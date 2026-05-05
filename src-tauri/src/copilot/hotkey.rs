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

    // ⌘+\ — Sub-prompt 4.5 alias for ⌘⌥W. Cluely uses Cmd+\ as the
    // hide-all gesture and PO testing showed it's the natural muscle-
    // memory shortcut. Same toggle_overlay handler — pure aliasing,
    // no separate behavior.
    let hide_alias = Shortcut::new(Some(Modifiers::SUPER), Code::Backslash);
    let app_handle3 = app.clone();
    app.global_shortcut()
        .on_shortcut(hide_alias, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_overlay(&app_handle3);
            }
        })?;
    log::info!("[Copilot] Registered hotkey ⌘+\\ (toggle overlay alias)");

    // ⌘+Enter — Sub-prompt 4.6 (Cluely 1:1) — focus the chat input
    // box. If the panel is collapsed, expand it first; either way
    // emit copilot-focus-input which the React side handles.
    let focus_input_shortcut = Shortcut::new(Some(Modifiers::SUPER), Code::Enter);
    let app_handle4 = app.clone();
    app.global_shortcut()
        .on_shortcut(focus_input_shortcut, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                use tauri::Emitter;
                // Make sure the strip is visible before focus. If it's
                // hidden the user can't see what they're typing into.
                if !window::is_overlay_visible(&app_handle4) {
                    if let Err(e) = window::show_overlay(&app_handle4) {
                        log::warn!("[Copilot] ⌘+Enter show_overlay failed: {}", e);
                        return;
                    }
                }
                let _ = app_handle4.emit("copilot-focus-input", ());
            }
        })?;
    log::info!("[Copilot] Registered hotkey ⌘+Enter (focus chat input)");

    // Ctrl+Arrow — Sub-prompt 4.6 (Cluely 1:1) accessibility — nudge
    // the overlay window 20px in the arrow direction. Mirrors Cluely's
    // keyboard-only repositioning pattern.
    register_nudge(app, Code::ArrowUp, 0, -20)?;
    register_nudge(app, Code::ArrowDown, 0, 20)?;
    register_nudge(app, Code::ArrowLeft, -20, 0)?;
    register_nudge(app, Code::ArrowRight, 20, 0)?;
    log::info!("[Copilot] Registered hotkey ⌃+arrows (nudge overlay 20px)");

    Ok(())
}

fn register_nudge<R: Runtime>(
    app: &AppHandle<R>,
    arrow: Code,
    dx: i32,
    dy: i32,
) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL), arrow);
    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                if let Err(e) = window::nudge_overlay(&app_handle, dx, dy) {
                    log::warn!("[Copilot] nudge_overlay failed: {}", e);
                }
            }
        })?;
    Ok(())
}

fn toggle_overlay<R: Runtime>(app: &AppHandle<R>) {
    let state_mutex = app.state::<CopilotStateMutex>();
    let mut state = state_mutex.0.lock().unwrap();

    // Two state classes need different behavior:
    //
    //   1. Idle / Paused / ShowingOverlay — pre-session states.
    //      The hotkey transitions Idle/Paused → ShowingOverlay
    //      (showing the window AND mutating CopilotState). It also
    //      transitions ShowingOverlay → Idle on hide. CopilotState
    //      tracks visibility because there's no audio capture yet.
    //
    //   2. StartingSession / Listening / Reconnecting / EndingSession —
    //      the Sub-prompt 2 lifecycle states. These represent audio
    //      capture being live; CopilotState must NOT be overwritten
    //      to ShowingOverlay (that would corrupt the session_id +
    //      tear down workers in end-copilot-session). For these the
    //      hotkey only flips window visibility — overlay shown OR
    //      hidden alongside the live session, CopilotState untouched.
    //      Use the window's actual visibility to decide direction.
    //
    // The original Sub-prompt 1 code only handled class 1 and
    // silently no-op'd class 2, which made the overlay invisible
    // during a Listening session — Sub-prompt 4 verification 2026-05-03
    // surfaced the bug.
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
        CopilotState::StartingSession { .. }
        | CopilotState::Listening { .. }
        | CopilotState::Reconnecting { .. }
        | CopilotState::EndingSession { .. } => {
            // Drop the lock before window operations — they may
            // trigger event-loop callbacks that re-enter state
            // (focus-changed handler hides on blur, etc.).
            let session_state = state.clone();
            drop(state);
            if window::is_overlay_visible(app) {
                log::info!(
                    "[Copilot] Hotkey: hiding overlay during session ({})",
                    session_state
                );
                if let Err(e) = window::hide_overlay(app) {
                    log::error!("[Copilot] hide_overlay failed: {}", e);
                }
            } else {
                log::info!(
                    "[Copilot] Hotkey: showing overlay during session ({})",
                    session_state
                );
                if let Err(e) = window::show_overlay(app) {
                    log::error!("[Copilot] show_overlay failed: {}", e);
                }
            }
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
