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
        // Critical for the "fullscreen Zoom/Meet" use case: by default,
        // each macOS fullscreen app gets its own Space, and an
        // always-on-top window from the default Space won't render
        // there. visible_on_all_workspaces=true sets the macOS
        // NSWindowCollectionBehaviorCanJoinAllSpaces +
        // NSWindowCollectionBehaviorFullScreenAuxiliary flags so the
        // overlay floats over fullscreen apps regardless of Space.
        // Surfaced by Sub-prompt 4 verification 2026-05-03 — PO had
        // Zoom in fullscreen, overlay only appeared on the home Space.
        .visible_on_all_workspaces(true)
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

    // Sub-prompt 4 fix 2026-05-03 — bump NSWindow level above
    // fullscreen apps. visible_on_all_workspaces=true (set on the
    // builder above) handles Spaces, but Tauri's `always_on_top`
    // only sets NSFloatingWindowLevel (3) which is below the level
    // fullscreen apps render at. We elevate to
    // NSScreenSaverWindowLevel (1000) — the level macOS uses for
    // the volume HUD and other system-wide overlays that float
    // above fullscreen content.
    #[cfg(target_os = "macos")]
    elevate_window_level(&overlay);

    position_top_center(&overlay);

    Ok(())
}

#[cfg(target_os = "macos")]
fn elevate_window_level<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // NSScreenSaverWindowLevel = CGShieldingWindowLevel - 1 = 1000.
    // Tauri's `WindowLevel` enum tops out at AlwaysOnTop which maps
    // to NSFloatingWindowLevel (3) — too low for fullscreen apps.
    const NS_SCREEN_SAVER_WINDOW_LEVEL: i64 = 1000;

    // NSWindowCollectionBehavior bit-mask. Tauri 2's
    // `visible_on_all_workspaces(true)` builder call doesn't always
    // include `FullScreenAuxiliary` — verified empirically on
    // 2026-05-03: PO had Chrome in fullscreen and overlay still
    // opened on the home Space. Setting the flags directly via
    // setCollectionBehavior: bypasses Tauri's abstraction.
    //
    //   CanJoinAllSpaces       (1 << 0 = 1)   — visible in every Space
    //   Stationary             (1 << 4 = 16)  — doesn't auto-move between Spaces
    //   IgnoresCycle           (1 << 6 = 64)  — excluded from Cmd-` window cycle
    //   FullScreenAuxiliary    (1 << 8 = 256) — renders on fullscreen-app Spaces
    //
    // FullScreenAuxiliary is the critical flag for the fullscreen
    // overlay use case — same bit Apple's volume HUD uses.
    const NS_COLLECTION_BEHAVIOR: usize = 1 | 16 | 64 | 256;

    let ns_window_ptr = match window.ns_window() {
        Ok(p) => p,
        Err(e) => {
            log::warn!(
                "[Copilot] elevate_window_level: ns_window() failed: {} — overlay may not show over fullscreen apps",
                e
            );
            return;
        }
    };

    // SAFETY: ns_window() returns a non-null pointer to a valid
    // NSWindow instance owned by the macOS runtime. Both setLevel:
    // and setCollectionBehavior: are documented NSWindow methods
    // that take NSInteger / NSWindowCollectionBehavior (NSUInteger)
    // and return void. We're not retaining / releasing — just
    // calling. msg_send! is the canonical bridge.
    unsafe {
        let ns_window = ns_window_ptr as *mut AnyObject;
        let _: () = msg_send![ns_window, setLevel: NS_SCREEN_SAVER_WINDOW_LEVEL];
        let _: () = msg_send![ns_window, setCollectionBehavior: NS_COLLECTION_BEHAVIOR];
    }
    log::info!(
        "[Copilot] Overlay window level={} + collection_behavior=0x{:X}",
        NS_SCREEN_SAVER_WINDOW_LEVEL,
        NS_COLLECTION_BEHAVIOR
    );
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

pub fn is_overlay_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(OVERLAY_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}
