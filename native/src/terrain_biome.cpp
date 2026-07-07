#include "terrain_biome.hpp"

#include <cstdio>

#include <httplib.h>          // header-only; plain HTTP (dev server is http://localhost:9080)
#include "netcfg.hpp"
#include "asset_cache.hpp"    // ETag disk cache (stream once, revalidate on later loads)
#include "stb_image.h"        // decode; implementation lives in stb_impl.cpp
#include "stb_image_resize2.h"

namespace biome {

// GET `path` and decode to RGBA8; optionally downsample to maxW (sRGB-aware for
// colour tiles, linear for normal maps — resizing normals through the sRGB curve
// would bend the vectors).
static Image fetchOne(httplib::Client& cli, const std::string& path, int maxW, bool srgb) {
  Image out;
  auto res = assetcache::get(cli, path);
  if (!res.ok) {
    std::printf("[biome] fetch %s failed\n", path.c_str());
    return out;
  }
  int w = 0, h = 0, comp = 0;
  unsigned char* pix = stbi_load_from_memory(
      reinterpret_cast<const unsigned char*>(res.bytes.data()),
      (int)res.bytes.size(), &w, &h, &comp, 4);   // force RGBA
  if (!pix) {
    std::printf("[biome] decode %s failed: %s\n", path.c_str(), stbi_failure_reason());
    return out;
  }
  if (maxW > 0 && w > maxW) {
    int dw = maxW;
    int dh = (int)((long long)h * dw / w);
    std::vector<uint8_t> small((size_t)dw * dh * 4);
    if (srgb) stbir_resize_uint8_srgb(pix, w, h, 0, small.data(), dw, dh, 0, STBIR_RGBA);
    else      stbir_resize_uint8_linear(pix, w, h, 0, small.data(), dw, dh, 0, STBIR_RGBA);
    stbi_image_free(pix);
    out.w = dw; out.h = dh; out.rgba = std::move(small); out.ok = true;
  } else {
    out.w = w; out.h = h;
    out.rgba.assign(pix, pix + (size_t)w * h * 4);
    stbi_image_free(pix);
    out.ok = true;
  }
  return out;
}

Set fetchAll(const std::string& host, int port, int tileW) {
  Set s;
  httplib::Client cli(netcfg::baseUrl(host, port));
  cli.set_connection_timeout(8, 0);
  cli.set_read_timeout(30, 0);

  static const char* kDiff[5] = { "sand", "grass", "gravel", "rock", "snow" };
  static const char* kNor[3]  = { "sand", "grass", "rock" };

  bool all = true;
  for (int i = 0; i < 5; ++i) {
    s.diff[i] = fetchOne(cli, std::string("/terrain/tile/") + kDiff[i] + "_diff", tileW, true);
    all = all && s.diff[i].ok;
  }
  // Variety textures: a second grass + rock, mixed in by slow world-space noise
  // (the client's section 6/7 anti-tiling) so large faces don't repeat one tile.
  s.diff2[0] = fetchOne(cli, "/terrain/tile/grass2_diff", tileW, true);
  s.diff2[1] = fetchOne(cli, "/terrain/tile/rock2_diff", tileW, true);
  all = all && s.diff2[0].ok && s.diff2[1].ok;
  for (int i = 0; i < 3; ++i) {
    s.nor[i] = fetchOne(cli, std::string("/terrain/tile/") + kNor[i] + "_nor", tileW, false);
    all = all && s.nor[i].ok;
  }
  s.splat = fetchOne(cli, "/terrain/splat-map", 0, false);   // linear weights, keep native res
  all = all && s.splat.ok;

  s.ok = all;
  std::printf("[biome] tiles %s (splat %dx%d)\n", all ? "loaded" : "INCOMPLETE",
              s.splat.w, s.splat.h);
  return s;
}

} // namespace biome
