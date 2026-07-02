// Minimal glTF/GLB mesh loader (positions + normals + indices) for Phase 1.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

// Interleaved vertex: position.xyz, normal.xyz, uv, albedo.rgb, metallic, roughness.
constexpr int kFloatsPerVertex = 13;

// A decoded texture (8-bit RGBA, top-left origin). `srgb` = colour data that
// should be uploaded as an sRGB format (base colour); normal/ORM maps are linear.
struct TextureData {
  int width = 0, height = 0;
  bool srgb = false;
  std::vector<uint8_t> rgba;
};

// A contiguous index range drawn with one material. Each field indexes into
// MeshData::textures, or -1 for "none" (a neutral default is used).
struct Submesh {
  uint32_t indexOffset = 0;
  uint32_t indexCount = 0;
  int      baseColor = -1;   // sRGB albedo map
  int      normal = -1;      // tangent-space normal map (linear)
  int      metalRough = -1;  // glTF metallic-roughness map: G=rough, B=metal (linear)
  std::string name;          // source glTF mesh name (finds the hull for the water mask)
};

struct MeshData {
  std::vector<float>       vertices;   // kFloatsPerVertex floats per vertex
  std::vector<uint32_t>    indices;
  std::vector<Submesh>     submeshes;
  std::vector<TextureData> textures;   // decoded base-colour maps
  float bbMin[3] = { 0, 0, 0 };
  float bbMax[3] = { 0, 0, 0 };
  bool  ok = false;
};

// Load and merge all triangle geometry from a .glb/.gltf. ok=false on failure.
MeshData loadGltfMesh(const char* path);

// A unit cube with per-face normals — used as a fallback when no model loads.
MeshData makeCubeMesh();
