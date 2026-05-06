# Sub-prompt 6.1 — Auto-Update Infrastructure — Plan

Status: pre-implementation. Owner: this session. Target: 0.7.0.

## Architecture

```
       App boot                Tauri's check()                manifest                 R2
   ┌──────────────┐    HTTPS GET     ┌────────────────────────────┐
   │ CopilotOverlay├───────────────► │ wolfee.io/api/desktop/      │
   │  useEffect    │                 │   latest.json               │
   │  → check()    │                 │ Returns:                    │
   │  → DI()       │                 │ {version, platforms.{       │
   │  fire&forget  │                 │   darwin-aarch64: {sig,url}}│
   └──────┬────────┘                 └─────────────┬───────────────┘
          │                                        │
          │ if newer than current                  │ url points to
          ▼                                        ▼
   ┌──────────────┐    HTTPS GET     ┌──────────────────────────┐
   │ download +   │◄─────────────────┤ pub-cc4f...r2.dev/        │
   │ verify sig   │                  │   downloads/              │
   │ ed25519      │                  │   wolfee-desktop-mac      │
   │ pub embedded │                  │   .app.tar.gz             │
   └──────┬───────┘                  └──────────────────────────┘
          │ stage in temp dir
          ▼
    [next launch]
    Tauri swaps bundle silently before app boots
```

Polling: **launch-only** (no interval polling while running). Per Tauri 2 docs, calling `check()` programmatically does NOT trigger a built-in dialog — it's silent by default unless you opt into the deprecated `dialog: true` config (we don't). `downloadAndInstall()` returns when staging is complete; the actual swap happens on next process launch.

## Decisions

| | Choice | Why |
|---|---|---|
| Endpoint host | Railway backend `/api/desktop/latest.json` | Lets us A/B + roll back via env vars without re-uploading R2 manifest. Matches our existing `/api/desktop/latest` shape. |
| Update bundle host | R2 (same bucket as .dmg) | One distribution surface; CDN-fronted via Cloudflare. |
| Polling | Launch-only | Simplest UX for V1. Interval polling is V2 polish. |
| Prompt UX | Silent | PO spec; Tauri 2's JS API has no built-in dialog when called programmatically. |
| Failure mode | Log + continue | check() throws on network/404/sig-mismatch — wrapped in try/catch, console.warn, no user-visible error. |
| First version | 0.7.0 | Existing 0.6.0 users will manually re-download once; future updates auto-flow. |
| Manifest pub_date | Current timestamp at release commit | Hardcoded constant in routes.ts so all clients see same value. |

## Plugin + dep additions

**Cargo** (`src-tauri/Cargo.toml`):
```toml
tauri-plugin-updater = "2"
```

**npm** (`overlay/package.json`):
```json
"@tauri-apps/plugin-updater": "^2"
```

**Process plugin not added** — `relaunch()` from `@tauri-apps/plugin-process` is documented but Tauri 2's `downloadAndInstall()` already stages without restart. We don't auto-relaunch (PO spec: "swap on next quit/launch cycle").

**Capability** (`src-tauri/capabilities/default.json`):
```
"updater:default"
```

## tauri.conf.json changes

```json
{
  "bundle": {
    ...
    "createUpdaterArtifacts": true,    // produces .app.tar.gz + .sig
    "targets": ["dmg"],                // unchanged
    ...
  },
  "plugins": {
    "shell": { "open": true },         // unchanged
    "updater": {
      "pubkey": "<contents of ~/.tauri/wolfee.key.pub>",
      "endpoints": [
        "https://wolfee.io/api/desktop/latest.json"
      ]
    }
  }
}
```

Sacred: `bundle.macOS.signingIdentity`, `bundle.macOS.entitlements`, `bundle.macOS.minimumSystemVersion`, `bundle.macOS.infoPlist`, `app.macOSPrivateApi`, `app.security` — all untouched.

## Frontend wiring

**New file** `overlay/src/updater.ts`:
```ts
import { check } from "@tauri-apps/plugin-updater";

export async function checkForUpdatesSilently(): Promise<void> {
  try {
    const update = await check();
    if (update?.available) {
      console.log(`[Updater] update ${update.version} available, staging…`);
      await update.downloadAndInstall();
      console.log("[Updater] staged; will apply on next launch");
    } else {
      console.log("[Updater] no update available");
    }
  } catch (e) {
    console.warn("[Updater] check failed (non-fatal):", e);
  }
}
```

**Mount** in `overlay/src/CopilotOverlay.tsx` — single useEffect on component mount, fire-and-forget. Behind `import.meta.env.PROD` guard so dev runs don't try to hit the production endpoint with a dev-build version that may not match.

## Backend route

`WOLFEE-MVP/server/routes.ts` — add adjacent to existing `/api/desktop/latest`:

```ts
const DESKTOP_UPDATE_SIG = "<paste contents of .app.tar.gz.sig — base64 inline>";
const DESKTOP_UPDATE_URL = `${R2_PUBLIC_BASE}/downloads/wolfee-desktop-mac.app.tar.gz`;
const DESKTOP_UPDATE_NOTES = "Auto-update enabled.";
const DESKTOP_UPDATE_PUB_DATE = "2026-05-06T00:00:00Z"; // build date, hardcoded

const latestUpdaterHandler: express.RequestHandler = (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Content-Type", "application/json");
  res.json({
    version: DESKTOP_VERSION,
    notes: DESKTOP_UPDATE_NOTES,
    pub_date: DESKTOP_UPDATE_PUB_DATE,
    platforms: {
      "darwin-aarch64": {
        signature: DESKTOP_UPDATE_SIG,
        url: DESKTOP_UPDATE_URL,
      },
    },
  });
};
app.get("/api/desktop/latest.json", latestUpdaterHandler);
```

Existing `/api/desktop/latest` stays untouched (website's "Download" button + the pre-update version-check both still work).

## Build pipeline changes

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/wolfee.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<passphrase>"
cargo tauri build
# Produces:
#   target/release/bundle/macos/Wolfee Desktop.app
#   target/release/bundle/macos/Wolfee Desktop.app.tar.gz
#   target/release/bundle/macos/Wolfee Desktop.app.tar.gz.sig
#   (target/release/bundle/dmg/...) — expected fail via bundle_dmg.sh on Sequoia
# Then: hdiutil makehybrid recipe to package the .dmg manually (carried over from 5.2/6.0)
# Then: codesign + notarize + staple .dmg as usual.
# .app.tar.gz does NOT need codesign — it's just a tarball of the already-signed .app.
```

## R2 upload (3 keys)

```
downloads/wolfee-desktop-mac.dmg          (overwrite — first-time downloads)
downloads/wolfee-desktop-mac.app.tar.gz   (NEW — update bundle)
downloads/wolfee-desktop-mac.app.tar.gz.sig (NEW — text signature)
```

Cache headers: `no-cache, no-store, must-revalidate` (same as 0.6.0). `text/plain` content-type for .sig; `application/x-apple-diskimage` for .dmg; `application/gzip` for .tar.gz. Roundtrip-verify content-length on .dmg + .tar.gz; .sig is small enough that we just diff the body.

## File map

**New files:**
- `overlay/src/updater.ts`
- `PLAN-auto-update-v0.7.0.md` (this file)

**Modified files:**
- `src-tauri/tauri.conf.json` — `bundle.createUpdaterArtifacts`, `plugins.updater`, version bump
- `src-tauri/Cargo.toml` — `tauri-plugin-updater` dep + version bump
- `overlay/package.json` — `@tauri-apps/plugin-updater` dep
- `package.json` (root) — version bump
- `src-tauri/src/lib.rs` — register updater plugin in builder
- `src-tauri/capabilities/default.json` — `updater:default` permission
- `overlay/src/CopilotOverlay.tsx` — useEffect calling checkForUpdatesSilently on mount
- `WOLFEE-MVP/server/routes.ts` — new `/api/desktop/latest.json` handler + 4 constants
- `.gitignore` — exclude `.tauri/` (defensive — actual key file is at `~/.tauri/`, outside repo, but belt-and-suspenders)

**Deleted files:** none.

## Implementation order (commits)

1. `docs(plan): auto-update infrastructure (0.7.0)` — this file
2. `chore(gitignore): exclude .tauri signing key directory`
3. *** PO CHECKPOINT — keypair generated, await "key backed up" ***
4. `chore(deps): add tauri-plugin-updater rust + js deps`
5. `feat(updater): register plugin + add capability + tauri.conf updater section`
6. `feat(updater): silent check + install on overlay mount`
7. `feat(backend): add /api/desktop/latest.json manifest endpoint`
8. `chore(release): bump to 0.7.0 — auto-update enabled`

## Risk surface

| Risk | Mitigation |
|---|---|
| Wrong pubkey embedded → every future update fails verification | Print pubkey to console after generation; PO confirms it matches `~/.tauri/wolfee.key.pub` content before commit. |
| Wrong endpoint URL → no users ever update | Hardcode the production URL `https://wolfee.io/api/desktop/latest.json` in tauri.conf.json. Smoke verifies `curl` returns 200 + valid JSON before final ship. |
| Manifest schema drift between Tauri versions | Use exact schema from current docs (verified via WebFetch this session): `{version, notes, pub_date, platforms.{"darwin-aarch64": {signature, url}}}`. |
| Bundle format mismatch (`.app.tar.gz` layout) | Tauri owns this — `createUpdaterArtifacts: true` produces the canonical layout. |
| Network failure on first launch → silent skip | Acceptable for V1 — `try/catch` swallows + logs. Next launch retries. |
| Lost private key | PO must back up to 1Password BEFORE first build. Hard checkpoint enforced. |
| Existing 0.5.x / 0.6.x users miss updates | Inherent — they predate the embedded pubkey. They get one final manual download to 0.7.0. Future updates auto-flow. |
| .app.tar.gz fails Gatekeeper post-extract | Gatekeeper checks the .app inside, which has the same codesign + notarization as the .dmg version. Tar/gz wrapping is transparent. |
| 0.7.0 itself ships with a bug + no auto-update path back | Workaround: bump backend manifest to revert URL to a known-good version's bundle. The R2 keys overwrite cleanly. |

## Test strategy

**Dev-mode smoke (before final .dmg build):**
- `pnpm tauri dev` boots without panic
- Console shows either `[Updater] no update available` (if backend manifest not yet pointing at 0.7.0) OR `[Updater] check failed (non-fatal)` if endpoint not yet up — both acceptable
- No UI prompts, no popups
- Onboarding wizard from 6.0 still renders (regression check)
- Strip + overlay still work (SP5.2 regression)
- Tray menu unchanged from 6.0

**Release smoke (after .dmg build):**
- Run release binary from terminal with stderr capture; confirm boot log shows `[Updater] no update available` because version matches manifest
- `cargo check` clean
- `tsc --noEmit` clean
- All 3 R2 artifacts have matching content-length when curl'd

**The real proof — 0.7.1:**
Auto-update is unverified until 0.7.0 → 0.7.1 succeeds end-to-end. After 0.7.0 ships and PO installs:
1. PO runs 0.7.0
2. Next sub-prompt: trivial 0.7.1 bump (e.g., visible version label in tray tooltip)
3. PO quits + relaunches 0.7.0
4. Confirms 0.7.1 visible

Until that round-trip, we have signed infrastructure but no proven delivery.

## Rollback plan

- Revert all 6.1 commits; rebuild 0.6.0 .dmg from `6d6f6ee` checkout.
- Wipe R2 `.app.tar.gz` + `.sig` so existing 0.7.x users don't pull a bad update.
- Update backend manifest to either 404 the endpoint or point at last-known-good URL.
- Generate new keypair only if private key is compromised (very different scenario from rolling back code).

## Out of scope (flagged for follow-up)

- Update notification UI (currently silent — V2 polish)
- Staged rollouts / version targeting (currently 100%)
- Update interval polling (currently launch-only)
- Force-update / required-update mechanism
- Auto-update for users on 0.6.x and earlier (impossible — predates embedded pubkey)
- Linux / Intel Mac / Windows builds
- Rollback kill-switch beyond manifest URL change
- Code-signing of the `.app.tar.gz` itself (it's just a wrapper; the .app inside is already signed + notarized)
