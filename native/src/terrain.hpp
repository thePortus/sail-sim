// World terrain: the server's global signed-elevation heightfield (land > 0,
// seabed < 0, waterline at 0). We fetch the manifest + all Uint16 chunks over
// REST, assemble one heightfield, and decode it to metres for CPU sampling and
// GPU upload. Mirrors server/controllers/terrain.controller.js + the client's
// terrain.service coordinate mapping (+Z is south).
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace terrain {

struct Harbor { std::string name, faction, tier; float x = 0, z = 0, heading = 0; };
struct Spawn  { float x = 0, z = 0, heading = 0; };

struct Manifest {
  int width = 0, height = 0, chunkSize = 0, chunkCountX = 0, chunkCountZ = 0;
  double quant = 65535.0, minE = 0, maxE = 0;
  double minX = 0, maxX = 0, minZ = 0, maxZ = 0;
  std::string source, sourceName;
  std::vector<Harbor> harbors;
  std::vector<Spawn>  spawns;
};

class Terrain {
public:
  // Fetch the manifest and every chunk, decode to metres. Blocking — run off the
  // render thread. Returns false (and stays !loaded) if anything fails.
  bool load(const std::string& host, int port);
  bool loaded() const { return loaded_; }
  const Manifest& manifest() const { return m_; }

  // Signed elevation (metres) at world (x,z): >0 land, <0 seabed, ~0 waterline.
  float elevation(float worldX, float worldZ) const;
  bool  isLand(float worldX, float worldZ) const { return elevation(worldX, worldZ) > 0.02f; }

  // Decoded elevation field (width*height, row-major) for an R32F GPU upload.
  const std::vector<float>& field() const { return elevF_; }

private:
  Manifest m_;
  std::vector<float> elevF_;   // decoded elevation (metres), row-major z*width+x
  bool loaded_ = false;
};

} // namespace terrain
