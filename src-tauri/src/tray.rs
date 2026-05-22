//! Menu-bar tray (UX redesign — iteration 2).
//!
//! The tray is no longer the app's UI surface — the unified Wolfee
//! panel (`recorder/panel_window.rs` + `RecorderPanel.tsx`) is.
//!
//! - **Left-click** the icon → toggle the unified panel, anchored
//!   under the icon (`show_menu_on_left_click(false)` + the tray
//!   click event).
//! - **Right-click** → a minimal native menu (Open Wolfee, Quit) as
//!   a safety net.
//!
//! State (Copilot session, recording, upload, auth) is no longer
//! rendered as menu rows — it lives in the panel, fed by the
//! `wolfee-state` event that `emit_wolfee_state` broadcasts. The
//! `update_tray_*` functions keep their old signatures (lib.rs calls
//! them in many places) but now just refresh the menu-bar glyph and
//! re-broadcast `wolfee-state`.

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

use crate::copilot::state::{CopilotState, CopilotStateMutex};
use crate::state::{AppState, LoomState, RecordingState};

// Wolfee tray icon (template-style, 44x44 @2x).
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/trayTemplate.png");

fn tray_icon() -> Image<'static> {
    Image::from_bytes(TRAY_ICON_BYTES).expect("Failed to load tray icon")
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> Result<TrayIcon<R>, tauri::Error> {
    let tray = TrayIconBuilder::new()
        .tooltip("Wolfee")
        .icon(tray_icon())
        .icon_as_template(true)
        .menu(&build_minimal_menu(app)?)
        // Left-click no longer shows the menu — it toggles the panel.
        // Right-click still shows the menu below.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| handle_tray_icon_event(tray, event))
        .build(app)?;
    Ok(tray)
}

/// Minimal right-click menu — a safety net only. Everything else is
/// in the panel.
fn build_minimal_menu<R: Runtime>(app: &AppHandle<R>) -> Result<Menu<R>, tauri::Error> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "open", "Open Wolfee", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "sep", "—", false, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Wolfee", true, None::<&str>)?)?;
    Ok(menu)
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "open" => {
            let _ = app.emit("wolfee-action", "open-wolfee");
        }
        "quit" => {
            log::info!("[Tray] Quit clicked");
            app.exit(0);
        }
        _ => {}
    }
}

/// Left-click the tray icon → toggle the unified panel anchored under
/// the icon. We act on button-Up only so the Down/Up pair of a single
/// click doesn't toggle twice.
fn handle_tray_icon_event<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        position,
        ..
    } = event
    {
        log::info!("[Tray] icon left-clicked — toggling panel");
        crate::recorder::panel_window::toggle_recorder_panel(tray.app_handle(), position);
    }
}

// ── State broadcasting ──────────────────────────────────────────────

/// Map the Copilot state machine to a stable kind string the panel
/// renders (status text + Start/End button enablement).
fn copilot_kind(state: &CopilotState) -> &'static str {
    match state {
        CopilotState::Idle => "idle",
        CopilotState::ShowingOverlay => "overlay",
        CopilotState::StartingSession { .. } => "starting",
        CopilotState::Listening { .. } => "listening",
        CopilotState::Reconnecting { .. } => "reconnecting",
        CopilotState::EndingSession { .. } => "ending",
    }
}

fn current_copilot_state<R: Runtime>(app: &AppHandle<R>) -> CopilotState {
    app.try_state::<CopilotStateMutex>()
        .map(|s| s.0.lock().unwrap().clone())
        .unwrap_or(CopilotState::Idle)
}

fn current_loom_state<R: Runtime>(app: &AppHandle<R>) -> LoomState {
    app.try_state::<AppState>()
        .map(|s| *s.loom_state.lock().unwrap())
        .unwrap_or(LoomState::Idle)
}

/// Broadcast the full app state to the unified panel. Called whenever
/// Loom or Copilot state changes (via the `update_tray_*` functions)
/// and on the panel's `request-wolfee-state`.
pub fn emit_wolfee_state<R: Runtime>(app: &AppHandle<R>) {
    let state = app.try_state::<AppState>();
    let loom = current_loom_state(app);
    let loom_error = state
        .as_ref()
        .and_then(|s| s.loom_error.lock().unwrap().clone());
    let loom_share = state
        .as_ref()
        .and_then(|s| s.loom_share_url.lock().unwrap().clone());
    let authed = state
        .as_ref()
        .map(|s| s.auth_token.lock().unwrap().is_some())
        .unwrap_or(false);

    let payload = serde_json::json!({
        "loom": loom.to_string(),
        "loomError": loom_error,
        "loomShareUrl": loom_share,
        "copilot": copilot_kind(&current_copilot_state(app)),
        "authed": authed,
    });
    let _ = app.emit("wolfee-state", payload);
}

// ── Tray refresh entry points (signatures kept for lib.rs) ──────────

/// Legacy/auth/linking refresh. The native menu is static now, so
/// this only re-broadcasts state to the panel.
pub fn update_tray_menu<R: Runtime>(
    tray: &TrayIcon<R>,
    app: &AppHandle<R>,
    state: RecordingState,
    is_authenticated: bool,
) {
    let _ = (tray, state, is_authenticated);
    emit_wolfee_state(app);
}

/// Loom recorder refresh — updates the menu-bar glyph and re-broadcasts
/// state. During `Uploading` the live percentage is driven separately
/// by the `wolfee-loom-progress` event from lib.rs.
pub fn update_tray_for_loom<R: Runtime>(tray: &TrayIcon<R>, app: &AppHandle<R>) {
    let (title, tooltip): (Option<&str>, &str) = match current_loom_state(app) {
        LoomState::Countdown => (Some("● ···"), "Wolfee — recording starts soon"),
        LoomState::Recording => (Some("● REC"), "Wolfee — recording your screen"),
        LoomState::Stopping => (Some("● ···"), "Wolfee — finishing recording"),
        LoomState::Uploading => (Some("⬆ 0%"), "Wolfee — uploading recording"),
        LoomState::Complete => (None, "Wolfee — recording uploaded"),
        LoomState::Failed => (None, "Wolfee — recording failed"),
        LoomState::Idle => (None, "Wolfee"),
    };
    let _ = tray.set_title(title);
    let _ = tray.set_tooltip(Some(tooltip));
    emit_wolfee_state(app);
}
