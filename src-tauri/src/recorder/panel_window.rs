//! Unified Wolfee panel window (UX redesign — iteration 2).
//!
//! A frameless, transparent, always-on-top webview hosting the
//! `#/recorder` React route (`RecorderPanel.tsx`). Since iteration 2
//! this is the app's primary surface — a **left-click on the tray
//! icon toggles it** (see `tray.rs`), Loom-style, anchored just under
//! the menu-bar icon.
//!
//! Lifecycle is owned by `tray.rs` (tray click) and the lib.rs action
//! handler. The window is destroyed — not hidden — on close, so every
//! open is fresh state.

use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const RECORDER_PANEL_LABEL: &str = "recorder-panel";

const PANEL_WIDTH: f64 = 360.0;
const PANEL_HEIGHT: f64 = 600.0;

/// Toggle the panel from a tray-icon left-click: open it anchored
/// under the icon if closed, dismiss it if already open.
pub fn toggle_recorder_panel<R: Runtime>(app: &AppHandle<R>, anchor: PhysicalPosition<f64>) {
    if app.get_webview_window(RECORDER_PANEL_LABEL).is_some() {
        close_recorder_panel(app);
    } else if let Err(e) = open_panel(app, Some(anchor)) {
        log::error!("[Panel] toggle-open failed: {e}");
    }
}

/// Open the panel centered (used by the `open-recorder-panel` action,
/// which has no tray-anchor information).
pub fn open_recorder_panel<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    open_panel(app, None)
}

/// Destroy the panel window. Safe to call when it isn't open.
///
/// The destroy is deferred to the next main-loop tick via
/// `run_on_main_thread`. This is almost always called from the handler
/// of a `wolfee-action` event the panel *itself* emitted (Start /
/// Cancel); destroying the webview synchronously while that event is
/// still being dispatched is a use-after-free that segfaults the whole
/// app. Deferring runs the destroy after the dispatch has unwound.
pub fn close_recorder_panel<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(RECORDER_PANEL_LABEL) {
            if let Err(e) = window.destroy() {
                log::warn!("[Panel] destroy failed: {e}");
            }
        }
    });
}

fn open_panel<R: Runtime>(
    app: &AppHandle<R>,
    anchor: Option<PhysicalPosition<f64>>,
) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(RECORDER_PANEL_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        RECORDER_PANEL_LABEL,
        WebviewUrl::App("index.html#/recorder".into()),
    )
    .title("Wolfee")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
    .visible(false)
    .build()?;

    // The panel is destroyed before our own capture starts, but a
    // user could open it while screen-sharing in another app — keep
    // it out of those captures.
    if let Err(e) = window.set_content_protected(true) {
        log::warn!("[Panel] set_content_protected failed: {e}");
    }

    match anchor {
        Some(point) => position_anchored(&window, point),
        None => position_centered(&window),
    }
    window.show()?;
    let _ = window.set_focus();
    log::info!("[Panel] opened");
    Ok(())
}

/// Anchor the panel just below the tray icon: top edge under the
/// menu bar, horizontally centered on the click, clamped on-screen.
fn position_anchored<R: Runtime>(window: &tauri::WebviewWindow<R>, anchor: PhysicalPosition<f64>) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        log::warn!("[Panel] no primary monitor — centered fallback");
        position_centered(window);
        return;
    };
    let scale = monitor.scale_factor();
    let msize = monitor.size();
    let mpos = monitor.position();
    let panel_w = PANEL_WIDTH * scale;
    let pad = 8.0 * scale;

    let min_x = f64::from(mpos.x) + pad;
    let max_x = f64::from(mpos.x) + f64::from(msize.width) - panel_w - pad;
    let x = (anchor.x - panel_w / 2.0).clamp(min_x, max_x.max(min_x));
    // 18 pt below the click clears the menu bar regardless of its height.
    let y = anchor.y + 18.0 * scale;

    if let Err(e) = window.set_position(PhysicalPosition {
        x: x as i32,
        y: y as i32,
    }) {
        log::warn!("[Panel] anchored positioning failed: {e}");
    }
}

fn position_centered<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let w = (PANEL_WIDTH * scale) as i32;
        let h = (PANEL_HEIGHT * scale) as i32;
        let x = ((size.width as i32) - w) / 2;
        let y = ((size.height as i32) - h) / 2;
        let _ = window.set_position(PhysicalPosition { x, y });
    }
}
