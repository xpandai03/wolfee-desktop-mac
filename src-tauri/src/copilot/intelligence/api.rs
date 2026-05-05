//! Backend HTTP client for the intelligence endpoints
//! (Sub-prompt 3, plan §8.1).
//!
//! Separate from `copilot::session::api` (which is sacred) so we
//! can extend without touching Sub-prompt 2 surface. Reuses
//! `reqwest::Client` patterns from Sub-prompt 2 and the locked
//! `Authorization: Bearer <device_token>` auth.

use std::time::Duration;

use eventsource_stream::{Event, Eventsource};
use futures_util::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};

const REQUEST_TIMEOUT_SECS: u64 = 30;
const SUGGEST_REQUEST_TIMEOUT_SECS: u64 = 60; // SSE streams take longer

#[derive(Debug)]
pub enum IntelligenceApiError {
    Network(String),
    Unauthorized,
    /// 429 from server-side rate limit. `retry_after_seconds` is
    /// parsed from the `Retry-After` header when present.
    RateLimited { retry_after_seconds: Option<u64> },
    /// 409 — concurrent suggest stream in flight for this session.
    /// Caller should drop, not retry.
    ConcurrentSuggestion,
    BadRequest { status: u16, body: String },
    ServerError { status: u16, body: String },
    Decode(String),
}

impl std::fmt::Display for IntelligenceApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(s) => write!(f, "network: {s}"),
            Self::Unauthorized => write!(f, "unauthorized (401)"),
            Self::RateLimited { retry_after_seconds } => {
                write!(f, "rate_limited retry_after={:?}", retry_after_seconds)
            }
            Self::ConcurrentSuggestion => write!(f, "concurrent_suggestion (409)"),
            Self::BadRequest { status, body } => write!(f, "{status}: {body}"),
            Self::ServerError { status, body } => write!(f, "{status}: {body}"),
            Self::Decode(s) => write!(f, "decode: {s}"),
        }
    }
}

impl std::error::Error for IntelligenceApiError {}

#[derive(Debug, Clone, Serialize)]
pub struct SummaryRequest {
    pub window: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
    pub mode: SummaryMode,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SummaryMode {
    Incremental,
    Full,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SummaryResponse {
    pub summary: String,
    #[serde(rename = "generated_at")]
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectMomentRequest {
    pub candidate_triggers: Vec<String>,
    pub transcript_window: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rolling_summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DetectMomentResponse {
    pub should_suggest: bool,
    pub trigger: String,
    pub trigger_phrase: Option<String>,
    pub urgency: u8,
    pub rationale: String,
    pub is_speaker_mid_statement: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SuggestRequest {
    pub trigger_source: String, // "moment" | "hotkey"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_phrase: Option<String>,
    pub transcript_window: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rolling_summary: Option<String>,
}

// ── Sub-prompt 4.5 ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Default)]
pub struct ContextRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about_call: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objections: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuickActionType {
    Ask,
    FollowUp,
    FactCheck,
    Recap,
}

impl QuickActionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::FollowUp => "follow_up",
            Self::FactCheck => "fact_check",
            Self::Recap => "recap",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "ask" => Some(Self::Ask),
            "follow_up" => Some(Self::FollowUp),
            "fact_check" => Some(Self::FactCheck),
            "recap" => Some(Self::Recap),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct QuickActionRequest {
    pub action: QuickActionType,
    pub transcript_window: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rolling_summary: Option<String>,
    /// Sub-prompt 4.6 — when present, overrides the auto-tactical
    /// behavior of action="ask" with a free-form user question. The
    /// backend ask.md prompt branches on this field's presence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_question: Option<String>,
    /// Sub-prompt 4.7 — prior messages from the active chat thread
    /// (oldest → newest). Backend caps + truncates; we just forward.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub chat_history: Vec<ChatHistoryEntry>,
}

/// Sub-prompt 4.7 — single message in a chat thread, in the wire
/// shape the backend's chat_history validation expects.
#[derive(Debug, Clone, Serialize)]
pub struct ChatHistoryEntry {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

/// Parsed SSE event from the /suggest stream.
#[derive(Debug, Clone)]
pub enum SuggestSseEvent {
    Start {
        id: String,
        moment_type: String,
    },
    Delta {
        text: String,
    },
    Complete {
        payload: SuggestPayload,
        /// Sub-prompt 4.7 — populated for fact-check verdicts; empty
        /// for other actions. Forwarded as-is to the desktop event.
        sources: Vec<FactCheckSource>,
    },
    Error {
        reason: String,
    },
    Done,
}

/// Sub-prompt 4.7 — citation chip from a fact-check response.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FactCheckSource {
    pub title: String,
    pub url: String,
}

// ── Sub-prompt 4.8 — Copilot Modes + post-session view ────────────

/// Saved mode template (per-user, synced via wolfee.io). Returned
/// from GET /api/copilot/modes; sent to ContextWindow's dropdown.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CopilotMode {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "contextAboutUser")]
    pub context_about_user: Option<String>,
    #[serde(rename = "contextAboutCall")]
    pub context_about_call: Option<String>,
    #[serde(rename = "contextObjections")]
    pub context_objections: Option<String>,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UpsertModeRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_about_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_about_call: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_objections: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_default: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModesListResponse {
    pub modes: Vec<CopilotMode>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModeResponse {
    pub mode: CopilotMode,
}

/// Sub-prompt 4.8 — payload for POST /api/copilot/sessions/:id/finalize.
/// Backend stores these as JSONB columns + triggers async summary.
#[derive(Debug, Clone, Serialize, Default)]
pub struct FinalizeSessionRequest {
    pub transcript: Vec<serde_json::Value>,
    pub chat_threads: Vec<serde_json::Value>,
    pub auto_suggestions: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_used_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FinalizeSessionResponse {
    pub session_id: String,
    pub share_slug: Option<String>,
    pub summary_status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UserPreferencesPayload {
    #[serde(rename = "copilot_auto_open_browser")]
    pub copilot_auto_open_browser: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SuggestPayload {
    pub suggestion_id: String,
    pub moment_type: String,
    pub primary: String,
    pub secondary: Option<String>,
    pub confidence: f64,
    pub reasoning: String,
    pub ttl_seconds: u32,
}

pub struct IntelligenceApi {
    backend_url: String,
    device_token: String,
    client: reqwest::Client,
    suggest_client: reqwest::Client,
}

impl IntelligenceApi {
    pub fn new(backend_url: String, device_token: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        // Suggest client has a longer timeout because the SSE stream
        // can run for several seconds; reqwest's timeout is the
        // total-request timeout including streaming.
        let suggest_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(SUGGEST_REQUEST_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            backend_url,
            device_token,
            client,
            suggest_client,
        }
    }

    pub async fn post_summary(
        &self,
        session_id: &str,
        req: SummaryRequest,
    ) -> Result<SummaryResponse, IntelligenceApiError> {
        let url = format!(
            "{}/api/copilot/sessions/{}/intelligence/summary",
            self.backend_url, session_id
        );
        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .json(&req)
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;
        res.json::<SummaryResponse>()
            .await
            .map_err(|e| IntelligenceApiError::Decode(e.to_string()))
    }

    pub async fn post_detect_moment(
        &self,
        session_id: &str,
        req: DetectMomentRequest,
    ) -> Result<DetectMomentResponse, IntelligenceApiError> {
        let url = format!(
            "{}/api/copilot/sessions/{}/intelligence/detect-moment",
            self.backend_url, session_id
        );
        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .json(&req)
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;
        res.json::<DetectMomentResponse>()
            .await
            .map_err(|e| IntelligenceApiError::Decode(e.to_string()))
    }

    /// Open the /suggest SSE stream. Returns a stream of parsed
    /// `SuggestSseEvent` values. Closes when the server emits
    /// `done: true` or the underlying connection drops.
    pub async fn post_suggest_sse(
        &self,
        session_id: &str,
        req: SuggestRequest,
    ) -> Result<impl Stream<Item = Result<SuggestSseEvent, IntelligenceApiError>>, IntelligenceApiError>
    {
        let url = format!(
            "{}/api/copilot/sessions/{}/intelligence/suggest",
            self.backend_url, session_id
        );
        let res = self
            .suggest_client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .header("Accept", "text/event-stream")
            .json(&req)
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;

        let byte_stream = res
            .bytes_stream()
            .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        let events = byte_stream.eventsource().map(parse_sse_event);
        Ok(events)
    }

    // ── Sub-prompt 4.5 ─────────────────────────────────────────────

    /// POST /api/copilot/sessions/:id/context — submit the 3 user-pasted
    /// context fields. Empty/blank values are sent as `null` so the
    /// backend stores NULL (which renders as "(not provided)" in
    /// prompt templates). All fields independently optional.
    pub async fn post_context(
        &self,
        session_id: &str,
        req: ContextRequest,
    ) -> Result<(), IntelligenceApiError> {
        let url = format!(
            "{}/api/copilot/sessions/{}/context",
            self.backend_url, session_id
        );
        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .json(&req)
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;
        Ok(())
    }

    /// POST /api/copilot/sessions/:id/intelligence/quick-action — same
    /// SSE shape as /suggest. Used by the 4 action buttons in the
    /// overlay (ask/follow_up/fact_check/recap).
    pub async fn post_quick_action_sse(
        &self,
        session_id: &str,
        req: QuickActionRequest,
    ) -> Result<impl Stream<Item = Result<SuggestSseEvent, IntelligenceApiError>>, IntelligenceApiError>
    {
        let url = format!(
            "{}/api/copilot/sessions/{}/intelligence/quick-action",
            self.backend_url, session_id
        );
        let res = self
            .suggest_client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .header("Accept", "text/event-stream")
            .json(&req)
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;

        let byte_stream = res
            .bytes_stream()
            .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

        let events = byte_stream.eventsource().map(parse_sse_event);
        Ok(events)
    }

    // ── Sub-prompt 4.8 — Modes CRUD + finalize + preferences ─────

    pub async fn list_modes(&self) -> Result<Vec<CopilotMode>, IntelligenceApiError> {
        let url = format!("{}/api/copilot/modes", self.backend_url);
        let res = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;
        let body: ModesListResponse = res
            .json()
            .await
            .map_err(|e| IntelligenceApiError::Decode(e.to_string()))?;
        Ok(body.modes)
    }

    pub async fn create_mode(
        &self,
        req: UpsertModeRequest,
    ) -> Result<CopilotMode, IntelligenceApiError> {
        let url = format!("{}/api/copilot/modes", self.backend_url);
        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .json(&req)
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;
        let body: ModeResponse = res
            .json()
            .await
            .map_err(|e| IntelligenceApiError::Decode(e.to_string()))?;
        Ok(body.mode)
    }

    pub async fn update_mode(
        &self,
        mode_id: &str,
        req: UpsertModeRequest,
    ) -> Result<CopilotMode, IntelligenceApiError> {
        let url = format!("{}/api/copilot/modes/{}", self.backend_url, mode_id);
        let res = self
            .client
            .patch(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .json(&req)
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;
        let body: ModeResponse = res
            .json()
            .await
            .map_err(|e| IntelligenceApiError::Decode(e.to_string()))?;
        Ok(body.mode)
    }

    pub async fn delete_mode(&self, mode_id: &str) -> Result<(), IntelligenceApiError> {
        let url = format!("{}/api/copilot/modes/{}", self.backend_url, mode_id);
        let res = self
            .client
            .delete(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;
        Ok(())
    }

    pub async fn set_default_mode(
        &self,
        mode_id: &str,
    ) -> Result<CopilotMode, IntelligenceApiError> {
        let url = format!(
            "{}/api/copilot/modes/{}/set-default",
            self.backend_url, mode_id
        );
        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;
        let body: ModeResponse = res
            .json()
            .await
            .map_err(|e| IntelligenceApiError::Decode(e.to_string()))?;
        Ok(body.mode)
    }

    pub async fn finalize_session(
        &self,
        session_id: &str,
        req: FinalizeSessionRequest,
    ) -> Result<FinalizeSessionResponse, IntelligenceApiError> {
        let url = format!(
            "{}/api/copilot/sessions/{}/finalize",
            self.backend_url, session_id
        );
        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .json(&req)
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;
        let body: FinalizeSessionResponse = res
            .json()
            .await
            .map_err(|e| IntelligenceApiError::Decode(e.to_string()))?;
        Ok(body)
    }

    pub async fn get_user_preferences(
        &self,
    ) -> Result<UserPreferencesPayload, IntelligenceApiError> {
        let url = format!("{}/api/user/preferences", self.backend_url);
        let res = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .send()
            .await
            .map_err(|e| IntelligenceApiError::Network(e.to_string()))?;
        translate_status(&res)?;
        let body: UserPreferencesPayload = res
            .json()
            .await
            .map_err(|e| IntelligenceApiError::Decode(e.to_string()))?;
        Ok(body)
    }
}

fn parse_sse_event(
    res: Result<Event, eventsource_stream::EventStreamError<std::io::Error>>,
) -> Result<SuggestSseEvent, IntelligenceApiError> {
    let evt = res.map_err(|e| IntelligenceApiError::Network(format!("sse: {e}")))?;
    if evt.data.is_empty() {
        return Err(IntelligenceApiError::Decode("empty SSE chunk".into()));
    }
    // Backend writes `data: {json}` per chunk. eventsource-stream has
    // already stripped the `data:` prefix; we just JSON-parse the rest.
    let parsed: serde_json::Value = serde_json::from_str(&evt.data)
        .map_err(|e| IntelligenceApiError::Decode(format!("sse json: {e}")))?;

    // Two terminal forms: `{"done": true}` and the various typed events.
    if parsed.get("done").and_then(|v| v.as_bool()) == Some(true) {
        return Ok(SuggestSseEvent::Done);
    }
    let kind = parsed
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match kind {
        "suggestion-start" => {
            let id = parsed
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let moment_type = parsed
                .get("moment_type")
                .and_then(|v| v.as_str())
                .unwrap_or("general")
                .to_string();
            Ok(SuggestSseEvent::Start { id, moment_type })
        }
        "delta" => {
            let text = parsed
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Ok(SuggestSseEvent::Delta { text })
        }
        "complete" => {
            let payload_v = parsed
                .get("payload")
                .ok_or_else(|| IntelligenceApiError::Decode("complete missing payload".into()))?;
            let payload: SuggestPayload = serde_json::from_value(payload_v.clone())
                .map_err(|e| IntelligenceApiError::Decode(format!("complete payload: {e}")))?;
            // Sub-prompt 4.7 — sources alongside the payload (fact-check
            // path only; absent for other actions). Tolerate missing /
            // wrong-shaped — fall back to empty.
            let sources: Vec<FactCheckSource> = parsed
                .get("sources")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| serde_json::from_value::<FactCheckSource>(s.clone()).ok())
                        .collect()
                })
                .unwrap_or_default();
            Ok(SuggestSseEvent::Complete { payload, sources })
        }
        "error" => {
            let reason = parsed
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            Ok(SuggestSseEvent::Error { reason })
        }
        _ => Err(IntelligenceApiError::Decode(format!(
            "unknown sse type: {kind}"
        ))),
    }
}

fn translate_status(res: &reqwest::Response) -> Result<(), IntelligenceApiError> {
    let status = res.status();
    if status.is_success() {
        return Ok(());
    }
    if status.as_u16() == 401 {
        return Err(IntelligenceApiError::Unauthorized);
    }
    if status.as_u16() == 409 {
        return Err(IntelligenceApiError::ConcurrentSuggestion);
    }
    if status.as_u16() == 429 {
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        return Err(IntelligenceApiError::RateLimited {
            retry_after_seconds: retry_after,
        });
    }
    if status.is_client_error() {
        Err(IntelligenceApiError::BadRequest {
            status: status.as_u16(),
            body: String::new(),
        })
    } else {
        Err(IntelligenceApiError::ServerError {
            status: status.as_u16(),
            body: String::new(),
        })
    }
}
