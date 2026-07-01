// Minimal glTF/GLB mesh loader (positions + normals + indices) for Phase 1.
#pragma once
#include <cstdint>
#include <vector>

struct MeshData {
  std::vector<float>    vertices;   // interleaved: position.xyz, normal.xyz
  std::vector<uint32_t> indices;
  float bbMin[3] = { 0, 0, 0 };
  float bbMax[3] = { 0, 0, 0 };
  bool  ok = false;
};

// Load and merge all triangle geometry from a .glb/.gltf. ok=false on failure.
MeshData loadGltfMesh(const char* path);

// A unit cube with per-face normals — used as a fallback when no model loads.
MeshData makeCubeMesh();
