#include "paths.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <system_error>

namespace fs = std::filesystem;

namespace paths {
namespace {

constexpr const char* kApp = "SailSim";

std::string homeDir() {
  const char* home = std::getenv("HOME");
  if (!home) home = std::getenv("USERPROFILE");   // Windows
  return home ? home : ".";
}

// Resolve an env var to a directory, falling back to `dflt` when unset/empty.
std::string envDir(const char* var, const std::string& dflt) {
  const char* v = std::getenv(var);
  return (v && *v) ? std::string(v) : dflt;
}

std::string computeDataDir() {
#if defined(__APPLE__)
  return homeDir() + "/Library/Application Support/" + kApp;
#elif defined(_WIN32)
  return envDir("APPDATA", homeDir()) + "/" + kApp;
#else
  return envDir("XDG_CONFIG_HOME", homeDir() + "/.config") + "/" + kApp;
#endif
}

std::string computeCacheDir() {
#if defined(__APPLE__)
  return homeDir() + "/Library/Caches/" + kApp;
#elif defined(_WIN32)
  return envDir("LOCALAPPDATA", homeDir()) + "/" + kApp + "/cache";
#else
  return envDir("XDG_CACHE_HOME", homeDir() + "/.cache") + "/" + kApp;
#endif
}

std::string ensured(const std::string& dir) {
  std::error_code ec;
  fs::create_directories(dir, ec);
  return dir;
}

}  // namespace

std::string dataDir() {
  static std::string d = ensured(computeDataDir());
  return d;
}

std::string cacheDir() {
  static std::string d = ensured(computeCacheDir());
  return d;
}

std::string dataFile(const std::string& name) {
  return (fs::path(dataDir()) / name).string();
}

void migrateLegacy() {
  std::error_code ec;
  const fs::path home = homeDir();

  // A legacy single-file dotfile -> its new home (only if the destination is absent).
  auto moveFile = [&](const fs::path& from, const fs::path& to) {
    if (!fs::exists(from, ec) || fs::exists(to, ec)) return;
    fs::create_directories(to.parent_path(), ec);
    fs::rename(from, to, ec);
    if (ec) {   // cross-device (e.g. HOME on another volume) — copy then remove
      ec.clear();
      fs::copy_file(from, to, fs::copy_options::overwrite_existing, ec);
      if (!ec) fs::remove(from, ec);
    }
  };
  moveFile(home / ".sailsim_settings", fs::path(dataFile("settings.json")));
  moveFile(home / ".sailsim_session",  fs::path(dataFile("session")));

  // Legacy cache dir -> new cache dir: move each top-level entry we don't already have, then drop the old dir.
  const fs::path oldCache = home / ".sailsim_cache";
  if (fs::exists(oldCache, ec) && fs::is_directory(oldCache, ec)) {
    const fs::path newCache = cacheDir();
    for (fs::directory_iterator it(oldCache, ec), end; !ec && it != end; it.increment(ec)) {
      const fs::path dst = newCache / it->path().filename();
      if (!fs::exists(dst, ec)) { std::error_code mv; fs::rename(it->path(), dst, mv); }
    }
    fs::remove_all(oldCache, ec);
  }
}

bool wipeAll() {
  std::error_code ec;
  bool ok = true;
  auto nuke = [&](const fs::path& p) {
    fs::remove_all(p, ec);
    if (ec) { ok = false; ec.clear(); }
  };
  nuke(dataDir());
  nuke(cacheDir());
  // Sweep any leftover legacy dotfiles too (in case an old build ran after migration).
  const fs::path home = homeDir();
  nuke(home / ".sailsim_settings");
  nuke(home / ".sailsim_session");
  nuke(home / ".sailsim_cache");
  return ok;
}

}  // namespace paths
