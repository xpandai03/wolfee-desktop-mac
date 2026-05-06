/**
 * Sub-prompt 6.1 — silent auto-update.
 *
 * Polls https://wolfee.io/api/desktop/latest.json on app launch (the
 * endpoints array is configured in tauri.conf.json under
 * plugins.updater.endpoints). If a newer version is available, the
 * plugin downloads + ed25519-verifies the .app.tar.gz against the
 * embedded pubkey, then stages it in a temp dir. Tauri swaps the
 * bundle on the NEXT process launch — we don't auto-relaunch since
 * yanking the user's running session mid-call would be hostile.
 *
 * Failure modes (all swallowed):
 *  - Network unreachable → log + skip
 *  - 404 manifest → log + skip
 *  - Manifest schema mismatch → log + skip
 *  - Signature verification fails → log + skip
 *  - Same-version (or older) manifest → check() returns null
 *
 * Wrapped in try/catch + console.warn so the user never sees an
 * error toast or dialog. Tauri 2's JS API does NOT show a built-in
 * dialog when called programmatically — that's a v1-era opt-in.
 */

import { check } from "@tauri-apps/plugin-updater";

export async function checkForUpdatesSilently(): Promise<void> {
  try {
    const update = await check();
    if (update?.available) {
      console.log(
        `[Updater] update ${update.version} available (current ${update.currentVersion}); staging…`,
      );
      await update.downloadAndInstall();
      console.log(
        "[Updater] update staged; will apply on next process launch",
      );
    } else {
      console.log("[Updater] no update available");
    }
  } catch (e) {
    // Catches: network errors, manifest 404, schema parse errors,
    // signature verification failures, ed25519 decode errors.
    console.warn("[Updater] check failed (non-fatal):", e);
  }
}
