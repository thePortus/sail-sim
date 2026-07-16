// Auto-updater entry point. macOS .app-bundle builds start Sparkle (which reads SUFeedURL + SUPublicEDKey from
// the Info.plist, polls the appcast, verifies the Ed25519 signature, and self-installs); every other build is a
// no-op stub. Call once after the app/window is up. WinSparkle joins this same entry point in Phase 4.
#pragma once

namespace updater {
void start();
// User-triggered "Check for updates now" (Settings button). Shows the updater's own UI: up-to-date, an error,
// or the update prompt. Bypasses the once-a-day automatic throttle. No-op on the stub (dev/CI) build.
void checkNow();
}  // namespace updater
