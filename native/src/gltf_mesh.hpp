// Minimal glTF/GLB mesh loader (positions + normals + indices) for Phase 1.
#pragma once
#include <cstdint>
#include <vector>

// Interleaved vertex layout: position.xyz, normal.xyz, albedo.rgb, metallic, roughness.
constexpr int kFloatsPerVertex = 11;

struct MeshData {
  std::vector<float>    vertices;   // kFloatsPerVertex floats per vertex
  std::vector<uint32_t> indices;
  float bbMin[3] = { 0, 0, 0 };
  float bbMax[3] = { 0, 0, 0 };
  bool  ok = false;
};

// Load and merge all triangle geometry from a .glb/.gltf. ok=false on failure.
MeshData loadGltfMesh(const char* path);

// A unit cube with per-face normals — used as a fallback when no model loads.
MeshData makeCubeMesh();
