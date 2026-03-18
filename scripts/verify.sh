#!/bin/bash
# Verify macOS app signing and notarization
set -e

APP_PATH="release/mac-arm64/Wolfee Desktop.app"
DMG_PATH=$(ls release/Wolfee\ Desktop-*-arm64.dmg 2>/dev/null | head -1)

echo "=== Wolfee Desktop Build Verification ==="
echo ""

# 1. Check codesign
echo "--- Code Signature ---"
codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1
echo ""

# 2. Check signing identity
echo "--- Signing Identity ---"
codesign -dvv "$APP_PATH" 2>&1 | grep -E "(Authority|TeamIdentifier|Identifier)"
echo ""

# 3. Check entitlements
echo "--- Entitlements ---"
codesign -d --entitlements - "$APP_PATH" 2>&1 | grep -E "(Key|Bool)" | head -20
echo ""

# 4. Gatekeeper assessment
echo "--- Gatekeeper Assessment ---"
spctl --assess --type exec --verbose "$APP_PATH" 2>&1 || echo "(FAILED — needs Developer ID Application certificate + notarization)"
echo ""

# 5. Check notarization staple
echo "--- Notarization Staple ---"
if [ -n "$DMG_PATH" ]; then
  stapler validate "$DMG_PATH" 2>&1 || echo "(Not stapled — notarization may not have run)"
else
  echo "(No DMG found)"
fi
echo ""

echo "=== Verification Complete ==="
