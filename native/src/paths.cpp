#include "paths.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <system_error>

#if defined(_WIN32)
#  include <windows.h>
#elif defined(__APPLE__)
#  include <mach-o/dyld.h>
#else
#  include <unistd.h>
#endif

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

std::string selfExecutable() {
#if defined(_WIN32)
  wchar_t buf[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return "";
  std::error_code ec;
  fs::path p = fs::weakly_canonical(fs::path(std::wstring(buf, n)), ec);
  return ec ? fs::path(std::wstring(buf, n)).string() : p.string();
#elif defined(__APPLE__)
  char buf[4096]; uint32_t sz = sizeof(buf);
  if (_NSGetExecutablePath(buf, &sz) != 0) return "";
  std::error_code ec;
  fs::path p = fs::canonical(buf, ec);
  return ec ? std::string(buf) : p.string();
#else
  char buf[4096];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (n <= 0) return "";
  buf[n] = '\0';
  return buf;
#endif
}

std::string installArtifact() {
  const std::string exe = selfExecutable();
  if (exe.empty()) return "";
  const fs::path p(exe);
#if defined(__APPLE__)
  // Inside a bundle (…/SailSim.app/Contents/MacOS/exe) → remove the whole .app.
  for (fs::path a = p; a.has_parent_path() && a != a.parent_path(); a = a.parent_path())
    if (a.extension() == ".app") return a.string();
#endif
  // Otherwise the folder the executable lives in (the install dir).
  return p.parent_path().string();
}

bool scheduleSelfDelete() {
  const std::string target = installArtifact();
  if (target.empty()) return false;
#if defined(_WIN32)
  // A running exe can't delete itself, so hand the job to a detached cmd that
  // waits for us to exit (ping = ~2 s delay), then removes the whole install
  // folder. Its CWD is set OUTSIDE the target so rmdir can delete it.
  // DETACHED_PROCESS | CREATE_NO_WINDOW keeps a console from flashing (release
  // is a GUI-subsystem build with no console of its own).
  std::string cmd = "cmd.exe /C \"ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + target + "\"\"";
  const std::string cwd = fs::path(target).parent_path().string();
  STARTUPINFOA si{}; si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  BOOL ok = CreateProcessA(nullptr, cmd.data(), nullptr, nullptr, FALSE,
                           DETACHED_PROCESS | CREATE_NO_WINDOW, nullptr,
                           cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
  if (ok) { CloseHandle(pi.hProcess); CloseHandle(pi.hThread); }
  return ok != 0;
#else
  // Background a subshell that outlives us: it sleeps, then rm -rf's the app /
  // install folder. On macOS/Linux the running binary's inode survives deletion
  // until the process exits, so removing it out from under ourselves is fine.
  std::string esc;
  for (char c : target) { if (c == '\'') esc += "'\\''"; else esc += c; }
  const std::string cmd = "(sleep 1; rm -rf '" + esc + "') >/dev/null 2>&1 &";
  return std::system(cmd.c_str()) == 0;
#endif
}

}  // namespace paths
