# Client release artifacts (`/client`)

This directory is served at **`/client`** and holds the native game client's auto-update feed and build
artifacts. Sparkle (macOS) and WinSparkle (Windows) poll the appcast here, download the enclosure, verify its
Ed25519 signature against the public key baked into the client, and self-update.

Everything here except this README is **generated** (and git-ignored) — produced by
[`server/scripts/client-release.js`](../../scripts/client-release.js):

```
appcast-mac.xml            # Sparkle feed (macOS)   — SUFeedURL in the .app's Info.plist
appcast-win.xml            # WinSparkle feed (Windows)
SailSim-<ver>-mac.zip      # zipped .app bundle (the enclosure)
SailSim-<ver>-win.zip      # zipped .exe / installer (the enclosure)
```

## One-time setup

```
node server/scripts/client-release.js keygen
```

Generates the Ed25519 update-signing keypair in `server/.sparkle/` (git-ignored — **back up the private key**;
losing it breaks updates for every installed client) and prints the **public key** to embed in the client
build (Phase 3/4: Info.plist `SUPublicEDKey` on macOS, `win_sparkle_set_eddsa_public_key` on Windows). This is
Sparkle's own update signature — separate from Apple notarization / Windows Authenticode code-signing.

## Publishing a build

```
node server/scripts/client-release.js publish \
  --platform mac --version 0.1.0 --file /path/to/SailSim-0.1.0-mac.zip \
  --base-url https://your.server/client --notes "What changed"
```

Copies the artifact in, signs it, and (re)writes `appcast-<platform>.xml` pointing at it. Run once per platform
per release.
