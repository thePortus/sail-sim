#define CGLTF_IMPLEMENTATION
#include "cgltf.h"

#include "gltf_mesh.hpp"

#include <cfloat>
#include <cstdio>

MeshData loadGltfMesh(const char* path) {
  MeshData out;
  out.bbMin[0] = out.bbMin[1] = out.bbMin[2] =  FLT_MAX;
  out.bbMax[0] = out.bbMax[1] = out.bbMax[2] = -FLT_MAX;

  cgltf_options options = {};
  cgltf_data* data = nullptr;
  if (cgltf_parse_file(&options, path, &data) != cgltf_result_success) {
    std::fprintf(stderr, "[gltf] parse failed: %s\n", path);
    return out;
  }
  if (cgltf_load_buffers(&options, data, path) != cgltf_result_success) {
    std::fprintf(stderr, "[gltf] load_buffers failed: %s\n", path);
    cgltf_free(data);
    return out;
  }
  if (cgltf_validate(data) != cgltf_result_success) {
    std::fprintf(stderr, "[gltf] validate failed: %s\n", path);
    cgltf_free(data);
    return out;
  }

  for (cgltf_size mi = 0; mi < data->meshes_count; ++mi) {
    const cgltf_mesh& mesh = data->meshes[mi];
    for (cgltf_size pi = 0; pi < mesh.primitives_count; ++pi) {
      const cgltf_primitive& prim = mesh.primitives[pi];
      if (prim.type != cgltf_primitive_type_triangles) continue;

      cgltf_accessor* pos = nullptr;
      cgltf_accessor* nrm = nullptr;
      for (cgltf_size ai = 0; ai < prim.attributes_count; ++ai) {
        if (prim.attributes[ai].type == cgltf_attribute_type_position) pos = prim.attributes[ai].data;
        else if (prim.attributes[ai].type == cgltf_attribute_type_normal) nrm = prim.attributes[ai].data;
      }
      if (!pos) continue;

      const cgltf_size base = out.vertices.size() / 6;
      const cgltf_size vcount = pos->count;
      for (cgltf_size v = 0; v < vcount; ++v) {
        float p[3] = { 0, 0, 0 };
        float n[3] = { 0, 1, 0 };
        cgltf_accessor_read_float(pos, v, p, 3);
        if (nrm) cgltf_accessor_read_float(nrm, v, n, 3);
        out.vertices.insert(out.vertices.end(), { p[0], p[1], p[2], n[0], n[1], n[2] });
        for (int c = 0; c < 3; ++c) {
          if (p[c] < out.bbMin[c]) out.bbMin[c] = p[c];
          if (p[c] > out.bbMax[c]) out.bbMax[c] = p[c];
        }
      }

      if (prim.indices) {
        const cgltf_size icount = prim.indices->count;
        for (cgltf_size i = 0; i < icount; ++i)
          out.indices.push_back((uint32_t)(base + cgltf_accessor_read_index(prim.indices, i)));
      } else {
        for (cgltf_size i = 0; i < vcount; ++i)
          out.indices.push_back((uint32_t)(base + i));
      }
    }
  }

  cgltf_free(data);
  out.ok = !out.vertices.empty() && !out.indices.empty();
  if (out.ok)
    std::printf("[gltf] loaded %s: %zu verts, %zu indices\n",
                path, out.vertices.size() / 6, out.indices.size());
  return out;
}

MeshData makeCubeMesh() {
  MeshData m;
  // Explicit 24-vertex cube (4 verts/face, per-face normal), 36 indices.
  const float V[] = {
    // +Z
    -0.5f,-0.5f, 0.5f, 0,0,1,  0.5f,-0.5f, 0.5f, 0,0,1,  0.5f, 0.5f, 0.5f, 0,0,1, -0.5f, 0.5f, 0.5f, 0,0,1,
    // -Z
     0.5f,-0.5f,-0.5f, 0,0,-1,-0.5f,-0.5f,-0.5f, 0,0,-1,-0.5f, 0.5f,-0.5f, 0,0,-1,  0.5f, 0.5f,-0.5f, 0,0,-1,
    // +X
     0.5f,-0.5f, 0.5f, 1,0,0,  0.5f,-0.5f,-0.5f, 1,0,0,  0.5f, 0.5f,-0.5f, 1,0,0,  0.5f, 0.5f, 0.5f, 1,0,0,
    // -X
    -0.5f,-0.5f,-0.5f,-1,0,0, -0.5f,-0.5f, 0.5f,-1,0,0, -0.5f, 0.5f, 0.5f,-1,0,0, -0.5f, 0.5f,-0.5f,-1,0,0,
    // +Y
    -0.5f, 0.5f, 0.5f, 0,1,0,  0.5f, 0.5f, 0.5f, 0,1,0,  0.5f, 0.5f,-0.5f, 0,1,0, -0.5f, 0.5f,-0.5f, 0,1,0,
    // -Y
    -0.5f,-0.5f,-0.5f, 0,-1,0, 0.5f,-0.5f,-0.5f, 0,-1,0, 0.5f,-0.5f, 0.5f, 0,-1,0,-0.5f,-0.5f, 0.5f, 0,-1,0,
  };
  m.vertices.assign(V, V + sizeof(V) / sizeof(V[0]));
  for (uint32_t f = 0; f < 6; ++f) {
    uint32_t b = f * 4;
    uint32_t quad[6] = { b, b + 1, b + 2, b, b + 2, b + 3 };
    m.indices.insert(m.indices.end(), quad, quad + 6);
  }
  m.bbMin[0] = m.bbMin[1] = m.bbMin[2] = -0.5f;
  m.bbMax[0] = m.bbMax[1] = m.bbMax[2] =  0.5f;
  m.ok = true;
  return m;
}
