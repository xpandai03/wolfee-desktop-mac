#!/usr/bin/env node

/**
 * Wolfee Desktop — Tauri Release Pipeline
 *
 * One-command: build → sign → notarize → staple → upload.
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

const TAURI_CONF = require("../src-tauri/tauri.conf.json");
const VERSION = TAURI_CONF.version;
const APP_NAME = TAURI_CONF.productName;

// Tauri 2 bundle output paths
const BUNDLE_DIR = "src-tauri/target/release/bundle";
const APP_PATH = `${BUNDLE_DIR}/macos/${APP_NAME}.app`;
const DMG_DIR = `${BUNDLE_DIR}/dmg`;

const SIGNING_IDENTITY = "Developer ID Application: XPAND TECHNOLOGY LLC (LT73Z72CKR)";
const DMG_NAME = `wolfee-desktop.dmg`;
const R2_KEY = `downloads/${DMG_NAME}`;
const MIN_DMG_SIZE = 10 * 1024 * 1024; // 10 MB min for Tauri app
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

  const appleApiKey = requireEnv("APPLE_API_KEY");
  const appleApiKeyId = requireEnv("APPLE_API_KEY_ID");
  const appleApiIssuer = requireEnv("APPLE_API_ISSUER");

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

  console.log(`  API Key ID:  ${appleApiKeyId}`);
  console.log(`  API Issuer:  ${appleApiIssuer}`);
  console.log("  OK\n");

  // ══════════════════════════════════════════
  // Step 2: Build with Tauri (compile + bundle + sign)
  // ══════════════════════════════════════════
  console.log(`[2/${TOTAL_STEPS}] Building with Tauri...`);
  console.log("  Tauri handles: compile → bundle .app → code sign → create DMG\n");
  run("cargo tauri build", "cargo tauri build");

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

  // If Tauri didn't create a DMG, create one manually
  if (!dmgFile) {
    console.log("  Tauri DMG not found — creating manually...");
    dmgFile = `${BUNDLE_DIR}/dmg/${APP_NAME}-${VERSION}.dmg`;
    const dmgDir = path.resolve(__dirname, "..", `${BUNDLE_DIR}/dmg`);
    if (!fs.existsSync(dmgDir)) fs.mkdirSync(dmgDir, { recursive: true });
    run(
      `hdiutil create -volname "${APP_NAME}" -srcfolder "${APP_PATH}" -ov -format UDZO "${dmgFile}"`,
      "hdiutil create DMG"
    );
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
      `--key "${appleApiKey}" ` +
      `--key-id "${appleApiKeyId}" ` +
      `--issuer "${appleApiIssuer}" ` +
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
        `--key "${appleApiKey}" ` +
        `--key-id "${appleApiKeyId}" ` +
        `--issuer "${appleApiIssuer}" ` +
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
          `--key "${appleApiKey}" ` +
          `--key-id "${appleApiKeyId}" ` +
          `--issuer "${appleApiIssuer}" 2>&1`,
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

  run(`xcrun stapler staple "${APP_PATH}"`, "staple .app");
  run(`xcrun stapler staple "${dmgFile}"`, "staple DMG");
  run(`xcrun stapler validate "${dmgFile}"`, "validate DMG");

  // Verify with spctl
  console.log("  Verifying with spctl...");
  try {
    const spctlOut = execSync(
      `spctl -a -vvv -t install "${dmgFile}" 2>&1`,
      { encoding: "utf-8", cwd: path.resolve(__dirname, "..") }
    );
    console.log(`  ${spctlOut.trim()}`);
    if (!spctlOut.includes("Notarized Developer ID")) {
      console.error("✗ DMG is NOT notarized according to spctl");
      process.exit(1);
    }
    console.log("  ✓ spctl: Notarized Developer ID");
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "");
    if (output && output.includes("Notarized Developer ID")) {
      console.log("  ✓ spctl: Notarized Developer ID");
    } else {
      console.error("✗ spctl verification failed:");
      if (output) console.error(output);
      process.exit(1);
    }
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
