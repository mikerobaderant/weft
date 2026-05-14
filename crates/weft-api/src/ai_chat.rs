//! Weave Chat endpoint: a stateless, provider-agnostic wrapper
//! around the existing LLM helpers that the dashboard calls from a
//! right-sidebar chat panel.
//!
//! The dashboard composes the full system prompt (catalog + project
//! context) and sends the rolling `messages` array on each turn; this
//! endpoint is kept dumb on purpose.

use axum::{extract::State, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use weft_nodes::llm_call::{build_bedrock_context, build_openrouter_context, CostMeta};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ChatConfig {
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    #[serde(rename = "systemPrompt")]
    pub system_prompt: String,
    #[serde(default)]
    pub config: Option<ChatConfig>,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub text: String,
    #[serde(rename = "weftPatch", skip_serializing_if = "Option::is_none")]
    pub weft_patch: Option<String>,
    pub provider: String,
    pub model: String,
}

pub async fn chat(
    State(_state): State<Arc<AppState>>,
    Json(body): Json<ChatRequest>,
) -> impl IntoResponse {
    // Resolve provider + model: body.config → env → openrouter/sonnet default.
    let cfg = body.config.unwrap_or(ChatConfig { provider: None, model: None, api_key: None });

    let provider = cfg
        .provider
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var("WEAVE_CHAT_PROVIDER").ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "openrouter".to_string());

    let default_model = match provider.as_str() {
        "bedrock" => "us.anthropic.claude-sonnet-4-6",
        _ => "anthropic/claude-sonnet-4.6",
    };
    let model = cfg
        .model
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var("WEAVE_CHAT_MODEL").ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| default_model.to_string());

    // Find the last user message; that's the "prompt" in minillmlib terms.
    // Prior turns fold into the system prompt as context. (We pass the
    // rolling conversation as plain text for v1 — multi-turn ChatNode
    // support comes later if needed.)
    let last_user = match body.messages.iter().rev().find(|m| m.role == "user") {
        Some(m) => m.content.clone(),
        None => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                "Request must contain at least one user message",
            )
                .into_response();
        }
    };

    // Build a system prompt that includes prior conversation turns so the
    // provider sees context without us needing multi-turn ChatNode glue.
    let mut composed_system = body.system_prompt.clone();
    let history: Vec<String> = body
        .messages
        .iter()
        .take(body.messages.len().saturating_sub(1))
        .map(|m| format!("{}: {}", m.role.to_uppercase(), m.content))
        .collect();
    if !history.is_empty() {
        composed_system.push_str("\n\n# Conversation so far\n");
        composed_system.push_str(&history.join("\n---\n"));
    }

    let api_url = std::env::var("API_URL")
        .unwrap_or_else(|_| "http://localhost:3000".to_string());
    let internal_api_key = std::env::var("INTERNAL_API_KEY").ok().filter(|v| !v.is_empty());
    let meta = CostMeta {
        user_id: "local".to_string(),
        project_id: None,
        execution_id: None,
        node_id: None,
        is_byok: cfg.api_key.as_deref().map(|k| !k.is_empty()).unwrap_or(false),
    };

    let reply_text = match provider.as_str() {
        "bedrock" => {
            let bedrock_ctx = build_bedrock_context(
                &model,
                meta,
                api_url,
                None,
                internal_api_key,
            )
            .await;
            let params = weft_nodes::bedrock::BedrockParams {
                temperature: Some(0.2),
                max_tokens: Some(4096),
                top_p: None,
            };
            match bedrock_ctx.converse(&composed_system, &last_user, &params).await {
                Ok(resp) => resp.text,
                Err(e) => return server_error(format!("Bedrock error: {e}")),
            }
        }
        "openrouter" => {
            let api_key = cfg
                .api_key
                .filter(|v| !v.is_empty() && v != "__PLATFORM__" && v != "__BYOK__")
                .or_else(|| std::env::var("OPENROUTER_API_KEY").ok().filter(|v| !v.is_empty()));
            let Some(api_key) = api_key else {
                return server_error(
                    "No OpenRouter API key available. Set OPENROUTER_API_KEY or pass apiKey in config."
                        .to_string(),
                );
            };

            let completion_ctx = build_openrouter_context(
                &model,
                &api_key,
                meta,
                api_url,
                None,
                internal_api_key,
            );

            let root = minillmlib::ChatNode::root(composed_system.as_str());
            let user_node = root.add_user(last_user.as_str());
            let params = minillmlib::NodeCompletionParameters::new();
            match user_node.complete_tracked(&completion_ctx, Some(&params)).await {
                Ok(response) => response.text().unwrap_or_default().to_string(),
                Err(e) => return server_error(format!("OpenRouter error: {e}")),
            }
        }
        other => return server_error(format!("Unknown provider: {other}")),
    };

    let weft_patch = extract_weft_patch_block(&reply_text);

    Json(ChatResponse {
        text: reply_text,
        weft_patch,
        provider,
        model,
    })
    .into_response()
}

fn server_error(msg: String) -> axum::response::Response {
    tracing::error!("ai_chat: {}", msg);
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, msg).into_response()
}

/// Extract the first ````weft-patch fenced block from an assistant reply.
/// The fence uses four backticks so embedded triple-backtick examples in
/// the SEARCH/REPLACE body don't break parsing. Mirrors the regex in
/// `dashboard/src/lib/ai/weft-patch.ts::extractWeftPatchBlock`.
///
/// Returns `None` if the assistant responded with prose only (e.g. asking
/// a clarification question).
fn extract_weft_patch_block(text: &str) -> Option<String> {
    const FENCE: &str = "````weft-patch";
    let open = text.find(FENCE)?;
    let after_open = &text[open + FENCE.len()..];
    // Skip optional whitespace + newline after the language tag.
    let content_start = after_open.find('\n').map(|i| i + 1)?;
    let content = &after_open[content_start..];
    let close = content.find("````")?;
    Some(content[..close].trim_end_matches('\n').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_weft_patch_block() {
        let text = "Sure, here's the change:\n\n````weft-patch\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n````\n\nDone.";
        let got = extract_weft_patch_block(text).unwrap();
        assert_eq!(
            got,
            "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE"
        );
    }

    #[test]
    fn returns_none_when_no_fence() {
        let text = "Could you clarify which node you'd like added?";
        assert!(extract_weft_patch_block(text).is_none());
    }

    #[test]
    fn handles_fence_without_trailing_newline() {
        let text = "````weft-patch\n<<<<<<< SEARCH\n=======\nfoo = Bar {}\n>>>>>>> REPLACE\n````";
        assert_eq!(
            extract_weft_patch_block(text).unwrap(),
            "<<<<<<< SEARCH\n=======\nfoo = Bar {}\n>>>>>>> REPLACE"
        );
    }

    #[test]
    fn ignores_triple_backtick_inside_patch_body() {
        // The model might echo a ```weft example inside the patch body.
        // Using 4-backtick fences keeps that from prematurely closing.
        let text = "````weft-patch\n<<<<<<< SEARCH\n=======\n# example: ```weft\nfoo = Bar {}\n# ```\n>>>>>>> REPLACE\n````";
        let got = extract_weft_patch_block(text).unwrap();
        assert!(got.contains("```weft"));
        assert!(got.ends_with(">>>>>>> REPLACE"));
    }
}
