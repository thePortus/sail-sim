#include "sky_assets.hpp"

#include <cstdio>

#include <httplib.h>          // header-only; plain HTTP (dev server is http://localhost:9080)
#include "netcfg.hpp"
#include "asset_cache.hpp"    // ETag disk cache (stream once, revalidate on later loads)
#include "stb_image.h"        // decode; implementation lives in stb_impl.cpp
#include "stb_image_resize2.h"

namespace sky {

Image fetch(const std::string& host, int port, const std::string& name, int maxW) {
  Image out;
  httplib::Client cli(netcfg::baseUrl(host, port));
  cli.set_connection_timeout(8, 0);
  cli.set_read_timeout(20, 0);

  auto res = assetcache::get(cli, "/sky/" + name);
  if (!res.ok) {
    std::printf("[sky] fetch /sky/%s failed\n", name.c_str());
    return out;
  }

  int w = 0, h = 0, comp = 0;
  unsigned char* pix = stbi_load_from_memory(
      reinterpret_cast<const unsigned char*>(res.bytes.data()),
      (int)res.bytes.size(), &w, &h, &comp, 4);   // force RGBA
  if (!pix) {
    std::printf("[sky] decode /sky/%s failed: %s\n", name.c_str(), stbi_failure_reason());
    return out;
  }

  if (maxW > 0 && w > maxW) {
    // Downsample huge maps (the 8192-wide star map) to bound VRAM. Preserve aspect.
    int dw = maxW;
    int dh = (int)((long long)h * dw / w);
    std::vector<uint8_t> small((size_t)dw * dh * 4);
    stbir_resize_uint8_srgb(pix, w, h, 0, small.data(), dw, dh, 0, STBIR_RGBA);
    stbi_image_free(pix);
    out.w = dw; out.h = dh; out.rgba = std::move(small); out.ok = true;
  } else {
    out.w = w; out.h = h;
    out.rgba.assign(pix, pix + (size_t)w * h * 4);
    stbi_image_free(pix);
    out.ok = true;
  }
  std::printf("[sky] loaded /sky/%s -> %dx%d\n", name.c_str(), out.w, out.h);
  return out;
}

} // namespace sky
