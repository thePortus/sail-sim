import { Injectable, inject } from '@angular/core';
import {
  MeshBuilder, Vector2, Vector3, AbstractMesh, Mesh, ShaderMaterial, Scene,
  DirectionalLight, MirrorTexture, Plane,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { OceanFFTEngine } from './ocean-fft-engine.service';
import { SeaConditions, Wind } from '../models';

// ── Vertex shader ─────────────────────────────────────────────────────────────
//
// Procedural wave displacement (Babylon NME model — simplified for WebGPU).
//
// Three-component model:
//   1. 2D Voronoi F1 × 2  — organic swell crests drifting downwind
//   2. 3-octave value-noise fBm — medium-frequency chop
//   3. Directional sine swell   — primary long-wavelength swell
//
// Deliberately uses only:
//   • smoothNoise() — 1 helper (_h), simple trilinear value noise
//   • voronoi2D()   — 9-iteration 2D cellular noise
// Avoids the full Simplex3D + 3D-Voronoi (27 iterations) that overwhelmed
// Babylon's GLSL→WGSL transpiler.
//
// FFT normal textures are still sampled in the fragment shader for micro-detail.

const OCEAN_VERT = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 worldViewProjection;
uniform mat4 world;

uniform vec2  u_WorldOffset;
uniform float u_MeshHalfSize;
uniform float u_DisplaceScale;
uniform float u_DomainC0;
uniform float u_DomainC1;
uniform float u_DomainC2;
uniform float u_Time;
uniform vec2  u_Direction;    // normalised wind direction (XZ)
uniform float u_WindSpeed;    // m/s — scales all amplitudes

varying vec3  v_worldPos;
varying float v_waveHeight;   // raw metres, used for colour gradient + dFdx normals
varying vec2  v_uv_c0;
varying vec2  v_uv_c1;
varying vec2  v_uv_c2;
varying vec4  v_projPos;

// ── Value noise (3D trilinear, C1-smooth) ─────────────────────────────────────
// Single helper, no overloads, no vec3(vec2,float) constructors.
float _h(float ax, float ay, float az) {
  return fract(sin(ax * 127.1 + ay * 311.7 + az * 74.7) * 43758.5453);
}
float smoothNoise(float px, float py, float pz) {
  float ix = floor(px);  float fx = fract(px);  fx = fx*fx*(3.0-2.0*fx);
  float iy = floor(py);  float fy = fract(py);  fy = fy*fy*(3.0-2.0*fy);
  float iz = floor(pz);  float fz = fract(pz);  fz = fz*fz*(3.0-2.0*fz);
  return mix(
    mix(mix(_h(ix,   iy,   iz), _h(ix+1.0, iy,   iz  ), fx),
        mix(_h(ix,   iy+1.0,iz), _h(ix+1.0, iy+1.0,iz  ), fx), fy),
    mix(mix(_h(ix,   iy,   iz+1.0), _h(ix+1.0, iy,   iz+1.0), fx),
        mix(_h(ix,   iy+1.0,iz+1.0), _h(ix+1.0, iy+1.0,iz+1.0), fx), fy),
    fz) * 2.0 - 1.0;
}

// ── 2D Voronoi F1 ─────────────────────────────────────────────────────────────
// Cells drift in wind direction → simulates forward-travelling wave trains.
// 9 neighbour iterations (no vec4 operations, no sin of large values).
float voronoi2D(float px, float py, float jitter) {
  float ix = floor(px);  float fx = fract(px);
  float iy = floor(py);  float fy = fract(py);
  float d = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float cx  = float(i);  float cy = float(j);
      float rx  = fract(sin((ix+cx)*127.1 + (iy+cy)*311.7) * 43758.5453);
      float ry  = fract(sin((ix+cx)*269.5 + (iy+cy)*183.3) * 43758.5453);
      float dx  = cx + rx * jitter - fx;
      float dy  = cy + ry * jitter - fy;
      d = min(d, dx*dx + dy*dy);
    }
  }
  return sqrt(d);
}

// ── Composite wave height (Babylon NME model) ─────────────────────────────────
float waveHeight(float wx, float wz) {
  float ws = max(u_WindSpeed, 1.0);
  float t  = u_Time;
  float dx = u_Direction.x;
  float dz = u_Direction.y;   // y component of Direction is Z in world-space
  float cx = -dz;             // cross-wind direction
  float cz =  dx;

  // — Voronoi 1: primary downwind swell (~360 m cells) —
  float vs   = 0.0028;
  float vspd = 0.60;
  float vU1  = wx * vs + dx * t * vspd;
  float vV1  = wz * vs + dz * t * vspd;
  float v1   = voronoi2D(vU1, vV1, 0.85);
  float hV1  = max(0.0, 1.0 - v1 * 1.4) * ws * 0.090;

  // — Voronoi 2: cross-wind secondary swell (crossing seas) —
  float vU2  = wx * vs * 0.77 + (dx * 0.55 + cx * 0.45) * t * vspd * 0.68;
  float vV2  = wz * vs * 0.77 + (dz * 0.55 + cz * 0.45) * t * vspd * 0.68;
  float v2   = voronoi2D(vU2, vV2, 0.90);
  float hV2  = max(0.0, 1.0 - v2 * 1.4) * ws * 0.030;

  // — 3-octave value noise fBm (wind-drifted) —
  // Octave 4 omitted: at 3 m vertex spacing, its period (~20 m) is below
  // the 8-vertices-per-wavelength threshold for smooth appearance.
  float ps   = 0.0055;
  float pspd = 0.28;
  float drx  = dx * t * pspd;
  float drz  = dz * t * pspd;
  float n1   = smoothNoise(wx*ps         + drx,        wz*ps         + drz,        t*0.09);
  float n2   = smoothNoise(wx*ps*2.10    + drx*1.9,    wz*ps*2.10    + drz*1.9,    t*0.19) * 0.50;
  float n3   = smoothNoise(wx*ps*4.37    + drx*2.8,    wz*ps*4.37    + drz*2.8,    t*0.39) * 0.25;
  float hN   = (n1 + n2 + n3) * ws * 0.048;

  // — Directional sine swell —
  float swellLen = clamp(200.0 / ws, 25.0, 280.0);
  float swellH   = ws * 0.040;
  float hS       = sin((wx * dx + wz * dz) / swellLen - t * 0.70) * swellH;

  return hV1 + hV2 + hN + hS;
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

  // Per-cascade tiling UVs for FFT normal sampling in fragment shader.
  float u0 = fract(wx / u_DomainC0);  float v0 = fract(wz / u_DomainC0);
  float u1 = fract(wx / u_DomainC1);  float v1 = fract(wz / u_DomainC1);
  float u2 = fract(wx / u_DomainC2);  float v2 = fract(wz / u_DomainC2);

  vec3  pos = position;
  float h   = 0.0;

  if (fade > 0.001) {
    h      = waveHeight(wx, wz);
    pos.y += h * fade;
  }

  v_worldPos   = (world * vec4(pos, 1.0)).xyz;
  v_waveHeight = h;
  v_uv_c0      = vec2(u0, v0);
  v_uv_c1      = vec2(u1, v1);
  v_uv_c2      = vec2(u2, v2);
  gl_Position  = worldViewProjection * vec4(pos, 1.0);
  v_projPos    = gl_Position;
}
`;

// ── Fragment shader ───────────────────────────────────────────────────────────
//
// Lighting pipeline:
//   1. FFT cascade normals  — micro-detail ripple from compute textures
//   2. Macro normals        — dFdx/dFdy(v_waveHeight) matches actual geometry
//   3. NME colour gradient  — trough navy → mid ocean blue → cyan crest
//   4. Schlick Fresnel      — F0 = 0.020 (water n ≈ 1.33)
//   5. SSS back-scatter     — teal glow through wave crests
//   6. GGX specular         — tight lobe (r=0.028), properly BRDF-normalised
//   7. RTT reflection       — screen-space mirror + analytical sky fallback
//   8. Height-threshold foam + Beaufort whitecaps
//   9. Horizon haze

const OCEAN_FRAG = `
precision highp float;

uniform float     u_Time;
uniform float     u_choppiness;
uniform float     u_DisplaceScale;
uniform float     u_Beaufort;
uniform float     u_MaxCascade;
uniform float     u_WindSpeed;
uniform vec3      u_cameraPosition;
uniform vec3      u_sunDir;
uniform vec3      u_sunColor;
uniform vec3      u_skyColorA;
uniform vec3      u_skyColorB;
uniform sampler2D u_norm0;
uniform sampler2D u_norm1;
uniform sampler2D u_norm2;
uniform sampler2D u_reflectionSampler;

varying vec3  v_worldPos;
varying float v_waveHeight;
varying vec2  v_uv_c0;
varying vec2  v_uv_c1;
varying vec2  v_uv_c2;
varying vec4  v_projPos;

float ggx(float NdotH, float rough) {
  float a  = rough * rough;
  float a2 = a * a;
  float d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d + 1e-7);
}

void main() {
  vec3  V    = normalize(u_cameraPosition - v_worldPos);
  vec3  L    = normalize(u_sunDir);
  float dist = length(u_cameraPosition - v_worldPos);

  // ── Micro-detail normals from FFT cascade textures ────────────────────────
  // sampler2D may not be passed as a function argument in Vulkan GLSL — inlined.
  vec2  _nxz0 = texture2D(u_norm0, v_uv_c0).xy;
  vec3  N     = normalize(vec3(_nxz0.x, sqrt(max(0.0, 1.0 - dot(_nxz0, _nxz0))), _nxz0.y));

  if (u_MaxCascade >= 1.0) {
    float w1    = 1.0 - smoothstep(800.0, 2000.0, dist);
    vec2  _nxz1 = texture2D(u_norm1, v_uv_c1).xy;
    vec3  _sn1  = normalize(vec3(_nxz1.x, sqrt(max(0.0, 1.0 - dot(_nxz1, _nxz1))), _nxz1.y));
    N = normalize(N + _sn1 * w1);
  }
  if (u_MaxCascade >= 2.0) {
    float w2    = 1.0 - smoothstep(200.0, 600.0, dist);
    vec2  _nxz2 = texture2D(u_norm2, v_uv_c2).xy;
    vec3  _sn2  = normalize(vec3(_nxz2.x, sqrt(max(0.0, 1.0 - dot(_nxz2, _nxz2))), _nxz2.y));
    N = normalize(N + _sn2 * w2);
  }

  // ── Macro wave normals from procedural wave slope ─────────────────────────
  // dFdx/dFdy of the interpolated v_waveHeight gives the surface tilt that
  // matches actual vertex geometry — GGX glints will land on the correct face.
  // u_choppiness scales how sharply the large-scale waves tilt under lighting.
  {
    float dhx      = dFdx(v_waveHeight);
    float dhz      = dFdy(v_waveHeight);
    float macroStr = clamp(1.0 - dist / 3000.0, 0.0, 1.0);
    float amp      = 3.5 + macroStr * 2.0 + u_choppiness * 2.0;
    vec3  waveN    = normalize(vec3(-dhx * amp, 1.0, -dhz * amp));
    N = normalize(N + waveN * (0.8 + macroStr * 1.4));
  }

  vec3  H     = normalize(L + V);
  float NdotL = max(dot(N, L), 0.0);
  float NdotH = max(dot(N, H), 0.0);

  // ── Schlick Fresnel (F0=0.020, water n≈1.33) ──────────────────────────────
  float cosV   = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = 0.020 + 0.980 * pow(1.0 - cosV, 5.0);

  // ── NME height-gradient colour (trough → crest) ───────────────────────────
  // hNorm: 0 = mean trough, 1 = crest peak (scaled by wind amplitude).
  float wamp  = max(u_WindSpeed * 0.16, 0.5);
  float hNorm = clamp((v_waveHeight + wamp) / (wamp * 2.0), 0.0, 1.0);

  vec3 deepCol  = vec3(0.020, 0.212, 0.329);   // deep navy
  vec3 midCol   = vec3(0.090, 0.376, 0.494);   // ocean blue
  vec3 crestCol = vec3(0.655, 0.906, 0.976);   // cyan crest

  vec3 waterBody = hNorm < 0.5
    ? mix(deepCol,  midCol,   hNorm * 2.0)
    : mix(midCol,   crestCol, (hNorm - 0.5) * 2.0);
  waterBody *= (1.0 - fresnel) * 0.85 + 0.15;

  // ── Ambient sky fill ──────────────────────────────────────────────────────
  float upFace = N.y * 0.5 + 0.5;
  vec3  ambient = mix(u_skyColorB, u_skyColorA, upFace) * 0.12;

  // ── Diffuse ───────────────────────────────────────────────────────────────
  vec3 diffuse = waterBody * u_sunColor * NdotL * 0.22;

  // ── SSS crest back-scatter ("green glass through wave") ───────────────────
  float crestSignal = smoothstep(0.62, 1.0, hNorm);
  float backLit     = max(dot(-L, N), 0.0) * crestSignal;
  float viewThru    = max(dot(V, -L), 0.0);
  float sssStr      = backLit * (0.45 + viewThru * 0.55);
  vec3  sssGlow     = vec3(0.06, 0.42, 0.26) * u_sunColor * sssStr * 0.70;

  // ── GGX specular (BRDF-normalised, tight lobe r=0.028) ───────────────────
  // Dividing by 4·NdotV·NdotL keeps the peak physically bounded (no blobs).
  float NdotV_s = max(dot(N, V), 0.05);
  float D       = ggx(NdotH, 0.028) * NdotL;
  float brdf    = D / (4.0 * NdotV_s * max(NdotL, 0.001) + 0.001);
  vec3  specular = u_sunColor * brdf * (fresnel * 1.4 + 0.04) * 1.6;

  // ── Sky reflection fallback ───────────────────────────────────────────────
  vec3  R    = reflect(-V, N);
  float skyT = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
  vec3  skyR = mix(u_skyColorB, u_skyColorA, skyT);

  // ── RTT screen-space reflection ───────────────────────────────────────────
  vec2 screenUV = (v_projPos.xy / v_projPos.w) * 0.5 + 0.5;
  screenUV.y    = 1.0 - screenUV.y;
  screenUV     += N.xz * 0.028;
  screenUV      = clamp(screenUV, 0.001, 0.999);
  vec3 rttRefl  = texture2D(u_reflectionSampler, screenUV).rgb;
  vec3 refl     = mix(skyR, rttRefl, 0.80);

  // ── Combine — Fresnel drives reflection vs. refracted water ───────────────
  vec3 waterColor = mix(ambient + diffuse + sssGlow, refl, max(fresnel, 0.06)) + specular;

  // ── Foam (height-threshold + Beaufort whitecaps) ──────────────────────────
  float jacFoam = smoothstep(0.72, 1.0, hNorm) * u_DisplaceScale;
  float bftT    = clamp((u_Beaufort - 4.0) / 6.0, 0.0, 1.0);
  float ambFoam = bftT * bftT * clamp(N.y, 0.0, 1.0) * 0.18;
  float foamMask = clamp(jacFoam + ambFoam, 0.0, 1.0);
  waterColor = mix(waterColor, vec3(0.94, 0.97, 1.00), foamMask * 0.88);

  // ── Horizon haze ──────────────────────────────────────────────────────────
  float fogT = clamp((dist - 3000.0) / 9000.0, 0.0, 1.0);
  fogT = fogT * fogT;
  vec3  fogColor = mix(u_skyColorA * 0.9, u_skyColorB * 1.1, 0.55);
  waterColor = mix(waterColor, fogColor, fogT * 0.88);

  gl_FragColor = vec4(waterColor, 1.0);
}
`;

// ── Kelvin wake shaders (unchanged) ──────────────────────────────────────────
const WAKE_VERT = `
precision highp float;
attribute vec3 position; attribute vec2 uv;
varying vec2 vUV;
uniform mat4 worldViewProjection;
void main(){ vUV = uv; gl_Position = worldViewProjection * vec4(position, 1.0); }
`;

const WAKE_FRAG = `
precision highp float;
varying vec2 vUV;
uniform float time; uniform float speed; uniform float planeW; uniform float planeL;
void main(){
  float lx = (vUV.x - 0.5) * planeW;
  float lz = (1.0 - vUV.y) * planeL;
  if (lz < 1.0) { gl_FragColor = vec4(0.0); return; }
  float kelvinArm  = abs(lx) - lz * 0.354;
  float lengthFade = exp(-lz * 0.0045);
  float armFoam    = exp(-kelvinArm * kelvinArm * 0.016) * lengthFade;
  float tPhase  = lz * 0.09 - time * 1.7;
  float trans   = (sin(tPhase) * 0.5 + 0.5) * exp(-lz * 0.006) * exp(-lx * lx * 0.0005);
  float dPhase  = kelvinArm * 0.13 - time * 1.1;
  float diverg  = (sin(dPhase) * 0.5 + 0.5) * armFoam;
  float r       = sqrt(lx * lx + lz * lz);
  float centre  = exp(-r * 0.035) * (1.0 - exp(-r * 0.22)) * exp(-lx * lx * 0.07);
  float foam    = clamp(armFoam * 0.52 + trans * 0.20 + diverg * 0.12 + centre * 0.36, 0.0, 1.0) * speed;
  gl_FragColor  = vec4(1.0, 1.0, 1.0, foam * 0.80);
}
`;

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class OceanService {
  private sceneService = inject(SceneService);
  private fftEngine    = inject(OceanFFTEngine);

  private oceanMeshNear!: Mesh;          // ultra-close LOD centered on boat
  private oceanMesh0!:   Mesh;
  private oceanMesh1!:   Mesh;
  private oceanMeshFar!: Mesh;
  private oceanMatNear!: ShaderMaterial;
  private oceanMat0!:    ShaderMaterial;
  private oceanMat1!:    ShaderMaterial;
  private oceanMatFar!:  ShaderMaterial;

  private wakePlane!: Mesh;
  private wakeMat!:   ShaderMaterial;

  private reflectionRTT!: MirrorTexture;

  private elapsed    = 0;
  private boatX      = 0;
  private boatZ      = 0;
  private boatHdgR   = 0;
  private boatSpeed  = 0;

  // Wind state — updated by updateWeather(), used for per-frame uniform upload.
  private windSpeed = 8.0;
  private windDirX  = 0.0;
  private windDirZ  = 1.0;

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

  private readonly WAKE_W      = 180;
  private readonly WAKE_L      = 320;
  private readonly BOAT_HALF_L =   7.0;

  // ── Init ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.fftEngine.init();

    const { scene } = this.sceneService;
    this.buildReflectionRTT(scene);
    this.buildLodFar(scene);
    this.buildLod1(scene);
    this.buildLod0(scene);
    this.buildLodNear(scene);
    this.buildWakePlane(scene);
    this.registerRenderLoop(scene);
  }

  // ── Reflection RTT ────────────────────────────────────────────────────────

  private buildReflectionRTT(scene: Scene): void {
    this.reflectionRTT = new MirrorTexture('oceanReflection', 512, scene, true);
    this.reflectionRTT.mirrorPlane = new Plane(0, -1, 0, 0);
    this.reflectionRTT.renderList  = [];

    const skybox = scene.getMeshByName('skybox');
    if (skybox) this.reflectionRTT.renderList.push(skybox);
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
    const mat = new ShaderMaterial(name, scene,
      { vertexSource: OCEAN_VERT, fragmentSource: OCEAN_FRAG },
      {
        attributes: ['position', 'uv'],
        uniforms: [
          'world', 'worldViewProjection',
          'u_WorldOffset', 'u_MeshHalfSize', 'u_DisplaceScale', 'u_MaxCascade',
          'u_DomainC0', 'u_DomainC1', 'u_DomainC2',
          'u_Time', 'u_choppiness', 'u_Beaufort',
          'u_Direction', 'u_WindSpeed',
          'u_cameraPosition',
          'u_sunDir', 'u_sunColor', 'u_skyColorA', 'u_skyColorB',
        ],
        samplers: [
          // FFT normals only — procedural vertex displacement no longer reads disp textures.
          'u_norm0', 'u_norm1', 'u_norm2',
          'u_reflectionSampler',
        ],
        needAlphaBlending: false,
      },
    );

    mat.setFloat('u_DisplaceScale', displaceScale);
    mat.setFloat('u_MeshHalfSize',  meshHalfSize);
    mat.setFloat('u_MaxCascade',    maxCascade);
    mat.setFloat('u_DomainC0', this.fftEngine.getDomain(0));
    mat.setFloat('u_DomainC1', this.fftEngine.getDomain(1));
    mat.setFloat('u_DomainC2', this.fftEngine.getDomain(2));

    mat.setFloat('u_choppiness', 0.40);
    mat.setFloat('u_Beaufort',    1.0);
    mat.setFloat('u_WindSpeed',   this.windSpeed);
    mat.setVector2('u_Direction', new Vector2(this.windDirX, this.windDirZ));

    mat.setVector3('u_sunDir',    new Vector3(0.5, 0.85, 0.2).normalize());
    mat.setVector3('u_sunColor',  new Vector3(1.00, 0.95, 0.80));
    mat.setVector3('u_skyColorA', new Vector3(0.22, 0.48, 0.72));
    mat.setVector3('u_skyColorB', new Vector3(0.08, 0.28, 0.58));

    mat.setFloat('u_Time', 0);
    mat.setVector3('u_cameraPosition', Vector3.Zero());
    mat.setVector2('u_WorldOffset',    new Vector2(0, 0));

    mat.setTexture('u_reflectionSampler', this.reflectionRTT);
    this.uploadFFTTextures(mat);

    return mat;
  }

  // ── Upload FFT normal textures ────────────────────────────────────────────

  private uploadFFTTextures(mat: ShaderMaterial): void {
    mat.setTexture('u_norm0', this.fftEngine.getNormalsTex(0));
    mat.setTexture('u_norm1', this.fftEngine.getNormalsTex(1));
    mat.setTexture('u_norm2', this.fftEngine.getNormalsTex(2));
  }

  // ── Kelvin wake plane ──────────────────────────────────────────────────────

  private buildWakePlane(scene: Scene): void {
    this.wakePlane = MeshBuilder.CreateGround('wakePlane', {
      width: this.WAKE_W, height: this.WAKE_L, subdivisions: 1,
    }, scene);
    this.wakePlane.isPickable    = false;
    this.wakePlane.renderingGroupId = 2;

    this.wakeMat = new ShaderMaterial('wakeMat', scene,
      { vertexSource: WAKE_VERT, fragmentSource: WAKE_FRAG },
      {
        attributes: ['position', 'uv'],
        uniforms:   ['worldViewProjection', 'time', 'speed', 'planeW', 'planeL'],
        needAlphaBlending: true,
      },
    );
    this.wakeMat.setFloat('planeW', this.WAKE_W);
    this.wakeMat.setFloat('planeL', this.WAKE_L);
    this.wakeMat.setFloat('time',   0);
    this.wakeMat.setFloat('speed',  0);
    this.wakeMat.backFaceCulling = false;
    this.wakePlane.material = this.wakeMat;
  }

  // ── Per-frame render loop ──────────────────────────────────────────────────

  private registerRenderLoop(scene: Scene): void {
    scene.registerBeforeRender(() => {
      const dt = scene.getEngine().getDeltaTime() * 0.001;
      this.elapsed += dt;

      this.fftEngine.tick(dt);

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

      const beaufortV = this.fftEngine.beaufort;
      const windDir   = new Vector2(this.windDirX, this.windDirZ);
      const allMats   = [this.oceanMatNear, this.oceanMat0, this.oceanMat1, this.oceanMatFar];

      for (const mat of allMats) {
        mat.setFloat('u_Time',      t);
        mat.setFloat('u_Beaufort',  beaufortV);
        mat.setFloat('u_WindSpeed', this.windSpeed);
        mat.setVector2('u_Direction', windDir);
      }

      const dl = scene.lights.find(l => l instanceof DirectionalLight) as DirectionalLight | undefined;
      if (dl) {
        const sunDir = dl.direction.negate().normalize();
        const sunCol = new Vector3(dl.diffuse.r, dl.diffuse.g, dl.diffuse.b);
        const elev   = Math.max(0, sunDir.y);
        const skyA   = new Vector3(0.18 + elev * 0.48, 0.36 + elev * 0.38, 0.76 + elev * 0.22);
        const skyB   = new Vector3(0.06 + elev * 0.22, 0.18 + elev * 0.26, 0.58 + elev * 0.26);
        for (const mat of allMats) {
          mat.setVector3('u_sunDir',    sunDir);
          mat.setVector3('u_sunColor',  sunCol);
          mat.setVector3('u_skyColorA', skyA);
          mat.setVector3('u_skyColorB', skyB);
        }
      }

      this.wakeMat.setFloat('time',  t);
      this.wakeMat.setFloat('speed', Math.min(1, Math.abs(this.boatSpeed) / 8));
      const shift = this.WAKE_L / 2 - this.BOAT_HALF_L;
      this.wakePlane.position.x = this.boatX - Math.sin(this.boatHdgR) * shift;
      this.wakePlane.position.z = this.boatZ - Math.cos(this.boatHdgR) * shift;
      this.wakePlane.rotation.y = this.boatHdgR;
      this.wakePlane.position.y = this.fftEngine.getHeightAt(this.boatX, this.boatZ, t) + 0.12;
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  getWaveHeightAt(wx: number, wz: number, t: number): number {
    return this.fftEngine.getHeightAt(wx, wz, t);
  }

  setBoatTransform(x: number, z: number, hdgRad: number, speed: number): void {
    this.boatX     = x;
    this.boatZ     = z;
    this.boatHdgR  = hdgRad;
    this.boatSpeed = speed;
  }

  updateWeather(wind: Wind, sea: SeaConditions): void {
    this.fftEngine.updateWeather(wind, sea);

    this.windSpeed = wind.speed;
    const hdgRad   = wind.fromBearingDeg * Math.PI / 180;
    this.windDirX  = Math.sin(hdgRad);
    this.windDirZ  = Math.cos(hdgRad);

    const chop = sea.choppiness;
    for (const mat of [this.oceanMatNear, this.oceanMat0, this.oceanMat1, this.oceanMatFar]) {
      if (mat) mat.setFloat('u_choppiness', chop);
    }
  }

  addToRenderList(mesh: AbstractMesh): void {
    this.reflectionRTT?.renderList?.push(mesh);
  }

  getOceanMesh(): Mesh { return this.oceanMesh0; }
}
