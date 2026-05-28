import { Injectable, inject } from '@angular/core';
import {
  MeshBuilder, Vector2, Vector3, AbstractMesh, Mesh, ShaderMaterial, Scene,
  MirrorTexture, Plane, Texture, DynamicTexture,
} from '@babylonjs/core';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import { SceneService } from './scene.service';
import { SeaConditions, Wind } from '../models';

const OCEAN_VERT = `
precision highp float;

#ifdef WEBGPU
layout(location = 0) in vec3 position;
layout(location = 0) out vec3 v_worldPos;
layout(location = 1) out vec4 v_projPos;
layout(location = 2) out float v_wakeMask;
#else
attribute vec3 position;
varying vec3  v_worldPos;
varying vec4  v_projPos;
varying float v_wakeMask;
#endif

uniform mat4 worldViewProjection;
uniform mat4 world;

uniform float u_Time;
uniform vec2  u_WorldOffset;
uniform float u_MeshHalfSize;
uniform float u_DisplaceScale;
uniform float u_WaveDepth;
uniform float u_WaveFreq;
uniform vec2  u_BoatPos;
uniform vec2  u_BoatDir;
uniform float u_BoatSpeed;

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

float wakeDisplacement(vec2 worldPos) {
  vec2 rel = worldPos - u_BoatPos;
  float along = dot(rel, -u_BoatDir);
  if (along <= 0.0) return 0.0;

  vec2 right = vec2(-u_BoatDir.y, u_BoatDir.x);
  float lateral = dot(rel, right);

  float width = 4.8 + min(10.0, u_BoatSpeed * 0.42);
  float depth = 0.36 + min(1.05, u_BoatSpeed * 0.060);
  float build = 1.0 - exp(-along * 0.030);
  float trail = exp(-along * 0.0082);

  float trench = exp(-(lateral * lateral) / (width * width));
  float shoulderOffset = abs(lateral) - width * 1.55;
  float shoulders = exp(-(shoulderOffset * shoulderOffset) / (width * width * 1.8));

  float ripple = sin(along * 0.18) * exp(-along * 0.028) * 0.06;
  return (-trench * 0.96 + shoulders * 0.30 + ripple) * depth * build * trail;
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

  // Edge-fade: blend displacement to zero near mesh boundary to hide seam.
  float d    = max(abs(position.x), abs(position.z));
  float fade = u_DisplaceScale * (1.0 - smoothstep(
    u_MeshHalfSize * 0.80,
    u_MeshHalfSize * 0.97,
    d
  ));

  vec3  pos = position;

  if (fade > 0.001) {
    vec2 wavePos = vec2(wx, wz) * u_WaveFreq;
    float h = (getwaves(wavePos) - 0.5) * u_WaveDepth;
    h += wakeDisplacement(vec2(wx, wz));
    pos.y += h * fade;
  }

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

#ifdef WEBGPU
layout(location = 0) in vec3 v_worldPos;
layout(location = 1) in vec4 v_projPos;
layout(location = 2) in float v_wakeMask;
layout(location = 0) out vec4 fragmentColor;
#else
varying vec3 v_worldPos;
varying vec4 v_projPos;
varying float v_wakeMask;
#endif

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

float wakeDisplacement(vec2 worldPos) {
  vec2 rel = worldPos - u_BoatPos;
  float along = dot(rel, -u_BoatDir);
  if (along <= 0.0) return 0.0;

  vec2 right = vec2(-u_BoatDir.y, u_BoatDir.x);
  float lateral = dot(rel, right);

  float width = 4.8 + min(10.0, u_BoatSpeed * 0.42);
  float depth = 0.36 + min(1.05, u_BoatSpeed * 0.060);
  float build = 1.0 - exp(-along * 0.030);
  float trail = exp(-along * 0.0082);

  float trench = exp(-(lateral * lateral) / (width * width));
  float shoulderOffset = abs(lateral) - width * 1.55;
  float shoulders = exp(-(shoulderOffset * shoulderOffset) / (width * width * 1.8));
  float ripple = sin(along * 0.18) * exp(-along * 0.028) * 0.06;

  return (-trench * 0.96 + shoulders * 0.30 + ripple) * depth * build * trail;
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
  return (getwaves(worldPos * u_WaveFreq) - 0.5) * depth + wakeDisplacement(worldPos);
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

void main() {
  float depth = u_WaveDepth;
  vec2 worldXZ = v_worldPos.xz;

  vec3 ray = normalize(v_worldPos - u_cameraPosition);
  vec3 N = normal(worldXZ, 0.55, depth);

  N = mix(
    N,
    vec3(0.0, 1.0, 0.0),
    0.8 * min(1.0, sqrt(length(v_worldPos - u_cameraPosition) * 0.01) * 1.1)
  );

  float fresnel = 0.04 + (1.0 - 0.04) * pow(1.0 - max(0.0, dot(-N, ray)), 5.0);

  vec3 R = normalize(reflect(ray, N));
  R.y = abs(R.y);
  vec3 reflectionAnalytic = getAtmosphere(R) + getSun(R);
  vec2 screenUV = (v_projPos.xy / v_projPos.w) * 0.5 + 0.5;
  screenUV += N.xz * 0.020;
  screenUV = clamp(screenUV, 0.001, 0.999);
  vec3 reflectionRTT = texture2D(u_reflectionSampler, screenUV).rgb;
  vec3 reflection = mix(reflectionAnalytic, reflectionRTT, 0.80);

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
  float wakeFoam = smoothstep(0.22, 0.92, wakeT) * 0.40;
  color = mix(color, vec3(0.86, 0.92, 0.98), wakeFoam);

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
    // Layer 1: turquoise water column (shallowing water shifts from deep blue)
    float shallowF = smoothstep(0.05, 0.70, proximity);
    color = mix(color, vec3(0.10, 0.48, 0.50), shallowF * 0.50);
    // Layer 2: sandy/rocky seafloor visible through very shallow transparent water
    float seafloorF = smoothstep(0.60, 0.88, proximity);
    color = mix(color, vec3(0.62, 0.55, 0.40), seafloorF * 0.62);
    // Layer 3: animated foam breaking at the waterline
    float foamF = smoothstep(0.75, 0.95, proximity);
    float foamAnim = clamp(
        0.44
      + 0.38 * sin(worldXZ.x * 0.55 + u_Time * 1.3 + worldXZ.y * 0.25)
      + 0.28 * cos(worldXZ.y * 0.48 - u_Time * 0.9 + worldXZ.x * 0.18),
      0.0, 1.0);
    color = mix(color, vec3(0.92, 0.97, 1.00), foamF * foamAnim * 0.92);
  }

  vec4 outCol = vec4(aces_tonemap(color * 2.0), 1.0);
#ifdef WEBGPU
  fragmentColor = outCol;
#else
  gl_FragColor = outCol;
#endif
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
uniform u_WaveDepth: f32;
uniform u_WaveFreq: f32;
uniform u_BoatPos: vec2f;
uniform u_BoatDir: vec2f;
uniform u_BoatSpeed: f32;

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

fn wakeDisplacement(worldPos: vec2f) -> f32 {
  let rel = worldPos - uniforms.u_BoatPos;
  let along = dot(rel, -uniforms.u_BoatDir);
  if (along <= 0.0) {
    return 0.0;
  }

  let right = vec2f(-uniforms.u_BoatDir.y, uniforms.u_BoatDir.x);
  let lateral = dot(rel, right);

  let width = 4.8 + min(10.0, uniforms.u_BoatSpeed * 0.42);
  let depth = 0.36 + min(1.05, uniforms.u_BoatSpeed * 0.060);
  let build = 1.0 - exp(-along * 0.030);
  let trail = exp(-along * 0.0082);

  let trench = exp(-(lateral * lateral) / (width * width));
  let shoulderOffset = abs(lateral) - width * 1.55;
  let shoulders = exp(-(shoulderOffset * shoulderOffset) / (width * width * 1.8));

  let ripple = sin(along * 0.18) * exp(-along * 0.028) * 0.06;
  return (-trench * 0.96 + shoulders * 0.30 + ripple) * depth * build * trail;
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

  let d = max(abs(input.position.x), abs(input.position.z));
  let fade = uniforms.u_DisplaceScale * (1.0 - smoothstep(
    uniforms.u_MeshHalfSize * 0.80,
    uniforms.u_MeshHalfSize * 0.97,
    d
  ));

  var pos = input.position;

  if (fade > 0.001) {
    let wavePos = vec2f(wx, wz) * uniforms.u_WaveFreq;
    var h = (getwaves(wavePos) - 0.5) * uniforms.u_WaveDepth;
    h += wakeDisplacement(vec2f(wx, wz));
    pos.y += h * fade;
  }

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

varying v_worldPos: vec3f;
varying v_projPos: vec4f;
varying v_wakeMask: f32;

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

fn wakeDisplacement(worldPos: vec2f) -> f32 {
  let rel = worldPos - uniforms.u_BoatPos;
  let along = dot(rel, -uniforms.u_BoatDir);
  if (along <= 0.0) {
    return 0.0;
  }

  let right = vec2f(-uniforms.u_BoatDir.y, uniforms.u_BoatDir.x);
  let lateral = dot(rel, right);

  let width = 4.8 + min(10.0, uniforms.u_BoatSpeed * 0.42);
  let depth = 0.36 + min(1.05, uniforms.u_BoatSpeed * 0.060);
  let build = 1.0 - exp(-along * 0.030);
  let trail = exp(-along * 0.0082);

  let trench = exp(-(lateral * lateral) / (width * width));
  let shoulderOffset = abs(lateral) - width * 1.55;
  let shoulders = exp(-(shoulderOffset * shoulderOffset) / (width * width * 1.8));
  let ripple = sin(along * 0.18) * exp(-along * 0.028) * 0.06;

  return (-trench * 0.96 + shoulders * 0.30 + ripple) * depth * build * trail;
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
  return (getwaves(worldPos * uniforms.u_WaveFreq) - 0.5) * depth + wakeDisplacement(worldPos);
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

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let depth = uniforms.u_WaveDepth;
  let worldXZ = input.v_worldPos.xz;

  let ray = normalize(input.v_worldPos - uniforms.u_cameraPosition);
  var N = normal(worldXZ, 0.55, depth);

  N = mix(
    N,
    vec3f(0.0, 1.0, 0.0),
    vec3f(0.8 * min(1.0, sqrt(length(input.v_worldPos - uniforms.u_cameraPosition) * 0.01) * 1.1))
  );

  let fresnel = 0.04 + (1.0 - 0.04) * pow(1.0 - max(0.0, dot(-N, ray)), 5.0);

  var R = normalize(reflect(ray, N));
  R.y = abs(R.y);
  let reflectionAnalytic = getAtmosphere(R) + vec3f(getSun(R));
  var screenUV = (input.v_projPos.xy / input.v_projPos.w) * 0.5 + vec2f(0.5);
  screenUV += N.xz * 0.020;
  screenUV = clamp(screenUV, vec2f(0.001), vec2f(0.999));
  let reflectionRTT = textureSample(u_reflectionSampler, u_reflectionSamplerSampler, screenUV).rgb;
  // Cloud reflection (same logic as GLSL path above)
  var cloudReflection = mix(reflectionAnalytic, reflectionRTT, vec3f(0.80));
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
  let wakeFoam = smoothstep(0.22, 0.92, wakeT) * 0.40;
  color = mix(color, vec3f(0.86, 0.92, 0.98), vec3f(wakeFoam));

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
    // Layer 1: turquoise water column
    let shallowF = smoothstep(0.05, 0.70, proximity);
    color = mix(color, vec3f(0.10, 0.48, 0.50), vec3f(shallowF * 0.50));
    // Layer 2: sandy/rocky seafloor through very shallow transparent water
    let seafloorF = smoothstep(0.60, 0.88, proximity);
    color = mix(color, vec3f(0.62, 0.55, 0.40), vec3f(seafloorF * 0.62));
    // Layer 3: animated foam at the waterline
    let foamF = smoothstep(0.75, 0.95, proximity);
    let foamAnim = clamp(
        0.44
      + 0.38 * sin(worldXZ.x * 0.55 + uniforms.u_Time * 1.3 + worldXZ.y * 0.25)
      + 0.28 * cos(worldXZ.y * 0.48 - uniforms.u_Time * 0.9 + worldXZ.x * 0.18),
      0.0, 1.0);
    color = mix(color, vec3f(0.92, 0.97, 1.00), vec3f(foamF * foamAnim * 0.92));
  }

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


  private reflectionRTT!: MirrorTexture;
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
  }

  // ── Reflection RTT ────────────────────────────────────────────────────────

  private buildReflectionRTT(scene: Scene): void {
    // 1024 px gives crisp, close-up reflections; 512 looks blurry at hull range.
    this.reflectionRTT = new MirrorTexture('oceanReflection', 1024, scene, true);
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
    this.oceanMatFar = this.buildOceanMaterial(scene, 'oceanMatFar', 0.0, this.FAR_SIZE / 2, -1);
    this.oceanMeshFar.material = this.oceanMatFar;
  }

  private buildLod1(scene: Scene): void {
    this.oceanMesh1 = MeshBuilder.CreateGround('ocean_lod1', {
      width: this.LOD1_SIZE, height: this.LOD1_SIZE, subdivisions: this.LOD1_SUB,
    }, scene);
    this.oceanMesh1.renderingGroupId = 1;
    this.oceanMesh1.position.y       = 0.002;
    this.oceanMat1 = this.buildOceanMaterial(scene, 'oceanMat1', 1.0, this.LOD1_SIZE / 2, 1);
    this.oceanMesh1.material = this.oceanMat1;
  }

  private buildLod0(scene: Scene): void {
    this.oceanMesh0 = MeshBuilder.CreateGround('ocean_lod0', {
      width: this.LOD0_SIZE, height: this.LOD0_SIZE, subdivisions: this.LOD0_SUB,
    }, scene);
    this.oceanMesh0.renderingGroupId = 2;
    this.oceanMesh0.position.y       = 0.004;
    this.oceanMat0 = this.buildOceanMaterial(scene, 'oceanMat0', 1.0, this.LOD0_SIZE / 2, 2);
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
    this.oceanMatNear = this.buildOceanMaterial(scene, 'oceanMatNear', 1.0, this.NEAR_SIZE / 2, 2);
    this.oceanMeshNear.material = this.oceanMatNear;
  }

  // ── Ocean ShaderMaterial factory ──────────────────────────────────────────

  private buildOceanMaterial(
    scene:         Scene,
    name:          string,
    displaceScale: number,
    meshHalfSize:  number,
    maxCascade:    number,
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
          'u_WorldOffset', 'u_MeshHalfSize', 'u_DisplaceScale',
          'u_Time', 'u_WaveDepth', 'u_WaveFreq',
          'u_BoatPos', 'u_BoatDir', 'u_BoatSpeed',
          'u_cameraPosition',
          'u_terrainShadowCenter', 'u_terrainShadowSize', 'u_terrainShadowStrength',
          'u_shoreMapCenter', 'u_shoreMapSize',
          'u_cloudCoverage', 'u_sunElevation',
        ],
        samplers: ['u_reflectionSampler', 'u_terrainShadowMask', 'u_shoreMap'],
        needAlphaBlending: false,
        shaderLanguage: useWgsl ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      },
    );

    const waveDepth = (maxCascade >= 2 ? this.WAVE_DEPTH_NEAR : maxCascade >= 1 ? this.WAVE_DEPTH_MID : this.WAVE_DEPTH_FAR) * this.waveDepthScale;

    mat.setFloat('u_DisplaceScale', displaceScale);
    mat.setFloat('u_MeshHalfSize',  meshHalfSize);
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

      const allMats   = [this.oceanMatNear, this.oceanMat0, this.oceanMat1, this.oceanMatFar];
      const boatDir = new Vector2(Math.sin(this.boatHdgR), Math.cos(this.boatHdgR));
      const boatPos = new Vector2(this.boatX, this.boatZ);
      const boatSpeedAbs = Math.abs(this.boatSpeed) * 4.0;

      for (const mat of allMats) {
        mat.setFloat('u_Time', t);
        mat.setVector2('u_BoatPos', boatPos);
        mat.setVector2('u_BoatDir', boatDir);
        mat.setFloat('u_BoatSpeed', boatSpeedAbs);
        mat.setFloat('u_cloudCoverage', this._cloudCoverage);
        mat.setFloat('u_sunElevation',  this._sunElevation);
      }

    });
  }

  // ── Cloud reflection ──────────────────────────────────────────────────────
  private _cloudCoverage = 0;
  private _sunElevation  = 0;

  /** Call each frame from CloudService so the water mirrors current sky state. */
  setCloudReflection(coverage: number, sunElevation: number): void {
    this._cloudCoverage = coverage;
    this._sunElevation  = sunElevation;
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
  getVisualHeightAt(wx: number, wz: number, t: number): number {
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
    this.waveDepthScale = 0.95 + chop * 0.30 + windT * 0.22;

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

  getOceanMesh(): Mesh { return this.oceanMesh0; }
}
