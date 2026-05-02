mod auth;
mod copilot;
mod recorder;
mod state;
mod tray;
mod uploader;

use auth::AuthConfig;
use copilot::state::{CopilotState, CopilotStateMutex};
use recorder::Recorder;
use state::{AppState, RecordingState};
use std::sync::{Arc, Mutex};
use tauri::{Listener, Manager, WindowEvent};

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

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

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
        .manage(app_state)
        .manage(CopilotStateMutex::default())
        .on_window_event(|window, event| {
            // Keep Rust state in sync when the overlay window hides via Esc / blur.
            if window.label() == copilot::window::OVERLAY_LABEL {
                if let WindowEvent::Focused(false) = event {
                    let app = window.app_handle();
                    // Hide the overlay on focus loss — matches the frontend's blur listener;
                    // either path is fine (idempotent).
                    let _ = copilot::window::hide_overlay(app);
                    copilot::hotkey::on_overlay_hidden(app);
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();

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
                let action = event.payload();
                let action = action.trim_matches('"');

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
                                                }
                                                tray::update_tray_menu(&tray, &handle, RecordingState::Complete, true);

                                                // Auto-return to idle after 5s
                                                let tray2 = tray.clone();
                                                let handle2 = handle.clone();
                                                std::thread::spawn(move || {
                                                    std::thread::sleep(std::time::Duration::from_secs(5));
                                                    let state: tauri::State<'_, AppState> = handle2.state();
                                                    if state.current_state() == RecordingState::Complete {
                                                        let _ = state.transition_to(RecordingState::Idle);
                                                        tray::update_tray_menu(&tray2, &handle2, RecordingState::Idle, true);
                                                    }
                                                });
                                            }
                                            Err(e) => {
                                                log::error!("[UPLOAD] Error: {}", e);
                                                log::error!("[UPLOAD] File kept at: {}", result.file_path.display());
                                                let state: tauri::State<'_, AppState> = handle.state();
                                                let _ = state.transition_to(RecordingState::Idle);
                                                tray::update_tray_menu(&tray, &handle, RecordingState::Idle, true);
                                            }
                                        }
                                    } else {
                                        log::warn!("[AUTH] No auth token — skip upload.");
                                        log::warn!("[AUTH] File saved at: {}", result.file_path.display());
                                        let state: tauri::State<'_, AppState> = handle.state();
                                        let _ = state.transition_to(RecordingState::Idle);
                                        tray::update_tray_menu(&tray, &handle, RecordingState::Idle, false);
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

                                    // Refresh tray to remove "Link with Wolfee..." and show ready state
                                    tray::update_tray_menu(&tray, &handle, RecordingState::Idle, true);
                                    log::info!("[AUTH] Tray updated — ready to record + upload");
                                }
                                Err(e) => {
                                    log::error!("[AUTH] Link failed: {}", e);
                                    log::error!("[AUTH] User can retry by clicking 'Link with Wolfee...' again");
                                }
                            }
                        });
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

                    "open-copilot-settings" => {
                        // Sub-prompt 1 placeholder. Full Settings window in Sub-prompt 6.
                        log::info!(
                            "[Copilot] Set Up Copilot clicked — Settings UI lands in Sub-prompt 6"
                        );
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
