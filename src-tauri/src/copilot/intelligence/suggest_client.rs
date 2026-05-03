//! Suggest SSE consumer (plan §6).
//!
//! NOT a long-running worker — spawned per suggestion event from
//! either the moment worker or the ⌘⌥G hotkey path. Owns one SSE
//! stream end-to-end + emits Tauri events for Sub-prompt 4 to render.
//!
//! Concurrency: `ActiveSuggestionMutex` gates "one in flight per
//! session" per plan §6.3. New trigger arriving while a previous
//! suggestion is streaming → drop, log, telemetry.
//!
//! Hard cap: time-to-first-token > 2s → abort the stream and emit
//! `copilot-suggestion-failed`. Better silent than late.
//!
//! Auto-clear: even on success, clear the active mutex after the
//! suggestion's TTL (30s) regardless of whether the user dismisses.
//! Otherwise a never-dismissed suggestion would block subsequent
//! triggers indefinitely.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::stream::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use uuid::Uuid;

use super::api::{IntelligenceApi, SuggestPayload, SuggestRequest, SuggestSseEvent};
use super::state::{ActiveSuggestion, ActiveSuggestionMutex, TriggerSource};

const TTFT_HARD_CAP: Duration = Duration::from_secs(2);
const ACTIVE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize)]
struct StreamingPayload {
    session_id: String,
    suggestion_id: String,
    /// "delta" | "start" | "complete" — parallels backend SSE shape
    /// so the overlay can multiplex without a separate event type.
    kind: &'static str,
    text: Option<String>,
    moment_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct FailedPayload {
    session_id: String,
    reason: String,
}

/// Public entry: moment worker calls this when its verifier fired.
pub fn spawn_for_moment<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    api: Arc<IntelligenceApi>,
    trigger_source: TriggerSource,
    trigger: Option<String>,
    trigger_phrase: Option<String>,
    transcript_window: String,
    rolling_summary: Option<String>,
) {
    spawn_inner(
        app,
        session_id,
        api,
        trigger_source,
        trigger,
        trigger_phrase,
        transcript_window,
        rolling_summary,
    );
}

/// Public entry: ⌘⌥G hotkey path. lib.rs collects the transcript
/// window itself (since hotkey doesn't go through moment worker).
pub fn spawn_for_hotkey<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    api: Arc<IntelligenceApi>,
    transcript_window: String,
    rolling_summary: Option<String>,
) {
    spawn_inner(
        app,
        session_id,
        api,
        TriggerSource::Hotkey,
        None,
        None,
        transcript_window,
        rolling_summary,
    );
}

fn spawn_inner<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    api: Arc<IntelligenceApi>,
    trigger_source: TriggerSource,
    trigger: Option<String>,
    trigger_phrase: Option<String>,
    transcript_window: String,
    rolling_summary: Option<String>,
) {
    // Concurrency gate — claim the active suggestion slot or drop.
    let suggestion_id = Uuid::new_v4().to_string();
    let claimed = {
        let active_state = app.state::<ActiveSuggestionMutex>();
        let mut guard = match active_state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(existing) = guard.as_ref() {
            if existing.started_at.elapsed() < ACTIVE_TTL {
                log::info!(
                    "[Copilot/intel/suggest] dropping new {} trigger — previous suggestion still active (id={}, age={}s)",
                    trigger_source.as_str(),
                    short(&existing.suggestion_id),
                    existing.started_at.elapsed().as_secs()
                );
                return;
            }
            // Previous TTL elapsed — replace.
        }
        *guard = Some(ActiveSuggestion {
            session_id: session_id.clone(),
            suggestion_id: suggestion_id.clone(),
            started_at: Instant::now(),
            trigger_source,
        });
        true
    };
    if !claimed {
        return;
    }

    tauri::async_runtime::spawn(async move {
        run_stream(
            app,
            session_id,
            api,
            suggestion_id,
            trigger_source,
            trigger,
            trigger_phrase,
            transcript_window,
            rolling_summary,
        )
        .await;
    });
}

async fn run_stream<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    api: Arc<IntelligenceApi>,
    suggestion_id: String,
    trigger_source: TriggerSource,
    trigger: Option<String>,
    trigger_phrase: Option<String>,
    transcript_window: String,
    rolling_summary: Option<String>,
) {
    let req = SuggestRequest {
        trigger_source: trigger_source.as_str().to_string(),
        trigger,
        trigger_phrase,
        transcript_window,
        rolling_summary,
    };

    let stream_started = Instant::now();
    let mut first_token_seen = false;

    let stream_result = api.post_suggest_sse(&session_id, req).await;
    let mut stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            log::warn!(
                "[Copilot/intel/suggest] open failed: {} session={}",
                e,
                short(&session_id)
            );
            emit_failed(&app, &session_id, format!("open: {}", e));
            release_active(&app, &suggestion_id);
            return;
        }
    };

    log::info!(
        "[Copilot/intel/suggest] stream open id={} source={} session={}",
        short(&suggestion_id),
        trigger_source.as_str(),
        short(&session_id)
    );

    while let Some(chunk) = stream.next().await {
        // TTFT hard cap — abort if we've waited > 2s and seen nothing.
        if !first_token_seen && stream_started.elapsed() > TTFT_HARD_CAP {
            log::warn!(
                "[Copilot/intel/suggest] TTFT exceeded {}s — aborting id={}",
                TTFT_HARD_CAP.as_secs(),
                short(&suggestion_id)
            );
            emit_failed(&app, &session_id, "ttft_exceeded".to_string());
            release_active(&app, &suggestion_id);
            return;
        }

        let event = match chunk {
            Ok(e) => e,
            Err(e) => {
                log::warn!(
                    "[Copilot/intel/suggest] stream error: {} id={}",
                    e,
                    short(&suggestion_id)
                );
                emit_failed(&app, &session_id, format!("stream: {}", e));
                release_active(&app, &suggestion_id);
                return;
            }
        };

        match event {
            SuggestSseEvent::Start { id: _, moment_type } => {
                first_token_seen = true;
                let _ = app.emit(
                    "copilot-suggestion-streaming",
                    &StreamingPayload {
                        session_id: session_id.clone(),
                        suggestion_id: suggestion_id.clone(),
                        kind: "start",
                        text: None,
                        moment_type: Some(moment_type),
                    },
                );
            }
            SuggestSseEvent::Delta { text } => {
                first_token_seen = true;
                let _ = app.emit(
                    "copilot-suggestion-streaming",
                    &StreamingPayload {
                        session_id: session_id.clone(),
                        suggestion_id: suggestion_id.clone(),
                        kind: "delta",
                        text: Some(text),
                        moment_type: None,
                    },
                );
            }
            SuggestSseEvent::Complete { payload } => {
                log::info!(
                    "[Copilot/intel/suggest] complete id={} confidence={:.2} primary='{}'",
                    short(&payload.suggestion_id),
                    payload.confidence,
                    truncate(&payload.primary, 80)
                );
                emit_complete(&app, &session_id, payload);
                // Don't release active immediately — wait for Sub-prompt 4
                // to send a `copilot-suggestion-dismissed` action OR the
                // 30s TTL elapses (handled by the next concurrency check).
            }
            SuggestSseEvent::Error { reason } => {
                log::warn!(
                    "[Copilot/intel/suggest] backend error: {} id={}",
                    reason,
                    short(&suggestion_id)
                );
                emit_failed(&app, &session_id, reason);
                release_active(&app, &suggestion_id);
                return;
            }
            SuggestSseEvent::Done => {
                // Stream cleanly ended. Active stays held until TTL/dismiss.
                return;
            }
        }
    }
}

fn emit_complete<R: Runtime>(app: &AppHandle<R>, session_id: &str, payload: SuggestPayload) {
    #[derive(Serialize)]
    struct CompletePayload {
        session_id: String,
        #[serde(flatten)]
        payload: SuggestPayload,
    }
    let _ = app.emit(
        "copilot-suggestion",
        &CompletePayload {
            session_id: session_id.to_string(),
            payload,
        },
    );
}

fn emit_failed<R: Runtime>(app: &AppHandle<R>, session_id: &str, reason: String) {
    let _ = app.emit(
        "copilot-suggestion-failed",
        &FailedPayload {
            session_id: session_id.to_string(),
            reason,
        },
    );
}

/// Release the ActiveSuggestionMutex if (and only if) the currently-
/// held entry is the one we own. Prevents a slow finisher from
/// clobbering a newer concurrent claim.
pub fn release_active<R: Runtime>(app: &AppHandle<R>, suggestion_id: &str) {
    if let Ok(mut guard) = app.state::<ActiveSuggestionMutex>().0.lock() {
        let should_clear = guard
            .as_ref()
            .map(|a| a.suggestion_id == suggestion_id)
            .unwrap_or(false);
        if should_clear {
            *guard = None;
        }
    }
}

fn short(s: &str) -> &str {
    &s[..8.min(s.len())]
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut out = s.chars().take(n).collect::<String>();
    out.push('…');
    out
}
