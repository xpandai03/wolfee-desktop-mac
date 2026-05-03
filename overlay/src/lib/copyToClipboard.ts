/**
 * Wrapper around `navigator.clipboard.writeText` with friendly
 * fallback. Returns true on success; caller can drive the flash
 * UX based on the boolean.
 */

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // Some Tauri / sandboxed contexts may need permission grants;
    // fall through to legacy below.
    console.warn("[Copilot] navigator.clipboard.writeText failed:", err);
  }

  // Legacy fallback — works inside Tauri webviews even when
  // navigator.clipboard isn't available (older webview2 builds, etc).
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch (err) {
    console.warn("[Copilot] legacy clipboard fallback failed:", err);
    return false;
  }
}
