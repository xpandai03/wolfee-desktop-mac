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

use super::api::{
    IntelligenceApi, QuickActionRequest, QuickActionType, SuggestPayload, SuggestRequest,
    SuggestSseEvent,
};
use super::state::{ActiveSuggestion, ActiveSuggestionMutex, TriggerSource};

const TTFT_HARD_CAP: Duration = Duration::from_secs(2);
const ACTIVE_TTL: Duration = Duration::from_secs(30);

/// Discriminator for which backend SSE endpoint a stream task
/// should hit. Auto = /suggest (moment + hotkey paths). User-clicked
/// quick-actions = /quick-action with a typed action enum.
#[derive(Debug, Clone)]
enum StreamMode {
    Auto {
        trigger: Option<String>,
        trigger_phrase: Option<String>,
    },
    QuickAction(QuickActionType),
}

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
        StreamMode::Auto {
            trigger,
            trigger_phrase,
        },
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
        StreamMode::Auto {
            trigger: None,
            trigger_phrase: None,
        },
        transcript_window,
        rolling_summary,
    );
}

/// Public entry: Sub-prompt 4.5 quick-action button click. Always
/// wins concurrency over an in-flight auto-suggestion (Decision N1)
/// — user intent takes priority.
pub fn spawn_for_quick_action<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    api: Arc<IntelligenceApi>,
    action: QuickActionType,
    transcript_window: String,
    rolling_summary: Option<String>,
) {
    spawn_inner(
        app,
        session_id,
        api,
        TriggerSource::Hotkey, // closest existing telemetry enum (user-initiated)
        StreamMode::QuickAction(action),
        transcript_window,
        rolling_summary,
    );
}

fn spawn_inner<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    api: Arc<IntelligenceApi>,
    trigger_source: TriggerSource,
    mode: StreamMode,
    transcript_window: String,
    rolling_summary: Option<String>,
) {
    // User-click-wins (Decision N1): a QuickAction always preempts
    // an in-flight Auto suggestion. Auto suggestions still respect
    // the existing "drop if active" rule.
    let is_user_initiated = matches!(mode, StreamMode::QuickAction(_));

    let suggestion_id = Uuid::new_v4().to_string();

    // Step 1 — under the lock, decide whether to abort the existing
    // entry. We MUST drop the guard before calling abort()/spawning
    // since abort() touches tokio internals that may want to acquire
    // their own locks.
    let to_abort: Option<std::sync::Arc<tauri::async_runtime::JoinHandle<()>>> = {
        let active_state = app.state::<ActiveSuggestionMutex>();
        let mut guard = match active_state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(existing) = guard.as_ref() {
            if existing.started_at.elapsed() < ACTIVE_TTL {
                if !is_user_initiated {
                    log::info!(
                        "[Copilot/intel/suggest] dropping new {} trigger — previous suggestion still active (id={}, age={}s)",
                        trigger_source.as_str(),
                        short(&existing.suggestion_id),
                        existing.started_at.elapsed().as_secs()
                    );
                    return;
                }
                log::info!(
                    "[Copilot/intel/suggest] user-initiated quick-action preempting active id={} (age={}s)",
                    short(&existing.suggestion_id),
                    existing.started_at.elapsed().as_secs()
                );
            }
        }
        // Take the abort handle out of the existing entry (if any) so
        // we can call .abort() outside the guard.
        guard.as_mut().and_then(|a| a.abort.take())
    };

    if let Some(handle) = to_abort {
        // tauri::async_runtime::JoinHandle::abort takes &self.
        handle.abort();
    }

    // Step 2 — spawn the stream task. Wrap the JoinHandle in Arc so
    // both this scope and the ActiveSuggestion entry can hold it.
    let join_handle = {
        let app = app.clone();
        let api = api.clone();
        let session_id = session_id.clone();
        let suggestion_id = suggestion_id.clone();
        tauri::async_runtime::spawn(async move {
            run_stream(
                app,
                session_id,
                api,
                suggestion_id,
                trigger_source,
                mode,
                transcript_window,
                rolling_summary,
            )
            .await;
        })
    };
    let join_arc = std::sync::Arc::new(join_handle);

    // Step 3 — claim the slot with our suggestion_id + JoinHandle.
    let active_state = app.state::<ActiveSuggestionMutex>();
    let mut guard = match active_state.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    *guard = Some(ActiveSuggestion {
        session_id: session_id.clone(),
        suggestion_id: suggestion_id.clone(),
        started_at: Instant::now(),
        trigger_source,
        abort: Some(join_arc),
    });
    drop(guard);
}

async fn run_stream<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    api: Arc<IntelligenceApi>,
    suggestion_id: String,
    trigger_source: TriggerSource,
    mode: StreamMode,
    transcript_window: String,
    rolling_summary: Option<String>,
) {
    let stream_started = Instant::now();
    let mut first_token_seen = false;

    // Two SSE endpoints, identical wire shape — pick based on mode.
    // Box::pin both branches to a single dyn-stream so the rest of
    // run_stream stays branch-free.
    type SseStream = std::pin::Pin<
        Box<
            dyn futures_util::Stream<
                    Item = Result<SuggestSseEvent, super::api::IntelligenceApiError>,
                > + Send,
        >,
    >;
    let stream_result: Result<SseStream, super::api::IntelligenceApiError> = match &mode {
        StreamMode::Auto {
            trigger,
            trigger_phrase,
        } => {
            let req = SuggestRequest {
                trigger_source: trigger_source.as_str().to_string(),
                trigger: trigger.clone(),
                trigger_phrase: trigger_phrase.clone(),
                transcript_window,
                rolling_summary,
            };
            api.post_suggest_sse(&session_id, req)
                .await
                .map(|s| Box::pin(s) as SseStream)
        }
        StreamMode::QuickAction(action) => {
            let req = QuickActionRequest {
                action: *action,
                transcript_window,
                rolling_summary,
            };
            api.post_quick_action_sse(&session_id, req)
                .await
                .map(|s| Box::pin(s) as SseStream)
        }
    };

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

    let mode_label = match &mode {
        StreamMode::Auto { .. } => "auto",
        StreamMode::QuickAction(a) => a.as_str(),
    };
    log::info!(
        "[Copilot/intel/suggest] stream open id={} mode={} source={} session={}",
        short(&suggestion_id),
        mode_label,
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

    // Stream ended without ever emitting Done — backend silently
    // closed the SSE response (typically when the route handler
    // throws after sending headers but before any chunk lands;
    // surfaced 2026-05-04 against the deployed /suggest endpoint
    // returning 500 mid-stream).
    //
    // If we never saw a single token, the user got a brief
    // Reasoning indicator and then nothing — they have no idea
    // what happened. Release the mutex immediately so a quick
    // retry isn't silently dropped, and emit a failure so the
    // overlay can clear out of Reasoning state.
    if !first_token_seen {
        log::warn!(
            "[Copilot/intel/suggest] stream closed silently with no tokens — id={}",
            short(&suggestion_id)
        );
        emit_failed(
            &app,
            &session_id,
            "stream_closed_no_tokens".to_string(),
        );
        release_active(&app, &suggestion_id);
    } else {
        // Some text arrived but Done never did. Treat as soft
        // failure — release so the user can try again rather than
        // getting silently blocked for 30s.
        log::warn!(
            "[Copilot/intel/suggest] stream ended without Done after partial output — id={}",
            short(&suggestion_id)
        );
        release_active(&app, &suggestion_id);
    }
}

fn emit_complete<R: Runtime>(app: &AppHandle<R>, session_id: &str, payload: SuggestPayload) {
    // Sub-prompt 4 verification 2026-05-04 round 7 — earlier this
    // struct had #[serde(flatten)] on the payload field. That
    // emitted a FLAT JSON object ({session_id, suggestion_id, primary, ...})
    // but the JS reducer's SUGGESTION_COMPLETE handler reads
    // `action.payload.payload.primary` (NESTED — matching dev-mode
    // mockEvents.ts). The flat shape made `action.payload.payload`
    // undefined, the reducer threw on `.primary`, React unmounted the
    // tree, and the user saw the bare body bg-zinc-950 — i.e. a
    // "black screen the moment generation finished."
    //
    // Fix: emit the NESTED shape that the JS code already expects.
    #[derive(Serialize)]
    struct CompletePayload {
        session_id: String,
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
