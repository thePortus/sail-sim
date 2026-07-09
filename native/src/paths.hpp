// Cross-platform application directories (config/data + cache), following each OS's convention so the client
// stores its state where users + an uninstaller expect it:
//   macOS   : ~/Library/Application Support/SailSim   +  ~/Library/Caches/SailSim
//   Windows : %APPDATA%\SailSim                        +  %LOCALAPPDATA%\SailSim\cache
//   Linux   : $XDG_CONFIG_HOME|~/.config/SailSim       +  $XDG_CACHE_HOME|~/.cache/SailSim
// Replaces the earlier ~/.sailsim_* dotfiles; migrateLegacy() moves any of those into place once, and wipeAll()
// deletes everything for the --uninstall path.
#pragma once

#include <string>

namespace paths {

// Persistent app data (settings, saved session token). Created on first use.
std::string dataDir();
// Disposable on-disk asset cache. Created on first use.
std::string cacheDir();
// Full path to a file under dataDir() (e.g. dataFile("settings.json")).
std::string dataFile(const std::string& name);

// One-time migration of legacy ~/.sailsim_settings|_session|_cache into the standard dirs. Idempotent and
// best-effort: a file is moved only when the destination doesn't already exist. Safe to call every launch.
void migrateLegacy();

// Delete all app data + cache (and any leftover legacy dotfiles) — the --uninstall action. Returns true if
// everything that existed was removed cleanly.
bool wipeAll();

// Absolute path to the running executable (resolves symlinks). Empty on failure.
std::string selfExecutable();

// What "delete the game" removes: the .app bundle on macOS, otherwise the folder the executable lives in.
std::string installArtifact();

// Spawn a DETACHED helper that waits for this process to exit, then deletes installArtifact() (the game
// itself). Pair with wipeAll() (data + cache), then quit, for a full in-game uninstall. Returns true if the
// helper launched. No console window is shown.
bool scheduleSelfDelete();

}  // namespace paths
