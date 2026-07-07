#include "asset_cache.hpp"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <system_error>

namespace fs = std::filesystem;

namespace assetcache {
namespace {

std::atomic<uint64_t> g_version{0};
std::mutex g_mutex;   // serialises invalidateAll() against the cache-root creation

std::string homeDir() {
  const char* home = std::getenv("HOME");
  if (!home) home = std::getenv("USERPROFILE");   // Windows
  return home ? home : ".";
}

// Canonical request path: drop any query string and lexically resolve '.'/'..' (so "/geometry/harbors/../
// forts/x.glb" -> "/geometry/forts/x.glb", matching how the server normalises it and giving a clean cache key).
std::string cleanUrl(const std::string& urlPath) {
  std::string p = urlPath;
  if (auto q = p.find('?'); q != std::string::npos) p.erase(q);
  return fs::path(p).lexically_normal().generic_string();
}

// Map a canonical URL path to a cache file path under <cacheDir>/, mirroring the server layout. Strips the
// leading '/' and neutralises any residual '..' so a path can't escape the cache root.
std::string relPathFor(const std::string& cleanPath) {
  std::string p = cleanPath;
  size_t i = 0;
  while (i < p.size() && (p[i] == '/' || p[i] == '\\')) ++i;
  p.erase(0, i);
  for (size_t pos = p.find(".."); pos != std::string::npos; pos = p.find("..", pos))
    p.replace(pos, 2, "__");
  return p;
}

std::string readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return {};
  return std::string(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
}

// Write bytes atomically: to a .tmp sibling, then rename over the target (so a crash/partial download never
// leaves a truncated asset that later reads as valid).
bool writeFileAtomic(const fs::path& path, const std::string& bytes) {
  std::error_code ec;
  fs::create_directories(path.parent_path(), ec);
  fs::path tmp = path;
  tmp += ".tmp";
  {
    std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    f.write(bytes.data(), (std::streamsize)bytes.size());
    if (!f) return false;
  }
  fs::rename(tmp, path, ec);
  if (ec) { fs::remove(tmp, ec); return false; }
  return true;
}

}  // namespace

std::string cacheDir() {
  static std::string dir = [] {
    std::string d = homeDir() + "/.sailsim_cache";
    std::error_code ec;
    fs::create_directories(d, ec);
    return d;
  }();
  return dir;
}

void setVersion(uint64_t v) { g_version.store(v); }
uint64_t version() { return g_version.load(); }

void invalidateAll() {
  std::lock_guard<std::mutex> lock(g_mutex);
  std::error_code ec;
  const std::string dir = cacheDir();
  // Wipe the CONTENTS, keeping the root directory itself.
  for (fs::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec))
    fs::remove_all(it->path(), ec);
  std::printf("[cache] invalidated %s (v%llu)\n", dir.c_str(), (unsigned long long)g_version.load());
}

Result get(httplib::Client& cli, const std::string& urlPath) {
  Result r;
  const std::string reqPath = cleanUrl(urlPath);
  const fs::path cacheFile = fs::path(cacheDir()) / relPathFor(reqPath);
  const fs::path etagFile = fs::path(cacheFile).concat(".etag");
  r.localPath = cacheFile.string();

  std::error_code ec;
  const bool haveCache = fs::exists(cacheFile, ec) && !ec;
  const std::string storedEtag = haveCache ? readFile(etagFile.string()) : std::string();

  httplib::Headers headers;
  if (haveCache && !storedEtag.empty()) headers.emplace("If-None-Match", storedEtag);

  auto res = cli.Get(reqPath.c_str(), headers);

  if (!res) {   // network/transport error — serve the last good copy if we have one
    if (haveCache) { r.bytes = readFile(cacheFile.string()); r.ok = true; r.fromCache = true; }
    else std::printf("[cache] %s fetch failed (no network, no cache)\n", urlPath.c_str());
    return r;
  }
  if (res->status == 304 && haveCache) {   // unchanged — the stored copy is current
    r.bytes = readFile(cacheFile.string()); r.ok = true; r.fromCache = true;
    return r;
  }
  if (res->status == 200) {   // fresh (or changed) — store body + ETag, return the new bytes
    r.bytes = std::move(res->body);
    r.ok = true; r.fromCache = false;
    if (!writeFileAtomic(cacheFile, r.bytes))
      std::printf("[cache] warn: could not store %s\n", urlPath.c_str());
    const std::string etag = res->get_header_value("ETag");
    if (!etag.empty()) writeFileAtomic(etagFile, etag);
    else fs::remove(etagFile, ec);
    return r;
  }
  // Any other status (404, 5xx, or a 304 with a missing cache file): prefer a cached copy, else fail.
  if (haveCache) { r.bytes = readFile(cacheFile.string()); r.ok = true; r.fromCache = true; }
  else std::printf("[cache] %s HTTP %d (no cache to fall back on)\n", urlPath.c_str(), res->status);
  return r;
}

Result get(const std::string& host, int port, const std::string& urlPath) {
  httplib::Client cli(host, port);
  cli.set_connection_timeout(8, 0);
  cli.set_read_timeout(30, 0);
  return get(cli, urlPath);
}

std::string localPath(const std::string& host, int port, const std::string& urlPath,
                      const std::string& localFallback) {
  Result r = get(host, port, urlPath);
  if (r.ok) return r.localPath;
  std::error_code ec;
  if (!localFallback.empty() && fs::exists(localFallback, ec) && !ec) return localFallback;
  return r.localPath;   // may be empty / absent; caller handles the miss
}

}  // namespace assetcache
