#include "scatter.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <map>
#include <vector>

#include <glm/gtc/constants.hpp>

#include "gltf_mesh.hpp"
#include "ktx2.hpp"
#include "terrain.hpp"
#include "stb_image.h"

namespace scatter {

// ── Placement noise: exact CPU twins of scatter-compute.ts PRELUDE ────────────
static const float TAU = 6.28318530718f;
static float sfract(float v) { return v - std::floor(v); }
static float hash2(float px, float pz) {
  float qx = sfract(px * 0.1031f), qz = sfract(pz * 0.1030f);
  float d = qx * (qz + 33.33f) + qz * (qx + 33.33f);
  qx += d; qz += d;
  return sfract((qx + qz) * qx);
}
static float vnoise(float px, float pz) {
  float xi = std::floor(px), zi = std::floor(pz);
  float xf = px - xi, zf = pz - zi;
  float u = xf * xf * (3.0f - 2.0f * xf), v = zf * zf * (3.0f - 2.0f * zf);
  float a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
static float fbm2(float px, float pz) {
  float sum = 0, amp = 0.5f, freq = 1, norm = 0;
  for (int o = 0; o < 4; ++o) {
    sum += amp * vnoise(px * freq + (float)o * 19.3f, pz * freq - (float)o * 7.1f);
    norm += amp; amp *= 0.5f; freq *= 2.0f;
  }
  return sum / norm;
}
static float sstep(float a, float b, float x) {
  float t = std::clamp((x - a) / (b - a), 0.0f, 1.0f);
  return t * t * (3.0f - 2.0f * t);
}

// One instance: rows of the 3x4 world transform + tint + animation phase.
struct Inst {
  float r0[4], r1[4], r2[4];   // rotation*scale columns as row-vectors, .w = translation
  float tintPhase[4];          // rgb tint multiplier, w = per-instance phase
};
static_assert(sizeof(Inst) == 16 * sizeof(float), "instance layout");

// Compose rows from yaw/pitch/roll + per-axis scale + translation (kernel composeMat).
static Inst compose(float yaw, float pitch, float roll, float sx, float sy, float sz,
                    float px, float y, float pz, glm::vec3 tint, float phase) {
  glm::vec4 qy(0, std::sin(yaw * 0.5f), 0, std::cos(yaw * 0.5f));
  glm::vec4 qx(std::sin(pitch * 0.5f), 0, 0, std::cos(pitch * 0.5f));
  glm::vec4 qz(0, 0, std::sin(roll * 0.5f), std::cos(roll * 0.5f));
  auto qmul = [](glm::vec4 a, glm::vec4 b) {
    glm::vec3 v = a.w * glm::vec3(b) + b.w * glm::vec3(a) + glm::cross(glm::vec3(a), glm::vec3(b));
    return glm::vec4(v, a.w * b.w - glm::dot(glm::vec3(a), glm::vec3(b)));
  };
  glm::vec4 q = qmul(qy, qmul(qx, qz));
  float x = q.x, yy = q.y, z = q.z, w = q.w;
  glm::vec3 c0 = glm::vec3(1 - 2 * (yy * yy + z * z), 2 * (x * yy + w * z), 2 * (x * z - w * yy)) * sx;
  glm::vec3 c1 = glm::vec3(2 * (x * yy - w * z), 1 - 2 * (x * x + z * z), 2 * (yy * z + w * x)) * sy;
  glm::vec3 c2 = glm::vec3(2 * (x * z + w * yy), 2 * (yy * z - w * x), 1 - 2 * (x * x + yy * yy)) * sz;
  Inst i;
  i.r0[0] = c0.x; i.r0[1] = c1.x; i.r0[2] = c2.x; i.r0[3] = px;
  i.r1[0] = c0.y; i.r1[1] = c1.y; i.r1[2] = c2.y; i.r1[3] = y;
  i.r2[0] = c0.z; i.r2[1] = c1.z; i.r2[2] = c2.z; i.r2[3] = pz;
  i.tintPhase[0] = tint.r; i.tintPhase[1] = tint.g; i.tintPhase[2] = tint.b;
  i.tintPhase[3] = phase;
  return i;
}

// ── GPU plumbing ──────────────────────────────────────────────────────────────
static const char* kWGSL = R"WGSL(
struct U {
  viewProj : mat4x4<f32>,
  eye      : vec4<f32>,
  sun      : vec4<f32>,   // xyz light dir; w = daylight
  anim     : vec4<f32>,   // x time, y mode, z wind amp, w alpha cutoff
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var tex  : texture_2d<f32>;
@group(0) @binding(2) var samp : sampler;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) normal   : vec3<f32>,
  @location(2) uv       : vec2<f32>,
  @location(3) tint     : vec3<f32>,
};

@vertex
fn vs_main(@location(0) inPos : vec3<f32>, @location(1) inNrm : vec3<f32>,
           @location(2) inUV : vec2<f32>, @location(3) inAlb : vec3<f32>,
           @location(4) inMR : vec2<f32>,
           @location(5) r0 : vec4<f32>, @location(6) r1 : vec4<f32>,
           @location(7) r2 : vec4<f32>, @location(8) tintPhase : vec4<f32>) -> VSOut {
  var p = inPos;
  let mode = u.anim.y;
  let t = u.anim.x;
  let phase = tintPhase.w;
  // Animal animation in LOCAL space (bird wing flap hinged along |x|; dolphin
  // body undulation; fish tail wiggle) — ports of the client's vertex plugins.
  if (mode > 2.5 && mode < 3.5) { p.y += sin(t * 9.0 + phase) * max(abs(p.x) - 0.10, 0.0) * 0.55; }
  if (mode > 3.5 && mode < 4.5) { p.y += sin(t * 4.5 + phase + p.x * 0.9) * 0.10 * max(abs(p.x), 0.3); }
  if (mode > 4.5) { p.z += sin(t * 7.0 + phase + p.x * 2.5) * 0.06; }
  var wp = vec3<f32>(dot(vec3<f32>(r0.x, r0.y, r0.z), p) + r0.w,
                     dot(vec3<f32>(r1.x, r1.y, r1.z), p) + r1.w,
                     dot(vec3<f32>(r2.x, r2.y, r2.z), p) + r2.w);
  // Wind sway (palms mode 1, beeches mode 2): the crown leans, roots stay put.
  if (mode > 0.5 && mode < 2.5) {
    let h = max(wp.y - r1.w, 0.0);
    let amp = select(0.020, 0.045, mode < 1.5) * u.anim.z;
    let b = sin(t * select(1.6, 1.1, mode < 1.5) + phase) * amp * h * h * 0.06;
    wp.x += b; wp.z += b * 0.6;
  }
  var o : VSOut;
  o.position = u.viewProj * vec4<f32>(wp, 1.0);
  o.worldPos = wp;
  o.normal = normalize(vec3<f32>(dot(vec3<f32>(r0.x, r0.y, r0.z), inNrm),
                                 dot(vec3<f32>(r1.x, r1.y, r1.z), inNrm),
                                 dot(vec3<f32>(r2.x, r2.y, r2.z), inNrm)));
  o.uv = inUV;
  o.tint = inAlb * vec3<f32>(tintPhase.x, tintPhase.y, tintPhase.z);
  return o;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let c = textureSample(tex, samp, in.uv);
  if (u.anim.w > 0.0 && c.a < u.anim.w) { discard; }
  var col = c.rgb * in.tint;
  let L = normalize(u.sun.xyz);
  var N = normalize(in.normal);
  if (dot(N, u.eye.xyz - in.worldPos) < 0.0) { N = -N; }   // double-sided fronds
  let diff = max(dot(N, L), 0.0);
  col = col * (0.38 + 0.62 * diff);
  let dayK = u.sun.w;
  col = col * mix(0.13, 1.0, dayK) * mix(vec3<f32>(0.48, 0.58, 0.82), vec3<f32>(1.0), dayK);
  return vec4<f32>(col, 1.0);
}
)WGSL";

struct Variant {
  WGPUBuffer vbuf = nullptr, ibuf = nullptr, instBuf = nullptr;
  uint32_t indexCount = 0, instCap = 0, instCount = 0;
  WGPUBindGroup bind = nullptr;
};

// A scatter layer: one placement kernel + N mesh variants + an animation mode.
struct Layer {
  std::vector<Variant> variants;
  WGPUBuffer ubuf = nullptr;
  float mode = 0, alphaCut = 0;
  int res = 0;                                 // kernel candidates per patch edge
  std::map<std::pair<int, int>, std::vector<std::vector<Inst>>> patches;   // patch -> per-variant
  bool dirty = false;
};

struct System::Impl {
  WGPUDevice device = nullptr;
  WGPUQueue queue = nullptr;
  WGPURenderPipeline pipeline = nullptr;
  WGPUBindGroupLayout bgl = nullptr;
  WGPUSampler samp = nullptr;
  WGPUTextureView whiteView = nullptr;
  const terrain::Terrain* terr = nullptr;
  bool ready = false;

  Layer palms, trees, rocks, drift;            // static, patch-streamed
  Layer birds, dolphins, fish;                 // living, CPU-pathed
  int lastPX = INT32_MIN, lastPZ = INT32_MIN;  // patch origin of the last stream

  static constexpr float PATCH = 40.0f;        // metres (client)
  static constexpr int   RINGS = 8;            // patch radius (client quality default)

  // ── Animal state ──
  struct Bird { float cx, cz, r, alt, w, ph; };
  std::vector<Bird> birdStates;
  struct Pod { float cx, cz, heading; float ph[5]; int n; };
  Pod pod{};
  struct School { float cx, cz, r, w, y; int n; float ph; };
  std::vector<School> schools;
  double animSeed = 0;

  float ground(float x, float z) const { return terr ? terr->elevation(x, z) : -1000.0f; }
  float slope(float x, float z) const {
    const float e = 2.0f;
    float gx = ground(x + e, z) - ground(x - e, z);
    float gz = ground(x, z + e) - ground(x, z - e);
    return std::hypot(gx, gz) / (2.0f * e);
  }
  bool nearShore(float x, float z, float minDist) const {
    for (int r = 1; r <= 3; ++r) {
      float d = ((float)r / 3.0f) * minDist;
      for (int i = 0; i < 8; ++i) {
        float a = ((float)i / 8.0f) * TAU + (float)r * 0.4f;
        if (ground(x + std::cos(a) * d, z + std::sin(a) * d) <= 0.4f) return true;
      }
    }
    return false;
  }
};
using Impl = System::Impl;   // free helpers below refer to the nested type

System::System() : p_(std::make_unique<Impl>()) {}
System::~System() = default;

// Upload a mesh variant's vertex/index buffers.
static void uploadVariantMesh(Impl* p, Variant& v, const MeshData& md) {
  WGPUBufferDescriptor vbd = {};
  vbd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
  vbd.size = md.vertices.size() * sizeof(float);
  v.vbuf = wgpuDeviceCreateBuffer(p->device, &vbd);
  wgpuQueueWriteBuffer(p->queue, v.vbuf, 0, md.vertices.data(), vbd.size);
  WGPUBufferDescriptor ibd = {};
  ibd.usage = WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
  ibd.size = md.indices.size() * sizeof(uint32_t);
  v.ibuf = wgpuDeviceCreateBuffer(p->device, &ibd);
  wgpuQueueWriteBuffer(p->queue, v.ibuf, 0, md.indices.data(), ibd.size);
  v.indexCount = (uint32_t)md.indices.size();
}

static WGPUTextureView makeTexView(Impl* p, int w, int h, const uint8_t* rgba, bool srgb) {
  WGPUTextureDescriptor td = {};
  td.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
  td.dimension = WGPUTextureDimension_2D;
  td.size = { (uint32_t)w, (uint32_t)h, 1 };
  td.format = srgb ? WGPUTextureFormat_RGBA8UnormSrgb : WGPUTextureFormat_RGBA8Unorm;
  td.mipLevelCount = 1; td.sampleCount = 1;
  WGPUTexture tex = wgpuDeviceCreateTexture(p->device, &td);
  WGPUImageCopyTexture dst = {}; dst.texture = tex; dst.aspect = WGPUTextureAspect_All;
  WGPUTextureDataLayout dl = {}; dl.bytesPerRow = (uint32_t)w * 4; dl.rowsPerImage = (uint32_t)h;
  WGPUExtent3D ext = { (uint32_t)w, (uint32_t)h, 1 };
  wgpuQueueWriteTexture(p->queue, &dst, rgba, (size_t)w * h * 4, &dl, &ext);
  return wgpuTextureCreateView(tex, nullptr);
}

static WGPUTextureView loadPngView(Impl* p, const std::string& path) {
  int w = 0, h = 0, c = 0;
  unsigned char* px = stbi_load(path.c_str(), &w, &h, &c, 4);
  if (!px) return nullptr;
  WGPUTextureView v = makeTexView(p, w, h, px, true);
  stbi_image_free(px);
  return v;
}

static WGPUTextureView loadKtx2View(Impl* p, const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return nullptr;
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  int w = 0, h = 0; std::vector<uint8_t> rgba;
  if (!decodeKtx2ToRGBA(bytes.data(), bytes.size(), w, h, rgba)) return nullptr;
  return makeTexView(p, w, h, rgba.data(), true);
}

static void buildVariantBind(Impl* p, Layer& l, Variant& v, WGPUTextureView tex) {
  WGPUBindGroupEntry be[3] = {};
  be[0].binding = 0; be[0].buffer = l.ubuf; be[0].size = sizeof(glm::mat4) + 3 * sizeof(glm::vec4);
  be[1].binding = 1; be[1].textureView = tex ? tex : p->whiteView;
  be[2].binding = 2; be[2].sampler = p->samp;
  WGPUBindGroupDescriptor bgd = {}; bgd.layout = p->bgl; bgd.entryCount = 3; bgd.entries = be;
  v.bind = wgpuDeviceCreateBindGroup(p->device, &bgd);
}

bool System::init(WGPUDevice device, WGPUQueue queue, WGPUTextureFormat colorFormat,
                  const std::string& dir) {
  Impl* p = p_.get();
  p->device = device; p->queue = queue;

  // ── Pipeline ──
  WGPUShaderModuleWGSLDescriptor wgsl = {};
  wgsl.chain.sType = WGPUSType_ShaderModuleWGSLDescriptor;
  wgsl.code = kWGSL;
  WGPUShaderModuleDescriptor smd = {}; smd.nextInChain = &wgsl.chain;
  WGPUShaderModule module = wgpuDeviceCreateShaderModule(device, &smd);

  WGPUBindGroupLayoutEntry ble[3] = {};
  ble[0].binding = 0; ble[0].visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
  ble[0].buffer.type = WGPUBufferBindingType_Uniform;
  ble[1].binding = 1; ble[1].visibility = WGPUShaderStage_Fragment;
  ble[1].texture.sampleType = WGPUTextureSampleType_Float;
  ble[1].texture.viewDimension = WGPUTextureViewDimension_2D;
  ble[2].binding = 2; ble[2].visibility = WGPUShaderStage_Fragment;
  ble[2].sampler.type = WGPUSamplerBindingType_Filtering;
  WGPUBindGroupLayoutDescriptor bgld = {}; bgld.entryCount = 3; bgld.entries = ble;
  p->bgl = wgpuDeviceCreateBindGroupLayout(device, &bgld);
  WGPUPipelineLayoutDescriptor pld = {}; pld.bindGroupLayoutCount = 1; pld.bindGroupLayouts = &p->bgl;
  WGPUPipelineLayout pl = wgpuDeviceCreatePipelineLayout(device, &pld);

  WGPUVertexAttribute ma[5] = {};
  ma[0] = { WGPUVertexFormat_Float32x3, 0, 0 };
  ma[1] = { WGPUVertexFormat_Float32x3, 3 * 4, 1 };
  ma[2] = { WGPUVertexFormat_Float32x2, 6 * 4, 2 };
  ma[3] = { WGPUVertexFormat_Float32x3, 8 * 4, 3 };
  ma[4] = { WGPUVertexFormat_Float32x2, 11 * 4, 4 };
  WGPUVertexAttribute ia[4] = {};
  ia[0] = { WGPUVertexFormat_Float32x4, 0, 5 };
  ia[1] = { WGPUVertexFormat_Float32x4, 4 * 4, 6 };
  ia[2] = { WGPUVertexFormat_Float32x4, 8 * 4, 7 };
  ia[3] = { WGPUVertexFormat_Float32x4, 12 * 4, 8 };
  WGPUVertexBufferLayout vbls[2] = {};
  vbls[0].arrayStride = kFloatsPerVertex * sizeof(float);
  vbls[0].stepMode = WGPUVertexStepMode_Vertex;
  vbls[0].attributeCount = 5; vbls[0].attributes = ma;
  vbls[1].arrayStride = 16 * sizeof(float);
  vbls[1].stepMode = WGPUVertexStepMode_Instance;
  vbls[1].attributeCount = 4; vbls[1].attributes = ia;

  WGPUDepthStencilState ds = {};
  ds.format = WGPUTextureFormat_Depth24PlusStencil8;
  ds.depthWriteEnabled = true; ds.depthCompare = WGPUCompareFunction_Less;
  ds.stencilFront.compare = WGPUCompareFunction_Always;
  ds.stencilFront.failOp = WGPUStencilOperation_Keep;
  ds.stencilFront.depthFailOp = WGPUStencilOperation_Keep;
  ds.stencilFront.passOp = WGPUStencilOperation_Keep;
  ds.stencilBack = ds.stencilFront;
  ds.stencilReadMask = 0xFFFFFFFFu; ds.stencilWriteMask = 0xFFFFFFFFu;
  WGPUColorTargetState target = {}; target.format = colorFormat; target.writeMask = WGPUColorWriteMask_All;
  WGPUFragmentState frag = {}; frag.module = module; frag.entryPoint = "fs_main";
  frag.targetCount = 1; frag.targets = &target;
  WGPURenderPipelineDescriptor rpd = {};
  rpd.layout = pl;
  rpd.vertex.module = module; rpd.vertex.entryPoint = "vs_main";
  rpd.vertex.bufferCount = 2; rpd.vertex.buffers = vbls;
  rpd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
  rpd.primitive.cullMode = WGPUCullMode_None;   // fronds/wings are double-sided
  rpd.depthStencil = &ds; rpd.multisample.count = 1; rpd.multisample.mask = 0xFFFFFFFFu;
  rpd.fragment = &frag;
  p->pipeline = wgpuDeviceCreateRenderPipeline(device, &rpd);
  wgpuPipelineLayoutRelease(pl);

  WGPUSamplerDescriptor sd = {};
  sd.addressModeU = WGPUAddressMode_Repeat; sd.addressModeV = WGPUAddressMode_Repeat;
  sd.addressModeW = WGPUAddressMode_Repeat;
  sd.magFilter = WGPUFilterMode_Linear; sd.minFilter = WGPUFilterMode_Linear;
  sd.mipmapFilter = WGPUMipmapFilterMode_Nearest; sd.lodMaxClamp = 0.0f; sd.maxAnisotropy = 1;
  p->samp = wgpuDeviceCreateSampler(device, &sd);
  const uint8_t white[4] = { 255, 255, 255, 255 };
  p->whiteView = makeTexView(p, 1, 1, white, true);

  // ── Load a layer's variants: GLB meshes + a texture policy ──
  auto initLayer = [&](Layer& l, float mode, float alphaCut, int res,
                       const std::vector<std::string>& glbs,
                       const std::vector<std::string>& texPaths,   // per variant ("" = embedded/white)
                       uint32_t instCap) -> bool {
    l.mode = mode; l.alphaCut = alphaCut; l.res = res;
    WGPUBufferDescriptor ubd = {};
    ubd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    ubd.size = sizeof(glm::mat4) + 3 * sizeof(glm::vec4);
    l.ubuf = wgpuDeviceCreateBuffer(device, &ubd);
    for (size_t i = 0; i < glbs.size(); ++i) {
      MeshData md = loadGltfMesh((dir + "/" + glbs[i]).c_str());
      if (!md.ok) { std::printf("[scatter] missing %s\n", glbs[i].c_str()); continue; }
      Variant v;
      uploadVariantMesh(p, v, md);
      v.instCap = instCap;
      WGPUBufferDescriptor ibd2 = {};
      ibd2.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
      ibd2.size = (uint64_t)instCap * sizeof(Inst);
      v.instBuf = wgpuDeviceCreateBuffer(device, &ibd2);
      // Texture: explicit path (png/ktx2) > first embedded sRGB map > white.
      WGPUTextureView tv = nullptr;
      if (i < texPaths.size() && !texPaths[i].empty()) {
        const std::string& tp = texPaths[i];
        tv = tp.size() > 5 && tp.substr(tp.size() - 5) == ".ktx2" ? loadKtx2View(p, tp) : loadPngView(p, tp);
      } else {
        for (size_t t = 0; t < md.textures.size(); ++t)
          if (md.textures[t].srgb) {
            tv = makeTexView(p, md.textures[t].width, md.textures[t].height, md.textures[t].rgba.data(), true);
            break;
          }
      }
      buildVariantBind(p, l, v, tv);
      l.variants.push_back(v);
    }
    return !l.variants.empty();
  };

  const std::string T = dir + "/textures/";
  bool ok = true;
  ok &= initLayer(p->palms, 1, 0.5f, 14, { "palm_a.glb", "palm_b.glb", "palm_c.glb" }, {}, 4000);
  ok &= initLayer(p->trees, 2, 0.5f, 16, { "beech_a.glb", "beech_b.glb", "beech_c.glb" }, {}, 4000);
  ok &= initLayer(p->rocks, 0, 0.0f, 24,
                  { "rock_a.glb", "rock_b.glb", "rock_c.glb", "rock_d.glb", "rock_e.glb" },
                  { T + "rock_04_albedo.ktx2", T + "rock_05_albedo.ktx2", T + "rock_cracked_albedo.ktx2",
                    T + "rock_04_albedo.ktx2", T + "rock_05_albedo.ktx2" }, 6000);
  ok &= initLayer(p->drift, 0, 0.0f, 20,
                  { "drift_a.glb", "drift_b.glb", "drift_c.glb", "drift_d.glb", "drift_e.glb" },
                  { T + "drift_albedo.png", T + "drift_albedo.png", T + "drift_albedo.png",
                    T + "drift_albedo.png", T + "drift_albedo.png" }, 3000);
  ok &= initLayer(p->birds, 3, 0.5f, 0, { "bird_a.glb", "bird_b.glb", "bird_c.glb" },
                  { T + "bird_atlas.png", T + "bird_atlas.png", T + "bird_atlas.png" }, 64);
  ok &= initLayer(p->dolphins, 4, 0.0f, 0, { "dolphin_a.glb", "dolphin_b.glb", "dolphin_c.glb" },
                  { T + "dolphin_atlas.png", T + "dolphin_atlas.png", T + "dolphin_atlas.png" }, 16);
  ok &= initLayer(p->fish, 5, 0.5f, 0, { "fish_a.glb", "fish_b.glb" },
                  { T + "fish_atlas.png", T + "fish_atlas.png" }, 128);

  p->ready = ok;
  std::printf("[scatter] %s (palms %zu, trees %zu, rocks %zu, drift %zu, birds %zu, dolphins %zu, fish %zu)\n",
              ok ? "ready" : "INCOMPLETE",
              p->palms.variants.size(), p->trees.variants.size(), p->rocks.variants.size(),
              p->drift.variants.size(), p->birds.variants.size(), p->dolphins.variants.size(),
              p->fish.variants.size());
  return ok;
}

void System::setTerrain(const terrain::Terrain* terr) { p_->terr = terr; }

// ── Placement kernels: CPU twins of ROCKS/DRIFT/TREES/PALMS_WGSL ─────────────
static void placePatch(Impl* p, Layer& l, int pxi, int pzi,
                       void (*kernel)(Impl*, Layer&, float, float, std::vector<std::vector<Inst>>&)) {
  auto key = std::make_pair(pxi, pzi);
  if (l.patches.count(key)) return;
  std::vector<std::vector<Inst>> per(l.variants.size());
  float cx = ((float)pxi + 0.5f) * Impl::PATCH, cz = ((float)pzi + 0.5f) * Impl::PATCH;
  for (int gz = 0; gz < l.res; ++gz)
    for (int gx = 0; gx < l.res; ++gx) {
      float cell = Impl::PATCH / (float)l.res;
      float wx = cx + ((float)gx + hash2(cx + gx * 12.9f, cz + gz * 78.2f)) * cell - Impl::PATCH * 0.5f;
      float wz = cz + ((float)gz + hash2(cx + gx * 39.3f + 7.1f, cz + gz * 11.7f - 3.3f)) * cell - Impl::PATCH * 0.5f;
      kernel(p, l, wx, wz, per);
    }
  l.patches.emplace(key, std::move(per));
  l.dirty = true;
}

// Variant index for a candidate (the kernels' dealtAway spreads variants).
static int variantOf(const Layer& l, float px, float pz) {
  return (int)(hash2(px * 0.71f + 50.0f, pz * 0.67f - 50.0f) * (float)l.variants.size())
         % (int)l.variants.size();
}

static void palmKernel(Impl* p, Layer& l, float px, float pz, std::vector<std::vector<Inst>>& out) {
  float y = p->ground(px, pz);
  if (y < 0.6f || y > 45.0f) return;
  float sl = p->slope(px, pz);
  if (sl > 0.5f) return;
  float stand = fbm2(px / 28.0f + 60.0f, pz / 28.0f - 40.0f);
  float dens = sstep(0.48f, 0.80f, stand) * (1.0f - sl * 0.6f) * 0.95f;
  if (hash2(px * 3.1f + 1.7f, pz * 2.9f - 3.3f) > dens) return;
  if (p->nearShore(px, pz, 7.0f)) return;
  float s = 0.92f + hash2(px * 5.3f - 2.0f, pz * 4.7f + 8.0f) * 0.16f;
  float yaw = hash2(px * 1.13f + 7.0f, pz * 1.07f - 7.0f) * TAU;
  out[variantOf(l, px, pz)].push_back(
      compose(yaw, 0, 0, s, s, s, px, y - 0.35f, pz, glm::vec3(1.0f), hash2(px, pz) * TAU));
}

static void treeKernel(Impl* p, Layer& l, float px, float pz, std::vector<std::vector<Inst>>& out) {
  float y = p->ground(px, pz);
  if (y < 0.6f || y > 80.0f) return;
  float sl = p->slope(px, pz);
  if (sl > 0.5f) return;
  float stand = fbm2(px / 45.0f, pz / 45.0f);
  float clearing = fbm2(px / 13.0f + 9.0f, pz / 13.0f - 4.0f);
  float dens = sstep(0.46f, 0.72f, stand) * sstep(0.4f, 0.62f, clearing) * (1.0f - sl * 0.8f) * 0.18f;
  if (hash2(px * 3.1f + 1.7f, pz * 2.9f - 3.3f) > dens) return;
  if (p->nearShore(px, pz, 7.0f)) return;
  float s = 0.9f + hash2(px * 5.3f - 2.0f, pz * 4.7f + 8.0f) * 0.22f;
  float yaw = hash2(px * 1.13f + 7.0f, pz * 1.07f - 7.0f) * TAU;
  out[variantOf(l, px, pz)].push_back(
      compose(yaw, 0, 0, s, s, s, px, y - 0.35f, pz, glm::vec3(1.0f), hash2(px, pz) * TAU));
}

static const glm::vec3 kRockTints[6] = {
  { 1.00f, 1.00f, 1.00f }, { 0.92f, 0.90f, 0.87f }, { 0.87f, 0.89f, 0.93f },
  { 1.00f, 0.97f, 0.92f }, { 0.91f, 0.93f, 0.90f }, { 0.96f, 0.96f, 0.99f } };
static const glm::vec3 kDriftTints[6] = {
  { 1.00f, 1.00f, 1.02f }, { 1.02f, 1.00f, 0.96f }, { 0.96f, 0.93f, 0.88f },
  { 0.90f, 0.86f, 0.80f }, { 0.97f, 0.94f, 0.88f }, { 0.86f, 0.88f, 0.90f } };

static void rockKernel(Impl* p, Layer& l, float px, float pz, std::vector<std::vector<Inst>>& out) {
  float y = p->ground(px, pz);
  if (y < 0.25f || y > 150.0f) return;
  float sl = p->slope(px, pz);
  if (sl > 0.85f) return;
  float clump = fbm2(px / 18.0f, pz / 18.0f);
  float beach = 1.0f - sstep(7.0f, 14.0f, y);
  float upland = sstep(12.0f, 45.0f, y);
  float bandMul = 0.45f + 0.55f * beach + 0.6f * upland;
  float dens = (0.004f + 0.085f * sstep(0.60f, 0.82f, clump)) * bandMul * (1.0f - sl * 0.4f);
  if (hash2(px * 3.1f + 1.7f, pz * 2.9f - 3.3f) > dens) return;
  float r = hash2(px * 5.3f - 2.0f, pz * 4.7f + 8.0f);
  float base = 0.25f + hash2(px * 6.1f + 9.0f, pz * 6.1f - 9.0f) * 0.4f;
  if (r < 0.05f) base = 1.8f + hash2(px * 2.2f, pz * 2.2f) * 1.7f;
  else if (r < 0.30f) base = 0.7f + hash2(px * 1.9f + 3.0f, pz * 1.9f - 3.0f) * 0.7f;
  float sx = base * (0.85f + hash2(px * 7.7f, pz * 1.3f) * 0.35f);
  float sy = base * (0.60f + hash2(px * 1.3f, pz * 7.7f) * 0.40f);
  float sz = base * (0.85f + hash2(px * 3.7f, pz * 9.1f) * 0.35f);
  float yaw = hash2(px * 1.11f + 4.0f, pz * 1.07f - 4.0f) * TAU;
  float pitch = (hash2(px * 2.3f, pz * 5.1f) - 0.5f) * 0.5f;
  float roll = (hash2(px * 5.1f, pz * 2.3f) - 0.5f) * 0.5f;
  int ti = (int)(hash2(px * 0.9f - 11.0f, pz * 0.9f + 11.0f) * 6.0f) % 6;
  out[variantOf(l, px, pz)].push_back(
      compose(yaw, pitch, roll, sx, sy, sz, px, y - base * 0.1f, pz, kRockTints[ti], 0));
}

static void driftKernel(Impl* p, Layer& l, float px, float pz, std::vector<std::vector<Inst>>& out) {
  float y = p->ground(px, pz);
  if (y < 0.25f || y > 7.0f) return;
  float sl = p->slope(px, pz);
  if (sl > 0.75f) return;
  float clump = fbm2(px / 16.0f + 40.0f, pz / 16.0f - 22.0f);
  float dens = (0.004f + 0.07f * sstep(0.60f, 0.82f, clump)) * (1.0f - sl * 0.4f);
  if (hash2(px * 3.1f + 1.7f, pz * 2.9f - 3.3f) > dens) return;
  float r = hash2(px * 5.3f - 2.0f, pz * 4.7f + 8.0f);
  float s = 0.45f + hash2(px * 6.1f + 9.0f, pz * 6.1f - 9.0f) * 0.25f;
  if (r < 0.15f) s = 1.2f + hash2(px * 2.2f, pz * 2.2f) * 0.6f;
  else if (r < 0.70f) s = 0.7f + hash2(px * 1.9f + 3.0f, pz * 1.9f - 3.0f) * 0.5f;
  float yaw = hash2(px * 1.11f + 4.0f, pz * 1.07f - 4.0f) * TAU;
  float pitch = (hash2(px * 2.3f, pz * 5.1f) - 0.5f) * 0.3f;
  float roll = (hash2(px * 5.1f, pz * 2.3f) - 0.5f) * 0.3f;
  int ti = (int)(hash2(px * 0.9f - 11.0f, pz * 0.9f + 11.0f) * 6.0f) % 6;
  out[variantOf(l, px, pz)].push_back(
      compose(yaw, pitch, roll, s, s, s, px, y - 0.03f, pz, kDriftTints[ti], 0));
}

// Rebuild a layer's concatenated per-variant instance buffers from its patches.
static void flushLayer(Impl* p, Layer& l) {
  if (!l.dirty) return;
  l.dirty = false;
  std::vector<std::vector<Inst>> all(l.variants.size());
  for (const auto& [k, per] : l.patches)
    for (size_t v = 0; v < per.size() && v < all.size(); ++v)
      all[v].insert(all[v].end(), per[v].begin(), per[v].end());
  for (size_t v = 0; v < l.variants.size(); ++v) {
    Variant& var = l.variants[v];
    var.instCount = std::min((uint32_t)all[v].size(), var.instCap);
    if (var.instCount)
      wgpuQueueWriteBuffer(p->queue, var.instBuf, 0, all[v].data(), (uint64_t)var.instCount * sizeof(Inst));
  }
}

void System::update(WGPUDevice, WGPUQueue, float dt, double timeSec, float shipX, float shipZ) {
  Impl* p = p_.get();
  if (!p->ready || !p->terr) return;

  // ── Static layers: stream patches around the ship (incremental, drop far). ──
  int px = (int)std::floor(shipX / Impl::PATCH), pz = (int)std::floor(shipZ / Impl::PATCH);
  if (px != p->lastPX || pz != p->lastPZ) {
    p->lastPX = px; p->lastPZ = pz;
    struct { Layer* l; void (*k)(Impl*, Layer&, float, float, std::vector<std::vector<Inst>>&); } layers[] = {
      { &p->palms, palmKernel }, { &p->trees, treeKernel },
      { &p->rocks, rockKernel }, { &p->drift, driftKernel },
    };
    for (auto& L : layers) {
      for (int dz = -Impl::RINGS; dz <= Impl::RINGS; ++dz)
        for (int dx = -Impl::RINGS; dx <= Impl::RINGS; ++dx)
          placePatch(p, *L.l, px + dx, pz + dz, L.k);
      // Drop patches beyond the ring (+1 hysteresis).
      for (auto it = L.l->patches.begin(); it != L.l->patches.end();) {
        if (std::abs(it->first.first - px) > Impl::RINGS + 1 ||
            std::abs(it->first.second - pz) > Impl::RINGS + 1) {
          it = L.l->patches.erase(it); L.l->dirty = true;
        } else ++it;
      }
      flushLayer(p, *L.l);
    }
  }

  // ── Living layers ──
  float t = (float)timeSec;
  // Seagull flocks: 3 flocks circling coastal anchors near the ship; re-anchor
  // when the ship sails far away.
  if (p->birdStates.empty()) {
    for (int f = 0; f < 3; ++f)
      for (int b = 0; b < 5; ++b)
        p->birdStates.push_back({ shipX + 100.0f * (f - 1), shipZ + 80.0f * (f - 1),
                                  18.0f + 8.0f * b, 16.0f + 7.0f * f + 1.5f * b,
                                  0.45f + 0.06f * b, (float)b * 1.7f + (float)f * 2.9f });
  }
  std::vector<std::vector<Inst>> birdInst(p->birds.variants.size());
  for (size_t i = 0; i < p->birdStates.size(); ++i) {
    Impl::Bird& b = p->birdStates[i];
    float dShip = std::hypot(b.cx - shipX, b.cz - shipZ);
    if (dShip > 900.0f) {   // drifted out of view: re-anchor near the ship
      b.cx = shipX + (hash2((float)i * 3.1f, t) - 0.5f) * 500.0f;
      b.cz = shipZ + (hash2(t, (float)i * 7.7f) - 0.5f) * 500.0f;
    }
    float a = t * b.w + b.ph;
    float x = b.cx + std::cos(a) * b.r, z = b.cz + std::sin(a) * b.r;
    float y = b.alt + std::sin(t * 0.7f + b.ph) * 2.0f;
    float yaw = -a - glm::half_pi<float>();   // tangent heading (bird bow +Z-ish)
    if (!p->birds.variants.empty())
      birdInst[i % p->birds.variants.size()].push_back(
          compose(yaw, 0, 0.18f, 1, 1, 1, x, y, z, glm::vec3(1.0f), b.ph));
  }
  for (size_t v = 0; v < p->birds.variants.size(); ++v) {
    Variant& var = p->birds.variants[v];
    var.instCount = std::min((uint32_t)birdInst[v].size(), var.instCap);
    if (var.instCount)
      wgpuQueueWriteBuffer(p->queue, var.instBuf, 0, birdInst[v].data(), (uint64_t)var.instCount * sizeof(Inst));
  }

  // Dolphin pod: porpoising arcs alongside the ship over deep water.
  if (p->pod.n == 0) {
    p->pod.n = 4;
    for (int i = 0; i < p->pod.n; ++i) p->pod.ph[i] = (float)i * 1.9f;
    p->pod.cx = shipX + 60; p->pod.cz = shipZ;
  }
  {
    // The pod idles in slow circles ~80 m off the ship, re-homing when left behind.
    float dShip = std::hypot(p->pod.cx - shipX, p->pod.cz - shipZ);
    if (dShip > 700.0f) { p->pod.cx = shipX + 90; p->pod.cz = shipZ + 40; }
    p->pod.heading = t * 0.22f;
    std::vector<std::vector<Inst>> podInst(p->dolphins.variants.size());
    for (int i = 0; i < p->pod.n; ++i) {
      float a = p->pod.heading + (float)i * 0.35f;
      float R = 34.0f + 5.0f * (float)i;
      float x = p->pod.cx + std::cos(a) * R, z = p->pod.cz + std::sin(a) * R;
      if (p->ground(x, z) > -6.0f) continue;   // dolphins keep to deep water
      float leap = std::sin(t * 1.4f + p->pod.ph[i]);
      float y = -0.7f + 1.5f * std::max(0.0f, leap);            // porpoise arc through the surface
      float pitch = -std::cos(t * 1.4f + p->pod.ph[i]) * 0.55f * (leap > -0.2f ? 1.0f : 0.2f);
      float yaw = -a - glm::half_pi<float>();
      if (!p->dolphins.variants.empty())
        podInst[i % p->dolphins.variants.size()].push_back(
            compose(yaw, pitch, 0, 1, 1, 1, x, y, z, glm::vec3(1.0f), p->pod.ph[i]));
    }
    for (size_t v = 0; v < p->dolphins.variants.size(); ++v) {
      Variant& var = p->dolphins.variants[v];
      var.instCount = std::min((uint32_t)podInst[v].size(), var.instCap);
      if (var.instCount)
        wgpuQueueWriteBuffer(p->queue, var.instBuf, 0, podInst[v].data(), (uint64_t)var.instCount * sizeof(Inst));
    }
  }

  // Fish schools: tight circling rings just under the surface of the shallows —
  // visible through the transparent water.
  if (p->schools.empty()) {
    for (int i = 0; i < 3; ++i)
      p->schools.push_back({ shipX, shipZ, 3.5f + (float)i, 0.9f - 0.15f * (float)i, -1.3f, 10, (float)i * 2.3f });
  }
  std::vector<std::vector<Inst>> fishInst(p->fish.variants.size());
  for (size_t si = 0; si < p->schools.size(); ++si) {
    Impl::School& sc = p->schools[si];
    float dShip = std::hypot(sc.cx - shipX, sc.cz - shipZ);
    // Schools live where the water is 2-9 m deep; re-seed nearby when out of range.
    float g = p->ground(sc.cx, sc.cz);
    if (dShip > 400.0f || g > -1.5f || g < -12.0f) {
      bool found = false;
      for (int tries = 0; tries < 24 && !found; ++tries) {
        float ax = shipX + (hash2((float)tries * 3.7f + (float)si, t) - 0.5f) * 320.0f;
        float az = shipZ + (hash2(t + (float)si * 13.7f, (float)tries * 9.1f) - 0.5f) * 320.0f;
        float ag = p->ground(ax, az);
        if (ag < -2.0f && ag > -9.0f) { sc.cx = ax; sc.cz = az; found = true; }
      }
      if (!found) continue;
    }
    for (int i = 0; i < sc.n; ++i) {
      float a = t * sc.w + sc.ph + (float)i * (TAU / (float)sc.n);
      float x = sc.cx + std::cos(a) * sc.r, z = sc.cz + std::sin(a) * sc.r;
      float yaw = -a - glm::half_pi<float>();
      if (!p->fish.variants.empty())
        fishInst[i % p->fish.variants.size()].push_back(
            compose(yaw, 0, 0, 0.8f, 0.8f, 0.8f, x, sc.y + 0.15f * std::sin(a * 3.0f), z,
                    glm::vec3(1.0f), sc.ph + (float)i));
    }
  }
  for (size_t v = 0; v < p->fish.variants.size(); ++v) {
    Variant& var = p->fish.variants[v];
    var.instCount = std::min((uint32_t)fishInst[v].size(), var.instCap);
    if (var.instCount)
      wgpuQueueWriteBuffer(p->queue, var.instBuf, 0, fishInst[v].data(), (uint64_t)var.instCount * sizeof(Inst));
  }
  (void)dt;
}

void System::draw(WGPURenderPassEncoder pass, WGPUQueue queue, const glm::mat4& viewProj,
                  const glm::vec3& eye, const glm::vec3& lightDir, float dayK,
                  double timeSec, float windAmp) {
  Impl* p = p_.get();
  if (!p->ready) return;
  struct LU { glm::mat4 vp; glm::vec4 eye, sun, anim; };
  Layer* layers[] = { &p->palms, &p->trees, &p->rocks, &p->drift, &p->birds, &p->dolphins, &p->fish };
  bool bound = false;
  for (Layer* l : layers) {
    uint32_t total = 0;
    for (const Variant& v : l->variants) total += v.instCount;
    if (!total) continue;
    LU u{ viewProj, glm::vec4(eye, 1.0f), glm::vec4(lightDir, dayK),
          glm::vec4((float)timeSec, l->mode, windAmp, l->alphaCut) };
    wgpuQueueWriteBuffer(queue, l->ubuf, 0, &u, sizeof(u));
    if (!bound) { wgpuRenderPassEncoderSetPipeline(pass, p->pipeline); bound = true; }
    for (const Variant& v : l->variants) {
      if (!v.instCount) continue;
      wgpuRenderPassEncoderSetBindGroup(pass, 0, v.bind, 0, nullptr);
      wgpuRenderPassEncoderSetVertexBuffer(pass, 0, v.vbuf, 0, WGPU_WHOLE_SIZE);
      wgpuRenderPassEncoderSetVertexBuffer(pass, 1, v.instBuf, 0, WGPU_WHOLE_SIZE);
      wgpuRenderPassEncoderSetIndexBuffer(pass, v.ibuf, WGPUIndexFormat_Uint32, 0, WGPU_WHOLE_SIZE);
      wgpuRenderPassEncoderDrawIndexed(pass, v.indexCount, v.instCount, 0, 0, 0);
    }
  }
}

} // namespace scatter
