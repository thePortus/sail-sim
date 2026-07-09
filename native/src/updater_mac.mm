// macOS auto-updater: start Sparkle. Compiled only for the .app-bundle build (SAILSIM_SPARKLE), with ARC.
#include "updater.hpp"

#import <Sparkle/Sparkle.h>

namespace updater {

// App-lifetime strong reference (ARC). File scope so checkNow() can reach it.
static SPUStandardUpdaterController* g_controller = nil;

void start() {
  // initWithStartingUpdater:YES reads SUFeedURL + SUPublicEDKey from the bundle Info.plist and begins Sparkle's
  // automatic update checks (first launch asks the user whether to auto-check; thereafter it polls on schedule).
  if (g_controller) return;
  g_controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:YES
                                                             updaterDelegate:nil
                                                          userDriverDelegate:nil];
}

void checkNow() {
  // User-initiated check with Sparkle's standard UI (bypasses the automatic schedule).
  if (g_controller) [g_controller checkForUpdates:nil];
}

}  // namespace updater
