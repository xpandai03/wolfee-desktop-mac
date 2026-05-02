//! Backend session HTTP client (Sub-prompt 2 — Listening, Phase 5).
//!
//! Talks to Wolfee's `/api/copilot/sessions` endpoints behind
//! `requireDeviceAuth`. Audio bytes never go through this client —
//! that's the Deepgram WebSocket's job (Phase 3). This is just for
//! session lifecycle: create, fetch JWT, end.
//!
//! Error model mirrors what auth.rs / uploader.rs do: a flat enum the
//! caller can pattern-match on for tray-message decisions (e.g.,
//! Unauthorized → "re-link", RateLimited → "daily cap reached").

use serde::Deserialize;

const REQUEST_TIMEOUT_SECS: u64 = 30;

#[derive(Debug)]
pub enum SessionApiError {
    /// Request never reached the server (DNS, connection refused, TLS, etc.).
    Network(String),
    /// 401 from `requireDeviceAuth` — auth.json is stale or revoked.
    Unauthorized,
    /// 429 from the JWT-mint endpoint when the per-user daily cost cap
    /// is hit. Phase 3 will surface this; Phase 5 doesn't call the
    /// mint endpoint, but the variant exists so the client is complete.
    RateLimited,
    /// 4xx other than 401/429.
    BadRequest { status: u16, body: String },
    /// 5xx — backend or upstream failure. Phase 3 handles 503 from
    /// Deepgram specifically.
    ServerError { status: u16, body: String },
    /// Body parsing / shape mismatch.
    Decode(String),
}

impl std::fmt::Display for SessionApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(s) => write!(f, "network error: {s}"),
            Self::Unauthorized => write!(f, "unauthorized (401) — re-link"),
            Self::RateLimited => write!(f, "rate limited (429) — daily cap reached"),
            Self::BadRequest { status, body } => write!(f, "{status}: {body}"),
            Self::ServerError { status, body } => write!(f, "{status}: {body}"),
            Self::Decode(s) => write!(f, "decode error: {s}"),
        }
    }
}

impl std::error::Error for SessionApiError {}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateSessionResponse {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EndSessionResponse {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "durationSeconds")]
    pub duration_seconds: u64,
    /// True when the backend already had `endedAt` set on this session
    /// (we get the existing row back instead of an update). Lets the
    /// caller log "session was already ended" for diagnostics.
    #[serde(default, rename = "alreadyEnded")]
    pub already_ended: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeepgramTokenResponse {
    pub jwt: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    /// True once the user has crossed the 4-hour soft cap today.
    /// Phase 5 ignores; Phase 3 surfaces in the tray.
    #[serde(default, rename = "softCapHit")]
    pub soft_cap_hit: bool,
    #[serde(default, rename = "minutesUsedToday")]
    pub minutes_used_today: u32,
}

/// Reason passed to `POST /sessions/:id/end`. The backend coerces
/// anything outside this set to "user_requested" defensively, so
/// drift here isn't fatal — but the closed enum keeps the contract clean.
#[derive(Debug, Clone, Copy)]
pub enum EndReason {
    UserRequested,
    Error,
    Timeout,
}

impl EndReason {
    fn as_str(&self) -> &'static str {
        match self {
            Self::UserRequested => "user_requested",
            Self::Error => "error",
            Self::Timeout => "timeout",
        }
    }
}

/// Stateless-ish HTTP client for the Copilot session endpoints. The
/// backend_url + device_token are captured at construction; rebuild
/// the client if either changes (e.g., user re-links, dev override).
pub struct SessionApi {
    backend_url: String,
    device_token: String,
    client: reqwest::Client,
}

impl SessionApi {
    pub fn new(backend_url: String, device_token: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            backend_url,
            device_token,
            client,
        }
    }

    /// `POST /api/copilot/sessions` with a client-generated UUID.
    /// Returns the canonical sessionId + startedAt the backend
    /// persisted. The endpoint is idempotent on the PK — retry-after-
    /// network-blip with the same sessionId is safe.
    pub async fn create_session(
        &self,
        session_id: &str,
    ) -> Result<CreateSessionResponse, SessionApiError> {
        let url = format!("{}/api/copilot/sessions", self.backend_url);
        let body = serde_json::json!({ "sessionId": session_id });

        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .json(&body)
            .send()
            .await
            .map_err(|e| SessionApiError::Network(e.to_string()))?;

        Self::translate_status(&res)?;
        res.json::<CreateSessionResponse>()
            .await
            .map_err(|e| SessionApiError::Decode(e.to_string()))
    }

    /// `POST /api/copilot/sessions/:sessionId/end` — closes the
    /// session, returns the server-computed durationSeconds.
    pub async fn end_session(
        &self,
        session_id: &str,
        reason: EndReason,
    ) -> Result<EndSessionResponse, SessionApiError> {
        let url = format!(
            "{}/api/copilot/sessions/{}/end",
            self.backend_url, session_id
        );
        let body = serde_json::json!({ "reason": reason.as_str() });

        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .json(&body)
            .send()
            .await
            .map_err(|e| SessionApiError::Network(e.to_string()))?;

        Self::translate_status(&res)?;
        res.json::<EndSessionResponse>()
            .await
            .map_err(|e| SessionApiError::Decode(e.to_string()))
    }

    /// `POST /api/copilot/sessions/:sessionId/deepgram-token` — Phase 3
    /// will call this just before opening the WS. Stub-quality
    /// implementation here so the SessionApi is complete; Phase 3 will
    /// add the JWT-refresh / re-mint logic.
    #[allow(dead_code)]
    pub async fn fetch_deepgram_token(
        &self,
        session_id: &str,
    ) -> Result<DeepgramTokenResponse, SessionApiError> {
        let url = format!(
            "{}/api/copilot/sessions/{}/deepgram-token",
            self.backend_url, session_id
        );

        let res = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.device_token))
            .send()
            .await
            .map_err(|e| SessionApiError::Network(e.to_string()))?;

        Self::translate_status(&res)?;
        res.json::<DeepgramTokenResponse>()
            .await
            .map_err(|e| SessionApiError::Decode(e.to_string()))
    }

    /// Map the response status to a SessionApiError variant. Returns
    /// Ok(()) on 2xx so the caller proceeds to .json(). Reads the body
    /// only on error to avoid double-consuming the response.
    fn translate_status(res: &reqwest::Response) -> Result<(), SessionApiError> {
        let status = res.status();
        if status.is_success() {
            return Ok(());
        }
        if status.as_u16() == 401 {
            return Err(SessionApiError::Unauthorized);
        }
        if status.as_u16() == 429 {
            return Err(SessionApiError::RateLimited);
        }
        // Body read is async — defer to caller. For now, surface the
        // status code; the caller can log the body if it has hold of
        // the response. We don't preemptively await .text() here
        // because we'd consume the body and the caller still has the
        // response object.
        if status.is_client_error() {
            Err(SessionApiError::BadRequest {
                status: status.as_u16(),
                body: String::new(),
            })
        } else {
            Err(SessionApiError::ServerError {
                status: status.as_u16(),
                body: String::new(),
            })
        }
    }
}
