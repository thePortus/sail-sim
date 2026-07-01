// Minimal glTF/GLB mesh loader (positions + normals + indices) for Phase 1.
#pragma once
#include <cstdint>
#include <vector>

// Interleaved vertex: position.xyz, normal.xyz, uv, albedo.rgb, metallic, roughness.
constexpr int kFloatsPerVertex = 13;

// A decoded base-colour texture (8-bit RGBA, top-left origin).
struct TextureData {
  int width = 0, height = 0;
  std::vector<uint8_t> rgba;
};

// A contiguous index range drawn with one material's texture (index into
// MeshData::textures, or -1 for "no texture").
struct Submesh {
  uint32_t indexOffset = 0;
  uint32_t indexCount = 0;
  int      textureIndex = -1;
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
