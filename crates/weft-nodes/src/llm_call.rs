//! Provider-agnostic builders for tracked LLM completion contexts.
//!
//! These free functions are the shared core used by both node execution
//! (`ExecutionContext::tracked_ai_context` / `tracked_bedrock_context`)
//! and non-node callers like `weft-api`'s AI chat endpoint. The behaviour
//! and cost-reporting shape match what `LlmInference` already emits to
//! `/api/v1/usage/events`.

use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use crate::bedrock::{AsyncCostCallback as BedrockCostCallback, BedrockContext, BedrockCostInfo};

/// Opaque metadata attached to every cost event.
/// Fields map 1:1 to the usage-events JSON body.
#[derive(Clone)]
pub struct CostMeta {
    pub user_id: String,
    pub project_id: Option<String>,
    pub execution_id: Option<String>,
    pub node_id: Option<String>,
    pub is_byok: bool,
}

impl CostMeta {
    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "userId": self.user_id,
            "projectId": self.project_id,
            "executionId": self.execution_id,
            "nodeId": self.node_id,
            "isByok": self.is_byok,
        })
    }
}

/// Build a tracked OpenRouter `CompletionContext`.
///
/// `api_url` is the weft-api base URL where usage events are POSTed.
/// `cost_accumulator` is optional — node execution threads in a shared
/// atomic so per-NodeExecution totals can be aggregated; other callers
/// (e.g. chat endpoint) can pass `None`.
pub fn build_openrouter_context(
    model: &str,
    api_key: &str,
    meta: CostMeta,
    api_url: String,
    cost_accumulator: Option<Arc<AtomicU64>>,
    internal_api_key: Option<String>,
) -> minillmlib::CompletionContext {
    let generator = minillmlib::GeneratorInfo::openrouter(model).with_api_key(api_key);
    let meta_json = meta.to_json();

    let callback: minillmlib::AsyncCostCallback = Arc::new(
        move |cost_info: minillmlib::CostInfo, meta: serde_json::Value| {
            let api_url = api_url.clone();
            let cost_acc = cost_accumulator.clone();
            let internal_key = internal_api_key.clone();
            Box::pin(async move {
                if let Some(acc) = cost_acc {
                    let microdollars = (cost_info.cost * 1_000_000.0) as u64;
                    acc.fetch_add(microdollars, std::sync::atomic::Ordering::Relaxed);
                }

                let client = reqwest::Client::new();
                let mut request = client.post(format!("{}/api/v1/usage/events", api_url));
                if let Some(key) = internal_key {
                    request = request.header("x-internal-api-key", key);
                }
                let body = serde_json::json!({
                    "userId": meta["userId"],
                    "eventType": "service",
                    "subtype": "llm",
                    "projectId": meta["projectId"],
                    "executionId": meta["executionId"],
                    "nodeId": meta["nodeId"],
                    "model": cost_info.model,
                    "promptTokens": cost_info.prompt_tokens,
                    "completionTokens": cost_info.completion_tokens,
                    "costUsd": cost_info.cost,
                    "isByok": meta["isByok"],
                    "metadata": {
                        "responseId": cost_info.response_id,
                    },
                });

                if let Err(e) = request.json(&body).send().await {
                    tracing::warn!("Failed to report AI cost to API: {}", e);
                }
            })
        },
    );

    minillmlib::CompletionContext::new(
        generator,
        meta_json,
        callback,
        "https://app.weavemind.ai",
        "WeaveMind",
    )
}

/// Build a tracked Bedrock `BedrockContext`.
///
/// Same contract as `build_openrouter_context`: cost is reported to
/// the same `/api/v1/usage/events` endpoint with identical shape.
pub async fn build_bedrock_context(
    model: &str,
    meta: CostMeta,
    api_url: String,
    cost_accumulator: Option<Arc<AtomicU64>>,
    internal_api_key: Option<String>,
) -> BedrockContext {
    let meta_json = meta.to_json();

    let callback: BedrockCostCallback = Arc::new(
        move |cost_info: BedrockCostInfo, meta: serde_json::Value| {
            let api_url = api_url.clone();
            let cost_acc = cost_accumulator.clone();
            let internal_key = internal_api_key.clone();
            Box::pin(async move {
                if let Some(acc) = cost_acc {
                    let microdollars = (cost_info.cost * 1_000_000.0) as u64;
                    acc.fetch_add(microdollars, std::sync::atomic::Ordering::Relaxed);
                }

                let client = reqwest::Client::new();
                let mut request = client.post(format!("{}/api/v1/usage/events", api_url));
                if let Some(key) = internal_key {
                    request = request.header("x-internal-api-key", key);
                }
                let body = serde_json::json!({
                    "userId": meta["userId"],
                    "eventType": "service",
                    "subtype": "llm",
                    "projectId": meta["projectId"],
                    "executionId": meta["executionId"],
                    "nodeId": meta["nodeId"],
                    "model": cost_info.model,
                    "promptTokens": cost_info.prompt_tokens,
                    "completionTokens": cost_info.completion_tokens,
                    "costUsd": cost_info.cost,
                    "isByok": meta["isByok"],
                    "metadata": {
                        "responseId": cost_info.response_id,
                    },
                });

                if let Err(e) = request.json(&body).send().await {
                    tracing::warn!("Failed to report AI cost to API: {}", e);
                }
            })
        },
    );

    BedrockContext::new(model.to_string(), callback, meta_json).await
}
