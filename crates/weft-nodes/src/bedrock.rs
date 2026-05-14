//! AWS Bedrock backend for the LLM node.
//!
//! Sits alongside the OpenRouter path in `node.rs::tracked_ai_context`.
//! Uses the Converse API so the same call shape works across Claude models
//! (and, later, Nova/Llama/Mistral if scope widens). Credentials come from
//! the default AWS credential chain (env, shared config, IAM role, SSO) via
//! `aws_config::load_defaults`. No BYOK in v1.

use aws_config::BehaviorVersion;
use aws_sdk_bedrockruntime::{
    types::{ContentBlock, ConversationRole, InferenceConfiguration, Message, SystemContentBlock},
    Client,
};
use std::sync::Arc;

pub type AsyncCostCallback = Arc<
    dyn Fn(BedrockCostInfo, serde_json::Value) -> futures::future::BoxFuture<'static, ()>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct BedrockCostInfo {
    pub model: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub cost: f64,
    pub response_id: Option<String>,
}

pub struct BedrockContext {
    client: Client,
    model_id: String,
    cost_callback: AsyncCostCallback,
    meta: serde_json::Value,
}

pub struct BedrockParams {
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f32>,
}

pub struct BedrockResponse {
    pub text: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

impl BedrockContext {
    pub async fn new(
        model_id: String,
        cost_callback: AsyncCostCallback,
        meta: serde_json::Value,
    ) -> Self {
        let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
        let client = Client::new(&config);
        Self { client, model_id, cost_callback, meta }
    }

    pub async fn converse(
        &self,
        system_prompt: &str,
        user_prompt: &str,
        params: &BedrockParams,
    ) -> Result<BedrockResponse, String> {
        let mut inference = InferenceConfiguration::builder();
        if let Some(t) = params.temperature {
            inference = inference.temperature(t);
        }
        if let Some(m) = params.max_tokens {
            inference = inference.max_tokens(m as i32);
        }
        if let Some(p) = params.top_p {
            inference = inference.top_p(p);
        }

        let user_message = Message::builder()
            .role(ConversationRole::User)
            .content(ContentBlock::Text(user_prompt.to_string()))
            .build()
            .map_err(|e| format!("Failed to build user message: {e}"))?;

        let mut request = self
            .client
            .converse()
            .model_id(&self.model_id)
            .inference_config(inference.build())
            .messages(user_message);

        if !system_prompt.is_empty() {
            request = request.system(SystemContentBlock::Text(system_prompt.to_string()));
        }

        let output = request.send().await.map_err(|e| {
            // SdkError's Display is generic ("service error"); the useful
            // detail lives on the inner service error. Unwrap it if present.
            use aws_sdk_bedrockruntime::error::ProvideErrorMetadata;
            let meta = e.meta();
            let detail = meta.message().map(String::from).unwrap_or_else(|| format!("{e:?}"));
            let code = meta.code().unwrap_or("unknown");
            format!("Bedrock Converse error ({code}): {detail}")
        })?;

        let text = output
            .output()
            .and_then(|o| o.as_message().ok())
            .and_then(|m| m.content().first())
            .and_then(|c| c.as_text().ok())
            .cloned()
            .unwrap_or_default();

        let (prompt_tokens, completion_tokens) = output
            .usage()
            .map(|u| (u.input_tokens().max(0) as u32, u.output_tokens().max(0) as u32))
            .unwrap_or((0, 0));

        let (in_price, out_price) = pricing(&self.model_id);
        let cost = (prompt_tokens as f64 / 1000.0) * in_price
            + (completion_tokens as f64 / 1000.0) * out_price;

        let info = BedrockCostInfo {
            model: self.model_id.clone(),
            prompt_tokens,
            completion_tokens,
            cost,
            response_id: None,
        };
        (self.cost_callback)(info, self.meta.clone()).await;

        Ok(BedrockResponse { text, prompt_tokens, completion_tokens })
    }
}

/// USD per 1K tokens (input, output) for supported Bedrock models.
/// Unknown models return (0.0, 0.0) so the call still succeeds but logs
/// a zero cost — add an entry here when you enable a new model in AWS.
fn pricing(model_id: &str) -> (f64, f64) {
    let key = strip_region_prefix(model_id);
    match key {
        // Claude 4 family (public pricing in USD per 1K tokens, input / output)
        "anthropic.claude-opus-4-7" => (0.015, 0.075),
        "anthropic.claude-opus-4-6-v1" => (0.015, 0.075),
        "anthropic.claude-opus-4-5-20251101-v1:0" => (0.015, 0.075),
        "anthropic.claude-opus-4-1-20250805-v1:0" => (0.015, 0.075),
        "anthropic.claude-opus-4-20250514-v1:0" => (0.015, 0.075),
        "anthropic.claude-sonnet-4-6" => (0.003, 0.015),
        "anthropic.claude-sonnet-4-5-20250929-v1:0" => (0.003, 0.015),
        "anthropic.claude-sonnet-4-20250514-v1:0" => (0.003, 0.015),
        "anthropic.claude-haiku-4-5-20251001-v1:0" => (0.001, 0.005),
        // Claude 3.x family
        "anthropic.claude-3-5-sonnet-20241022-v2:0" => (0.003, 0.015),
        "anthropic.claude-3-5-haiku-20241022-v1:0" => (0.0008, 0.004),
        "anthropic.claude-3-opus-20240229-v1:0" => (0.015, 0.075),
        "anthropic.claude-3-sonnet-20240229-v1:0" => (0.003, 0.015),
        "anthropic.claude-3-haiku-20240307-v1:0" => (0.00025, 0.00125),
        _ => {
            tracing::warn!("No pricing entry for Bedrock model {}, charging $0", model_id);
            (0.0, 0.0)
        }
    }
}

fn strip_region_prefix(model_id: &str) -> &str {
    model_id
        .strip_prefix("us.")
        .or_else(|| model_id.strip_prefix("eu."))
        .or_else(|| model_id.strip_prefix("apac."))
        .or_else(|| model_id.strip_prefix("global."))
        .unwrap_or(model_id)
}
