mod auth;
mod copilot;
mod recorder;
mod state;
mod tray;
mod uploader;

use auth::AuthConfig;
use copilot::audio::{AudioError, CopilotAudioCapture, PermissionKind};
use copilot::intelligence::state::{
    ActiveSuggestionMutex, MomentCooldownMutex, RollingSummaryMutex,
};
use copilot::intelligence::{spawn_workers, IntelligenceWorkers};
use copilot::session::api::{EndReason, SessionApi};
use copilot::state::{
    CopilotAudioCaptureMutex, CopilotState, CopilotStateMutex, TranscriptBufferMutex,
};
use copilot::transcribe::deepgram::DeepgramClient;
use recorder::Recorder;
use state::{AppState, LinkingStatus, RecordingState, UploadStatus};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Listener, Manager, WindowEvent};
use tauri_plugin_store::StoreExt;

/// Sub-prompt 5.0 — store file holding user-flag persistence. Lives
/// next to the other auth/config files in the app's data dir.
///
/// Sub-prompt 5.2 — welcome key is now scoped by paired user_id so
/// shared Macs (different wolfee.io accounts on same machine) don't
/// suppress each other's onboarding. Unpaired callers still get a
/// stable key so they see welcome exactly once before pairing. One-
/// time migration cost from 5.0 → 5.2: every paired user will see
/// welcome once after upgrading because the new per-user key starts
/// unset.
const FLAGS_STORE_PATH: &str = "flags.json";
const WELCOME_KEY_PREFIX: &str = "wolfee_welcome_shown_v1";

/// Sub-prompt 6.0 — onboarding wizard flag scoped per paired user_id.
/// `_completed` is the boolean "user finished or skipped the wizard";
/// `_last_step` is the resume-mid-tour step index (1..6).
const ONBOARDING_COMPLETED_PREFIX: &str = "wolfee_onboarding_completed_v1";
const ONBOARDING_LAST_STEP_PREFIX: &str = "wolfee_onboarding_last_step_v1";

fn welcome_key_for(user_id: Option<&str>) -> String {
    match user_id {
        Some(uid) if !uid.is_empty() => {
            format!("{}_{}", WELCOME_KEY_PREFIX, uid)
        }
        _ => format!("{}_unpaired", WELCOME_KEY_PREFIX),
    }
}

fn onboarding_completed_key_for(user_id: Option<&str>) -> String {
    match user_id {
        Some(uid) if !uid.is_empty() => {
            format!("{}_{}", ONBOARDING_COMPLETED_PREFIX, uid)
        }
        _ => format!("{}_unpaired", ONBOARDING_COMPLETED_PREFIX),
    }
}

fn onboarding_last_step_key_for(user_id: Option<&str>) -> String {
    match user_id {
        Some(uid) if !uid.is_empty() => {
            format!("{}_{}", ONBOARDING_LAST_STEP_PREFIX, uid)
        }
        _ => format!("{}_unpaired", ONBOARDING_LAST_STEP_PREFIX),
    }
}

fn open_url(url: &str) {
    log::info!("[App] Opening URL: {}", url);
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    }
}

/// Run async work on a dedicated thread to avoid deadlocking the main event loop.
fn spawn_async<F, Fut>(name: &str, f: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let name = name.to_string();
    std::thread::Builder::new()
        .name(name.clone())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to create tokio runtime");
            rt.block_on(f());
        })
        .unwrap_or_else(|e| panic!("Failed to spawn thread {}: {}", name, e));
}

/// Tauri-managed wrapper around the active session's intelligence
/// workers. `None` between sessions; populated when
/// `start-copilot-session` finishes spawning workers and taken back
/// out + stopped by `end-copilot-session`. tokio::Mutex because
/// IntelligenceWorkers::stop() is async (await across the guard).
struct IntelligenceWorkersMutex(tokio::sync::Mutex<Option<IntelligenceWorkers>>);

/// Sub-prompt 4.8 — mode_used_id from the ContextWindow submit, kept
/// alive for the duration of the session so the finalize POST can
/// attribute the session to the right Mode template. Set when the
/// user clicks Submit on ContextWindow; cleared on session end.
///
/// Sub-prompt 5.0 — also tracks the human-readable mode name so the
/// post-session takeover card can show "Discovery mode" subtext
/// without an extra round-trip to the modes API.
#[derive(Default, Clone)]
struct ActiveMode {
    id: Option<String>,
    name: Option<String>,
}
struct ActiveModeIdMutex(std::sync::Mutex<ActiveMode>);
impl Default for ActiveModeIdMutex {
    fn default() -> Self {
        Self(std::sync::Mutex::new(ActiveMode::default()))
    }
}

// Phase 5 had a `spawn_frame_logger` here that just counted AudioFrames
// every 5s for runtime verification. Phase 3 replaces it with
// `copilot::transcribe::deepgram::DeepgramClient::spawn`, which owns
// the same Receiver and forwards frames to Deepgram's WebSocket. The
// runtime-ownership note (use `tauri::async_runtime::spawn`, never the
// dedicated `spawn_async`) carries over to the new client — see the
// comment on its `spawn` method.

/// Sub-prompt 4.5 context fields, captured from the context paste
/// window. All optional — empty submission falls back to pre-4.5
/// "no context" behavior.
#[derive(Debug, Clone, Default)]
struct CopilotContextFields {
    about_user: Option<String>,
    about_call: Option<String>,
    objections: Option<String>,
}

impl CopilotContextFields {
    fn is_empty(&self) -> bool {
        self.about_user.as_ref().map_or(true, |s| s.trim().is_empty())
            && self.about_call.as_ref().map_or(true, |s| s.trim().is_empty())
            && self.objections.as_ref().map_or(true, |s| s.trim().is_empty())
    }

    fn from_value(v: &serde_json::Value) -> Self {
        fn read(v: &serde_json::Value, key: &str) -> Option<String> {
            v.get(key)
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        }
        Self {
            about_user: read(v, "about_user"),
            about_call: read(v, "about_call"),
            objections: read(v, "objections"),
        }
    }
}

/// Module-level session-start worker. Extracted from the old inline
/// `start-copilot-session` action handler for Sub-prompt 4.5 so both
/// the legacy path (no context) and the new context-window path
/// (with 3 paste fields) share identical lifecycle plumbing. The
/// only branch is the optional /context POST after the session is
/// minted backend-side.
fn spawn_session_workers(
    handle: tauri::AppHandle,
    tray: Arc<tauri::tray::TrayIcon>,
    session_id: String,
    backend_url: String,
    device_token: String,
    context: CopilotContextFields,
) {
    {
        let copilot_mutex = handle.state::<CopilotStateMutex>();
        *copilot_mutex.0.lock().unwrap() =
            CopilotState::StartingSession { session_id: session_id.clone() };
        let app_state: tauri::State<'_, AppState> = handle.state();
        tray::update_tray_menu(
            &tray,
            &handle,
            app_state.current_state(),
            app_state.auth_token.lock().unwrap().is_some(),
        );
    }

    tauri::async_runtime::spawn(async move {
        let api = SessionApi::new(backend_url.clone(), device_token.clone());

        // 1. Mint session id backend-side.
        match api.create_session(&session_id).await {
            Ok(resp) => {
                log::info!(
                    "[Copilot] backend session created — id={}, startedAt={}",
                    resp.session_id, resp.started_at
                );
            }
            Err(e) => {
                log::error!(
                    "[Copilot] create_session failed: {} — aborting start",
                    e
                );
                let copilot_mutex = handle.state::<CopilotStateMutex>();
                *copilot_mutex.0.lock().unwrap() = CopilotState::Idle;
                let app_state: tauri::State<'_, AppState> = handle.state();
                tray::update_tray_menu(
                    &tray,
                    &handle,
                    app_state.current_state(),
                    app_state.auth_token.lock().unwrap().is_some(),
                );
                copilot::context_window::close_context_window(&handle);
                return;
            }
        }

        // 1.5. Sub-prompt 4.5 — POST /context BEFORE audio starts so
        //      the very first /summary/moment/suggest call sees the
        //      paste-in fields. Best-effort: a /context failure is
        //      logged but doesn't abort the session (degrades to
        //      no-context mode, same as pre-4.5).
        if !context.is_empty() {
            let intel_api = copilot::intelligence::api::IntelligenceApi::new(
                backend_url.clone(),
                device_token.clone(),
            );
            let req = copilot::intelligence::api::ContextRequest {
                about_user: context.about_user.clone(),
                about_call: context.about_call.clone(),
                objections: context.objections.clone(),
            };
            match intel_api.post_context(&session_id, req).await {
                Ok(()) => log::info!("[Copilot] context posted to backend session={}", &session_id[..8.min(session_id.len())]),
                Err(e) => log::warn!("[Copilot] /context failed (degrading to no-context): {}", e),
            }
        }

        // 2. Start audio capture (mic + system + mux pump).
        let (frame_tx, frame_rx) = tokio::sync::mpsc::channel::<copilot::audio::AudioFrame>(64);

        let capture = match CopilotAudioCapture::start(session_id.clone(), frame_tx).await {
            Ok(c) => c,
            Err(e) => {
                log::error!(
                    "[Copilot] audio capture start failed: {} — \
                     ending backend session and reverting state",
                    e
                );
                if let AudioError::PermissionDenied(kind) = &e {
                    let kind_str = match kind {
                        PermissionKind::Microphone => "Microphone",
                        PermissionKind::ScreenRecording => "ScreenRecording",
                    };
                    if let Err(err) = copilot::window::show_overlay(&handle) {
                        log::warn!(
                            "[Copilot] show_overlay for permission modal failed: {}",
                            err
                        );
                    }
                    if let Err(err) = handle.emit(
                        "copilot-permission-needed",
                        serde_json::json!({
                            "kind": kind_str,
                            "session_id": session_id.clone(),
                        }),
                    ) {
                        log::warn!(
                            "[Copilot] copilot-permission-needed emit failed: {}",
                            err
                        );
                    }
                }
                let _ = api.end_session(&session_id, EndReason::Error).await;
                let copilot_mutex = handle.state::<CopilotStateMutex>();
                *copilot_mutex.0.lock().unwrap() = CopilotState::Idle;
                let app_state: tauri::State<'_, AppState> = handle.state();
                tray::update_tray_menu(
                    &tray,
                    &handle,
                    app_state.current_state(),
                    app_state.auth_token.lock().unwrap().is_some(),
                );
                copilot::context_window::close_context_window(&handle);
                return;
            }
        };

        // 3. Stash capture handle in managed state.
        let cap_mutex = handle.state::<CopilotAudioCaptureMutex>();
        *cap_mutex.0.lock().await = Some(capture);
        drop(cap_mutex);

        // 4. Transition to Listening + refresh tray BEFORE Deepgram spawn.
        {
            let copilot_mutex = handle.state::<CopilotStateMutex>();
            *copilot_mutex.0.lock().unwrap() = CopilotState::Listening {
                session_id: session_id.clone(),
                started_at: std::time::Instant::now(),
            };
        }
        let app_state: tauri::State<'_, AppState> = handle.state();
        tray::update_tray_menu(
            &tray,
            &handle,
            app_state.current_state(),
            app_state.auth_token.lock().unwrap().is_some(),
        );

        // 5. Spawn the Deepgram WebSocket client.
        let api_arc = std::sync::Arc::new(api);
        let _dg_handle = DeepgramClient::spawn(
            session_id.clone(),
            api_arc,
            frame_rx,
            handle.clone(),
        );

        // 6. Spawn Sub-prompt 3 intelligence workers.
        let workers = spawn_workers(
            handle.clone(),
            session_id.clone(),
            backend_url.clone(),
            device_token.clone(),
        );
        let workers_mutex = handle.state::<IntelligenceWorkersMutex>();
        *workers_mutex.0.lock().await = Some(workers);
        drop(workers_mutex);

        // 7. Sub-prompt 4.5: now that the session is live, close the
        //    context paste window (no-op if it was already destroyed
        //    on a /context error path, idempotent).
        copilot::context_window::close_context_window(&handle);

        // 8. Show the overlay so the user has something to look at
        //    immediately (auto-suggestions take ~30-60s to start
        //    firing, but click-driven action buttons work right away).
        if let Err(e) = copilot::window::show_overlay(&handle) {
            log::warn!("[Copilot] show_overlay after session start failed: {}", e);
        }

        log::info!(
            "[Copilot] session live — id={}, Deepgram + intelligence workers spawned",
            session_id
        );
    });
}

/// Sub-prompt 4.5 — dispatcher for `wolfee-action` events whose
/// payload is a JSON object with a `type` field. Carries typed args
/// (e.g. submit-copilot-context's 3 strings, trigger-copilot-quick-action's
/// action enum). Plain string payloads still go through the legacy
/// match block in lib.rs::run.
fn handle_structured_action(
    action_type: &str,
    payload: &serde_json::Value,
    tray: &Arc<tauri::tray::TrayIcon>,
    backend_url: &str,
) {
    let handle = tray.app_handle();
    match action_type {
        // ─────────────────────────────────────────
        // SUBMIT CONTEXT → start session with paste-in fields
        // ─────────────────────────────────────────
        "submit-copilot-context" => {
            log::info!("[Copilot] Context submitted — starting session");

            // Idempotent: ignore if not Idle/ShowingOverlay.
            let copilot_mutex = handle.state::<CopilotStateMutex>();
            {
                let cur = copilot_mutex.0.lock().unwrap();
                if !matches!(*cur, CopilotState::Idle | CopilotState::ShowingOverlay) {
                    log::info!(
                        "[Copilot] Ignoring submit-context — current state: {}",
                        *cur
                    );
                    return;
                }
            }

            let device_token = {
                let app_state: tauri::State<'_, AppState> = handle.state();
                let token_opt = app_state.auth_token.lock().unwrap().clone();
                match token_opt {
                    Some(t) => t,
                    None => {
                        log::warn!(
                            "[Copilot] Cannot submit context — not paired."
                        );
                        return;
                    }
                }
            };

            let context = CopilotContextFields::from_value(payload);
            // Sub-prompt 4.8 — capture mode_used_id from the
            // submit payload so the finalize POST can attribute the
            // session to the right Mode template.
            // Sub-prompt 5.0 — also capture mode_used_name so the
            // post-session takeover can show it without re-querying.
            let mode_used_id = payload
                .get("mode_used_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mode_used_name = payload
                .get("mode_used_name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Ok(mut g) = handle.state::<ActiveModeIdMutex>().0.lock() {
                *g = ActiveMode {
                    id: mode_used_id,
                    name: mode_used_name,
                };
            }

            let session_id = uuid::Uuid::new_v4().to_string();
            spawn_session_workers(
                handle.clone(),
                tray.clone(),
                session_id,
                backend_url.to_string(),
                device_token,
                context,
            );
        }

        // ─────────────────────────────────────────
        // TRIGGER QUICK-ACTION → spawn suggest_client with action
        // ─────────────────────────────────────────
        "trigger-copilot-quick-action" => {
            let action = match payload
                .get("action")
                .and_then(|v| v.as_str())
                .and_then(copilot::intelligence::api::QuickActionType::from_str)
            {
                Some(a) => a,
                None => {
                    log::warn!(
                        "[Copilot] trigger-copilot-quick-action: invalid action {:?}",
                        payload.get("action")
                    );
                    return;
                }
            };

            let session_id = {
                let copilot_mutex = handle.state::<CopilotStateMutex>();
                let cur = copilot_mutex.0.lock().unwrap().clone();
                match cur {
                    CopilotState::Listening { session_id, .. }
                    | CopilotState::Reconnecting { session_id, .. } => session_id,
                    other => {
                        log::debug!(
                            "[Copilot] quick-action ignored — state: {}",
                            other
                        );
                        return;
                    }
                }
            };

            let device_token = {
                let app_state: tauri::State<'_, AppState> = handle.state();
                let token_opt = app_state.auth_token.lock().unwrap().clone();
                match token_opt {
                    Some(t) => t,
                    None => {
                        log::warn!("[Copilot] quick-action ignored — not authed");
                        return;
                    }
                }
            };

            let window_text = {
                let buf = handle.state::<TranscriptBufferMutex>();
                let g = match buf.0.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                let utts = g.last_n_seconds(90);
                if utts.is_empty() {
                    log::info!(
                        "[Copilot] quick-action — empty transcript, sending placeholder"
                    );
                    "(no transcript yet)".to_string()
                } else {
                    copilot::intelligence::format_transcript_window(&utts)
                }
            };
            let rolling_summary = match handle.state::<RollingSummaryMutex>().0.lock() {
                Ok(g) => g.as_ref().map(|x| x.text.clone()),
                Err(_) => None,
            };

            let api = std::sync::Arc::new(
                copilot::intelligence::api::IntelligenceApi::new(
                    backend_url.to_string(),
                    device_token,
                ),
            );

            // Sub-prompt 4 N3 — fire pending event so the overlay
            // shows the Reasoning indicator immediately.
            let _ = handle.emit(
                "copilot-suggestion-pending",
                serde_json::json!({
                    "trigger_source": "hotkey",
                    "trigger": action.as_str(),
                }),
            );

            copilot::intelligence::suggest_client::spawn_for_quick_action(
                handle.clone(),
                session_id,
                api,
                action,
                window_text,
                rolling_summary,
            );
        }

        // ─────────────────────────────────────────
        // Sub-prompt 4.6 — chat input dispatch
        // ─────────────────────────────────────────
        "submit-chat-question" => {
            let question = match payload.get("question").and_then(|v| v.as_str()) {
                Some(q) if !q.is_empty() => q.to_string(),
                _ => {
                    log::warn!("[Copilot] submit-chat-question: empty/missing question");
                    return;
                }
            };
            let ai_response_id = payload
                .get("ai_response_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if ai_response_id.is_empty() {
                log::warn!("[Copilot] submit-chat-question: missing ai_response_id");
                return;
            }

            let session_id = {
                let copilot_mutex = handle.state::<CopilotStateMutex>();
                let cur = copilot_mutex.0.lock().unwrap().clone();
                match cur {
                    CopilotState::Listening { session_id, .. }
                    | CopilotState::Reconnecting { session_id, .. } => session_id,
                    other => {
                        log::debug!(
                            "[Copilot] chat question ignored — state: {}",
                            other
                        );
                        // Tell the frontend to fail the streaming slot
                        // so the user sees an error rather than a
                        // forever-spinning bubble.
                        let _ = handle.emit(
                            "copilot-chat-failed",
                            serde_json::json!({
                                "ai_response_id": ai_response_id,
                                "reason": "no_active_session",
                            }),
                        );
                        return;
                    }
                }
            };

            let device_token = {
                let app_state: tauri::State<'_, AppState> = handle.state();
                let token_opt = app_state.auth_token.lock().unwrap().clone();
                match token_opt {
                    Some(t) => t,
                    None => {
                        log::warn!("[Copilot] chat question ignored — not authed");
                        let _ = handle.emit(
                            "copilot-chat-failed",
                            serde_json::json!({
                                "ai_response_id": ai_response_id,
                                "reason": "not_authed",
                            }),
                        );
                        return;
                    }
                }
            };

            let window_text = {
                let buf = handle.state::<TranscriptBufferMutex>();
                let g = match buf.0.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                let utts = g.last_n_seconds(90);
                if utts.is_empty() {
                    "(no transcript yet)".to_string()
                } else {
                    copilot::intelligence::format_transcript_window(&utts)
                }
            };
            let rolling_summary = match handle.state::<RollingSummaryMutex>().0.lock() {
                Ok(g) => g.as_ref().map(|x| x.text.clone()),
                Err(_) => None,
            };

            // Sub-prompt 4.7 — forward thread history for memory.
            let chat_history: Vec<copilot::intelligence::api::ChatHistoryEntry> =
                payload
                    .get("chat_history")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|entry| {
                                let role = entry.get("role")?.as_str()?;
                                let content = entry.get("content")?.as_str()?;
                                if role != "user" && role != "assistant" {
                                    return None;
                                }
                                Some(
                                    copilot::intelligence::api::ChatHistoryEntry {
                                        role: role.to_string(),
                                        content: content.to_string(),
                                    },
                                )
                            })
                            .collect()
                    })
                    .unwrap_or_default();

            let api = std::sync::Arc::new(
                copilot::intelligence::api::IntelligenceApi::new(
                    backend_url.to_string(),
                    device_token,
                ),
            );

            copilot::intelligence::suggest_client::spawn_for_chat_question(
                handle.clone(),
                session_id,
                api,
                ai_response_id,
                question,
                chat_history,
                window_text,
                rolling_summary,
            );
        }

        // ─────────────────────────────────────────
        // Sub-prompt 4.8 — Copilot Modes (synced via wolfee.io)
        // ─────────────────────────────────────────
        "list-copilot-modes" => {
            let device_token = {
                let app_state: tauri::State<'_, AppState> = handle.state();
                let token = app_state.auth_token.lock().unwrap().clone();
                match token {
                    Some(t) => t,
                    None => {
                        let _ = handle.emit(
                            "copilot-modes-loaded",
                            serde_json::json!({ "modes": [], "error": "not_authed" }),
                        );
                        return;
                    }
                }
            };
            let backend_url_owned = backend_url.to_string();
            let handle_clone = handle.clone();
            tauri::async_runtime::spawn(async move {
                let api = copilot::intelligence::api::IntelligenceApi::new(
                    backend_url_owned,
                    device_token,
                );
                match api.list_modes().await {
                    Ok(modes) => {
                        let _ = handle_clone.emit(
                            "copilot-modes-loaded",
                            serde_json::json!({ "modes": modes }),
                        );
                    }
                    Err(e) => {
                        log::warn!("[Copilot] list_modes failed: {}", e);
                        let _ = handle_clone.emit(
                            "copilot-modes-loaded",
                            serde_json::json!({ "modes": [], "error": e.to_string() }),
                        );
                    }
                }
            });
        }

        "save-copilot-mode" => {
            // Body: { mode_id?: string, name, description?, context_about_user?,
            //         context_about_call?, context_objections?, is_default? }
            // Mode_id present → update; absent → create.
            let device_token = match handle
                .state::<AppState>()
                .auth_token
                .lock()
                .unwrap()
                .clone()
            {
                Some(t) => t,
                None => return,
            };

            let mode_id = payload
                .get("mode_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let req = copilot::intelligence::api::UpsertModeRequest {
                name: payload
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                description: payload
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                context_about_user: payload
                    .get("context_about_user")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                context_about_call: payload
                    .get("context_about_call")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                context_objections: payload
                    .get("context_objections")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                is_default: payload.get("is_default").and_then(|v| v.as_bool()),
            };
            let backend_url_owned = backend_url.to_string();
            let handle_clone = handle.clone();
            tauri::async_runtime::spawn(async move {
                let api = copilot::intelligence::api::IntelligenceApi::new(
                    backend_url_owned,
                    device_token,
                );
                let result = match mode_id {
                    Some(id) => api.update_mode(&id, req).await,
                    None => api.create_mode(req).await,
                };
                match result {
                    Ok(mode) => {
                        let _ = handle_clone.emit(
                            "copilot-mode-saved",
                            serde_json::json!({ "mode": mode }),
                        );
                    }
                    Err(e) => {
                        log::warn!("[Copilot] save_mode failed: {}", e);
                        let _ = handle_clone.emit(
                            "copilot-mode-saved",
                            serde_json::json!({ "error": e.to_string() }),
                        );
                    }
                }
            });
        }

        "delete-copilot-mode" => {
            let mode_id = match payload.get("mode_id").and_then(|v| v.as_str()) {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => return,
            };
            let device_token = match handle
                .state::<AppState>()
                .auth_token
                .lock()
                .unwrap()
                .clone()
            {
                Some(t) => t,
                None => return,
            };
            let backend_url_owned = backend_url.to_string();
            let handle_clone = handle.clone();
            tauri::async_runtime::spawn(async move {
                let api = copilot::intelligence::api::IntelligenceApi::new(
                    backend_url_owned,
                    device_token,
                );
                match api.delete_mode(&mode_id).await {
                    Ok(_) => {
                        let _ = handle_clone.emit(
                            "copilot-mode-deleted",
                            serde_json::json!({ "mode_id": mode_id }),
                        );
                    }
                    Err(e) => log::warn!("[Copilot] delete_mode failed: {}", e),
                }
            });
        }

        "set-default-copilot-mode" => {
            let mode_id = match payload.get("mode_id").and_then(|v| v.as_str()) {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => return,
            };
            let device_token = match handle
                .state::<AppState>()
                .auth_token
                .lock()
                .unwrap()
                .clone()
            {
                Some(t) => t,
                None => return,
            };
            let backend_url_owned = backend_url.to_string();
            let handle_clone = handle.clone();
            tauri::async_runtime::spawn(async move {
                let api = copilot::intelligence::api::IntelligenceApi::new(
                    backend_url_owned,
                    device_token,
                );
                match api.set_default_mode(&mode_id).await {
                    Ok(mode) => {
                        let _ = handle_clone.emit(
                            "copilot-mode-saved",
                            serde_json::json!({ "mode": mode }),
                        );
                    }
                    Err(e) => log::warn!("[Copilot] set_default_mode failed: {}", e),
                }
            });
        }

        // ─────────────────────────────────────────
        // Sub-prompt 4.8 — finalize session: bulk push transcript +
        // chat_threads + auto_suggestions to backend, generate summary,
        // optionally auto-open browser. Frontend emits this from the
        // Stop button click handler with its reducer state attached.
        // ─────────────────────────────────────────
        "finalize-and-push-session" => {
            // Sub-prompt 5.0 — capture session_id AND started_at while
            // we hold the state lock so we can compute duration for the
            // post-session takeover card. started_at only lives on the
            // Listening variant; Reconnecting/EndingSession lose it but
            // those paths still finalize fine (duration falls back to
            // None and the card just shows "Recording complete").
            let (session_id, started_at_opt) = {
                let copilot_mutex = handle.state::<CopilotStateMutex>();
                let cur = copilot_mutex.0.lock().unwrap().clone();
                match cur {
                    CopilotState::Listening { session_id, started_at } => {
                        (session_id, Some(started_at))
                    }
                    CopilotState::Reconnecting { session_id, .. }
                    | CopilotState::EndingSession { session_id, .. } => {
                        (session_id, None)
                    }
                    other => {
                        log::debug!(
                            "[Copilot] finalize-and-push-session ignored — state: {}",
                            other
                        );
                        return;
                    }
                }
            };
            let duration_ms = started_at_opt.map(|t| t.elapsed().as_millis() as u64);

            let device_token = match handle
                .state::<AppState>()
                .auth_token
                .lock()
                .unwrap()
                .clone()
            {
                Some(t) => t,
                None => {
                    log::warn!(
                        "[Copilot] finalize-and-push-session ignored — not authed"
                    );
                    return;
                }
            };

            let active_mode = handle
                .state::<ActiveModeIdMutex>()
                .0
                .lock()
                .ok()
                .map(|g| g.clone())
                .unwrap_or_default();
            let mode_used_id = active_mode.id.clone();
            let mode_used_name = active_mode.name.clone();

            // Frontend supplies the transcript (its `fullTranscript`
            // state — last 200 utterances) since the Rust buffer is a
            // 90s sliding window that doesn't carry the full call.
            let transcript_full: Vec<serde_json::Value> = payload
                .get("transcript")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let chat_threads: Vec<serde_json::Value> = payload
                .get("chat_threads")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let auto_suggestions: Vec<serde_json::Value> = payload
                .get("auto_suggestions")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let req = copilot::intelligence::api::FinalizeSessionRequest {
                transcript: transcript_full,
                chat_threads,
                auto_suggestions,
                mode_used_id: mode_used_id.clone(),
            };

            let backend_url_owned = backend_url.to_string();
            let handle_clone = handle.clone();
            let session_id_for_log = session_id.clone();
            tauri::async_runtime::spawn(async move {
                let api = copilot::intelligence::api::IntelligenceApi::new(
                    backend_url_owned.clone(),
                    device_token.clone(),
                );
                match api.finalize_session(&session_id_for_log, req).await {
                    Ok(resp) => {
                        log::info!(
                            "[Copilot] session finalized — id={} share_slug={:?}",
                            &session_id_for_log[..8.min(session_id_for_log.len())],
                            resp.share_slug
                        );
                        // Emit so the frontend can show "View on web".
                        // Sub-prompt 5.0 — also include duration_ms +
                        // mode_used_name so the post-session takeover
                        // card has its subtext data immediately.
                        let _ = handle_clone.emit(
                            "copilot-session-finalized",
                            serde_json::json!({
                                "session_id": resp.session_id,
                                "share_slug": resp.share_slug,
                                "duration_ms": duration_ms,
                                "mode_used_name": mode_used_name,
                            }),
                        );

                        // Auto-open browser if user has the toggle on.
                        match api.get_user_preferences().await {
                            Ok(prefs) if prefs.copilot_auto_open_browser => {
                                // Construct the wolfee.io URL. Use the
                                // backend_url's host as the web origin
                                // — V1 assumes web app is served from
                                // the same domain.
                                let url = format!(
                                    "{}/copilot/sessions/{}",
                                    backend_url_owned.trim_end_matches('/'),
                                    resp.session_id
                                );
                                log::info!(
                                    "[Copilot] auto-open enabled — opening {}",
                                    url
                                );
                                open_url(&url);
                            }
                            _ => {}
                        }
                    }
                    Err(e) => {
                        // Sub-prompt 4.9 — surface failures instead of
                        // swallowing. Desktop overlay listens for this
                        // event + renders a toast so the user knows the
                        // recap won't appear at wolfee.io. Body excerpt
                        // is captured by api.rs::finalize_session and
                        // included in the Display impl of the error.
                        log::error!(
                            "[Copilot] finalize_session failed: {} — session={}",
                            e,
                            &session_id_for_log[..8.min(session_id_for_log.len())]
                        );
                        let _ = handle_clone.emit(
                            "copilot-session-failed",
                            serde_json::json!({
                                "session_id": session_id_for_log,
                                "reason": e.to_string(),
                            }),
                        );
                    }
                }
            });

            // Clear active mode id once the finalize is in flight.
            if let Ok(mut g) = handle.state::<ActiveModeIdMutex>().0.lock() {
                *g = ActiveMode::default();
            }
        }

        // ─────────────────────────────────────────
        // Sub-prompt 5.0 — welcome-flag persistence.
        // Frontend emits `request-welcome-flag` on boot; we read the
        // store and emit `welcome-flag-loaded` back. `mark-welcome-shown`
        // writes true. Failures emit shown=false (never block onboarding).
        // ─────────────────────────────────────────
        "request-welcome-flag" => {
            // Sub-prompt 5.2 — scope the flag key by paired user_id so
            // a different wolfee.io account on the same machine still
            // sees the welcome card. Falls back to `_unpaired` when
            // no auth token is present yet.
            let user_id = handle
                .state::<AppState>()
                .user_id
                .lock()
                .ok()
                .and_then(|g| g.clone());
            let key = welcome_key_for(user_id.as_deref());
            let shown = match handle.store(FLAGS_STORE_PATH) {
                Ok(store) => store
                    .get(&key)
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                Err(e) => {
                    log::warn!("[Copilot] welcome-flag store load failed: {}", e);
                    false
                }
            };
            log::info!(
                "[Copilot] welcome flag loaded (key={}, shown={})",
                key, shown
            );
            let _ = handle.emit(
                "welcome-flag-loaded",
                serde_json::json!({ "shown": shown }),
            );
        }

        "mark-welcome-shown" => {
            let user_id = handle
                .state::<AppState>()
                .user_id
                .lock()
                .ok()
                .and_then(|g| g.clone());
            let key = welcome_key_for(user_id.as_deref());
            match handle.store(FLAGS_STORE_PATH) {
                Ok(store) => {
                    store.set(key.clone(), serde_json::Value::Bool(true));
                    if let Err(e) = store.save() {
                        log::warn!(
                            "[Copilot] welcome-flag save failed: {}",
                            e
                        );
                    } else {
                        log::info!(
                            "[Copilot] welcome flag persisted ({}=true)",
                            key
                        );
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[Copilot] welcome-flag store open failed: {}",
                        e
                    );
                }
            }
        }

        // ─────────────────────────────────────────
        // Sub-prompt 6.0 — onboarding wizard handlers.
        //
        // request-onboarding-flag → emits onboarding-flag-loaded
        //   {completed: bool, last_step: u32}
        // mark-onboarding-completed → flips _completed key to true
        // mark-onboarding-step → writes _last_step (1..6) so quit-mid-tour
        //   resumes correctly. step out of bounds clamped to 1.
        // request-auth-status → emits auth-status-loaded
        //   {paired: bool, user_id: Option<String>}
        // request-permission-status → emits permission-status-loaded
        //   {mic: PermissionProbe::as_str, screen: same}. Silent — does
        //   NOT trigger TCC prompts. The wizard's Step 4 polls this
        //   every 5s while open.
        // show-onboarding → react-side flips wizard open. Tray menu
        //   "Show Onboarding Tour" emits this; CopilotOverlay has the
        //   listener in CopilotOverlay.tsx.
        // ─────────────────────────────────────────
        "request-onboarding-flag" => {
            let user_id = handle
                .state::<AppState>()
                .user_id
                .lock()
                .ok()
                .and_then(|g| g.clone());
            let (completed, last_step) = match handle.store(FLAGS_STORE_PATH) {
                Ok(store) => {
                    let c_key = onboarding_completed_key_for(user_id.as_deref());
                    let s_key = onboarding_last_step_key_for(user_id.as_deref());
                    let completed = store
                        .get(&c_key)
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let step = store
                        .get(&s_key)
                        .and_then(|v| v.as_u64())
                        .unwrap_or(1) as u32;
                    (completed, step.clamp(1, 6))
                }
                Err(e) => {
                    log::warn!("[Copilot] onboarding-flag store load failed: {}", e);
                    (false, 1)
                }
            };
            log::info!(
                "[Copilot] onboarding flag loaded (completed={}, last_step={})",
                completed, last_step
            );
            let _ = handle.emit(
                "onboarding-flag-loaded",
                serde_json::json!({ "completed": completed, "last_step": last_step }),
            );
        }

        "mark-onboarding-completed" => {
            let user_id = handle
                .state::<AppState>()
                .user_id
                .lock()
                .ok()
                .and_then(|g| g.clone());
            let key = onboarding_completed_key_for(user_id.as_deref());
            match handle.store(FLAGS_STORE_PATH) {
                Ok(store) => {
                    store.set(key.clone(), serde_json::Value::Bool(true));
                    if let Err(e) = store.save() {
                        log::warn!("[Copilot] onboarding-completed save failed: {}", e);
                    } else {
                        log::info!("[Copilot] onboarding completed persisted ({}=true)", key);
                    }
                }
                Err(e) => {
                    log::warn!("[Copilot] onboarding-completed store open failed: {}", e);
                }
            }
        }

        "mark-onboarding-step" => {
            let step = payload
                .get("step")
                .and_then(|v| v.as_u64())
                .unwrap_or(1)
                .clamp(1, 6);
            let user_id = handle
                .state::<AppState>()
                .user_id
                .lock()
                .ok()
                .and_then(|g| g.clone());
            let key = onboarding_last_step_key_for(user_id.as_deref());
            match handle.store(FLAGS_STORE_PATH) {
                Ok(store) => {
                    store.set(key.clone(), serde_json::Value::from(step));
                    let _ = store.save();
                }
                Err(e) => {
                    log::warn!("[Copilot] onboarding-step store open failed: {}", e);
                }
            }
        }

        "request-auth-status" => {
            let app_state = handle.state::<AppState>();
            let token_opt = app_state.auth_token.lock().unwrap().clone();
            let user_id = app_state.user_id.lock().unwrap().clone();
            let _ = handle.emit(
                "auth-status-loaded",
                serde_json::json!({
                    "paired": token_opt.is_some(),
                    "user_id": user_id,
                }),
            );
        }

        "request-permission-status" => {
            // Silent probes — no TCC prompts. Sub-prompt 6.0 wizard
            // Step 4 polls every 5s while open.
            let mic = copilot::audio::permissions::probe_microphone();
            let screen = copilot::audio::permissions::probe_screen_recording();
            let _ = handle.emit(
                "permission-status-loaded",
                serde_json::json!({
                    "mic": mic.as_str(),
                    "screen": screen.as_str(),
                }),
            );
        }

        "show-onboarding" => {
            // Tray "Show Onboarding Tour" → emit a notification event the
            // overlay listens for. The overlay then dispatches SHOW_ONBOARDING
            // and emits expand-overlay so the wizard becomes visible.
            log::info!("[Copilot] tray: show-onboarding");
            let _ = handle.emit("copilot-show-onboarding", serde_json::json!({}));
        }

        // ─────────────────────────────────────────
        // Sub-prompt 4.7 — open an external URL (fact-check sources).
        // ─────────────────────────────────────────
        "open-external-url" => {
            let url = match payload.get("url").and_then(|v| v.as_str()) {
                Some(u) if !u.is_empty() => u,
                _ => {
                    log::warn!("[Copilot] open-external-url: missing/empty url");
                    return;
                }
            };
            // Only allow http(s) — defense in depth against javascript: /
            // file: URLs sneaking in from a malformed annotation.
            if !url.starts_with("http://") && !url.starts_with("https://") {
                log::warn!("[Copilot] open-external-url: rejected non-http URL: {}", url);
                return;
            }
            log::info!("[Copilot] Opening external URL: {}", url);
            open_url(url);
        }

        other => {
            log::warn!("[App] Unknown structured action: {}", other);
        }
    }
}

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    // rustls 0.23 requires an explicit CryptoProvider before any TLS
    // connection. tokio-tungstenite and reqwest both pull rustls in
    // transitively but never call `install_default()`, so the first
    // TLS handshake (Deepgram WS upgrade) panics on a tokio worker
    // thread and silently kills connect_async. install_default()
    // returns Err if a provider is already installed — fine, ignore it.
    let _ = rustls::crypto::ring::default_provider().install_default();

    const VERSION: &str = env!("CARGO_PKG_VERSION");
    const BUILD_TS: &str = env!("BUILD_TIMESTAMP");

    let auth_config = AuthConfig::load();
    let exe_path = std::env::current_exe().unwrap_or_default();

    log::info!("══════════════════════════════════════════");
    log::info!("  WOLFEE DESKTOP (Tauri) BOOT");
    log::info!("══════════════════════════════════════════");
    log::info!("  version:     {} (built {})", VERSION, BUILD_TS);
    log::info!("  binary:      {}", exe_path.display());
    log::info!("  backend:     {}", auth_config.backend_url);
    log::info!("  deviceId:    {}", auth_config.device_id);
    log::info!("  authed:      {}", auth_config.is_authenticated());
    log::info!("  config:      {}", AuthConfig::config_path().display());
    log::info!("══════════════════════════════════════════");

    // Warn if duplicate installs exist
    let check_paths = [
        "/Applications/Wolfee Desktop.app",
        &format!("{}/Applications/Wolfee Desktop.app", dirs::home_dir().unwrap_or_default().display()),
    ];
    let existing: Vec<&str> = check_paths.iter().filter(|p| std::path::Path::new(p).exists()).copied().collect();
    if existing.len() > 1 {
        log::warn!("══════════════════════════════════════════");
        log::warn!("  WARNING: Multiple Wolfee installs found!");
        for p in &existing {
            log::warn!("    → {}", p);
        }
        log::warn!("  Remove duplicates to avoid running stale versions.");
        log::warn!("══════════════════════════════════════════");
    }

    let app_state = AppState {
        recording_state: Mutex::new(RecordingState::Idle),
        auth_token: Mutex::new(auth_config.auth_token.clone()),
        user_id: Mutex::new(auth_config.user_id.clone()),
        device_id: Mutex::new(auth_config.device_id.clone()),
        current_recording_path: Mutex::new(None),
        recording_start_time: Mutex::new(None),
        linking_status: Mutex::new(LinkingStatus::Idle),
        upload_status: Mutex::new(UploadStatus::Idle),
    };

    let backend_url = auth_config.backend_url.clone();
    let recorder = Arc::new(tokio::sync::Mutex::new(Recorder::new()));
    let last_meeting_url: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        // Sub-prompt 6.1 — auto-update. The plugin reads endpoints +
        // pubkey from tauri.conf.json's `plugins.updater` section.
        // Frontend calls @tauri-apps/plugin-updater check() +
        // downloadAndInstall() on launch (silent, fire-and-forget).
        // Signature verification happens against the embedded pubkey;
        // a tampered .app.tar.gz fails verification and never installs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_state)
        .manage(CopilotStateMutex::default())
        .manage(CopilotAudioCaptureMutex::default())
        .manage(TranscriptBufferMutex::default())
        // Sub-prompt 3 (Intelligence) state.
        .manage(RollingSummaryMutex::default())
        .manage(MomentCooldownMutex::default())
        .manage(ActiveSuggestionMutex::default())
        // Storage for the live IntelligenceWorkers handles. tokio::Mutex
        // because we hold the guard across `await` (workers.stop() is async).
        .manage(IntelligenceWorkersMutex(tokio::sync::Mutex::new(None)))
        .manage(ActiveModeIdMutex::default())
        .on_window_event(|window, _event| {
            // 2026-05-04: removed the WindowEvent::Focused(false) →
            // hide_overlay handler. With the new "overlay stays
            // visible" model, focus loss should NOT auto-hide.
            // Surfaced by PO as "blacked out" — overlay flickered
            // gone the instant Chrome reclaimed focus after a
            // suggestion appeared.
            //
            // The handler is kept (rather than dropping the whole
            // .on_window_event block) so future listeners can hang
            // off it without re-introducing the wiring.
            let _ = window.label();
        })
        .setup(move |app| {
            let handle = app.handle().clone();

            // Sub-prompt 4 fix 2026-05-04 — set activation policy to
            // Accessory so the overlay floats above fullscreen apps
            // on macOS Sequoia. Three previous attempts (visible_on_
            // all_workspaces, NSScreenSaverWindowLevel,
            // FullScreenAuxiliary collection-behavior bit) didn't fix
            // the issue alone; macOS Sequoia changed the rules so an
            // app must ALSO be in Accessory activation policy
            // (LSUIElement-equivalent) for fullscreen overlay to work.
            // Same recipe Raycast / 1Password / Spotlight use.
            //
            // Tradeoffs (acceptable per design Decision N7 — Wolfee
            // Desktop is tray-driven):
            //   - No dock icon (fine — already tray-icon-only model)
            //   - Not visible in Cmd-Tab (fine — tray menu is the entry)
            //   - Tray icon stays exactly the same
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                log::info!("[Copilot] activation policy set to Accessory");
            }

            // Create tray icon
            let tray = tray::create_tray(&handle)?;
            let is_authed = auth_config.is_authenticated();
            tray::update_tray_menu(&tray, &handle, RecordingState::Idle, is_authed);

            // Initialize Copilot foundation (overlay window + hotkey).
            // No audio / no LLM yet — Sub-prompts 2 / 3.
            if let Err(e) = copilot::init(&handle) {
                log::error!("[Copilot] Failed to initialize: {}", e);
            }

            let tray = Arc::new(tray);

            let recorder_clone = recorder.clone();
            let tray_clone = tray.clone();
            let last_meeting_url_clone = last_meeting_url.clone();
            let backend_url_clone = backend_url.clone();

            handle.listen("wolfee-action", move |event| {
                let raw_payload = event.payload();

                // Sub-prompt 4.5: structured (JSON object) payloads carry
                // typed args (e.g. `{type: "submit-copilot-context",
                // about_user: "..."}`). Plain string payloads (e.g.
                // `"start-recording"`) keep the legacy match below.
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw_payload) {
                    if let Some(obj) = parsed.as_object() {
                        if let Some(action_type) = obj.get("type").and_then(|v| v.as_str()) {
                            handle_structured_action(
                                action_type,
                                &parsed,
                                &tray_clone,
                                &backend_url_clone,
                            );
                            return;
                        }
                    }
                }

                let action = raw_payload.trim_matches('"');

                let handle_ref = tray_clone.app_handle();
                let state: tauri::State<'_, AppState> = handle_ref.state();

                match action {
                    // ─────────────────────────────────────────
                    // START RECORDING
                    // ─────────────────────────────────────────
                    "start-recording" => {
                        log::info!("[TRAY] Start Recording clicked");

                        if state.current_state() != RecordingState::Idle {
                            log::info!("[App] Ignoring start — state is {}", state.current_state());
                            return;
                        }

                        let token = state.auth_token.lock().unwrap().clone();
                        if token.is_none() {
                            log::warn!("[AUTH] Not authenticated — recording will save locally but NOT upload");
                        }

                        if let Err(e) = state.transition_to(RecordingState::Recording) {
                            log::error!("[App] {}", e);
                            return;
                        }

                        let is_authed = token.is_some();
                        tray::update_tray_menu(&tray_clone, handle_ref, RecordingState::Recording, is_authed);

                        let recorder = recorder_clone.clone();
                        let tray = tray_clone.clone();
                        let handle = handle_ref.clone();
                        spawn_async("recorder-start", move || async move {
                            let mut rec = recorder.lock().await;
                            match rec.start().await {
                                Ok(path) => {
                                    let state: tauri::State<'_, AppState> = handle.state();
                                    *state.current_recording_path.lock().unwrap() = Some(path.to_string_lossy().to_string());
                                    *state.recording_start_time.lock().unwrap() = Some(std::time::Instant::now());
                                    log::info!("[RECORDER] Started — output: {}", path.display());
                                }
                                Err(e) => {
                                    log::error!("[RECORDER] Failed to start: {}", e);
                                    let state: tauri::State<'_, AppState> = handle.state();
                                    state.reset();
                                    tray::update_tray_menu(&tray, &handle, RecordingState::Idle, is_authed);
                                }
                            }
                        });
                    }

                    // ─────────────────────────────────────────
                    // STOP RECORDING → UPLOAD
                    // ─────────────────────────────────────────
                    "stop-recording" => {
                        log::info!("[TRAY] Stop Recording clicked");

                        if state.current_state() != RecordingState::Recording {
                            log::info!("[App] Ignoring stop — state is {}", state.current_state());
                            return;
                        }

                        let _ = state.transition_to(RecordingState::Stopping);
                        let token = state.auth_token.lock().unwrap().clone();
                        let is_authed = token.is_some();
                        tray::update_tray_menu(&tray_clone, handle_ref, RecordingState::Stopping, is_authed);

                        let recorder = recorder_clone.clone();
                        let tray = tray_clone.clone();
                        let handle = handle_ref.clone();
                        let backend_url = backend_url_clone.clone();
                        let last_url = last_meeting_url_clone.clone();
                        spawn_async("recorder-stop", move || async move {
                            let mut rec = recorder.lock().await;

                            match rec.stop().await {
                                Ok(result) => {
                                    log::info!("[RECORDER] Stopped — duration={:.1}s, file={}", result.duration, result.file_path.display());

                                    if let Some(ref auth_token) = token {
                                        // Transition to uploading
                                        {
                                            let state: tauri::State<'_, AppState> = handle.state();
                                            let _ = state.transition_to(RecordingState::Uploading);
                                        }
                                        tray::update_tray_menu(&tray, &handle, RecordingState::Uploading, true);

                                        let now = chrono::Utc::now();
                                        let start_time = now - chrono::Duration::seconds(result.duration as i64);
                                        let metadata = uploader::UploadMetadata {
                                            source: "desktop_recorder".to_string(),
                                            detected_platform: "desktop".to_string(),
                                            start_time: start_time.to_rfc3339(),
                                            end_time: now.to_rfc3339(),
                                            duration: result.duration,
                                        };

                                        {
                                            let state: tauri::State<'_, AppState> = handle.state();
                                            state.set_upload_status(UploadStatus::InProgress);
                                        }
                                        tray::update_tray_menu(&tray, &handle, RecordingState::Uploading, true);
                                        log::info!("[UPLOAD] Begin — POST {}/api/meetings/import/desktop", backend_url);
                                        match uploader::upload_recording(
                                            &result.file_path,
                                            &metadata,
                                            &backend_url,
                                            auth_token,
                                        ).await {
                                            Ok(upload_result) => {
                                                log::info!("[UPLOAD] Success: meetingId={:?}", upload_result.meeting_id);
                                                if let Some(ref url) = upload_result.meeting_url {
                                                    log::info!("[UPLOAD] URL: {}", url);
                                                    *last_url.lock().unwrap() = Some(url.clone());
                                                }
                                                let _ = std::fs::remove_file(&result.file_path);

                                                {
                                                    let state: tauri::State<'_, AppState> = handle.state();
                                                    let _ = state.transition_to(RecordingState::Complete);
                                                    state.set_upload_status(UploadStatus::JustUploaded);
                                                }
                                                tray::update_tray_menu(&tray, &handle, RecordingState::Complete, true);

                                                // Auto-return to idle after 10s, also clearing the upload status row.
                                                let tray2 = tray.clone();
                                                let handle2 = handle.clone();
                                                std::thread::spawn(move || {
                                                    std::thread::sleep(std::time::Duration::from_secs(10));
                                                    let state: tauri::State<'_, AppState> = handle2.state();
                                                    if state.current_state() == RecordingState::Complete {
                                                        let _ = state.transition_to(RecordingState::Idle);
                                                        state.set_upload_status(UploadStatus::Idle);
                                                        tray::update_tray_menu(&tray2, &handle2, RecordingState::Idle, true);
                                                    }
                                                });
                                            }
                                            Err(e) => {
                                                log::warn!("[UPLOAD] Error: {}", e);
                                                log::warn!("[UPLOAD] File kept at: {}", result.file_path.display());
                                                let state: tauri::State<'_, AppState> = handle.state();
                                                let _ = state.transition_to(RecordingState::Idle);
                                                state.set_upload_status(UploadStatus::Failed);
                                                tray::update_tray_menu(&tray, &handle, RecordingState::Idle, true);
                                                // Failed upload is sticky — user dismisses via the tray.
                                            }
                                        }
                                    } else {
                                        log::warn!("[AUTH] No auth token — skip upload.");
                                        log::warn!("[AUTH] File saved at: {}", result.file_path.display());
                                        let state: tauri::State<'_, AppState> = handle.state();
                                        let _ = state.transition_to(RecordingState::Idle);
                                        state.set_upload_status(UploadStatus::SkippedNoAuth);
                                        tray::update_tray_menu(&tray, &handle, RecordingState::Idle, false);
                                        // Sticky — user clicks "Link with Wolfee…" to clear via the link flow.
                                    }
                                }
                                Err(e) => {
                                    log::error!("[RECORDER] Stop failed: {}", e);
                                    let state: tauri::State<'_, AppState> = handle.state();
                                    state.reset();
                                    tray::update_tray_menu(&tray, &handle, RecordingState::Idle, is_authed);
                                }
                            }
                        });
                    }

                    // ─────────────────────────────────────────
                    // LINK ACCOUNT (browser + poll)
                    // ─────────────────────────────────────────
                    "link-account" => {
                        let device_id = state.device_id.lock().unwrap().clone();
                        let backend_url = backend_url_clone.clone();
                        let device_name = hostname::get()
                            .map(|h| h.to_string_lossy().to_string())
                            .unwrap_or_else(|_| "Desktop".to_string());
                        let encoded_name = urlencoding::encode(&device_name);
                        let url = format!(
                            "{}/desktop/link?deviceId={}&deviceName={}",
                            backend_url, device_id, encoded_name
                        );
                        log::info!("[LINK] Opening pairing URL: {}", url);
                        open_url(&url);

                        // UX: surface "🔄 Linking…" in the tray so the user knows polling is live.
                        // Also clears any prior SkippedNoAuth upload-status row.
                        state.set_linking_status(LinkingStatus::InProgress);
                        if *state.upload_status.lock().unwrap() == UploadStatus::SkippedNoAuth {
                            state.set_upload_status(UploadStatus::Idle);
                        }
                        tray::update_tray_menu(
                            &tray_clone,
                            handle_ref,
                            state.current_state(),
                            state.auth_token.lock().unwrap().is_some(),
                        );

                        // Now poll the backend until the web app confirms the link
                        let tray = tray_clone.clone();
                        let handle = handle_ref.clone();
                        let device_id_poll = device_id.clone();
                        let backend_url_poll = backend_url.clone();
                        spawn_async("link-poll", move || async move {
                            log::info!("[AUTH] Polling for link confirmation (device={})...", device_id_poll);

                            match auth::poll_link_status(&backend_url_poll, &device_id_poll).await {
                                Ok((token, user_id)) => {
                                    log::info!("[AUTH] Link success! Saving credentials.");

                                    // Save to auth.json
                                    let config = AuthConfig {
                                        auth_token: Some(token.clone()),
                                        user_id: user_id.clone(),
                                        device_id: device_id_poll,
                                        backend_url: backend_url_poll,
                                    };
                                    config.save();

                                    // Update app state
                                    let state: tauri::State<'_, AppState> = handle.state();
                                    *state.auth_token.lock().unwrap() = Some(token);
                                    *state.user_id.lock().unwrap() = user_id;
                                    state.set_linking_status(LinkingStatus::JustLinked);

                                    // Refresh tray to remove "Link with Wolfee..." and show ready state
                                    tray::update_tray_menu(&tray, &handle, RecordingState::Idle, true);
                                    log::info!("[AUTH] Tray updated — ready to record + upload");

                                    // Auto-clear the "✅ Linked!" status row after 5s.
                                    let tray2 = tray.clone();
                                    let handle2 = handle.clone();
                                    std::thread::spawn(move || {
                                        std::thread::sleep(std::time::Duration::from_secs(5));
                                        let state: tauri::State<'_, AppState> = handle2.state();
                                        if *state.linking_status.lock().unwrap() == LinkingStatus::JustLinked {
                                            state.set_linking_status(LinkingStatus::Idle);
                                            tray::update_tray_menu(
                                                &tray2,
                                                &handle2,
                                                state.current_state(),
                                                true,
                                            );
                                        }
                                    });
                                }
                                Err(e) => {
                                    log::warn!("[AUTH] Link failed: {}", e);
                                    log::warn!("[AUTH] Surface in tray as failed — click to retry");
                                    let state: tauri::State<'_, AppState> = handle.state();
                                    state.set_linking_status(LinkingStatus::Failed);
                                    tray::update_tray_menu(
                                        &tray,
                                        &handle,
                                        state.current_state(),
                                        state.auth_token.lock().unwrap().is_some(),
                                    );
                                    // Sticky — user clicks the failed row to retry, which re-emits link-account.
                                }
                            }
                        });
                    }

                    // ─────────────────────────────────────────
                    // CLEAR transient status rows (tray dismiss)
                    // ─────────────────────────────────────────
                    "clear-linking-status" => {
                        let s: tauri::State<'_, AppState> = handle_ref.state();
                        s.set_linking_status(LinkingStatus::Idle);
                        tray::update_tray_menu(
                            &tray_clone,
                            handle_ref,
                            s.current_state(),
                            s.auth_token.lock().unwrap().is_some(),
                        );
                    }
                    "clear-upload-status" => {
                        let s: tauri::State<'_, AppState> = handle_ref.state();
                        s.set_upload_status(UploadStatus::Idle);
                        tray::update_tray_menu(
                            &tray_clone,
                            handle_ref,
                            s.current_state(),
                            s.auth_token.lock().unwrap().is_some(),
                        );
                    }

                    // ─────────────────────────────────────────
                    // NAVIGATION
                    // ─────────────────────────────────────────
                    "open-wolfee" => {
                        open_url(&backend_url_clone);
                    }

                    "open-meeting" => {
                        let url = last_meeting_url_clone.lock().unwrap().clone()
                            .unwrap_or_else(|| backend_url_clone.clone());
                        open_url(&url);
                    }

                    // ─────────────────────────────────────────
                    // COPILOT (Sub-prompt 1 — Foundation)
                    // ─────────────────────────────────────────
                    "open-copilot-overlay" => {
                        log::info!("[Copilot] Tray: open overlay");
                        if let Err(e) = copilot::window::show_overlay(handle_ref) {
                            log::error!("[Copilot] show_overlay failed: {}", e);
                        } else {
                            let copilot_mutex = handle_ref.state::<CopilotStateMutex>();
                            *copilot_mutex.0.lock().unwrap() = CopilotState::ShowingOverlay;
                            tray::update_tray_menu(
                                &tray_clone,
                                handle_ref,
                                state.current_state(),
                                state.auth_token.lock().unwrap().is_some(),
                            );
                        }
                    }

                    "toggle-copilot-pause" => {
                        let copilot_mutex = handle_ref.state::<CopilotStateMutex>();
                        let mut s = copilot_mutex.0.lock().unwrap();
                        *s = match *s {
                            CopilotState::Paused => CopilotState::Idle,
                            _ => CopilotState::Paused,
                        };
                        log::info!("[Copilot] State -> {}", *s);
                        drop(s);
                        tray::update_tray_menu(
                            &tray_clone,
                            handle_ref,
                            state.current_state(),
                            state.auth_token.lock().unwrap().is_some(),
                        );
                    }

                    // Phase 6 — overlay modal "Open System Settings" buttons.
                    // The frontend can't open `x-apple.systempreferences:` URLs
                    // directly without the @tauri-apps/plugin-opener JS package
                    // (we have only the Rust side). Routing through
                    // wolfee-action keeps the dep surface unchanged and reuses
                    // the existing macOS `open` shell invocation.
                    "open-system-settings-microphone" => {
                        open_url(
                            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
                        );
                    }
                    "open-system-settings-screen-recording" => {
                        open_url(
                            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                        );
                    }

                    // Sub-prompt 3 — ⌘⌥G hotkey OR tray "Generate
                    // Suggestion" menu item. Fires the suggest_client
                    // with trigger_source=hotkey, bypassing the moment
                    // detector entirely.
                    "trigger-copilot-suggestion" => {
                        // Read CopilotState — only fire during Listening
                        // (or Reconnecting; rolling summary still useful).
                        let copilot_mutex = handle_ref.state::<CopilotStateMutex>();
                        let cur = copilot_mutex.0.lock().unwrap().clone();
                        let session_id = match cur {
                            CopilotState::Listening { session_id, .. }
                            | CopilotState::Reconnecting { session_id, .. } => session_id,
                            other => {
                                log::debug!(
                                    "[Copilot] hotkey ⌘⌥G ignored — state: {}",
                                    other
                                );
                                return;
                            }
                        };

                        let device_token = match state.auth_token.lock().unwrap().clone() {
                            Some(t) => t,
                            None => {
                                log::warn!(
                                    "[Copilot] hotkey ⌘⌥G ignored — not authed"
                                );
                                return;
                            }
                        };

                        // Snapshot transcript window + rolling summary.
                        // Drop locks before await per Phase 6 lesson.
                        let window_text = {
                            let buf = handle_ref.state::<TranscriptBufferMutex>();
                            let g = match buf.0.lock() {
                                Ok(g) => g,
                                Err(_) => return,
                            };
                            let utts = g.last_n_seconds(90);
                            if utts.is_empty() {
                                log::info!(
                                    "[Copilot] hotkey ⌘⌥G — empty transcript window, no-op"
                                );
                                return;
                            }
                            copilot::intelligence::format_transcript_window(&utts)
                        };
                        let rolling_summary = match handle_ref
                            .state::<RollingSummaryMutex>()
                            .0
                            .lock()
                        {
                            Ok(g) => g.as_ref().map(|x| x.text.clone()),
                            Err(_) => None,
                        };

                        let backend_url = backend_url_clone.clone();
                        let api = std::sync::Arc::new(
                            copilot::intelligence::api::IntelligenceApi::new(
                                backend_url,
                                device_token,
                            ),
                        );
                        // Sub-prompt 4 N3 — fire-and-forget pending event so
                        // the overlay can show the Reasoning indicator
                        // instantly, before the LLM round-trip begins.
                        // Eliminates 200-800ms dead air on hotkey path.
                        let _ = handle_ref.emit(
                            "copilot-suggestion-pending",
                            serde_json::json!({"trigger_source": "hotkey"}),
                        );
                        copilot::intelligence::suggest_client::spawn_for_hotkey(
                            handle_ref.clone(),
                            session_id,
                            api,
                            window_text,
                            rolling_summary,
                        );
                    }

                    // Sub-prompt 4 will emit this when the user dismisses
                    // a suggestion via Esc / click-outside / click-suggestion.
                    // Releases the ActiveSuggestionMutex so the next
                    // moment detector / hotkey trigger can fire.
                    "copilot-suggestion-dismissed" => {
                        if let Ok(mut g) =
                            handle_ref.state::<ActiveSuggestionMutex>().0.lock()
                        {
                            *g = None;
                        }
                    }

                    // Internal action emitted by Phase 3's DeepgramClient
                    // when CopilotState transitions inside the WS task
                    // (Listening ⇄ Reconnecting). Tray rendering reads
                    // CopilotState from app state, so the repaint just
                    // needs to call update_tray_menu — no payload needed.
                    "refresh-copilot-tray" => {
                        tray::update_tray_menu(
                            &tray_clone,
                            handle_ref,
                            state.current_state(),
                            state.auth_token.lock().unwrap().is_some(),
                        );
                    }

                    "open-copilot-settings" => {
                        // Sub-prompt 1 placeholder. Full Settings window in Sub-prompt 6.
                        log::info!(
                            "[Copilot] Set Up Copilot clicked — Settings UI lands in Sub-prompt 6"
                        );
                    }

                    // ─────────────────────────────────────────
                    // COPILOT (Sub-prompt 2 Phase 5 — Listening lifecycle)
                    //
                    // Sub-prompt 4.5 retune: the tray click no longer
                    // immediately mints a session. Instead it opens the
                    // context paste window. The user's submit fires a
                    // wolfee-action with type=submit-copilot-context which
                    // dispatches to the JSON branch above.
                    // ─────────────────────────────────────────
                    "start-copilot-session" => {
                        log::info!("[Copilot] Tray: Start Copilot Session — opening context window");

                        let copilot_mutex = handle_ref.state::<CopilotStateMutex>();
                        {
                            let cur = copilot_mutex.0.lock().unwrap();
                            if !matches!(*cur, CopilotState::Idle | CopilotState::ShowingOverlay) {
                                log::info!(
                                    "[Copilot] Ignoring start-session — current state: {}",
                                    *cur
                                );
                                return;
                            }
                        }

                        if state.auth_token.lock().unwrap().is_none() {
                            log::warn!(
                                "[Copilot] Cannot start session — not paired. \
                                 Click 'Link with Wolfee...' first."
                            );
                            return;
                        }

                        if state.current_state() == RecordingState::Recording {
                            log::warn!(
                                "[Copilot] Notes recorder is also running — Copilot will \
                                 listen alongside. Stop recorder if you want to free resources."
                            );
                        }

                        if let Err(e) = copilot::context_window::open_context_window(handle_ref) {
                            log::error!("[Copilot] open_context_window failed: {}", e);
                        }
                    }

                    // Sub-prompt 4.5 — user closed the context window without
                    // submitting. Just destroy the window; CopilotState stays
                    // Idle, no session was created.
                    "cancel-copilot-context" => {
                        log::info!("[Copilot] Context cancelled — closing window");
                        copilot::context_window::close_context_window(handle_ref);
                    }

                    // ─────────────────────────────────────────
                    // Sub-prompt 4.6 (Cluely 1:1) — strip / panel
                    // ─────────────────────────────────────────
                    "expand-overlay" => {
                        // Sub-prompt 5.2 hotfix — always show the window
                        // before resizing. The Sub-prompt 5.0 boot welcome
                        // flow emits expand-overlay while the window is
                        // still hidden; macOS Sequoia + Tauri 2 transparent
                        // + content-protected leaves WKWebView's surface
                        // detached when set_size runs before first
                        // orderFront:, so the window never visually
                        // renders even after a later show_overlay(). Show
                        // first → resize on a visible window. Idempotent
                        // for the 6 callers that already had a visible
                        // window (suggestion arrival, focus-input,
                        // new-thread, finalize takeover, permission needed,
                        // quick-action click).
                        if let Err(e) = copilot::window::show_overlay(handle_ref) {
                            log::warn!("[Copilot] expand-overlay show_overlay failed: {}", e);
                        }
                        if let Err(e) = copilot::window::expand_overlay(handle_ref) {
                            log::warn!("[Copilot] expand_overlay failed: {}", e);
                            return;
                        }
                        let _ = handle_ref.emit(
                            "copilot-panel-state",
                            serde_json::json!({ "mode": "expanded" }),
                        );
                    }

                    "collapse-overlay" => {
                        if let Err(e) = copilot::window::collapse_overlay(handle_ref) {
                            log::warn!("[Copilot] collapse_overlay failed: {}", e);
                            return;
                        }
                        let _ = handle_ref.emit(
                            "copilot-panel-state",
                            serde_json::json!({ "mode": "strip" }),
                        );
                    }

                    "toggle-copilot-pause" => {
                        // Sub-prompt 4.6 — pause/resume audio capture without
                        // ending the session. V1: just toggle a flag and emit
                        // state for the strip to render. Actual mic-mute /
                        // audio-pause plumbing lands in Sub-prompt 6 alongside
                        // the settings panel.
                        log::info!("[Copilot] Pause toggle clicked (Sub-prompt 6 wires audio pause)");
                        let _ = handle_ref.emit(
                            "copilot-pause-state",
                            serde_json::json!({ "paused": false }),
                        );
                    }

                    "end-copilot-session" => {
                        log::info!("[Copilot] Tray: End Copilot Session clicked");

                        // Capture the active session_id while we still have the lock.
                        let session_id_opt = {
                            let copilot_mutex = handle_ref.state::<CopilotStateMutex>();
                            let cur = copilot_mutex.0.lock().unwrap().clone();
                            match cur {
                                CopilotState::Listening { session_id, .. }
                                | CopilotState::Reconnecting { session_id, .. }
                                | CopilotState::StartingSession { session_id }
                                | CopilotState::EndingSession { session_id, .. } => {
                                    Some(session_id)
                                }
                                _ => None,
                            }
                        };

                        let session_id = match session_id_opt {
                            Some(id) => id,
                            None => {
                                log::info!(
                                    "[Copilot] Ignoring end-session — no active session"
                                );
                                return;
                            }
                        };

                        // Transition to Ending + refresh tray.
                        {
                            let copilot_mutex = handle_ref.state::<CopilotStateMutex>();
                            *copilot_mutex.0.lock().unwrap() = CopilotState::EndingSession {
                                session_id: session_id.clone(),
                                reason: copilot::state::SessionEndReason::UserRequested,
                            };
                        }
                        tray::update_tray_menu(
                            &tray_clone,
                            handle_ref,
                            state.current_state(),
                            state.auth_token.lock().unwrap().is_some(),
                        );

                        let tray = tray_clone.clone();
                        let handle = handle_ref.clone();
                        let device_token = state.auth_token.lock().unwrap().clone();
                        let backend_url = backend_url_clone.clone();

                        // Same Tauri-global-runtime hosting as copilot-start
                        // (see comment there). End-session also awaits
                        // capture.stop() which drops the mux pump task —
                        // running on the same long-lived runtime keeps
                        // everything tidy and symmetrical with start.
                        tauri::async_runtime::spawn(async move {
                            // 1a. Stop intelligence workers FIRST so they
                            //     don't keep firing LLM calls during teardown.
                            //     `IntelligenceWorkers::stop()` signals via
                            //     watch::Sender + awaits both join handles
                            //     with a 5s soft timeout.
                            let workers_mutex = handle.state::<IntelligenceWorkersMutex>();
                            let workers_opt = workers_mutex.0.lock().await.take();
                            drop(workers_mutex);
                            if let Some(workers) = workers_opt {
                                workers.stop().await;
                                log::info!("[Copilot] intelligence workers stopped");
                            }
                            // Clear intelligence mutexes so a subsequent
                            // session starts clean.
                            if let Ok(mut g) = handle.state::<RollingSummaryMutex>().0.lock() {
                                *g = None;
                            }
                            if let Ok(mut g) = handle.state::<MomentCooldownMutex>().0.lock() {
                                g.last_fired.clear();
                                g.last_llm_verify = None;
                                g.session_id.clear();
                            }
                            if let Ok(mut g) = handle.state::<ActiveSuggestionMutex>().0.lock() {
                                *g = None;
                            }

                            // 1. Stop audio capture (drops mic + sys + pump).
                            //    Bind State outside the await so its borrow of
                            //    `handle` lives across the suspend point.
                            let cap_mutex = handle.state::<CopilotAudioCaptureMutex>();
                            let capture_opt = cap_mutex.0.lock().await.take();
                            drop(cap_mutex);
                            if let Some(capture) = capture_opt {
                                if let Err(e) = capture.stop().await {
                                    log::warn!(
                                        "[Copilot] capture.stop() error (non-fatal): {}",
                                        e
                                    );
                                } else {
                                    log::info!("[Copilot] audio capture stopped cleanly");
                                }
                            } else {
                                log::warn!(
                                    "[Copilot] No capture handle in managed state — \
                                     possibly already torn down"
                                );
                            }

                            // 2. Notify backend (non-fatal — local end already happened).
                            if let Some(token) = device_token {
                                let api = SessionApi::new(backend_url, token);
                                match api
                                    .end_session(&session_id, EndReason::UserRequested)
                                    .await
                                {
                                    Ok(resp) => {
                                        log::info!(
                                            "[Copilot] backend end OK — duration={}s, \
                                             alreadyEnded={}",
                                            resp.duration_seconds,
                                            resp.already_ended
                                        );
                                    }
                                    Err(e) => {
                                        log::warn!(
                                            "[Copilot] backend end failed: {} — \
                                             session ended locally regardless",
                                            e
                                        );
                                    }
                                }
                            }

                            // 3. Return state to Idle + refresh tray.
                            {
                                let copilot_mutex = handle.state::<CopilotStateMutex>();
                                *copilot_mutex.0.lock().unwrap() = CopilotState::Idle;
                            }
                            let app_state: tauri::State<'_, AppState> = handle.state();
                            tray::update_tray_menu(
                                &tray,
                                &handle,
                                app_state.current_state(),
                                app_state.auth_token.lock().unwrap().is_some(),
                            );
                            log::info!("[Copilot] session ended — back to Idle");
                        });
                    }

                    _ => {
                        log::warn!("[App] Unknown action: {}", action);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Wolfee Desktop");
}
