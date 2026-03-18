# Wolfee Desktop — macOS Build & Distribution

## Prerequisites

### 1. Apple Developer Program
Enroll at https://developer.apple.com/programs/ ($99/year).
You need this for Developer ID distribution outside the App Store.

### 2. Developer ID Application Certificate
This is the certificate that signs your app for distribution.

**Create via Xcode:**
- Xcode → Settings → Accounts → your Apple ID
- Manage Certificates → "+" → "Developer ID Application"

**Or via developer.apple.com:**
- Certificates → "+" → Developer ID Application
- Download .cer → double-click to install in Keychain

### 3. Notarization Credentials

**Option A — App Store Connect API Key (recommended)**
- Go to https://appstoreconnect.apple.com/access/integrations/api
- Generate a new key with "Developer" role
- Download the .p8 file (one-time download)
- Note Key ID and Issuer ID

**Option B — Apple ID + App-Specific Password**
- Go to https://appleid.apple.com/account/manage
- Generate an app-specific password under "Sign-In and Security"

---

## Environment Variables

Set these before running `npm run dist`:

### Signing
```bash
# Auto-detected from Keychain, or set explicitly:
export CSC_NAME="Developer ID Application: XPAND TECHNOLOGY LLC (LT73Z72CKR)"

# If using exported .p12 file instead of Keychain:
# export CSC_LINK=./certs/wolfee-dev-id.p12
# export CSC_KEY_PASSWORD=your-password
```

### Notarization (Option A — API Key)
```bash
export APPLE_API_KEY="/absolute/path/to/AuthKey_XXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### Notarization (Option B — Apple ID)
```bash
export APPLE_ID="you@example.com"
export APPLE_ID_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="LT73Z72CKR"
```

---

## Build Commands

### Production build (signed + notarized)
```bash
npm run dist
```

### Local dev build (unsigned, for testing)
```bash
npm run dist:unsigned
```

### Verify build
```bash
npm run verify
```

---

## Output

```
release/
  Wolfee Desktop-0.1.0-arm64.dmg       # Installer
  Wolfee Desktop-0.1.0-arm64-mac.zip   # Auto-update artifact
  mac-arm64/
    Wolfee Desktop.app                  # Signed app
```

---

## Verification

After building, run:

```bash
# Check code signature
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Wolfee Desktop.app"

# Check Gatekeeper (must say "accepted")
spctl --assess --type exec --verbose "release/mac-arm64/Wolfee Desktop.app"

# Check notarization staple on DMG
stapler validate "release/Wolfee Desktop-0.1.0-arm64.dmg"
```

---

## Troubleshooting

**"No identity found for signing"**
→ Install Developer ID Application certificate in Keychain

**"Notarization failed"**
→ Check credentials are set correctly
→ Run `xcrun notarytool log <submission-id>` for details

**"App is damaged" on other Macs**
→ App wasn't notarized. Run `npm run dist` with credentials set.

**Local testing without certificate**
→ `xattr -cr "release/mac-arm64/Wolfee Desktop.app"` removes quarantine
