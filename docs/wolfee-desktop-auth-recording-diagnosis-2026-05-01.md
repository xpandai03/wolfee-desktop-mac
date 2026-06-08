# Wolfee Desktop — Auth + Recording Diagnosis (2026-05-01)

**Status:** investigation complete, **zero code changed, nothing committed.**
**Scope:** macOS only. Read-only. The diagnosis points at a single root cause with high confidence; verification steps for the PO are in §7.

---

## 1 — Repo state

- **Branch:** `main`, up to date with `origin/main`
- **HEAD:** `08455b8 fix: update pairing URL to /desktop/link with deviceName` — exactly matches the audit's reference commit
- **Working tree:** clean, no uncommitted changes
- **Recent commits:**
  - `08455b8` — pairing URL fix (Tauri-era)
  - `a8716e1` — version bump to 0.2.1 + build timestamp + duplicate-install detection (Tauri-era)
  - `d4e3ffb` — Wolfee branding (Tauri-era)
  - `aa1604f` — **migrate desktop app from Electron to Tauri 2** (the watershed commit)

**Audit accuracy:** the audit's read of `08455b8` is current. No drift. The code paths the audit traced match what's on disk.

**Critical version mismatch found:**

| Where | Version | Era |
|---|---|---|
| `package.json:3` | `"version": "0.1.2"` | **Electron** (never bumped post-migration) |
| `src-tauri/Cargo.toml:3` | `version = "0.2.1"` | Tauri 2 |
| `src-tauri/tauri.conf.json:5` | `"version": "0.2.1"` | Tauri 2 |
| `release/Wolfee Desktop-0.1.2-arm64.dmg` | `0.1.2` | **Electron** |
| Cached `release/mac-arm64/Wolfee Desktop.app/Contents/Resources/` | contains `app.asar`, `app.asar.unpacked`, `electron.icns` | **Electron** (`file Contents/MacOS/Wolfee\ Desktop` → Mach-O 64-bit executable arm64; `app.asar` confirmed via `npx asar list` — contains `dist/main/pairing.js`, `dist/main/recorder/*.js`, etc.) |
| `electron-builder.yml:30` (and `release/builder-effective-config.yaml:30`) | `electronVersion: 28.3.3` | **Electron** |
| `package.json:scripts:dist` | `tsc && electron-builder` | **Electron pipeline** (never replaced with `tauri build`) |

**Conclusion: the most recent .dmg in the repo is the pre-migration Electron build.** The Tauri 2 codebase has never been built into a distributable .dmg from this repo's release pipeline.

---

## 2 — Auth flow map (Tauri-era code, current `main`)

The current Tauri code paths the PO would hit *if they were running 0.2.1*:

### 2.1 — Token loading
- [`src-tauri/src/auth.rs:21-52`](src-tauri/src/auth.rs#L21-L52) — `AuthConfig::load()`:
  1. Try `WOLFEE_API_KEY` env var (line 23-33). If non-empty → use as `auth_token`, generate stable `device_id`.
  2. Else read `~/Library/Application Support/io.wolfee.desktop/auth.json` (path built at line 13-19).
  3. Else default state (no token, upload disabled).
- [`auth.rs:64-72`](src-tauri/src/auth.rs#L64-L72) — `resolve_backend_url()`: `WOLFEE_BACKEND_URL` env → `http://localhost:3000` in debug → `https://wolfee.io` in release.

### 2.2 — Pairing trigger (tray click)
- [`src-tauri/src/tray.rs:147-148`](src-tauri/src/tray.rs#L147-L148) — "Link with Wolfee..." menu item (`id="link"`) emits `wolfee-action: link-account`.
- [`src-tauri/src/lib.rs:276-326`](src-tauri/src/lib.rs#L276-L326) — handler:
  1. Builds URL: `{backend_url}/desktop/link?deviceId={uuid}&deviceName={hostname}` (line 283-286).
  2. `open_url()` (lib.rs:13-23) → `open` on macOS, `cmd /C start` on Windows. Opens default browser.
  3. Spawns `link-poll` thread → `auth::poll_link_status()`.

### 2.3 — Polling
- [`auth.rs:124-178`](src-tauri/src/auth.rs#L124-L178) — `poll_link_status()`:
  - Polls `GET {backend}/api/devices/{deviceId}/status` every 2 s for 60 attempts (120 s total).
  - On `linked: true` with `authToken` → returns Ok((token, userId)).
  - Errors logged at line 145-147, 153-155, 170-172. **Failure is silent to the user** — only goes to log/stderr, no dialog or notification.
- On success in `lib.rs:299-318` — saves `auth.json`, updates `AppState`, refreshes tray menu.

### 2.4 — Web-side counterpart (verified directly, since I have read access)
- [`WOLFEE-MVP/client/src/App.tsx:129`](../WOLFEE-MVP/client/src/App.tsx#L129) — `<Route path="/desktop/link">` renders `<DesktopLink>` behind `<ProtectedRoute>` (login required).
- [`WOLFEE-MVP/client/src/pages/desktop-link.tsx:25-50`](../WOLFEE-MVP/client/src/pages/desktop-link.tsx#L25-L50) — auto-fires `POST /api/devices/link` as soon as page loads + user is authenticated. **No button click required.** Good UX in the Tauri-era flow.
- [`WOLFEE-MVP/server/routes.ts:4872-4915`](../WOLFEE-MVP/server/routes.ts#L4872-L4915) — `POST /api/devices/link` mints token, stores in in-memory `linkTokenStore` Map (5 min TTL).
- [`WOLFEE-MVP/server/routes.ts:4918-4942`](../WOLFEE-MVP/server/routes.ts#L4918-L4942) — `GET /api/devices/:deviceId/status` returns the cached token once, then deletes from the Map.

**Tauri-era pairing flow looks healthy on both sides.** Pairs cleanly when the user runs current code.

### 2.5 — Legacy Electron pairing flow (what the PO is actually running)
- [`src/main/pairing.ts:16-110`](src/main/pairing.ts#L16-L110) — opens a local Electron `BrowserWindow` (400×340) loading `src/renderer/pairing.html`. User must enter a **6-character code** manually.
- The code is generated by `POST /api/devices/generate-code` ([`WOLFEE-MVP/server/routes.ts:4723`](../WOLFEE-MVP/server/routes.ts#L4723)) — likely shown on a separate web page (`desktop-pair.tsx` per `App.tsx:30`).
- Posts to `POST /api/devices/pair` ([`WOLFEE-MVP/server/routes.ts:4751`](../WOLFEE-MVP/server/routes.ts#L4751)) — endpoint still exists, still functional.
- **UX mismatch:** the marketing/onboarding likely points the PO at the new "click → browser → done" flow. The OLD app, however, opens a tiny local window asking for a code the PO doesn't have. From the PO's POV this looks like "tray menu does nothing useful."

---

## 3 — Recording flow map (Tauri-era code)

### 3.1 — Tray click → handler
- [`tray.rs:130-133`](src-tauri/src/tray.rs#L130-L133) — "Start Recording" emits `wolfee-action: start-recording`.
- [`lib.rs:125-166`](src-tauri/src/lib.rs#L125-L166) — handler:
  1. Bail if state ≠ Idle (line 128-131). Silent to user.
  2. **Auth check (line 133-136):** logs warn if no token, but **proceeds anyway** (records locally without upload). Recording does NOT require auth.
  3. Transition to `Recording` (line 138-141).
  4. Spawn `recorder-start` thread → `Recorder::start()`.
  5. On `Err`: reset state, revert tray (line 158-163). **No user-facing error.**

### 3.2 — Recorder
- [`recorder.rs:33-54`](src-tauri/src/recorder.rs#L33-L54) — `ffmpeg_path()`:
  1. `FFMPEG_PATH` env var → use it.
  2. `<exe_dir>/ffmpeg` (Tauri sidecar inside `.app/Contents/MacOS/`).
  3. Fall back to `"ffmpeg"` from `$PATH`.
- [`recorder.rs:56-85`](src-tauri/src/recorder.rs#L56-L85) — `start()`: builds capture args, spawns ffmpeg, returns Ok with output path. If spawn fails → Err.
- [`recorder.rs:155-188`](src-tauri/src/recorder.rs#L155-L188) — macOS args: tries dual capture (mic + virtual loopback). If `detect_macos_devices()` returns `None` → falls back to mic-only (line 175-187). **Recording works without BlackHole/Loopback** — just produces a mic-only WAV.
- [`recorder.rs:217-260`](src-tauri/src/recorder.rs#L217-L260) — `detect_macos_devices()`: shells out to `ffmpeg -f avfoundation -list_devices true -i "" `. Keyword-matches `blackhole`, `loopback`, `soundflower`, `virtual`, `multi-output`, `loomaudiodevice` against detected device names.
- [`recorder.rs:218-219`](src-tauri/src/recorder.rs#L218-L219) — note the `.ok()?` on line 226: **if the ffmpeg detection probe itself fails (e.g., sidecar binary missing), this returns `None` silently** — code then takes the mic-only path, which ALSO requires ffmpeg, which then ALSO fails — and *that* failure (line 71-77) is the one that propagates as `Err`.

### 3.3 — ffmpeg sidecar — present in repo
- `src-tauri/binaries/ffmpeg-aarch64-apple-darwin` exists, 421 KB, executable. ✅
- `tauri.conf.json:38` — `"externalBin": ["binaries/ffmpeg"]`. Tauri will resolve the right per-target binary at build time.
- **For the Tauri build, ffmpeg ships correctly.** A current-source build would have ffmpeg at `<app>/Contents/MacOS/ffmpeg-aarch64-apple-darwin` (renamed during bundling).

### 3.4 — Uploader
- [`uploader.rs:29-119`](src-tauri/src/uploader.rs#L29-L119) — multipart POST to `{backend}/api/meetings/import/desktop`. Bearer token auth. 200 MB limit, 120 s timeout. Errors are logged but recording file is preserved (`lib.rs:248-250`).
- [`WOLFEE-MVP/server/routes.ts:5017-5078`](../WOLFEE-MVP/server/routes.ts#L5017-L5078) — endpoint exists, accepts `audio/wav` among others, behind `requireDeviceAuth` middleware.

**Tauri-era recording flow looks healthy end-to-end.** No bugs visible in code.

### 3.5 — Legacy Electron recording flow (what the PO is actually running)
- `src/main/recorder/audioRecorder.ts`, `src/main/recorder/screenRecorder.ts`, `src/main/audioDevices.ts` (visible inside `app.asar` at `dist/main/recorder/*.js`).
- Bundled `node_modules/ffmpeg-static/ffmpeg` at `Contents/Resources/ffmpeg` (per `electron-builder.yml:27-29`).
- I did not read these files — diagnosis doesn't require it. The Electron build's recorder MAY work or MAY not, but it is **not the recorder the PO would experience after upgrading** to current code.

---

## 4 — Backend URL configuration

| Where | Value |
|---|---|
| `auth.rs:64-72` (Tauri) | `WOLFEE_BACKEND_URL` env > `http://localhost:3000` (debug) > `https://wolfee.io` (release) |
| `src/main/store.ts` (Electron, legacy) | `getBackendUrl()` exported — likely same shape, not verified |

For the PO's installed app: if it's the Electron 0.1.2 .dmg, the URL is whatever `src/main/store.ts:getBackendUrl()` returns — probably `https://wolfee.io`. Either way, the URL is unlikely to be the failure point: the *flow* on the OLD build is the wrong shape for the current backend's primary supported pairing path (auto-link via `/desktop/link` page).

---

## 5 — Identified failure points

### 5.1 — Stale install: PO is running an Electron 0.1.2 .dmg, not Tauri 0.2.1 (PRIMARY ROOT CAUSE)

**Evidence chain:**
1. `release/Wolfee Desktop-0.1.2-arm64.dmg` is the most recent .dmg in the repo (mtime Mar 17 23:36).
2. `release/mac-arm64/Wolfee Desktop.app/Contents/Resources/app.asar` exists → confirms Electron, not Tauri (Tauri produces a single Mach-O binary with no `app.asar`).
3. `npx asar list` of that file dumps `dist/main/pairing.js`, `dist/main/recorder/audioRecorder.js`, etc. — Electron-era TypeScript build.
4. `package.json:3` still pinned to `0.1.2`, never bumped post-migration.
5. `package.json:scripts:dist` still calls `electron-builder`. There is **no `tauri build` invocation anywhere in the build pipeline**.
6. WOLFEE-MVP's download URL ([`server/routes.ts:200-207`](../WOLFEE-MVP/server/routes.ts#L200-L207)) redirects `/downloads/wolfee-desktop-mac.dmg` to `${R2_PUBLIC_BASE}/downloads/wolfee-desktop-mac.dmg` — a single canonical R2 path. Without WOLFEE-MVP-side R2 inspection, **cannot directly confirm what's at that URL**, but given (a) the only build pipeline that's run is the Electron one and (b) the most recent .dmg in the repo is 0.1.2 Electron — the overwhelming likelihood is that the R2 object is the 0.1.2 Electron build.

**Failure mode for the PO:**
- PO clicks "Link with Wolfee..." → Electron opens a small local window expecting a 6-character code. PO doesn't know where to get the code, or thinks the app should open a browser → **"clicking tray menu items does nothing."**
- PO clicks "Start Recording" → if the legacy Electron audio pipeline has issues with current macOS Sequoia or with the bundled ffmpeg-static, it may silently fail → **"doesn't record meetings."**
- PO clicks "Open Wolfee" → opens `https://wolfee.io` in browser → **"just opens the Wolfee web app."** (This is correct behavior for that menu item, but the PO may have clicked it expecting something else.)

**Likelihood: HIGH.** This is the top suspect by a wide margin. Everything else in the symptom list is explainable by "PO is on an old build that uses a fundamentally different pairing UX."

### 5.2 — Silent UX on every Tauri-era handler failure path (SECONDARY, applies AFTER fixing 5.1)

Even after the PO upgrades to a Tauri 0.2.1 build:
- Pairing timeout (auth.rs:177) → only `Err` returned to caller. lib.rs:320-324 logs error but no user-visible toast/notification.
- Recording fails (lib.rs:158-163) → tray reverts, no error UI.
- Uploader fails (lib.rs:247-253) → tray reverts, file preserved silently in `~/Library/Application Support/io.wolfee.desktop/recordings/`.

**Likelihood this *is* the PO's current issue:** LOW (because they're not running this code). But it WILL bite users in the next release — flagged as a TODO for whoever owns the next desktop sub-prompt.

### 5.3 — Other potential failure points (ruled out by code reading)

- ❌ macOS mic permission → entitlements.plist has `audio-input`. App should prompt automatically on first ffmpeg invocation. Not a silent failure path.
- ❌ ffmpeg sidecar missing → `binaries/ffmpeg-aarch64-apple-darwin` exists in repo, would ship with Tauri build correctly.
- ❌ Tauri code bug → auth + recorder + uploader code reads fine; mirrors a working pattern (audit found no logic bugs).
- ❌ Backend regression to `/api/devices/link`, `/status`, `/import/desktop` → endpoints all present in current WOLFEE-MVP `routes.ts` with the shapes the desktop expects.

---

## 6 — Branch verdict

**Branch A — local install issue:** **HIGH likelihood** (estimated >85%). The `.dmg` the PO downloaded from `wolfee.io/downloads/wolfee-desktop-mac.dmg` is almost certainly the pre-Tauri Electron 0.1.2 build, which uses a 6-character pairing code flow that doesn't match the current app's "click → browser → done" UX.

**Branch B — backend regression:** **LOW likelihood** (~5%). Both the new `POST /api/devices/link` (used by Tauri) and the legacy `POST /api/devices/pair` (used by Electron) are present and functional in current `WOLFEE-MVP/server/routes.ts`. No regression visible from code reading. (This becomes 0% if the WOLFEE-MVP agent confirms no recent breaking changes — see §8.)

**Branch C — desktop codebase bug:** **LOW likelihood** (~10%). The Tauri 2 code at HEAD is consistent with the audit's assessment: clean, readable, no logic bugs. Has UX issues (5.2: silent failures) but those don't match the PO's described symptoms.

**Most likely: Branch A — but with a structural twist.** This is not "PO needs to re-pair" — it's "the build pipeline was never updated to ship Tauri-era artifacts, so the canonical download URL still serves the pre-migration Electron build." Re-downloading from the same URL won't help. The fix requires building a Tauri 0.2.1 .dmg from current source, uploading it to R2 at the canonical path, and *then* having the PO re-download.

**Confidence:** very high on the verdict, conditional on §7 manual verification.

---

## 7 — What the PO can verify manually (5 min)

Run these on the Mac with the broken install:

### 7.1 — Confirm the installed app's actual version
```bash
mdls -name kMDItemVersion "/Applications/Wolfee Desktop.app"
defaults read "/Applications/Wolfee Desktop.app/Contents/Info.plist" CFBundleVersion
defaults read "/Applications/Wolfee Desktop.app/Contents/Info.plist" CFBundleShortVersionString
```
- If output shows **0.1.2** → confirmed Electron build. Branch A locked in.
- If output shows **0.2.1** → unexpected; flag immediately, re-evaluate verdict.

### 7.2 — Confirm Electron vs Tauri
```bash
ls "/Applications/Wolfee Desktop.app/Contents/Resources/" | grep asar
```
- If `app.asar` is listed → Electron build. Branch A locked in.
- If no `app.asar` → it's a Tauri build (or something stranger).

### 7.3 — Check the auth file
```bash
ls -la "$HOME/Library/Application Support/io.wolfee.desktop/" 2>/dev/null
cat "$HOME/Library/Application Support/io.wolfee.desktop/auth.json" 2>/dev/null
```
- If the dir doesn't exist → app has never paired (consistent with Branch A — Electron uses a different storage shape via `electron-store`, possibly at `~/Library/Application Support/Wolfee Desktop/config.json`).
- If `auth.json` is empty or missing `auth_token` → pairing never completed.

### 7.4 — Check Electron's storage location (in case the app paired but to the wrong place)
```bash
ls -la "$HOME/Library/Application Support/Wolfee Desktop/" 2>/dev/null
cat "$HOME/Library/Application Support/Wolfee Desktop/config.json" 2>/dev/null
```
- This is the path electron-store uses by default (named after `productName` in `package.json`). If the PO ever paired with the Electron build, the token lives here, NOT in `io.wolfee.desktop/auth.json`.

### 7.5 — Live logs
```bash
"/Applications/Wolfee Desktop.app/Contents/MacOS/Wolfee Desktop" 2>&1 | head -100
```
Run from Terminal. Click tray menu items and watch stderr. Electron's `console.log` and `console.error` from `src/main/index.ts` and friends will be visible. The text directly reveals which code path runs.

### 7.6 — Confirm what's served at the download URL (use any browser or curl)
```bash
curl -sI -L "https://wolfee.io/downloads/wolfee-desktop-mac.dmg" | grep -iE "content-length|location|last-modified"
```
Use the redirect target's `Last-Modified` and `Content-Length`. If the download is the same size as `release/Wolfee Desktop-0.1.2-arm64.dmg` (149 MB-ish, mtime Mar 17 2026) → confirmed stale R2 object.

---

## 8 — What needs WOLFEE-MVP agent confirmation

I read these directly via cross-repo access, but flagging them so the WOLFEE-MVP agent can verify (and watch for changes that break desktop in future):

1. **`POST /api/devices/link`** ([`server/routes.ts:4872`](../WOLFEE-MVP/server/routes.ts#L4872)) — confirmed present, expects `{ deviceId, deviceName }`, requires `requireAuth`. Stores `{ authToken, userId, backendUrl }` in in-memory `linkTokenStore` Map with 5 min TTL.
2. **`GET /api/devices/:deviceId/status`** ([`server/routes.ts:4918`](../WOLFEE-MVP/server/routes.ts#L4918)) — confirmed present, returns `{ linked, authToken, userId, backendUrl }` once (delete-on-read).
3. **`POST /api/devices/pair`** ([`server/routes.ts:4751`](../WOLFEE-MVP/server/routes.ts#L4751)) — legacy code-based pairing, still functional; Electron build depends on this.
4. **`POST /api/meetings/import/desktop`** ([`server/routes.ts:5017`](../WOLFEE-MVP/server/routes.ts#L5017)) — confirmed present, behind `requireDeviceAuth`, accepts `audio/wav` and others, 500 MB limit.
5. **`/desktop/link` web page** ([`client/src/pages/desktop-link.tsx`](../WOLFEE-MVP/client/src/pages/desktop-link.tsx)) — auto-fires `POST /api/devices/link` on page load when authenticated. Looks healthy.

**One thing only the WOLFEE-MVP agent can confirm:** what's currently at `${R2_PUBLIC_BASE}/downloads/wolfee-desktop-mac.dmg`. If the byte size and Last-Modified match `release/Wolfee Desktop-0.1.2-arm64.dmg` (this repo, ~149 MB, Mar 17 2026), the R2 object is the stale Electron build — Branch A confirmed at the infrastructure level. If it's a freshly-uploaded Tauri 0.2.1 build, my verdict is wrong and we need to re-investigate.

---

## 9 — Recommended fix path

**Branch A confirmed → two options, pick one:**

### Option 9a (recommended, full fix — ~2 hours)
1. **wolfee-desktop agent** (separate prompt): build Tauri 0.2.1 .dmg from current `08455b8` source. Steps:
   - Update `package.json:version` to `0.2.1` (sync with Cargo).
   - Replace `package.json:scripts:dist` with a `tauri build` invocation (or add a separate `tauri:dist` script and document the migration).
   - Run `pnpm tauri build` (or `npm run tauri build`) — produces a signed + notarized `.dmg` via the existing `bundle.macOS.signingIdentity` config in `tauri.conf.json`. Uses `scripts/notarize.js` if hooked into `bundle.macOS.afterSign`.
   - Verify with `codesign --verify --deep --strict --verbose=2` and `spctl --assess --type exec --verbose`.
2. **WOLFEE-MVP agent** (separate prompt): upload the new `.dmg` to R2 at the canonical path `downloads/wolfee-desktop-mac.dmg`, replacing the stale 0.1.2.
3. **PO**: download fresh from `https://wolfee.io/downloads/wolfee-desktop-mac.dmg`, install (move existing app to Trash first to avoid duplicate-install warning that lib.rs:71-80 will log), launch, click "Link with Wolfee...", complete the new browser-based flow.

### Option 9b (10-min quick-unstick, doesn't fix the root cause)
1. PO uses the legacy Electron pairing flow they actually have:
   - Visit `https://wolfee.io/desktop/pair` (the `desktop-pair.tsx` page), get a 6-char code.
   - In the Electron app's tray, click "Link with Wolfee...", paste the code into the local pairing window.
2. This unblocks the PO temporarily but does not solve "the canonical download URL serves a stale build" — every new user who downloads from wolfee.io will hit the same problem until 9a is done.

**Strongly recommend 9a.** 9b only buys time.

**Tertiary cleanup (deferred, not this prompt):**
- Delete `wolfee-desktop/src/`, `electron-builder.yml`, Electron entries in `package.json`, `cert.p12`, `developerID_application.cer` once 9a ships and is confirmed working. These are dead weight per audit §2.
- Improve UX on Tauri-era silent-failure paths (5.2). Tray notification or tray menu status row showing "❌ Pairing failed — click to retry."

---

## 10 — Time estimate to resolution

| Path | Best case | Likely | Worst case |
|---|---|---|---|
| **9a (full fix)** | 1 hour (agent builds + uploads + PO re-installs cleanly) | 2 hours | 4 hours (notarization fails, agent has to debug signing identity, R2 upload permissions issue) |
| **9b (Electron quick-unstick)** | 10 min (PO finds the pair page, gets code, enters it) | 30 min | 1 hour (Electron build has its own bug — back to Branch C territory) |

**If the PO unblocks via 9b first, the 9a build-and-upload work still needs to happen this week** — otherwise it'll bite the next user who downloads.

---

## TODOs spotted but out of scope for this diagnosis

- T1 — `package.json` is half-migrated (still has Electron deps, version 0.1.2). Should be cleaned up as part of 9a.
- T2 — Tauri-era handlers have systemic silent-failure UX (§5.2). Tray notifications would be cheap and high-value.
- T3 — Backend's `linkTokenStore` is in-memory (`routes.ts:4863`); a backend restart between web-side link and desktop-side poll loses the token. Low-volume so unlikely to bite, but flagged.
- T4 — `electron-builder.yml:notarize: false` — the historical Electron builds were *not* notarized via electron-builder's auto-notarize. If the cached 0.1.2 .dmg was never notarized (or notarization expired), the PO may also see a Gatekeeper warning on launch. Tertiary; doesn't change the diagnosis.

---

**End of diagnosis.**
No code modified. Nothing committed. Hand the §6 verdict + §7 manual checks + §9 recommended fix path to the PO.
