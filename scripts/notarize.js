const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== "darwin") {
    console.log("[Notarize] Skipping — not macOS");
    return;
  }

  // Skip if no credentials configured
  const hasApiKey = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
  const hasAppleId = process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID;

  if (!hasApiKey && !hasAppleId) {
    // In CI, missing credentials is a hard error — we must notarize.
    // Locally, skip silently so `npm run dist:unsigned` still works.
    if (process.env.CI) {
      throw new Error(
        "[Notarize] FATAL: No Apple credentials set in CI. " +
        "Set APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER secrets."
      );
    }
    console.log("[Notarize] Skipping — no Apple credentials set (local build)");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[Notarize] Notarizing ${appPath}...`);

  const options = {
    appPath,
    tool: "notarytool",
  };

  if (hasApiKey) {
    options.appleApiKey = process.env.APPLE_API_KEY;
    options.appleApiKeyId = process.env.APPLE_API_KEY_ID;
    options.appleApiIssuer = process.env.APPLE_API_ISSUER;
    console.log("[Notarize] Using App Store Connect API key auth");
  } else {
    options.appleId = process.env.APPLE_ID;
    options.appleIdPassword = process.env.APPLE_ID_PASSWORD;
    options.teamId = process.env.APPLE_TEAM_ID;
    console.log("[Notarize] Using Apple ID auth");
  }

  try {
    await notarize(options);
    console.log("[Notarize] Notarization complete!");
  } catch (err) {
    console.error("[Notarize] Notarization failed:", err.message);
    throw err;
  }
};
