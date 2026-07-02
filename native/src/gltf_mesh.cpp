#define CGLTF_IMPLEMENTATION
#include "cgltf.h"

#include "gltf_mesh.hpp"
#include "ktx2.hpp"

#include <cfloat>
#include <cstdio>
#include <map>
#include <utility>

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

  // Decode each KTX2 texture once, deduped by cgltf pointer.
  std::vector<const cgltf_texture*> texPtrs;
  auto getTexIndex = [&](const cgltf_texture* tex, bool srgb) -> int {
    if (!tex) return -1;
    for (size_t i = 0; i < texPtrs.size(); ++i)
      if (texPtrs[i] == tex) return (int)i;
    const cgltf_image* img = (tex->has_basisu && tex->basisu_image) ? tex->basisu_image : tex->image;
    if (!img || !img->buffer_view || !img->buffer_view->buffer || !img->buffer_view->buffer->data) return -1;
    const cgltf_buffer_view* bv = img->buffer_view;
    const uint8_t* bytes = (const uint8_t*)bv->buffer->data + bv->offset;
    TextureData td;
    td.srgb = srgb;
    if (!decodeKtx2ToRGBA(bytes, bv->size, td.width, td.height, td.rgba)) return -1;
    out.textures.push_back(std::move(td));
    texPtrs.push_back(tex);
    return (int)out.textures.size() - 1;
  };

  // Mesh -> scene-node name (the semantic name: 'Sloop_Hull', 'B_Mast_Main'...).
  // Vessels are authored with meaningful NODE names while the mesh names can be
  // arbitrary ('Aft_Cabinet', 'Hull.001'), so prefer the node's.
  std::map<const cgltf_mesh*, const char*> meshNode;
  for (cgltf_size ni = 0; ni < data->nodes_count; ++ni) {
    const cgltf_node& nd = data->nodes[ni];
    if (nd.mesh && nd.name && meshNode.find(nd.mesh) == meshNode.end()) meshNode[nd.mesh] = nd.name;
  }

  for (cgltf_size mi = 0; mi < data->meshes_count; ++mi) {
    const cgltf_mesh& mesh = data->meshes[mi];
    for (cgltf_size pi = 0; pi < mesh.primitives_count; ++pi) {
      const cgltf_primitive& prim = mesh.primitives[pi];
      if (prim.type != cgltf_primitive_type_triangles) continue;

      cgltf_accessor* pos = nullptr;
      cgltf_accessor* nrm = nullptr;
      cgltf_accessor* uv = nullptr;
      for (cgltf_size ai = 0; ai < prim.attributes_count; ++ai) {
        const cgltf_attribute& a = prim.attributes[ai];
        if (a.type == cgltf_attribute_type_position) pos = a.data;
        else if (a.type == cgltf_attribute_type_normal) nrm = a.data;
        else if (a.type == cgltf_attribute_type_texcoord && a.index == 0) uv = a.data;
      }
      if (!pos) continue;

      // Per-primitive material: factors + base-colour / normal / metallic-roughness maps.
      float albedo[3] = { 0.8f, 0.8f, 0.8f };
      float metallic = 0.0f, roughness = 0.7f;
      int baseColorTex = -1, normalTex = -1, metalRoughTex = -1;
      if (prim.material) {
        if (prim.material->has_pbr_metallic_roughness) {
          const cgltf_pbr_metallic_roughness& mr = prim.material->pbr_metallic_roughness;
          albedo[0] = mr.base_color_factor[0];
          albedo[1] = mr.base_color_factor[1];
          albedo[2] = mr.base_color_factor[2];
          metallic = mr.metallic_factor;
          roughness = mr.roughness_factor;
          baseColorTex  = getTexIndex(mr.base_color_texture.texture, true);
          metalRoughTex = getTexIndex(mr.metallic_roughness_texture.texture, false);
        }
        normalTex = getTexIndex(prim.material->normal_texture.texture, false);
      }

      const cgltf_size base = out.vertices.size() / kFloatsPerVertex;
      const cgltf_size vcount = pos->count;
      for (cgltf_size v = 0; v < vcount; ++v) {
        float p[3] = { 0, 0, 0 };
        float n[3] = { 0, 1, 0 };
        float t[2] = { 0, 0 };
        cgltf_accessor_read_float(pos, v, p, 3);
        if (nrm) cgltf_accessor_read_float(nrm, v, n, 3);
        if (uv)  cgltf_accessor_read_float(uv, v, t, 2);
        out.vertices.insert(out.vertices.end(),
          { p[0], p[1], p[2], n[0], n[1], n[2], t[0], t[1], albedo[0], albedo[1], albedo[2], metallic, roughness });
        for (int c = 0; c < 3; ++c) {
          if (p[c] < out.bbMin[c]) out.bbMin[c] = p[c];
          if (p[c] > out.bbMax[c]) out.bbMax[c] = p[c];
        }
      }

      const uint32_t indexOffset = (uint32_t)out.indices.size();
      if (prim.indices) {
        const cgltf_size icount = prim.indices->count;
        for (cgltf_size i = 0; i < icount; ++i)
          out.indices.push_back((uint32_t)(base + cgltf_accessor_read_index(prim.indices, i)));
      } else {
        for (cgltf_size i = 0; i < vcount; ++i)
          out.indices.push_back((uint32_t)(base + i));
      }
      auto nodeIt = meshNode.find(&mesh);
      const char* smName = nodeIt != meshNode.end() ? nodeIt->second : mesh.name;
      out.submeshes.push_back({ indexOffset, (uint32_t)out.indices.size() - indexOffset,
                                baseColorTex, normalTex, metalRoughTex,
                                smName ? std::string(smName) : std::string() });
    }
  }

  cgltf_free(data);
  out.ok = !out.vertices.empty() && !out.indices.empty();
  if (out.ok)
    std::printf("[gltf] loaded %s: %zu verts, %zu indices, %zu submeshes, %zu textures\n",
                path, out.vertices.size() / kFloatsPerVertex, out.indices.size(),
                out.submeshes.size(), out.textures.size());
  return out;
}

MeshData makeCubeMesh() {
  MeshData m;
  // 24 vertices (4 per face) as position + face-normal; colour/roughness added below.
  const float PN[] = {
    -0.5f,-0.5f, 0.5f, 0,0,1,  0.5f,-0.5f, 0.5f, 0,0,1,  0.5f, 0.5f, 0.5f, 0,0,1, -0.5f, 0.5f, 0.5f, 0,0,1,   // +Z
     0.5f,-0.5f,-0.5f, 0,0,-1,-0.5f,-0.5f,-0.5f, 0,0,-1,-0.5f, 0.5f,-0.5f, 0,0,-1,  0.5f, 0.5f,-0.5f, 0,0,-1,  // -Z
     0.5f,-0.5f, 0.5f, 1,0,0,  0.5f,-0.5f,-0.5f, 1,0,0,  0.5f, 0.5f,-0.5f, 1,0,0,  0.5f, 0.5f, 0.5f, 1,0,0,    // +X
    -0.5f,-0.5f,-0.5f,-1,0,0, -0.5f,-0.5f, 0.5f,-1,0,0, -0.5f, 0.5f, 0.5f,-1,0,0, -0.5f, 0.5f,-0.5f,-1,0,0,    // -X
    -0.5f, 0.5f, 0.5f, 0,1,0,  0.5f, 0.5f, 0.5f, 0,1,0,  0.5f, 0.5f,-0.5f, 0,1,0, -0.5f, 0.5f,-0.5f, 0,1,0,    // +Y
    -0.5f,-0.5f,-0.5f, 0,-1,0, 0.5f,-0.5f,-0.5f, 0,-1,0, 0.5f,-0.5f, 0.5f, 0,-1,0,-0.5f,-0.5f, 0.5f, 0,-1,0,   // -Y
  };
  const float faceColor[6][3] = {
    {0.85f,0.25f,0.25f}, {0.25f,0.75f,0.35f}, {0.30f,0.45f,0.95f},
    {0.90f,0.80f,0.25f}, {0.85f,0.85f,0.85f}, {0.55f,0.35f,0.75f},
  };
  for (int f = 0; f < 6; ++f)
    for (int v = 0; v < 4; ++v) {
      const float* pn = &PN[(f * 4 + v) * 6];
      m.vertices.insert(m.vertices.end(),
        { pn[0], pn[1], pn[2], pn[3], pn[4], pn[5], 0.0f, 0.0f,   // pos, normal, uv
          faceColor[f][0], faceColor[f][1], faceColor[f][2], 0.0f, 0.5f });
    }
  for (uint32_t f = 0; f < 6; ++f) {
    uint32_t b = f * 4;
    uint32_t quad[6] = { b, b + 1, b + 2, b, b + 2, b + 3 };
    m.indices.insert(m.indices.end(), quad, quad + 6);
  }
  m.submeshes.push_back({ 0, (uint32_t)m.indices.size(), -1, -1, -1 });   // untextured
  m.bbMin[0] = m.bbMin[1] = m.bbMin[2] = -0.5f;
  m.bbMax[0] = m.bbMax[1] = m.bbMax[2] =  0.5f;
  m.ok = true;
  return m;
}
