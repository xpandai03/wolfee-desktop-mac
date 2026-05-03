//! Rolling summary worker (plan §4).
//!
//! Spawned via `tauri::async_runtime::spawn` from
//! `intelligence::spawn_workers`. Polls TranscriptBufferMutex every
//! 30s; when there's new transcript content, POSTs to /summary and
//! updates the per-session RollingSummaryMutex + emits a
//! `copilot-summary-updated` Tauri event.
//!
//! Lock discipline (lesson from Phase 6 commit `5cc2425`): take
//! owned data out of MutexGuards, drop guards, then await.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{async_runtime::JoinHandle, AppHandle, Emitter, Manager, Runtime};
use tokio::sync::watch;

use crate::copilot::state::TranscriptBufferMutex;

use super::api::{IntelligenceApi, SummaryMode, SummaryRequest};
use super::state::{RollingSummary, RollingSummaryMutex};

const SUMMARY_INTERVAL_SECS: u64 = 30;
const FULL_RESYNTHESIS_EVERY_N_TICKS: u32 = 10; // ≈ 5 min
const INCREMENTAL_WINDOW_SECS: u64 = 35;
const FULL_WINDOW_SECS: u64 = 300;
/// Don't fire the first call until the buffer has at least this many
/// seconds of content — saves a noisy "what happened?" at session
/// start when only 5s of audio exist.
const MIN_FIRST_CALL_WINDOW_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize)]
struct CopilotSummaryUpdatedPayload {
    session_id: String,
    summary: String,
    generated_at_ms: u64,
    generation_count: u32,
}

pub fn spawn<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    api: Arc<IntelligenceApi>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut tick: u32 = 0;
        let mut last_failure_count: u32 = 0;
        let mut interval = tokio::time::interval(Duration::from_secs(SUMMARY_INTERVAL_SECS));
        // Skip the first immediate tick — we want to wait the full
        // 30s before the first call so the buffer has content.
        interval.tick().await;

        log::info!(
            "[Copilot/intel/summary] worker started for session {}",
            short(&session_id)
        );

        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        log::info!(
                            "[Copilot/intel/summary] worker exiting cleanly for session {}",
                            short(&session_id)
                        );
                        return;
                    }
                }
                _ = interval.tick() => {
                    tick += 1;

                    let mode = if tick % FULL_RESYNTHESIS_EVERY_N_TICKS == 0 {
                        SummaryMode::Full
                    } else {
                        SummaryMode::Incremental
                    };
                    let window_secs = match mode {
                        SummaryMode::Incremental => INCREMENTAL_WINDOW_SECS,
                        SummaryMode::Full => FULL_WINDOW_SECS,
                    };

                    // Take owned snapshot of transcript window. Lock is
                    // dropped at the end of this block before the await.
                    let window_text: Option<String> = {
                        let buf_state = app.state::<TranscriptBufferMutex>();
                        let guard = match buf_state.0.lock() {
                            Ok(g) => g,
                            Err(_) => continue,
                        };
                        let utts = guard.last_n_seconds(window_secs);
                        if utts.is_empty() {
                            None
                        } else {
                            Some(super::format_transcript_window(&utts))
                        }
                    };

                    let Some(window_text) = window_text else {
                        log::debug!(
                            "[Copilot/intel/summary] empty window — skip tick {} for session {}",
                            tick,
                            short(&session_id)
                        );
                        continue;
                    };

                    // First-call guard: skip until we have enough content.
                    if tick == 1 && window_text.len() < 200 {
                        log::debug!(
                            "[Copilot/intel/summary] skipping first tick — window too short ({}b) for session {}",
                            window_text.len(),
                            short(&session_id)
                        );
                        let _ = MIN_FIRST_CALL_WINDOW_SECS; // suppress unused; kept for future tuning
                        continue;
                    }

                    let previous = {
                        let summary_state = app.state::<RollingSummaryMutex>();
                        let guard = match summary_state.0.lock() {
                            Ok(g) => g,
                            Err(_) => continue,
                        };
                        guard.as_ref().map(|s| s.text.clone())
                    };

                    let req = SummaryRequest {
                        window: window_text,
                        previous,
                        mode,
                    };

                    match api.post_summary(&session_id, req).await {
                        Ok(resp) => {
                            last_failure_count = 0;
                            let now = Instant::now();
                            let now_ms = chrono::Utc::now().timestamp_millis() as u64;
                            let new_count;
                            {
                                let summary_state = app.state::<RollingSummaryMutex>();
                                let mut guard = summary_state.0.lock().unwrap();
                                let count = guard.as_ref().map(|s| s.generation_count + 1).unwrap_or(1);
                                new_count = count;
                                *guard = Some(RollingSummary {
                                    session_id: session_id.clone(),
                                    text: resp.summary.clone(),
                                    generated_at: now,
                                    generation_count: count,
                                });
                            }
                            log::info!(
                                "[Copilot/intel/summary] updated session={} mode={:?} count={} chars={}",
                                short(&session_id),
                                mode,
                                new_count,
                                resp.summary.len()
                            );
                            let _ = app.emit(
                                "copilot-summary-updated",
                                &CopilotSummaryUpdatedPayload {
                                    session_id: session_id.clone(),
                                    summary: resp.summary,
                                    generated_at_ms: now_ms,
                                    generation_count: new_count,
                                },
                            );
                        }
                        Err(e) => {
                            last_failure_count += 1;
                            if last_failure_count >= 3 {
                                log::error!(
                                    "[Copilot/intel/summary] {} consecutive failures (latest: {}) for session {}",
                                    last_failure_count,
                                    e,
                                    short(&session_id)
                                );
                            } else {
                                log::warn!(
                                    "[Copilot/intel/summary] call failed: {} (consec={}) for session {}",
                                    e,
                                    last_failure_count,
                                    short(&session_id)
                                );
                            }
                        }
                    }
                }
            }
        }
    })
}

fn short(session_id: &str) -> &str {
    &session_id[..8.min(session_id.len())]
}
