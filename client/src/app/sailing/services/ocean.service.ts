import { Injectable, inject } from '@angular/core';
import {
  MeshBuilder, Vector2, Vector3, AbstractMesh, Mesh, ShaderMaterial, Scene,
  MirrorTexture, Plane, Texture, DynamicTexture, RenderTargetTexture, Color4,
} from '@babylonjs/core';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import { SceneService } from './scene.service';
import { SeaConditions, Wind } from '../models';

const OCEAN_VERT = `
precision highp float;

attribute vec3 position;
varying vec3  v_worldPos;
varying vec4  v_projPos;
varying float v_wakeMask;

uniform mat4 worldViewProjection;
uniform mat4 world;

uniform float u_Time;
uniform vec2  u_WorldOffset;
uniform float u_MeshHalfSize;
uniform float u_DisplaceScale;
uniform float u_edgeFade;        // 1 = fade displacement to 0 at mesh edge, 0 = full waves to edge
uniform float u_WaveDepth;
uniform float u_WaveFreq;
uniform vec2  u_BoatPos;
uniform vec2  u_BoatDir;
uniform float u_BoatSpeed;
uniform vec4  u_wakePath[24];   // recent ship track: xy = world pos, z = age (s)
uniform float u_wakeCount;      // number of valid points in u_wakePath
uniform vec4  u_splashData[8];  // cannonball water impacts: xy = world pos, z = age (s)
uniform float u_splashCount;    // number of active splashes

#define DRAG_MULT 0.38
#define ITERATIONS 24

vec2 wavedx(vec2 position, vec2 direction, float frequency, float timeshift) {
  float x = dot(direction, position) * frequency + timeshift;
  float wave = exp(sin(x) - 1.0);
  float dx = wave * cos(x);
  return vec2(wave, -dx);
}

float getwaves(vec2 position) {
  float wavePhaseShift = length(position) * 0.1;
  float iter = 0.0;
  float frequency = 1.0;
  float timeMultiplier = 2.0;
  float weight = 1.0;
  float sum = 0.0;
  float sumW = 0.0;

  for (int i = 0; i < ITERATIONS; i++) {
    vec2 p = vec2(sin(iter), cos(iter));
    vec2 res = wavedx(position, p, frequency, u_Time * timeMultiplier + wavePhaseShift);
    position += p * res.y * weight * DRAG_MULT;
    sum += res.x * weight;
    sumW += weight;
    weight = mix(weight, 0.0, 0.2);
    frequency *= 1.18;
    timeMultiplier *= 1.07;
    iter += 1232.399963;
  }
  return sum / max(sumW, 1e-5);
}

// Froth/turbulence intensity from the ship's recent track: 1 on a fresh part of
// the path, fading to 0 with lateral distance and with age. Curves with the
// actual route sailed; early-outs cheaply for fragments far from the boat.
float wakeTrail(vec2 p) {
  if (u_wakeCount < 2.0) return 0.0;
  if (length(p - u_BoatPos) > 170.0) return 0.0;
  float best = 1.0e9;
  float bestAge = 0.0;
  for (int i = 0; i < 23; i++) {
    if (float(i) >= u_wakeCount - 1.0) break;
    vec2 a = u_wakePath[i].xy;
    vec2 b = u_wakePath[i + 1].xy;
    vec2 ab = b - a;
    float L2 = max(dot(ab, ab), 1.0e-3);
    float t = clamp(dot(p - a, ab) / L2, 0.0, 1.0);
    float d = length(p - (a + ab * t));
    if (d < best) { best = d; bestAge = mix(u_wakePath[i].z, u_wakePath[i + 1].z, t); }
  }
  float lat = 1.0 - smoothstep(3.0, 15.0, best);
  float age = 1.0 - smoothstep(0.0, 7.0, bestAge);
  return lat * age;
}

float wakeDisplacement(vec2 worldPos) {
  float wake = wakeTrail(worldPos);
  if (wake < 0.001) return 0.0;
  // Frothy churn following the ship's track: a slight trench plus fast animated
  // chop, all scaled by the trail freshness (wake).
  float chop = (sin(worldPos.x * 0.65 + u_Time *  9.0)
              + sin(worldPos.y * 0.80 - u_Time * 11.0)
              + sin((worldPos.x - worldPos.y) * 0.50 + u_Time * 7.0)
              + sin((worldPos.x + worldPos.y) * 1.00 - u_Time * 8.0)) * 0.25;
  return (-0.22 + chop * 0.80) * pow(wake, 1.6);
}

// Cannonball water impacts: a brief geyser column + an expanding rebound ring that
// punch the surface where a ball strikes, fading over ~1.6 s. Each client simulates
// the ball, so u_splashData (updated CPU-side) is identical on every machine.
float splashDisplacement(vec2 worldPos) {
  if (u_splashCount < 0.5) return 0.0;
  float sum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= u_splashCount) break;
    vec2  c   = u_splashData[i].xy;
    float age = u_splashData[i].z;
    float life = 1.0 - age / 1.6;
    if (life <= 0.0) continue;
    float r = length(worldPos - c);
    // Impact ORDER: the surface is punched DOWN into a crater first (peaks ~0.07s),
    // THEN rebounds UP into a geyser column (peaks ~0.34s); a ring ripples outward.
    float qc = (age - 0.16) / 0.22;
    float qg = (age - 0.62) / 0.24;
    float crater = -exp(-(r * r) / 5.0)  * exp(-qc * qc) * 3.0;   // wider, deeper, longer-dwelling dip
    float geyser =  exp(-(r * r) / 2.56) * exp(-qg * qg) * 2.6;   // rebound UP (delayed)
    float ringR  = age * 6.0;
    float ring   =  exp(-((r - ringR) * (r - ringR)) / 2.56) * life * 0.5;
    sum += crater + geyser + ring;
  }
  return sum;
}

float wakeMask(vec2 worldPos) {
  vec2 rel = worldPos - u_BoatPos;
  float along = dot(rel, -u_BoatDir);
  if (along <= 0.0) return 0.0;

  vec2 right = vec2(-u_BoatDir.y, u_BoatDir.x);
  float lateral = dot(rel, right);
  float width = 12.0 + min(18.0, u_BoatSpeed * 1.10);
  float spread = exp(-(lateral * lateral) / (width * width));
  float trail = exp(-along * 0.0068);
  float build = 1.0 - exp(-along * 0.026);
  return clamp(spread * trail * build, 0.0, 1.0);
}

void main() {
  float wx = position.x + u_WorldOffset.x;
  float wz = position.z + u_WorldOffset.y;

  // Edge-fade: optionally blend displacement to zero near mesh boundary. Enabled
  // (u_edgeFade=1) only for the LOD that meets a FLAT outer LOD (LOD1→FAR); for
  // LODs whose neighbour continues the wave field (near→LOD0, LOD0→LOD1) it is
  // disabled (u_edgeFade=0) so full waves run to the edge and the inner LOD's
  // footprint is hard-cut out of the outer via u_innerCull — no interpenetration.
  float d        = max(abs(position.x), abs(position.z));
  float edgeF    = 1.0 - smoothstep(u_MeshHalfSize * 0.80, u_MeshHalfSize * 0.97, d);
  float fade     = u_DisplaceScale * mix(1.0, edgeF, u_edgeFade);

  vec3  pos = position;

  if (fade > 0.001) {
    vec2 wavePos = vec2(wx, wz) * u_WaveFreq;
    float h = (getwaves(wavePos) - 0.5) * u_WaveDepth;
    h += wakeDisplacement(vec2(wx, wz)) * 1.9;
    pos.y += h * fade;
  }

  pos.y += splashDisplacement(vec2(wx, wz));   // transient cannonball impacts (always on)
  v_wakeMask  = wakeMask(vec2(wx, wz));
  v_worldPos   = (world * vec4(pos, 1.0)).xyz;
  gl_Position  = worldViewProjection * vec4(pos, 1.0);
  v_projPos    = gl_Position;
}
`;

const OCEAN_FRAG = `
precision highp float;

uniform vec3  u_cameraPosition;
uniform float u_Time;
uniform float u_WaveDepth;
uniform float u_WaveFreq;
uniform vec2  u_BoatPos;
uniform vec2  u_BoatDir;
uniform float u_BoatSpeed;
uniform float u_innerCull;      // >0: discard frags within this chebyshev half-size of the boat (inner-LOD footprint)
uniform vec4  u_wakePath[24];   // recent ship track: xy = world pos, z = age (s)
uniform float u_wakeCount;      // number of valid points in u_wakePath
uniform vec4  u_splashData[8];  // cannonball water impacts: xy = world pos, z = age (s)
uniform float u_splashCount;    // number of active splashes
uniform sampler2D u_reflectionSampler;
uniform sampler2D u_terrainShadowMask;
uniform vec2  u_terrainShadowCenter;
uniform float u_terrainShadowSize;
uniform float u_terrainShadowStrength;
uniform sampler2D u_shoreMap;      // elevation map: R = clamp((elev+15)/20, 0,1)
uniform vec2  u_shoreMapCenter;    // world-space XZ of shore map centre
uniform float u_shoreMapSize;      // full world-space width covered (metres)
uniform float u_cloudCoverage;   // 0 = clear, 1 = fully overcast
uniform float u_sunElevation;    // sin(elevation): −1 night → +1 noon
uniform float u_rainIntensity;   // 0 = dry, 1 = full storm — drives surface rain ripples
uniform float u_reflectionStrength;  // 1 = RTT reflections on, 0 = analytic-sky only (Reflections setting)
uniform float u_seabedStrength;      // 1 = shallow-water transparency on, 0 = off (Water-transparency setting)
uniform int u_normalIter;            // per-LOD fragment normal detail (near hi, far lo)
uniform vec3  u_sunDir;          // unit vector toward the sun (boat shadow on water)
uniform mat4  view;              // auto-bound by Babylon — world→view (camera) space
uniform sampler2D u_sceneDepth;  // camera-space Z of opaque geom (ocean excluded), 1e8 = empty
uniform sampler2D u_refraction;  // seabed (terrain) colour for true shallow-water transparency

varying vec3 v_worldPos;
varying vec4 v_projPos;
varying float v_wakeMask;

#define DRAG_MULT 0.38
#define ITERATIONS u_normalIter   // FRAGMENT normal count, set PER-LOD via
                        // setInt('u_normalIter',…): near water hi (smooth reflections),
                        // far LODs lo (most of the screen, tiny reflections). Vertex
                        // geometry stays a fixed 24. (Loop below expands to u_normalIter.)

vec2 wavedx(vec2 position, vec2 direction, float frequency, float timeshift) {
  float x = dot(direction, position) * frequency + timeshift;
  float wave = exp(sin(x) - 1.0);
  float dx = wave * cos(x);
  return vec2(wave, -dx);
}

float getwaves(vec2 position) {
  float wavePhaseShift = length(position) * 0.1;
  float iter = 0.0;
  float frequency = 1.0;
  float timeMultiplier = 2.0;
  float weight = 1.0;
  float sum = 0.0;
  float sumW = 0.0;

  for (int i = 0; i < ITERATIONS; i++) {
    vec2 p = vec2(sin(iter), cos(iter));
    vec2 res = wavedx(position, p, frequency, u_Time * timeMultiplier + wavePhaseShift);
    position += p * res.y * weight * DRAG_MULT;
    sum += res.x * weight;
    sumW += weight;
    weight = mix(weight, 0.0, 0.2);
    frequency *= 1.18;
    timeMultiplier *= 1.07;
    iter += 1232.399963;
  }
  return sum / max(sumW, 1e-5);
}

// Froth/turbulence intensity from the ship's recent track: 1 on a fresh part of
// the path, fading to 0 with lateral distance and with age. Curves with the
// actual route sailed; early-outs cheaply for fragments far from the boat.
float wakeTrail(vec2 p) {
  if (u_wakeCount < 2.0) return 0.0;
  if (length(p - u_BoatPos) > 170.0) return 0.0;
  float best = 1.0e9;
  float bestAge = 0.0;
  for (int i = 0; i < 23; i++) {
    if (float(i) >= u_wakeCount - 1.0) break;
    vec2 a = u_wakePath[i].xy;
    vec2 b = u_wakePath[i + 1].xy;
    vec2 ab = b - a;
    float L2 = max(dot(ab, ab), 1.0e-3);
    float t = clamp(dot(p - a, ab) / L2, 0.0, 1.0);
    float d = length(p - (a + ab * t));
    if (d < best) { best = d; bestAge = mix(u_wakePath[i].z, u_wakePath[i + 1].z, t); }
  }
  float lat = 1.0 - smoothstep(3.0, 15.0, best);
  float age = 1.0 - smoothstep(0.0, 7.0, bestAge);
  return lat * age;
}

float wakeDisplacement(vec2 worldPos) {
  float wake = wakeTrail(worldPos);
  if (wake < 0.001) return 0.0;
  // Frothy churn following the ship's track (feeds the surface normals).
  float chop = (sin(worldPos.x * 0.65 + u_Time *  9.0)
              + sin(worldPos.y * 0.80 - u_Time * 11.0)
              + sin((worldPos.x - worldPos.y) * 0.50 + u_Time * 7.0)
              + sin((worldPos.x + worldPos.y) * 1.00 - u_Time * 8.0)) * 0.25;
  return (-0.22 + chop * 0.80) * pow(wake, 1.6);
}

// Cannonball water impacts: a brief geyser column + an expanding rebound ring that
// punch the surface where a ball strikes, fading over ~1.6 s. Each client simulates
// the ball, so u_splashData (updated CPU-side) is identical on every machine.
float splashDisplacement(vec2 worldPos) {
  if (u_splashCount < 0.5) return 0.0;
  float sum = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= u_splashCount) break;
    vec2  c   = u_splashData[i].xy;
    float age = u_splashData[i].z;
    float life = 1.0 - age / 1.6;
    if (life <= 0.0) continue;
    float r = length(worldPos - c);
    // Impact ORDER: the surface is punched DOWN into a crater first (peaks ~0.07s),
    // THEN rebounds UP into a geyser column (peaks ~0.34s); a ring ripples outward.
    float qc = (age - 0.16) / 0.22;
    float qg = (age - 0.62) / 0.24;
    float crater = -exp(-(r * r) / 5.0)  * exp(-qc * qc) * 3.0;   // wider, deeper, longer-dwelling dip
    float geyser =  exp(-(r * r) / 2.56) * exp(-qg * qg) * 2.6;   // rebound UP (delayed)
    float ringR  = age * 6.0;
    float ring   =  exp(-((r - ringR) * (r - ringR)) / 2.56) * life * 0.5;
    sum += crater + geyser + ring;
  }
  return sum;
}

float wakeMask(vec2 worldPos) {
  vec2 rel = worldPos - u_BoatPos;
  float along = dot(rel, -u_BoatDir);
  if (along <= 0.0) return 0.0;

  vec2 right = vec2(-u_BoatDir.y, u_BoatDir.x);
  float lateral = dot(rel, right);
  float width = 12.0 + min(18.0, u_BoatSpeed * 1.10);
  float spread = exp(-(lateral * lateral) / (width * width));
  float trail = exp(-along * 0.0068);
  float build = 1.0 - exp(-along * 0.026);
  return clamp(spread * trail * build, 0.0, 1.0);
}

float waveHeightWithWake(vec2 worldPos, float depth) {
  return (getwaves(worldPos * u_WaveFreq) - 0.5) * depth + wakeDisplacement(worldPos) * 1.9 + splashDisplacement(worldPos);
}

vec3 normal(vec2 worldPos, float e, float depth) {
  vec2 ex = vec2(e, 0.0);
  float H = waveHeightWithWake(worldPos, depth);
  vec3 a = vec3(worldPos.x, H, worldPos.y);
  return normalize(
    cross(
      a - vec3(worldPos.x - e, waveHeightWithWake(worldPos - ex, depth), worldPos.y),
      a - vec3(worldPos.x, waveHeightWithWake(worldPos + ex.yx, depth), worldPos.y + e)
    )
  );
}

vec3 getSunDirection() {
  return normalize(vec3(-0.07735, 0.5 + sin(u_Time * 0.2 + 2.6) * 0.45, 0.57735));
}

vec3 extra_cheap_atmosphere(vec3 raydir, vec3 sundir) {
  float special_trick = 1.0 / (raydir.y * 1.0 + 0.1);
  float special_trick2 = 1.0 / (sundir.y * 11.0 + 1.0);
  float raysundt = pow(abs(dot(sundir, raydir)), 2.0);
  vec3 suncolor = mix(vec3(1.0),
                      max(vec3(0.0), vec3(1.0) - vec3(5.5, 13.0, 22.4) / 22.4),
                      special_trick2);
  vec3 bluesky = vec3(5.5, 13.0, 22.4) / 22.4 * suncolor;
  vec3 bluesky2 = max(vec3(0.0),
                      bluesky - vec3(5.5, 13.0, 22.4) * 0.002 *
                      (special_trick - 6.0 * sundir.y * sundir.y));
  bluesky2 *= special_trick * (0.24 + raysundt * 0.24);
  return bluesky2 * (1.0 + pow(1.0 - raydir.y, 3.0));
}

vec3 getAtmosphere(vec3 dir) {
  return extra_cheap_atmosphere(dir, getSunDirection()) * 0.5;
}

float getSun(vec3 dir) {
  return pow(max(0.0, dot(dir, getSunDirection())), 720.0) * 210.0;
}

vec3 aces_tonemap(vec3 color) {
  mat3 m1 = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  mat3 m2 = mat3(
    1.60475, -0.10208, -0.00327,
    -0.53108, 1.10813, -0.07276,
    -0.07367, -0.00605, 1.07602
  );
  vec3 v = m1 * color;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return pow(clamp(m2 * (a / b), 0.0, 1.0), vec3(1.0 / 2.2));
}

float terrainShadowMask(vec2 worldXZ) {
  float halfSize = max(1.0, u_terrainShadowSize * 0.5);
  vec2 uv = (worldXZ - u_terrainShadowCenter) / (halfSize * 2.0) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture2D(u_terrainShadowMask, uv).r;
}

// Animated caustic web for the shallow seabed: domain-warped ridged sine field
// sharpened into thin bright filaments that drift and shimmer over time.
float causticPattern(vec2 uv, float t) {
  uv += vec2(sin(uv.y * 1.7 + t * 1.1), cos(uv.x * 1.5 - t * 0.9)) * 0.5;
  float a = (sin(uv.x * 2.0 + t) + sin(uv.y * 2.0 - t * 1.2)
           + sin((uv.x + uv.y) * 1.4 + t * 0.7)) / 3.0;
  return pow(clamp(1.0 - abs(a), 0.0, 1.0), 3.5);
}

// ── Fish: cheap drifting silhouettes for the clear shallows (viewed from above) ──
// Two schools at different scales/directions; ~1/4 of cells hold a fish, squashed into
// an elongated sliver with a tail wiggle. Only sampled on shallow pixels (see main).
float fishHash(vec2 id) { return fract(sin(dot(id, vec2(41.3, 289.1))) * 43758.5453); }
float fishField(vec2 p, float t) {
  // One independent fish per occupied ~12 m cell. Each wanders on its own Lissajous
  // path (unequal speeds → it turns and changes pace), and the body points along its
  // actual heading — so neighbours swim in all different directions, not in lockstep.
  float scale = 0.085;
  vec2  id  = floor(p * scale);
  float rnd = fishHash(id);
  if (rnd <= 0.76) return 0.0;                                  // ~24% of cells have a fish (a bit fewer)
  float szr = fishHash(id + 31.7);                             // independent random → full size range
  float ph  = rnd * 53.0;
  float sp1 = 0.30 + rnd * 0.55;                                // per-fish speeds (differ → curved path)
  float sp2 = 0.40 + fract(rnd * 7.3) * 0.60;
  vec2  cellC = (id + 0.5) / scale;
  vec2  fishC = cellC + vec2(sin(t * sp1 + ph), sin(t * sp2 + ph * 1.7)) * 4.5;  // wander within the cell
  vec2  vel   = vec2(sp1 * cos(t * sp1 + ph), sp2 * cos(t * sp2 + ph * 1.7));     // heading + speed
  vec2  fwd   = normalize(vel + vec2(1e-4, 0.0));
  vec2  rel   = p - fishC;
  vec2  local = vec2(dot(rel, fwd), dot(rel, vec2(-fwd.y, fwd.x)));               // into the fish's frame
  // Fish silhouette (top-down): a teardrop body + a flaring triangular tail fin, with
  // per-fish size variety. local.x = forward (+head), local.y = lateral.
  local /= (0.5 + szr * 0.7);                            // per-fish size — small ↔ big (max trimmed down)
  float fx = local.x;
  float fy = abs(local.y);
  float shape = 0.0;
  if (fx > -0.45 && fx < 0.85) {                         // body: widest mid, tapering to nose & tail
    float bs = (fx + 0.45) / 1.30;
    float w  = max(0.045, 0.34 * sin(bs * 3.14159));
    shape = max(shape, 1.0 - smoothstep(w * 0.45, w, fy));   // soft edge (slight blur)
  }
  if (fx > -1.15 && fx <= -0.35) {                       // caudal tail fin: flares toward the tip
    float ts = (-0.35 - fx) / 0.80;
    float tw = 0.05 + ts * 0.34;
    shape = max(shape, (1.0 - smoothstep(tw * 0.45, tw, fy)) * 0.88);
  }
  return shape * (0.70 + rnd * 0.30);                    // per-fish darkness
}

// ── Rain ripple noise ───────────────────────────────────────────────────────
// Cheap value noise + a fast two-octave drifting field used to dimple the water
// surface normals where rain is falling (simulates countless drop impacts).
float rVHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rVNoise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rVHash(i), rVHash(i + vec2(1.0, 0.0)), u.x),
             mix(rVHash(i + vec2(0.0, 1.0)), rVHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Raindrop impact field: each grid cell hosts a jittered impact with its own
// random phase and rate, fading in → peak → out, so individual drops blink into
// and out of existence in place rather than drifting as a static pattern.
float rainField(vec2 p, float t){
  vec2 cell = floor(p);
  vec2 f    = fract(p);
  float h1 = rVHash(cell);
  float h2 = rVHash(cell + 5.7);
  float h3 = rVHash(cell + 11.3);
  float h4 = rVHash(cell + 19.1);
  vec2  center = vec2(0.2 + h1 * 0.6, 0.2 + h2 * 0.6);     // jittered impact point
  float rate = mix(1.0, 3.2, h3);                          // impacts/sec (varied)
  float life = fract(t * rate + h1 * 7.0);                 // 0..1 life cycle
  float r    = length(f - center);
  float sz   = mix(0.16, 0.42, h4);                        // per-drop size: drizzle → fat splash

  // Sharp central plip the instant the drop lands.
  float impact = (1.0 - smoothstep(0.0, sz * 0.55, r)) * (1.0 - smoothstep(0.0, 0.22, life));
  // Ripple ring that expands outward and fades — the real drop-on-water signature.
  float ringR  = life * sz * 1.6;
  float ring   = 1.0 - smoothstep(0.0, sz * 0.34, abs(r - ringR));
  ring *= smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.5, 1.0, life));
  return impact + ring * 0.6;
}

void main() {
  // Inner-LOD cull: discard fragments that fall inside the boat-centred near patch
  // so this (outer) LOD never co-renders with the denser inner one — a clean hard
  // cut that replaces the old interpenetrating displacement fade.
  if (u_innerCull > 0.0 &&
      max(abs(v_worldPos.x - u_BoatPos.x), abs(v_worldPos.z - u_BoatPos.y)) < u_innerCull) {
    discard;
  }

  float depth = u_WaveDepth;
  vec2 worldXZ = v_worldPos.xz;

  vec3 ray = normalize(v_worldPos - u_cameraPosition);
  vec3 N = normal(worldXZ, 0.55, depth);

  N = mix(
    N,
    vec3(0.0, 1.0, 0.0),
    0.8 * min(1.0, sqrt(length(v_worldPos - u_cameraPosition) * 0.01) * 1.1)
  );

  // Rain ripples: dimple the normal with fast-evolving noise near the camera so
  // the surface looks peppered by raindrop impacts. Faded out with distance and
  // scaled by rain intensity.
  if (u_rainIntensity > 0.01) {
    float nearF = 1.0 - smoothstep(25.0, 180.0, length(v_worldPos - u_cameraPosition));
    if (nearF > 0.001) {
      float rt = u_Time;
      vec2  rp = worldXZ * 2.2;
      float e  = 0.18;
      float n0 = rainField(rp, rt);
      vec2  grad = vec2(rainField(rp + vec2(e, 0.0), rt) - n0,
                        rainField(rp + vec2(0.0, e), rt) - n0) / e;
      N = normalize(N + vec3(grad.x, 0.0, grad.y) * (0.18 * u_rainIntensity * nearF));
    }
  }

  float fresnel = 0.04 + (1.0 - 0.04) * pow(1.0 - max(0.0, dot(-N, ray)), 5.0);

  vec3 R = normalize(reflect(ray, N));
  R.y = abs(R.y);
  vec3 reflectionAnalytic = getAtmosphere(R) + getSun(R);
  vec2 screenUV = (v_projPos.xy / v_projPos.w) * 0.5 + 0.5;
  screenUV += N.xz * 0.020;
  screenUV = clamp(screenUV, 0.001, 0.999);
  vec3 reflectionRTT = texture2D(u_reflectionSampler, screenUV).rgb;
  vec3 reflection = mix(reflectionAnalytic, reflectionRTT, 0.80 * u_reflectionStrength);
  // (u_reflectionStrength = 0 → analytic sky only; the reflection RTT pass is also
  //  stopped on the CPU side so there's no off-screen geometry re-render.)

  // Cloud reflection: when the reflected ray points upward and sky is covered,
  // blend a cloud-grey into the sky portion of the mirror so the water surface
  // shows cloud shapes rather than pure clear-sky colour.
  if (R.y > 0.04 && u_cloudCoverage > 0.01) {
    float cloudMask = smoothstep(0.04, 0.50, R.y) * u_cloudCoverage;
    vec3  cloudDay  = vec3(0.82, 0.85, 0.90);   // bright overcast white
    vec3  cloudNight= vec3(0.16, 0.20, 0.30);   // dim moonlit grey
    vec3  cloudCol  = mix(cloudNight, cloudDay, clamp(u_sunElevation, 0.0, 1.0));
    reflection = mix(reflection, cloudCol, cloudMask * 0.62);
  }

  float rawTerrainMask = terrainShadowMask(worldXZ);
  float terrainShadow  = rawTerrainMask * clamp(u_terrainShadowStrength, 0.0, 1.0);
  reflection *= (1.0 - terrainShadow * 0.40);
  float wakeT = max(v_wakeMask, wakeMask(worldXZ));
  vec3 scattering = vec3(0.0293, 0.0698, 0.1717) * (0.20 - wakeT * 0.07);
  scattering *= (1.0 - terrainShadow * 0.75);
  vec3 color = fresnel * reflection + scattering;

  // Frothy wake: a thin, ~90%-transparent white wisp hugging the boat only — the
  // rest of the track is just turbulence. Narrow (only the freshest centerline
  // core) and gated to the area right around the hull.
  float wakeF = wakeTrail(worldXZ);
  if (wakeF > 0.001) {
    float core     = smoothstep(0.95, 0.998, wakeF);  // razor-thin: only the tightest core
    float nearBoat = 1.0 - smoothstep(18.0, 65.0, length(worldXZ - u_BoatPos));
    float grain    = rVNoise(worldXZ * 1.4 + vec2(u_Time * 0.6, -u_Time * 0.4));
    float froth    = core * nearBoat * (0.6 + 0.4 * grain);
    color = mix(color, vec3(0.92, 0.96, 1.0), froth * 0.03);
  }

  // ── Shore: shallow-water transparency + tint + animated foam ───────────────
  // u_shoreMap R channel = proximity to nearest land (0=open ocean, 1=waterline).
  // Three layers build up as the shore approaches:
  //   1. Turquoise water-column tint  — deep blue gives way to shallow turquoise
  //   2. Sandy seafloor               — very shallow water lets the bottom show
  //   3. Animated foam                — breaking waves right at the waterline
  vec2 shoreUV = (worldXZ - u_shoreMapCenter) / u_shoreMapSize + 0.5;
  if (shoreUV.x >= 0.001 && shoreUV.x <= 0.999 &&
      shoreUV.y >= 0.001 && shoreUV.y <= 0.999) {
    float proximity = texture2D(u_shoreMap, shoreUV).r;
    // 1. Subtle turquoise water column on the broad shallows.
    float shallowF = smoothstep(0.05, 0.65, proximity);
    color = mix(color, vec3(0.10, 0.48, 0.50), shallowF * 0.25);
    // 2. Seabed reveal — the see-through effect. Lerp the reflective surface
    // toward the wet seabed sand as the water shallows, strongly near the edge,
    // so the thin water at the waterline reads as clear (depth-fade illusion).
    float reveal = smoothstep(0.40, 0.92, proximity);
    color = mix(color, vec3(0.40, 0.34, 0.25), reveal * 0.88);
    // 3. Caustics over the shallows and the revealed sand.
    float causMask = smoothstep(0.12, 0.95, proximity);
    float caus = causticPattern(worldXZ * 0.18, u_Time * 0.9)
               + causticPattern(worldXZ * 0.33 + 7.3, u_Time * 1.3) * 0.6;
    color += vec3(0.80, 1.0, 0.92) * caus * causMask * 0.24;
    // 4. Thin, translucent breaking foam at the very waterline (not a wide wash,
    // which used to bury the seabed under opaque white).
    float foamF = smoothstep(0.90, 0.99, proximity);
    float foamAnim = clamp(
        0.44
      + 0.38 * sin(worldXZ.x * 0.55 + u_Time * 1.3 + worldXZ.y * 0.25)
      + 0.28 * cos(worldXZ.y * 0.48 - u_Time * 0.9 + worldXZ.x * 0.18),
      0.0, 1.0);
    color = mix(color, vec3(0.92, 0.97, 1.00), foamF * foamAnim * 0.50);
    // 5. Rain impacts on the shallow turquoise/surf — the seabed-reveal overwrites the
    //    surface colour here, so the normal-based ripples (added earlier) don't show;
    //    paint the drop dimples directly as little bright splashes when it's raining.
    // Gate strictly to the shallow/surf zone (where the seabed-reveal washed out the
    // normal-based ripples). Open water — even within the shore-map bounds — keeps only
    // the subtle normal ripples, so drops there aren't over-painted.
    float rainShoreMask = smoothstep(0.45, 0.75, proximity);
    if (u_rainIntensity > 0.01 && rainShoreMask > 0.001) {
      float rNear = 1.0 - smoothstep(25.0, 180.0, length(v_worldPos - u_cameraPosition));
      if (rNear > 0.001) {
        float drops = rainField(worldXZ * 2.2, u_Time);
        float dAmt = drops * (0.4 + 0.6 * u_rainIntensity) * rNear * rainShoreMask;
        color *= 1.0 - dAmt * 0.85;
        color += vec3(0.9, 0.95, 1.0) * dAmt * 0.5;
      }
    }
  }

  // ── Soft waterline ─────────────────────────────────────────────────────────
  // Hide the hard, aliased edge where the hull (and shore) meet the water.
  // Sample the opaque-scene camera-space depth (ocean excluded) at this pixel and
  // compare it to this water fragment's own camera-space depth. Where opaque
  // geometry sits just behind the water surface, feather a soft foam wash.
  vec2 sceneUV = clamp((v_projPos.xy / v_projPos.w) * 0.5 + 0.5, 0.0, 1.0);
  float sceneZ = texture2D(u_sceneDepth, sceneUV).r;     // 1e8 where nothing opaque
  float waterZ = (view * vec4(v_worldPos, 1.0)).z;       // same space as sceneZ
  float dz     = sceneZ - waterZ;                        // >0: opaque just behind surface

  // Depth-based shallow water: where the seabed (u_sceneDepth, ocean excluded)
  // is only just behind the surface, the water is a thin sheet — show the REAL
  // terrain through it (true refraction): sample the seabed colour from the
  // refraction RTT at this pixel, with a slight wave-driven wobble, and blend
  // toward it by shallowness. dz ≈ 1e8 in open ocean → reveal 0.
  float seabedReveal = 1.0 - smoothstep(0.0, 22.0, dz);
  // Gate by distance to land (shore-map R = land proximity, 1 at shore → 0 far):
  // only reveal the seabed near islands, never over shallow open water.
  vec2 revShoreUV = (worldXZ - u_shoreMapCenter) / u_shoreMapSize + 0.5;
  float landProx = (revShoreUV.x >= 0.0 && revShoreUV.x <= 1.0 &&
                    revShoreUV.y >= 0.0 && revShoreUV.y <= 1.0)
                 ? texture2D(u_shoreMap, revShoreUV).r : 0.0;
  seabedReveal *= smoothstep(0.18, 0.55, landProx);
  seabedReveal *= u_seabedStrength;   // 0 → shallow-water transparency off (refraction+depth RTTs also stopped)
  if (seabedReveal > 0.001) {
    vec2 refrUV = clamp(sceneUV + N.xz * 0.015 * seabedReveal, 0.001, 0.999);
    // Cool the submerged sand — water absorbs warm light, so the bottom seen
    // through water reads cooler/greener than dry sand (kills the "yellow water").
    vec3 seabed = texture2D(u_refraction, refrUV).rgb * vec3(0.40, 0.49, 0.56);
    // Fish: dark drifting silhouettes on the seabed — only when the camera is above the
    // surface (avoids artifacts when the view dips underwater).
    float fish = (u_cameraPosition.y > 0.05) ? fishField(worldXZ, u_Time) : 0.0;
    seabed *= (1.0 - fish * 0.50);   // a touch fainter
    // Tint toward water teal with depth so the deeper shallows read as water,
    // not bare sand. Narrower reveal (8 m) keeps it to genuinely shallow water.
    float depthTint = smoothstep(0.0, 22.0, dz);
    vec3 shallowWater = mix(seabed, vec3(0.07, 0.30, 0.38), depthTint * 0.65);
    color = mix(color, shallowWater, seabedReveal * 0.90);
  }

  // Boat shadow on the water surface: an oriented ellipse projected from the hull
  // toward the anti-sun direction. Gated by (1 - seabedReveal) so it doesn't
  // double with the real seabed shadow seen through the shallow refraction, and
  // only when the sun is above the horizon.
  if (u_sunDir.y > 0.02) {
    float sunUp = max(0.25, u_sunDir.y);
    vec2 shOffset = -u_sunDir.xz / sunUp * 2.0;
    vec2 rel = worldXZ - (u_BoatPos + shOffset);
    vec2 fwd = normalize(u_BoatDir);
    vec2 rgt = vec2(fwd.y, -fwd.x);
    float along  = dot(rel, fwd);
    float across = dot(rel, rgt);
    float e = (along * along) / (9.0 * 9.0) + (across * across) / (3.6 * 3.6);
    float boatShadow = (1.0 - smoothstep(0.5, 1.0, e)) * (1.0 - seabedReveal);
    color *= 1.0 - boatShadow * 0.32;
  }

  // Soft waterline foam for the hull edge — but suppressed where the seabed shows
  // through (that's clear shore water, not a hull edge), so it stops whitening the
  // clear shallows.
  float waterline = smoothstep(0.0, 0.20, dz) * (1.0 - smoothstep(0.5, 1.6, dz))
                  * (1.0 - seabedReveal * 0.92);
  color = mix(color, vec3(0.90, 0.95, 1.00), waterline * 0.70);

  // ── Cloud shadows ───────────────────────────────────────────────────────────
  // Soft moving dappled shadows cast by the volumetric clouds onto the water. We
  // sample a low-frequency drifting "cloud cover" field (same character as the
  // volumetric weather map) at the point where the sun ray through this water
  // fragment would pierce cloud height, so the shadows sit downsun of the clouds
  // and drift with the wind. Gated by coverage + sun elevation.
  if (u_sunDir.y > 0.03 && u_cloudCoverage > 0.02) {
    // Project from the water point up to cloud altitude along the sun direction.
    // Scale 0.004 → noise cells ~250 m, so several distinct shadow patches fall within
    // view (0.00018 was ~5500 m/cell → one flat tone over the whole screen).
    vec2  cloudUV = (worldXZ + u_sunDir.xz / max(u_sunDir.y, 0.2) * 900.0) * 0.004;
    vec2  drift   = vec2(u_Time * 0.18, u_Time * 0.12);
    float cf = rVNoise(cloudUV + drift) * 0.6
             + rVNoise(cloudUV * 2.3 - drift * 1.7) * 0.4;
    // Map the field through coverage: more cloud cover → lower threshold → more shadow.
    // Tight smoothstep band → crisp shadow edges (not a vague wash).
    float shadow = smoothstep(0.60 - u_cloudCoverage * 0.45, 0.70 - u_cloudCoverage * 0.30, cf);
    shadow *= u_cloudCoverage * smoothstep(0.03, 0.18, u_sunDir.y);
    color *= 1.0 - shadow * 0.78;
  }

  // ── Night dimming ───────────────────────────────────────────────────────────
  // The reflection, scattering and shallow-water tints are all day-calibrated, so
  // without this the water (especially turquoise shallows) stays unnaturally
  // bright after dark. Fade the whole surface toward a dim moonlit floor as the
  // sun drops below the horizon (u_sunElevation = sun dir .y, <0 at night).
  float dayLight = mix(0.12, 1.0, smoothstep(-0.12, 0.22, u_sunElevation));
  color *= dayLight;

  vec4 outCol = vec4(aces_tonemap(color * 2.0), 1.0);
  gl_FragColor = outCol;
}
`;

const OCEAN_VERT_WGSL = `
attribute position: vec3f;
varying v_worldPos: vec3f;
varying v_projPos: vec4f;
varying v_wakeMask: f32;

uniform worldViewProjection: mat4x4f;
uniform world: mat4x4f;

uniform u_Time: f32;
uniform u_WorldOffset: vec2f;
uniform u_MeshHalfSize: f32;
uniform u_DisplaceScale: f32;
uniform u_edgeFade: f32;        // 1 = fade displacement to 0 at mesh edge; 0 = full waves to edge
uniform u_WaveDepth: f32;
uniform u_WaveFreq: f32;
uniform u_BoatPos: vec2f;
uniform u_BoatDir: vec2f;
uniform u_BoatSpeed: f32;
uniform u_wakePath: array<vec4f, 24>;   // recent ship track: xy = world pos, z = age (s)
uniform u_wakeCount: f32;               // number of valid points in u_wakePath
uniform u_splashData: array<vec4f, 8>;  // cannonball water impacts: xy = world pos, z = age (s)
uniform u_splashCount: f32;             // number of active splashes

const DRAG_MULT: f32 = 0.38;
const ITERATIONS: i32 = 24;

fn wavedx(position: vec2f, direction: vec2f, frequency: f32, timeshift: f32) -> vec2f {
  let x = dot(direction, position) * frequency + timeshift;
  let wave = exp(sin(x) - 1.0);
  let dx = wave * cos(x);
  return vec2f(wave, -dx);
}

fn getwaves(positionIn: vec2f) -> f32 {
  var position = positionIn;
  let wavePhaseShift = length(position) * 0.1;
  var iter = 0.0;
  var frequency = 1.0;
  var timeMultiplier = 2.0;
  var weight = 1.0;
  var sum = 0.0;
  var sumW = 0.0;

  for (var i: i32 = 0; i < ITERATIONS; i = i + 1) {
    let p = vec2f(sin(iter), cos(iter));
    let res = wavedx(position, p, frequency, uniforms.u_Time * timeMultiplier + wavePhaseShift);
    position += p * res.y * weight * DRAG_MULT;
    sum += res.x * weight;
    sumW += weight;
    weight = mix(weight, 0.0, 0.2);
    frequency *= 1.18;
    timeMultiplier *= 1.07;
    iter += 1232.399963;
  }
  return sum / max(sumW, 1e-5);
}

// Froth/turbulence intensity from the ship's recent track (see GLSL path).
fn wakeTrail(p: vec2f) -> f32 {
  if (uniforms.u_wakeCount < 2.0) { return 0.0; }
  if (length(p - uniforms.u_BoatPos) > 170.0) { return 0.0; }
  var best = 1.0e9;
  var bestAge = 0.0;
  for (var i = 0; i < 23; i = i + 1) {
    if (f32(i) >= uniforms.u_wakeCount - 1.0) { break; }
    let a = uniforms.u_wakePath[i].xy;
    let b = uniforms.u_wakePath[i + 1].xy;
    let ab = b - a;
    let L2 = max(dot(ab, ab), 1.0e-3);
    let t = clamp(dot(p - a, ab) / L2, 0.0, 1.0);
    let d = length(p - (a + ab * t));
    if (d < best) { best = d; bestAge = mix(uniforms.u_wakePath[i].z, uniforms.u_wakePath[i + 1].z, t); }
  }
  let lat = 1.0 - smoothstep(3.0, 15.0, best);
  let age = 1.0 - smoothstep(0.0, 7.0, bestAge);
  return lat * age;
}

fn wakeDisplacement(worldPos: vec2f) -> f32 {
  let wake = wakeTrail(worldPos);
  if (wake < 0.001) { return 0.0; }
  // Frothy churn following the ship's track, scaled by trail freshness (wake).
  let chop = (sin(worldPos.x * 0.65 + uniforms.u_Time *  9.0)
            + sin(worldPos.y * 0.80 - uniforms.u_Time * 11.0)
            + sin((worldPos.x - worldPos.y) * 0.50 + uniforms.u_Time * 7.0)
            + sin((worldPos.x + worldPos.y) * 1.00 - uniforms.u_Time * 8.0)) * 0.25;
  return (-0.22 + chop * 0.80) * pow(wake, 1.6);
}

// Cannonball water impacts (same as GLSL): geyser column + expanding rebound ring.
fn splashDisplacement(worldPos: vec2f) -> f32 {
  if (uniforms.u_splashCount < 0.5) { return 0.0; }
  var sum = 0.0;
  for (var i: i32 = 0; i < 8; i = i + 1) {
    if (f32(i) >= uniforms.u_splashCount) { break; }
    let c   = uniforms.u_splashData[i].xy;
    let age = uniforms.u_splashData[i].z;
    let life = 1.0 - age / 1.6;
    if (life <= 0.0) { continue; }
    let r = length(worldPos - c);
    // Crater DOWN first (~0.07s), then rebound geyser UP (~0.34s); ring ripples out.
    let qc = (age - 0.16) / 0.22;
    let qg = (age - 0.62) / 0.24;
    let crater = -exp(-(r * r) / 5.0)  * exp(-qc * qc) * 3.0;
    let geyser =  exp(-(r * r) / 2.56) * exp(-qg * qg) * 2.6;
    let ringR  = age * 6.0;
    let ring   =  exp(-((r - ringR) * (r - ringR)) / 2.56) * life * 0.5;
    sum = sum + crater + geyser + ring;
  }
  return sum;
}

fn wakeMask(worldPos: vec2f) -> f32 {
  let rel = worldPos - uniforms.u_BoatPos;
  let along = dot(rel, -uniforms.u_BoatDir);
  if (along <= 0.0) {
    return 0.0;
  }

  let right = vec2f(-uniforms.u_BoatDir.y, uniforms.u_BoatDir.x);
  let lateral = dot(rel, right);
  let width = 12.0 + min(18.0, uniforms.u_BoatSpeed * 1.10);
  let spread = exp(-(lateral * lateral) / (width * width));
  let trail = exp(-along * 0.0068);
  let build = 1.0 - exp(-along * 0.026);
  return clamp(spread * trail * build, 0.0, 1.0);
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let wx = input.position.x + uniforms.u_WorldOffset.x;
  let wz = input.position.z + uniforms.u_WorldOffset.y;

  let d     = max(abs(input.position.x), abs(input.position.z));
  let edgeF = 1.0 - smoothstep(uniforms.u_MeshHalfSize * 0.80, uniforms.u_MeshHalfSize * 0.97, d);
  let fade  = uniforms.u_DisplaceScale * mix(1.0, edgeF, uniforms.u_edgeFade);

  var pos = input.position;

  if (fade > 0.001) {
    let wavePos = vec2f(wx, wz) * uniforms.u_WaveFreq;
    var h = (getwaves(wavePos) - 0.5) * uniforms.u_WaveDepth;
    h += wakeDisplacement(vec2f(wx, wz)) * 1.9;
    pos.y += h * fade;
  }

  pos.y = pos.y + splashDisplacement(vec2f(wx, wz));   // transient cannonball impacts
  vertexOutputs.v_wakeMask = wakeMask(vec2f(wx, wz));
  vertexOutputs.v_worldPos = (uniforms.world * vec4f(pos, 1.0)).xyz;
  vertexOutputs.position = uniforms.worldViewProjection * vec4f(pos, 1.0);
  vertexOutputs.v_projPos = vertexOutputs.position;
}
`;

const OCEAN_FRAG_WGSL = `
uniform u_cameraPosition: vec3f;
uniform u_Time: f32;
uniform u_WaveDepth: f32;
uniform u_WaveFreq: f32;
uniform u_BoatPos: vec2f;
uniform u_BoatDir: vec2f;
uniform u_BoatSpeed: f32;
uniform u_innerCull: f32;               // >0: discard frags within this chebyshev half-size of the boat
uniform u_wakePath: array<vec4f, 24>;   // recent ship track: xy = world pos, z = age (s)
uniform u_wakeCount: f32;               // number of valid points in u_wakePath
uniform u_splashData: array<vec4f, 8>;  // cannonball water impacts: xy = world pos, z = age (s)
uniform u_splashCount: f32;             // number of active splashes
var u_reflectionSamplerSampler: sampler;
var u_reflectionSampler: texture_2d<f32>;
var u_terrainShadowMaskSampler: sampler;
var u_terrainShadowMask: texture_2d<f32>;
uniform u_terrainShadowCenter: vec2f;
uniform u_terrainShadowSize: f32;
uniform u_terrainShadowStrength: f32;
var u_shoreMapSampler: sampler;
var u_shoreMap: texture_2d<f32>;
uniform u_shoreMapCenter: vec2f;
uniform u_shoreMapSize: f32;
uniform u_cloudCoverage: f32;
uniform u_sunElevation: f32;
uniform u_rainIntensity: f32;      // 0 = dry, 1 = full storm — drives surface rain ripples
uniform u_reflectionStrength: f32; // 1 = RTT reflections on, 0 = analytic-sky only
uniform u_seabedStrength: f32;     // 1 = shallow-water transparency on, 0 = off
uniform u_normalIter: i32;         // per-LOD fragment normal detail (near hi, far lo)
uniform u_sunDir: vec3f;           // unit vector toward the sun (boat shadow on water)
uniform view: mat4x4f;             // auto-bound by Babylon — world→view (camera) space
var u_sceneDepthSampler: sampler;
var u_sceneDepth: texture_2d<f32>; // camera-space Z of opaque geom (ocean excluded), 1e8 = empty
var u_refractionSampler: sampler;
var u_refraction: texture_2d<f32>; // seabed (terrain) colour for true shallow-water transparency

varying v_worldPos: vec3f;
varying v_projPos: vec4f;
varying v_wakeMask: f32;

const DRAG_MULT: f32 = 0.38;
// FRAGMENT normal iteration count is the per-LOD uniform u_normalIter (see GLSL note).

fn wavedx(position: vec2f, direction: vec2f, frequency: f32, timeshift: f32) -> vec2f {
  let x = dot(direction, position) * frequency + timeshift;
  let wave = exp(sin(x) - 1.0);
  let dx = wave * cos(x);
  return vec2f(wave, -dx);
}

fn getwaves(positionIn: vec2f) -> f32 {
  var position = positionIn;
  let wavePhaseShift = length(position) * 0.1;
  var iter = 0.0;
  var frequency = 1.0;
  var timeMultiplier = 2.0;
  var weight = 1.0;
  var sum = 0.0;
  var sumW = 0.0;

  for (var i: i32 = 0; i < uniforms.u_normalIter; i = i + 1) {
    let p = vec2f(sin(iter), cos(iter));
    let res = wavedx(position, p, frequency, uniforms.u_Time * timeMultiplier + wavePhaseShift);
    position += p * res.y * weight * DRAG_MULT;
    sum += res.x * weight;
    sumW += weight;
    weight = mix(weight, 0.0, 0.2);
    frequency *= 1.18;
    timeMultiplier *= 1.07;
    iter += 1232.399963;
  }
  return sum / max(sumW, 1e-5);
}

// Froth/turbulence intensity from the ship's recent track (see GLSL path).
fn wakeTrail(p: vec2f) -> f32 {
  if (uniforms.u_wakeCount < 2.0) { return 0.0; }
  if (length(p - uniforms.u_BoatPos) > 170.0) { return 0.0; }
  var best = 1.0e9;
  var bestAge = 0.0;
  for (var i = 0; i < 23; i = i + 1) {
    if (f32(i) >= uniforms.u_wakeCount - 1.0) { break; }
    let a = uniforms.u_wakePath[i].xy;
    let b = uniforms.u_wakePath[i + 1].xy;
    let ab = b - a;
    let L2 = max(dot(ab, ab), 1.0e-3);
    let t = clamp(dot(p - a, ab) / L2, 0.0, 1.0);
    let d = length(p - (a + ab * t));
    if (d < best) { best = d; bestAge = mix(uniforms.u_wakePath[i].z, uniforms.u_wakePath[i + 1].z, t); }
  }
  let lat = 1.0 - smoothstep(3.0, 15.0, best);
  let age = 1.0 - smoothstep(0.0, 7.0, bestAge);
  return lat * age;
}

fn wakeDisplacement(worldPos: vec2f) -> f32 {
  let wake = wakeTrail(worldPos);
  if (wake < 0.001) { return 0.0; }
  // Frothy churn following the ship's track (feeds the surface normals).
  let chop = (sin(worldPos.x * 0.65 + uniforms.u_Time *  9.0)
            + sin(worldPos.y * 0.80 - uniforms.u_Time * 11.0)
            + sin((worldPos.x - worldPos.y) * 0.50 + uniforms.u_Time * 7.0)
            + sin((worldPos.x + worldPos.y) * 1.00 - uniforms.u_Time * 8.0)) * 0.25;
  return (-0.22 + chop * 0.80) * pow(wake, 1.6);
}

// Cannonball water impacts (same as GLSL): geyser column + expanding rebound ring.
fn splashDisplacement(worldPos: vec2f) -> f32 {
  if (uniforms.u_splashCount < 0.5) { return 0.0; }
  var sum = 0.0;
  for (var i: i32 = 0; i < 8; i = i + 1) {
    if (f32(i) >= uniforms.u_splashCount) { break; }
    let c   = uniforms.u_splashData[i].xy;
    let age = uniforms.u_splashData[i].z;
    let life = 1.0 - age / 1.6;
    if (life <= 0.0) { continue; }
    let r = length(worldPos - c);
    // Crater DOWN first (~0.07s), then rebound geyser UP (~0.34s); ring ripples out.
    let qc = (age - 0.16) / 0.22;
    let qg = (age - 0.62) / 0.24;
    let crater = -exp(-(r * r) / 5.0)  * exp(-qc * qc) * 3.0;
    let geyser =  exp(-(r * r) / 2.56) * exp(-qg * qg) * 2.6;
    let ringR  = age * 6.0;
    let ring   =  exp(-((r - ringR) * (r - ringR)) / 2.56) * life * 0.5;
    sum = sum + crater + geyser + ring;
  }
  return sum;
}

fn wakeMask(worldPos: vec2f) -> f32 {
  let rel = worldPos - uniforms.u_BoatPos;
  let along = dot(rel, -uniforms.u_BoatDir);
  if (along <= 0.0) {
    return 0.0;
  }

  let right = vec2f(-uniforms.u_BoatDir.y, uniforms.u_BoatDir.x);
  let lateral = dot(rel, right);
  let width = 12.0 + min(18.0, uniforms.u_BoatSpeed * 1.10);
  let spread = exp(-(lateral * lateral) / (width * width));
  let trail = exp(-along * 0.0068);
  let build = 1.0 - exp(-along * 0.026);
  return clamp(spread * trail * build, 0.0, 1.0);
}

fn waveHeightWithWake(worldPos: vec2f, depth: f32) -> f32 {
  return (getwaves(worldPos * uniforms.u_WaveFreq) - 0.5) * depth + wakeDisplacement(worldPos) * 1.9 + splashDisplacement(worldPos);
}

fn normal(worldPos: vec2f, e: f32, depth: f32) -> vec3f {
  let ex = vec2f(e, 0.0);
  let H = waveHeightWithWake(worldPos, depth);
  let a = vec3f(worldPos.x, H, worldPos.y);
  return normalize(
    cross(
      a - vec3f(worldPos.x - e, waveHeightWithWake(worldPos - ex, depth), worldPos.y),
      a - vec3f(worldPos.x, waveHeightWithWake(worldPos + ex.yx, depth), worldPos.y + e)
    )
  );
}

fn getSunDirection() -> vec3f {
  return normalize(vec3f(-0.07735, 0.5 + sin(uniforms.u_Time * 0.2 + 2.6) * 0.45, 0.57735));
}

fn extra_cheap_atmosphere(raydir: vec3f, sundir: vec3f) -> vec3f {
  let special_trick = 1.0 / (raydir.y * 1.0 + 0.1);
  let special_trick2 = 1.0 / (sundir.y * 11.0 + 1.0);
  let raysundt = pow(abs(dot(sundir, raydir)), 2.0);
  let suncolor = mix(vec3f(1.0),
                     max(vec3f(0.0), vec3f(1.0) - vec3f(5.5, 13.0, 22.4) / 22.4),
                     vec3f(special_trick2));
  let bluesky = vec3f(5.5, 13.0, 22.4) / 22.4 * suncolor;
  var bluesky2 = max(vec3f(0.0),
                     bluesky - vec3f(5.5, 13.0, 22.4) * 0.002 *
                     (special_trick - 6.0 * sundir.y * sundir.y));
  bluesky2 *= special_trick * (0.24 + raysundt * 0.24);
  return bluesky2 * (1.0 + pow(1.0 - raydir.y, 3.0));
}

fn getAtmosphere(dir: vec3f) -> vec3f {
  return extra_cheap_atmosphere(dir, getSunDirection()) * 0.5;
}

fn getSun(dir: vec3f) -> f32 {
  return pow(max(0.0, dot(dir, getSunDirection())), 720.0) * 210.0;
}

fn aces_tonemap(color: vec3f) -> vec3f {
  let m1 = mat3x3f(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  let m2 = mat3x3f(
    1.60475, -0.10208, -0.00327,
    -0.53108, 1.10813, -0.07276,
    -0.07367, -0.00605, 1.07602
  );
  let v = m1 * color;
  let a = v * (v + vec3f(0.0245786)) - vec3f(0.000090537);
  let b = v * (0.983729 * v + vec3f(0.4329510)) + vec3f(0.238081);
  return pow(clamp(m2 * (a / b), vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
}

fn terrainShadowMask(worldXZ: vec2f) -> f32 {
  let halfSize = max(1.0, uniforms.u_terrainShadowSize * 0.5);
  let uv = (worldXZ - uniforms.u_terrainShadowCenter) / (halfSize * 2.0) + vec2f(0.5);
  let inBounds = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  // textureSampleLevel (explicit LOD) is valid in non-uniform control flow.
  let s = textureSampleLevel(u_terrainShadowMask, u_terrainShadowMaskSampler,
                             clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0).r;
  return select(0.0, s, inBounds);
}

// Animated caustic web for the shallow seabed (same as GLSL path).
fn causticPattern(uvIn: vec2f, t: f32) -> f32 {
  let uv = uvIn + vec2f(sin(uvIn.y * 1.7 + t * 1.1), cos(uvIn.x * 1.5 - t * 0.9)) * 0.5;
  let a = (sin(uv.x * 2.0 + t) + sin(uv.y * 2.0 - t * 1.2)
         + sin((uv.x + uv.y) * 1.4 + t * 0.7)) / 3.0;
  return pow(clamp(1.0 - abs(a), 0.0, 1.0), 3.5);
}

// ── Fish: cheap drifting silhouettes for the clear shallows (viewed from above) ──
fn fishHash(id: vec2f) -> f32 { return fract(sin(dot(id, vec2f(41.3, 289.1))) * 43758.5453); }
fn fishField(p: vec2f, t: f32) -> f32 {
  // One independent fish per occupied ~12 m cell — own heading/speed, wandering on a
  // Lissajous path (so it turns & changes pace), body oriented to its travel direction.
  let scale = 0.085;
  let id  = floor(p * scale);
  let rnd = fishHash(id);
  if (rnd <= 0.76) { return 0.0; }
  let szr = fishHash(id + 31.7);
  let ph  = rnd * 53.0;
  let sp1 = 0.30 + rnd * 0.55;
  let sp2 = 0.40 + fract(rnd * 7.3) * 0.60;
  let cellC = (id + vec2f(0.5)) / scale;
  let fishC = cellC + vec2f(sin(t * sp1 + ph), sin(t * sp2 + ph * 1.7)) * 4.5;
  let vel   = vec2f(sp1 * cos(t * sp1 + ph), sp2 * cos(t * sp2 + ph * 1.7));
  let fwd   = normalize(vel + vec2f(1e-4, 0.0));
  let rel   = p - fishC;
  let local = vec2f(dot(rel, fwd), dot(rel, vec2f(-fwd.y, fwd.x))) / (0.5 + szr * 0.7);
  // Fish silhouette: teardrop body + flaring tail fin (local.x forward, local.y lateral).
  let fx = local.x;
  let fy = abs(local.y);
  var shape = 0.0;
  if (fx > -0.45 && fx < 0.85) {
    let bs = (fx + 0.45) / 1.30;
    let w  = max(0.045, 0.34 * sin(bs * 3.14159));
    shape = max(shape, 1.0 - smoothstep(w * 0.45, w, fy));
  }
  if (fx > -1.15 && fx <= -0.35) {
    let ts = (-0.35 - fx) / 0.80;
    let tw = 0.05 + ts * 0.34;
    shape = max(shape, (1.0 - smoothstep(tw * 0.45, tw, fy)) * 0.88);
  }
  return shape * (0.70 + rnd * 0.30);
}

// ── Rain ripple noise (same as GLSL path) ───────────────────────────────────
fn rVHash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn rVNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rVHash(i), rVHash(i + vec2f(1.0, 0.0)), u.x),
             mix(rVHash(i + vec2f(0.0, 1.0)), rVHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
// Raindrop impact field: per-cell jittered impacts that fade in → peak → out at
// random phases, so drops blink into and out of existence in place.
fn rainField(p: vec2f, t: f32) -> f32 {
  let cell = floor(p);
  let f    = fract(p);
  let h1 = rVHash(cell);
  let h2 = rVHash(cell + 5.7);
  let h3 = rVHash(cell + 11.3);
  let h4 = rVHash(cell + 19.1);
  let center = vec2f(0.2 + h1 * 0.6, 0.2 + h2 * 0.6);
  let rate = mix(1.0, 3.2, h3);
  let life = fract(t * rate + h1 * 7.0);
  let r    = length(f - center);
  let sz   = mix(0.16, 0.42, h4);
  let impact = (1.0 - smoothstep(0.0, sz * 0.55, r)) * (1.0 - smoothstep(0.0, 0.22, life));
  let ringR  = life * sz * 1.6;
  var ring   = 1.0 - smoothstep(0.0, sz * 0.34, abs(r - ringR));
  ring = ring * smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.5, 1.0, life));
  return impact + ring * 0.6;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  // Inner-LOD cull: discard fragments inside the boat-centred near patch so this
  // (outer) LOD never co-renders with the denser inner one — clean hard cut.
  if (uniforms.u_innerCull > 0.0 &&
      max(abs(input.v_worldPos.x - uniforms.u_BoatPos.x),
          abs(input.v_worldPos.z - uniforms.u_BoatPos.y)) < uniforms.u_innerCull) {
    discard;
  }

  let depth = uniforms.u_WaveDepth;
  let worldXZ = input.v_worldPos.xz;

  let ray = normalize(input.v_worldPos - uniforms.u_cameraPosition);
  var N = normal(worldXZ, 0.55, depth);

  N = mix(
    N,
    vec3f(0.0, 1.0, 0.0),
    vec3f(0.8 * min(1.0, sqrt(length(input.v_worldPos - uniforms.u_cameraPosition) * 0.01) * 1.1))
  );

  // Rain ripples (same logic as GLSL path): dimple the normal near the camera.
  if (uniforms.u_rainIntensity > 0.01) {
    let nearF = 1.0 - smoothstep(25.0, 180.0, length(input.v_worldPos - uniforms.u_cameraPosition));
    if (nearF > 0.001) {
      let rt = uniforms.u_Time;
      let rp = worldXZ * 2.2;
      let e  = 0.18;
      let n0 = rainField(rp, rt);
      let grad = vec2f(rainField(rp + vec2f(e, 0.0), rt) - n0,
                       rainField(rp + vec2f(0.0, e), rt) - n0) / e;
      N = normalize(N + vec3f(grad.x, 0.0, grad.y) * (0.18 * uniforms.u_rainIntensity * nearF));
    }
  }

  let fresnel = 0.04 + (1.0 - 0.04) * pow(1.0 - max(0.0, dot(-N, ray)), 5.0);

  var R = normalize(reflect(ray, N));
  R.y = abs(R.y);
  let reflectionAnalytic = getAtmosphere(R) + vec3f(getSun(R));
  var screenUV = (input.v_projPos.xy / input.v_projPos.w) * 0.5 + vec2f(0.5);
  screenUV += N.xz * 0.020;
  screenUV = clamp(screenUV, vec2f(0.001), vec2f(0.999));
  let reflectionRTT = textureSample(u_reflectionSampler, u_reflectionSamplerSampler, screenUV).rgb;
  let reflStrength = uniforms.u_reflectionStrength;
  // Cloud reflection (same logic as GLSL path above)
  var cloudReflection = mix(reflectionAnalytic, reflectionRTT, vec3f(0.80 * reflStrength));
  if (R.y > 0.04 && uniforms.u_cloudCoverage > 0.01) {
    let cloudMask  = smoothstep(0.04, 0.50, R.y) * uniforms.u_cloudCoverage;
    let cloudDay   = vec3f(0.82, 0.85, 0.90);
    let cloudNight = vec3f(0.16, 0.20, 0.30);
    let cloudCol   = mix(cloudNight, cloudDay, clamp(uniforms.u_sunElevation, 0.0, 1.0));
    cloudReflection = mix(cloudReflection, cloudCol, vec3f(cloudMask * 0.62));
  }
  let rawTerrainMask = terrainShadowMask(worldXZ);
  let terrainShadow = rawTerrainMask * clamp(uniforms.u_terrainShadowStrength, 0.0, 1.0);
  let reflection = cloudReflection * (1.0 - terrainShadow * 0.40);
  let wakeT = max(input.v_wakeMask, wakeMask(worldXZ));
  let scattering = vec3f(0.0293, 0.0698, 0.1717) * (0.20 - wakeT * 0.07) * (1.0 - terrainShadow * 0.75);
  var color = fresnel * reflection + scattering;

  // Frothy wake (same as GLSL path): thin, ~90%-transparent wisp near the boat.
  let wakeF = wakeTrail(worldXZ);
  if (wakeF > 0.001) {
    let core     = smoothstep(0.95, 0.998, wakeF);
    let nearBoat = 1.0 - smoothstep(18.0, 65.0, length(worldXZ - uniforms.u_BoatPos));
    let grain    = rVNoise(worldXZ * 1.4 + vec2f(uniforms.u_Time * 0.6, -uniforms.u_Time * 0.4));
    let froth    = core * nearBoat * (0.6 + 0.4 * grain);
    color = mix(color, vec3f(0.92, 0.96, 1.0), vec3f(froth * 0.03));
  }

  // ── Shore: shallow-water transparency + tint + animated foam ───────────────
  // u_shoreMap R channel = proximity to nearest land (0=open ocean, 1=waterline).
  // Three layers build up as the shore approaches:
  //   1. Turquoise water-column tint  — deep blue gives way to shallow turquoise
  //   2. Sandy seafloor               — very shallow water lets the bottom show
  //   3. Animated foam                — breaking waves right at the waterline
  let shoreUV = (worldXZ - uniforms.u_shoreMapCenter) / uniforms.u_shoreMapSize + vec2f(0.5);
  let shoreInBounds = shoreUV.x >= 0.001 && shoreUV.x <= 0.999 &&
                      shoreUV.y >= 0.001 && shoreUV.y <= 0.999;
  if (shoreInBounds) {
    // textureSampleLevel (explicit LOD) is valid in non-uniform control flow.
    let proximity = textureSampleLevel(u_shoreMap, u_shoreMapSampler,
                                       clamp(shoreUV, vec2f(0.001), vec2f(0.999)), 0.0).r;
    // 1. Subtle turquoise water column on the broad shallows.
    let shallowF = smoothstep(0.05, 0.65, proximity);
    color = mix(color, vec3f(0.10, 0.48, 0.50), vec3f(shallowF * 0.25));
    // 2. Seabed reveal — the see-through effect (depth-fade toward wet sand).
    let reveal = smoothstep(0.40, 0.92, proximity);
    color = mix(color, vec3f(0.40, 0.34, 0.25), vec3f(reveal * 0.88));
    // 3. Caustics over the shallows AND the revealed sand.
    let causMask = smoothstep(0.12, 0.95, proximity);
    let caus = causticPattern(worldXZ * 0.18, uniforms.u_Time * 0.9)
             + causticPattern(worldXZ * 0.33 + vec2f(7.3), uniforms.u_Time * 1.3) * 0.6;
    color += vec3f(0.80, 1.0, 0.92) * (caus * causMask * 0.24);
    // 4. Thin, translucent breaking foam at the very waterline only.
    let foamF = smoothstep(0.90, 0.99, proximity);
    let foamAnim = clamp(
        0.44
      + 0.38 * sin(worldXZ.x * 0.55 + uniforms.u_Time * 1.3 + worldXZ.y * 0.25)
      + 0.28 * cos(worldXZ.y * 0.48 - uniforms.u_Time * 0.9 + worldXZ.x * 0.18),
      0.0, 1.0);
    color = mix(color, vec3f(0.92, 0.97, 1.00), vec3f(foamF * foamAnim * 0.50));
    // 5. Rain impacts on the shallow turquoise/surf (seabed-reveal overwrites the
    //    normal-based ripples here, so paint the drop splashes directly).
    let rainShoreMask = smoothstep(0.45, 0.75, proximity);
    if (uniforms.u_rainIntensity > 0.01 && rainShoreMask > 0.001) {
      let rNear = 1.0 - smoothstep(25.0, 180.0, length(input.v_worldPos - uniforms.u_cameraPosition));
      if (rNear > 0.001) {
        let drops = rainField(worldXZ * 2.2, uniforms.u_Time);
        let dAmt = drops * (0.4 + 0.6 * uniforms.u_rainIntensity) * rNear * rainShoreMask;
        color *= 1.0 - dAmt * 0.85;
        color += vec3f(0.9, 0.95, 1.0) * (dAmt * 0.5);
      }
    }
  }

  // ── Soft waterline ─────────────────────────────────────────────────────────
  // (same logic as the GLSL path) feather a soft foam wash where opaque geometry
  // sits just behind the water surface, hiding the hard aliased waterline edge.
  let sceneUV = clamp((input.v_projPos.xy / input.v_projPos.w) * 0.5 + vec2f(0.5), vec2f(0.0), vec2f(1.0));
  let sceneZ  = textureSampleLevel(u_sceneDepth, u_sceneDepthSampler, sceneUV, 0.0).r;
  let waterZ  = (uniforms.view * vec4f(input.v_worldPos, 1.0)).z;
  let dz      = sceneZ - waterZ;

  // Depth-based shallow water (same as GLSL path): show the REAL terrain through
  // thin water by sampling the seabed refraction RTT, blended by shallowness.
  var seabedReveal = 1.0 - smoothstep(0.0, 22.0, dz);
  // Gate by distance to land (shore-map proximity) — only reveal near islands.
  let revShoreUV = (worldXZ - uniforms.u_shoreMapCenter) / uniforms.u_shoreMapSize + vec2f(0.5);
  let revInB = revShoreUV.x >= 0.0 && revShoreUV.x <= 1.0 && revShoreUV.y >= 0.0 && revShoreUV.y <= 1.0;
  let landProx = select(0.0, textureSampleLevel(u_shoreMap, u_shoreMapSampler, clamp(revShoreUV, vec2f(0.001), vec2f(0.999)), 0.0).r, revInB);
  seabedReveal *= smoothstep(0.18, 0.55, landProx);
  seabedReveal *= uniforms.u_seabedStrength;   // 0 → shallow-water transparency off
  if (seabedReveal > 0.001) {
    let refrUV = clamp(sceneUV + N.xz * 0.015 * seabedReveal, vec2f(0.001), vec2f(0.999));
    // Cool the submerged sand (water absorbs warm light) → kills "yellow water".
    var seabed = textureSampleLevel(u_refraction, u_refractionSampler, refrUV, 0.0).rgb * vec3f(0.40, 0.49, 0.56);
    // Fish: dark drifting silhouettes — only with the camera above the surface.
    var fish = 0.0;
    if (uniforms.u_cameraPosition.y > 0.05) { fish = fishField(worldXZ, uniforms.u_Time); }
    seabed = seabed * (1.0 - fish * 0.50);   // a touch fainter
    let depthTint = smoothstep(0.0, 22.0, dz);
    let shallowWater = mix(seabed, vec3f(0.07, 0.30, 0.38), vec3f(depthTint * 0.65));
    color = mix(color, shallowWater, vec3f(seabedReveal * 0.90));
  }

  // Boat shadow on the water surface (same as GLSL path): oriented ellipse cast
  // from the hull toward anti-sun, gated to deeper water and to daytime.
  if (uniforms.u_sunDir.y > 0.02) {
    let sunUp = max(0.25, uniforms.u_sunDir.y);
    let shOffset = -uniforms.u_sunDir.xz / sunUp * 2.0;
    let rel = worldXZ - (uniforms.u_BoatPos + shOffset);
    let fwd = normalize(uniforms.u_BoatDir);
    let rgt = vec2f(fwd.y, -fwd.x);
    let along  = dot(rel, fwd);
    let across = dot(rel, rgt);
    let e = (along * along) / (9.0 * 9.0) + (across * across) / (3.6 * 3.6);
    let boatShadow = (1.0 - smoothstep(0.5, 1.0, e)) * (1.0 - seabedReveal);
    color *= 1.0 - boatShadow * 0.32;
  }

  // Soft waterline foam — suppressed where the seabed shows through (clear shore
  // water, not a hull edge) so it stops whitening the clear shallows.
  let waterline = smoothstep(0.0, 0.20, dz) * (1.0 - smoothstep(0.5, 1.6, dz))
                * (1.0 - seabedReveal * 0.92);
  color = mix(color, vec3f(0.90, 0.95, 1.00), vec3f(waterline * 0.70));

  // ── Cloud shadows (same as GLSL path) ───────────────────────────────────────
  if (uniforms.u_sunDir.y > 0.03 && uniforms.u_cloudCoverage > 0.02) {
    let cloudUV = (worldXZ + uniforms.u_sunDir.xz / max(uniforms.u_sunDir.y, 0.2) * 900.0) * 0.004;
    let drift   = vec2f(uniforms.u_Time * 0.18, uniforms.u_Time * 0.12);
    let cf = rVNoise(cloudUV + drift) * 0.6
           + rVNoise(cloudUV * 2.3 - drift * 1.7) * 0.4;
    var shadow = smoothstep(0.60 - uniforms.u_cloudCoverage * 0.45, 0.70 - uniforms.u_cloudCoverage * 0.30, cf);
    shadow *= uniforms.u_cloudCoverage * smoothstep(0.03, 0.18, uniforms.u_sunDir.y);
    color *= 1.0 - shadow * 0.78;
  }

  // ── Night dimming ───────────────────────────────────────────────────────────
  // (same as GLSL path) fade the surface toward a dim moonlit floor after dark so
  // the day-calibrated reflection / scattering / shallow tints aren't too bright.
  let dayLight = mix(0.12, 1.0, smoothstep(-0.12, 0.22, uniforms.u_sunElevation));
  color *= dayLight;

  fragmentOutputs.color = vec4f(aces_tonemap(color * 2.0), 1.0);
}
`;

// ── Kelvin wake shaders (unchanged) ──────────────────────────────────────────
// ── CPU port of GPU waveHeight() ─────────────────────────────────────────────
//
// Mirrors the GLSL `waveHeight(wx, wz)` in OCEAN_VERT exactly so that the CPU
// buoyancy sampler sees the same surface height as the rendered ocean vertex.
// Called 8× per physics tick (once per hull point) — fast enough on the CPU.

function _fract(x: number): number { return x - Math.floor(x); }

/** Playground wave primitive — returns [wave, -dx]. */
function _wavedx(px: number, py: number, dx: number, dy: number, frequency: number, timeShift: number): [number, number] {
  const x = (dx * px + dy * py) * frequency + timeShift;
  const wave = Math.exp(Math.sin(x) - 1.0);
  const ddx = wave * Math.cos(x);
  return [wave, -ddx];
}

/** CPU port of playground getwaves() — used by buoyancy parity path. */
function _getWaves(px0: number, py0: number, t: number): number {
  let px = px0;
  let py = py0;
  const wavePhaseShift = Math.hypot(px, py) * 0.1;
  let iter = 0.0;
  let frequency = 1.0;
  let timeMultiplier = 2.0;
  let weight = 1.0;
  let sum = 0.0;
  let sumW = 0.0;

  for (let i = 0; i < 24; i++) {
    const dx = Math.sin(iter);
    const dy = Math.cos(iter);
    const [wave, negDx] = _wavedx(px, py, dx, dy, frequency, t * timeMultiplier + wavePhaseShift);
    px += dx * negDx * weight * 0.38;
    py += dy * negDx * weight * 0.38;
    sum += wave * weight;
    sumW += weight;
    weight *= 0.8;
    frequency *= 1.18;
    timeMultiplier *= 1.07;
    iter += 1232.399963;
  }

  return sum / Math.max(sumW, 1e-5);
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class OceanService {
  private sceneService = inject(SceneService);

  private oceanMeshNear!: Mesh;          // ultra-close LOD centered on boat
  private oceanMesh0!:   Mesh;
  private oceanMesh1!:   Mesh;
  private oceanMeshFar!: Mesh;
  private oceanMatNear!: ShaderMaterial;
  private oceanMat0!:    ShaderMaterial;
  private oceanMat1!:    ShaderMaterial;
  private oceanMatFar!:  ShaderMaterial;

  // Quality toggles (persisted). When off, the shader falls back to analytic sky /
  // no seabed AND the corresponding off-screen RTT pass is stopped (the real win).
  private _reflectionsEnabled = (localStorage.getItem('ignis_reflections') ?? '1') !== '0';
  private _transparencyEnabled = (localStorage.getItem('ignis_water_transparency') ?? '1') !== '0';

  private reflectionRTT!: MirrorTexture;
  private refractionRTT!: RenderTargetTexture;   // seabed-only colour for true shallow-water transparency
  private terrainShadowMask: Texture | null = null;
  private terrainShadowCenter = new Vector2(0, 0);
  private terrainShadowSize = 1;
  private terrainShadowStrength = 0;
  // Shore elevation map (set by TerrainService after init).
  // shoreMapBlackTexture is a 1×1 black placeholder — enc=0 decodes to
  // tElev=−15 m so wDep≈15 m, both foam and tint thresholds fail to trigger.
  // This prevents the foamAnim polka-dot artefact before the real map arrives.
  private shoreMap: Texture | null = null;
  private shoreMapBlackTexture: DynamicTexture | null = null;
  private shoreMapCenter = new Vector2(0, 0);
  private shoreMapSize = 3000;  // correct world width; placeholder is always black

  private elapsed    = 0;
  private boatX      = 0;
  private boatZ      = 0;
  private boatHdgR   = 0;
  private boatSpeed  = 0;

  // ── Wake trail ──────────────────────────────────────────────────────────────
  // Recent track of the ship as a short polyline (x, z, age, _) per point, newest
  // appended at the end. The shader computes froth/turbulence from distance-to-
  // path + age, so the wake follows the exact route sailed and fades behind.
  private readonly WAKE_PATH_MAX  = 24;     // matches the shader array size
  private readonly WAKE_PATH_STEP = 3;      // metres travelled between recorded points (denser = smoother curve)
  private readonly WAKE_PATH_LIFE = 7.0;    // seconds before a point fully fades
  private wakePath = new Float32Array(this.WAKE_PATH_MAX * 4);
  private wakePathCount = 0;
  private wakeLastX = 0;
  private wakeLastZ = 0;

  // Transient cannonball water impacts → a geyser+ring displacement on the surface.
  private readonly SPLASH_MAX  = 8;      // matches the shader array size
  private readonly SPLASH_LIFE = 1.6;    // seconds before a splash fully settles
  private splashData = new Float32Array(this.SPLASH_MAX * 4);  // xy = pos, z = age
  private splashCount = 0;

  // Small weather coupling: stormy seas slightly amplify wave depth.
  private waveDepthScale = 1.0;

  // ── LOD geometry constants ─────────────────────────────────────────────────
  // LOD hierarchy (vertex spacing):
  //   NEAR  80 m ×  80 m, 256 subs →  0.31 m/vert — hull precision (boat-centred)
  //   LOD0 800 m × 800 m, 512 subs →  1.56 m/vert — smooth close-up (camera-centred)
  //   LOD1  4 km ×  4 km, 128 subs → 31.25 m/vert — mid-range swell
  //   FAR 200 km ×200 km,  32 subs →  flat        — horizon fill, no displacement
  private readonly NEAR_SIZE = 80;
  private readonly NEAR_SUB  = 256;
  private readonly LOD0_SIZE = 800;
  private readonly LOD0_SUB  = 512;   // was 256 — doubled for smooth close-up
  private readonly LOD1_SIZE = 4_000;
  private readonly LOD1_SUB  = 128;
  private readonly FAR_SIZE  = 200_000;
  private readonly FAR_SUB   = 32;


  // Playground-style wave tuning. Near and LOD0 use full quality;
  // LOD1/FAR are reduced for performance.
  private readonly WAVE_FREQ = 0.18;
  private readonly WAVE_DEPTH_NEAR = 3.0;
  private readonly WAVE_DEPTH_MID  = 2.3;
  private readonly WAVE_DEPTH_FAR  = 1.5;

  // ── Init ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const { scene } = this.sceneService;
    this.buildReflectionRTT(scene);
    this.buildShoreMapBlackTexture(scene);
    this.buildLodFar(scene);
    this.buildLod1(scene);
    this.buildLod0(scene);
    this.buildLodNear(scene);
    this.registerRenderLoop(scene);

    // WGSL ShaderMaterials can't participate in Babylon's prePass G-buffer
    // compilation (used by SSAO2 + DoF).  Exclude all ocean/wake materials so
    // the prePass skips them — water doesn't need AO or DoF depth data anyway.
    if (this.sceneService.isWebGPU) {
      for (const mat of [
        this.oceanMatFar, this.oceanMat1, this.oceanMat0, this.oceanMatNear,
      ]) {
        this.sceneService.excludeFromPrePass(mat);
      }
    }

    // Sync the persisted quality toggles: if either is off, stop its RTT pass now
    // (buildReflectionRTT pushes both unconditionally).
    this.setReflectionsEnabled(this._reflectionsEnabled);
    this.setWaterTransparencyEnabled(this._transparencyEnabled);
  }

  // ── Reflection RTT ────────────────────────────────────────────────────────

  private buildReflectionRTT(scene: Scene): void {
    // 512 px + every-other-frame: this RTT re-renders the whole scene (terrain
    // included) mirrored, which is a big fixed per-frame cost independent of the
    // main render-scale. Water reflections are distorted/blurry anyway, so neither
    // the resolution drop nor the 30 Hz update rate is noticeable — but it roughly
    // 1/8ths the reflection's cost.
    this.reflectionRTT = new MirrorTexture('oceanReflection', 512, scene, true);
    // Every other frame (perf). If the sky/sun reflection strobes at low FPS, set to 1.
    this.reflectionRTT.refreshRate = 2;
    this.reflectionRTT.mirrorPlane = new Plane(0, -1, 0, 0);
    this.reflectionRTT.renderList  = [];

    // Seed with the sky — always present and covers the whole horizon.
    const skybox = scene.getMeshByName('skybox');
    if (skybox) this.reflectionRTT.renderList!.push(skybox);

    // CRITICAL: register as a custom render target so BabylonJS renders it
    // every frame.  Without this entry the ShaderMaterial sampler receives a
    // blank texture — BabylonJS only auto-renders RTTs that are wired through
    // StandardMaterial / PBRMaterial reflection slots, not ShaderMaterial.
    scene.customRenderTargets.push(this.reflectionRTT);

    // ── Refraction RTT: the seabed (terrain only) rendered from the main camera,
    // at half resolution, so the ocean shader can show the REAL terrain colour
    // through shallow water (true depth transparency) without alpha-blending the
    // ocean. Only the terrain heightfield is drawn — cheap-ish and exactly what
    // we want behind the water.
    this.refractionRTT = new RenderTargetTexture('oceanRefraction', { ratio: 0.5 }, scene, false);
    // Include the terrain seabed AND the vessel (any non-ocean, non-foliage opaque
    // mesh), so the submerged hull occludes the sand behind it — otherwise the
    // shader "sees past" the keel to the seabed and sand shows through the hull.
    // Trees/scatter excluded for perf.
    this.refractionRTT.renderListPredicate = (m) =>
      !m.name.startsWith('ocean_') && !m.name.startsWith('tree_') && !m.name.startsWith('scatter_') &&
      m.name !== 'skybox';   // exclude the sky: where the seabed drops off, the water must NOT reveal the sky (a bright sky-coloured band)
    // Clear to a sandy tan so where the seabed drops off (no terrain behind the water) the
    // shallows reveal SAND rather than the sky or a dark void — a tan transition that blends
    // the deep→shallow boundary into the beach colour.
    this.refractionRTT.clearColor = new Color4(0.57, 0.50, 0.37, 1.0);
    this.refractionRTT.refreshRate = 2;   // every other frame — seabed barely moves
    scene.customRenderTargets.push(this.refractionRTT);

    // Island meshes arrive asynchronously (HTTP load).  Auto-enroll them so
    // we don't need a separate manual call after each island is built.
    // Vessel parts are enrolled via the explicit addToRenderList() calls in
    // vessel.service.ts (which run after the vessel mesh is created).
    scene.onNewMeshAddedObservable.add((mesh) => {
      if (mesh.name.startsWith('island_')) {
        this.addToRenderList(mesh);
      }
    });
  }

  // ── Shore-map black placeholder ────────────────────────────────────────────

  /**
   * 1×1 black DynamicTexture used as the `u_shoreMap` sampler placeholder
   * before TerrainService writes the real elevation map.  Sampling it gives
   * R=0 → enc=0 → tElev=−15 m → wDep≈+15 m, which exceeds every foam/tint
   * threshold → both effects stay fully transparent.  This prevents the
   * foamAnim dot-grid artefact that appears when the reflectionRTT is used
   * (which encodes scene colours, not ocean depths).
   */
  private buildShoreMapBlackTexture(scene: Scene): void {
    const tex = new DynamicTexture('shoreMapBlack', { width: 1, height: 1 }, scene, false);
    tex.hasAlpha = false;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 1, 1);
    tex.update();
    this.shoreMapBlackTexture = tex;
  }

  // ── LOD meshes ─────────────────────────────────────────────────────────────

  private buildLodFar(scene: Scene): void {
    this.oceanMeshFar = MeshBuilder.CreateGround('ocean_far', {
      width: this.FAR_SIZE, height: this.FAR_SIZE, subdivisions: this.FAR_SUB,
    }, scene);
    this.oceanMeshFar.renderingGroupId = 0;
    // FAR: flat (displaceScale 0), so edge fade is moot; no inner cull.
    this.oceanMatFar = this.buildOceanMaterial(scene, 'oceanMatFar', 0.0, this.FAR_SIZE / 2, -1, 1, 0);
    this.oceanMeshFar.material = this.oceanMatFar;
  }

  private buildLod1(scene: Scene): void {
    this.oceanMesh1 = MeshBuilder.CreateGround('ocean_lod1', {
      width: this.LOD1_SIZE, height: this.LOD1_SIZE, subdivisions: this.LOD1_SUB,
    }, scene);
    this.oceanMesh1.renderingGroupId = 1;
    this.oceanMesh1.position.y       = 0.002;
    // LOD1: fade displacement to 0 at its edge so it blends into the FLAT far ocean.
    this.oceanMat1 = this.buildOceanMaterial(scene, 'oceanMat1', 1.0, this.LOD1_SIZE / 2, 1, 1, 0);
    this.oceanMesh1.material = this.oceanMat1;
  }

  private buildLod0(scene: Scene): void {
    this.oceanMesh0 = MeshBuilder.CreateGround('ocean_lod0', {
      width: this.LOD0_SIZE, height: this.LOD0_SIZE, subdivisions: this.LOD0_SUB,
    }, scene);
    this.oceanMesh0.renderingGroupId = 2;
    this.oceanMesh0.position.y       = 0.004;
    // LOD0: full waves to its edge (LOD1 continues the field beneath it, no fade
    // needed), and hard-cut the near patch out of it so the two group-2 surfaces
    // never interpenetrate. Cull just inside the near edge (40 m) for a safe seam.
    this.oceanMat0 = this.buildOceanMaterial(
      scene, 'oceanMat0', 1.0, this.LOD0_SIZE / 2, 2, 0, this.NEAR_SIZE / 2 - 0.5);
    this.oceanMesh0.material = this.oceanMat0;
  }

  /**
   * Ultra-close near-boat LOD — 0.31 m vertex spacing for wave resolution
   * directly under the hull.  Centred on the boat (not the camera) so it
   * stays precisely aligned with the physics-sampled wave surface.
   * Rendered in group 2 at y+0.006 — just above LOD0 (+0.004) so depth-testing
   * always keeps the denser near surface visible through the coarser one.
   * The shader's edge-fade smoothstep (80 %–97 % of halfSize = 32–39 m from
   * boat centre) blends the displacement gracefully to zero at the seam.
   */
  private buildLodNear(scene: Scene): void {
    this.oceanMeshNear = MeshBuilder.CreateGround('ocean_near', {
      width: this.NEAR_SIZE, height: this.NEAR_SIZE, subdivisions: this.NEAR_SUB,
    }, scene);
    this.oceanMeshNear.renderingGroupId = 2;
    this.oceanMeshNear.position.y       = 0.006;   // above LOD0 (0.004) — wins depth test
    // NEAR: full waves all the way to its edge (no fade); LOD0 is hard-cut beneath
    // it, so its edge hands straight over to LOD0's identical wave field.
    this.oceanMatNear = this.buildOceanMaterial(scene, 'oceanMatNear', 1.0, this.NEAR_SIZE / 2, 2, 0, 0);
    this.oceanMeshNear.material = this.oceanMatNear;
  }

  // ── Ocean ShaderMaterial factory ──────────────────────────────────────────

  private buildOceanMaterial(
    scene:         Scene,
    name:          string,
    displaceScale: number,
    meshHalfSize:  number,
    maxCascade:    number,
    edgeFade:      number,   // 1 = fade displacement to 0 at edge (meets a flat outer LOD); 0 = full waves
    innerCull:     number,   // >0 = discard frags within this chebyshev half-size of the boat (inner footprint)
  ): ShaderMaterial {
    const useWgsl = this.sceneService.isWebGPU;
    const mat = new ShaderMaterial(name, scene,
      {
        vertexSource: useWgsl ? OCEAN_VERT_WGSL : OCEAN_VERT,
        fragmentSource: useWgsl ? OCEAN_FRAG_WGSL : OCEAN_FRAG,
      },
      {
        attributes: ['position'],
        uniforms: [
          'world', 'worldViewProjection',
          'u_WorldOffset', 'u_MeshHalfSize', 'u_DisplaceScale', 'u_edgeFade', 'u_innerCull',
          'u_Time', 'u_WaveDepth', 'u_WaveFreq',
          'u_BoatPos', 'u_BoatDir', 'u_BoatSpeed',
          'u_cameraPosition', 'view',
          'u_terrainShadowCenter', 'u_terrainShadowSize', 'u_terrainShadowStrength',
          'u_shoreMapCenter', 'u_shoreMapSize',
          'u_cloudCoverage', 'u_sunElevation', 'u_rainIntensity', 'u_sunDir',
          'u_reflectionStrength', 'u_seabedStrength', 'u_normalIter',
          'u_wakePath', 'u_wakeCount', 'u_splashData', 'u_splashCount',
        ],
        samplers: ['u_reflectionSampler', 'u_terrainShadowMask', 'u_shoreMap', 'u_sceneDepth', 'u_refraction'],
        needAlphaBlending: false,
        shaderLanguage: useWgsl ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      },
    );

    const waveDepth = (maxCascade >= 2 ? this.WAVE_DEPTH_NEAR : maxCascade >= 1 ? this.WAVE_DEPTH_MID : this.WAVE_DEPTH_FAR) * this.waveDepthScale;

    mat.setFloat('u_DisplaceScale', displaceScale);
    mat.setFloat('u_MeshHalfSize',  meshHalfSize);
    mat.setFloat('u_edgeFade',      edgeFade);
    mat.setFloat('u_innerCull',     innerCull);
    mat.setFloat('u_WaveDepth',   waveDepth);
    mat.setFloat('u_WaveFreq',    this.WAVE_FREQ);

    mat.setFloat('u_Time', 0);
    mat.setVector3('u_cameraPosition', Vector3.Zero());
    mat.setVector2('u_WorldOffset',    new Vector2(0, 0));
    mat.setVector2('u_BoatPos', new Vector2(0, 0));
    mat.setVector2('u_BoatDir', new Vector2(0, 1));
    mat.setFloat('u_BoatSpeed', 0);
    mat.setTexture('u_reflectionSampler', this.reflectionRTT);
    if (this.terrainShadowMask) {
      mat.setTexture('u_terrainShadowMask', this.terrainShadowMask);
    } else {
      mat.setTexture('u_terrainShadowMask', this.reflectionRTT);
    }
    mat.setVector2('u_terrainShadowCenter', this.terrainShadowCenter);
    mat.setFloat('u_terrainShadowSize', this.terrainShadowSize);
    mat.setFloat('u_terrainShadowStrength', this.terrainShadowStrength);
    // Shore map: use the 1×1 black placeholder until TerrainService sets the
    // real elevation texture.  Black → enc=0 → tElev=−15 m → wDep≈15 m →
    // foamF and shallowF both zero → no spurious polka-dot effect.
    mat.setTexture('u_shoreMap', this.shoreMap ?? this.shoreMapBlackTexture ?? this.reflectionRTT);
    mat.setVector2('u_shoreMapCenter', this.shoreMapCenter);
    mat.setFloat('u_shoreMapSize', this.shoreMapSize);
    mat.setFloat('u_cloudCoverage', 0);
    mat.setFloat('u_sunElevation',  0);
    mat.setFloat('u_rainIntensity', 0);
    mat.setFloat('u_reflectionStrength', this._reflectionsEnabled ? 1 : 0);
    mat.setFloat('u_seabedStrength',     this._transparencyEnabled ? 1 : 0);
    // Per-LOD fragment-normal detail: near/LOD0 stay smooth (reflections read clearly),
    // LOD1 + far drop low — the far sea is most of the screen but its reflections are
    // tiny, so the faceting is invisible there while the iteration savings are large.
    const normalIter = maxCascade >= 2 ? 16 : (maxCascade >= 1 ? 10 : 6);
    mat.setInt('u_normalIter', normalIter);
    mat.setVector3('u_sunDir', new Vector3(0, 1, 0));
    mat.setArray4('u_wakePath', Array(this.WAKE_PATH_MAX * 4).fill(0));
    mat.setFloat('u_wakeCount', 0);
    mat.setArray4('u_splashData', Array(this.SPLASH_MAX * 4).fill(0));
    mat.setFloat('u_splashCount', 0);
    // Soft-waterline depth map (ocean excluded). Fall back to the reflection RTT
    // until the scene's depth map exists — harmless because its colour values are
    // < the water's camera-space Z, so dz is negative and no foam is drawn.
    mat.setTexture('u_sceneDepth', this.sceneService.oceanDepthMap ?? this.reflectionRTT);
    mat.setTexture('u_refraction', this.refractionRTT);

    return mat;
  }

  // ── Per-frame render loop ──────────────────────────────────────────────────

  private registerRenderLoop(scene: Scene): void {
    scene.registerBeforeRender(() => {
      const dt = scene.getEngine().getDeltaTime() * 0.001;
      this.elapsed += dt;

      const cam = scene.activeCamera;
      const t   = this.elapsed;

      if (cam) {
        const cx   = cam.position.x;
        const cz   = cam.position.z;
        const wOff = new Vector2(cx, cz);
        const camV = cam.position;

        // Near mesh — centre on the boat, not the camera, for hull-precision waves.
        // WorldOffset must match mesh centre so the shader computes correct world coords.
        const nearOff = new Vector2(this.boatX, this.boatZ);
        this.oceanMeshNear.position.x = this.boatX;
        this.oceanMeshNear.position.z = this.boatZ;
        this.oceanMatNear.setVector2('u_WorldOffset',    nearOff);
        this.oceanMatNear.setVector3('u_cameraPosition', camV);

        this.oceanMesh0.position.x = cx; this.oceanMesh0.position.z = cz;
        this.oceanMat0.setVector2('u_WorldOffset',    wOff);
        this.oceanMat0.setVector3('u_cameraPosition', camV);

        this.oceanMesh1.position.x = cx; this.oceanMesh1.position.z = cz;
        this.oceanMat1.setVector2('u_WorldOffset',    wOff);
        this.oceanMat1.setVector3('u_cameraPosition', camV);

        this.oceanMeshFar.position.x = cx; this.oceanMeshFar.position.z = cz;
        this.oceanMatFar.setVector2('u_WorldOffset',    wOff);
        this.oceanMatFar.setVector3('u_cameraPosition', camV);
      }

      this.updateWakePath(dt);
      this.updateSplashes(dt);

      const allMats   = [this.oceanMatNear, this.oceanMat0, this.oceanMat1, this.oceanMatFar];
      const boatDir = new Vector2(Math.sin(this.boatHdgR), Math.cos(this.boatHdgR));
      const boatPos = new Vector2(this.boatX, this.boatZ);
      const boatSpeedAbs = Math.abs(this.boatSpeed) * 4.0;
      const wakePathArr = this.wakePath as unknown as number[];
      const splashArr   = this.splashData as unknown as number[];

      const depthMap = this.sceneService.oceanDepthMap;
      for (const mat of allMats) {
        mat.setFloat('u_Time', t);
        mat.setVector2('u_BoatPos', boatPos);
        mat.setVector2('u_BoatDir', boatDir);
        mat.setFloat('u_BoatSpeed', boatSpeedAbs);
        mat.setFloat('u_cloudCoverage', this._cloudCoverage);
        mat.setFloat('u_sunElevation',  this._sunElevation);
        mat.setFloat('u_rainIntensity', this._rainIntensity);
        mat.setVector3('u_sunDir', this.sceneService.getSunDirection());
        mat.setArray4('u_wakePath', wakePathArr);
        mat.setFloat('u_wakeCount', this.wakePathCount);
        mat.setArray4('u_splashData', splashArr);
        mat.setFloat('u_splashCount', this.splashCount);
        if (depthMap) mat.setTexture('u_sceneDepth', depthMap);
      }

    });
  }

  /**
   * Maintains the ship's recent track polyline: ages points, drops faded/old ones
   * from the front, and appends a new point each time the boat has travelled far
   * enough while moving. The shader turns this into a path-following, fading wake.
   */
  /** Register a cannonball water impact at (x,z) — drives the surface geyser+ring. */
  addSplash(x: number, z: number): void {
    const N = 4;
    if (this.splashCount >= this.SPLASH_MAX) {
      this.splashData.copyWithin(0, N, this.SPLASH_MAX * N);   // drop the oldest
      this.splashCount = this.SPLASH_MAX - 1;
    }
    const idx = this.splashCount * N;
    this.splashData[idx]     = x;
    this.splashData[idx + 1] = z;
    this.splashData[idx + 2] = 0;   // age
    this.splashData[idx + 3] = 0;
    this.splashCount++;
  }

  /** Age active splashes and drop settled ones (oldest are at the front). */
  private updateSplashes(dt: number): void {
    const buf = this.splashData;
    const N = 4;
    for (let i = 0; i < this.splashCount; i++) buf[i * N + 2] += dt;
    let drop = 0;
    while (drop < this.splashCount && buf[drop * N + 2] > this.SPLASH_LIFE) drop++;
    if (drop > 0) {
      buf.copyWithin(0, drop * N, this.splashCount * N);
      this.splashCount -= drop;
    }
  }

  private updateWakePath(dt: number): void {
    const buf = this.wakePath;
    const N = 4;

    // Age every active point.
    for (let i = 0; i < this.wakePathCount; i++) buf[i * N + 2] += dt;

    // Drop fully-faded points from the front (they are the oldest).
    let drop = 0;
    while (drop < this.wakePathCount && buf[drop * N + 2] > this.WAKE_PATH_LIFE) drop++;
    if (drop > 0) {
      buf.copyWithin(0, drop * N, this.wakePathCount * N);
      this.wakePathCount -= drop;
    }

    // Append a fresh point once the boat has moved far enough (and is moving).
    const dx = this.boatX - this.wakeLastX;
    const dz = this.boatZ - this.wakeLastZ;
    const movedSq = dx * dx + dz * dz;
    if (Math.abs(this.boatSpeed) > 0.05 && movedSq >= this.WAKE_PATH_STEP * this.WAKE_PATH_STEP) {
      if (this.wakePathCount >= this.WAKE_PATH_MAX) {
        // Make room by dropping the oldest.
        buf.copyWithin(0, N, this.WAKE_PATH_MAX * N);
        this.wakePathCount = this.WAKE_PATH_MAX - 1;
      }
      const idx = this.wakePathCount * N;
      buf[idx]     = this.boatX;
      buf[idx + 1] = this.boatZ;
      buf[idx + 2] = 0;
      buf[idx + 3] = 0;
      this.wakePathCount++;
      this.wakeLastX = this.boatX;
      this.wakeLastZ = this.boatZ;
    }
  }

  // ── Cloud reflection ──────────────────────────────────────────────────────
  private _cloudCoverage = 0;
  private _sunElevation  = 0;
  private _rainIntensity = 0;

  /** Call each frame from CloudService so the water mirrors current sky state. */
  setCloudReflection(coverage: number, sunElevation: number): void {
    this._cloudCoverage = coverage;
    this._sunElevation  = sunElevation;
  }

  /** Current cloud coverage (0–1) — shared with the terrain so its cloud shadows match. */
  getCloudCoverage(): number { return this._cloudCoverage; }
  getRainIntensity(): number { return this._rainIntensity; }
  /** Current shader time (same clock that drifts the ocean's cloud shadows). */
  getOceanTime(): number { return this.elapsed; }

  /** Call each frame from CloudService — drives the surface rain-ripple normals. */
  setRainIntensity(intensity: number): void {
    this._rainIntensity = Math.max(0, Math.min(1, intensity));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getWaveHeightAt(wx: number, wz: number, t: number): number {
    return this.getVisualHeightAt(wx, wz, t);
  }

  /**
   * CPU port of the GPU vertex shader's `waveHeight(wx, wz)`.
   *
   * Produces the same wave height as the rendered ocean surface for a given
   * world position and simulation time.  Use this (rather than
   * WaveEngine.getHeightAt) whenever the CPU height must match the visual
   * surface — e.g. hull buoyancy sampling in VesselBuoyancyService.
   *
   * Shader-faithful CPU height path (from Babylon playground 7KGC8J).
   */
  /** When set (FFT ocean active), all height queries come from here instead of the
   *  procedural model — so the boat floats on the actual FFT surface. NaN = not ready. */
  private heightProvider: ((wx: number, wz: number) => number) | null = null;
  setHeightProvider(fn: ((wx: number, wz: number) => number) | null): void {
    this.heightProvider = fn;
  }

  getVisualHeightAt(wx: number, wz: number, t: number): number {
    if (this.heightProvider) {
      const h = this.heightProvider(wx, wz);
      if (!Number.isNaN(h)) { return h; }   // NaN → FFT map not ready yet, fall back
    }
    const px = wx * this.WAVE_FREQ;
    const py = wz * this.WAVE_FREQ;
    const h = (_getWaves(px, py, t) - 0.5) * this.WAVE_DEPTH_NEAR * this.waveDepthScale;
    return h;
  }

  setBoatTransform(x: number, z: number, hdgRad: number, speed: number): void {
    this.boatX     = x;
    this.boatZ     = z;
    this.boatHdgR  = hdgRad;
    this.boatSpeed = speed;
  }

  updateWeather(wind: Wind, sea: SeaConditions): void {
    const chop = Math.max(0, Math.min(1, sea.choppiness));
    const windT = Math.max(0, Math.min(1, wind.speed / 24));
    // Wave amplitude scales strongly with sea state so storms feel genuinely
    // rougher than calm water: ~0.6 (glassy) → ~2.3 (full storm), a ~3.8× range
    // (was 0.95→1.47, barely perceptible). Buoyancy follows automatically because
    // getWaveHeightAt / getVisualHeightAt use the same waveDepthScale.
    this.waveDepthScale = 0.6 + chop * 0.9 + windT * 0.8;

    if (this.oceanMatNear) this.oceanMatNear.setFloat('u_WaveDepth', this.WAVE_DEPTH_NEAR * this.waveDepthScale);
    if (this.oceanMat0)    this.oceanMat0.setFloat('u_WaveDepth',    this.WAVE_DEPTH_NEAR * this.waveDepthScale);
    if (this.oceanMat1)    this.oceanMat1.setFloat('u_WaveDepth',    this.WAVE_DEPTH_MID  * this.waveDepthScale);
    if (this.oceanMatFar)  this.oceanMatFar.setFloat('u_WaveDepth',  this.WAVE_DEPTH_FAR  * this.waveDepthScale);
  }

  /** Called every ~10 frames by TerrainService with the freshly-painted shore elevation map. */
  setShoreMap(map: Texture, centerX: number, centerZ: number, size: number): void {
    this.shoreMap = map;
    this.shoreMapCenter.set(centerX, centerZ);
    this.shoreMapSize = Math.max(1, size);

    const mats = [this.oceanMatNear, this.oceanMat0, this.oceanMat1, this.oceanMatFar];
    for (const mat of mats) {
      if (!mat) continue;
      mat.setTexture('u_shoreMap', map);
      mat.setVector2('u_shoreMapCenter', this.shoreMapCenter);
      mat.setFloat('u_shoreMapSize', this.shoreMapSize);
    }
  }

  setTerrainShadowMask(mask: Texture, centerX: number, centerZ: number, size: number, strength: number): void {
    this.terrainShadowMask = mask;
    this.terrainShadowCenter.set(centerX, centerZ);
    this.terrainShadowSize = Math.max(1, size);
    this.terrainShadowStrength = Math.max(0, Math.min(1, strength));

    const mats = [this.oceanMatNear, this.oceanMat0, this.oceanMat1, this.oceanMatFar];
    for (const mat of mats) {
      if (!mat) continue;
      mat.setTexture('u_terrainShadowMask', mask);
      mat.setVector2('u_terrainShadowCenter', this.terrainShadowCenter);
      mat.setFloat('u_terrainShadowSize', this.terrainShadowSize);
      mat.setFloat('u_terrainShadowStrength', this.terrainShadowStrength);
    }
  }

  // ── Quality toggles (Settings) ─────────────────────────────────────────────

  isReflectionsEnabled(): boolean { return this._reflectionsEnabled; }
  isWaterTransparencyEnabled(): boolean { return this._transparencyEnabled; }

  /** Water reflections on/off. Off → analytic sky only in-shader AND the reflection
   *  RTT (a full mirrored scene re-render) is removed from the render loop. */
  setReflectionsEnabled(enabled: boolean): void {
    this._reflectionsEnabled = enabled;
    localStorage.setItem('ignis_reflections', enabled ? '1' : '0');
    for (const mat of [this.oceanMatNear, this.oceanMat0, this.oceanMat1, this.oceanMatFar]) {
      if (mat) mat.setFloat('u_reflectionStrength', enabled ? 1 : 0);
    }
    this.toggleCustomRenderTarget(this.reflectionRTT, enabled);
  }

  /** Shallow-water see-through on/off. Off → no seabed reveal in-shader AND the
   *  refraction RTT (a terrain/vessel re-render) is removed. The depth renderer is
   *  left running because it also feeds the soft waterline. */
  setWaterTransparencyEnabled(enabled: boolean): void {
    this._transparencyEnabled = enabled;
    localStorage.setItem('ignis_water_transparency', enabled ? '1' : '0');
    for (const mat of [this.oceanMatNear, this.oceanMat0, this.oceanMat1, this.oceanMatFar]) {
      if (mat) mat.setFloat('u_seabedStrength', enabled ? 1 : 0);
    }
    this.toggleCustomRenderTarget(this.refractionRTT, enabled);
  }

  /** Add/remove an RTT from the scene's per-frame render list (stops its GPU pass). */
  private toggleCustomRenderTarget(rtt: RenderTargetTexture | MirrorTexture, enabled: boolean): void {
    const scene = this.sceneService.scene;
    if (!scene || !rtt) return;
    const list = scene.customRenderTargets;
    const idx = list.indexOf(rtt);
    if (enabled && idx < 0) list.push(rtt);
    else if (!enabled && idx >= 0) list.splice(idx, 1);
  }

  // O(1) dedup — island meshes arrive via both the onNewMeshAdded observable and
  // explicit addToRenderList() calls; vegetation instances arrive only via the
  // direct call.  The Set avoids O(n) Array.includes() on a potentially large list.
  private renderListSet = new Set<AbstractMesh>();

  addToRenderList(mesh: AbstractMesh): void {
    if (this.reflectionRTT?.renderList && !this.renderListSet.has(mesh)) {
      this.renderListSet.add(mesh);
      this.reflectionRTT.renderList.push(mesh);
    }
  }

  /** Remove a mesh from the reflection render list (e.g. a disconnected remote vessel),
   *  so disposed meshes don't accumulate in the RTT over many join/leaves. */
  removeFromRenderList(mesh: AbstractMesh): void {
    if (!this.renderListSet.has(mesh)) return;
    this.renderListSet.delete(mesh);
    const list = this.reflectionRTT?.renderList;
    if (list) {
      const i = list.indexOf(mesh);
      if (i >= 0) list.splice(i, 1);
    }
  }

  getOceanMesh(): Mesh { return this.oceanMesh0; }

  /** The shared planar reflection RTT (skybox + islands + vessels), for the FFT ocean to reuse. */
  getReflectionTexture(): MirrorTexture { return this.reflectionRTT; }

  /** Seabed-only colour RTT (scene minus ocean), for the FFT ocean's shallow-water transparency. */
  getRefractionTexture(): RenderTargetTexture { return this.refractionRTT; }

  /** Boat pose + speed for the FFT ocean's wake (dir = heading unit vector; speed scaled ×4). */
  getBoatWake(): { x: number; z: number; dirX: number; dirZ: number; speed: number } {
    return {
      x: this.boatX, z: this.boatZ,
      dirX: Math.sin(this.boatHdgR), dirZ: Math.cos(this.boatHdgR),
      speed: Math.abs(this.boatSpeed) * 4.0,
    };
  }

  /** The CPU wake track (vec4 ×24: x, z, age(s), _) + valid-point count, for a curved wake. */
  getWakePath(): { data: Float32Array; count: number } {
    return { data: this.wakePath, count: this.wakePathCount };
  }

  /** Active cannonball water impacts (vec4 ×8: x, z, age(s), _) + count, for splash displacement. */
  getSplashData(): { data: Float32Array; count: number } {
    return { data: this.splashData, count: this.splashCount };
  }

  /** Top-down terrain (island) shadow mask + transform + strength + live cloud cover, for the
   *  FFT ocean to cast island/cloud shadows on the water. Black placeholder until terrain sets it. */
  getWaterShadowInfo(): { map: Texture; center: Vector2; size: number; strength: number; cloud: number } {
    return {
      map: this.terrainShadowMask ?? this.shoreMapBlackTexture ?? this.reflectionRTT,
      center: this.terrainShadowCenter,
      size: this.terrainShadowSize > 0 ? this.terrainShadowSize : 1e9,
      strength: this.terrainShadowStrength,
      cloud: this._cloudCoverage,
    };
  }

  /**
   * Shore/elevation map for the FFT ocean (shoaling + shallow shading). R = clamp((elev+15)/20).
   * Returns a black placeholder + huge size until terrain sets the real map (so the FFT ocean
   * reads "open ocean" everywhere in the meantime). center/size are live (terrain may restream).
   */
  getShoreInfo(): { map: Texture; center: Vector2; size: number } {
    return {
      map: this.shoreMap ?? this.shoreMapBlackTexture ?? this.reflectionRTT,
      center: this.shoreMapCenter,
      size: this.shoreMapSize > 0 ? this.shoreMapSize : 1e9,
    };
  }

  /** Hide/show the procedural ocean meshes (so the FFT ocean can take over on WebGPU). */
  setHidden(hidden: boolean): void {
    this.oceanMeshNear?.setEnabled(!hidden);
    this.oceanMesh0?.setEnabled(!hidden);
    this.oceanMesh1?.setEnabled(!hidden);
    this.oceanMeshFar?.setEnabled(!hidden);
  }
}
