// Fetches + decodes the celestial sky textures the server serves (mirrors the
// client's /sky/moon and /sky/stars): NASA public-domain lunar colour map and the
// Tycho all-sky star map. Runs off the render thread (see main.cpp std::async);
// the decoded RGBA is uploaded to WebGPU on the render thread once ready.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace sky {

// One decoded image as tightly-packed RGBA8 (row-major, w*h*4 bytes).
struct Image {
  bool ok = false;
  int  w = 0, h = 0;
  std::vector<uint8_t> rgba;
};

// GET /sky/<name> and decode. `maxW` (>0) downsamples very large maps (the star
// map is 8192x4096) to bound VRAM; 0 keeps native resolution.
Image fetch(const std::string& host, int port, const std::string& name, int maxW = 0);

} // namespace sky
