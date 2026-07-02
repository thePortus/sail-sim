// Fetches + decodes the LOD-impostor atlases the server serves, mirroring the
// Angular client's ship-impostor.ts / harbor.service.ts impostor layers:
//   /geometry/ship_impostors/ship_impostors_manifest.json + <slug>_atlas.png
//     - N horizon-level views baked around each hull (1xN strip); a distant ship
//       is drawn as one alpha-tested billboard picking the cell for its view angle.
//   /geometry/harbors/impostors/impostors_manifest.json + <asset>_imp.png
//     - one baked 3/4 view per building type, billboarded at mid-distance.
// Runs off the render thread (std::async in main.cpp).
#pragma once
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace props {

struct Image {
  bool ok = false;
  int  w = 0, h = 0;
  std::vector<uint8_t> rgba;
};

struct ShipAtlas {
  float size = 0, centerY = 0;   // world metres: quad size + its centre height over the waterline
  int   n = 16, cols = 16;       // baked azimuth views / atlas columns
  Image img;
};

struct BuildingImp {
  float size = 0;      // world metres (square quad)
  float basePad = 0;   // fraction of the image height that is transparent below the
                       // content (client measureBottomPad) — aligns the base to the ground
  Image img;
};

struct Set {
  bool ok = false;   // true when every manifest-listed image decoded
  std::map<std::string, ShipAtlas>   ships;       // slug -> atlas
  std::map<std::string, BuildingImp> buildings;   // asset -> impostor
};

Set fetchAll(const std::string& host, int port);

} // namespace props
