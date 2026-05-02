use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::copilot::{
    state::{CopilotState, CopilotStateMutex},
    window,
};

/// Register the Copilot hotkeys.
///
/// Sub-prompt 1: `⌘⌥W` toggles the overlay. User-customizable hotkey UI ships
/// in Sub-prompt 6 (per design doc §6). Pause-Copilot hotkey (`⌘⌥⇧W`,
/// Decision N9) is added in Sub-prompt 6 too.
pub fn register<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyW);

    let app_handle = app.clone();
    app.global_shortcut().on_shortcut(toggle_shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_overlay(&app_handle);
        }
    })?;

    log::info!("[Copilot] Registered hotkey ⌘⌥W (toggle overlay)");
    Ok(())
}

fn toggle_overlay<R: Runtime>(app: &AppHandle<R>) {
    let state_mutex = app.state::<CopilotStateMutex>();
    let mut state = state_mutex.0.lock().unwrap();

    match *state {
        CopilotState::Idle | CopilotState::Paused => {
            log::info!("[Copilot] Hotkey: showing overlay (was {})", *state);
            if let Err(e) = window::show_overlay(app) {
                log::error!("[Copilot] show_overlay failed: {}", e);
                return;
            }
            *state = CopilotState::ShowingOverlay;
        }
        CopilotState::ShowingOverlay => {
            log::info!("[Copilot] Hotkey: hiding overlay");
            if let Err(e) = window::hide_overlay(app) {
                log::error!("[Copilot] hide_overlay failed: {}", e);
                return;
            }
            *state = CopilotState::Idle;
        }
    }
}

/// Called when the overlay window becomes hidden via Esc / blur from the
/// frontend side, so Rust state stays in sync.
pub fn on_overlay_hidden<R: Runtime>(app: &AppHandle<R>) {
    let state_mutex = app.state::<CopilotStateMutex>();
    let mut state = state_mutex.0.lock().unwrap();
    if *state == CopilotState::ShowingOverlay {
        *state = CopilotState::Idle;
        log::info!("[Copilot] Overlay hidden — state reset to idle");
    }
}
