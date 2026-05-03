use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::copilot::{
    state::{CopilotState, CopilotStateMutex},
    window,
};

/// Register the Copilot hotkeys.
///
/// Sub-prompt 1: `⌘⌥W` toggles the overlay. Sub-prompt 3: `⌘⌥G`
/// generates an on-demand suggestion during a Listening session
/// (Decision N4). User-customizable hotkey UI ships in Sub-prompt 6.
/// Pause-Copilot hotkey (`⌘⌥⇧W`, Decision N9) is added in Sub-prompt 6.
pub fn register<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    // ⌘⌥W — toggle overlay (Sub-prompt 1, sacred).
    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyW);
    let app_handle = app.clone();
    app.global_shortcut().on_shortcut(toggle_shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_overlay(&app_handle);
        }
    })?;
    log::info!("[Copilot] Registered hotkey ⌘⌥W (toggle overlay)");

    // ⌘⌥G — generate suggestion on demand (Sub-prompt 3, Decision N4).
    let suggest_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyG);
    let app_handle2 = app.clone();
    app.global_shortcut().on_shortcut(suggest_shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            // Route through the standard wolfee-action listener so
            // the lib.rs handler does the cooldown + state checks
            // alongside the tray-menu path. Single source of truth
            // for what "trigger a suggestion" means.
            use tauri::Emitter;
            let _ = app_handle2.emit("wolfee-action", "trigger-copilot-suggestion");
        }
    })?;
    log::info!("[Copilot] Registered hotkey ⌘⌥G (generate suggestion)");

    Ok(())
}

fn toggle_overlay<R: Runtime>(app: &AppHandle<R>) {
    let state_mutex = app.state::<CopilotStateMutex>();
    let mut state = state_mutex.0.lock().unwrap();

    // Match by reference so non-Copy variants (StartingSession et al
    // from Sub-prompt 2) don't trigger a move out of the MutexGuard.
    match &*state {
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
        // During an active listening session (or its setup/teardown)
        // the hotkey is a no-op for V1. Sub-prompt 4 (Overlay polish)
        // can repurpose it for "show suggestions" UX.
        other => {
            log::debug!("[Copilot] Hotkey ignored — current state: {}", other);
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
