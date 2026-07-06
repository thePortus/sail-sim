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

// One placed structure of a harbour town (asset = GLB/impostor basename).
struct Building { std::string asset; float x = 0, z = 0, rotY = 0; };
// One node of a town's defensive wall ring (Harbor Forts). tag: 0 corner, 1 bastion, 2 gate.
struct WallNode { float x = 0, z = 0; int tag = 0; };
// One street segment of a town's road network (draped ribbon of width `w`).
struct Street { float x1 = 0, z1 = 0, x2 = 0, z2 = 0, w = 5; };
// An oriented rectangle (the civic square). halfZ = along heading, halfX = across.
struct Rect { bool valid = false; float cx = 0, cz = 0, halfX = 0, halfZ = 0, rotY = 0; };
// One harbor-fort gun: muzzle world position + combat spec (server-authoritative; the combat pass fires from here).
struct Gun { float x = 0, z = 0, y = 0, heading = 0, range = 0, reload = 0, damage = 0; };
// One harbor fort (Harbor Forts). Placement is server-derived (deriveForts) so both clients agree exactly; the
// client just loads forts/<glb>.glb at (x,y,z), guns facing seaward (heading). tier is informational.
struct Fort { std::string glb, tier; float x = 0, z = 0, y = 0, heading = 0; std::vector<Gun> guns; };
struct Harbor {
  std::string id;                             // server town id ("town_0") for economy calls
  std::string name, faction, tier, variant;   // variant picks the pier GLB (straight/l/t)
  float x = 0, z = 0, heading = 0;
  float padElev = 0;                          // town pad ground elevation (metres)
  std::vector<Building> buildings;
  std::vector<Street>   streets;              // road network (draped ribbons)
  Rect                  square;               // civic square (valid=false if none)
  std::vector<WallNode> walls;                // defensive wall ring (open polyline; placeholder for the spike)
  std::vector<Fort>     forts;                // harbor forts (server-derived placement + gun spec)
};
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
