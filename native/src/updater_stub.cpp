// No-op auto-updater for builds without an integrated updater (bare dev/CI executable, and — until Phase 4 —
// Windows). The macOS .app bundle swaps in updater_mac.mm (Sparkle) instead.
#include "updater.hpp"

namespace updater {
void start() {}
}  // namespace updater
