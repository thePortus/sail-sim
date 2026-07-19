// Rigged glTF loader — see gltf_rig.hpp. Traverses the scene graph (a mesh
// referenced by two nodes is emitted twice), retains skins/clips/morphs, and
// bakes nothing: vertices stay in their authored space and the matrix palette
// carries the rest pose, so animation later is a pure palette/weight rewrite.

#include "cgltf.h"   // implementation lives in gltf_mesh.cpp

#include "gltf_rig.hpp"
#include "ktx2.hpp"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>

#include <glm/gtc/matrix_transform.hpp>

namespace {

glm::mat4 nodeLocal(const RigNode& n) {
  glm::mat4 m = glm::translate(glm::mat4(1.0f), n.t);
  m *= glm::mat4_cast(n.r);
  m = glm::scale(m, n.s);
  return m;
}

// Synthesize a "Billow" morph for every furlable sail: a smooth wind-filled belly the animation
// controller drives per frame (see RigMorph::billowAxis). Sails ship as FLAT quads with only a
// 'Furl' morph — this adds the curve. For each Furl'd canvas submesh we take its LOCAL bounding
// box, treat the thinnest axis as the sail-plane normal, and push each vertex out along that normal
// by depth·sin(π·u)·sin(π·v) (u,v = fractional position across the two in-plane axes) → zero at all
// four edges (bent to spar/luff/foot), deepest mid-sail. Depth ≈ 11% of the chord (a realistic
// working-sail belly). The controller signs the weight by leeward direction so it curves correctly.
void synthesizeSailBillow(RiggedData& out) {
  const size_t stride = kRigFloatsPerVertex;
  std::vector<RigMorph> add;
  for (const RigMorph& furl : out.morphs) {
    if (furl.targetName != "Furl" || furl.submesh < 0) continue;
    std::string nm = out.submeshes[(size_t)furl.submesh].name;
    std::transform(nm.begin(), nm.end(), nm.begin(), [](unsigned char c){ return (char)std::tolower(c); });
    if (nm.find("sail") == std::string::npos) continue;                  // canvas nodes are 'Sail_*'
    if (nm.find("sheet") != std::string::npos || nm.find("gear") != std::string::npos) continue;  // ropes, not canvas
    const uint32_t vb = furl.vertexBase, vc = furl.vertexCount;
    if (vc < 4) continue;
    glm::vec3 lo(1e30f), hi(-1e30f);
    for (uint32_t j = 0; j < vc; ++j) {
      const float* vp = &out.vertices[(size_t)(vb + j) * stride];
      glm::vec3 p(vp[0], vp[1], vp[2]); lo = glm::min(lo, p); hi = glm::max(hi, p);
    }
    glm::vec3 ext = hi - lo;
    int thin = 0; if (ext.y < ext[thin]) thin = 1; if (ext.z < ext[thin]) thin = 2;   // plane normal axis
    int a1 = (thin + 1) % 3, a2 = (thin + 2) % 3;                                       // in-plane axes
    const float depth = 0.11f * std::min(ext[a1], ext[a2]);                             // realistic belly (~11% chord)
    glm::vec3 axis(0.0f); axis[thin] = 1.0f;
    RigMorph m; m.submesh = furl.submesh; m.target = -1; m.targetName = "Billow";
    m.vertexBase = vb; m.vertexCount = vc; m.dpos.resize(vc); m.billowAxis = axis;
    for (uint32_t j = 0; j < vc; ++j) {
      const float* vp = &out.vertices[(size_t)(vb + j) * stride];
      float u = ext[a1] > 1e-4f ? (vp[a1] - lo[a1]) / ext[a1] : 0.5f;
      float v = ext[a2] > 1e-4f ? (vp[a2] - lo[a2]) / ext[a2] : 0.5f;
      float belly = std::sin(3.14159265f * u) * std::sin(3.14159265f * v);
      m.dpos[j] = axis * (depth * belly);
    }
    add.push_back(std::move(m));
  }
  for (auto& m : add) out.morphs.push_back(std::move(m));
  if (!add.empty()) std::printf("[rig] synthesized %zu sail billow morphs\n", add.size());
}

}  // namespace

RiggedData loadGltfRigged(const char* path) {
  RiggedData out;
  out.bbMin[0] = out.bbMin[1] = out.bbMin[2] =  FLT_MAX;
  out.bbMax[0] = out.bbMax[1] = out.bbMax[2] = -FLT_MAX;

  cgltf_options options = {};
  cgltf_data* data = nullptr;
  if (cgltf_parse_file(&options, path, &data) != cgltf_result_success) {
    std::fprintf(stderr, "[rig] parse failed: %s\n", path);
    return out;
  }
  if (cgltf_load_buffers(&options, data, path) != cgltf_result_success ||
      cgltf_validate(data) != cgltf_result_success) {
    std::fprintf(stderr, "[rig] buffers/validate failed: %s\n", path);
    cgltf_free(data);
    return out;
  }

  // ── Nodes ──
  std::map<const cgltf_node*, int> nodeIndex;
  out.nodes.resize(data->nodes_count);
  for (cgltf_size i = 0; i < data->nodes_count; ++i) nodeIndex[&data->nodes[i]] = (int)i;
  for (cgltf_size i = 0; i < data->nodes_count; ++i) {
    const cgltf_node& src = data->nodes[i];
    RigNode& n = out.nodes[i];
    n.name = src.name ? src.name : "";
    n.parent = src.parent ? nodeIndex[src.parent] : -1;
    if (src.has_matrix) {
      // Decompose is overkill — vessels author TRS; but accept matrix nodes.
      glm::mat4 m;
      std::memcpy(&m, src.matrix, sizeof(float) * 16);
      n.t = glm::vec3(m[3]);
      n.s = glm::vec3(glm::length(glm::vec3(m[0])), glm::length(glm::vec3(m[1])), glm::length(glm::vec3(m[2])));
      glm::mat3 rot(glm::vec3(m[0]) / n.s.x, glm::vec3(m[1]) / n.s.y, glm::vec3(m[2]) / n.s.z);
      n.r = glm::quat_cast(rot);
    } else {
      if (src.has_translation) n.t = glm::vec3(src.translation[0], src.translation[1], src.translation[2]);
      if (src.has_rotation)    n.r = glm::quat(src.rotation[3], src.rotation[0], src.rotation[1], src.rotation[2]);
      if (src.has_scale)       n.s = glm::vec3(src.scale[0], src.scale[1], src.scale[2]);
    }
  }

  // Rest-pose node worlds.
  std::vector<glm::mat4> world(out.nodes.size(), glm::mat4(1.0f));
  {
    // Nodes are stored in arbitrary order; resolve parents iteratively.
    std::vector<bool> done(out.nodes.size(), false);
    bool progress = true;
    while (progress) {
      progress = false;
      for (size_t i = 0; i < out.nodes.size(); ++i) {
        if (done[i]) continue;
        int p = out.nodes[i].parent;
        if (p < 0 || done[(size_t)p]) {
          world[i] = (p < 0 ? glm::mat4(1.0f) : world[(size_t)p]) * nodeLocal(out.nodes[i]);
          done[i] = true;
          progress = true;
        }
      }
    }
  }

  // ── Skins ──
  std::map<const cgltf_skin*, int> skinIndex;
  uint32_t jointSlots = 0;
  std::vector<uint32_t> skinBase;   // palette base per skin (after all node slots)
  for (cgltf_size si = 0; si < data->skins_count; ++si) {
    const cgltf_skin& s = data->skins[si];
    RigSkin skin;
    for (cgltf_size j = 0; j < s.joints_count; ++j) skin.joints.push_back(nodeIndex[s.joints[j]]);
    skin.invBind.resize(s.joints_count, glm::mat4(1.0f));
    if (s.inverse_bind_matrices) {
      for (cgltf_size j = 0; j < s.joints_count; ++j) {
        float m[16];
        cgltf_accessor_read_float(s.inverse_bind_matrices, j, m, 16);
        std::memcpy(&skin.invBind[j], m, sizeof(m));
      }
    }
    skinIndex[&s] = (int)out.skins.size();
    skinBase.push_back((uint32_t)out.nodes.size() + jointSlots);
    jointSlots += (uint32_t)s.joints_count;
    out.skins.push_back(std::move(skin));
  }
  const uint32_t paletteCount = (uint32_t)out.nodes.size() + jointSlots;
  if (paletteCount > kMaxPaletteSlots) {
    std::fprintf(stderr, "[rig] %s: %u palette slots exceeds cap %u\n", path, paletteCount, kMaxPaletteSlots);
    cgltf_free(data);
    return out;
  }

  // Rest palette: node worlds, then joint skin matrices.
  out.restPalette.assign(paletteCount, glm::mat4(1.0f));
  for (size_t i = 0; i < out.nodes.size(); ++i) out.restPalette[i] = world[i];
  for (size_t si = 0; si < out.skins.size(); ++si)
    for (size_t j = 0; j < out.skins[si].joints.size(); ++j)
      out.restPalette[skinBase[si] + j] = world[(size_t)out.skins[si].joints[j]] * out.skins[si].invBind[j];

  // ── Textures (KTX2, deduped) ──
  std::vector<const cgltf_texture*> texPtrs;
  auto getTexIndex = [&](const cgltf_texture* tex, bool srgb) -> int {
    if (!tex) return -1;
    for (size_t i = 0; i < texPtrs.size(); ++i)
      if (texPtrs[i] == tex) return (int)i;
    const cgltf_image* img = (tex->has_basisu && tex->basisu_image) ? tex->basisu_image : tex->image;
    if (!img || !img->buffer_view || !img->buffer_view->buffer || !img->buffer_view->buffer->data) {
      std::fprintf(stderr, "[rig] texture '%s' has no embedded KTX2 payload — submesh falls back to defaults\n",
                   img && img->name ? img->name : "(unnamed)");
      return -1;
    }
    const cgltf_buffer_view* bv = img->buffer_view;
    TextureData td;
    td.srgb = srgb;
    if (!decodeKtx2ToRGBA((const uint8_t*)bv->buffer->data + bv->offset, bv->size, td.width, td.height, td.rgba)) {
      // A failed metallic-roughness decode is NOT cosmetic: the white fallback + glTF's default
      // metallicFactor=1 turns the whole submesh into ambient-rejecting metal (a near-black hull).
      std::fprintf(stderr, "[rig] KTX2 decode FAILED for texture '%s' (%zu bytes) — submesh falls back to defaults\n",
                   img->name ? img->name : "(unnamed)", (size_t)bv->size);
      return -1;
    }
    out.textures.push_back(std::move(td));
    texPtrs.push_back(tex);
    return (int)out.textures.size() - 1;
  };

  // ── Geometry: one submesh per (node, primitive) — scene-graph traversal ──
  for (cgltf_size ni = 0; ni < data->nodes_count; ++ni) {
    const cgltf_node& nd = data->nodes[ni];
    if (!nd.mesh) continue;
    const bool skinned = nd.skin != nullptr;
    const uint32_t jointBase = skinned ? skinBase[(size_t)skinIndex[nd.skin]] : 0;
    const glm::mat4& nodeW = world[ni];

    for (cgltf_size pi = 0; pi < nd.mesh->primitives_count; ++pi) {
      const cgltf_primitive& prim = nd.mesh->primitives[pi];
      if (prim.type != cgltf_primitive_type_triangles) continue;

      cgltf_accessor *pos = nullptr, *nrm = nullptr, *uv = nullptr, *jts = nullptr, *wts = nullptr;
      for (cgltf_size ai = 0; ai < prim.attributes_count; ++ai) {
        const cgltf_attribute& a = prim.attributes[ai];
        if (a.type == cgltf_attribute_type_position) pos = a.data;
        else if (a.type == cgltf_attribute_type_normal) nrm = a.data;
        else if (a.type == cgltf_attribute_type_texcoord && a.index == 0) uv = a.data;
        else if (a.type == cgltf_attribute_type_joints && a.index == 0) jts = a.data;
        else if (a.type == cgltf_attribute_type_weights && a.index == 0) wts = a.data;
      }
      if (!pos) continue;

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

      const uint32_t base = (uint32_t)(out.vertices.size() / kRigFloatsPerVertex);
      const cgltf_size vcount = pos->count;
      for (cgltf_size v = 0; v < vcount; ++v) {
        float p[3] = { 0, 0, 0 }, n[3] = { 0, 1, 0 }, t[2] = { 0, 0 };
        cgltf_accessor_read_float(pos, v, p, 3);
        if (nrm) cgltf_accessor_read_float(nrm, v, n, 3);
        if (uv)  cgltf_accessor_read_float(uv, v, t, 2);

        float joints[4] = { (float)ni, 0, 0, 0 };
        float weights[4] = { 1, 0, 0, 0 };
        glm::vec4 rest;   // rest-pose world position (bbox only)
        if (skinned && jts && wts) {
          cgltf_uint ji[4] = { 0, 0, 0, 0 };
          cgltf_accessor_read_uint(jts, v, ji, 4);
          cgltf_accessor_read_float(wts, v, weights, 4);
          float wsum = weights[0] + weights[1] + weights[2] + weights[3];
          if (wsum > 1e-6f) { for (float& w : weights) w /= wsum; }
          else { weights[0] = 1.0f; }
          glm::mat4 skinM(0.0f);
          for (int k = 0; k < 4; ++k) {
            joints[k] = (float)(jointBase + ji[k]);
            skinM += weights[k] * out.restPalette[jointBase + ji[k]];
          }
          rest = skinM * glm::vec4(p[0], p[1], p[2], 1.0f);
        } else {
          rest = nodeW * glm::vec4(p[0], p[1], p[2], 1.0f);
        }

        out.vertices.insert(out.vertices.end(),
          { p[0], p[1], p[2], n[0], n[1], n[2], t[0], t[1],
            albedo[0], albedo[1], albedo[2], metallic, roughness,
            joints[0], joints[1], joints[2], joints[3],
            weights[0], weights[1], weights[2], weights[3] });
        for (int c = 0; c < 3; ++c) {
          if (rest[c] < out.bbMin[c]) out.bbMin[c] = rest[c];
          if (rest[c] > out.bbMax[c]) out.bbMax[c] = rest[c];
        }
      }

      const uint32_t indexOffset = (uint32_t)out.indices.size();
      if (prim.indices) {
        for (cgltf_size i = 0; i < prim.indices->count; ++i)
          out.indices.push_back(base + (uint32_t)cgltf_accessor_read_index(prim.indices, i));
      } else {
        for (cgltf_size i = 0; i < vcount; ++i) out.indices.push_back(base + (uint32_t)i);
      }

      RigSubmesh sm;
      sm.indexOffset = indexOffset;
      sm.indexCount = (uint32_t)out.indices.size() - indexOffset;
      sm.baseColor = baseColorTex; sm.normal = normalTex; sm.metalRough = metalRoughTex;
      sm.albedo[0] = albedo[0]; sm.albedo[1] = albedo[1]; sm.albedo[2] = albedo[2];   // baseColorFactor (flag-tint gate)
      if (prim.material) {   // emissive = factor x KHR strength (lantern glass, cabin windows)
        const float es = prim.material->has_emissive_strength
                       ? prim.material->emissive_strength.emissive_strength : 1.0f;
        for (int c = 0; c < 3; ++c) sm.emissive[c] = prim.material->emissive_factor[c] * es;
      }
      sm.name = nd.name ? nd.name : (nd.mesh->name ? nd.mesh->name : "");
      sm.material = (prim.material && prim.material->name) ? prim.material->name : "";
      sm.node = (int)ni;
      sm.skinned = skinned;
      const int smIndex = (int)out.submeshes.size();
      out.submeshes.push_back(std::move(sm));

      // Morph targets: position deltas per target (sail Furl / Break morphs).
      for (cgltf_size ti = 0; ti < prim.targets_count; ++ti) {
        const cgltf_morph_target& mt = prim.targets[ti];
        for (cgltf_size ai = 0; ai < mt.attributes_count; ++ai) {
          if (mt.attributes[ai].type != cgltf_attribute_type_position) continue;
          RigMorph m;
          m.submesh = smIndex;
          m.target = (int)ti;
          if (nd.mesh->target_names && ti < nd.mesh->target_names_count && nd.mesh->target_names[ti])
            m.targetName = nd.mesh->target_names[ti];
          m.vertexBase = base;
          m.vertexCount = (uint32_t)vcount;
          m.dpos.resize(vcount);
          // unpack_floats (NOT read_float per-vertex): it applies SPARSE substitution.
          // cgltf_accessor_read_float returns 0 and writes nothing for a sparse accessor,
          // and the Blender glTF exporter stores a morph target sparsely once it moves
          // fewer than ~half the mesh's verts — so a subset-morph (e.g. the frigate's
          // per-variant gun-port lid groups) would otherwise read all-zero deltas and
          // never deform. glm::vec3 is 3 contiguous floats, so dpos packs tightly.
          if (vcount)
            cgltf_accessor_unpack_floats(mt.attributes[ai].data, &m.dpos[0].x, vcount * 3);
          out.morphs.push_back(std::move(m));
        }
      }
    }
  }

  // ── Animation clips (node TRS channels; morph-weight channels skipped — the
  //    controllers drive morphs directly, like the browser). ──
  for (cgltf_size ai = 0; ai < data->animations_count; ++ai) {
    const cgltf_animation& a = data->animations[ai];
    RigClip clip;
    clip.name = a.name ? a.name : ("clip" + std::to_string(ai));
    clip.tMin = FLT_MAX; clip.tMax = 0;
    for (cgltf_size ci = 0; ci < a.channels_count; ++ci) {
      const cgltf_animation_channel& ch = a.channels[ci];
      if (!ch.target_node || !ch.sampler) continue;
      int pathId;
      if (ch.target_path == cgltf_animation_path_type_translation) pathId = 0;
      else if (ch.target_path == cgltf_animation_path_type_rotation) pathId = 1;
      else if (ch.target_path == cgltf_animation_path_type_scale) pathId = 2;
      else continue;   // weights: driven directly by controllers
      RigChannel rc;
      rc.node = nodeIndex[ch.target_node];
      rc.path = pathId;
      rc.step = ch.sampler->interpolation == cgltf_interpolation_type_step;
      const bool cubic = ch.sampler->interpolation == cgltf_interpolation_type_cubic_spline;
      const cgltf_size n = ch.sampler->input->count;
      rc.times.resize(n);
      rc.values.resize(n, glm::vec4(0.0f));
      for (cgltf_size k = 0; k < n; ++k) {
        cgltf_accessor_read_float(ch.sampler->input, k, &rc.times[k], 1);
        // CUBICSPLINE stores in-tangent / value / out-tangent triplets — read the value.
        const cgltf_size outIdx = cubic ? k * 3 + 1 : k;
        float v[4] = { 0, 0, 0, 0 };
        cgltf_accessor_read_float(ch.sampler->output, outIdx, v, pathId == 1 ? 4 : 3);
        rc.values[k] = glm::vec4(v[0], v[1], v[2], v[3]);
      }
      if (!rc.times.empty()) {
        clip.tMin = std::min(clip.tMin, rc.times.front());
        clip.tMax = std::max(clip.tMax, rc.times.back());
      }
      clip.channels.push_back(std::move(rc));
    }
    if (clip.tMin > clip.tMax) clip.tMin = clip.tMax = 0;
    out.clips.push_back(std::move(clip));
  }

  cgltf_free(data);
  out.ok = !out.vertices.empty() && !out.indices.empty();
  synthesizeSailBillow(out);
  if (out.ok)
    std::printf("[rig] %s: %zu verts, %zu submeshes, %zu nodes, %zu skins (%u palette), %zu clips, %zu morphs\n",
                path, out.vertices.size() / kRigFloatsPerVertex, out.submeshes.size(),
                out.nodes.size(), out.skins.size(), paletteCount, out.clips.size(), out.morphs.size());
  return out;
}

RiggedData makeRiggedCube() {
  RiggedData m;
  MeshData cube = makeCubeMesh();
  const size_t n = cube.vertices.size() / kFloatsPerVertex;
  for (size_t v = 0; v < n; ++v) {
    const float* s = &cube.vertices[v * kFloatsPerVertex];
    m.vertices.insert(m.vertices.end(), s, s + kFloatsPerVertex);
    m.vertices.insert(m.vertices.end(), { 0, 0, 0, 0, 1, 0, 0, 0 });   // node 0, weight 1
  }
  m.indices = cube.indices;
  for (const Submesh& sm : cube.submeshes) {
    RigSubmesh rs;   // named fields (not a positional init) so adding a RigSubmesh member never breaks this
    rs.indexOffset = sm.indexOffset; rs.indexCount = sm.indexCount;
    rs.baseColor = sm.baseColor; rs.normal = sm.normal; rs.metalRough = sm.metalRough;
    rs.name = sm.name;
    m.submeshes.push_back(std::move(rs));
  }
  m.nodes.push_back({ "root", -1 });
  m.restPalette.assign(1, glm::mat4(1.0f));
  for (int c = 0; c < 3; ++c) { m.bbMin[c] = cube.bbMin[c]; m.bbMax[c] = cube.bbMax[c]; }
  m.ok = true;
  return m;
}
