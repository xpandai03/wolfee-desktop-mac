/**
 * electron-builder afterSign hook.
 *
 * DISABLED: Notarization is now handled explicitly by release.js using
 * `xcrun notarytool submit --wait` for reliability in CI.
 *
 * This file is kept as a no-op so electron-builder doesn't error if
 * afterSign is re-enabled in electron-builder.yml.
 */
exports.default = async function notarizing(_context) {
  console.log("[Notarize] afterSign hook skipped — notarization handled by release.js");
};
