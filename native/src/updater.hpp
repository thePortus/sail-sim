// Auto-updater entry point. macOS .app-bundle builds start Sparkle (which reads SUFeedURL + SUPublicEDKey from
// the Info.plist, polls the appcast, verifies the Ed25519 signature, and self-installs); every other build is a
// no-op stub. Call once after the app/window is up. WinSparkle joins this same entry point in Phase 4.
#pragma once

namespace updater {
void start();
}  // namespace updater
