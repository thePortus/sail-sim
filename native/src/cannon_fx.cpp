#include "cannon_fx.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace fx {

// ── WGSL: shared billboard vertex + three fragment families ──────────────────
// The explosion raymarch and the smoke cloud are line-for-line ports of the
// client's GLSL (muzzle-explosion.ts / muzzle-smoke.ts), which was WRITTEN to be
// WGSL-legal (hash noise, baked loop bounds, uniform-gated depth sampling).
static const char* kWGSL = R"WGSL(
struct U {
  viewProj : mat4x4<f32>,
  camRight : vec4<f32>,   // xyz
  camUp    : vec4<f32>,   // xyz
  camFwd   : vec4<f32>,   // xyz; w = soft range (m)
  camPos   : vec4<f32>,   // xyz
  proj     : vec4<f32>,   // x=p00 y=p11 z=p22 w=p32 (linearise the depth snapshot)
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var sceneDepth : texture_depth_2d;   // pre-ocean snapshot (ships+terrain)

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv    : vec2<f32>,
  @location(1) color : vec4<f32>,   // particles: rgba; smoke/expl: unused rgb
  @location(2) misc  : vec4<f32>,   // x = life, y = time, z = seed, w = viewZ
};

@vertex
fn vs_bill(@builtin(vertex_index) vid : u32,
           @location(0) posSize : vec4<f32>,
           @location(1) misc    : vec4<f32>,
           @location(2) color   : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5), vec2<f32>(-0.5, 0.5),
    vec2<f32>(0.5, -0.5), vec2<f32>(0.5, 0.5), vec2<f32>(-0.5, 0.5));
  let c = corners[vid];
  let world = posSize.xyz + (u.camRight.xyz * c.x + u.camUp.xyz * c.y) * posSize.w;
  var o : VSOut;
  o.position = u.viewProj * vec4<f32>(world, 1.0);
  o.uv = c + 0.5;
  o.color = color;
  o.misc = vec4<f32>(misc.xyz, dot(world - u.camPos.xyz, u.camFwd.xyz));
  return o;
}

// ── Particles: soft radial disc x per-particle colour ──
@fragment
fn fs_particle(in : VSOut) -> @location(0) vec4<f32> {
  let rr = length(in.uv - 0.5) * 2.0;
  let disc = 1.0 - smoothstep(0.25, 1.0, rr);
  return vec4<f32>(in.color.rgb, in.color.a * disc);
}

// ── Muzzle fireball (Duke's volumetric explosion; client adaptation) ──
fn hash13(p3in : vec3<f32>) -> f32 {
  var p3 = fract(p3in * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
fn vnoise(x : vec3<f32>) -> f32 {
  let p = floor(x);
  var f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  let n = mix(mix(mix(hash13(p), hash13(p + vec3<f32>(1.0, 0.0, 0.0)), f.x),
                  mix(hash13(p + vec3<f32>(0.0, 1.0, 0.0)), hash13(p + vec3<f32>(1.0, 1.0, 0.0)), f.x), f.y),
              mix(mix(hash13(p + vec3<f32>(0.0, 0.0, 1.0)), hash13(p + vec3<f32>(1.0, 0.0, 1.0)), f.x),
                  mix(hash13(p + vec3<f32>(0.0, 1.0, 1.0)), hash13(p + vec3<f32>(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  return 1.0 - 0.82 * n;
}
fn efbm(p : vec3<f32>) -> f32 {
  return vnoise(p * 0.06125) * 0.5 + vnoise(p * 0.125) * 0.25 + vnoise(p * 0.25) * 0.125 + vnoise(p * 0.4) * 0.2;
}
fn spiralNoise(pin : vec3<f32>, tim : f32) -> f32 {
  let nudge = 4.0;
  let normalizer = 0.2425356250;
  var p = pin;
  var n = -(tim * 0.2 - 2.0 * floor(tim * 0.2 / 2.0));   // -mod(t*0.2, -2) equivalent phase
  var iter = 2.0;
  for (var i = 0; i < 6; i = i + 1) {
    n += -abs(sin(p.y * iter) + cos(p.x * iter)) / iter;
    p = vec3<f32>(p.x + p.y * nudge, p.y - p.x * nudge, p.z);
    p = vec3<f32>(p.x * normalizer, p.y * normalizer, p.z);
    p = vec3<f32>(p.x + p.z * nudge, p.y, p.z - p.x * nudge);
    p = vec3<f32>(p.x * normalizer, p.y, p.z * normalizer);
    iter *= 1.733733;
  }
  return n;
}
fn explMap(pin : vec3<f32>, tim : f32) -> f32 {
  var p = pin;
  let a = tim * 0.15;
  let xz = cos(a) * p.xz + sin(a) * vec2<f32>(p.z, -p.x);
  p = vec3<f32>(xz.x, p.y, xz.y);
  let q = p / 0.5;
  var dens = length(q) - 4.0;
  dens += efbm(q * 50.0);
  dens += spiralNoise(q.zxy * 0.4132 + 333.0, tim) * 3.0;
  return dens * 0.5;
}
fn explColor(density : f32, radius : f32) -> vec3<f32> {
  var result = mix(vec3<f32>(1.0, 0.9, 0.8), vec3<f32>(0.4, 0.15, 0.1), density);
  let colCenter = 7.0 * vec3<f32>(0.8, 1.0, 1.0);
  let colEdge = 1.5 * vec3<f32>(0.48, 0.53, 0.5);
  result *= mix(colCenter, colEdge, min((radius + 0.05) / 0.9, 1.15));
  return result;
}
fn explosion(uv : vec2<f32>, life : f32, tim : f32, steps : i32, sScale : f32) -> vec3<f32> {
  let p2 = uv - 0.5;
  let rd = normalize(vec3<f32>(p2, 1.0));
  let ro = vec3<f32>(0.0, 0.0, -7.5);
  var ld = 0.0; var td = 0.0; var w = 0.0;
  let d = 1.0; var t = 0.0;
  let h = 0.1;
  var sum = vec4<f32>(0.0);
  let b = dot(rd, ro);
  let cc = dot(ro, ro) - 8.0;
  let delta = b * b - cc;
  let dsq = sqrt(max(delta, 0.0));
  let minD = -b - dsq;
  let maxD = -b + dsq;
  if (delta >= 0.0 && maxD > 0.0) {
    t = minD * step(t, minD);
    for (var i = 0; i < 44; i = i + 1) {
      if (i >= steps) { break; }
      let pos = ro + t * rd;
      if (td > 0.9 || d < 0.12 * t || t > 10.0 || sum.a > 0.99 || t > maxD) { break; }
      var dd = explMap(pos, tim);
      dd = max(dd, 0.03);
      let ldst = vec3<f32>(0.0) - pos;
      let lDist = max(length(ldst), 0.001);
      sum = vec4<f32>(sum.rgb + (vec3<f32>(1.0, 0.5, 0.25) / exp(lDist * lDist * lDist * 0.08) / 30.0) * sScale, sum.a);
      if (dd < h) {
        ld = h - dd;
        w = (1.0 - td) * ld;
        td += w + sScale / 200.0;
        var col = vec4<f32>(explColor(td, lDist), td);
        sum += sum.a * vec4<f32>(sum.rgb, 0.0) * 0.2 / lDist;
        col.a *= 0.2;
        col = vec4<f32>(col.rgb * col.a, col.a);
        sum = sum + col * (1.0 - sum.a);
      }
      td += sScale / 70.0;
      t += max(dd * 0.08 * max(min(length(ldst), dd), 2.0), 0.01) * sScale;
    }
    sum *= 1.0 / exp(ld * 0.2) * 0.8;
    sum = clamp(sum, vec4<f32>(0.0), vec4<f32>(1.0));
    let s3 = sum.xyz * sum.xyz * (3.0 - 2.0 * sum.xyz);
    sum = vec4<f32>(s3, sum.a);
  }
  var col = sum.xyz * 1.7;
  let rr = length(uv - 0.5) * 2.0;
  let front = 1.05 - life * 0.95;
  let radial = smoothstep(front, front - 0.5, rr);
  let fade = mix(1.0, 0.55, life);
  return col * radial * fade;
}
@fragment
fn fs_expl_hi(in : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(explosion(in.uv, clamp(in.misc.x, 0.0, 1.0), in.misc.y, 44, 1.0), 1.0);
}
@fragment
fn fs_expl_lo(in : VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(explosion(in.uv, clamp(in.misc.x, 0.0, 1.0), in.misc.y, 26, 1.69231), 1.0);
}

// ── Smoke puffs (Ashima simplex fbm; normal alpha, soft depth fade) ──
fn mod289v3(x : vec3<f32>) -> vec3<f32> { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289v4(x : vec4<f32>) -> vec4<f32> { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute4(x : vec4<f32>) -> vec4<f32> { return mod289v4(((x * 34.0) + 1.0) * x); }
fn taylorInvSqrt4(r : vec4<f32>) -> vec4<f32> { return 1.79284291400159 - 0.85373472095314 * r; }
fn snoise(v : vec3<f32>) -> f32 {
  let C = vec2<f32>(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4<f32>(0.0, 0.5, 1.0, 2.0);
  var i = floor(v + dot(v, C.yyy));
  let x0 = v - i + dot(i, C.xxx);
  let g = step(x0.yzx, x0.xyz);
  let l = 1.0 - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);
  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;
  i = mod289v3(i);
  let p = permute4(permute4(permute4(
            i.z + vec4<f32>(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4<f32>(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4<f32>(0.0, i1.x, i2.x, 1.0));
  let n_ = 0.142857142857;
  let ns = n_ * D.wyz - D.xzx;
  let j = p - 49.0 * floor(p * ns.z * ns.z);
  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);
  let x = x_ * ns.x + ns.yyyy;
  let y = y_ * ns.x + ns.yyyy;
  let hh = 1.0 - abs(x) - abs(y);
  let b0 = vec4<f32>(x.xy, y.xy);
  let b1 = vec4<f32>(x.zw, y.zw);
  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(hh, vec4<f32>(0.0));
  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;
  var p0 = vec3<f32>(a0.xy, hh.x);
  var p1 = vec3<f32>(a0.zw, hh.y);
  var p2 = vec3<f32>(a1.xy, hh.z);
  var p3 = vec3<f32>(a1.zw, hh.w);
  let norm = taylorInvSqrt4(vec4<f32>(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  var m = max(0.6 - vec4<f32>(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4<f32>(0.0));
  m = m * m;
  return 42.0 * dot(m * m, vec4<f32>(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
fn fbmCloud(uv : vec2<f32>, tim : f32, seed : f32) -> f32 {
  let n = snoise(vec3<f32>(uv * 3.0 + seed, tim * 0.4)) * 0.55
        + snoise(vec3<f32>(uv * 6.0 + seed * 1.7, tim * 0.5)) * 0.28
        + snoise(vec3<f32>(uv * 12.0 - seed * 0.9, tim * 0.3)) * 0.14;
  return 0.5 * (n + 1.0);
}
@fragment
fn fs_smoke(in : VSOut) -> @location(0) vec4<f32> {
  let life = clamp(in.misc.x, 0.0, 1.0);
  let q = in.uv - 0.5;
  let rr = length(q) * 2.0;
  let disc = smoothstep(1.0, 0.1, rr);
  let a = in.misc.y * 0.2 + in.misc.z;
  let ruv = vec2<f32>(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a)) + 0.5;
  let n = fbmCloud(ruv, in.misc.y, in.misc.z);
  let dens = smoothstep(0.28, 0.78, n) * disc;
  let col = mix(vec3<f32>(0.13, 0.13, 0.14), vec3<f32>(0.5, 0.49, 0.46), n * n);
  let env = smoothstep(0.0, 0.10, life) * (1.0 - smoothstep(0.6, 1.0, life));
  var alpha = dens * env * 0.9;
  // Soft-particle fade against the pre-ocean depth snapshot (ships + terrain).
  let dims = vec2<f32>(textureDimensions(sceneDepth));
  let px = vec2<i32>(clamp(in.position.xy, vec2<f32>(0.0), dims - vec2<f32>(1.0)));
  let dRaw = textureLoad(sceneDepth, px, 0);
  let sceneZ = -u.proj.w / (dRaw + u.proj.z);          // view z, negative forward
  let soft = clamp((-sceneZ - in.misc.w) / max(u.camFwd.w, 0.1), 0.0, 1.0);
  alpha *= soft;
  return vec4<f32>(col, alpha);
}
)WGSL";

// ── Particle-system definitions (client cannon.service constants) ─────────────
struct ColorStop { float t; glm::vec4 c; };
struct SysDef {
  ColorStop stops[4]; int nStops;
  float size0Min, size0Max, size1Min, size1Max;
  float lifeMin, lifeMax;
  float powMin, powMax;
  glm::vec3 gravity;
  bool additive;
  bool velGradient;    // fast out -> hang (smoke palls)
};
enum Sys { SPLASH, DIRT, LANDSMOKE, DEBRIS, FIRE, SOOT, SYS_COUNT };
static const SysDef kSys[SYS_COUNT] = {
  // SPLASH: fine sea mist, heavy fall.
  { { { 0.0f, { 0.82f, 0.91f, 1.00f, 0.28f } }, { 1.0f, { 0.86f, 0.93f, 1.00f, 0.0f } } }, 2,
    0.06f, 0.14f, 0.35f, 0.70f, 0.55f, 1.80f, 6, 13, { 0, -46, 0 }, false, false },
  // DIRT: dust-brown burst.
  { { { 0.0f, { 0.55f, 0.42f, 0.22f, 0.0f } }, { 0.08f, { 0.60f, 0.46f, 0.26f, 0.95f } },
      { 0.45f, { 0.50f, 0.45f, 0.38f, 0.82f } }, { 1.0f, { 0.42f, 0.40f, 0.37f, 0.0f } } }, 4,
    0.50f, 1.20f, 3.50f, 5.50f, 0.80f, 1.50f, 6, 20, { 0, -20, 0 }, false, false },
  // LANDSMOKE: lingering dusty pall.
  { { { 0.0f, { 0.54f, 0.45f, 0.30f, 0.0f } }, { 0.10f, { 0.52f, 0.44f, 0.31f, 0.58f } },
      { 0.40f, { 0.47f, 0.43f, 0.37f, 0.50f } }, { 1.0f, { 0.41f, 0.39f, 0.37f, 0.0f } } }, 4,
    1.20f, 2.20f, 6.50f, 9.00f, 6.0f, 11.0f, 6, 16, { 0, 0.4f, 0 }, false, true },
  // DEBRIS: dark wood splinters.
  { { { 0.0f, { 0.46f, 0.33f, 0.18f, 1.0f } }, { 0.6f, { 0.28f, 0.19f, 0.10f, 1.0f } },
      { 1.0f, { 0.22f, 0.15f, 0.08f, 0.0f } } }, 3,
    0.09f, 0.36f, 0.09f, 0.36f, 0.45f, 1.30f, 9, 24, { 0, -30, 0 }, false, false },
  // FIRE: quick additive gust.
  { { { 0.0f, { 1.00f, 0.92f, 0.55f, 1.0f } }, { 0.5f, { 1.00f, 0.46f, 0.10f, 0.95f } },
      { 1.0f, { 0.45f, 0.12f, 0.01f, 0.0f } } }, 3,
    0.40f, 0.90f, 1.80f, 2.80f, 0.12f, 0.42f, 7, 20, { 0, 3, 0 }, true, false },
  // SOOT: black smoke pall that hangs.
  { { { 0.0f, { 0.09f, 0.08f, 0.07f, 0.0f } }, { 0.10f, { 0.11f, 0.10f, 0.09f, 0.74f } },
      { 0.45f, { 0.14f, 0.13f, 0.12f, 0.62f } }, { 1.0f, { 0.17f, 0.17f, 0.17f, 0.0f } } }, 4,
    1.00f, 2.00f, 6.50f, 9.50f, 5.0f, 9.0f, 4, 12, { 0, 0.8f, 0 }, false, true },
};

struct Particle {
  bool active = false;
  int sys = 0;
  float life = 0, lifetime = 1;
  glm::vec3 p{ 0 }, v{ 0 };
  float size0 = 1, size1 = 2;
  float gscale = 1;   // per-particle gravity scale (slow-motion spray: v*k + g*k^2 = same arc, longer flight)
};
struct ExplSlot {
  bool active = false, low = false;
  float life = 0, seed = 0, size = 6.5f;
  glm::vec3 pos{ 0 };
};
struct Puff {
  bool active = false;
  float life = 0, lifetime = 2.4f, seed = 0, size0 = 3, size1 = 9;
  glm::vec3 p{ 0 }, v{ 0 };
};
struct Emitter { glm::vec3 pos{ 0 }; float dx = 0, dz = 0, tLeft = 0, spawnIn = 0; };

struct Inst { glm::vec4 posSize, misc, color; };

struct System::Impl {
  WGPURenderPipeline pipeParticle = nullptr, pipeFire = nullptr, pipeSmoke = nullptr;
  WGPURenderPipeline pipeExplHi = nullptr, pipeExplLo = nullptr;
  WGPUBindGroupLayout bgl = nullptr;
  WGPUBuffer ubuf = nullptr, vbuf = nullptr;
  uint64_t vbufCap = 0;
  WGPUBindGroup bind = nullptr;
  WGPUTextureView boundDepth = nullptr;

  std::vector<Particle> particles;
  ExplSlot expl[16];
  std::vector<Puff> puffs;
  std::vector<Emitter> emitters;
  uint32_t rng = 22222;

  float frand() {
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
    return (float)(rng & 0xFFFFFF) / (float)0xFFFFFF;
  }
  float frand(float a, float b) { return a + frand() * (b - a); }

  Particle* freeParticle() {
    for (Particle& q : particles) if (!q.active) return &q;
    Particle* oldest = &particles[0];
    for (Particle& q : particles) if (q.life > oldest->life) oldest = &q;
    return oldest;
  }

  // Burst n particles in a direction box (client direction1..direction2 cones).
  void burst(int sys, int n, const glm::vec3& at, const glm::vec3& box,
             const glm::vec3& dir1, const glm::vec3& dir2, float sizeScale = 1.0f, float powScale = 1.0f,
             float gravScale = 1.0f, float lifeScale = 1.0f) {
    const SysDef& d = kSys[sys];
    for (int i = 0; i < n; ++i) {
      Particle& q = *freeParticle();
      q.active = true;
      q.sys = sys;
      q.life = 0;
      q.lifetime = frand(d.lifeMin, d.lifeMax) * lifeScale;
      q.gscale = gravScale;
      q.p = at + glm::vec3(frand(-box.x, box.x), frand(0.0f, box.y), frand(-box.z, box.z));
      glm::vec3 dir(frand(dir1.x, dir2.x), frand(dir1.y, dir2.y), frand(dir1.z, dir2.z));
      float len = glm::length(dir);
      if (len > 1e-4f) dir /= len;
      q.v = dir * frand(d.powMin, d.powMax) * powScale;
      q.size0 = frand(d.size0Min, d.size0Max) * sizeScale;
      q.size1 = frand(d.size1Min, d.size1Max) * sizeScale;
    }
  }
  glm::vec4 colorAt(const SysDef& d, float t) {
    if (t <= d.stops[0].t) return d.stops[0].c;
    for (int i = 1; i < d.nStops; ++i)
      if (t <= d.stops[i].t) {
        float u = (t - d.stops[i - 1].t) / std::max(1e-4f, d.stops[i].t - d.stops[i - 1].t);
        return glm::mix(d.stops[i - 1].c, d.stops[i].c, u);
      }
    return d.stops[d.nStops - 1].c;
  }

  Puff* freePuff() {
    for (Puff& q : puffs) if (!q.active) return &q;
    Puff* oldest = &puffs[0];
    for (Puff& q : puffs) if (q.life > oldest->life) oldest = &q;
    return oldest;
  }
  void spawnBelchPuff(const Emitter& e) {
    Puff& p = *freePuff();
    const float speed = 13.0f * (e.tLeft / 0.6f) + 4.0f;
    p.p = e.pos + glm::vec3(e.dx * 0.4f, 0.1f, e.dz * 0.4f);
    p.v = glm::vec3(e.dx * speed + frand(-1, 1) * 2.0f,
                    0.9f + frand(-1, 1) * 0.7f,
                    e.dz * speed + frand(-1, 1) * 2.0f);
    p.seed = std::fmod(e.tLeft * 53.7f, 50.0f);
    p.size0 = 3.2f + frand(-1, 1) * 1.0f;
    p.size1 = 12.0f + frand(-1, 1) * 4.0f;
    p.lifetime = frand(3.6f, 5.8f);
    p.life = 0;
    p.active = true;
  }
  void spawnPallPuff(const glm::vec3& at, float dx, float dz) {
    Puff& p = *freePuff();
    p.p = at + glm::vec3(dx * 0.5f + frand(-1, 1) * 1.5f, 0.4f + frand(-1, 1) * 0.5f,
                         dz * 0.5f + frand(-1, 1) * 1.5f);
    p.v = glm::vec3(dx * 1.5f + frand(-1, 1), 0.5f + frand(-1, 1) * 0.3f, dz * 1.5f + frand(-1, 1));
    p.seed = frand(0, 50);
    p.size0 = 8.0f + frand(-1, 1) * 2.0f;
    p.size1 = 22.0f + frand(-1, 1) * 6.0f;
    p.lifetime = frand(9.0f, 14.0f);
    p.life = 0;
    p.active = true;
  }
};

bool System::init(WGPUDevice device, WGPUTextureFormat colorFormat) {
  p_ = new Impl();
  p_->particles.resize(2600);
  p_->puffs.resize(40);

  WGPUShaderModuleWGSLDescriptor wgsl = {};
  wgsl.chain.sType = WGPUSType_ShaderModuleWGSLDescriptor;
  wgsl.code = kWGSL;
  WGPUShaderModuleDescriptor smd = {}; smd.nextInChain = &wgsl.chain;
  WGPUShaderModule mod = wgpuDeviceCreateShaderModule(device, &smd);

  WGPUBufferDescriptor ubd = {};
  ubd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
  ubd.size = sizeof(glm::mat4) + 5 * sizeof(glm::vec4);
  p_->ubuf = wgpuDeviceCreateBuffer(device, &ubd);

  WGPUBindGroupLayoutEntry ble[2] = {};
  ble[0].binding = 0; ble[0].visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
  ble[0].buffer.type = WGPUBufferBindingType_Uniform;
  ble[1].binding = 1; ble[1].visibility = WGPUShaderStage_Fragment;
  ble[1].texture.sampleType = WGPUTextureSampleType_Depth;
  ble[1].texture.viewDimension = WGPUTextureViewDimension_2D;
  WGPUBindGroupLayoutDescriptor bld = {}; bld.entryCount = 2; bld.entries = ble;
  p_->bgl = wgpuDeviceCreateBindGroupLayout(device, &bld);
  WGPUPipelineLayoutDescriptor pld = {}; pld.bindGroupLayoutCount = 1; pld.bindGroupLayouts = &p_->bgl;
  WGPUPipelineLayout pl = wgpuDeviceCreatePipelineLayout(device, &pld);

  WGPUVertexAttribute attrs[3] = {};
  attrs[0].format = WGPUVertexFormat_Float32x4; attrs[0].offset = 0;  attrs[0].shaderLocation = 0;
  attrs[1].format = WGPUVertexFormat_Float32x4; attrs[1].offset = 16; attrs[1].shaderLocation = 1;
  attrs[2].format = WGPUVertexFormat_Float32x4; attrs[2].offset = 32; attrs[2].shaderLocation = 2;
  WGPUVertexBufferLayout vbl = {};
  vbl.arrayStride = sizeof(Inst);
  vbl.stepMode = WGPUVertexStepMode_Instance;
  vbl.attributeCount = 3; vbl.attributes = attrs;

  auto makePipe = [&](const char* fs, bool additive) {
    WGPUDepthStencilState ds = {};
    ds.format = WGPUTextureFormat_Depth24PlusStencil8;
    ds.depthWriteEnabled = false;            // test only: hull occludes, FX never punch holes
    ds.depthCompare = WGPUCompareFunction_Less;
    ds.stencilFront.compare = WGPUCompareFunction_Always;
    ds.stencilBack.compare = WGPUCompareFunction_Always;
    ds.stencilReadMask = 0xFFFFFFFFu; ds.stencilWriteMask = 0xFFFFFFFFu;
    WGPUBlendState blend = {};
    if (additive) {
      blend.color.srcFactor = WGPUBlendFactor_One;
      blend.color.dstFactor = WGPUBlendFactor_One;
    } else {
      blend.color.srcFactor = WGPUBlendFactor_SrcAlpha;
      blend.color.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    }
    blend.color.operation = WGPUBlendOperation_Add;
    blend.alpha.srcFactor = WGPUBlendFactor_One;
    blend.alpha.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    blend.alpha.operation = WGPUBlendOperation_Add;
    WGPUColorTargetState target = {};
    target.format = colorFormat; target.writeMask = WGPUColorWriteMask_All;
    target.blend = &blend;
    WGPUFragmentState frag = {};
    frag.module = mod; frag.entryPoint = fs; frag.targetCount = 1; frag.targets = &target;
    WGPURenderPipelineDescriptor rpd = {};
    rpd.layout = pl;
    rpd.vertex.module = mod; rpd.vertex.entryPoint = "vs_bill";
    rpd.vertex.bufferCount = 1; rpd.vertex.buffers = &vbl;
    rpd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    rpd.primitive.cullMode = WGPUCullMode_None;
    rpd.depthStencil = &ds;
    rpd.multisample.count = 1; rpd.multisample.mask = 0xFFFFFFFFu;
    rpd.fragment = &frag;
    return wgpuDeviceCreateRenderPipeline(device, &rpd);
  };
  p_->pipeParticle = makePipe("fs_particle", false);
  p_->pipeFire = makePipe("fs_particle", true);
  p_->pipeSmoke = makePipe("fs_smoke", false);
  p_->pipeExplHi = makePipe("fs_expl_hi", true);
  p_->pipeExplLo = makePipe("fs_expl_lo", true);
  wgpuPipelineLayoutRelease(pl);
  return p_->pipeExplHi != nullptr;
}

void System::muzzleBlast(const glm::vec3& m, float dirX, float dirZ, float camDist) {
  Impl& im = *p_;
  // Fireball (size 6.5, LOW tier within 9x size — client NEAR_MULT).
  ExplSlot* slot = nullptr;
  for (ExplSlot& s : im.expl) if (!s.active) { slot = &s; break; }
  if (!slot) { slot = &im.expl[0]; for (ExplSlot& s : im.expl) if (s.life > slot->life) slot = &s; }
  slot->active = true;
  slot->low = camDist < 6.5f * 9.0f;
  slot->life = 0;
  slot->size = 6.5f;
  slot->seed = std::fabs(std::fmod(m.x * 0.37f + m.z * 0.91f, 50.0f));
  slot->pos = glm::vec3(m.x + dirX * 0.5f, m.y + 0.1f, m.z + dirZ * 0.5f);
  // Smoke belch + lingering pall.
  im.emitters.push_back({ m, dirX, dirZ, 0.6f, 0.0f });
  for (int k = 0; k < 3; ++k)
    im.spawnPallPuff(glm::vec3(m.x, m.y + 0.2f, m.z), dirX, dirZ);
}

void System::shipHit(const glm::vec3& p, const glm::vec3& dirIn) {
  glm::vec3 r = -dirIn;
  float len = glm::length(r);
  if (len > 1e-4f) r /= len;
  // Reverse-entry cones (client setCone spreads).
  p_->burst(DEBRIS, 450, p, glm::vec3(0.25f, 0.25f, 0.25f),
            r * 4.0f + glm::vec3(-1, 3, -1), r * 4.0f + glm::vec3(1, 7, 1));
  p_->burst(FIRE, 160, p, glm::vec3(0.15f),
            r * 3.0f + glm::vec3(-1, 2, -1), r * 3.0f + glm::vec3(1, 6, 1));
  p_->burst(SOOT, 100, p + glm::vec3(0, 0.4f, 0), glm::vec3(0.5f, 0.4f, 0.5f),
            glm::vec3(-1, 1, -1), glm::vec3(1, 3, 1));
}

void System::waterSplash(const glm::vec3& p, const glm::vec3& velIn) {
  glm::vec3 r = -velIn;
  float len = glm::length(r);
  if (len > 1e-4f) r /= len;
  p_->burst(SPLASH, 240, glm::vec3(p.x, 0.2f, p.z), glm::vec3(0.2f, 0.1f, 0.2f),
            r * 2.0f + glm::vec3(-2, 5, -2), r * 2.0f + glm::vec3(2, 10, 2));
}

void System::spray(const glm::vec3& p, const glm::vec3& velIn, float strength, float energy) {
  // Many SMALL droplets (0.4x the cannonball-splash particle size) — fine mist, not a few blobs.
  // energy [0,1] scales the launch power: low = a lazy plume that barely clears the rail, high = spray
  // thrown high and far. Count scales with both the impact strength and the energy.
  const float e = glm::clamp(energy, 0.0f, 1.0f);
  const int n = (int)((110.0f + 190.0f * glm::clamp(strength, 0.0f, 1.0f)) * (0.6f + 0.5f * e));
  // Slow-motion factor: velocity x k with gravity x k^2 keeps the SAME arc (height/reach) while the
  // flight takes 1/k longer — sea spray hangs in the air instead of snapping like a cannonball splash.
  const float k = 0.6f;
  p_->burst(SPLASH, n, p, glm::vec3(0.5f, 0.2f, 0.5f),
            velIn + glm::vec3(-1.5f, 2.0f, -1.5f), velIn + glm::vec3(1.5f, 4.5f, 1.5f),
            0.4f, (0.4f + 0.85f * e) * k, k * k, 1.0f / k);
}

void System::landHit(const glm::vec3& p, const glm::vec3& velIn) {
  glm::vec3 r = -velIn;
  float len = glm::length(r);
  if (len > 1e-4f) r /= len;
  p_->burst(DIRT, 300, p, glm::vec3(0.2f),
            r * 2.0f + glm::vec3(-1.5f, 5, -1.5f), r * 2.0f + glm::vec3(1.5f, 12, 1.5f));
  p_->burst(LANDSMOKE, 100, p, glm::vec3(1.0f, 0.4f, 1.0f),
            glm::vec3(-1, 1, -1), glm::vec3(1, 2, 1));
}

void System::update(float dt, float windX, float windZ) {
  Impl& im = *p_;
  // Fireballs (0.9 s, ANIM_RATE 6.3, expand 0.8 -> 1.15).
  for (ExplSlot& s : im.expl) {
    if (!s.active) continue;
    s.life += dt / 0.9f;
    if (s.life >= 1.0f) s.active = false;
  }
  // Belch emitters spit puffs every 0.06 s over 0.6 s.
  for (Emitter& e : im.emitters) {
    e.tLeft -= dt; e.spawnIn -= dt;
    while (e.spawnIn <= 0 && e.tLeft > 0) { im.spawnBelchPuff(e); e.spawnIn += 0.06f; }
  }
  im.emitters.erase(std::remove_if(im.emitters.begin(), im.emitters.end(),
                                   [](const Emitter& e) { return e.tLeft <= 0; }),
                    im.emitters.end());
  // Puffs: drag, buoyancy, wind drift.
  const float dragH = std::max(0.0f, 1.0f - 0.85f * dt);
  for (Puff& q : im.puffs) {
    if (!q.active) continue;
    q.life += dt / q.lifetime;
    if (q.life >= 1.0f) { q.active = false; continue; }
    q.v.x *= dragH; q.v.z *= dragH;
    q.v.y = q.v.y * std::max(0.0f, 1.0f - 0.4f * dt) + 0.5f * dt;
    q.p += glm::vec3((q.v.x + windX) * dt, q.v.y * dt, (q.v.z + windZ) * dt);
  }
  // Particles.
  for (Particle& q : im.particles) {
    if (!q.active) continue;
    q.life += dt / q.lifetime;
    if (q.life >= 1.0f) { q.active = false; continue; }
    const SysDef& d = kSys[q.sys];
    if (d.velGradient) {
      // Fast out -> hang (client velocity gradient 1.0 -> 0.2 -> 0.02).
      float vk = q.life < 0.1f ? 1.0f - q.life / 0.1f * 0.8f : 0.2f - (q.life - 0.1f) / 0.9f * 0.18f;
      q.p += q.v * (vk * dt);
      q.p += d.gravity * dt;   // gentle drift, not accumulated velocity
    } else {
      q.v += d.gravity * (q.gscale * dt);
      q.p += q.v * dt;
    }
  }
}

bool System::anyActive() const {
  for (const ExplSlot& s : p_->expl) if (s.active) return true;
  for (const Puff& q : p_->puffs) if (q.active) return true;
  for (const Particle& q : p_->particles) if (q.active) return true;
  return !p_->emitters.empty();
}

void System::draw(WGPUDevice device, WGPUQueue queue, WGPURenderPassEncoder pass,
                  const glm::mat4& viewProj, const glm::vec3& camRight, const glm::vec3& camUp,
                  const glm::vec3& camFwd, const glm::vec3& camPos,
                  WGPUTextureView sceneDepth, const glm::vec4& proj) {
  Impl& im = *p_;
  // Build instance runs: [particles-normal][fire][smoke][explHi][explLo].
  std::vector<Inst> inst;
  inst.reserve(512);
  auto pushParticles = [&](bool additive) {
    uint32_t start = (uint32_t)inst.size();
    for (const Particle& q : im.particles) {
      if (!q.active) continue;
      const SysDef& d = kSys[q.sys];
      if (d.additive != additive) continue;
      float size = q.size0 + (q.size1 - q.size0) * q.life;
      inst.push_back({ glm::vec4(q.p, size), glm::vec4(q.life, 0, 0, 0), im.colorAt(d, q.life) });
    }
    return std::make_pair(start, (uint32_t)inst.size());
  };
  auto normRun = pushParticles(false);
  auto fireRun = pushParticles(true);
  uint32_t smokeStart = (uint32_t)inst.size();
  for (const Puff& q : im.puffs) {
    if (!q.active) continue;
    float grow = 1.0f - (1.0f - q.life) * (1.0f - q.life);
    float size = q.size0 + (q.size1 - q.size0) * grow;
    inst.push_back({ glm::vec4(q.p, size),
                     glm::vec4(q.life, q.seed + q.life * q.lifetime, q.seed, 0), glm::vec4(1) });
  }
  uint32_t smokeEnd = (uint32_t)inst.size();
  uint32_t hiStart = smokeEnd;
  for (const ExplSlot& s : im.expl) {
    if (!s.active || s.low) continue;
    float size = s.size * (0.8f + 0.35f * s.life);
    inst.push_back({ glm::vec4(s.pos, size),
                     glm::vec4(s.life, s.seed + s.life * 0.9f * 6.3f, s.seed, 0), glm::vec4(1) });
  }
  uint32_t hiEnd = (uint32_t)inst.size();
  for (const ExplSlot& s : im.expl) {
    if (!s.active || !s.low) continue;
    float size = s.size * (0.8f + 0.35f * s.life);
    inst.push_back({ glm::vec4(s.pos, size),
                     glm::vec4(s.life, s.seed + s.life * 0.9f * 6.3f, s.seed, 0), glm::vec4(1) });
  }
  uint32_t loEnd = (uint32_t)inst.size();
  if (inst.empty()) return;

  struct { glm::mat4 vp; glm::vec4 r, u, f, c, proj; } uni{
    viewProj, glm::vec4(camRight, 0), glm::vec4(camUp, 0),
    glm::vec4(camFwd, 3.0f) /* soft range m */, glm::vec4(camPos, 0), proj };
  wgpuQueueWriteBuffer(queue, im.ubuf, 0, &uni, sizeof(uni));

  const uint64_t bytes = inst.size() * sizeof(Inst);
  if (bytes > im.vbufCap) {
    if (im.vbuf) wgpuBufferRelease(im.vbuf);
    im.vbufCap = bytes * 2;
    WGPUBufferDescriptor vbd = {};
    vbd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
    vbd.size = im.vbufCap;
    im.vbuf = wgpuDeviceCreateBuffer(device, &vbd);
  }
  wgpuQueueWriteBuffer(queue, im.vbuf, 0, inst.data(), bytes);

  if (!im.bind || im.boundDepth != sceneDepth) {
    if (im.bind) wgpuBindGroupRelease(im.bind);
    WGPUBindGroupEntry e[2] = {};
    e[0].binding = 0; e[0].buffer = im.ubuf; e[0].size = sizeof(uni);
    e[1].binding = 1; e[1].textureView = sceneDepth;
    WGPUBindGroupDescriptor d = {}; d.layout = im.bgl; d.entryCount = 2; d.entries = e;
    im.bind = wgpuDeviceCreateBindGroup(device, &d);
    im.boundDepth = sceneDepth;
  }
  wgpuRenderPassEncoderSetBindGroup(pass, 0, im.bind, 0, nullptr);
  wgpuRenderPassEncoderSetVertexBuffer(pass, 0, im.vbuf, 0, bytes);
  auto drawRun = [&](WGPURenderPipeline pipe, uint32_t a, uint32_t b) {
    if (b <= a) return;
    wgpuRenderPassEncoderSetPipeline(pass, pipe);
    wgpuRenderPassEncoderDraw(pass, 6, b - a, 0, a);
  };
  drawRun(im.pipeParticle, normRun.first, normRun.second);
  drawRun(im.pipeSmoke, smokeStart, smokeEnd);
  drawRun(im.pipeFire, fireRun.first, fireRun.second);
  drawRun(im.pipeExplHi, hiStart, hiEnd);
  drawRun(im.pipeExplLo, hiEnd, loEnd);
}

}  // namespace fx
