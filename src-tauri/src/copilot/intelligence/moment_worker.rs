//! Moment detector worker (plan §5).
//!
//! Two cadences interleaved:
//!   - HEURISTIC_INTERVAL — heuristics fire on local Rust state every 5s
//!     (Medium) / 10s (Low). Cheap. Output: candidate triggers.
//!   - LLM_CADENCE_CAP — minimum spacing between LLM verifier calls.
//!     30s (Medium) / 60s (Low). Even if heuristics fire every cycle,
//!     we only call the verifier this often.
//!
//! V1 launches at "Low" sensitivity per Decision N8 (Risk #6
//! mitigation). Sub-prompt 6 adds the runtime sensitivity preset.
//!
//! On verifier success with `should_suggest && urgency >= threshold`:
//!   1. Update MomentCooldownMutex with the trigger's last-fired time
//!   2. Emit `copilot-moment-detected` Tauri event
//!   3. Spawn the suggest_client (Tauri::async_runtime::spawn)
//!
//! Lock discipline: drop guards before any await.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{async_runtime::JoinHandle, AppHandle, Emitter, Manager, Runtime};
use tokio::sync::watch;

use crate::copilot::state::TranscriptBufferMutex;

use super::api::{DetectMomentRequest, IntelligenceApi};
use super::heuristics::detect_candidates;
use super::state::{
    MomentCooldownMutex, RollingSummaryMutex, TriggerSource, TriggerType,
};
use super::suggest_client;

// ── Sensitivity preset (V1 default = High after PO 2026-05-04 retune) ───
// Original Decision N8 locked "Low" for the conservative launch
// (heuristic 10s / LLM cap 60s / urgency≥4). PO feedback after live
// testing: hotkey-only feels constant, suggestions felt too rare
// when they should be reactive to the transcript. Bumped to "High"
// so the AI surfaces suggestions on real moments without the user
// pressing ⌘⌥G every time. ~4-6× more frequent than Low.
//
// Sub-prompt 6 will surface this as a user-toggle (Off/Low/Medium/
// High) per design Decision N4. For now hardcoded.
const HEURISTIC_INTERVAL_SECS: u64 = 5;
const LLM_CADENCE_CAP_SECS: u64 = 15;
const URGENCY_THRESHOLD: u8 = 3;

/// Window we send to the verifier prompt (90s of transcript).
const VERIFIER_WINDOW_SECS: u64 = 90;

#[derive(Debug, Clone, Serialize)]
struct MomentDetectedPayload {
    session_id: String,
    trigger: String,
    trigger_phrase: Option<String>,
    urgency: u8,
    rationale: String,
}

pub fn spawn<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    api: Arc<IntelligenceApi>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(HEURISTIC_INTERVAL_SECS));
        // Skip first immediate tick so transcripts have a chance to populate.
        interval.tick().await;

        log::info!(
            "[Copilot/intel/moment] worker started for session {}",
            short(&session_id)
        );

        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        log::info!(
                            "[Copilot/intel/moment] worker exiting cleanly for session {}",
                            short(&session_id)
                        );
                        return;
                    }
                }
                _ = interval.tick() => {
                    run_one_cycle(&app, &session_id, &api).await;
                }
            }
        }
    })
}

async fn run_one_cycle<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    api: &Arc<IntelligenceApi>,
) {
    let now = Instant::now();

    // 1. Snapshot transcript + cooldowns; drop guards before await.
    let (transcript, cooldown_map, last_llm_verify) = {
        let buf_state = app.state::<TranscriptBufferMutex>();
        let cool_state = app.state::<MomentCooldownMutex>();
        let buf_guard = match buf_state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let cool_guard = match cool_state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let transcript = buf_guard.last_n_seconds(VERIFIER_WINDOW_SECS);
        let cooldowns = cool_guard.last_fired.clone();
        let last_verify = cool_guard.last_llm_verify;
        (transcript, cooldowns, last_verify)
    };

    if transcript.is_empty() {
        return;
    }

    // 2. Heuristic check.
    let candidates = detect_candidates(&transcript, &cooldown_map, now);
    if candidates.is_empty() {
        return;
    }

    // 3. LLM cadence cap — even with candidates, throttle the
    // verifier call.
    if let Some(last) = last_llm_verify {
        if now.saturating_duration_since(last).as_secs() < LLM_CADENCE_CAP_SECS {
            log::debug!(
                "[Copilot/intel/moment] {} candidate(s) suppressed by LLM cadence cap, session {}",
                candidates.len(),
                short(session_id)
            );
            return;
        }
    }

    log::info!(
        "[Copilot/intel/moment] {} heuristic candidate(s): {:?} for session {}",
        candidates.len(),
        candidates.iter().map(|c| c.trigger.as_str()).collect::<Vec<_>>(),
        short(session_id)
    );

    // 4. Snapshot rolling summary (drop lock before await).
    let rolling_summary = {
        let summary_state = app.state::<RollingSummaryMutex>();
        let guard = match summary_state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        guard.as_ref().map(|s| s.text.clone())
    };

    // 5. Format window + call verifier.
    let window_text = super::format_transcript_window(&transcript);
    let req = DetectMomentRequest {
        candidate_triggers: candidates
            .iter()
            .map(|c| c.trigger.as_str().to_string())
            .collect(),
        transcript_window: window_text.clone(),
        rolling_summary: rolling_summary.clone(),
    };

    // Mark verifier-call attempt time NOW so back-to-back failures
    // also get cadence-capped.
    if let Ok(mut g) = app.state::<MomentCooldownMutex>().0.lock() {
        g.last_llm_verify = Some(Instant::now());
        if g.session_id.is_empty() {
            g.session_id = session_id.to_string();
        }
    }

    let resp = match api.post_detect_moment(session_id, req).await {
        Ok(r) => r,
        Err(e) => {
            log::warn!(
                "[Copilot/intel/moment] verifier call failed: {} for session {}",
                e,
                short(session_id)
            );
            return;
        }
    };

    // 6. Surfacing rule.
    if !resp.should_suggest
        || resp.urgency < URGENCY_THRESHOLD
        || resp.is_speaker_mid_statement
        || resp.trigger == "none"
    {
        log::debug!(
            "[Copilot/intel/moment] verifier said no-fire (trigger={}, urgency={}, mid={}, ss={}) for session {}",
            resp.trigger,
            resp.urgency,
            resp.is_speaker_mid_statement,
            resp.should_suggest,
            short(session_id)
        );
        return;
    }

    // 7. Update cooldown for this trigger type.
    let trigger_type = match TriggerType::from_str(&resp.trigger) {
        Some(t) => t,
        None => {
            log::warn!(
                "[Copilot/intel/moment] verifier returned unknown trigger '{}' — dropping",
                resp.trigger
            );
            return;
        }
    };
    if let Ok(mut g) = app.state::<MomentCooldownMutex>().0.lock() {
        g.last_fired.insert(trigger_type, Instant::now());
    }

    log::info!(
        "[Copilot/intel/moment] FIRED trigger={} urgency={} session={}",
        resp.trigger,
        resp.urgency,
        short(session_id)
    );

    // 8. Emit Tauri event.
    let _ = app.emit(
        "copilot-moment-detected",
        &MomentDetectedPayload {
            session_id: session_id.to_string(),
            trigger: resp.trigger.clone(),
            trigger_phrase: resp.trigger_phrase.clone(),
            urgency: resp.urgency,
            rationale: resp.rationale.clone(),
        },
    );

    // Sub-prompt 4 N3 — pending event for the overlay's Reasoning
    // indicator. Defensive: copilot-moment-detected and -pending
    // both fire here; the overlay reducer dedupes (whichever lands
    // first wins; the other is a no-op).
    let _ = app.emit(
        "copilot-suggestion-pending",
        serde_json::json!({
            "trigger_source": "moment",
            "trigger": &resp.trigger,
            "trigger_phrase": &resp.trigger_phrase,
        }),
    );

    // 9. Spawn suggest_client (Tauri-runtime, never blocks this worker).
    suggest_client::spawn_for_moment(
        app.clone(),
        session_id.to_string(),
        api.clone(),
        TriggerSource::Moment,
        Some(resp.trigger),
        resp.trigger_phrase,
        window_text,
        rolling_summary,
    );
}

fn short(session_id: &str) -> &str {
    &session_id[..8.min(session_id.len())]
}
