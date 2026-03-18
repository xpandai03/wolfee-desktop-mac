#!/usr/bin/env node

/**
 * Quick upload of the beta zip to R2.
 *
 * Usage:
 *   export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=...
 *   node scripts/upload-beta.js
 */

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");
const https = require("https");

const ZIP_PATH = path.resolve(__dirname, "..", "release", "wolfee-desktop.zip");
const R2_KEY = "downloads/wolfee-desktop.zip";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing: ${name}`);
    console.error(`Run: export ${name}=...`);
    process.exit(1);
  }
  return val;
}

async function main() {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const bucket = requireEnv("R2_BUCKET");

  if (!fs.existsSync(ZIP_PATH)) {
    console.error(`Zip not found: ${ZIP_PATH}`);
    console.error("Run: npm run build && npx electron-builder --mac --arm64");
    process.exit(1);
  }

  const pkg = require("../package.json");
  const zipBuffer = fs.readFileSync(ZIP_PATH);
  const sizeMB = (zipBuffer.length / 1024 / 1024).toFixed(1);

  console.log(`Uploading v${pkg.version} (${sizeMB} MB) to R2...`);

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  // Upload zip
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
      },
    })
  );
  console.log(`Uploaded: ${R2_KEY}`);

  // Upload manifest
  const publicBase = `https://pub-cc4f334f693243388ee3ef32a86c9368.r2.dev`;
  const manifest = {
    version: pkg.version,
    url: `${publicBase}/${R2_KEY}`,
    notes: `Recording widget + state machine`,
    releasedAt: new Date().toISOString(),
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "releases/latest.json",
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
      CacheControl: "max-age=300",
    })
  );
  console.log(`Uploaded: releases/latest.json`);

  // Verify
  const downloadUrl = `${publicBase}/${R2_KEY}`;
  console.log(`\nDownload URL: ${downloadUrl}`);
  console.log(`Version: ${pkg.version}`);
  console.log("\nDone. Verify with:");
  console.log(`  curl -sI "${downloadUrl}" | head -5`);
}

main().catch((err) => {
  console.error("Upload failed:", err.message);
  process.exit(1);
});
