#!/usr/bin/env node

/**
 * Wolfee Desktop — Release Pipeline
 *
 * One-command: build → sign → notarize → staple → zip → upload.
 *
 * Required env vars:
 *   APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER
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

const APP_NAME = "Wolfee Desktop";
const APP_PATH = `release/mac-arm64/${APP_NAME}.app`;
const ZIP_NAME = "wolfee-desktop.zip";
const ZIP_PATH = `release/${ZIP_NAME}`;
const R2_KEY = `downloads/${ZIP_NAME}`;
const MIN_ZIP_SIZE = 50 * 1024 * 1024;
const NOTARIZE_TIMEOUT = 20 * 60; // 20 minutes — Apple can be slow

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

/** Run a command and return its stdout */
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
    // notarytool and spctl write to stderr, execSync throws on non-zero exit
    // but the output is still useful
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
  const pkg = require("../package.json");
  const TOTAL_STEPS = 11;

  console.log("══════════════════════════════════════════");
  console.log("  Wolfee Desktop — Release Pipeline");
  console.log("══════════════════════════════════════════");
  console.log(`  version: ${pkg.version}`);
  console.log(`  target:  macOS arm64`);
  console.log(`  steps:   ${TOTAL_STEPS}`);
  console.log("");

  // ══════════════════════════════════════════
  // Step 1: Validate env vars
  // ══════════════════════════════════════════
  console.log(`[1/${TOTAL_STEPS}] Validating environment...`);

  // Apple notarization (required)
  const appleApiKey = requireEnv("APPLE_API_KEY");
  const appleApiKeyId = requireEnv("APPLE_API_KEY_ID");
  const appleApiIssuer = requireEnv("APPLE_API_ISSUER");

  // R2 (optional — skipped if not configured)
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
    console.log("  [R2] Skipped — using GitHub Releases only");
  }

  console.log(`  API Key ID:  ${appleApiKeyId}`);
  console.log(`  API Issuer:  ${appleApiIssuer}`);
  console.log("  OK\n");

  // ══════════════════════════════════════════
  // Step 2: Clean + Build
  // ══════════════════════════════════════════
  console.log(`[2/${TOTAL_STEPS}] Building...`);
  run("rm -rf dist release", "Clean previous build");
  run("npm run build", "Compile TypeScript");

  // ══════════════════════════════════════════
  // Step 3: Package + Sign
  // ══════════════════════════════════════════
  console.log(`[3/${TOTAL_STEPS}] Packaging + signing...`);
  run("npx electron-builder --mac --arm64", "electron-builder");

  const absApp = path.resolve(__dirname, "..", APP_PATH);
  if (!fs.existsSync(absApp)) {
    console.error(`✗ Build output not found: ${APP_PATH}`);
    process.exit(1);
  }

  // ══════════════════════════════════════════
  // Step 4: Verify code signature
  // ══════════════════════════════════════════
  console.log(`[4/${TOTAL_STEPS}] Verifying code signature...`);
  run(`codesign --verify --deep --strict "${APP_PATH}"`, "codesign verify");
  console.log("  Signature OK");

  // ══════════════════════════════════════════
  // Step 5: Notarize (explicit xcrun notarytool — no library wrapper)
  // ══════════════════════════════════════════
  console.log(`[5/${TOTAL_STEPS}] Notarizing with Apple...`);
  console.log("  [NOTARIZE] Submitting to Apple...");
  console.log(`  [NOTARIZE] Timeout: ${NOTARIZE_TIMEOUT}s (${(NOTARIZE_TIMEOUT / 60).toFixed(0)} min)`);
  console.log(`  [NOTARIZE] App: ${APP_PATH}`);
  console.log("");

  // Create submission zip — more reliable than submitting .app directly
  const notarizeZip = path.resolve(__dirname, "..", "release", "notarize-submission.zip");
  run(
    `ditto -c -k --keepParent "${APP_PATH}" "release/notarize-submission.zip"`,
    "Create submission zip"
  );

  const notarizeCmd =
    `xcrun notarytool submit "release/notarize-submission.zip" ` +
    `--key "${appleApiKey}" ` +
    `--key-id "${appleApiKeyId}" ` +
    `--issuer "${appleApiIssuer}" ` +
    `--wait 2>&1`;

  let notarizeOutput;
  try {
    notarizeOutput = execSync(notarizeCmd, {
      encoding: "utf-8",
      cwd: path.resolve(__dirname, ".."),
      timeout: NOTARIZE_TIMEOUT * 1000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // execSync throws on non-zero exit OR timeout
    notarizeOutput = (err.stdout || "") + (err.stderr || "");
    if (err.killed) {
      console.error(`\n✗ [NOTARIZE] TIMEOUT after ${NOTARIZE_TIMEOUT}s — Apple did not respond in time`);
    } else {
      console.error(`\n✗ [NOTARIZE] Command failed (exit code ${err.status})`);
    }
    if (notarizeOutput) console.log(notarizeOutput);
    process.exit(1);
  }

  console.log(notarizeOutput);

  // Parse submission ID and status
  const idMatch = notarizeOutput.match(/id:\s*([0-9a-f-]+)/i);
  const statusMatch = notarizeOutput.match(/status:\s*(\w+)/i);
  const submissionId = idMatch ? idMatch[1] : "unknown";
  const notarizeStatus = statusMatch ? statusMatch[1] : "unknown";

  console.log(`  [NOTARIZE] Submission ID: ${submissionId}`);
  console.log(`  [NOTARIZE] Status: ${notarizeStatus}`);

  if (notarizeStatus.toLowerCase() !== "accepted") {
    console.error(`✗ [NOTARIZE] FAILED with status: ${notarizeStatus}`);
    console.error("  Fetching detailed log...\n");

    try {
      const logOutput = execSync(
        `xcrun notarytool log "${submissionId}" ` +
        `--key "${appleApiKey}" ` +
        `--key-id "${appleApiKeyId}" ` +
        `--issuer "${appleApiIssuer}" 2>&1`,
        { encoding: "utf-8", cwd: path.resolve(__dirname, ".."), timeout: 60000 }
      );
      console.log(logOutput);
    } catch (logErr) {
      console.error("  Could not fetch notarization log:", logErr.message);
    }

    process.exit(1);
  }

  console.log("  [NOTARIZE] Completed — ACCEPTED");

  // Clean up submission zip
  if (fs.existsSync(notarizeZip)) fs.unlinkSync(notarizeZip);

  // ══════════════════════════════════════════
  // Step 6: Staple + Validate
  // ══════════════════════════════════════════
  console.log(`[6/${TOTAL_STEPS}] Stapling notarization ticket...`);
  run(`xcrun stapler staple "${APP_PATH}"`, "stapler staple .app");
  run(`xcrun stapler validate "${APP_PATH}"`, "stapler validate .app");
  console.log("  Staple OK — validated");

  // ══════════════════════════════════════════
  // Step 7: Verify notarization via spctl
  // ══════════════════════════════════════════
  console.log(`[7/${TOTAL_STEPS}] Verifying Gatekeeper acceptance...`);

  try {
    const spctlOutput = execSync(
      `spctl --assess --type execute --verbose=2 "${APP_PATH}" 2>&1`,
      { encoding: "utf-8", cwd: path.resolve(__dirname, "..") }
    );
    console.log(`  ${spctlOutput.trim()}`);

    if (!spctlOutput.includes("accepted")) {
      console.error("✗ spctl did not return 'accepted'. App may not open cleanly for users.");
      process.exit(1);
    }
    console.log("  Gatekeeper: ACCEPTED");
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "");
    console.log(`  ${output.trim()}`);
    if (output.includes("accepted")) {
      console.log("  Gatekeeper: ACCEPTED");
    } else {
      console.error("✗ spctl verification failed. App will be blocked by Gatekeeper.");
      process.exit(1);
    }
  }

  // ══════════════════════════════════════════
  // Step 7b: Re-create DMG with stapled app + staple the DMG itself
  // ══════════════════════════════════════════
  console.log(`[7b/${TOTAL_STEPS}] Re-creating DMG with stapled app...`);

  // Remove the stale DMG that electron-builder created before notarization
  const dmgGlob = fs.readdirSync(path.resolve(__dirname, "..", "release"))
    .filter((f) => f.endsWith(".dmg"));
  for (const dmg of dmgGlob) {
    fs.unlinkSync(path.resolve(__dirname, "..", "release", dmg));
  }

  // Create fresh DMG from the notarized+stapled .app
  const dmgName = `Wolfee Desktop-${pkg.version}-arm64.dmg`;
  const DMG_PATH = `release/${dmgName}`;
  run(
    `hdiutil create -volname "Wolfee Desktop" -srcfolder "${APP_PATH}" -ov -format UDZO "${DMG_PATH}"`,
    "hdiutil create DMG"
  );

  // Staple the DMG itself (so offline Gatekeeper checks pass on the DMG too)
  run(`xcrun stapler staple "${DMG_PATH}"`, "stapler staple DMG");
  console.log("  DMG stapled OK");

  // ══════════════════════════════════════════
  // Step 8: Create distribution zip (with stapled ticket)
  // ══════════════════════════════════════════
  console.log(`[8/${TOTAL_STEPS}] Creating distribution zip...`);
  const absZip = path.resolve(__dirname, "..", ZIP_PATH);
  if (fs.existsSync(absZip)) fs.unlinkSync(absZip);

  run(
    `ditto -c -k --keepParent "${APP_PATH}" "${ZIP_PATH}"`,
    "ditto zip (notarized + stapled)"
  );

  const zipStat = fs.statSync(absZip);
  const sizeBytes = zipStat.size;
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
  console.log(`  Zip size: ${sizeMB} MB`);

  if (sizeBytes < MIN_ZIP_SIZE) {
    console.error(`✗ Zip too small (${sizeMB} MB). Expected at least ${(MIN_ZIP_SIZE / 1024 / 1024).toFixed(0)} MB.`);
    process.exit(1);
  }

  // ══════════════════════════════════════════
  // Step 9–11: Upload to R2 (optional)
  // ══════════════════════════════════════════
  let downloadUrl = "(GitHub Releases)";
  let manifestUrl = "(GitHub Releases)";

  if (hasR2) {
    console.log(`[9/${TOTAL_STEPS}] Uploading zip to Cloudflare R2...`);

    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });

    const zipBuffer = fs.readFileSync(absZip);

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`  Uploading ${R2_KEY} (${sizeMB} MB, attempt ${attempt})...`);
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: R2_KEY,
            Body: zipBuffer,
            ContentType: "application/zip",
            ContentDisposition: `attachment; filename="wolfee-desktop-${pkg.version}.zip"`,
            CacheControl: "no-cache, no-store, must-revalidate",
            Metadata: {
              "wolfee-version": pkg.version,
              "build-time": new Date().toISOString(),
              "notarization-id": submissionId,
            },
          })
        );
        console.log("  Upload OK");
        break;
      } catch (err) {
        console.error(`  Upload failed: ${err.message}`);
        if (attempt === 2) {
          console.error("✗ Upload failed after 2 attempts. Aborting.");
          process.exit(1);
        }
        console.log("  Retrying in 3s...");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    console.log(`[10/${TOTAL_STEPS}] Uploading update manifest...`);

    downloadUrl = `${publicBase}/${R2_KEY}`;
    const releaseNotes = process.env.RELEASE_NOTES || `Wolfee Desktop v${pkg.version}`;

    const manifest = {
      version: pkg.version,
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
      console.log(`  Uploaded ${manifestKey}`);
    } catch (err) {
      console.error(`  Manifest upload failed: ${err.message}`);
      console.error("  WARNING: Zip uploaded but manifest failed.");
    }

    console.log(`[11/${TOTAL_STEPS}] Verifying public download URL...`);
    console.log(`  HEAD ${downloadUrl}`);

    try {
      const check = await httpHead(downloadUrl);
      console.log(`  Status: ${check.status}`);
      console.log(`  Content-Length: ${check.contentLength} bytes`);

      if (check.status !== 200) {
        console.error(`✗ URL returned ${check.status}. Check R2 public access.`);
        process.exit(1);
      }

      if (check.contentLength > 0 && Math.abs(check.contentLength - sizeBytes) > 1024) {
        console.error(`✗ Size mismatch: uploaded ${sizeBytes}, URL reports ${check.contentLength}`);
        process.exit(1);
      }
      console.log("  Verification OK");
    } catch (err) {
      console.error(`  Verification failed: ${err.message}`);
      console.error("  WARNING: Could not verify URL. Check manually: " + downloadUrl);
    }
  } else {
    console.log(`[9/${TOTAL_STEPS}] [R2] Skipped — not configured`);
    console.log(`[10/${TOTAL_STEPS}] [R2] Skipped — not configured`);
    console.log(`[11/${TOTAL_STEPS}] [R2] Skipped — using GitHub Releases only`);
  }

  // ══════════════════════════════════════════
  // Done
  // ══════════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("");
  console.log("══════════════════════════════════════════");
  console.log("  Release complete");
  console.log("══════════════════════════════════════════");
  console.log(`  Version:         ${pkg.version}`);
  console.log(`  Zip:             ${ZIP_PATH} (${sizeMB} MB)`);
  console.log(`  Signed:          YES`);
  console.log(`  Notarized:       YES (${submissionId})`);
  console.log(`  Stapled:         YES`);
  console.log(`  Gatekeeper:      ACCEPTED`);
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
