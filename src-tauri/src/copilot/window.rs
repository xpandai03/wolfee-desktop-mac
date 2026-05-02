use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const OVERLAY_LABEL: &str = "copilot-overlay";

const OVERLAY_WIDTH: f64 = 420.0;
const OVERLAY_HEIGHT: f64 = 280.0;
const TOP_MARGIN: f64 = 40.0;

pub fn create_overlay_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        log::info!("[Copilot] Overlay window already exists — skipping create");
        return Ok(());
    }

    // Note: Tauri 2's `transparent(true)` requires the `macos-private-api` feature
    // (uses Apple private APIs). We ship Sub-prompt 1 with a solid dark backdrop;
    // Sub-prompt 4 (UI polish) can opt in to private-API transparency if the design
    // calls for it.
    let overlay = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
        .title("Wolfee Copilot")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
        .visible(false)
        .focused(false)
        .shadow(false)
        .build()?;

    // Critical: the whole point of this window is content protection during screen share.
    // If this call fails we still build the window (some macOS setups may not honor it,
    // surfaced via Risk #2 in the design doc), but we log loudly so it's never a silent fail.
    if let Err(e) = overlay.set_content_protected(true) {
        log::error!("[Copilot] set_content_protected failed: {}", e);
    } else {
        log::info!("[Copilot] Overlay content protection enabled");
    }

    position_top_center(&overlay);

    Ok(())
}

fn position_top_center<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let monitor = match window.primary_monitor() {
        Ok(Some(m)) => m,
        _ => {
            log::warn!("[Copilot] No primary monitor — overlay using default position");
            return;
        }
    };
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let window_px = (OVERLAY_WIDTH * scale) as i32;
    let x = ((size.width as i32) - window_px) / 2;
    let y = (TOP_MARGIN * scale) as i32;
    if let Err(e) = window.set_position(PhysicalPosition { x, y }) {
        log::warn!("[Copilot] Failed to position overlay: {}", e);
    }
}

pub fn show_overlay<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let window = match app.get_webview_window(OVERLAY_LABEL) {
        Some(w) => w,
        None => {
            log::error!("[Copilot] show_overlay: overlay window not found");
            return Ok(());
        }
    };
    // Re-position each time so monitor changes (lid open / external display) are honored.
    position_top_center(&window);
    window.show()?;
    window.set_focus()?;
    Ok(())
}

pub fn hide_overlay<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        window.hide()?;
    }
    Ok(())
}

#[allow(dead_code)]
pub fn is_overlay_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(OVERLAY_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}
