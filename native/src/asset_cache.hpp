// On-disk asset cache with HTTP ETag revalidation — the native equivalent of the browser's
// Cache-Control:no-cache + ETag flow the Angular client relies on (server/app.js serves /geometry with
// etag:true, maxAge:0). Assets stream from the server once, are STORED under ~/.sailsim_cache, and on every
// later load we send If-None-Match: the server answers 304 (cheap) when unchanged so we read the stored copy,
// or 200 with fresh bytes when the file changed (e.g. after an admin /reloadassets). On a network error we
// fall back to the last cached copy so a launch still works offline. Cross-platform: the cache root follows
// the same $HOME / %USERPROFILE% convention as settings/session (see settings.cpp).
#pragma once

#include <cstdint>
#include <string>

#include <httplib.h>

namespace assetcache {

// One fetch outcome. `bytes` is the asset body; `localPath` is where it lives on disk (valid whenever the
// asset is cached, even on a 304); `fromCache` is true when served from disk (304 / offline fallback).
struct Result {
  std::string bytes;
  std::string localPath;
  bool ok = false;
  bool fromCache = false;
};

// Cache root (~/.sailsim_cache), created on first use. Empty only if no home dir is resolvable.
std::string cacheDir();

// Cache-bust version broadcast by the server on /reloadassets (0 = none). Informational (logging) — the ETag
// revalidation is what actually re-streams changed files; invalidateAll() forces a full re-download.
void     setVersion(uint64_t v);
uint64_t version();

// Delete the whole on-disk cache so every asset re-streams on its next get() (the /reloadassets semantics:
// "all cached assets are forced to reload"). Safe to call from the main thread between fetches.
void invalidateAll();

// Fetch `urlPath` (e.g. "/geometry/brig.glb") honouring the server ETag, reusing an already-opened client
// (bound to one host:port). Stores body+ETag on a 200, reads the stored copy on a 304, and falls back to the
// cached copy on a network error.
Result get(httplib::Client& cli, const std::string& urlPath);
// Convenience overload that opens its own client to host:port (for one-off fetches).
Result get(const std::string& host, int port, const std::string& urlPath);

// Like get() but returns a LOCAL FILE PATH to read, for path-based loaders (the glTF reader takes a filename).
// Ensures the asset is on disk, then hands back its cache path. On total failure returns `localFallback` when
// that file exists (so a bundled/dev asset still loads), else an empty string.
std::string localPath(const std::string& host, int port, const std::string& urlPath,
                      const std::string& localFallback = "");

}  // namespace assetcache
