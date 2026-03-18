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
    console.log("[Notarize] Skipping — no Apple credentials set");
    console.log("[Notarize] Set APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER for API key auth");
    console.log("[Notarize] Or set APPLE_ID/APPLE_ID_PASSWORD/APPLE_TEAM_ID for Apple ID auth");
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
