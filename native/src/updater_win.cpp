// Windows auto-updater: start WinSparkle. Compiled only for the Windows build (SAILSIM_WINSPARKLE). WinSparkle
// shares Sparkle's appcast format + Ed25519 signatures, so the same signing key covers both platforms.
#include "updater.hpp"

#include <string>

#include <winsparkle.h>

namespace updater {

void start() {
  // Configure BEFORE win_sparkle_init(): the Windows appcast feed and the Ed25519 public key that signed the
  // updates (same key as macOS). set_app_details wants wide strings; the ASCII version widens cleanly.
  win_sparkle_set_appcast_url(SAILSIM_SPARKLE_FEED_URL_WIN);
  win_sparkle_set_eddsa_public_key(SAILSIM_SPARKLE_PUBKEY);
  const std::string ver = SAILSIM_VERSION;
  win_sparkle_set_app_details(L"thePortus", L"Sail-Sim", std::wstring(ver.begin(), ver.end()).c_str());
  // Starts WinSparkle's background update checks (reads the config above; polls on its schedule).
  win_sparkle_init();
}

}  // namespace updater
