// macOS auto-updater: start Sparkle. Compiled only for the .app-bundle build (SAILSIM_SPARKLE), with ARC.
#include "updater.hpp"

#import <Sparkle/Sparkle.h>

namespace updater {

void start() {
  // Held for the app's lifetime (ARC keeps this global strong reference alive). initWithStartingUpdater:YES
  // reads SUFeedURL + SUPublicEDKey from the bundle Info.plist and begins Sparkle's automatic update checks
  // (first launch asks the user whether to auto-check; thereafter it polls on Sparkle's schedule).
  static SPUStandardUpdaterController* controller = nil;
  if (controller) return;
  controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:YES
                                                            updaterDelegate:nil
                                                         userDriverDelegate:nil];
}

}  // namespace updater
