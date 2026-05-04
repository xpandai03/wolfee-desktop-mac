use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager, Runtime,
};

use crate::copilot::state::{CopilotState, CopilotStateMutex};
use crate::state::{AppState, LinkingStatus, RecordingState, UploadStatus};

fn current_copilot_state<R: Runtime>(app: &AppHandle<R>) -> CopilotState {
    if let Some(state) = app.try_state::<CopilotStateMutex>() {
        return state.0.lock().unwrap().clone();
    }
    CopilotState::Idle
}

fn current_linking_status<R: Runtime>(app: &AppHandle<R>) -> LinkingStatus {
    if let Some(state) = app.try_state::<AppState>() {
        return *state.linking_status.lock().unwrap();
    }
    LinkingStatus::Idle
}

fn current_upload_status<R: Runtime>(app: &AppHandle<R>) -> UploadStatus {
    if let Some(state) = app.try_state::<AppState>() {
        return *state.upload_status.lock().unwrap();
    }
    UploadStatus::Idle
}

// Wolfee tray icon (template-style, 44x44 @2x)
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/trayTemplate.png");

fn tray_icon() -> Image<'static> {
    Image::from_bytes(TRAY_ICON_BYTES).expect("Failed to load tray icon")
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> Result<TrayIcon<R>, tauri::Error> {
    let icon = tray_icon();
    let tray = TrayIconBuilder::new()
        .tooltip("Wolfee Desktop")
        .icon(icon)
        .icon_as_template(true)
        .menu(&build_menu(app, RecordingState::Idle, current_copilot_state(app), false)?)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .build(app)?;

    Ok(tray)
}

pub fn update_tray_menu<R: Runtime>(
    tray: &TrayIcon<R>,
    app: &AppHandle<R>,
    state: RecordingState,
    is_authenticated: bool,
) {
    let copilot_state = current_copilot_state(app);
    if let Ok(menu) = build_menu(app, state, copilot_state, is_authenticated) {
        let _ = tray.set_menu(Some(menu));
    }

    // Icon stays as Wolfee wolf — state shown via title text

    // Update tooltip
    let tooltip = match state {
        RecordingState::Recording => "Wolfee — Recording...",
        RecordingState::Stopping => "Wolfee — Saving...",
        RecordingState::Uploading => "Wolfee — Uploading...",
        RecordingState::Complete => "Wolfee — Uploaded!",
        RecordingState::Idle => "Wolfee Desktop",
    };
    let _ = tray.set_tooltip(Some(tooltip));

    // Set visible title text next to tray icon (macOS menu bar)
    let title = match state {
        RecordingState::Recording => Some("REC"),
        RecordingState::Stopping => Some("..."),
        RecordingState::Uploading => Some("UP"),
        RecordingState::Complete => None,
        RecordingState::Idle => None,
    };
    let _ = tray.set_title(title);
}

fn copilot_status_label(state: &CopilotState) -> &'static str {
    match state {
        CopilotState::Idle => "🟢 Copilot: Idle",
        CopilotState::ShowingOverlay => "🟡 Copilot: Active",
        CopilotState::Paused => "🔴 Copilot: Paused",
        // Sub-prompt 2 listening lifecycle. Wired here so the tray
        // reflects session state even before Sub-prompt 5 lands the
        // tray-action handlers; the matching menu items themselves
        // come in Sub-prompt 5.
        CopilotState::StartingSession { .. } => "🔄 Copilot: Starting…",
        CopilotState::Listening { .. } => "🟢 Copilot: Listening",
        CopilotState::Reconnecting { .. } => "⚠️ Copilot: Reconnecting…",
        CopilotState::EndingSession { .. } => "🔄 Copilot: Ending…",
    }
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: RecordingState,
    copilot_state: CopilotState,
    is_authenticated: bool,
) -> Result<Menu<R>, tauri::Error> {
    let menu = Menu::new(app)?;

    // ─────────────────────────────────────────────
    // COPILOT SECTION (new — Sub-prompt 1)
    // Per design doc §2.2 + Decision N7: Copilot is the headline.
    // ─────────────────────────────────────────────
    let copilot_status = MenuItem::with_id(
        app,
        "copilot_status",
        copilot_status_label(&copilot_state),
        false,
        None::<&str>,
    )?;
    menu.append(&copilot_status)?;

    let open_overlay = MenuItem::with_id(
        app,
        "copilot_open_overlay",
        "Open Copilot Overlay  ⌘⌥W",
        true,
        None::<&str>,
    )?;
    menu.append(&open_overlay)?;

    // ── Session controls (Sub-prompt 2 Phase 5) ───────────────────
    // Show Start when nothing is in flight (Idle / ShowingOverlay /
    // Paused) and End when a session is live or transitioning.
    let session_sep_top = MenuItem::with_id(app, "copilot_session_sep_top", "—", false, None::<&str>)?;
    menu.append(&session_sep_top)?;

    let in_session = matches!(
        copilot_state,
        CopilotState::StartingSession { .. }
            | CopilotState::Listening { .. }
            | CopilotState::Reconnecting { .. }
            | CopilotState::EndingSession { .. }
    );

    if !in_session {
        let label = if is_authenticated {
            "Start Copilot Session"
        } else {
            "Start Copilot Session (link first)"
        };
        let start_session = MenuItem::with_id(
            app,
            "copilot_start_session",
            label,
            is_authenticated, // disabled when not authed
            None::<&str>,
        )?;
        menu.append(&start_session)?;
    } else {
        // Disable End during transient Starting/Ending so a stale
        // double-click during transitions can't kick off cascading
        // teardowns.
        let enabled = matches!(
            copilot_state,
            CopilotState::Listening { .. } | CopilotState::Reconnecting { .. }
        );
        let label = if enabled {
            "End Copilot Session"
        } else {
            "End Copilot Session (please wait…)"
        };
        let end_session = MenuItem::with_id(
            app,
            "copilot_end_session",
            label,
            enabled,
            None::<&str>,
        )?;
        menu.append(&end_session)?;

        // Manual suggestion trigger — same path as ⌘⌥G but discoverable
        // via tray for users who don't memorize hotkeys (PO 2026-05-04
        // feedback: "the hot keys are also not easy to kind of hit and
        // memorize"). Enabled only during Listening/Reconnecting.
        let suggest_enabled = matches!(
            copilot_state,
            CopilotState::Listening { .. } | CopilotState::Reconnecting { .. }
        );
        let suggest_item = MenuItem::with_id(
            app,
            "copilot_generate_suggestion",
            "Generate Suggestion  ⌘⌥G",
            suggest_enabled,
            None::<&str>,
        )?;
        menu.append(&suggest_item)?;
    }

    let session_sep_bottom = MenuItem::with_id(app, "copilot_session_sep_bottom", "—", false, None::<&str>)?;
    menu.append(&session_sep_bottom)?;

    let pause_label = if copilot_state == CopilotState::Paused {
        "Resume Copilot"
    } else {
        "Pause Copilot"
    };
    let pause_copilot = MenuItem::with_id(app, "copilot_pause", pause_label, true, None::<&str>)?;
    menu.append(&pause_copilot)?;

    let copilot_sep = MenuItem::with_id(app, "copilot_sep", "—", false, None::<&str>)?;
    menu.append(&copilot_sep)?;

    let setup_copilot =
        MenuItem::with_id(app, "copilot_setup", "Set Up Copilot…", true, None::<&str>)?;
    menu.append(&setup_copilot)?;

    // Recorder + Copilot coexistence warning (Decision N6 — soft, allowed).
    // Surface only when both are simultaneously active so the user knows
    // they're double-running on shared mic resources.
    let recorder_active = matches!(state, RecordingState::Recording);
    let copilot_active_session = matches!(
        copilot_state,
        CopilotState::Listening { .. } | CopilotState::Reconnecting { .. }
    );
    if recorder_active && copilot_active_session {
        let warn = MenuItem::with_id(
            app,
            "copilot_coexist_warn",
            "⚠️ Recorder + Copilot both running",
            false,
            None::<&str>,
        )?;
        menu.append(&warn)?;
    }

    let section_sep = MenuItem::with_id(app, "section_sep", "———", false, None::<&str>)?;
    menu.append(&section_sep)?;

    // ─────────────────────────────────────────────
    // NOTES SECTION
    // Decision N6 (recorder coexistence) deferred to Sub-prompt 6 — recorder
    // entries appear unchanged below.
    // ─────────────────────────────────────────────

    // Linking + upload status rows. Surface these BEFORE the auth row so the
    // user sees what the desktop is doing right now (fixing the Sub-prompt 1
    // bug-test silent-failure UX). All rows below are non-disruptive — they
    // only appear when there's actually something to surface.
    let linking_status = current_linking_status(app);
    let upload_status = current_upload_status(app);

    let mut needs_status_sep = false;

    match linking_status {
        LinkingStatus::Idle => {}
        LinkingStatus::InProgress => {
            let row = MenuItem::with_id(app, "linking_row", "🔄 Linking…", false, None::<&str>)?;
            menu.append(&row)?;
            needs_status_sep = true;
        }
        LinkingStatus::JustLinked => {
            let row = MenuItem::with_id(app, "linking_row", "✅ Linked!", false, None::<&str>)?;
            menu.append(&row)?;
            needs_status_sep = true;
        }
        LinkingStatus::Failed => {
            let row = MenuItem::with_id(
                app,
                "linking_failed_retry",
                "❌ Link failed — click to retry",
                true,
                None::<&str>,
            )?;
            menu.append(&row)?;
            let dismiss = MenuItem::with_id(
                app,
                "linking_failed_dismiss",
                "  Dismiss",
                true,
                None::<&str>,
            )?;
            menu.append(&dismiss)?;
            needs_status_sep = true;
        }
    }

    match upload_status {
        UploadStatus::Idle | UploadStatus::InProgress => {
            // InProgress is reflected via the existing RecordingState::Uploading
            // status row below; no need for a duplicate.
        }
        UploadStatus::JustUploaded => {
            let row = MenuItem::with_id(
                app,
                "upload_just_uploaded",
                "✅ Uploaded — open in Wolfee",
                true,
                None::<&str>,
            )?;
            menu.append(&row)?;
            needs_status_sep = true;
        }
        UploadStatus::SkippedNoAuth => {
            let row = MenuItem::with_id(
                app,
                "upload_skipped_link",
                "⚠️ Recording saved — link to upload",
                true,
                None::<&str>,
            )?;
            menu.append(&row)?;
            let dismiss = MenuItem::with_id(
                app,
                "upload_skipped_dismiss",
                "  Dismiss",
                true,
                None::<&str>,
            )?;
            menu.append(&dismiss)?;
            needs_status_sep = true;
        }
        UploadStatus::Failed => {
            let row = MenuItem::with_id(
                app,
                "upload_failed_dismiss",
                "❌ Upload failed — click to dismiss",
                true,
                None::<&str>,
            )?;
            menu.append(&row)?;
            needs_status_sep = true;
        }
    }

    if needs_status_sep {
        let status_sep = MenuItem::with_id(app, "status_sep", "—", false, None::<&str>)?;
        menu.append(&status_sep)?;
    }

    // Auth row — hide while linking is InProgress (the status row above tells
    // the user what's happening; a clickable "Link with Wolfee…" would just
    // double-open the browser).
    if !is_authenticated && linking_status != LinkingStatus::InProgress {
        let link = MenuItem::with_id(app, "link", "Link with Wolfee...", true, None::<&str>)?;
        menu.append(&link)?;
        let sep = MenuItem::with_id(app, "sep0", "—", false, None::<&str>)?;
        menu.append(&sep)?;
    }

    match state {
        RecordingState::Recording => {
            let status = MenuItem::with_id(app, "status", "● Recording", false, None::<&str>)?;
            menu.append(&status)?;
            let stop = MenuItem::with_id(app, "stop", "Stop Recording  ⌘⌥Space", true, None::<&str>)?;
            menu.append(&stop)?;
        }
        RecordingState::Stopping => {
            let status = MenuItem::with_id(app, "status", "Saving recording...", false, None::<&str>)?;
            menu.append(&status)?;
        }
        RecordingState::Uploading => {
            let status = MenuItem::with_id(app, "status", "↑ Uploading to Wolfee...", false, None::<&str>)?;
            menu.append(&status)?;
        }
        RecordingState::Complete => {
            let status = MenuItem::with_id(app, "status", "✓ Uploaded!", false, None::<&str>)?;
            menu.append(&status)?;
            let open_meeting = MenuItem::with_id(app, "open_meeting", "Open in Wolfee", true, None::<&str>)?;
            menu.append(&open_meeting)?;
        }
        RecordingState::Idle => {
            if is_authenticated {
                let start = MenuItem::with_id(app, "start", "Start Recording  ⌘⌥Space", true, None::<&str>)?;
                menu.append(&start)?;
            } else {
                let start = MenuItem::with_id(app, "start", "Start Recording (no upload — link first)", true, None::<&str>)?;
                menu.append(&start)?;
            }
        }
    }

    let sep1 = MenuItem::with_id(app, "sep1", "—", false, None::<&str>)?;
    menu.append(&sep1)?;

    let open_wolfee = MenuItem::with_id(app, "open", "Open Wolfee", true, None::<&str>)?;
    menu.append(&open_wolfee)?;

    let sep2 = MenuItem::with_id(app, "sep2", "—", false, None::<&str>)?;
    menu.append(&sep2)?;

    let quit = MenuItem::with_id(app, "quit", "Quit Wolfee", true, None::<&str>)?;
    menu.append(&quit)?;

    Ok(menu)
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        // ─── Copilot menu items ───
        "copilot_open_overlay" => {
            log::info!("[Tray] Open Copilot Overlay clicked");
            let _ = app.emit("wolfee-action", "open-copilot-overlay");
        }
        "copilot_pause" => {
            log::info!("[Tray] Pause/Resume Copilot clicked");
            let _ = app.emit("wolfee-action", "toggle-copilot-pause");
        }
        "copilot_setup" => {
            log::info!("[Tray] Set Up Copilot clicked");
            let _ = app.emit("wolfee-action", "open-copilot-settings");
        }
        "copilot_start_session" => {
            log::info!("[Tray] Start Copilot Session clicked");
            let _ = app.emit("wolfee-action", "start-copilot-session");
        }
        "copilot_end_session" => {
            log::info!("[Tray] End Copilot Session clicked");
            let _ = app.emit("wolfee-action", "end-copilot-session");
        }
        "copilot_generate_suggestion" => {
            log::info!("[Tray] Generate Suggestion clicked");
            let _ = app.emit("wolfee-action", "trigger-copilot-suggestion");
        }

        // ─── Linking / upload status row clicks ───
        "linking_failed_retry" => {
            log::info!("[Tray] Link-failed retry clicked");
            let _ = app.emit("wolfee-action", "clear-linking-status");
            let _ = app.emit("wolfee-action", "link-account");
        }
        "linking_failed_dismiss" => {
            log::info!("[Tray] Link-failed dismiss clicked");
            let _ = app.emit("wolfee-action", "clear-linking-status");
        }
        "upload_just_uploaded" => {
            log::info!("[Tray] Just-uploaded row clicked → open meeting");
            let _ = app.emit("wolfee-action", "clear-upload-status");
            let _ = app.emit("wolfee-action", "open-meeting");
        }
        "upload_skipped_link" => {
            log::info!("[Tray] Saved-locally row clicked → run link flow");
            let _ = app.emit("wolfee-action", "clear-upload-status");
            let _ = app.emit("wolfee-action", "link-account");
        }
        "upload_skipped_dismiss" => {
            log::info!("[Tray] Saved-locally dismiss clicked");
            let _ = app.emit("wolfee-action", "clear-upload-status");
        }
        "upload_failed_dismiss" => {
            log::info!("[Tray] Upload-failed dismiss clicked");
            let _ = app.emit("wolfee-action", "clear-upload-status");
        }

        // ─── Existing recorder / nav items (unchanged) ───
        "start" => {
            log::info!("[Tray] Start Recording clicked");
            let _ = app.emit("wolfee-action", "start-recording");
        }
        "stop" => {
            log::info!("[Tray] Stop Recording clicked");
            let _ = app.emit("wolfee-action", "stop-recording");
        }
        "open" => {
            log::info!("[Tray] Open Wolfee clicked");
            let _ = app.emit("wolfee-action", "open-wolfee");
        }
        "open_meeting" => {
            log::info!("[Tray] Open Meeting clicked");
            let _ = app.emit("wolfee-action", "open-meeting");
        }
        "link" => {
            log::info!("[Tray] Link clicked");
            let _ = app.emit("wolfee-action", "link-account");
        }
        "quit" => {
            log::info!("[Tray] Quit clicked");
            app.exit(0);
        }
        _ => {}
    }
}
