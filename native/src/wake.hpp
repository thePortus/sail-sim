// Wake path tracker — verbatim port of the client's wake-tracker.ts. Records a
// breadcrumb trail for EVERY vessel (local + remotes) so the FFT ocean can draw
// a curved, trailing wake behind each ship: per frame every track's points age,
// expired ones drop, and a new point is laid each WAKE_STEP metres of travel.
// assemble() packs the nearest kMaxBoats ships (local always first) into the
// flat vec4 arrays the ocean shader samples.
#pragma once

#include <algorithm>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

#include <glm/glm.hpp>

namespace wake {

constexpr int   kPoints   = 40;    // points per boat (longer buffer -> longer wake)
constexpr int   kMaxBoats = 4;     // ships rendered with a wake at once
constexpr float kLife     = 12.0f; // seconds before a wake point fades out
constexpr float kStep     = 3.0f;  // metres travelled between recorded points

// One ship's live pose for this frame. speed = abs(vessel speed) * 4, exactly
// the client's scaling (the shader's speed thresholds assume it).
struct Source { std::string id; float x, z, speed; };

class Tracker {
 public:
  // Age/extend each ship's track. boats[0] should be the local boat (id "local").
  void update(float dt, const std::vector<Source>& boats) {
    std::set<std::string> seen;
    for (const Source& b : boats) {
      seen.insert(b.id);
      Track& tr = tracks_[b.id];
      if (tr.fresh) { tr.lastX = b.x; tr.lastZ = b.z; tr.fresh = false; }
      tr.curX = b.x; tr.curZ = b.z; tr.speed = b.speed;

      for (int i = 0; i < tr.count; ++i) tr.path[i].z += dt;   // age
      int drop = 0;
      while (drop < tr.count && tr.path[drop].z > kLife) ++drop;
      if (drop > 0) {
        std::memmove(tr.path, tr.path + drop, sizeof(glm::vec4) * (tr.count - drop));
        tr.count -= drop;
      }

      const float dx = b.x - tr.lastX, dz = b.z - tr.lastZ;
      if (std::fabs(b.speed) > 0.2f && dx * dx + dz * dz >= kStep * kStep) {
        if (tr.count >= kPoints) {
          std::memmove(tr.path, tr.path + 1, sizeof(glm::vec4) * (kPoints - 1));
          tr.count = kPoints - 1;
        }
        // 4th channel = speed at the moment this point was laid, so the wake's
        // strength/width reflects how fast the ship was HERE, not now.
        tr.path[tr.count] = glm::vec4(b.x, b.z, 0.0f, b.speed);
        ++tr.count; tr.lastX = b.x; tr.lastZ = b.z;
      }
    }
    // Forget ships that left.
    for (auto it = tracks_.begin(); it != tracks_.end();)
      it = seen.count(it->first) ? std::next(it) : tracks_.erase(it);
  }

  // Pack the nearest kMaxBoats tracks (local always first) for the shader.
  void assemble(float cx, float cz) {
    std::vector<std::pair<const std::string*, const Track*>> entries;
    entries.reserve(tracks_.size());
    for (const auto& [id, tr] : tracks_) entries.push_back({ &id, &tr });
    std::sort(entries.begin(), entries.end(), [&](const auto& a, const auto& b) {
      if (*a.first == "local") return true;
      if (*b.first == "local") return false;
      const float da = (a.second->curX - cx) * (a.second->curX - cx)
                     + (a.second->curZ - cz) * (a.second->curZ - cz);
      const float db = (b.second->curX - cx) * (b.second->curX - cx)
                     + (b.second->curZ - cz) * (b.second->curZ - cz);
      return da < db;
    });
    count_ = std::min<int>(kMaxBoats, (int)entries.size());
    for (int k = 0; k < count_; ++k) {
      const Track& tr = *entries[k].second;
      std::memcpy(paths_ + k * kPoints, tr.path, sizeof(glm::vec4) * tr.count);
      meta_[k] = glm::vec4(tr.curX, tr.curZ, (float)tr.count, tr.speed);
    }
  }

  const glm::vec4* paths() const { return paths_; }   // vec4 x kMaxBoats*kPoints
  const glm::vec4* meta() const { return meta_; }     // vec4 x kMaxBoats
  int boatCount() const { return count_; }

 private:
  struct Track {
    glm::vec4 path[kPoints];        // x, z, age, speed-at-laydown
    int count = 0;
    bool fresh = true;              // lastX/Z not yet seeded from the first pose
    float lastX = 0, lastZ = 0;     // last recorded point
    float curX = 0, curZ = 0;       // current position (for culling)
    float speed = 0;
  };
  std::map<std::string, Track> tracks_;
  glm::vec4 paths_[kMaxBoats * kPoints] = {};
  glm::vec4 meta_[kMaxBoats] = {};
  int count_ = 0;
};

}  // namespace wake
