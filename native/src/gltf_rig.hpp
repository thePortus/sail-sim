// Rigged glTF/GLB loader (Phase 0 of the vessel-animation port): retains the
// node hierarchy, skins, morph targets and animation clips that the flat
// loadGltfMesh() discards. Rendering uses a UNIFIED MATRIX PALETTE:
//   slots [0, nodes)              = each node's world matrix
//   slots [nodes, nodes+joints)   = jointWorld × inverseBind (the skin)
// Every vertex carries 4 joint slots + weights: rigid geometry references its
// node's slot with weight 1, skinned geometry its joint slots — one shader path
// for both, and animation is just a palette rewrite.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>

#include "gltf_mesh.hpp"   // TextureData (shared with the flat loader)

// Interleaved vertex: position.xyz, normal.xyz, uv, albedo.rgb, metallic,
// roughness, joints.xyzw (palette slots, as float), weights.xyzw.
constexpr int kRigFloatsPerVertex = 21;

struct RigNode {
  std::string name;          // authored node name ('B_Boom', 'Anchor', …)
  int parent = -1;
  glm::vec3 t = glm::vec3(0.0f);
  glm::quat r = glm::quat(1.0f, 0.0f, 0.0f, 0.0f);
  glm::vec3 s = glm::vec3(1.0f);
};

struct RigSkin {
  std::vector<int> joints;            // node indices
  std::vector<glm::mat4> invBind;     // aligned with joints
};

// One keyframed property of one node. Times are seconds; values vec3 (T/S) or
// quaternion xyzw (R). STEP interpolation is flagged; CUBICSPLINE falls back to
// linear over the key values.
struct RigChannel {
  int node = -1;
  int path = 0;                       // 0 translation, 1 rotation, 2 scale
  bool step = false;
  std::vector<float> times;
  std::vector<glm::vec4> values;
};

struct RigClip {
  std::string name;                   // raw ('NLA_Trim', 'Furl_Jib', …)
  float tMin = 0, tMax = 0;
  std::vector<RigChannel> channels;
};

// Morph target deltas for one emitted submesh (positions only — that's all the
// sail furl/break morphs move). vertexBase indexes into RiggedData::vertices.
struct RigMorph {
  int submesh = -1;
  int target = 0;                     // morph target index within the primitive
  std::string targetName;             // from the glTF target_names extras ('Furl', 'Drop_S', …)
  uint32_t vertexBase = 0, vertexCount = 0;
  std::vector<glm::vec3> dpos;
};

struct RigSubmesh {
  uint32_t indexOffset = 0;
  uint32_t indexCount = 0;
  int baseColor = -1, normal = -1, metalRough = -1;   // into textures
  float albedo[3] = { 1, 1, 1 };      // material baseColorFactor (flag-tint gate: only blank white ensigns tint)
  float emissive[3] = { 0, 0, 0 };    // emissiveFactor x KHR emissive strength (lantern glass, windows)
  std::string name;                   // owning NODE name (semantic)
  std::string material;               // glTF material name (e.g. SHIP_FLAG) — flag tint keys off this
  int node = -1;
  bool skinned = false;
};

struct RiggedData {
  std::vector<float>       vertices;   // kRigFloatsPerVertex floats per vertex
  std::vector<uint32_t>    indices;
  std::vector<RigSubmesh>  submeshes;
  std::vector<TextureData> textures;
  std::vector<RigNode>     nodes;
  std::vector<RigSkin>     skins;
  std::vector<RigClip>     clips;
  std::vector<RigMorph>    morphs;
  // Rest-pose palette (nodes first, then each skin's joint matrices) — exactly
  // what the renderer uploads until controllers start rewriting it.
  std::vector<glm::mat4>   restPalette;
  // Rest-pose world-space bounds (node transforms + skinning applied), so hull
  // scale/keel/draft calibration sees the ship as it renders.
  float bbMin[3] = { 0, 0, 0 };
  float bbMax[3] = { 0, 0, 0 };
  bool ok = false;
};

// Max palette slots the renderer allocates (nodes + skin joints; largest ship
// uses ~85). Load fails if exceeded.
constexpr uint32_t kMaxPaletteSlots = 128;

RiggedData loadGltfRigged(const char* path);

// 21-float fallback cube (matches the rigged vertex layout; single identity node).
RiggedData makeRiggedCube();
