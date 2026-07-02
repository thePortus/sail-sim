// Fetches + decodes the terrain biome assets the server serves (mirrors the
// Angular client's S1/S2 terrain skinning): five Polyhaven PBR diffuse tiles
// (/terrain/tile/{sand,grass,gravel,rock,snow}_diff), three normal tiles
// (sand/grass/rock _nor — the client blends gravel/rock/snow onto the rock
// normal), and the baked RGBA control/splat map (/terrain/splat-map) whose
// texels are world-aligned soft biome weights (R sand, G grass, B gravel,
// A rock; snow = 1-sum). Runs off the render thread (std::async in main.cpp);
// decoded RGBA is uploaded to WebGPU on the render thread once ready.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace biome {

// One decoded image as tightly-packed RGBA8 (row-major, w*h*4 bytes).
struct Image {
  bool ok = false;
  int  w = 0, h = 0;
  std::vector<uint8_t> rgba;
};

// The full biome texture set. Diffuse tiles are downsampled to `tileW`
// (default 1024 — plenty at the 12-55 m repeat scales) to bound VRAM.
struct Set {
  bool ok = false;                       // true when every image decoded
  Image diff[5];                         // sand, grass, gravel, rock, snow
  Image diff2[2];                        // grass2, rock2 — anti-tiling variety mixes
  Image nor[3];                          // sand, grass, rock
  Image splat;                           // control map (world bounds aligned)
};

Set fetchAll(const std::string& host, int port, int tileW = 1024);

} // namespace biome
