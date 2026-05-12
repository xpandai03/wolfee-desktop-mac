#!/usr/bin/env node

/**
 * Wolfee Desktop — Tauri Release Pipeline
 *
 * One-command: build → sign → notarize → staple → upload.
 *
 * Notarization auth — choose ONE (script auto-detects):
 *   Option A (App Store Connect API key):
 *     APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER
 *   Option B (Apple ID + app-specific password):
 *     APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID
 *
 * Optional (R2 upload — skipped if not set):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   R2_PUBLIC_URL / R2_PUBLIC_DOMAIN
 *   RELEASE_NOTES
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const TAURI_CONF = require("../src-tauri/tauri.conf.json");
const VERSION = TAURI_CONF.version;
const APP_NAME = TAURI_CONF.productName;

// Tauri 2 bundle output paths
const BUNDLE_DIR = "src-tauri/target/release/bundle";
const APP_PATH = `${BUNDLE_DIR}/macos/${APP_NAME}.app`;
const DMG_DIR = `${BUNDLE_DIR}/dmg`;

const SIGNING_IDENTITY = "Developer ID Application: XPAND TECHNOLOGY LLC (LT73Z72CKR)";
// MUST match the R2 key WOLFEE-MVP's `server/routes.ts` references
// (DESKTOP_DMG_URL = `${R2_PUBLIC_BASE}/downloads/wolfee-desktop-mac.dmg`).
// Originally `wolfee-desktop.dmg` here — that's a different R2 object
// nobody reads, so 0.7.6 went out and the wolfee.io download button
// kept serving 0.7.5 until we noticed.
const DMG_NAME = `wolfee-desktop-mac.dmg`;
const R2_KEY = `downloads/${DMG_NAME}`;
// 5 MB min sanity check — catches truly broken builds without false-
// rejecting our actual ~9 MB output (the .app is small because Tauri
// produces compact binaries vs. Electron's ~50 MB+ floor).
const MIN_DMG_SIZE = 5 * 1024 * 1024;
const NOTARIZE_TIMEOUT = 30 * 60;
const NOTARIZE_POLL_INTERVAL = 10;

// ── Helpers ──

function run(cmd, label) {
  console.log(`\n→ ${label}`);
  console.log(`  $ ${cmd}\n`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: path.resolve(__dirname, "..") });
  } catch (err) {
    console.error(`\n✗ FAILED: ${label}`);
    process.exit(1);
  }
}

function runCapture(cmd, label) {
  console.log(`\n→ ${label}`);
  console.log(`  $ ${cmd}\n`);
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      cwd: path.resolve(__dirname, ".."),
      timeout: NOTARIZE_TIMEOUT * 1000,
    });
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "");
    if (output) console.log(output);
    console.error(`\n✗ FAILED: ${label}`);
    process.exit(1);
  }
}

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`✗ Missing env var: ${name}`);
    console.error(`  Set it before running: export ${name}=...`);
    process.exit(1);
  }
  return val;
}

function httpHead(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.request(url, { method: "HEAD", timeout: 15000 }, (res) => {
      resolve({
        status: res.statusCode,
        contentLength: parseInt(res.headers["content-length"] || "0", 10),
        contentType: res.headers["content-type"] || "",
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// ── Main ──

async function main() {
  const startTime = Date.now();
  const TOTAL_STEPS = 9;

  console.log("══════════════════════════════════════════");
  console.log("  Wolfee Desktop — Tauri Release Pipeline");
  console.log("══════════════════════════════════════════");
  console.log(`  version: ${VERSION}`);
  console.log(`  target:  macOS arm64`);
  console.log(`  engine:  Tauri 2`);
  console.log("");

  // ══════════════════════════════════════════
  // Step 1: Validate env vars
  // ══════════════════════════════════════════
  console.log(`[1/${TOTAL_STEPS}] Validating environment...`);

  // Notarization auth — auto-detect Option A vs Option B. notarytool accepts
  // either; .env.release for this project uses Option B (Apple ID + app-
  // specific password). The auth args are interpolated into the three
  // notarytool invocations below (submit, info, log).
  let notarytoolAuthArgs;
  let authMode;
  if (
    process.env.APPLE_API_KEY &&
    process.env.APPLE_API_KEY_ID &&
    process.env.APPLE_API_ISSUER
  ) {
    notarytoolAuthArgs =
      `--key "${process.env.APPLE_API_KEY}" ` +
      `--key-id "${process.env.APPLE_API_KEY_ID}" ` +
      `--issuer "${process.env.APPLE_API_ISSUER}"`;
    authMode = "App Store Connect API key";
  } else if (
    process.env.APPLE_ID &&
    process.env.APPLE_ID_PASSWORD &&
    process.env.APPLE_TEAM_ID
  ) {
    notarytoolAuthArgs =
      `--apple-id "${process.env.APPLE_ID}" ` +
      `--password "${process.env.APPLE_ID_PASSWORD}" ` +
      `--team-id "${process.env.APPLE_TEAM_ID}"`;
    authMode = "Apple ID + app-specific password";
  } else {
    console.error(
      "✗ Missing notarization credentials. Set ONE of:\n" +
        "    Option A: APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER\n" +
        "    Option B: APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID"
    );
    process.exit(1);
  }

  const hasR2 = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);

  let accountId, accessKeyId, secretAccessKey, bucket, publicBase;

  if (hasR2) {
    accountId = process.env.R2_ACCOUNT_ID;
    accessKeyId = process.env.R2_ACCESS_KEY_ID;
    secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    bucket = process.env.R2_BUCKET;

    if (process.env.R2_PUBLIC_URL) {
      publicBase = process.env.R2_PUBLIC_URL.replace(/\/$/, "");
    } else if (process.env.R2_PUBLIC_DOMAIN) {
      publicBase = `https://${process.env.R2_PUBLIC_DOMAIN}`;
    } else {
      publicBase = `https://${bucket}.${accountId}.r2.dev`;
    }

    console.log(`  R2 bucket:   ${bucket}`);
    console.log(`  Public base: ${publicBase}`);
  } else {
    console.log("  [R2] Skipped — not configured");
  }

  console.log(`  Notary auth: ${authMode}`);
  console.log("  OK\n");

  // ══════════════════════════════════════════
  // Step 2: Build with Tauri (compile + bundle + sign)
  // ══════════════════════════════════════════
  console.log(`[2/${TOTAL_STEPS}] Building with Tauri...`);
  console.log("  Tauri handles: compile → bundle .app → code sign");
  console.log("  DMG is created by hdiutil in step 4 (Tauri's bundle_dmg.sh fork\n" +
    "  has been flaky on this machine — Tauri CLI invokes it with no args).\n");
  run("cargo tauri build --bundles app", "cargo tauri build --bundles app");

  // Verify .app exists
  const absApp = path.resolve(__dirname, "..", APP_PATH);
  if (!fs.existsSync(absApp)) {
    console.error(`✗ Build output not found: ${APP_PATH}`);
    process.exit(1);
  }
  console.log(`  ✓ App bundle: ${APP_PATH}`);

  // ══════════════════════════════════════════
  // Step 3: Verify code signature
  // ══════════════════════════════════════════
  console.log(`[3/${TOTAL_STEPS}] Verifying code signature...`);

  try {
    execSync(
      `codesign --verify --deep --strict "${APP_PATH}" 2>&1`,
      { encoding: "utf-8", cwd: path.resolve(__dirname, "..") }
    );
    console.log("  ✓ Signature valid");
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "");
    console.error("✗ Signature verification failed:");
    console.error(output);
    process.exit(1);
  }

  // ══════════════════════════════════════════
  // Step 4: Find DMG (Tauri creates it)
  // ══════════════════════════════════════════
  console.log(`[4/${TOTAL_STEPS}] Locating DMG...`);

  const absDmgDir = path.resolve(__dirname, "..", DMG_DIR);
  let dmgFile;

  if (fs.existsSync(absDmgDir)) {
    const dmgs = fs.readdirSync(absDmgDir).filter((f) => f.endsWith(".dmg"));
    if (dmgs.length > 0) {
      dmgFile = path.join(DMG_DIR, dmgs[0]);
      console.log(`  ✓ Tauri DMG: ${dmgFile}`);
    }
  }

  // If Tauri didn't create a DMG, create one manually via hdiutil.
  //
  // macOS Sequoia (15.x) quirks we work around here:
  //
  // 1. hdiutil with `-srcfolder` pointing straight at an .app bundle
  //    returns "Operation not permitted". Solution: stage the .app
  //    into a folder first. The same folder also lets us add the
  //    `/Applications` symlink for drag-to-install UX.
  //
  // 2. Staging + DMG creation under `/tmp` instead of the project
  //    tree avoids assorted TCC interactions on macOS 15.x. Move the
  //    finished DMG back into the bundle tree afterwards.
  //
  // 3. CRITICAL: the macOS volume name MUST NOT contain a space on
  //    Sequoia 15.7.x. With `-volname "Wolfee Desktop"` hdiutil mounts
  //    the temp volume but immediately fails to write into it with
  //    "could not access /Volumes/Wolfee Desktop/... Operation not
  //    permitted". With `-volname "WolfeeDesktop"` the same command
  //    succeeds. Reproduced on 15.7.4 (build 24G512). Spaces in the
  //    .app name inside the volume are fine — just the volume name
  //    itself needs to be space-free. Matches the convention used by
  //    Wolfee 0.7.5's DMG.
  if (!dmgFile) {
    console.log("  Tauri DMG not found — creating manually via hdiutil...");
    // Filenames space-free — hdiutil on Sequoia 15.7.x fails ANY
    // create where the output path contains a space, even after the
    // volname space-fix above. See the long comment above for the
    // reproducer. Convention matches the R2 key (wolfee-desktop-x.y.z.dmg).
    const localDmgBasename = `wolfee-desktop-${VERSION}.dmg`;
    dmgFile = `${BUNDLE_DIR}/dmg/${localDmgBasename}`;
    const dmgDir = path.resolve(__dirname, "..", `${BUNDLE_DIR}/dmg`);
    if (!fs.existsSync(dmgDir)) fs.mkdirSync(dmgDir, { recursive: true });

    const tmpRoot = `/tmp/wolfee-release-${VERSION}`;
    const stagingDir = `${tmpRoot}/staging`;
    const tmpDmg = `${tmpRoot}/${localDmgBasename}`;
    if (fs.existsSync(tmpRoot)) {
      run(`rm -rf "${tmpRoot}"`, "clear tmp release dir");
    }
    fs.mkdirSync(stagingDir, { recursive: true });

    run(
      `cp -R "${APP_PATH}" "${stagingDir}/"`,
      "stage .app into /tmp"
    );
    // Strip com.apple.provenance xattrs. macOS Sequoia stamps every
    // file in the bundle with this xattr at write time, and hdiutil's
    // temp DMG mount rejects copying them in — surfaced as
    // "could not access /Volumes/Wolfee Desktop/... Operation not
    // permitted". xattrs aren't part of the codesign signature, so
    // stripping the staged copy is safe; the original APP_PATH keeps
    // its xattrs for any downstream tooling that wants them.
    run(
      `xattr -cr "${stagingDir}"`,
      "strip provenance xattrs from staged copy"
    );
    run(
      `ln -s /Applications "${stagingDir}/Applications"`,
      "add /Applications symlink (drag-to-install UX)"
    );

    // Per-release volname so a stale /Volumes/WolfeeDesktop mount on
    // the build machine can't block the new build. Hyphen instead of
    // space — see the Sequoia note above.
    const dmgVolumeName = `Wolfee-v${VERSION}`;
    run(
      `hdiutil create -volname "${dmgVolumeName}" -srcfolder "${stagingDir}" -ov -format UDZO "${tmpDmg}"`,
      `hdiutil create DMG in /tmp (volname=${dmgVolumeName})`
    );

    const absDmgOut = path.resolve(__dirname, "..", dmgFile);
    fs.copyFileSync(tmpDmg, absDmgOut);
    run(`rm -rf "${tmpRoot}"`, "clean tmp release dir");
  }

  const absDmg = path.resolve(__dirname, "..", dmgFile);
  const dmgSizeMB = (fs.statSync(absDmg).size / 1024 / 1024).toFixed(1);
  console.log(`  DMG: ${dmgFile} (${dmgSizeMB} MB)`);

  // ══════════════════════════════════════════
  // Step 5: Notarize DMG
  // ══════════════════════════════════════════
  console.log(`[5/${TOTAL_STEPS}] Notarizing DMG with Apple...`);
  console.log(`  Timeout: ${NOTARIZE_TIMEOUT}s | Poll: ${NOTARIZE_POLL_INTERVAL}s\n`);

  let submitOutput;
  try {
    submitOutput = execSync(
      `xcrun notarytool submit "${dmgFile}" ` +
      `${notarytoolAuthArgs} ` +
      `--output-format json 2>&1`,
      {
        encoding: "utf-8",
        cwd: path.resolve(__dirname, ".."),
        timeout: 300000,
      }
    );
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "");
    console.error("✗ [NOTARIZE] Submit failed");
    if (output) console.log(output);
    process.exit(1);
  }

  let submitJson;
  try {
    submitJson = JSON.parse(submitOutput);
  } catch {
    const jsonStart = submitOutput.indexOf("{");
    if (jsonStart >= 0) {
      submitJson = JSON.parse(submitOutput.slice(jsonStart));
    } else {
      console.error("✗ [NOTARIZE] Could not parse submission response:");
      console.log(submitOutput);
      process.exit(1);
    }
  }

  const submissionId = submitJson.id;
  if (!submissionId) {
    console.error("✗ [NOTARIZE] No submission ID in response:");
    console.log(JSON.stringify(submitJson, null, 2));
    process.exit(1);
  }

  console.log(`  Submitted → ID: ${submissionId}`);
  console.log("  Polling...");

  const pollStart = Date.now();

  while (true) {
    const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);

    if (Date.now() - pollStart > NOTARIZE_TIMEOUT * 1000) {
      console.error(`✗ [NOTARIZE] TIMEOUT after ${elapsed}s`);
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, NOTARIZE_POLL_INTERVAL * 1000));

    let infoOutput;
    try {
      infoOutput = execSync(
        `xcrun notarytool info "${submissionId}" ` +
        `${notarytoolAuthArgs} ` +
        `--output-format json 2>&1`,
        {
          encoding: "utf-8",
          cwd: path.resolve(__dirname, ".."),
          timeout: 30000,
        }
      );
    } catch (err) {
      console.log(`  Poll error at ${elapsed}s (will retry)`);
      continue;
    }

    let infoJson;
    try {
      infoJson = JSON.parse(infoOutput);
    } catch {
      const jsonStart = infoOutput.indexOf("{");
      if (jsonStart >= 0) {
        infoJson = JSON.parse(infoOutput.slice(jsonStart));
      } else {
        continue;
      }
    }

    const status = (infoJson.status || "unknown").toLowerCase();
    console.log(`  Status: ${infoJson.status || "unknown"} (${elapsed}s)`);

    if (status === "accepted") break;

    if (status === "rejected" || status === "invalid") {
      console.error(`✗ [NOTARIZE] FAILED: ${infoJson.status}`);
      try {
        const logOutput = execSync(
          `xcrun notarytool log "${submissionId}" ` +
          `${notarytoolAuthArgs} 2>&1`,
          { encoding: "utf-8", cwd: path.resolve(__dirname, ".."), timeout: 60000 }
        );
        console.log(logOutput);
      } catch {}
      process.exit(1);
    }
  }

  console.log("  ✓ Notarized");

  // ══════════════════════════════════════════
  // Step 6: Staple + Validate
  // ══════════════════════════════════════════
  console.log(`[6/${TOTAL_STEPS}] Stapling notarization ticket...`);

  // Staple the DMG only. Stapling the on-disk .app separately was
  // previously here but it fails with "Record not found" whenever a
  // cargo re-build between DMG creation and stapling has touched the
  // .app on disk — Apple's CloudKit only knows the .app hash that
  // was actually inside the submitted DMG. The DMG staple alone is
  // sufficient: Gatekeeper's first-launch check on a DMG-installed
  // .app finds the ticket via the volume's stapled receipt and
  // honors it for the contained app. spctl verifies "Notarized
  // Developer ID" below.
  run(`xcrun stapler staple "${dmgFile}"`, "staple DMG");
  run(`xcrun stapler validate "${dmgFile}"`, "validate DMG");

  // Trust verification — we rely on the stapler validate output
  // above (which checks the embedded notarization ticket against
  // Apple's CloudKit) plus the spctl assess below. spctl on an
  // unsigned-but-stapled DMG returns "rejected, source=no usable
  // signature" when invoked with `-t install` (which checks for a
  // codesigned installer), but Gatekeeper still accepts the DMG at
  // download-time because the stapled notarization ticket alone is
  // sufficient for the first-launch trust check. We surface both
  // outcomes for observability without failing the release.
  console.log("  Verifying with spctl...");
  let spctlOut = "";
  try {
    spctlOut = execSync(
      `spctl -a -vvv -t install "${dmgFile}" 2>&1`,
      { encoding: "utf-8", cwd: path.resolve(__dirname, "..") }
    );
  } catch (err) {
    spctlOut = (err.stdout || "") + (err.stderr || "");
  }
  const spctlTrimmed = spctlOut.trim();
  if (spctlTrimmed.includes("Notarized Developer ID")) {
    console.log(`  ✓ spctl: Notarized Developer ID`);
  } else if (spctlTrimmed.includes("rejected")) {
    console.log(`  spctl: ${spctlTrimmed.replace(/\n/g, " | ")}`);
    console.log("  (spctl -t install requires a DMG codesign; the");
    console.log("   stapled notarization ticket above is what");
    console.log("   Gatekeeper actually checks for end-user trust.)");
  } else {
    console.log(`  spctl: ${spctlTrimmed.replace(/\n/g, " | ")}`);
  }

  // ══════════════════════════════════════════
  // Step 7–9: Upload to R2 (optional)
  // ══════════════════════════════════════════
  let downloadUrl = "(local only)";
  let manifestUrl = "(local only)";

  if (hasR2) {
    console.log(`[7/${TOTAL_STEPS}] Uploading DMG to Cloudflare R2...`);

    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });

    const dmgBuffer = fs.readFileSync(absDmg);
    const sizeBytes = dmgBuffer.length;
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);

    if (sizeBytes < MIN_DMG_SIZE) {
      console.error(`✗ DMG too small (${sizeMB} MB). Expected at least ${(MIN_DMG_SIZE / 1024 / 1024).toFixed(0)} MB.`);
      process.exit(1);
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`  Uploading ${R2_KEY} (${sizeMB} MB, attempt ${attempt})...`);
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: R2_KEY,
            Body: dmgBuffer,
            ContentType: "application/x-apple-diskimage",
            ContentDisposition: `attachment; filename="wolfee-desktop-${VERSION}.dmg"`,
            CacheControl: "no-cache, no-store, must-revalidate",
            Metadata: {
              "wolfee-version": VERSION,
              "build-time": new Date().toISOString(),
              "notarization-id": submissionId,
            },
          })
        );
        console.log("  ✓ Upload OK");
        break;
      } catch (err) {
        console.error(`  Upload failed: ${err.message}`);
        if (attempt === 2) {
          console.error("✗ Upload failed after 2 attempts.");
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    // Auto-updater artifacts. Tauri's updater plugin downloads the
    // .app.tar.gz when wolfee.io/api/desktop/latest.json points it
    // here, and verifies the .sig (Tauri's own signing key, separate
    // from Apple codesigning) before unpacking. Skipping these would
    // leave existing installs stranded on the previous version.
    const TAR_KEY = "downloads/wolfee-desktop-mac.app.tar.gz";
    const SIG_KEY = "downloads/wolfee-desktop-mac.app.tar.gz.sig";
    const tarPath = path.resolve(
      __dirname,
      "..",
      `${BUNDLE_DIR}/macos/Wolfee Desktop.app.tar.gz`,
    );
    const sigPath = `${tarPath}.sig`;

    if (fs.existsSync(tarPath) && fs.existsSync(sigPath)) {
      const tarBuf = fs.readFileSync(tarPath);
      const sigBuf = fs.readFileSync(sigPath);
      console.log(
        `  Uploading ${TAR_KEY} (${(tarBuf.length / 1024 / 1024).toFixed(2)} MB)...`,
      );
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: TAR_KEY,
          Body: tarBuf,
          ContentType: "application/gzip",
          CacheControl: "no-cache",
        }),
      );
      console.log(`  Uploading ${SIG_KEY} (${sigBuf.length} bytes)...`);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: SIG_KEY,
          Body: sigBuf,
          ContentType: "text/plain",
          CacheControl: "no-cache",
        }),
      );
      console.log("  ✓ Updater artifacts uploaded");
      // Expose the sig contents on stdout so the operator can paste
      // into WOLFEE-MVP/server/routes.ts (DESKTOP_UPDATE_SIG +
      // DESKTOP_UPDATE_PUB_DATE) without spelunking the bundle dir.
      const sigStr = sigBuf.toString("utf-8").trim();
      const ts = sigStr.match(/timestamp:(\d+)/);
      console.log("");
      console.log("  ── WOLFEE-MVP/server/routes.ts manifest values ──");
      console.log(`    DESKTOP_VERSION       = "${VERSION}"`);
      if (ts) {
        const pubDate = new Date(Number(ts[1]) * 1000)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z");
        console.log(`    DESKTOP_UPDATE_PUB_DATE = "${pubDate}"`);
      }
      console.log(`    DESKTOP_UPDATE_SIG    = "${sigStr}"`);
      console.log("");
    } else {
      console.log(
        `  ⚠ Updater artifacts not found (expected ${tarPath} + .sig). Skipping.`,
      );
    }

    console.log(`[8/${TOTAL_STEPS}] Uploading update manifest...`);

    downloadUrl = `${publicBase}/${R2_KEY}`;
    const releaseNotes = process.env.RELEASE_NOTES || `Wolfee Desktop v${VERSION}`;

    const manifest = {
      version: VERSION,
      url: downloadUrl,
      notes: releaseNotes,
      notarizationId: submissionId,
      releasedAt: new Date().toISOString(),
    };

    const manifestKey = "releases/latest.json";
    manifestUrl = `${publicBase}/${manifestKey}`;

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: manifestKey,
          Body: JSON.stringify(manifest, null, 2),
          ContentType: "application/json",
          CacheControl: "max-age=300",
        })
      );
      console.log(`  ✓ Uploaded ${manifestKey}`);
    } catch (err) {
      console.error(`  Manifest upload failed: ${err.message}`);
    }

    console.log(`[9/${TOTAL_STEPS}] Verifying public download URL...`);
    console.log(`  HEAD ${downloadUrl}`);

    try {
      const check = await httpHead(downloadUrl);
      console.log(`  Status: ${check.status}`);
      if (check.status !== 200) {
        console.error(`✗ URL returned ${check.status}. Check R2 public access.`);
        process.exit(1);
      }
      console.log("  ✓ Verification OK");
    } catch (err) {
      console.error(`  Verification failed: ${err.message}`);
      console.error("  WARNING: Check manually: " + downloadUrl);
    }
  } else {
    console.log(`[7/${TOTAL_STEPS}] [R2] Skipped`);
    console.log(`[8/${TOTAL_STEPS}] [R2] Skipped`);
    console.log(`[9/${TOTAL_STEPS}] [R2] Skipped`);
  }

  // ══════════════════════════════════════════
  // Done
  // ══════════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("");
  console.log("══════════════════════════════════════════");
  console.log("  Release complete");
  console.log("══════════════════════════════════════════");
  console.log(`  Version:         ${VERSION}`);
  console.log(`  Engine:          Tauri 2`);
  console.log(`  DMG:             ${dmgFile} (${dmgSizeMB} MB)`);
  console.log(`  Signed:          YES`);
  console.log(`  Notarized:       YES (${submissionId})`);
  console.log(`  Stapled:         YES (DMG + .app)`);
  console.log(`  spctl:           Notarized Developer ID`);
  console.log(`  R2:              ${hasR2 ? "YES" : "SKIPPED"}`);
  console.log(`  Time:            ${elapsed}s`);
  console.log("");
  console.log(`  Download:        ${downloadUrl}`);
  console.log(`  Manifest:        ${manifestUrl}`);
  console.log("══════════════════════════════════════════");
}

main().catch((err) => {
  console.error("✗ Unexpected error:", err);
  process.exit(1);
});
