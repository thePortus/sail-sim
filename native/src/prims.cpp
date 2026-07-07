#include "prims.hpp"

#include <cmath>
#include <cstring>

namespace prims {

static const char* kWGSL = R"WGSL(
struct U { viewProj : mat4x4<f32> };
@group(0) @binding(0) var<uniform> u : U;
struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) color : vec4<f32>,
};
@vertex
fn vs_main(@location(0) pos : vec3<f32>, @location(1) color : vec4<f32>) -> VSOut {
  var o : VSOut;
  o.position = u.viewProj * vec4<f32>(pos, 1.0);
  o.color = color;
  return o;
}
@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> { return in.color; }
)WGSL";

// Textured decal (town roads): sample the decal atlas; the texture's own alpha
// gives the worn, soft-edged path. Unlit — ground decals read fine flat-lit.
static const char* kTexWGSL = R"WGSL(
struct U { viewProj : mat4x4<f32> };
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var samp : sampler;
struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};
@vertex
fn vs_main(@location(0) pos : vec3<f32>, @location(1) uv : vec2<f32>) -> VSOut {
  var o : VSOut;
  o.position = u.viewProj * vec4<f32>(pos, 1.0);
  o.uv = uv;
  return o;
}
@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let c = textureSample(tex, samp, in.uv);
  if (c.a < 0.02) { discard; }
  return c;
}
)WGSL";

bool System::init(WGPUDevice device, WGPUTextureFormat colorFormat) {
  WGPUShaderModuleWGSLDescriptor wgsl = {};
  wgsl.chain.sType = WGPUSType_ShaderModuleWGSLDescriptor;
  wgsl.code = kWGSL;
  WGPUShaderModuleDescriptor smd = {};
  smd.nextInChain = &wgsl.chain;
  WGPUShaderModule mod = wgpuDeviceCreateShaderModule(device, &smd);

  WGPUBufferDescriptor ubd = {};
  ubd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
  ubd.size = sizeof(glm::mat4);
  ubuf_ = wgpuDeviceCreateBuffer(device, &ubd);

  WGPUBindGroupLayoutEntry ble = {};
  ble.binding = 0; ble.visibility = WGPUShaderStage_Vertex;
  ble.buffer.type = WGPUBufferBindingType_Uniform;
  WGPUBindGroupLayoutDescriptor bld = {}; bld.entryCount = 1; bld.entries = &ble;
  WGPUBindGroupLayout bgl = wgpuDeviceCreateBindGroupLayout(device, &bld);
  WGPUPipelineLayoutDescriptor pld = {}; pld.bindGroupLayoutCount = 1; pld.bindGroupLayouts = &bgl;
  WGPUPipelineLayout pl = wgpuDeviceCreatePipelineLayout(device, &pld);

  WGPUVertexAttribute attrs[2] = {};
  attrs[0].format = WGPUVertexFormat_Float32x3; attrs[0].offset = 0; attrs[0].shaderLocation = 0;
  attrs[1].format = WGPUVertexFormat_Float32x4; attrs[1].offset = 3 * sizeof(float); attrs[1].shaderLocation = 1;
  WGPUVertexBufferLayout vbl = {};
  vbl.arrayStride = sizeof(Vtx); vbl.attributeCount = 2; vbl.attributes = attrs;

  auto makePipe = [&](bool translucent) {
    WGPUDepthStencilState ds = {};
    ds.format = WGPUTextureFormat_Depth24PlusStencil8;
    ds.depthWriteEnabled = !translucent;
    ds.depthCompare = WGPUCompareFunction_Less;
    ds.stencilFront.compare = WGPUCompareFunction_Always;
    ds.stencilBack.compare = WGPUCompareFunction_Always;
    ds.stencilReadMask = 0xFFFFFFFFu; ds.stencilWriteMask = 0xFFFFFFFFu;
    WGPUBlendState blend = {};
    blend.color.srcFactor = WGPUBlendFactor_SrcAlpha;
    blend.color.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    blend.color.operation = WGPUBlendOperation_Add;
    blend.alpha.srcFactor = WGPUBlendFactor_One;
    blend.alpha.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    blend.alpha.operation = WGPUBlendOperation_Add;
    WGPUColorTargetState target = {};
    target.format = colorFormat; target.writeMask = WGPUColorWriteMask_All;
    if (translucent) target.blend = &blend;
    WGPUFragmentState frag = {};
    frag.module = mod; frag.entryPoint = "fs_main"; frag.targetCount = 1; frag.targets = &target;
    WGPURenderPipelineDescriptor rpd = {};
    rpd.layout = pl;
    rpd.vertex.module = mod; rpd.vertex.entryPoint = "vs_main";
    rpd.vertex.bufferCount = 1; rpd.vertex.buffers = &vbl;
    rpd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    rpd.primitive.cullMode = WGPUCullMode_None;
    rpd.depthStencil = &ds;
    rpd.multisample.count = 1; rpd.multisample.mask = 0xFFFFFFFFu;
    rpd.fragment = &frag;
    return wgpuDeviceCreateRenderPipeline(device, &rpd);
  };
  pipeOpaque_ = makePipe(false);
  pipeTrans_ = makePipe(true);

  WGPUBindGroupEntry bge = {};
  bge.binding = 0; bge.buffer = ubuf_; bge.size = sizeof(glm::mat4);
  WGPUBindGroupDescriptor bgd = {}; bgd.layout = bgl; bgd.entryCount = 1; bgd.entries = &bge;
  bind_ = wgpuDeviceCreateBindGroup(device, &bgd);
  wgpuBindGroupLayoutRelease(bgl);
  wgpuPipelineLayoutRelease(pl);

  // ── Textured decal pipeline (town roads): uniform + texture + sampler; alpha-
  //    blended, NO depth write (draped on the terrain, avoids z-fighting). ──
  {
    WGPUShaderModuleWGSLDescriptor twgsl = {};
    twgsl.chain.sType = WGPUSType_ShaderModuleWGSLDescriptor;
    twgsl.code = kTexWGSL;
    WGPUShaderModuleDescriptor tsmd = {}; tsmd.nextInChain = &twgsl.chain;
    WGPUShaderModule tmod = wgpuDeviceCreateShaderModule(device, &tsmd);

    WGPUSamplerDescriptor sd = {};
    sd.addressModeW = WGPUAddressMode_Repeat;
    sd.magFilter = WGPUFilterMode_Linear; sd.minFilter = WGPUFilterMode_Linear;
    sd.mipmapFilter = WGPUMipmapFilterMode_Linear;
    sd.lodMaxClamp = 32.0f; sd.maxAnisotropy = 1;
    // Slot 0 (roads): U = path cross-section (clamp), V tiles along. Slot 1 (cobble square): both tile.
    sd.addressModeU = WGPUAddressMode_ClampToEdge; sd.addressModeV = WGPUAddressMode_Repeat;
    texSampler_[0] = wgpuDeviceCreateSampler(device, &sd);
    sd.addressModeU = WGPUAddressMode_Repeat;      sd.addressModeV = WGPUAddressMode_Repeat;
    texSampler_[1] = wgpuDeviceCreateSampler(device, &sd);

    WGPUBindGroupLayoutEntry te[3] = {};
    te[0].binding = 0; te[0].visibility = WGPUShaderStage_Vertex; te[0].buffer.type = WGPUBufferBindingType_Uniform;
    te[1].binding = 1; te[1].visibility = WGPUShaderStage_Fragment; te[1].texture.sampleType = WGPUTextureSampleType_Float;
    te[1].texture.viewDimension = WGPUTextureViewDimension_2D;
    te[2].binding = 2; te[2].visibility = WGPUShaderStage_Fragment; te[2].sampler.type = WGPUSamplerBindingType_Filtering;
    WGPUBindGroupLayoutDescriptor tbld = {}; tbld.entryCount = 3; tbld.entries = te;
    texBgl_ = wgpuDeviceCreateBindGroupLayout(device, &tbld);
    WGPUPipelineLayoutDescriptor tpld = {}; tpld.bindGroupLayoutCount = 1; tpld.bindGroupLayouts = &texBgl_;
    WGPUPipelineLayout tpl = wgpuDeviceCreatePipelineLayout(device, &tpld);

    WGPUVertexAttribute tattrs[2] = {};
    tattrs[0].format = WGPUVertexFormat_Float32x3; tattrs[0].offset = 0; tattrs[0].shaderLocation = 0;
    tattrs[1].format = WGPUVertexFormat_Float32x2; tattrs[1].offset = 3 * sizeof(float); tattrs[1].shaderLocation = 1;
    WGPUVertexBufferLayout tvbl = {}; tvbl.arrayStride = sizeof(TVtx); tvbl.attributeCount = 2; tvbl.attributes = tattrs;

    WGPUDepthStencilState tds = {};
    tds.format = WGPUTextureFormat_Depth24PlusStencil8;
    tds.depthWriteEnabled = false; tds.depthCompare = WGPUCompareFunction_Less;
    tds.stencilFront.compare = WGPUCompareFunction_Always; tds.stencilBack.compare = WGPUCompareFunction_Always;
    tds.stencilReadMask = 0xFFFFFFFFu; tds.stencilWriteMask = 0xFFFFFFFFu;
    WGPUBlendState tblend = {};
    tblend.color.srcFactor = WGPUBlendFactor_SrcAlpha; tblend.color.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    tblend.color.operation = WGPUBlendOperation_Add;
    tblend.alpha.srcFactor = WGPUBlendFactor_One; tblend.alpha.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    tblend.alpha.operation = WGPUBlendOperation_Add;
    WGPUColorTargetState ttarget = {}; ttarget.format = colorFormat; ttarget.writeMask = WGPUColorWriteMask_All; ttarget.blend = &tblend;
    WGPUFragmentState tfrag = {}; tfrag.module = tmod; tfrag.entryPoint = "fs_main"; tfrag.targetCount = 1; tfrag.targets = &ttarget;
    WGPURenderPipelineDescriptor trpd = {};
    trpd.layout = tpl;
    trpd.vertex.module = tmod; trpd.vertex.entryPoint = "vs_main"; trpd.vertex.bufferCount = 1; trpd.vertex.buffers = &tvbl;
    trpd.primitive.topology = WGPUPrimitiveTopology_TriangleList; trpd.primitive.cullMode = WGPUCullMode_None;
    trpd.depthStencil = &tds;
    trpd.multisample.count = 1; trpd.multisample.mask = 0xFFFFFFFFu;
    trpd.fragment = &tfrag;
    pipeTex_ = wgpuDeviceCreateRenderPipeline(device, &trpd);
    wgpuPipelineLayoutRelease(tpl);
  }
  return pipeOpaque_ && pipeTrans_;
}

void System::setDecalTexture(WGPUDevice device, WGPUTextureView view, int slot) {
  if (!view || !texBgl_ || slot < 0 || slot >= kDecalSlots) return;
  if (texBind_[slot]) { wgpuBindGroupRelease(texBind_[slot]); texBind_[slot] = nullptr; }
  WGPUBindGroupEntry e[3] = {};
  e[0].binding = 0; e[0].buffer = ubuf_; e[0].size = sizeof(glm::mat4);
  e[1].binding = 1; e[1].textureView = view;
  e[2].binding = 2; e[2].sampler = texSampler_[slot];
  WGPUBindGroupDescriptor bgd = {}; bgd.layout = texBgl_; bgd.entryCount = 3; bgd.entries = e;
  texBind_[slot] = wgpuDeviceCreateBindGroup(device, &bgd);
}

void System::triTex(const glm::vec3& a, const glm::vec3& b, const glm::vec3& c,
                    const glm::vec2& ua, const glm::vec2& ub, const glm::vec2& uc, int slot) {
  if (slot < 0 || slot >= kDecalSlots) return;
  tex_[slot].push_back({ a, ua });
  tex_[slot].push_back({ b, ub });
  tex_[slot].push_back({ c, uc });
}

void System::clear() { opaque_.clear(); trans_.clear(); for (auto& t : tex_) t.clear(); }

void System::tri(const glm::vec3& a, const glm::vec3& b, const glm::vec3& c,
                 const glm::vec4& color, bool translucent) {
  auto& v = translucent ? trans_ : opaque_;
  v.push_back({ a, color });
  v.push_back({ b, color });
  v.push_back({ c, color });
}

void System::tri3(const glm::vec3& a, const glm::vec3& b, const glm::vec3& c,
                  const glm::vec4& ca, const glm::vec4& cb, const glm::vec4& cc, bool translucent) {
  auto& v = translucent ? trans_ : opaque_;
  v.push_back({ a, ca });
  v.push_back({ b, cb });
  v.push_back({ c, cc });
}

void System::sphere(const glm::vec3& c, float r, const glm::vec4& color, const glm::mat3& orient) {
  const int SEG = 7, RING = 5;   // client used 7-segment low-poly spheres
  const glm::vec3 lightDir = glm::normalize(glm::vec3(0.4f, 0.8f, 0.3f));
  auto pt = [&](int i, int j) {
    float th = 3.14159265f * (float)j / RING;          // 0..pi
    float ph = 6.2831853f * (float)i / SEG;            // 0..2pi
    return glm::vec3(std::sin(th) * std::cos(ph), std::cos(th), std::sin(th) * std::sin(ph));
  };
  for (int j = 0; j < RING; ++j)
    for (int i = 0; i < SEG; ++i) {
      glm::vec3 n00 = pt(i, j), n10 = pt(i + 1, j), n01 = pt(i, j + 1), n11 = pt(i + 1, j + 1);
      auto shade = [&](const glm::vec3& n) {
        float d = 0.35f + 0.65f * std::max(0.0f, glm::dot(glm::normalize(orient * n), lightDir));
        return glm::vec4(glm::vec3(color) * d, color.a);
      };
      glm::vec3 p00 = c + orient * n00 * r, p10 = c + orient * n10 * r;
      glm::vec3 p01 = c + orient * n01 * r, p11 = c + orient * n11 * r;
      opaque_.push_back({ p00, shade(n00) });
      opaque_.push_back({ p01, shade(n01) });
      opaque_.push_back({ p10, shade(n10) });
      opaque_.push_back({ p10, shade(n10) });
      opaque_.push_back({ p01, shade(n01) });
      opaque_.push_back({ p11, shade(n11) });
    }
}

void System::cylinder(const glm::vec3& a, const glm::vec3& b, float radius,
                      const glm::vec4& color, int sides, bool translucent) {
  glm::vec3 axis = b - a;
  float len = glm::length(axis);
  if (len < 1e-5f) return;
  axis /= len;
  glm::vec3 up = std::fabs(axis.y) > 0.95f ? glm::vec3(1, 0, 0) : glm::vec3(0, 1, 0);
  glm::vec3 t = glm::normalize(glm::cross(up, axis));
  glm::vec3 s = glm::cross(axis, t);
  for (int i = 0; i < sides; ++i) {
    float a0 = 6.2831853f * (float)i / sides, a1 = 6.2831853f * (float)(i + 1) / sides;
    glm::vec3 r0 = (t * std::cos(a0) + s * std::sin(a0)) * radius;
    glm::vec3 r1 = (t * std::cos(a1) + s * std::sin(a1)) * radius;
    tri(a + r0, b + r0, a + r1, color, translucent);
    tri(a + r1, b + r0, b + r1, color, translucent);
  }
}

void System::tube(const std::vector<glm::vec3>& path, float radius,
                  const glm::vec4& color, int sides) {
  for (size_t i = 0; i + 1 < path.size(); ++i)
    cylinder(path[i], path[i + 1], radius, color, sides, true);
}

void System::billboard(const glm::vec3& c, const glm::vec3& r, const glm::vec3& u,
                       float w, float h, const glm::vec4& color) {
  glm::vec3 rw = r * (w * 0.5f), uh = u * (h * 0.5f);
  tri(c - rw - uh, c + rw - uh, c - rw + uh, color, true);
  tri(c + rw - uh, c + rw + uh, c - rw + uh, color, true);
}

void System::flush(WGPUDevice device, WGPUQueue queue, WGPURenderPassEncoder pass,
                   const glm::mat4& viewProj) {
  const uint64_t total = (uint64_t)(opaque_.size() + trans_.size()) * sizeof(Vtx);
  size_t texN = 0; for (const auto& t : tex_) texN += t.size();
  if ((total == 0 && texN == 0) || !pipeOpaque_) return;
  if (total > vbufCap_ && total > 0) {
    if (vbuf_) wgpuBufferRelease(vbuf_);
    vbufCap_ = total * 2;
    WGPUBufferDescriptor vbd = {};
    vbd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
    vbd.size = vbufCap_;
    vbuf_ = wgpuDeviceCreateBuffer(device, &vbd);
  }
  wgpuQueueWriteBuffer(queue, ubuf_, 0, &viewProj, sizeof(glm::mat4));
  if (!opaque_.empty())
    wgpuQueueWriteBuffer(queue, vbuf_, 0, opaque_.data(), opaque_.size() * sizeof(Vtx));
  if (!trans_.empty())
    wgpuQueueWriteBuffer(queue, vbuf_, opaque_.size() * sizeof(Vtx),
                         trans_.data(), trans_.size() * sizeof(Vtx));
  wgpuRenderPassEncoderSetBindGroup(pass, 0, bind_, 0, nullptr);
  if (!opaque_.empty()) {
    wgpuRenderPassEncoderSetPipeline(pass, pipeOpaque_);
    wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vbuf_, 0, opaque_.size() * sizeof(Vtx));
    wgpuRenderPassEncoderDraw(pass, (uint32_t)opaque_.size(), 1, 0, 0);
  }
  if (!trans_.empty()) {
    wgpuRenderPassEncoderSetPipeline(pass, pipeTrans_);
    wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vbuf_, opaque_.size() * sizeof(Vtx),
                                         trans_.size() * sizeof(Vtx));
    wgpuRenderPassEncoderDraw(pass, (uint32_t)trans_.size(), 1, 0, 0);
  }
  // Textured decals — one draw per slot (roads slot 0, cobble square slot 1),
  // packed back-to-back into tvbuf_; each slot binds its own texture+sampler.
  if (texN && pipeTex_) {
    const uint64_t tbytes = (uint64_t)texN * sizeof(TVtx);
    if (tbytes > tvbufCap_) {
      if (tvbuf_) wgpuBufferRelease(tvbuf_);
      tvbufCap_ = tbytes * 2;
      WGPUBufferDescriptor tvd = {};
      tvd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst; tvd.size = tvbufCap_;
      tvbuf_ = wgpuDeviceCreateBuffer(device, &tvd);
    }
    wgpuRenderPassEncoderSetPipeline(pass, pipeTex_);
    uint64_t off = 0;
    for (int s = 0; s < kDecalSlots; ++s) {
      if (tex_[s].empty() || !texBind_[s]) continue;
      const uint64_t sb = (uint64_t)tex_[s].size() * sizeof(TVtx);
      wgpuQueueWriteBuffer(queue, tvbuf_, off, tex_[s].data(), sb);
      wgpuRenderPassEncoderSetBindGroup(pass, 0, texBind_[s], 0, nullptr);
      wgpuRenderPassEncoderSetVertexBuffer(pass, 0, tvbuf_, off, sb);
      wgpuRenderPassEncoderDraw(pass, (uint32_t)tex_[s].size(), 1, 0, 0);
      off += sb;
    }
  }
}

}  // namespace prims
