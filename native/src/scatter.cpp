#include "scatter.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <chrono>
#include <future>
#include <random>
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
static float angDiff(float b, float a) {
  float d = std::fmod(b - a, TAU);
  if (d > glm::pi<float>()) d -= TAU; else if (d < -glm::pi<float>()) d += TAU;
  return d;
}

// One instance: rows of the 3x4 world transform + tint + per-instance energy
// (the animal animation amplitude; static props leave it 1).
struct Inst {
  float r0[4], r1[4], r2[4];
  float tintE[4];
};
static_assert(sizeof(Inst) == 16 * sizeof(float), "instance layout");

static Inst composeQ(glm::vec4 q, float sx, float sy, float sz,
                     float px, float y, float pz, glm::vec3 tint, float energy) {
  float x = q.x, yy = q.y, z = q.z, w = q.w;
  glm::vec3 c0 = glm::vec3(1 - 2 * (yy * yy + z * z), 2 * (x * yy + w * z), 2 * (x * z - w * yy)) * sx;
  glm::vec3 c1 = glm::vec3(2 * (x * yy - w * z), 1 - 2 * (x * x + z * z), 2 * (yy * z + w * x)) * sy;
  glm::vec3 c2 = glm::vec3(2 * (x * z + w * yy), 2 * (yy * z - w * x), 1 - 2 * (x * x + yy * yy)) * sz;
  Inst i;
  i.r0[0] = c0.x; i.r0[1] = c1.x; i.r0[2] = c2.x; i.r0[3] = px;
  i.r1[0] = c0.y; i.r1[1] = c1.y; i.r1[2] = c2.y; i.r1[3] = y;
  i.r2[0] = c0.z; i.r2[1] = c1.z; i.r2[2] = c2.z; i.r2[3] = pz;
  i.tintE[0] = tint.r; i.tintE[1] = tint.g; i.tintE[2] = tint.b; i.tintE[3] = energy;
  return i;
}
static glm::vec4 qAxis(glm::vec3 ax, float ang) {
  float s = std::sin(ang * 0.5f);
  return glm::vec4(ax * s, std::cos(ang * 0.5f));
}
static glm::vec4 qmul(glm::vec4 a, glm::vec4 b) {
  glm::vec3 v = a.w * glm::vec3(b) + b.w * glm::vec3(a) + glm::cross(glm::vec3(a), glm::vec3(b));
  return glm::vec4(v, a.w * b.w - glm::dot(glm::vec3(a), glm::vec3(b)));
}
// Babylon YawPitchRoll: yaw about Y, pitch about X, roll about Z (kernels + dolphins/fish).
static Inst compose(float yaw, float pitch, float roll, float sx, float sy, float sz,
                    float px, float y, float pz, glm::vec3 tint, float energy) {
  glm::vec4 q = qmul(qAxis({0, 1, 0}, yaw), qmul(qAxis({1, 0, 0}, pitch), qAxis({0, 0, 1}, roll)));
  return composeQ(q, sx, sy, sz, px, y, pz, tint, energy);
}
// Bird frame (bird.service writeBird): yaw(Y) ∘ pitch(Z, span axis) ∘ roll(X, nose axis).
static Inst composeBird(float yaw, float pitch, float roll, float s,
                        float px, float y, float pz, glm::vec3 tint, float energy) {
  glm::vec4 q = qmul(qAxis({0, 1, 0}, yaw), qmul(qAxis({0, 0, 1}, pitch), qAxis({1, 0, 0}, roll)));
  return composeQ(q, s, s, s, px, y, pz, tint, energy);
}

// ── Shader ────────────────────────────────────────────────────────────────────
// anim: x time, y mode, z wind amp, w alpha cutoff.
// lod:  x near, y band, z fadeMode (0 none / 1 full shrink-out / 2 impostor grow-in),
//       w dither-cull start (0 = off; band is 60 m).
// Animal modes (anim.y): 3 bird flap, 4 dolphin swim, 5 fish swim — exact ports of
// the client's vertex plugins; phase derives from the instance's world translation
// just like the plugins' world3-based phase. Instance tintE.w = energy.
static const char* kWGSL = R"WGSL(
struct U {
  viewProj : mat4x4<f32>,
  eye      : vec4<f32>,
  sun      : vec4<f32>,
  anim     : vec4<f32>,
  lod      : vec4<f32>,
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
           @location(7) r2 : vec4<f32>, @location(8) tintE : vec4<f32>) -> VSOut {
  var p = inPos;
  let mode = u.anim.y;
  let t = u.anim.x;
  let E = tintE.w;
  if (mode > 2.5 && mode < 3.5) {
    // BirdFlapPlugin: wingtips (|z| span) beat, body bobs gently, world-pos phase.
    let bWf  = smoothstep(0.10, 0.70, abs(p.z));
    let bBob = 1.0 - smoothstep(0.05, 0.25, abs(p.z));
    let bPh = (r0.w + r2.w) * 1.7;
    let bF = sin(3.2 * t + bPh);
    p.y += bF * (bWf * 0.26 * E + bBob * 0.05);
  }
  if (mode > 3.5 && mode < 4.5) {
    // DolphinSwimPlugin: tail pump travelling wave along -x.
    let dPump = 1.0 - smoothstep(-0.9, 0.3, p.x);
    let dPh = (r0.w + r2.w) * 0.6;
    let dW = 2.4 * t * (0.7 + 0.6 * E) - p.x * 2.2 + dPh;
    p.y += sin(dW) * dPump * 0.10 * (0.4 + 0.85 * E);
  }
  if (mode > 4.5 && mode < 5.5) {
    // FishSwimPlugin: lateral tail sway travelling wave.
    let fSway = 1.0 - smoothstep(-0.45, 0.25, p.x);
    let fPh = (r0.w + r2.w) * 0.7;
    let fW = 3.2 * t * (0.8 + 0.5 * E) - p.x * 3.4 + fPh;
    p.z += sin(fW) * fSway * 0.13 * (0.5 + 0.7 * E);
  }
  if (mode > 5.5) {
    // ShadowBlobPlugin: stretch the unit disc away from the sun; the sun-side
    // edge (along = -0.5) stays anchored under the trunk. lod = (dirX, dirZ, stretch).
    let sDir = vec2<f32>(u.lod.x, u.lod.y);
    let sLocal = vec2<f32>(p.x, p.z);
    let sAlong = dot(sLocal, sDir);
    let sPerp = sLocal - sAlong * sDir;
    let sNew = sAlong * u.lod.z + (u.lod.z - 1.0) * 0.5;
    p.x = sPerp.x + sNew * sDir.x;
    p.z = sPerp.y + sNew * sDir.y;
  }
  let isBlob = mode > 5.5;
  // LoD cross-dissolve (NearFadePlugin port): the full mesh stays 1 inside `near`
  // and shrinks out over [near, near+band]; the impostor is 1 outside and shrinks
  // over [near-band, near] — around `near` BOTH are full-size (they overlap).
  let dCam = distance(vec2<f32>(r0.w, r2.w), vec2<f32>(u.eye.x, u.eye.z));
  var f = 1.0;
  if (!isBlob) {
    if (u.lod.z > 0.5 && u.lod.z < 1.5) { f = 1.0 - smoothstep(u.lod.x, u.lod.x + u.lod.y, dCam); }
    if (u.lod.z > 1.5) { f = smoothstep(u.lod.x - u.lod.y, u.lod.x, dCam); }
  }
  p = p * f;
  var wp = vec3<f32>(dot(vec3<f32>(r0.x, r0.y, r0.z), p) + r0.w,
                     dot(vec3<f32>(r1.x, r1.y, r1.z), p) + r1.w,
                     dot(vec3<f32>(r2.x, r2.y, r2.z), p) + r2.w);
  // Wind sway (palms mode 1, beeches mode 2).
  if (mode > 0.5 && mode < 2.5) {
    let h = max(wp.y - r1.w, 0.0);
    let amp = select(0.020, 0.045, mode < 1.5) * u.anim.z;
    let b = sin(t * select(1.6, 1.1, mode < 1.5) + (r0.w + r2.w) * 0.05) * amp * h * h * 0.06;
    wp.x += b; wp.z += b * 0.6;
  }
  var o : VSOut;
  o.position = u.viewProj * vec4<f32>(wp, 1.0);
  o.worldPos = wp;
  o.normal = normalize(vec3<f32>(dot(vec3<f32>(r0.x, r0.y, r0.z), inNrm),
                                 dot(vec3<f32>(r1.x, r1.y, r1.z), inNrm),
                                 dot(vec3<f32>(r2.x, r2.y, r2.z), inNrm)));
  o.uv = inUV;
  o.tint = inAlb * vec3<f32>(tintE.x, tintE.y, tintE.z);
  return o;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let c = textureSample(tex, samp, in.uv);
  // Shadow blobs: a dark, cool, unlit decal — the dappled texture's alpha times
  // the global sun-elevation alpha (anim.w repurposed as blob opacity).
  if (u.anim.y > 5.5) {
    let a = c.a * u.anim.w;
    return vec4<f32>(vec3<f32>(0.02, 0.03, 0.05), a);
  }
  if (u.anim.w > 0.0 && c.a < u.anim.w) { discard; }
  // Screen-door dissolve at the patch-cull edge (LodDitherPlugin port): dithered
  // out over [cullStart, cullStart+60] by interleaved-gradient noise.
  if (u.lod.w > 0.0) {
    let dd = distance(in.worldPos.xz, u.eye.xz);
    let fade = 1.0 - smoothstep(u.lod.w, u.lod.w + 60.0, dd);
    let ign = fract(52.9829189 * fract(dot(in.position.xy, vec2<f32>(0.06711056, 0.00583715))));
    if (fade < ign) { discard; }
  }
  var col = c.rgb * in.tint;
  let L = normalize(u.sun.xyz);
  var N = normalize(in.normal);
  if (dot(N, u.eye.xyz - in.worldPos) < 0.0) { N = -N; }
  let diff = max(dot(N, L), 0.0);
  col = col * (0.38 + 0.62 * diff);
  let dayK = u.sun.w;
  col = col * mix(0.30, 1.0, dayK) * mix(vec3<f32>(0.48, 0.58, 0.82), vec3<f32>(1.0), dayK);
  // Aerial haze (ImpostorHazePlugin port) — far impostors recede with the terrain.
  let hd = distance(u.eye.xyz, in.worldPos);
  let haze = 1.0 - exp(-pow(hd * 0.00009, 2.0));
  col = mix(col, mix(vec3<f32>(0.13, 0.155, 0.21), vec3<f32>(0.66, 0.72, 0.80), dayK), haze);
  return vec4<f32>(col, 1.0);
}
)WGSL";

// One drawable mesh + its instance buffer + texture bind group.
struct DrawSet {
  WGPUBuffer vbuf = nullptr, ibuf = nullptr, instBuf = nullptr;
  uint32_t indexCount = 0, instCap = 0, instCount = 0;
  WGPUBindGroup bind = nullptr;
};

struct PatchData {
  std::vector<std::vector<Inst>> per;   // per-variant prop instances
  std::vector<Inst> blobs;              // flat shadow-blob discs under the props
};
struct Layer {
  std::vector<DrawSet> full;     // per variant: the full GLB mesh
  std::vector<DrawSet> lod;      // per variant: rock/drift low-poly LOD or tree cross-impostor ("" = none)
  bool impostor = false;         // lod = billboard impostors (cross-dissolve) vs plain LOD meshes
  WGPUBuffer ubufFull = nullptr, ubufLod = nullptr;
  float mode = 0, alphaCut = 0;
  int res = 0;
  int maxRing = 8;               // patch radius (grass uses the client's short 4-ring range)
  std::map<std::pair<int, int>, PatchData> patches;
  bool dirty = false;
};

// ── Wildlife state (ports of bird.service / dolphin.service / fish-school.service) ──
struct BirdMember {
  float ox, oz; int flyVariant; float scale; glm::vec3 tint; float yaw;
  bool restWingsOut; float restTimer;
  bool airborne;
  float px, py, pz, hdg, spd, vy, bank;
  float radBias, altBias;
  float flapE; bool gliding; float glideTimer;
  bool onFinal; float flare;
  int dipState; float dipTimer, dipCooldown;
};
enum class FlockState { RESTING, TAKEOFF, FLYING, LANDING };
struct Flock {
  FlockState state; float stateTimer, dwell;
  float cx, cz, cy, anchorX, anchorZ, cruiseAlt, wanderR;
  float gx, gy, gz, goalAlt, wTx, wTz, wanderTimer;
  float driftX, driftZ, nearShipDist;
  bool following; float followTimer, followCooldown;
  std::vector<BirdMember> members;
};
struct Dolphin {
  float x, z, y, theta, targetTheta, speed, targetSpeed, baseY;
  float depthPhase, depthRate, depthAmp, retarget, effort;
  int group; float bank; int bowSlot; bool breaching; float breachVy;
  float scale, homeX, homeZ; glm::vec3 tint;
};
struct FishM {
  float x, z, y, theta, targetTheta, speed, targetSpeed, baseY;
  float depthPhase, depthRate, depthAmp, retarget, effort, bank;
};
struct FishSchool {
  int species; float homeX, homeZ, scl;
  bool boiling; float boilT;
  std::vector<FishM> fish;
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

  Layer palms, trees, rocks, drift, grass;
  Layer birdsL, dolphinsL, fishL;   // wildlife draw sets (full[] only; instances per frame)
  Layer reedsL, weedsL;             // shoreline reeds + underwater seaweed (stand/clump services)
  // Static FAR impostor layers (buildFarForest port): whole-map tree/palm
  // billboards on every island's forested slopes and coasts, faded IN over
  // 280-470 m (FarFadePlugin band) so distant islands read as treed. Built once
  // off-thread from the heightfield when terrain lands.
  Layer farTrees, farPalms;
  std::future<std::pair<std::vector<std::vector<Inst>>, std::vector<std::vector<Inst>>>> farFuture;
  bool farBuilt = false;
  // Shadow blobs: one blended draw over all layers' discs (dappled texture,
  // sun-stretched in the shader). Separate pipeline: alpha blend, no depth write.
  WGPURenderPipeline blobPipeline = nullptr;
  WGPUBuffer blobUbuf = nullptr;
  DrawSet blobSet;
  int lastPX = INT32_MIN, lastPZ = INT32_MIN;
  float flushX = 1e9f, flushZ = 1e9f;   // camera pos of the last visible-set flush

  static constexpr float PATCH = 40.0f;
  static constexpr int   RINGS = 8;
  static constexpr float LOD_SPLIT = 120.0f;     // rocks/drift: full mesh inside, low-poly LOD beyond
  static constexpr float NEAR_FADE = 260.0f;     // trees: full <-> impostor cross-dissolve centre (client)
  static constexpr float NEAR_BAND = 55.0f;
  static constexpr float TREE_CULL = 280.0f;     // dither out to nothing by 340 (client treeFade)
  static constexpr int   GRASS_RING = 4;         // grass only within 4 patch rings (client)
  static constexpr float GRASS_NEAR = 30.0f;     // full clump mesh within this of the patch centre
  static constexpr int   SHADOW_RING = 3;        // blobs only near the camera (~120 m, client)

  // ── Reed stands + seaweed clumps (reed.service / seaweed.service ports) ──
  struct Sprout { float x, z, y, rotY, scale; int variant; glm::vec3 tint; };
  struct Stand { float cx, cz; std::vector<Sprout> items; };
  std::vector<Stand> reedStands, weedClumps;
  float bedAcc = 0; bool bedDirty = false;
  static constexpr float REED_ELEV_MAX = 0.3f, REED_ELEV_MIN = -1.8f, REED_CULL = 95;
  static constexpr float REED_SPAWN_MIN = 10, REED_SPAWN_MAX = 85; static constexpr int MAX_STANDS = 14;
  static constexpr float WEED_DEPTH_MIN = 2.5f, WEED_DEPTH_MAX = 18, WEED_CULL = 100;
  static constexpr float WEED_SPAWN_MIN = 8, WEED_SPAWN_MAX = 88; static constexpr int MAX_CLUMPS = 16;

  std::minstd_rand rng{ 12345 };
  float frand() { return (float)rng() / (float)std::minstd_rand::max(); }

  // Wildlife (client constants).
  std::vector<Flock> flocks;
  float spawnTimer = 0;
  static constexpr int   MAX_FLOCKS = 4;         // quality High
  static constexpr float SPAWN_INTERVAL = 1.2f;
  static constexpr float SPAWN_MIN = 60, SPAWN_MAX = 160, DESPAWN = 240, LAND_PROXIMITY = 250;
  static constexpr float SEA_Y = 0.25f, GROUND_CLEARANCE = 9, TAKEOFF_TIME = 2.6f, LAND_TIME = 3.4f;
  static constexpr float STARTLE_RADIUS = 65, IMMINENT_RADIUS = 26;
  static constexpr float CRUISE_SPD = 8.5f, MIN_SPD = 5.5f, ACCEL = 5.0f, TURN_RATE = 0.85f;
  static constexpr float MAX_BANK = 0.62f, BANK_EASE = 3.0f, CLIMB_RATE = 2.8f, VACCEL = 3.5f, PITCH_GAIN = 1.0f;
  static constexpr float NEIGH_R = 12, SEP_R = 4.5f, W_GOAL = 0.85f, W_ALI = 0.5f, W_COH = 0.35f, W_SEP = 1.7f, VSEP = 1.3f;
  static constexpr float FLARE_ALT = 7, LAND_SPD = 4.5f, FLARE_PITCH = 0.55f;
  static constexpr float FOLLOW_TRIGGER = 75, FOLLOW_DROP = 150, FOLLOW_TRAIL = 22, FOLLOW_ALT = 14,
                         FOLLOW_WANDER = 14, FOLLOW_MIN_SPD = 1.0f;
  static constexpr float DIP_SKIM_H = 0.8f, DIP_RATE = 0.015f, DIP_RATE_FOLLOW = 0.07f, DIP_DIVE_RATE = 6.5f;
  static constexpr float kBirdAmp[4] = { 1.0f, 0.4f, 1.0f, 0.5f };   // per-variant flap scale

  std::vector<Dolphin> pod;
  bool dolActive = false;
  static constexpr float D_DEPTH_MIN = 2.0f, D_DEPTH_MAX = 22, D_LEASH = 42;
  static constexpr int   D_PODS = 2;
  static constexpr float D_SURFACE_CLEAR = 1.0f, D_SEABED_CLEAR = 0.7f;
  static constexpr float D_SEP_R = 6, D_W_WANDER = 0.5f, D_W_COH = 0.5f, D_W_ALI = 0.55f, D_W_SEP = 1.8f;
  static constexpr float D_TURN = 1.7f, D_BANK_K = 0.55f, D_MAX_BANK = 0.6f, D_BANK_EASE = 3.0f;
  static constexpr float BOWRIDE_SPEED_MIN = 1.4f, BOW_AHEAD = 8, BOW_SPACING = 4, BOW_SIDE = 2.6f,
                         BOWRIDE_RANGE = 30, BOWRIDE_DEPTH = -0.9f;
  static constexpr int   MAX_RIDERS = 6, MAX_BREACH = 2;
  static constexpr float BREACH_CHANCE = 0.05f, BREACH_VY0 = 7.5f, BREACH_G = 13, BREACH_REENTRY = -1.2f,
                         BREACH_MIN_DEPTH = 3;
  static constexpr float D_UPRIGHT = glm::half_pi<float>();
  static constexpr float D_FACE = glm::pi<float>();

  std::vector<FishSchool> schools;
  bool fishActive = false;
  static constexpr float F_LEASH = 36, F_SURFACE_CLEAR = 1.2f, F_SEABED_CLEAR = 0.6f;
  static constexpr float F_SEP_R = 1.4f, F_W_WANDER = 0.35f, F_W_COH = 0.9f, F_W_ALI = 0.7f, F_W_SEP = 1.6f;
  static constexpr float F_TURN = 2.6f, F_BANK_K = 0.3f, F_MAX_BANK = 0.5f, F_BANK_EASE = 4.0f;
  static constexpr float HULL_FLEE_R = 12, HULL_FLEE_W = 3.5f, THREAT_R = 16, THREAT_FLEE_W = 4.5f,
                         BOLT_SPEED = 4.5f, BOIL_DEPTH = -0.7f;
  static constexpr int   NSPECIES = 4;

  float ground(float x, float z) const { return terr ? terr->elevation(x, z) : -1000.0f; }
  bool isLand(float x, float z) const { return ground(x, z) > 0.02f; }
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
  bool nearLand(float x, float z) const {
    const float radii[3] = { LAND_PROXIMITY * 0.35f, LAND_PROXIMITY * 0.7f, LAND_PROXIMITY };
    for (float r : radii)
      for (int k = 0; k < 6; ++k) {
        float a = ((float)k / 6.0f) * TAU;
        if (isLand(x + std::cos(a) * r, z + std::sin(a) * r)) return true;
      }
    return false;
  }
};
using Impl = System::Impl;

System::System() : p_(std::make_unique<Impl>()) {}
System::~System() = default;

// ── GPU helpers ───────────────────────────────────────────────────────────────
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
struct PngData { int w = 0, h = 0; std::vector<uint8_t> rgba; bool ok = false; };
static PngData loadPng(const std::string& path) {
  PngData out;
  int c = 0;
  unsigned char* px = stbi_load(path.c_str(), &out.w, &out.h, &c, 4);
  if (!px) return out;
  out.rgba.assign(px, px + (size_t)out.w * out.h * 4);
  stbi_image_free(px);
  out.ok = true;
  return out;
}
static WGPUTextureView loadKtx2View(Impl* p, const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return nullptr;
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  int w = 0, h = 0; std::vector<uint8_t> rgba;
  if (!decodeKtx2ToRGBA(bytes.data(), bytes.size(), w, h, rgba)) return nullptr;
  return makeTexView(p, w, h, rgba.data(), true);
}
// Fraction of the image height that is transparent below the content.
static float bottomPad(const PngData& img) {
  for (int y = img.h - 1; y >= 0; --y) {
    const uint8_t* row = img.rgba.data() + (size_t)y * img.w * 4;
    for (int x = 0; x < img.w; ++x)
      if (row[x * 4 + 3] >= 16) return (float)(img.h - 1 - y) / (float)img.h;
  }
  return 0.0f;
}

static void makeDrawSet(Impl* p, DrawSet& d, const MeshData& md, WGPUBuffer ubuf,
                        WGPUTextureView tex, uint32_t instCap) {
  WGPUBufferDescriptor vbd = {};
  vbd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
  vbd.size = md.vertices.size() * sizeof(float);
  d.vbuf = wgpuDeviceCreateBuffer(p->device, &vbd);
  wgpuQueueWriteBuffer(p->queue, d.vbuf, 0, md.vertices.data(), vbd.size);
  WGPUBufferDescriptor ibd = {};
  ibd.usage = WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
  ibd.size = md.indices.size() * sizeof(uint32_t);
  d.ibuf = wgpuDeviceCreateBuffer(p->device, &ibd);
  wgpuQueueWriteBuffer(p->queue, d.ibuf, 0, md.indices.data(), ibd.size);
  d.indexCount = (uint32_t)md.indices.size();
  d.instCap = instCap;
  WGPUBufferDescriptor xbd = {};
  xbd.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
  xbd.size = (uint64_t)instCap * sizeof(Inst);
  d.instBuf = wgpuDeviceCreateBuffer(p->device, &xbd);
  WGPUBindGroupEntry be[3] = {};
  be[0].binding = 0; be[0].buffer = ubuf; be[0].size = sizeof(glm::mat4) + 4 * sizeof(glm::vec4);
  be[1].binding = 1; be[1].textureView = tex ? tex : p->whiteView;
  be[2].binding = 2; be[2].sampler = p->samp;
  WGPUBindGroupDescriptor bgd = {}; bgd.layout = p->bgl; bgd.entryCount = 3; bgd.entries = be;
  d.bind = wgpuDeviceCreateBindGroup(p->device, &bgd);
}

// Three-quad cross billboard (createCrossImpostor port): quads at 0/60/120 deg,
// base at local y=0 (image bottom padding removed), normals up.
static MeshData makeCrossMesh(float width, float height, float basePad) {
  MeshData m;
  float y0 = -basePad * height, y1 = height - basePad * height;
  for (int k = 0; k < 3; ++k) {
    float a = (float)k / 3.0f * glm::pi<float>();
    float cx = std::cos(a) * width * 0.5f, cz = std::sin(a) * width * 0.5f;
    uint32_t base = (uint32_t)(m.vertices.size() / kFloatsPerVertex);
    auto push = [&](float x, float y, float z, float uu, float vv) {
      float v[kFloatsPerVertex] = { x, y, z, 0, 1, 0, uu, vv, 1, 1, 1, 0, 0.9f };
      m.vertices.insert(m.vertices.end(), v, v + kFloatsPerVertex);
    };
    push(-cx, y0, -cz, 0, 1); push(cx, y0, cz, 1, 1);
    push(cx, y1, cz, 1, 0);  push(-cx, y1, -cz, 0, 0);
    m.indices.insert(m.indices.end(), { base, base + 1, base + 2, base, base + 2, base + 3 });
  }
  m.ok = true;
  return m;
}

bool System::init(WGPUDevice device, WGPUQueue queue, WGPUTextureFormat colorFormat,
                  const std::string& dir) {
  Impl* p = p_.get();
  p->device = device; p->queue = queue;

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
  rpd.primitive.cullMode = WGPUCullMode_None;
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

  auto makeUbuf = [&]() {
    WGPUBufferDescriptor ubd = {};
    ubd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    ubd.size = sizeof(glm::mat4) + 4 * sizeof(glm::vec4);
    return wgpuDeviceCreateBuffer(device, &ubd);
  };
  auto embeddedTex = [&](const MeshData& md) -> WGPUTextureView {
    for (const auto& t : md.textures)
      if (t.srgb) return makeTexView(p, t.width, t.height, t.rgba.data(), true);
    return nullptr;
  };

  const std::string T = dir + "/textures/";
  bool ok = true;

  // Loads a set of GLBs sharing one atlas texture into a layer's full[] sets.
  auto initAnimalFwd = [&](Impl* pi, Layer& l, float mode, float alphaCut,
                           const std::vector<std::string>& glbs,
                           const std::string& atlasPng, uint32_t cap,
                           const std::string& adir) -> bool {
    l.mode = mode; l.alphaCut = alphaCut;
    l.ubufFull = makeUbuf();
    PngData png = loadPng(atlasPng);
    WGPUTextureView tv = png.ok ? makeTexView(pi, png.w, png.h, png.rgba.data(), true) : nullptr;
    for (const std::string& g : glbs) {
      MeshData md = loadGltfMesh((adir + "/" + g).c_str());
      if (!md.ok) { std::printf("[scatter] missing %s\n", g.c_str()); l.full.push_back({}); continue; }
      DrawSet dsA; makeDrawSet(pi, dsA, md, l.ubufFull, tv, cap);
      l.full.push_back(dsA);
    }
    return !l.full.empty();
  };

  // ── Static layers: full GLB + (LOD glb | cross-impostor) per variant ──
  struct StaticCfg {
    Layer* l; float mode, alphaCut; int res; uint32_t cap;
    std::vector<std::string> glbs, lodGlbs, texPaths, impPngs;
  };
  StaticCfg cfgs[] = {
    { &p->palms, 1, 0.5f, 14, 4000, { "palm_a.glb", "palm_b.glb", "palm_c.glb" }, {}, {},
      { T + "impostor_a.png", T + "impostor_b.png", T + "impostor_c.png" } },
    { &p->trees, 2, 0.5f, 16, 4000, { "beech_a.glb", "beech_b.glb", "beech_c.glb" }, {}, {},
      { T + "beech_impostor_a.png", T + "beech_impostor_b.png", T + "beech_impostor_c.png" } },
    { &p->rocks, 0, 0.0f, 24, 6000,
      { "rock_a.glb", "rock_b.glb", "rock_c.glb", "rock_d.glb", "rock_e.glb" },
      { "rock_a_lod.glb", "rock_b_lod.glb", "rock_c_lod.glb", "rock_d_lod.glb", "rock_e_lod.glb" },
      { T + "rock_04_albedo.ktx2", T + "rock_05_albedo.ktx2", T + "rock_cracked_albedo.ktx2",
        T + "rock_04_albedo.ktx2", T + "rock_05_albedo.ktx2" }, {} },
    { &p->drift, 0, 0.0f, 20, 3000,
      { "drift_a.glb", "drift_b.glb", "drift_c.glb", "drift_d.glb", "drift_e.glb" },
      { "drift_a_lod.glb", "drift_b_lod.glb", "drift_c_lod.glb", "drift_d_lod.glb", "drift_e_lod.glb" },
      { T + "drift_albedo.png", T + "drift_albedo.png", T + "drift_albedo.png",
        T + "drift_albedo.png", T + "drift_albedo.png" }, {} },
    { &p->grass, 0, 0.4f, 28, 12000,
      { "grass_a.glb", "grass_b.glb" },
      { "grass_a_lod.glb", "grass_b_lod.glb" },
      { T + "grass_albedo.png", T + "grass_albedo.png" }, {} },
  };
  for (auto& c : cfgs) {
    Layer& l = *c.l;
    l.mode = c.mode; l.alphaCut = c.alphaCut; l.res = c.res;
    l.impostor = !c.impPngs.empty();
    l.ubufFull = makeUbuf(); l.ubufLod = makeUbuf();
    for (size_t i = 0; i < c.glbs.size(); ++i) {
      MeshData md = loadGltfMesh((dir + "/" + c.glbs[i]).c_str());
      if (!md.ok) { std::printf("[scatter] missing %s\n", c.glbs[i].c_str()); continue; }
      WGPUTextureView tv = nullptr;
      if (i < c.texPaths.size() && !c.texPaths[i].empty()) {
        const std::string& tp = c.texPaths[i];
        if (tp.size() > 5 && tp.substr(tp.size() - 5) == ".ktx2") tv = loadKtx2View(p, tp);
        else { PngData png = loadPng(tp); if (png.ok) tv = makeTexView(p, png.w, png.h, png.rgba.data(), true); }
      } else tv = embeddedTex(md);
      DrawSet dsF; makeDrawSet(p, dsF, md, l.ubufFull, tv, c.cap);
      l.full.push_back(dsF);
      if (!c.lodGlbs.empty()) {                              // plain low-poly LOD mesh
        MeshData ml = loadGltfMesh((dir + "/" + c.lodGlbs[i]).c_str());
        DrawSet dsL;
        if (ml.ok) { makeDrawSet(p, dsL, ml, l.ubufLod, tv, c.cap); }
        l.lod.push_back(dsL);
      } else if (l.impostor) {                               // cross-billboard impostor
        PngData png = loadPng(c.impPngs[i]);
        float h = md.bbMax[1] - md.bbMin[1];
        MeshData cross = makeCrossMesh(h, h, png.ok ? bottomPad(png) : 0.0f);
        WGPUTextureView iv = png.ok ? makeTexView(p, png.w, png.h, png.rgba.data(), true) : nullptr;
        DrawSet dsI; makeDrawSet(p, dsI, cross, l.ubufLod, iv, c.cap);
        l.lod.push_back(dsI);
      }
    }
    ok = ok && !l.full.empty();
  }

  p->grass.maxRing = Impl::GRASS_RING;   // client GRASS_RING: no grass past ~180 m

  // ── Shadow blobs: blended decal pipeline + the dappled canopy disc ──
  {
    // Second pipeline: same shaders, alpha blend, depth test but NO depth write.
    WGPUBlendState bl = {};
    bl.color.srcFactor = WGPUBlendFactor_SrcAlpha;
    bl.color.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    bl.color.operation = WGPUBlendOperation_Add;
    bl.alpha.srcFactor = WGPUBlendFactor_One;
    bl.alpha.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
    bl.alpha.operation = WGPUBlendOperation_Add;
    WGPUColorTargetState bt = {}; bt.format = colorFormat; bt.writeMask = WGPUColorWriteMask_All; bt.blend = &bl;
    WGPUFragmentState bf = {}; bf.module = module; bf.entryPoint = "fs_main"; bf.targetCount = 1; bf.targets = &bt;
    WGPUDepthStencilState bds = ds;
    bds.depthWriteEnabled = false;
    WGPUPipelineLayoutDescriptor bpld = {}; bpld.bindGroupLayoutCount = 1; bpld.bindGroupLayouts = &p->bgl;
    WGPUPipelineLayout bpl = wgpuDeviceCreatePipelineLayout(device, &bpld);
    WGPURenderPipelineDescriptor brpd = rpd;
    brpd.layout = bpl; brpd.depthStencil = &bds; brpd.fragment = &bf;
    p->blobPipeline = wgpuDeviceCreateRenderPipeline(device, &brpd);
    wgpuPipelineLayoutRelease(bpl);

    // Dappled canopy shadow texture (registerShadows port): wavy-edged radial
    // gradient + radial frond streaks + punched light gaps. Alpha-only mask.
    const int S = 256; const float c2 = S / 2.0f, R = S / 2.0f - 6.0f;
    std::vector<uint8_t> tex((size_t)S * S * 4, 255);
    uint32_t seed = 0x9e3779b9u;
    auto rnd = [&]() { seed = (seed * 1103515245u + 12345u) & 0x7fffffffu; return (float)seed / (float)0x7fffffff; };
    struct Spoke { float ang, len, w, a; };
    std::vector<Spoke> spokes;
    for (int i = 0; i < 16; ++i)
      spokes.push_back({ (float)i / 16.0f * TAU + (rnd() - 0.5f) * 0.25f,
                         R * (0.7f + rnd() * 0.45f), 3 + rnd() * 5, 0.10f + rnd() * 0.10f });
    struct Punch { float x, y, r, a; };
    std::vector<Punch> punches;
    for (int i = 0; i < 60; ++i) {
      float a = rnd() * TAU, rr = rnd() * R * 0.92f;
      punches.push_back({ c2 + std::cos(a) * rr, c2 + std::sin(a) * rr, 2 + rnd() * 6, 0.12f + rnd() * 0.26f });
    }
    for (int y = 0; y < S; ++y)
      for (int x = 0; x < S; ++x) {
        float dx = x - c2, dy = y - c2;
        float r = std::hypot(dx, dy), ang = std::atan2(dy, dx);
        float wavyR = R * (0.80f + 0.18f * std::sin(ang * 5) + 0.06f * std::sin(ang * 11 + 1.3f));
        float t01 = std::clamp(r / R, 0.0f, 1.0f);
        float g = t01 < 0.55f ? 0.82f + (0.52f - 0.82f) * (t01 / 0.55f)
                : t01 < 0.85f ? 0.52f + (0.16f - 0.52f) * ((t01 - 0.55f) / 0.30f)
                              : 0.16f * (1.0f - (t01 - 0.85f) / 0.15f);
        float alpha = r <= wavyR ? std::max(0.0f, g) : 0.0f;
        for (const Spoke& sp : spokes) {
          float along = dx * std::cos(sp.ang) + dy * std::sin(sp.ang);
          float perp = std::fabs(-dx * std::sin(sp.ang) + dy * std::cos(sp.ang));
          if (along > 0 && along < sp.len && perp < sp.w * 0.5f) alpha += sp.a;
        }
        for (const Punch& pu : punches) {
          if (std::hypot(x - pu.x, y - pu.y) < pu.r) alpha *= (1.0f - pu.a);
        }
        tex[((size_t)y * S + x) * 4 + 3] = (uint8_t)(std::clamp(alpha, 0.0f, 1.0f) * 255.0f);
      }
    WGPUTextureView dappleView = makeTexView(p, S, S, tex.data(), false);

    // Unit ground quad in XZ (local x,z in [-0.5, 0.5], y = 0), uv 0..1.
    MeshData quad;
    auto pushV = [&](float x, float z, float uu, float vv) {
      float v[kFloatsPerVertex] = { x, 0, z, 0, 1, 0, uu, vv, 1, 1, 1, 0, 0.9f };
      quad.vertices.insert(quad.vertices.end(), v, v + kFloatsPerVertex);
    };
    pushV(-0.5f, -0.5f, 0, 0); pushV(0.5f, -0.5f, 1, 0);
    pushV(0.5f, 0.5f, 1, 1);  pushV(-0.5f, 0.5f, 0, 1);
    quad.indices = { 0, 1, 2, 0, 2, 3 };
    quad.ok = true;
    p->blobUbuf = makeUbuf();
    makeDrawSet(p, p->blobSet, quad, p->blobUbuf, dappleView, 20000);
  }

  // ── Far-forest / far-palm impostor layers: reuse the cross meshes + atlases;
  //    instance buffers are filled once the off-thread heightfield walk lands. ──
  {
    struct FarCfg { Layer* l; const char* glb; std::vector<std::string> pngs; };
    FarCfg fars[] = {
      { &p->farTrees, "beech_a.glb",
        { T + "beech_impostor_a.png", T + "beech_impostor_b.png", T + "beech_impostor_c.png" } },
      { &p->farPalms, "palm_a.glb",
        { T + "impostor_a.png", T + "impostor_b.png", T + "impostor_c.png" } },
    };
    for (auto& fc : fars) {
      fc.l->mode = 0; fc.l->alphaCut = 0.4f;
      fc.l->ubufFull = makeUbuf();
      MeshData ref = loadGltfMesh((dir + "/" + std::string(fc.glb)).c_str());
      float h = ref.ok ? (ref.bbMax[1] - ref.bbMin[1]) : 10.0f;
      for (const std::string& png : fc.pngs) {
        PngData img = loadPng(png);
        MeshData cross = makeCrossMesh(h, h, img.ok ? bottomPad(img) : 0.0f);
        WGPUTextureView iv = img.ok ? makeTexView(p, img.w, img.h, img.rgba.data(), true) : nullptr;
        DrawSet dsF; makeDrawSet(p, dsF, cross, fc.l->ubufFull, iv, 220000);
        fc.l->full.push_back(dsF);
      }
    }
  }

  // ── Shoreline reeds + underwater seaweed (LOD-only meshes, alpha atlas) ──
  ok &= initAnimalFwd(p, p->reedsL, 0, 0.4f,
                      { "reed_a_lod.glb", "reed_b_lod.glb", "reed_c_lod.glb" }, T + "reeds_atlas.png", 384, dir);
  ok &= initAnimalFwd(p, p->weedsL, 0, 0.0f,
                      { "seaweed_a_lod.glb", "seaweed_b_lod.glb", "seaweed_c_lod.glb" }, T + "seaweed_albedo.png", 384, dir);

  // ── Wildlife draw sets ──
  ok &= initAnimalFwd(p, p->birdsL, 3, 0.5f,
                      { "bird_a.glb", "bird_b.glb", "bird_c.glb", "bird_d.glb" }, T + "bird_atlas.png", 220, dir);
  ok &= initAnimalFwd(p, p->dolphinsL, 4, 0.0f,
                      { "dolphin_a.glb", "dolphin_b.glb", "dolphin_c.glb" }, T + "dolphin_atlas.png", 32, dir);
  // Fish: 4 species = UV-row-remapped clones of the two bodies (fish-school.service SPECIES).
  {
    Layer& l = p->fishL;
    l.mode = 5; l.alphaCut = 0.5f;
    l.ubufFull = makeUbuf();
    PngData png = loadPng(T + "fish_atlas.png");
    WGPUTextureView tv = png.ok ? makeTexView(p, png.w, png.h, png.rgba.data(), true) : nullptr;
    MeshData bodyA = loadGltfMesh((dir + "/fish_a.glb").c_str());
    MeshData bodyB = loadGltfMesh((dir + "/fish_b.glb").c_str());
    const struct { int row; char body; } SPECIES[4] = { {0,'a'}, {1,'b'}, {2,'b'}, {3,'a'} };
    for (int s = 0; s < 4; ++s) {
      const MeshData& src = SPECIES[s].body == 'a' ? bodyA : bodyB;
      if (!src.ok) { l.full.push_back({}); continue; }
      MeshData md = src;
      float rowH = 1.0f / (float)Impl::NSPECIES;
      for (size_t v = 0; v + kFloatsPerVertex <= md.vertices.size(); v += kFloatsPerVertex)
        md.vertices[v + 7] = md.vertices[v + 7] * rowH + (float)SPECIES[s].row * rowH;
      DrawSet dsF; makeDrawSet(p, dsF, md, l.ubufFull, tv, 64);
      l.full.push_back(dsF);
    }
    ok &= !l.full.empty();
  }

  p->ready = ok;
  std::printf("[scatter] %s (palms %zu+%zu, trees %zu+%zu, rocks %zu+%zu, drift %zu+%zu, birds %zu, dolphins %zu, fish %zu)\n",
              ok ? "ready" : "INCOMPLETE",
              p->palms.full.size(), p->palms.lod.size(), p->trees.full.size(), p->trees.lod.size(),
              p->rocks.full.size(), p->rocks.lod.size(), p->drift.full.size(), p->drift.lod.size(),
              p->birdsL.full.size(), p->dolphinsL.full.size(), p->fishL.full.size());
  return ok;
}

// Whole-map far-impostor walk (buildFarForest port): sample every heightfield
// cell (jittered, stride-capped), gate by the client's dense far-forest recipe
// (or the palm coast band), reservoir-cap the budget, and bin by variant.
static std::pair<std::vector<std::vector<Inst>>, std::vector<std::vector<Inst>>>
buildFarLayers(const terrain::Terrain* terr) {
  std::pair<std::vector<std::vector<Inst>>, std::vector<std::vector<Inst>>> out;
  out.first.resize(3); out.second.resize(3);
  const terrain::Manifest& m = terr->manifest();
  float spanX = (float)(m.maxX - m.minX), spanZ = (float)(m.maxZ - m.minZ);
  int nx = std::max(2, m.width), nz = std::max(2, m.height);
  int stride = std::max(1, (int)std::ceil(std::sqrt((double)nx * nz / 8000000.0)));
  float peak = 1.0f;
  for (float v : terr->field()) peak = std::max(peak, v);
  float yLo = std::max(0.6f, 0.04f * peak), yHi = 0.74f * peak;
  auto ground = [&](float x, float z) { return terr->elevation(x, z); };
  auto slopeAt = [&](float x, float z) {
    const float e = 3.0f;
    float gx = ground(x + e, z) - ground(x - e, z);
    float gz = ground(x, z + e) - ground(x, z - e);
    return std::hypot(gx, gz) / (2.0f * e);
  };
  auto nearShoreline = [&](float x, float z, float d) {
    for (int i = 0; i < 6; ++i) {
      float a = (float)i / 6.0f * TAU;
      if (ground(x + std::cos(a) * d, z + std::sin(a) * d) <= 0.4f) return true;
    }
    return false;
  };
  const int BUDGET_PER = 200000;   // per variant bin (600k total, the client's cap)
  std::minstd_rand rng{ 777 };
  for (int iz = 0; iz < nz; iz += stride)
    for (int ix = 0; ix < nx; ix += stride) {
      float jx = hash2(ix * 12.9f + iz, iz * 78.2f + ix), jz = hash2(ix * 39.3f + 7.1f, iz * 11.7f - 3.3f);
      float px = (float)m.minX + ((ix + jx) / (float)(nx - 1)) * spanX;
      float pz = (float)m.maxZ - ((iz + jz) / (float)(nz - 1)) * spanZ;
      float y = ground(px, pz);
      // ── FAR FOREST (beech impostors): the client's dense canopy recipe. ──
      if (y >= yLo && y <= yHi) {
        float sl = slopeAt(px, pz);
        if (sl <= 0.6f) {
          float stand = fbm2(px / 45.0f, pz / 45.0f), clearing = fbm2(px / 13.0f + 9.0f, pz / 13.0f - 4.0f);
          float standC = sstep(0.28f, 0.62f, stand), clearC = sstep(0.18f, 0.52f, clearing);
          float dens = (0.45f + 0.55f * standC) * clearC * (1.0f - sl * 0.35f);
          if (hash2(px * 3.1f + 1.7f, pz * 2.9f - 3.3f) <= dens && !nearShoreline(px, pz, 6.0f)) {
            int v = std::min(2, (int)(hash2(px * 0.71f + 50.0f, pz * 0.67f - 50.0f) * 3.0f));
            if ((int)out.first[(size_t)v].size() < BUDGET_PER) {
              float s = 0.9f + hash2(px * 5.3f - 2.0f, pz * 4.7f + 8.0f) * 0.22f;
              out.first[(size_t)v].push_back(
                  compose(0, 0, 0, s, s, s, px, y - 0.35f, pz, glm::vec3(1.0f), 1.0f));
            }
          }
        }
      }
      // ── FAR COAST PALMS: the near palm kernel's gates (so the far layer's groves
      //    land where the near ring's real palms are — a clean handoff). ──
      if (y >= 0.6f && y <= 45.0f) {
        float sl = slopeAt(px, pz);
        if (sl <= 0.5f) {
          float stand = fbm2(px / 28.0f + 60.0f, pz / 28.0f - 40.0f);
          float dens = sstep(0.48f, 0.80f, stand) * (1.0f - sl * 0.6f) * 0.95f;
          if (hash2(px * 3.1f + 1.7f, pz * 2.9f - 3.3f) <= dens && !nearShoreline(px, pz, 7.0f)) {
            int v = std::min(2, (int)(hash2(px * 0.71f + 50.0f, pz * 0.67f - 50.0f) * 3.0f));
            if ((int)out.second[(size_t)v].size() < BUDGET_PER) {
              float s = 0.92f + hash2(px * 5.3f - 2.0f, pz * 4.7f + 8.0f) * 0.16f;
              out.second[(size_t)v].push_back(
                  compose(0, 0, 0, s, s, s, px, y - 0.35f, pz, glm::vec3(1.0f), 1.0f));
            }
          }
        }
      }
    }
  (void)rng;
  return out;
}

void System::setTerrain(const terrain::Terrain* terr) {
  p_->terr = terr;
  if (terr && !p_->farBuilt && !p_->farFuture.valid())
    p_->farFuture = std::async(std::launch::async, [terr] { return buildFarLayers(terr); });
}

// ── Placement kernels (unchanged CPU twins) ───────────────────────────────────
static int variantOf(size_t n, float px, float pz) {
  return (int)(hash2(px * 0.71f + 50.0f, pz * 0.67f - 50.0f) * (float)n) % (int)n;
}
static const glm::vec3 kRockTints[6] = {
  { 1.00f, 1.00f, 1.00f }, { 0.92f, 0.90f, 0.87f }, { 0.87f, 0.89f, 0.93f },
  { 1.00f, 0.97f, 0.92f }, { 0.91f, 0.93f, 0.90f }, { 0.96f, 0.96f, 0.99f } };
static const glm::vec3 kDriftTints[6] = {
  { 1.00f, 1.00f, 1.02f }, { 1.02f, 1.00f, 0.96f }, { 0.96f, 0.93f, 0.88f },
  { 0.90f, 0.86f, 0.80f }, { 0.97f, 0.94f, 0.88f }, { 0.86f, 0.88f, 0.90f } };

typedef void (*Kernel)(Impl*, size_t, float, float, std::vector<std::vector<Inst>>&, std::vector<Inst>&);
// A flat disc instance under a prop (unit XZ quad scaled to d = radius * 2).
static Inst blobInst(float px, float groundY, float pz, float radius) {
  Inst i{};
  float d = radius * 2.0f;
  i.r0[0] = d; i.r0[3] = px;
  i.r1[1] = 1; i.r1[3] = groundY + 0.06f;
  i.r2[2] = d; i.r2[3] = pz;
  i.tintE[0] = i.tintE[1] = i.tintE[2] = 1; i.tintE[3] = 1;
  return i;
}
static void palmKernel(Impl* p, size_t nv, float px, float pz, std::vector<std::vector<Inst>>& out, std::vector<Inst>& blobs) {
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
  out[variantOf(nv, px, pz)].push_back(compose(yaw, 0, 0, s, s, s, px, y - 0.35f, pz, glm::vec3(1.0f), 1.0f));
  blobs.push_back(blobInst(px, y, pz, s * 2.6f));
}
static void treeKernel(Impl* p, size_t nv, float px, float pz, std::vector<std::vector<Inst>>& out, std::vector<Inst>& blobs) {
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
  out[variantOf(nv, px, pz)].push_back(compose(yaw, 0, 0, s, s, s, px, y - 0.35f, pz, glm::vec3(1.0f), 1.0f));
  blobs.push_back(blobInst(px, y, pz, s * 4.2f));
}
static void rockKernel(Impl* p, size_t nv, float px, float pz, std::vector<std::vector<Inst>>& out, std::vector<Inst>& blobs) {
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
  out[variantOf(nv, px, pz)].push_back(
      compose(yaw, pitch, roll, sx, sy, sz, px, y - base * 0.1f, pz, kRockTints[ti], 1.0f));
  blobs.push_back(blobInst(px, y, pz, std::max(0.8f, std::max(sx, sz) * 1.3f)));
}
static void driftKernel(Impl* p, size_t nv, float px, float pz, std::vector<std::vector<Inst>>& out, std::vector<Inst>& blobs) {
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
  out[variantOf(nv, px, pz)].push_back(
      compose(yaw, pitch, roll, s, s, s, px, y - 0.03f, pz, kDriftTints[ti], 1.0f));
  blobs.push_back(blobInst(px, y, pz, s * 1.15f));
}

// Grass (GRASS_WGSL port): forest meadow floor + beach-band bush cores, each hit
// emitting a burst of 3-6 blade clumps within a 0.9 m bush radius. No blobs.
static const glm::vec3 kGrassTints[5] = {
  { 0.88f, 1.00f, 0.78f }, { 1.00f, 1.00f, 0.72f }, { 1.05f, 0.92f, 0.55f },
  { 1.12f, 0.84f, 0.42f }, { 1.15f, 0.95f, 0.55f } };
static float step01(float a, float b, float x) { float t = sstep(a, b, x); return t * t * (3.0f - 2.0f * t); }
static void grassEmit(Impl* p, size_t nv, float px, float pz, float y, std::vector<std::vector<Inst>>& out) {
  float s = 0.7f + hash2(px * 5.3f - 2.0f, pz * 4.7f + 8.0f) * 0.9f;
  float yaw = hash2(px * 1.13f + 7.0f, pz * 1.07f - 7.0f) * TAU;
  int ti = (int)(hash2(px * 0.9f - 11.0f, pz * 0.9f + 11.0f) * 5.0f) % 5;
  out[variantOf(nv, px, pz)].push_back(compose(yaw, 0, 0, s, s, s, px, y - 0.02f, pz, kGrassTints[ti], 1.0f));
}
static void grassKernel(Impl* p, size_t nv, float px, float pz, std::vector<std::vector<Inst>>& out, std::vector<Inst>&) {
  float y = p->ground(px, pz);
  if (y < 0.6f) return;
  float sl = p->slope(px, pz);
  if (sl > 0.7f) return;
  float region = fbm2(px / 45.0f + 120.0f, pz / 45.0f - 60.0f);
  float bush = fbm2(px / 5.0f + 31.0f, pz / 5.0f + 17.0f);
  float core = step01(0.50f, 0.78f, bush);
  float coreD = core * core * core;
  float alt = 1.0f - sstep(90.0f, 140.0f, y);
  float forestRegion = step01(0.34f, 0.50f, region);
  float forestCover = 0.55f + 0.45f * coreD;
  float lowland = sstep(1.5f, 13.0f, y);
  float forestDens = forestRegion * forestCover * lowland;
  float beachBand = sstep(0.7f, 1.8f, y) * (1.0f - sstep(4.0f, 11.0f, y));
  float beachRegion = step01(0.50f, 0.62f, region);
  float beachDens = beachRegion * coreD * beachBand * 0.85f;
  float density = std::max(forestDens, beachDens) * alt * (1.0f - sl * 0.7f);
  if (hash2(px * 3.1f + 1.7f, pz * 2.9f - 3.3f) > density) return;
  grassEmit(p, nv, px, pz, y, out);
  const float BURST = 6.0f, BUSH_R = 0.9f;
  int blades = (int)(3.0f + coreD * (BURST - 3.0f));
  for (int b = 1; b < blades; ++b) {
    float fb = (float)b;
    float ang = hash2(px * (3.1f + fb * 0.7f) + fb * 1.7f, pz * (2.3f + fb * 0.5f) - fb * 2.9f) * TAU;
    float rad = std::sqrt(hash2(px * (5.7f + fb) + 3.0f, pz * (1.9f + fb) - 3.0f)) * BUSH_R;
    float jx = px + std::cos(ang) * rad, jz = pz + std::sin(ang) * rad;
    grassEmit(p, nv, jx, jz, p->ground(jx, jz), out);
  }
}

static void placePatch(Impl* p, Layer& l, int pxi, int pzi, Kernel k) {
  auto key = std::make_pair(pxi, pzi);
  if (l.patches.count(key)) return;
  PatchData pd;
  pd.per.resize(l.full.size());
  float cx = ((float)pxi + 0.5f) * Impl::PATCH, cz = ((float)pzi + 0.5f) * Impl::PATCH;
  for (int gz = 0; gz < l.res; ++gz)
    for (int gx = 0; gx < l.res; ++gx) {
      float cell = Impl::PATCH / (float)l.res;
      float wx = cx + ((float)gx + hash2(cx + gx * 12.9f, cz + gz * 78.2f)) * cell - Impl::PATCH * 0.5f;
      float wz = cz + ((float)gz + hash2(cx + gx * 39.3f + 7.1f, cz + gz * 11.7f - 3.3f)) * cell - Impl::PATCH * 0.5f;
      k(p, l.full.size(), wx, wz, pd.per, pd.blobs);
    }
  l.patches.emplace(key, std::move(pd));
  l.dirty = true;
}

// ── Wildlife updates: exact behaviour ports ───────────────────────────────────
static void updateBirds(Impl* p, float dt, float camX, float camZ,
                        const System::ShipInfo& ship, float storminess) {
  bool welcome = storminess < 0.35f;

  for (int i = (int)p->flocks.size() - 1; i >= 0; --i) {
    Flock& f = p->flocks[(size_t)i];
    if (std::hypot(f.cx - camX, f.cz - camZ) > Impl::DESPAWN)
      p->flocks.erase(p->flocks.begin() + i);
  }
  if (welcome) {
    p->spawnTimer += dt;
    if ((int)p->flocks.size() < Impl::MAX_FLOCKS && p->spawnTimer >= Impl::SPAWN_INTERVAL) {
      p->spawnTimer = 0;
      // findCoastalSpot: water within the spawn ring with land nearby.
      for (int tr = 0; tr < 8; ++tr) {
        float ang = p->frand() * TAU;
        float r = Impl::SPAWN_MIN + p->frand() * (Impl::SPAWN_MAX - Impl::SPAWN_MIN);
        float x = camX + std::cos(ang) * r, z = camZ + std::sin(ang) * r;
        if (p->isLand(x, z) || !p->nearLand(x, z)) continue;
        // makeFlock
        Flock f{};
        int count = 7 + (int)(p->frand() * 11);
        float spread = 8 + p->frand() * 12;
        for (int b = 0; b < count; ++b) {
          BirdMember m{};
          m.ox = (p->frand() - 0.5f) * 2 * spread; m.oz = (p->frand() - 0.5f) * 2 * spread;
          m.flyVariant = p->frand() < 0.35f ? 1 : 0;
          m.scale = 0.85f + p->frand() * 0.45f;
          const glm::vec3 tints[4] = { {1, 1, 1}, {0.88f, 0.90f, 0.94f}, {0.82f, 0.74f, 0.62f}, {0.66f, 0.70f, 0.76f} };
          m.tint = tints[(int)(p->frand() * 4) & 3];
          m.yaw = p->frand() * TAU;
          m.restTimer = 3 + p->frand() * 16;
          m.px = x; m.py = Impl::SEA_Y; m.pz = z; m.hdg = p->frand() * TAU;
          m.radBias = 0.6f + p->frand() * 0.8f; m.altBias = (p->frand() - 0.5f) * 12;
          m.flapE = 0.6f; m.dipCooldown = p->frand() * 10;
          f.members.push_back(m);
        }
        float drift = 0.12f + p->frand() * 0.22f, dang = p->frand() * TAU;
        bool airborne = p->frand() < 0.35f;
        f.cruiseAlt = 22 + p->frand() * 22;
        f.state = airborne ? FlockState::FLYING : FlockState::RESTING;
        f.dwell = airborne ? 14 + p->frand() * 18 : 4 + p->frand() * 16;
        f.cx = x; f.cz = z; f.cy = Impl::SEA_Y; f.anchorX = x; f.anchorZ = z;
        f.wanderR = 16 + p->frand() * 26;
        f.gx = x; f.gz = z; f.gy = airborne ? f.cruiseAlt : Impl::SEA_Y;
        f.goalAlt = f.gy; f.wTx = x; f.wTz = z;
        f.driftX = std::cos(dang) * drift; f.driftZ = std::sin(dang) * drift;
        f.nearShipDist = -1;
        if (airborne)
          for (BirdMember& m : f.members) {
            m.airborne = true;
            m.px = f.gx + m.ox; m.py = f.cruiseAlt + m.altBias * 0.5f; m.pz = f.gz + m.oz;
            m.hdg = p->frand() * TAU; m.spd = Impl::CRUISE_SPD;
          }
        p->flocks.push_back(std::move(f));
        break;
      }
    }
  }

  bool shipUnderway = !ship.anchored && std::fabs(ship.speedMps) > Impl::FOLLOW_MIN_SPD && welcome;

  auto beginTakeoff = [&](Flock& f) {
    f.state = FlockState::TAKEOFF; f.stateTimer = 0;
    f.anchorX = f.cx; f.anchorZ = f.cz;
    f.gx = f.cx; f.gz = f.cz; f.goalAlt = Impl::SEA_Y;
    f.wTx = f.cx; f.wTz = f.cz; f.wanderTimer = 0;
    for (BirdMember& m : f.members) {
      m.airborne = true;
      m.px = f.cx + m.ox; m.py = Impl::SEA_Y; m.pz = f.cz + m.oz;
      m.hdg = std::atan2(m.px - f.cx, m.pz - f.cz) + (p->frand() - 0.5f) * 0.6f;
      m.spd = Impl::MIN_SPD; m.vy = Impl::CLIMB_RATE * 0.7f; m.bank = 0;
    }
  };
  auto updateGoal = [&](Flock& f) {
    if ((f.wanderTimer -= dt) <= 0) {
      float ang = p->frand() * TAU, r = f.wanderR * (0.3f + p->frand() * 0.7f);
      f.wTx = f.anchorX + std::cos(ang) * r; f.wTz = f.anchorZ + std::sin(ang) * r;
      f.wanderTimer = 4 + p->frand() * 5;
    }
    float k = std::min(1.0f, dt * 0.3f);
    f.gx += (f.wTx - f.gx) * k; f.gz += (f.wTz - f.gz) * k; f.gy = f.goalAlt;
    f.cx = f.gx; f.cz = f.gz; f.cy = f.goalAlt;
  };
  auto steerBird = [&](Flock& f, BirdMember& m) {
    const float NEIGH2 = Impl::NEIGH_R * Impl::NEIGH_R, SEP2 = Impl::SEP_R * Impl::SEP_R;
    float sepX = 0, sepZ = 0, sepY = 0, aliX = 0, aliZ = 0, cohX = 0, cohZ = 0; int cohN = 0;
    for (const BirdMember& o : f.members) {
      if (&o == &m || !o.airborne) continue;
      float ddx = m.px - o.px, ddz = m.pz - o.pz, d2 = ddx * ddx + ddz * ddz;
      if (d2 > NEIGH2) continue;
      aliX += std::sin(o.hdg); aliZ += std::cos(o.hdg);
      cohX += o.px; cohZ += o.pz; ++cohN;
      if (d2 < SEP2) {
        float d = std::sqrt(d2); if (d < 1e-3f) d = 1e-3f;
        float w = 1 - d / Impl::SEP_R;
        sepX += (ddx / d) * w; sepZ += (ddz / d) * w;
        float ddy = m.py - o.py;
        if (std::fabs(ddy) < 2.5f) sepY += (ddy >= 0 ? 1.0f : -1.0f) * (1 - std::fabs(ddy) / 2.5f) * w;
      }
    }
    float dirX = f.gx - m.px, dirZ = f.gz - m.pz;
    float gl = std::hypot(dirX, dirZ); if (gl < 1e-6f) gl = 1;
    dirX = dirX / gl * Impl::W_GOAL; dirZ = dirZ / gl * Impl::W_GOAL;
    if (cohN > 0) {
      float al = std::hypot(aliX, aliZ); if (al < 1e-6f) al = 1;
      dirX += aliX / al * Impl::W_ALI; dirZ += aliZ / al * Impl::W_ALI;
      float cx2 = cohX / cohN - m.px, cz2 = cohZ / cohN - m.pz;
      float cl = std::hypot(cx2, cz2); if (cl < 1e-6f) cl = 1;
      dirX += cx2 / cl * Impl::W_COH; dirZ += cz2 / cl * Impl::W_COH;
    }
    dirX += sepX * Impl::W_SEP; dirZ += sepZ * Impl::W_SEP;
    float ty = (m.dipState == 1 || m.dipState == 2) ? Impl::SEA_Y + Impl::DIP_SKIM_H
                                                    : f.gy + m.altBias * 0.5f;
    float desired = std::atan2(dirX, dirZ);
    float dh = angDiff(desired, m.hdg);
    float maxTurn = Impl::TURN_RATE * dt;
    float turn = std::clamp(dh, -maxTurn, maxTurn);
    m.hdg += turn;
    float yawRate = dt > 1e-4f ? turn / dt : 0;
    float targetSpd = (ty - m.py) > 1.5f ? Impl::CRUISE_SPD * 0.85f : Impl::CRUISE_SPD;
    m.spd += std::clamp(targetSpd - m.spd, -Impl::ACCEL * dt, Impl::ACCEL * dt);
    if (m.spd < Impl::MIN_SPD) m.spd = Impl::MIN_SPD;
    m.px += std::sin(m.hdg) * m.spd * dt;
    m.pz += std::cos(m.hdg) * m.spd * dt;
    float diveMax = m.dipState == 1 ? Impl::DIP_DIVE_RATE : Impl::CLIMB_RATE;
    float targetVy = std::clamp((ty - m.py) * 0.8f + sepY * Impl::VSEP, -diveMax, Impl::CLIMB_RATE);
    m.vy += std::clamp(targetVy - m.vy, -Impl::VACCEL * dt, Impl::VACCEL * dt);
    m.py += m.vy * dt;
    float groundY = p->ground(m.px, m.pz);
    if (groundY > 0.5f) {
      float floorY = groundY + Impl::GROUND_CLEARANCE;
      if (m.py < floorY) { m.py = floorY; if (m.vy < 0) m.vy = 0; }
    }
    float targetBank = std::clamp(yawRate / Impl::TURN_RATE * Impl::MAX_BANK, -Impl::MAX_BANK, Impl::MAX_BANK);
    m.bank += (targetBank - m.bank) * std::min(1.0f, dt * Impl::BANK_EASE);
    float eTarget = std::clamp(0.5f + m.vy * 0.18f, 0.08f, 1.0f);
    m.flapE += (eTarget - m.flapE) * std::min(1.0f, dt * 2.5f);
    bool wantGlide = m.vy < -0.8f;
    if (wantGlide != m.gliding) {
      if ((m.glideTimer -= dt) <= 0) { m.gliding = wantGlide; m.glideTimer = 1.5f + p->frand() * 1.5f; }
    } else m.glideTimer = 1.5f + p->frand() * 1.5f;
  };
  auto updateDip = [&](Flock& f, BirdMember& m) {
    if (m.dipState == 0) {
      if (m.dipCooldown > 0) { m.dipCooldown -= dt; return; }
      float rate = f.following ? Impl::DIP_RATE_FOLLOW : Impl::DIP_RATE;
      if (m.py > Impl::FLARE_ALT + 3 && p->frand() < rate * dt) { m.dipState = 1; m.dipTimer = 6; }
      return;
    }
    m.dipTimer -= dt;
    if (m.dipState == 1) {
      if (m.py <= Impl::SEA_Y + Impl::DIP_SKIM_H + 0.5f || m.dipTimer <= 0) { m.dipState = 2; m.dipTimer = 0.3f + p->frand() * 0.5f; }
    } else if (m.dipState == 2) {
      if (m.dipTimer <= 0) { m.dipState = 3; m.dipTimer = 6; }
    } else if (m.py >= f.goalAlt - 4 || m.dipTimer <= 0) {
      m.dipState = 0; m.dipCooldown = 6 + p->frand() * 12;
    }
  };
  auto flyMembers = [&](Flock& f, bool landing) {
    for (BirdMember& m : f.members) {
      if (!m.airborne) continue;
      if (landing) m.dipState = 0; else updateDip(f, m);
      steerBird(f, m);
      bool onFinal = landing && m.py < Impl::FLARE_ALT;
      m.onFinal = onFinal;
      if (onFinal) {
        if (m.spd > Impl::LAND_SPD) m.spd = std::max(Impl::LAND_SPD, m.spd - Impl::ACCEL * 2 * dt);
        float f01 = std::clamp(1 - (m.py - Impl::SEA_Y) / (Impl::FLARE_ALT - Impl::SEA_Y), 0.0f, 1.0f);
        m.flare += (f01 - m.flare) * std::min(1.0f, dt * 4);
        if (m.py <= Impl::SEA_Y + 0.8f && m.vy <= 0.3f) {   // settleMember
          m.airborne = false; m.py = Impl::SEA_Y;
          m.ox = m.px - f.anchorX; m.oz = m.pz - f.anchorZ;
          m.yaw = std::atan2(std::cos(m.hdg), -std::sin(m.hdg));
          m.bank = 0; m.vy = 0; m.onFinal = false; m.flare = 0; m.dipState = 0;
          m.restWingsOut = false; m.restTimer = 2 + p->frand() * 6;
        }
      } else if (m.flare > 0.001f) m.flare += (0 - m.flare) * std::min(1.0f, dt * 3);
    }
  };

  for (Flock& f : p->flocks) {
    // Follow (B6).
    if (f.following) {
      f.followTimer -= dt;
      float dShip = shipUnderway ? std::hypot(ship.x - f.cx, ship.z - f.cz) : 1e9f;
      if (!shipUnderway || dShip > Impl::FOLLOW_DROP || f.followTimer <= 0) {
        f.following = false;
        f.followCooldown = 8 + p->frand() * 10;
        f.anchorX = f.gx; f.anchorZ = f.gz;
        f.wanderR = 16 + p->frand() * 26;
        if (f.state == FlockState::FLYING) f.dwell = std::min(f.dwell, f.stateTimer + 6 + p->frand() * 6);
      } else {
        f.anchorX = ship.x - std::sin(ship.headingRad) * Impl::FOLLOW_TRAIL;
        f.anchorZ = ship.z - std::cos(ship.headingRad) * Impl::FOLLOW_TRAIL;
        f.cruiseAlt = Impl::FOLLOW_ALT; f.wanderR = Impl::FOLLOW_WANDER;
      }
    } else {
      if (f.followCooldown > 0) f.followCooldown -= dt;
      if (f.state == FlockState::FLYING && f.followCooldown <= 0 && shipUnderway &&
          std::hypot(ship.x - f.cx, ship.z - f.cz) < Impl::FOLLOW_TRIGGER) {
        f.following = true;
        f.followTimer = 18 + p->frand() * 22;
        f.cruiseAlt = Impl::FOLLOW_ALT; f.wanderR = Impl::FOLLOW_WANDER;
      }
    }
    if (!welcome) {   // departFlock: fly off in worsening weather
      if (f.state == FlockState::RESTING) beginTakeoff(f);
      float ax = f.anchorX - camX, az = f.anchorZ - camZ;
      float d = std::hypot(ax, az); if (d < 1e-3f) d = 1;
      float departSpeed = 4 + storminess * 8;
      f.anchorX += ax / d * departSpeed * dt;
      f.anchorZ += az / d * departSpeed * dt;
      f.cruiseAlt = std::min(70.0f, f.cruiseAlt + dt * 4);
    }
    // State machine (advanceFlock).
    f.stateTimer += dt;
    float climb = f.cruiseAlt - Impl::SEA_Y;
    switch (f.state) {
      case FlockState::RESTING:
        f.cx += f.driftX * dt; f.cz += f.driftZ * dt;
        f.anchorX = f.cx; f.anchorZ = f.cz; f.cy = Impl::SEA_Y; f.goalAlt = Impl::SEA_Y;
        if (f.stateTimer >= f.dwell) beginTakeoff(f);
        break;
      case FlockState::TAKEOFF:
        f.goalAlt = std::min(f.cruiseAlt, f.goalAlt + climb / Impl::TAKEOFF_TIME * dt);
        updateGoal(f); flyMembers(f, false);
        if (f.goalAlt >= f.cruiseAlt - 0.5f) { f.state = FlockState::FLYING; f.stateTimer = 0; f.dwell = 14 + p->frand() * 18; }
        break;
      case FlockState::FLYING:
        f.goalAlt = f.cruiseAlt;
        updateGoal(f); flyMembers(f, false);
        if (f.stateTimer >= f.dwell && !f.following) { f.state = FlockState::LANDING; f.stateTimer = 0; f.wanderTimer = 1e9f; }
        break;
      case FlockState::LANDING: {
        f.wTx = f.anchorX; f.wTz = f.anchorZ;
        f.goalAlt = std::max(Impl::SEA_Y, f.goalAlt - climb / Impl::LAND_TIME * dt);
        updateGoal(f); flyMembers(f, true);
        bool anyAir = false;
        for (const BirdMember& m : f.members) if (m.airborne) { anyAir = true; break; }
        if (!anyAir) {
          f.state = FlockState::RESTING; f.stateTimer = 0; f.dwell = 9 + p->frand() * 14;
          f.cx = f.anchorX; f.cz = f.anchorZ; f.nearShipDist = -1;
        }
        break;
      }
    }
    // Ship-approach startle (resting rafts only; own ship).
    if (f.state == FlockState::RESTING) {
      float minD = std::hypot(ship.x - f.cx, ship.z - f.cz);
      if (f.nearShipDist < 0) f.nearShipDist = minD;
      else {
        bool closing = minD < f.nearShipDist - 0.3f;
        f.nearShipDist = minD;
        if (minD < Impl::IMMINENT_RADIUS || (closing && minD < Impl::STARTLE_RADIUS)) beginTakeoff(f);
      }
    }
    // Rest stretch poses.
    if (f.state == FlockState::RESTING)
      for (BirdMember& m : f.members) {
        m.restTimer -= dt;
        if (m.restTimer > 0) continue;
        if (m.restWingsOut) { m.restWingsOut = false; m.restTimer = 6 + p->frand() * 16; }
        else if (p->frand() < 0.5f) { m.restWingsOut = true; m.restTimer = 1.5f + p->frand() * 4; }
        else m.restTimer = 4 + p->frand() * 10;
      }
  }
}

static void updateDolphins(Impl* p, float dt, float t, const System::ShipInfo& ship) {
  float bx = ship.x, bz = ship.z;
  float depth = -p->ground(bx, bz);
  bool inShallows = depth >= Impl::D_DEPTH_MIN && depth <= Impl::D_DEPTH_MAX;
  if (inShallows && !p->dolActive) {   // spawn two pods
    p->pod.clear();
    float baseAng = p->frand() * TAU;
    for (int g = 0; g < Impl::D_PODS; ++g) {
      float gAng = baseAng + (float)g * TAU / Impl::D_PODS + (p->frand() - 0.5f) * 0.8f;
      float gDist = 16 + p->frand() * 22;
      float homeX = std::cos(gAng) * gDist, homeZ = std::sin(gAng) * gDist;
      int members = 5 + (int)(p->frand() * 4);
      const glm::vec3 tints[4] = { {1, 1, 1}, {0.82f, 0.86f, 0.94f}, {0.70f, 0.76f, 0.86f}, {0.92f, 0.95f, 1.0f} };
      for (int i = 0; i < members; ++i) {
        float ang = p->frand() * TAU, r = 4 + p->frand() * 16;
        Dolphin d{};
        d.x = bx + homeX + std::cos(ang) * r; d.z = bz + homeZ + std::sin(ang) * r;
        d.y = -(2 + p->frand() * 4);
        d.theta = p->frand() * TAU; d.targetTheta = p->frand() * TAU;
        d.speed = 2 + p->frand() * 2; d.targetSpeed = 2 + p->frand() * 2;
        d.baseY = -(1.5f + p->frand() * 5);
        d.depthPhase = p->frand() * TAU; d.depthRate = 0.1f + p->frand() * 0.25f;
        d.depthAmp = 0.8f + p->frand() * 2.0f;
        d.retarget = p->frand() * 2; d.effort = 0.4f;
        d.group = g; d.bowSlot = -1;
        d.scale = 0.9f + p->frand() * 0.4f;
        d.homeX = homeX; d.homeZ = homeZ;
        d.tint = tints[(int)(p->frand() * 4) & 3];
        p->pod.push_back(d);
      }
    }
    p->dolActive = true;
  } else if (!inShallows && p->dolActive) {
    p->pod.clear(); p->dolActive = false;
  }
  if (!p->dolActive) return;

  float boatSpeed = std::fabs(ship.speedMps);
  float fwdx = std::sin(ship.headingRad), fwdz = std::cos(ship.headingRad);
  float rgtx = fwdz, rgtz = -fwdx;
  float bowX = bx + fwdx * Impl::BOW_AHEAD, bowZ = bz + fwdz * Impl::BOW_AHEAD;
  bool wantRiders = boatSpeed > Impl::BOWRIDE_SPEED_MIN;
  bool taken[Impl::MAX_RIDERS] = {};
  for (Dolphin& d : p->pod) {
    if (d.bowSlot < 0) continue;
    bool tooFar = std::hypot(d.x - bx, d.z - bz) > Impl::BOWRIDE_RANGE * 1.7f;
    if (!wantRiders || tooFar) d.bowSlot = -1; else taken[d.bowSlot] = true;
  }
  if (wantRiders)
    for (Dolphin& d : p->pod) {
      if (d.bowSlot >= 0) continue;
      if (std::hypot(d.x - bowX, d.z - bowZ) > Impl::BOWRIDE_RANGE) continue;
      int slot = -1;
      for (int k = 0; k < Impl::MAX_RIDERS; ++k) if (!taken[k]) { slot = k; break; }
      if (slot < 0) break;
      taken[slot] = true; d.bowSlot = slot;
    }

  const int G = Impl::D_PODS;
  float gcx[2] = {}, gcz[2] = {}, ghx[2] = {}, ghz[2] = {};
  int gct[2] = {};
  int breachCount = 0;
  for (const Dolphin& d : p->pod) {
    gcx[d.group] += d.x; gcz[d.group] += d.z;
    ghx[d.group] += std::cos(d.theta); ghz[d.group] += std::sin(d.theta);
    gct[d.group]++;
    if (d.breaching) ++breachCount;
  }
  for (int g = 0; g < G; ++g) if (gct[g] > 0) { gcx[g] /= gct[g]; gcz[g] /= gct[g]; }

  for (Dolphin& d : p->pod) {
    int g = d.group;
    d.retarget -= dt;
    if (d.retarget <= 0) {
      d.retarget = 1.2f + p->frand() * 3.0f;
      d.targetTheta = d.theta + (p->frand() - 0.5f) * 1.6f;
      d.targetSpeed = 2.0f + p->frand() * 2.6f;
      if (p->frand() < 0.22f) d.targetSpeed = 5.5f + p->frand() * 2.5f;
      d.baseY = -(1.5f + p->frand() * 5);
    }
    float sx = std::cos(d.targetTheta) * Impl::D_W_WANDER;
    float sz = std::sin(d.targetTheta) * Impl::D_W_WANDER;
    float ccx = gcx[g] - d.x, ccz = gcz[g] - d.z;
    float cd = std::hypot(ccx, ccz); if (cd < 1e-6f) cd = 1;
    sx += ccx / cd * Impl::D_W_COH; sz += ccz / cd * Impl::D_W_COH;
    float ah = std::hypot(ghx[g], ghz[g]); if (ah < 1e-6f) ah = 1;
    sx += ghx[g] / ah * Impl::D_W_ALI; sz += ghz[g] / ah * Impl::D_W_ALI;
    for (const Dolphin& o : p->pod) {
      if (&o == &d || o.group != g) continue;
      float ox = d.x - o.x, oz = d.z - o.z, od2 = ox * ox + oz * oz;
      if (od2 > 1e-4f && od2 < Impl::D_SEP_R * Impl::D_SEP_R) {
        float inv = 1.0f / std::sqrt(od2);
        sx += ox * inv * inv * Impl::D_W_SEP * Impl::D_SEP_R;
        sz += oz * inv * inv * Impl::D_W_SEP * Impl::D_SEP_R;
      }
    }
    float dxB = (bx + d.homeX) - d.x, dzB = (bz + d.homeZ) - d.z;
    float distB = std::hypot(dxB, dzB);
    if (distB > Impl::D_LEASH) { sx += dxB / distB * 2.5f; sz += dzB / distB * 2.5f; }
    bool riding = false;
    if (d.bowSlot >= 0) {
      int rank = d.bowSlot / 2;
      float side = (d.bowSlot % 2 == 0) ? 1.0f : -1.0f;
      float tx = bowX + fwdx * (rank * Impl::BOW_SPACING) + rgtx * (side * Impl::BOW_SIDE);
      float tz = bowZ + fwdz * (rank * Impl::BOW_SPACING) + rgtz * (side * Impl::BOW_SIDE);
      sx = tx - d.x; sz = tz - d.z;
      d.targetSpeed = std::max(boatSpeed + 0.6f, 3.0f);
      d.baseY = Impl::BOWRIDE_DEPTH;
      riding = true;
    }
    const float la = 7;
    float aheadDepth = -p->ground(d.x + std::cos(d.theta) * la, d.z + std::sin(d.theta) * la);
    bool avoiding = aheadDepth < Impl::D_DEPTH_MIN;
    if (avoiding) { sx = dxB; sz = dzB; d.targetSpeed = std::min(d.targetSpeed, 2.5f); }

    float desired = std::atan2(sz, sx);
    float maxTurn = Impl::D_TURN * dt * (avoiding ? 2.2f : riding ? 2.0f : 1.0f);
    float turn = std::clamp(angDiff(desired, d.theta), -maxTurn, maxTurn);
    d.theta += turn;
    float bankTarget = std::clamp(-(turn / std::max(1e-4f, dt)) * Impl::D_BANK_K, -Impl::D_MAX_BANK, Impl::D_MAX_BANK);
    d.bank += (bankTarget - d.bank) * std::min(1.0f, dt * Impl::D_BANK_EASE);
    d.speed += (d.targetSpeed - d.speed) * std::min(1.0f, dt * 1.5f);
    d.x += std::cos(d.theta) * d.speed * dt;
    d.z += std::sin(d.theta) * d.speed * dt;

    float sb = p->ground(d.x, d.z);
    if (d.breaching) {
      d.breachVy -= Impl::BREACH_G * dt;
      d.y += d.breachVy * dt;
      if (d.y <= Impl::BREACH_REENTRY && d.breachVy < 0) d.breaching = false;
    } else {
      float yTarget = d.baseY + std::sin(t * d.depthRate + d.depthPhase) * d.depthAmp;
      float lo = sb + Impl::D_SEABED_CLEAR, hi = -Impl::D_SURFACE_CLEAR;
      yTarget = hi < lo ? (lo + hi) * 0.5f : std::clamp(yTarget, lo, hi);
      d.y += (yTarget - d.y) * std::min(1.0f, dt * 1.5f);
      if (!avoiding && d.bowSlot < 0 && d.speed > 2.2f && sb < -Impl::BREACH_MIN_DEPTH &&
          breachCount < Impl::MAX_BREACH && p->frand() < Impl::BREACH_CHANCE * dt) {
        d.breaching = true; d.breachVy = Impl::BREACH_VY0; d.targetSpeed = 6; ++breachCount;
      }
    }
    float effortTarget = std::clamp((d.speed - 1.2f) / 6.0f, 0.15f, 1.0f);
    d.effort += (effortTarget - d.effort) * std::min(1.0f, dt * 4);
  }
}

static void updateFish(Impl* p, float dt, float t, const System::ShipInfo& ship) {
  float bx = ship.x, bz = ship.z;
  float depth = -p->ground(bx, bz);
  bool inShallows = depth >= Impl::D_DEPTH_MIN && depth <= Impl::D_DEPTH_MAX;
  if (inShallows && !p->fishActive) {
    p->schools.clear();
    float baseAng = p->frand() * TAU;
    for (int s = 0; s < Impl::NSPECIES; ++s) {
      FishSchool sc{};
      sc.species = s;
      float gAng = baseAng + (float)s * TAU / Impl::NSPECIES + (p->frand() - 0.5f) * 0.7f;
      float gDist = 14 + p->frand() * 20;
      sc.homeX = std::cos(gAng) * gDist; sc.homeZ = std::sin(gAng) * gDist;
      int members = 14 + (int)(p->frand() * 12);
      sc.scl = 0.32f + p->frand() * 0.22f;
      sc.boilT = 3 + p->frand() * 5;
      for (int i = 0; i < members; ++i) {
        float ang = p->frand() * TAU, r = 1 + p->frand() * 4;
        FishM f{};
        f.x = bx + sc.homeX + std::cos(ang) * r; f.z = bz + sc.homeZ + std::sin(ang) * r;
        f.y = -(2 + p->frand() * 3);
        f.theta = p->frand() * TAU; f.targetTheta = p->frand() * TAU;
        f.speed = 1.2f + p->frand() * 1.2f; f.targetSpeed = f.speed;
        f.baseY = -(1.2f + p->frand() * 4);
        f.depthPhase = p->frand() * TAU; f.depthRate = 0.15f + p->frand() * 0.3f;
        f.depthAmp = 0.5f + p->frand() * 1.4f;
        f.retarget = p->frand() * 2; f.effort = 0.4f;
        sc.fish.push_back(f);
      }
      p->schools.push_back(std::move(sc));
    }
    p->fishActive = true;
  } else if (!inShallows && p->fishActive) {
    p->schools.clear(); p->fishActive = false;
  }
  if (!p->fishActive) return;

  // Dolphin pod centres = predators.
  float pcx[2] = {}, pcz[2] = {}; int pct[2] = {};
  for (const Dolphin& d : p->pod) { pcx[d.group] += d.x; pcz[d.group] += d.z; pct[d.group]++; }

  for (FishSchool& sc : p->schools) {
    float cx = 0, cz = 0, hx = 0, hz = 0;
    for (const FishM& f : sc.fish) { cx += f.x; cz += f.z; hx += std::cos(f.theta); hz += std::sin(f.theta); }
    int n = (int)sc.fish.size(); cx /= n; cz /= n;
    float thx = 0, thz = 0, thd = 1e9f;
    for (int g = 0; g < 2; ++g) {
      if (!pct[g]) continue;
      float px2 = pcx[g] / pct[g], pz2 = pcz[g] / pct[g];
      float d = std::hypot(cx - px2, cz - pz2);
      if (d < thd) { thd = d; thx = px2; thz = pz2; }
    }
    float alarm = thd < Impl::THREAT_R ? (1 - thd / Impl::THREAT_R) : 0;
    sc.boilT -= dt;
    if (sc.boilT <= 0) {
      sc.boiling = p->frand() < 0.18f;
      sc.boilT = sc.boiling ? 2 + p->frand() * 3 : 4 + p->frand() * 6;
    }
    bool boil = sc.boiling || alarm > 0.25f;
    for (int i = 0; i < n; ++i) {
      FishM& f = sc.fish[i];
      f.retarget -= dt;
      if (f.retarget <= 0) {
        f.retarget = 1.0f + p->frand() * 2.4f;
        f.targetTheta = f.theta + (p->frand() - 0.5f) * 1.4f;
        f.targetSpeed = 1.4f + p->frand() * 1.6f;
        if (p->frand() < 0.15f) f.targetSpeed = 3.2f + p->frand() * 1.8f;
        f.baseY = -(1.2f + p->frand() * 4);
      }
      float sx = std::cos(f.targetTheta) * Impl::F_W_WANDER;
      float sz = std::sin(f.targetTheta) * Impl::F_W_WANDER;
      float ccx = cx - f.x, ccz = cz - f.z;
      float cd = std::hypot(ccx, ccz); if (cd < 1e-6f) cd = 1;
      sx += ccx / cd * Impl::F_W_COH; sz += ccz / cd * Impl::F_W_COH;
      float ah = std::hypot(hx, hz); if (ah < 1e-6f) ah = 1;
      sx += hx / ah * Impl::F_W_ALI; sz += hz / ah * Impl::F_W_ALI;
      for (int j = 0; j < n; ++j) {
        if (j == i) continue;
        const FishM& o = sc.fish[j];
        float ox = f.x - o.x, oz = f.z - o.z, od2 = ox * ox + oz * oz;
        if (od2 > 1e-4f && od2 < Impl::F_SEP_R * Impl::F_SEP_R) {
          float inv = 1.0f / std::sqrt(od2);
          sx += ox * inv * inv * Impl::F_W_SEP * Impl::F_SEP_R;
          sz += oz * inv * inv * Impl::F_W_SEP * Impl::F_SEP_R;
        }
      }
      float dxB = (bx + sc.homeX) - f.x, dzB = (bz + sc.homeZ) - f.z;
      float distB = std::hypot(dxB, dzB);
      if (distB > Impl::F_LEASH) { sx += dxB / distB * 2.2f; sz += dzB / distB * 2.2f; }
      float hdx = f.x - bx, hdz = f.z - bz;
      float hd = std::hypot(hdx, hdz); if (hd < 1e-6f) hd = 1;
      if (hd < Impl::HULL_FLEE_R) {
        float w = (1 - hd / Impl::HULL_FLEE_R) * Impl::HULL_FLEE_W;
        sx += hdx / hd * w; sz += hdz / hd * w;
        f.targetSpeed = std::max(f.targetSpeed, Impl::BOLT_SPEED * 0.7f);
      }
      if (alarm > 0) {
        float tdx = f.x - thx, tdz = f.z - thz;
        float td = std::hypot(tdx, tdz); if (td < 1e-6f) td = 1;
        sx += tdx / td * Impl::THREAT_FLEE_W * alarm;
        sz += tdz / td * Impl::THREAT_FLEE_W * alarm;
        sx += ccx / cd * Impl::F_W_COH * alarm * 1.6f;
        sz += ccz / cd * Impl::F_W_COH * alarm * 1.6f;
        f.targetSpeed = std::max(f.targetSpeed, Impl::BOLT_SPEED);
      }
      const float la = 6;
      float aheadDepth = -p->ground(f.x + std::cos(f.theta) * la, f.z + std::sin(f.theta) * la);
      bool avoiding = aheadDepth < Impl::D_DEPTH_MIN;
      if (avoiding) { sx = dxB; sz = dzB; f.targetSpeed = std::min(f.targetSpeed, 1.6f); }
      float desired = std::atan2(sz, sx);
      float maxTurn = Impl::F_TURN * dt * (avoiding ? 2.0f : 1.0f);
      float turn = std::clamp(angDiff(desired, f.theta), -maxTurn, maxTurn);
      f.theta += turn;
      float bankTarget = std::clamp(-(turn / std::max(1e-4f, dt)) * Impl::F_BANK_K, -Impl::F_MAX_BANK, Impl::F_MAX_BANK);
      f.bank += (bankTarget - f.bank) * std::min(1.0f, dt * Impl::F_BANK_EASE);
      f.speed += (f.targetSpeed - f.speed) * std::min(1.0f, dt * 1.8f);
      f.x += std::cos(f.theta) * f.speed * dt;
      f.z += std::sin(f.theta) * f.speed * dt;
      float sb = p->ground(f.x, f.z);
      float depthBase = boil ? std::max(f.baseY, Impl::BOIL_DEPTH) : f.baseY;
      float yTarget = depthBase + std::sin(t * f.depthRate + f.depthPhase) * f.depthAmp * (boil ? 1.5f : 1.0f);
      float lo = sb + Impl::F_SEABED_CLEAR, hi = -Impl::F_SURFACE_CLEAR;
      yTarget = hi < lo ? (lo + hi) * 0.5f : std::clamp(yTarget, lo, hi);
      f.y += (yTarget - f.y) * std::min(1.0f, dt * 1.8f);
      float effortTarget = std::clamp((f.speed - 1.0f) / 3.5f, 0.2f, 1.0f);
      f.effort += (effortTarget - f.effort) * std::min(1.0f, dt * 5);
    }
  }
}

void System::update(WGPUDevice, WGPUQueue, float dtIn, double timeSec,
                    const ShipInfo& ship, float storminess) {
  Impl* p = p_.get();
  if (!p->ready || !p->terr) return;
  float dt = std::min(0.05f, dtIn);
  float t = (float)timeSec;

  // ── Static layers: stream patches (kernels), incremental + far-drop. ──
  int px = (int)std::floor(ship.x / Impl::PATCH), pz = (int)std::floor(ship.z / Impl::PATCH);
  if (px != p->lastPX || pz != p->lastPZ) {
    p->lastPX = px; p->lastPZ = pz;
    struct { Layer* l; Kernel k; } layers[] = {
      { &p->palms, palmKernel }, { &p->trees, treeKernel },
      { &p->rocks, rockKernel }, { &p->drift, driftKernel },
      { &p->grass, grassKernel },
    };
    for (auto& L : layers) {
      int ring = L.l->maxRing;
      for (int dz = -ring; dz <= ring; ++dz)
        for (int dx = -ring; dx <= ring; ++dx)
          placePatch(p, *L.l, px + dx, pz + dz, L.k);
      for (auto it = L.l->patches.begin(); it != L.l->patches.end();) {
        if (std::abs(it->first.first - px) > ring + 1 ||
            std::abs(it->first.second - pz) > ring + 1) {
          it = L.l->patches.erase(it); L.l->dirty = true;
        } else ++it;
      }
    }
  }

  // ── Shoreline reeds + underwater seaweed (reed/seaweed.service ports):
  //    stands/clumps re-evaluated ~3x/s, seeded in noise-gated bunches near the
  //    boat, recycled past the cull radius. Instances rebuilt only on change. ──
  p->bedAcc += dt;
  if (p->bedAcc >= 0.33f) {
    p->bedAcc = 0;
    auto noise1 = [](float x, float z) {
      float v = std::sin(x * 12.9898f + z * 78.233f) * 43758.5453f;
      return v - std::floor(v);
    };
    // Reeds: shoreline band (seabed elev in [-1.8, 0.3]).
    for (int i = (int)p->reedStands.size() - 1; i >= 0; --i)
      if (std::hypot(p->reedStands[(size_t)i].cx - ship.x, p->reedStands[(size_t)i].cz - ship.z) > Impl::REED_CULL) {
        p->reedStands.erase(p->reedStands.begin() + i); p->bedDirty = true;
      }
    for (int sd = 0; sd < 2 && (int)p->reedStands.size() < Impl::MAX_STANDS; ++sd) {
      for (int tr = 0; tr < 8; ++tr) {
        float ang = p->frand() * TAU;
        float r = Impl::REED_SPAWN_MIN + p->frand() * (Impl::REED_SPAWN_MAX - Impl::REED_SPAWN_MIN);
        float x = ship.x + std::cos(ang) * r, z = ship.z + std::sin(ang) * r;
        float elev = p->ground(x, z);
        if (elev < Impl::REED_ELEV_MIN || elev > Impl::REED_ELEV_MAX) continue;
        if (noise1(std::floor(x / 22.0f), std::floor(z / 22.0f)) < 0.5f) continue;
        bool near = false;
        for (const Impl::Stand& st : p->reedStands)
          if (std::hypot(st.cx - x, st.cz - z) < 6) { near = true; break; }
        if (near) continue;
        Impl::Stand st{ x, z, {} };
        int n = 6 + (int)(p->frand() * 9);
        float radius = 1.2f + p->frand() * 1.6f;
        const glm::vec3 tints[5] = { {0.85f, 1.0f, 0.72f}, {0.90f, 0.95f, 0.66f}, {0.95f, 0.92f, 0.55f},
                                     {1.0f, 0.92f, 0.60f}, {0.92f, 0.90f, 0.60f} };
        for (int k = 0; k < n; ++k) {
          float a = p->frand() * TAU, rr = std::sqrt(p->frand()) * radius;
          float wx = x + std::cos(a) * rr, wz = z + std::sin(a) * rr;
          st.items.push_back({ wx, wz, p->ground(wx, wz), p->frand() * TAU,
                               0.75f + p->frand() * 0.55f, (int)(p->frand() * 3) % 3,
                               tints[(int)(p->frand() * 5) % 5] });
        }
        p->reedStands.push_back(std::move(st));
        p->bedDirty = true;
        break;
      }
    }
    // Seaweed: shallows (water depth 2.5-18 m); cleared entirely off the shallows.
    float bDepth = -p->ground(ship.x, ship.z);
    bool overShallows = bDepth >= Impl::WEED_DEPTH_MIN - 1 && bDepth <= Impl::WEED_DEPTH_MAX + 4;
    if (!overShallows) {
      if (!p->weedClumps.empty()) { p->weedClumps.clear(); p->bedDirty = true; }
    } else {
      for (int i = (int)p->weedClumps.size() - 1; i >= 0; --i)
        if (std::hypot(p->weedClumps[(size_t)i].cx - ship.x, p->weedClumps[(size_t)i].cz - ship.z) > Impl::WEED_CULL) {
          p->weedClumps.erase(p->weedClumps.begin() + i); p->bedDirty = true;
        }
      for (int sd = 0; sd < 2 && (int)p->weedClumps.size() < Impl::MAX_CLUMPS; ++sd) {
        for (int tr = 0; tr < 6; ++tr) {
          float ang = p->frand() * TAU;
          float r = Impl::WEED_SPAWN_MIN + p->frand() * (Impl::WEED_SPAWN_MAX - Impl::WEED_SPAWN_MIN);
          float x = ship.x + std::cos(ang) * r, z = ship.z + std::sin(ang) * r;
          float seabed = p->ground(x, z);
          float depth = -seabed;
          if (depth < Impl::WEED_DEPTH_MIN || depth > Impl::WEED_DEPTH_MAX) continue;
          if (noise1(std::floor(x / 26.0f), std::floor(z / 26.0f)) < 0.55f) continue;
          bool near = false;
          for (const Impl::Stand& c : p->weedClumps)
            if (std::hypot(c.cx - x, c.cz - z) < 6) { near = true; break; }
          if (near) continue;
          Impl::Stand cl{ x, z, {} };
          int n = 8 + (int)(p->frand() * 11);
          float radius = 1.1f + p->frand() * 1.3f;
          const glm::vec3 tints[4] = { {0.62f, 0.74f, 0.42f}, {0.50f, 0.62f, 0.34f},
                                       {0.70f, 0.58f, 0.34f}, {0.44f, 0.58f, 0.44f} };
          for (int k = 0; k < n; ++k) {
            float a = p->frand() * TAU, rr = std::sqrt(p->frand()) * radius;
            float wx = x + std::cos(a) * rr, wz = z + std::sin(a) * rr;
            cl.items.push_back({ wx, wz, p->ground(wx, wz), p->frand() * TAU,
                                 0.6f + p->frand() * 0.7f, (int)(p->frand() * 3) % 3,
                                 tints[(int)(p->frand() * 4) & 3] });
          }
          p->weedClumps.push_back(std::move(cl));
          p->bedDirty = true;
          break;
        }
      }
    }
    if (p->bedDirty) {
      p->bedDirty = false;
      auto rebuildBeds = [&](Layer& l, const std::vector<Impl::Stand>& stands) {
        std::vector<std::vector<Inst>> per(l.full.size());
        for (const Impl::Stand& st : stands)
          for (const Impl::Sprout& w : st.items) {
            int v = w.variant % (int)per.size();
            if (!l.full[(size_t)v].vbuf) v = 0;
            per[(size_t)v].push_back(compose(w.rotY, 0, 0, w.scale, w.scale, w.scale,
                                             w.x, w.y, w.z, w.tint, 1.0f));
          }
        for (size_t v = 0; v < l.full.size(); ++v) {
          DrawSet& dset = l.full[v];
          if (!dset.instBuf) continue;
          dset.instCount = std::min((uint32_t)per[v].size(), dset.instCap);
          if (dset.instCount)
            wgpuQueueWriteBuffer(p->queue, dset.instBuf, 0, per[v].data(), (uint64_t)dset.instCount * sizeof(Inst));
        }
      };
      rebuildBeds(p->reedsL, p->reedStands);
      rebuildBeds(p->weedsL, p->weedClumps);
    }
  }

  // Far impostor layers built? Upload once (static thereafter).
  if (!p->farBuilt && p->farFuture.valid() &&
      p->farFuture.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
    auto [beech, palm] = p->farFuture.get();
    size_t total = 0;
    auto uploadFar = [&](Layer& l, std::vector<std::vector<Inst>>& per) {
      for (size_t v = 0; v < l.full.size() && v < per.size(); ++v) {
        DrawSet& dset = l.full[v];
        dset.instCount = std::min((uint32_t)per[v].size(), dset.instCap);
        total += dset.instCount;
        if (dset.instCount)
          wgpuQueueWriteBuffer(p->queue, dset.instBuf, 0, per[v].data(), (uint64_t)dset.instCount * sizeof(Inst));
      }
    };
    uploadFar(p->farTrees, beech);
    uploadFar(p->farPalms, palm);
    p->farBuilt = true;
    std::printf("[scatter] far impostors: %zu billboards\n", total);
  }

  // ── Wildlife (exact client behaviour). ──
  updateBirds(p, dt, ship.x, ship.z, ship, storminess);
  updateDolphins(p, dt, t, ship);
  updateFish(p, dt, t, ship);

  // Write animal instances.
  auto writeSets = [&](Layer& l, const std::vector<std::vector<Inst>>& per) {
    for (size_t v = 0; v < l.full.size(); ++v) {
      DrawSet& dset = l.full[v];
      if (!dset.instBuf) continue;
      dset.instCount = std::min((uint32_t)per[v].size(), dset.instCap);
      if (dset.instCount)
        wgpuQueueWriteBuffer(p->queue, dset.instBuf, 0, per[v].data(), (uint64_t)dset.instCount * sizeof(Inst));
    }
  };
  {
    std::vector<std::vector<Inst>> per(p->birdsL.full.size());
    for (const Flock& f : p->flocks)
      for (const BirdMember& m : f.members) {
        int v; float wx, wy, wz, energy = 1;
        Inst inst;
        if (m.airborne) {
          v = m.onFinal ? 3 : (m.gliding ? 1 : 0);
          energy = m.onFinal ? 0.5f : (m.gliding ? 0.12f : m.flapE);
          wx = m.px; wy = m.py; wz = m.pz;
          float vx = std::sin(m.hdg), vz = std::cos(m.hdg);
          float yaw = std::atan2(vz, -vx);
          float pitch = std::clamp(std::atan2(m.vy, std::max(m.spd, 1.0f)) * Impl::PITCH_GAIN
                                   + m.flare * Impl::FLARE_PITCH, -0.5f, 0.7f);
          inst = composeBird(yaw, pitch, m.bank, m.scale, wx, wy, wz, m.tint,
                             energy * Impl::kBirdAmp[v]);
        } else {
          v = m.restWingsOut ? m.flyVariant : 2;
          wx = f.cx + m.ox; wy = Impl::SEA_Y; wz = f.cz + m.oz;
          inst = composeBird(m.yaw, 0, 0, m.scale, wx, wy, wz, m.tint, Impl::kBirdAmp[v]);
        }
        if (v >= (int)per.size() || !p->birdsL.full[(size_t)v].vbuf) v = 0;
        if (per[(size_t)v].size() < 220) per[(size_t)v].push_back(inst);
      }
    writeSets(p->birdsL, per);
  }
  {
    std::vector<std::vector<Inst>> per(p->dolphinsL.full.size());
    for (const Dolphin& d : p->pod) {
      int mi = !d.breaching ? 0 : (d.breachVy > 0 ? 1 : 2);
      if (mi >= (int)per.size() || !p->dolphinsL.full[(size_t)mi].vbuf) mi = 0;
      float leapPitch = d.breaching ? std::atan2(d.breachVy, std::max(2.0f, d.speed)) : 0.0f;
      float yaw = -d.theta + Impl::D_FACE;
      per[(size_t)mi].push_back(compose(yaw, Impl::D_UPRIGHT + leapPitch, d.bank,
                                        d.scale, d.scale, d.scale, d.x, d.y, d.z, d.tint, d.effort));
    }
    writeSets(p->dolphinsL, per);
  }
  {
    std::vector<std::vector<Inst>> per(p->fishL.full.size());
    for (const FishSchool& sc : p->schools) {
      if (sc.species >= (int)per.size() || !p->fishL.full[(size_t)sc.species].vbuf) continue;
      for (const FishM& f : sc.fish)
        per[(size_t)sc.species].push_back(compose(-f.theta, 0, f.bank,
                                                  sc.scl, sc.scl, sc.scl, f.x, f.y, f.z,
                                                  glm::vec3(1.0f), f.effort));
    }
    writeSets(p->fishL, per);
  }
}

// ── Draw: frustum-culled patch flush + per-set draws ──────────────────────────
void System::draw(WGPURenderPassEncoder pass, WGPUQueue queue, const glm::mat4& viewProj,
                  const glm::vec3& eye, const glm::vec3& lightDir, float dayK,
                  double timeSec, float windAmp) {
  Impl* p = p_.get();
  if (!p->ready) return;

  // Re-flush the static instance buffers when the camera has moved (or patches
  // changed): each 40 m patch AABB is tested against the view frustum, so props
  // behind the camera cost nothing (client patch culling).
  bool anyDirty = p->palms.dirty || p->trees.dirty || p->rocks.dirty || p->drift.dirty;
  float moved = std::hypot(eye.x - p->flushX, eye.z - p->flushZ);
  static glm::mat4 lastVP(0.0f);
  bool camChanged = moved > 3.0f || viewProj != lastVP;
  if (anyDirty || camChanged) {
    lastVP = viewProj; p->flushX = eye.x; p->flushZ = eye.z;
    // Gribb-Hartmann frustum planes in world space.
    glm::vec4 rows[4];
    for (int r = 0; r < 4; ++r)
      rows[r] = glm::vec4(viewProj[0][r], viewProj[1][r], viewProj[2][r], viewProj[3][r]);
    glm::vec4 planes[5] = {
      rows[3] + rows[0], rows[3] - rows[0],   // left, right
      rows[3] + rows[1], rows[3] - rows[1],   // bottom, top
      rows[3] + rows[2],                       // near
    };
    auto patchVisible = [&](int pxi, int pzi) {
      float x0 = (float)pxi * Impl::PATCH, z0 = (float)pzi * Impl::PATCH;
      glm::vec3 c(x0 + Impl::PATCH * 0.5f, 20.0f, z0 + Impl::PATCH * 0.5f);
      glm::vec3 e2(Impl::PATCH * 0.5f, 35.0f, Impl::PATCH * 0.5f);   // generous Y for tall palms
      for (const glm::vec4& pl : planes) {
        float d = pl.x * c.x + pl.y * c.y + pl.z * c.z + pl.w;
        float r = std::fabs(pl.x) * e2.x + std::fabs(pl.y) * e2.y + std::fabs(pl.z) * e2.z;
        if (d + r < 0) return false;
      }
      return true;
    };
    Layer* statics[] = { &p->palms, &p->trees, &p->rocks, &p->drift, &p->grass };
    std::vector<Inst> blobBin;
    for (Layer* l : statics) {
      l->dirty = false;
      size_t nv = l->full.size();
      bool isGrass = l == &p->grass;
      float lodSplit = isGrass ? Impl::GRASS_NEAR : Impl::LOD_SPLIT;
      std::vector<std::vector<Inst>> fullBin(nv), lodBin(nv);
      for (const auto& [key, pd2] : l->patches) {
        if (!patchVisible(key.first, key.second)) continue;
        const auto& per = pd2.per;
        float cx = ((float)key.first + 0.5f) * Impl::PATCH;
        float cz = ((float)key.second + 0.5f) * Impl::PATCH;
        float pd = std::hypot(cx - eye.x, cz - eye.z);
        // Shadow blobs only near the camera (client shadowRing ~3 patches).
        if (!pd2.blobs.empty() && pd <= (Impl::SHADOW_RING + 0.5f) * Impl::PATCH)
          blobBin.insert(blobBin.end(), pd2.blobs.begin(), pd2.blobs.end());
        for (size_t v = 0; v < nv && v < per.size(); ++v) {
          if (l->impostor) {
            // Trees: dual-render the cross-dissolve ring (both bins; the shader
            // scale-collapses each on its own side of NEAR_FADE).
            if (pd < Impl::NEAR_FADE + Impl::NEAR_BAND + Impl::PATCH)
              fullBin[v].insert(fullBin[v].end(), per[v].begin(), per[v].end());
            if (!l->lod.empty() && pd > Impl::NEAR_FADE - Impl::NEAR_BAND - Impl::PATCH)
              lodBin[v].insert(lodBin[v].end(), per[v].begin(), per[v].end());
          } else {
            // Rocks/drift/grass: full mesh near, low-poly LOD beyond.
            bool nearP = pd <= lodSplit;
            auto& bin = (nearP || l->lod.empty() || !l->lod[v].vbuf) ? fullBin[v] : lodBin[v];
            bin.insert(bin.end(), per[v].begin(), per[v].end());
          }
        }
      }
      for (size_t v = 0; v < nv; ++v) {
        DrawSet& df = l->full[v];
        df.instCount = std::min((uint32_t)fullBin[v].size(), df.instCap);
        if (df.instCount)
          wgpuQueueWriteBuffer(queue, df.instBuf, 0, fullBin[v].data(), (uint64_t)df.instCount * sizeof(Inst));
        if (v < l->lod.size() && l->lod[v].vbuf) {
          DrawSet& dl = l->lod[v];
          dl.instCount = std::min((uint32_t)lodBin[v].size(), dl.instCap);
          if (dl.instCount)
            wgpuQueueWriteBuffer(queue, dl.instBuf, 0, lodBin[v].data(), (uint64_t)dl.instCount * sizeof(Inst));
        }
      }
    }
    p->blobSet.instCount = std::min((uint32_t)blobBin.size(), p->blobSet.instCap);
    if (p->blobSet.instCount)
      wgpuQueueWriteBuffer(queue, p->blobSet.instBuf, 0, blobBin.data(), (uint64_t)p->blobSet.instCount * sizeof(Inst));
  }

  struct LU { glm::mat4 vp; glm::vec4 eye, sun, anim, lod; };
  auto drawSets = [&](Layer& l, bool lodSets, const glm::vec4& lodU) {
    std::vector<DrawSet>& sets = lodSets ? l.lod : l.full;
    WGPUBuffer ubuf = lodSets ? l.ubufLod : l.ubufFull;
    uint32_t total = 0;
    for (const DrawSet& d : sets) total += d.instCount;
    if (!total || !ubuf) return;
    float mode = (lodSets && l.impostor) ? 0.0f : l.mode;   // impostor crosses don't sway
    float aCut = (lodSets && l.impostor) ? 0.4f : l.alphaCut;
    LU u{ viewProj, glm::vec4(eye, 1.0f), glm::vec4(lightDir, dayK),
          glm::vec4((float)timeSec, mode, windAmp, aCut), lodU };
    wgpuQueueWriteBuffer(queue, ubuf, 0, &u, sizeof(u));
    wgpuRenderPassEncoderSetPipeline(pass, p->pipeline);
    for (const DrawSet& d : sets) {
      if (!d.instCount || !d.vbuf) continue;
      wgpuRenderPassEncoderSetBindGroup(pass, 0, d.bind, 0, nullptr);
      wgpuRenderPassEncoderSetVertexBuffer(pass, 0, d.vbuf, 0, WGPU_WHOLE_SIZE);
      wgpuRenderPassEncoderSetVertexBuffer(pass, 1, d.instBuf, 0, WGPU_WHOLE_SIZE);
      wgpuRenderPassEncoderSetIndexBuffer(pass, d.ibuf, WGPUIndexFormat_Uint32, 0, WGPU_WHOLE_SIZE);
      wgpuRenderPassEncoderDrawIndexed(pass, d.indexCount, d.instCount, 0, 0, 0);
    }
  };

  const glm::vec4 noLod(0.0f);
  // Trees/palms: full mesh shrinks out at NEAR_FADE; impostor grows in there and
  // dithers out at the patch edge (client NearFade + LodDither).
  glm::vec4 fullFade(Impl::NEAR_FADE, Impl::NEAR_BAND, 1.0f, 0.0f);
  glm::vec4 impFade(Impl::NEAR_FADE, Impl::NEAR_BAND, 2.0f, Impl::TREE_CULL);
  // Grass: dithers out at the GrassFade edge ((ring+0.5)*40 = 180 m; band 60).
  glm::vec4 grassFade(0.0f, 0.0f, 0.0f, (Impl::GRASS_RING + 0.5f) * Impl::PATCH - 60.0f);
  drawSets(p->palms, false, fullFade);
  drawSets(p->palms, true, impFade);
  drawSets(p->trees, false, fullFade);
  drawSets(p->trees, true, impFade);
  drawSets(p->rocks, false, noLod);
  drawSets(p->rocks, true, noLod);
  drawSets(p->drift, false, noLod);
  drawSets(p->drift, true, noLod);
  drawSets(p->grass, false, grassFade);
  drawSets(p->grass, true, grassFade);
  // Far island impostors: grow in over the FarFadePlugin band (280 -> full 470 m)
  // as the near scatter ring hands off; distant coasts read as treed.
  glm::vec4 farFade(470.0f, 190.0f, 2.0f, 0.0f);
  drawSets(p->farTrees, false, farFade);
  drawSets(p->farPalms, false, farFade);
  drawSets(p->reedsL, false, noLod);
  drawSets(p->weedsL, false, noLod);
  drawSets(p->birdsL, false, noLod);
  drawSets(p->dolphinsL, false, noLod);
  drawSets(p->fishL, false, noLod);

  // Shadow blobs last (blended decal over the terrain, before the ocean draws):
  // stretched away from the sun, lengthening + fading as it lowers; gone at night.
  if (p->blobSet.instCount && p->blobPipeline) {
    // lightDir is the sun by day (dayK gates the moon out at night, matching the
    // client's sun-elevation fade). stretch = 1/max(sun.y, 0.30), clamped 1..3.5.
    float sunY = lightDir.y;
    float stretch = std::clamp(1.0f / std::max(sunY, 0.30f), 1.0f, 3.5f);
    float alpha = 0.62f * sstep(0.0f, 0.16f, sunY) * (1.0f - 0.06f * (stretch - 1.0f)) * dayK;
    glm::vec2 sd(-lightDir.x, -lightDir.z);
    float sl = glm::length(sd);
    sd = sl > 1e-4f ? sd / sl : glm::vec2(0, 1);
    LU u{ viewProj, glm::vec4(eye, 1.0f), glm::vec4(lightDir, dayK),
          glm::vec4((float)timeSec, 6.0f, 0.0f, alpha),
          glm::vec4(sd.x, sd.y, stretch, 0.0f) };
    wgpuQueueWriteBuffer(queue, p->blobUbuf, 0, &u, sizeof(u));
    wgpuRenderPassEncoderSetPipeline(pass, p->blobPipeline);
    wgpuRenderPassEncoderSetBindGroup(pass, 0, p->blobSet.bind, 0, nullptr);
    wgpuRenderPassEncoderSetVertexBuffer(pass, 0, p->blobSet.vbuf, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetVertexBuffer(pass, 1, p->blobSet.instBuf, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetIndexBuffer(pass, p->blobSet.ibuf, WGPUIndexFormat_Uint32, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderDrawIndexed(pass, p->blobSet.indexCount, p->blobSet.instCount, 0, 0, 0);
  }
}

} // namespace scatter
