//! Wolfee Copilot Intelligence layer (Sub-prompt 3).
//!
//! Three workers run as `tauri::async_runtime::spawn` tasks during a
//! Listening session. They consume the per-session
//! `TranscriptBufferMutex` (Sub-prompt 2 sacred — read-only) and emit
//! Tauri events that Sub-prompt 4's overlay will eventually render.
//!
//! - `summary_worker` — every 30s, calls backend /summary; updates
//!   RollingSummaryMutex; emits `copilot-summary-updated`.
//! - `moment_worker` — heuristic check every 5/10s, LLM verifier
//!   gated by per-trigger cooldown; emits `copilot-moment-detected`
//!   on `should_suggest=true && urgency >= threshold`.
//! - `suggest_client` (per event, not long-running) — fires on
//!   moment OR hotkey; opens SSE stream to backend /suggest; emits
//!   `copilot-suggestion-streaming` per delta + `copilot-suggestion`
//!   on completion. ActiveSuggestionMutex gates concurrency.
//!
//! All HTTP calls go through `intelligence::api` (separate from the
//! Sub-prompt 2 `session::api` which stays sacred). Heuristics live
//! in `heuristics` (pure logic, unit-testable). State types in
//! `state` get registered via `app.manage(...)` in `lib.rs`.
//!
//! Runtime ownership lesson from Phase 5 commit `6d0f113` applies
//! here too — every spawn uses `tauri::async_runtime::spawn`, never
//! a one-shot `current_thread` runtime via `spawn_async`. Lock
//! discipline lesson from Phase 6 commit `5cc2425` — drop
//! `MutexGuard`s before any `.await`.

pub mod api;
pub mod heuristics;
pub mod moment_worker;
pub mod state;
pub mod suggest_client;
pub mod summary_worker;

use std::sync::Arc;

use tauri::{async_runtime::JoinHandle, AppHandle, Runtime};
use tokio::sync::watch;

use self::api::IntelligenceApi;
use crate::copilot::transcribe::buffer::{ChannelLabel, Utterance};

/// Format a list of utterances as the labeled-line format the
/// backend prompts expect:
///   user: ...\n
///   speakers: ...\n
///
/// Shared by the summary, moment, and suggest workers.
pub fn format_transcript_window(utts: &[Utterance]) -> String {
    let mut out = String::with_capacity(utts.len() * 80);
    for u in utts {
        let label = match u.channel {
            ChannelLabel::User => "user",
            ChannelLabel::Speakers => "speakers",
        };
        out.push_str(label);
        out.push_str(": ");
        out.push_str(&u.text);
        out.push('\n');
    }
    out
}

/// Owned shutdown signal + worker handles for the intelligence
/// layer of a single Copilot session. Created when the session goes
/// Listening; consumed (and signalled to shut down) when the
/// session ends.
pub struct IntelligenceWorkers {
    pub session_id: String,
    pub shutdown_tx: watch::Sender<bool>,
    pub summary_handle: JoinHandle<()>,
    pub moment_handle: JoinHandle<()>,
}

impl IntelligenceWorkers {
    /// Send the shutdown signal and await both workers (with a soft
    /// timeout so a stuck worker doesn't block session teardown).
    /// Called from the `end-copilot-session` handler.
    pub async fn stop(self) {
        let _ = self.shutdown_tx.send(true);
        // Workers poll the shutdown_rx with a small interval so
        // they exit promptly. Cap teardown at 5s in case a worker
        // is blocked on a long LLM call — abort if so.
        let timeout = std::time::Duration::from_secs(5);
        let summary = tokio::time::timeout(timeout, self.summary_handle);
        let moment = tokio::time::timeout(timeout, self.moment_handle);
        let (s, m) = tokio::join!(summary, moment);
        if s.is_err() {
            log::warn!("[Copilot/intel] summary worker did not exit within 5s — abandoning");
        }
        if m.is_err() {
            log::warn!("[Copilot/intel] moment worker did not exit within 5s — abandoning");
        }
    }
}

/// Spawn both background workers for a freshly-started session.
/// `lib.rs` calls this after audio capture + Deepgram client are up.
///
/// We take backend_url + device_token rather than borrowing from
/// `session::api::SessionApi` (which is Sub-prompt 2 sacred and
/// keeps its fields private). The intelligence layer constructs
/// its own `IntelligenceApi` from these.
pub fn spawn_workers<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    backend_url: String,
    device_token: String,
) -> IntelligenceWorkers {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let api = Arc::new(IntelligenceApi::new(backend_url, device_token));

    let summary_handle = summary_worker::spawn(
        app.clone(),
        session_id.clone(),
        api.clone(),
        shutdown_rx.clone(),
    );

    let moment_handle = moment_worker::spawn(
        app.clone(),
        session_id.clone(),
        api,
        shutdown_rx,
    );

    log::info!(
        "[Copilot/intel] workers spawned for session {}",
        &session_id[..8.min(session_id.len())]
    );

    IntelligenceWorkers {
        session_id,
        shutdown_tx,
        summary_handle,
        moment_handle,
    }
}
