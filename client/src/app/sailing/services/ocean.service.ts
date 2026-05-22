import { Injectable, inject } from '@angular/core';
import {
  MeshBuilder, Vector3, Mesh, ShaderMaterial, Scene,
  DefaultRenderingPipeline, DirectionalLight,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { SeaConditions, Wind } from '../models';

// ── Vertex shader ─────────────────────────────────────────────────────────────
// Flat pass-through — all wave detail is computed analytically in the fragment
// shader via fBm gradient normals.  No vertex displacement means no periodic
// shadow bands or sine-wave stripe artefacts.
const OCEAN_VERT = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 worldViewProjection;
uniform mat4 world;

varying vec3 v_worldPos;
varying vec2 v_uv;

void main() {
    v_uv       = uv;
    v_worldPos = (world * vec4(position, 1.0)).xyz;
    gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

// ── Fragment shader ───────────────────────────────────────────────────────────
// Normal generation: 5-octave analytical fBm value-noise gradients.
//   • Each octave scrolls in a unique compass direction at a unique speed so
//     no two octaves share phase → non-repeating surface detail at any angle.
//   • Non-integer lacunarity (2.07) prevents frequency-resonance moiré stripes.
//   • Distance fade decays normals to (0,1,0) beyond 18 km, eliminating the
//     Gerstner phase-aliasing that renders distant ocean as solid-blue patches.
// Lighting: Fresnel (F0 = 0.02, IOR 1.33) + narrow GGX specular.  Specular is
// intentionally > 1 so post-process bloom turns it into wide sparkle.
// Foam: 3-layer procedural value-noise — no external textures required.
const OCEAN_FRAG = `
precision highp float;

uniform float u_Time;
uniform float u_speed;
uniform float u_choppiness;
uniform vec3  u_cameraPosition;
uniform vec3  u_sunDir;
uniform vec3  u_sunColor;
uniform vec3  u_skyColorA;
uniform vec3  u_skyColorB;
uniform float u_FoamSpeed;

varying vec3 v_worldPos;
varying vec2 v_uv;

// ── Hash — uniform pseudo-random scalar in [0,1] ──────────────────────────────
float hashF(vec2 p) {
    p  = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 43.21);
    return fract(p.x * p.y);
}

// ── Value noise with analytical gradient ─────────────────────────────────────
// Returns vec3(dv/dp.x, dv/dp.y, v) with v in [0,1].
// Gradient is the exact analytical derivative of the smoothstep-interpolated
// bilinear hash — no finite differences, no aliasing.
vec3 valueNoiseD(vec2 p) {
    vec2 i  = floor(p);
    vec2 f  = fract(p);
    vec2 u  = f * f * (3.0 - 2.0 * f);      // smoothstep kernel
    vec2 du = 6.0 * f * (1.0 - f);           // d(kernel)/df

    float a    = hashF(i);
    float b    = hashF(i + vec2(1.0, 0.0));
    float c    = hashF(i + vec2(0.0, 1.0));
    float d    = hashF(i + vec2(1.0, 1.0));
    float abcd = a - b - c + d;

    return vec3(
        du.x * (b - a + abcd * u.y),                    // dv/dp.x
        du.y * (c - a + abcd * u.x),                    // dv/dp.y
        a + (b - a)*u.x + (c - a)*u.y + abcd*u.x*u.y   // value
    );
}

// ── GGX microfacet distribution (normalised) ─────────────────────────────────
float ggxD(float NdotH, float roughness) {
    float a2 = roughness * roughness * roughness * roughness;
    float d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / (3.14159265 * d * d + 1e-6);
}

void main() {
    vec3  viewDir = normalize(u_cameraPosition - v_worldPos);
    float camDist = length(u_cameraPosition - v_worldPos);
    vec2  wx      = v_worldPos.xz;

    // ── Distance-based normal fade ────────────────────────────────────────────
    // Quadratic rolloff: full normals near camera → flat at 18 km.
    // This replaces the aliased Gerstner phase-cancellation that produced
    // solid-blue patches at large world-position values.
    float distAmp   = clamp(1.0 - camDist / 18000.0, 0.0, 1.0);
    distAmp         = distAmp * distAmp;
    float normalStr = (0.30 + u_choppiness * 1.20) * distAmp;

    // ── Analytical fBm gradient normals — 5 octaves ───────────────────────────
    // Frequencies: 1, 2.07, 4.28, 8.87, 18.36  (geometric, ratio 2.07)
    // Wavelengths: ~1100, ~530, ~257, ~124, ~60 m   (BASE = 0.00091)
    // Each octave has a unique scroll direction and a unique phase speed.
    // Scroll time-scale: u_speed = 0.38 → ~3.3 m/s apparent celerity.
    float t = u_Time * u_speed * 0.008;

    vec3 nd0 = valueNoiseD(wx * 1.000  * 0.00091 + vec2( 0.600,  0.800) * t * 1.000);
    vec3 nd1 = valueNoiseD(wx * 2.070  * 0.00091 + vec2(-0.800,  0.600) * t * 1.280);
    vec3 nd2 = valueNoiseD(wx * 4.285  * 0.00091 + vec2( 0.300, -0.954) * t * 1.620);
    vec3 nd3 = valueNoiseD(wx * 8.870  * 0.00091 + vec2(-0.707, -0.707) * t * 2.060);
    vec3 nd4 = valueNoiseD(wx * 18.360 * 0.00091 + vec2( 0.924, -0.383) * t * 2.570);

    // Amplitude: geometric series, gain = 0.5.
    // Gradient does NOT scale with frequency — keeps swell-face shapes smooth
    // rather than dominated by the highest, noisiest octave.
    float gx   = nd0.x*1.000 + nd1.x*0.500 + nd2.x*0.250 + nd3.x*0.125 + nd4.x*0.0625;
    float gy   = nd0.y*1.000 + nd1.y*0.500 + nd2.y*0.250 + nd3.y*0.125 + nd4.y*0.0625;
    float hsum = nd0.z*1.000 + nd1.z*0.500 + nd2.z*0.250 + nd3.z*0.125 + nd4.z*0.0625;
    float invA = 1.0 / 1.9375;
    gx   *= invA;
    gy   *= invA;
    hsum *= invA;   // 0..1 — used as height proxy for colour and foam

    // World-space normal (Y is vertical in BabylonJS).
    // Surface slope (gx, gy) → N = normalize(-gx, 1, -gy) scaled by normalStr.
    vec3 normalW = normalize(vec3(-gx * normalStr, 1.0, -gy * normalStr));

    // ── Ocean colour — deep navy to rich teal ─────────────────────────────────
    float hp       = clamp(hsum * 0.80 + 0.10, 0.0, 1.0);
    vec3 deepColor = vec3(0.006, 0.090, 0.200);
    vec3 midColor  = vec3(0.015, 0.180, 0.340);
    vec3 oceanColor = mix(deepColor, midColor, hp);

    // ── Lighting ──────────────────────────────────────────────────────────────
    float NdotV = max(0.001, dot(normalW, viewDir));
    float NdotL = max(0.0,   dot(normalW, u_sunDir));
    vec3  halfV = normalize(u_sunDir + viewDir);
    float NdotH = max(0.0,   dot(normalW, halfV));

    // Fresnel — water F0 = 0.02 (IOR 1.33)
    float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
    fresnel = clamp(fresnel, 0.0, 0.95);

    // Sky colour along the reflection vector
    vec3  reflDir = reflect(-viewDir, normalW);
    float skyT    = clamp(reflDir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3  skyRefl = mix(u_skyColorA, u_skyColorB, skyT);

    // Ambient + diffuse
    vec3 ambient = oceanColor * u_skyColorA * 0.22;
    vec3 diffuse = oceanColor * u_sunColor  * NdotL * 0.55;

    // GGX specular — values > 1 rely on post-process bloom for wide sparkle
    float roughness = 0.018 + u_choppiness * 0.068;
    float D         = ggxD(NdotH, roughness);
    vec3  specular  = u_sunColor * D * fresnel * 1.8;

    // ── Compose ───────────────────────────────────────────────────────────────
    vec3 waterColor = mix(ambient + diffuse, skyRefl, fresnel) + specular;

    // ── Procedural foam — 3-layer value noise ─────────────────────────────────
    // Foam concentrates on crests (hsum → 1) and dissolves in troughs.
    float ft  = u_Time * u_FoamSpeed * 0.10;   // ×0.10 → ~2.8 m/s drift
    vec2  fb  = wx * 0.0050;
    float fm0 = valueNoiseD(fb * 1.00 + vec2( ft * 0.70,  ft * 0.30)).z;
    float fm1 = valueNoiseD(fb * 1.80 + vec2(-ft * 0.45,  ft * 0.60)).z;
    float fm2 = valueNoiseD(fb * 3.30 + vec2( ft * 0.50, -ft * 0.55)).z;
    float rawFoam   = fm0 * 0.50 + fm1 * 0.30 + fm2 * 0.20;
    float crestMask = smoothstep(0.60, 0.90, hsum);
    float foamMask  = clamp(rawFoam * (crestMask + 0.03*(1.0 + u_choppiness)), 0.0, 1.0);

    waterColor = mix(waterColor, vec3(0.94, 0.97, 1.00), foamMask * 0.90);

    gl_FragColor = vec4(waterColor, 1.0);
}
`;

// ── Kelvin wake (unchanged) ───────────────────────────────────────────────────
const WAKE_VERT = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUV;
uniform mat4 worldViewProjection;
void main(){ vUV=uv; gl_Position=worldViewProjection*vec4(position,1.0); }
`;

const WAKE_FRAG = `
precision highp float;
varying vec2 vUV;
uniform float time; uniform float speed; uniform float planeW; uniform float planeL;
void main(){
    float lx=(vUV.x-0.5)*planeW; float lz=(1.0-vUV.y)*planeL;
    if(lz<1.0){gl_FragColor=vec4(0.0);return;}
    float kelvinArm=abs(lx)-lz*0.354;
    float lengthFade=exp(-lz*0.0045);
    float armFoam=exp(-kelvinArm*kelvinArm*0.016)*lengthFade;
    float tPhase=lz*0.09-time*1.7;
    float trans=(sin(tPhase)*0.5+0.5)*exp(-lz*0.006)*exp(-lx*lx*0.0005);
    float dPhase=kelvinArm*0.13-time*1.1;
    float diverg=(sin(dPhase)*0.5+0.5)*armFoam;
    float r=sqrt(lx*lx+lz*lz);
    float centre=exp(-r*0.035)*(1.0-exp(-r*0.22))*exp(-lx*lx*0.07);
    float foam=clamp(armFoam*0.52+trans*0.20+diverg*0.12+centre*0.36,0.0,1.0)*speed;
    gl_FragColor=vec4(1.0,1.0,1.0,foam*0.80);
}
`;

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class OceanService {
  private sceneService = inject(SceneService);

  private oceanMesh!: Mesh;
  private oceanMat!:  ShaderMaterial;
  private wakePlane!: Mesh;
  private wakeMat!:   ShaderMaterial;

  private elapsed   = 0;
  private boatX     = 0;
  private boatZ     = 0;
  private boatHdgR  = 0;
  private boatSpeed = 0;

  private readonly OCEAN_SIZE  = 200_000;
  private readonly WAKE_W      = 180;
  private readonly WAKE_L      = 320;
  private readonly BOAT_HALF_L =   7.0;

  init(): void {
    const { scene } = this.sceneService;
    this.buildOceanMesh(scene);
    this.buildOceanMaterial(scene);
    this.buildWakePlane(scene);
    this.registerRenderLoop(scene);
    this.setupPostProcessing(scene);
  }

  // ── Ground mesh ────────────────────────────────────────────────────────────
  // Flat plane — no vertex displacement.  256 subdivisions retained for smooth
  // horizon edge interpolation; subdivision density is irrelevant to wave
  // appearance since all detail is computed per-fragment.

  private buildOceanMesh(scene: Scene): void {
    this.oceanMesh = MeshBuilder.CreateGround('ocean', {
      width:        this.OCEAN_SIZE,
      height:       this.OCEAN_SIZE,
      subdivisions: 256,
    }, scene);
  }

  // ── Ocean ShaderMaterial ────────────────────────────────────────────────────

  private buildOceanMaterial(scene: Scene): void {
    this.oceanMat = new ShaderMaterial('oceanNME', scene,
      { vertexSource: OCEAN_VERT, fragmentSource: OCEAN_FRAG },
      {
        attributes: ['position', 'uv'],   // 'normal' not needed: flat plane + analytic normals
        uniforms: [
          'world', 'worldViewProjection',
          'u_Time', 'u_cameraPosition',
          'u_speed', 'u_choppiness', 'u_FoamSpeed',
          'u_sunDir', 'u_sunColor', 'u_skyColorA', 'u_skyColorB',
        ],
        needAlphaBlending: false,
      },
    );

    // Wave motion
    this.oceanMat.setFloat('u_speed',      0.38);   // scroll speed → ~3.3 m/s primary swell
    this.oceanMat.setFloat('u_choppiness', 0.20);   // 0 = glassy, 1 = rough sea
    this.oceanMat.setFloat('u_FoamSpeed',  0.20);   // whitecap drift speed

    // Lighting defaults (noon sun, tropical palette)
    this.oceanMat.setVector3('u_sunDir',    new Vector3(0.5, 0.85, 0.2).normalize());
    this.oceanMat.setVector3('u_sunColor',  new Vector3(1.00, 0.95, 0.80));
    // Rich, saturated sky tones — prevents Fresnel reflection looking grey
    this.oceanMat.setVector3('u_skyColorA', new Vector3(0.22, 0.48, 0.72)); // horizon
    this.oceanMat.setVector3('u_skyColorB', new Vector3(0.08, 0.28, 0.58)); // zenith

    // Per-frame uniforms (updated every tick in registerRenderLoop)
    this.oceanMat.setFloat('u_Time', 0);
    this.oceanMat.setVector3('u_cameraPosition', Vector3.Zero());

    this.oceanMesh.material = this.oceanMat;
  }

  // ── Post-processing pipeline ───────────────────────────────────────────────
  // Matches the playground's DefaultRenderingPipeline:
  //   bloom  — hot GGX specular pixels radiate into wide sparkle
  //   grain  — prevents the plastic "too perfect" look
  //   CA     — subtle lens character
  //   sharpen — pops fine-ripple detail

  private setupPostProcessing(scene: Scene): void {
    scene.onAfterRenderObservable.addOnce(() => {
      const camera = scene.activeCamera;
      if (!camera) return;
      try {
        const pipeline = new DefaultRenderingPipeline(
          'oceanPipeline', false, scene, [camera],
        );
        pipeline.bloomEnabled   = true;
        pipeline.bloomThreshold = 0.25;
        pipeline.bloomKernel    = 64;
        pipeline.bloomScale     = 0.50;
        pipeline.bloomWeight    = 0.18;

        pipeline.grainEnabled       = true;
        pipeline.grain.intensity    = 7;
        pipeline.grain.animated     = true;

        pipeline.chromaticAberrationEnabled           = true;
        pipeline.chromaticAberration.aberrationAmount = 14;
        pipeline.chromaticAberration.radialIntensity  = 1.5;

        pipeline.sharpenEnabled       = true;
        pipeline.sharpen.edgeAmount   = 0.12;
      } catch {
        // Pipeline already exists — leave it.
      }
    });
  }

  // ── Kelvin wake plane ──────────────────────────────────────────────────────

  private buildWakePlane(scene: Scene): void {
    this.wakePlane = MeshBuilder.CreateGround('wakePlane', {
      width: this.WAKE_W, height: this.WAKE_L, subdivisions: 1,
    }, scene);
    this.wakePlane.isPickable = false;
    this.wakePlane.position.y = 0.10;

    this.wakeMat = new ShaderMaterial('wakeMat', scene,
      { vertexSource: WAKE_VERT, fragmentSource: WAKE_FRAG },
      {
        attributes:        ['position', 'uv'],
        uniforms:          ['worldViewProjection', 'time', 'speed', 'planeW', 'planeL'],
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

      // Ocean
      this.oceanMat.setFloat('u_Time', this.elapsed);
      const cam = scene.activeCamera;
      if (cam) this.oceanMat.setVector3('u_cameraPosition', cam.position);

      // Sync sun from scene's DirectionalLight (direction points toward ground → negate)
      const dl = scene.lights.find(l => l instanceof DirectionalLight) as DirectionalLight | undefined;
      if (dl) {
        this.oceanMat.setVector3('u_sunDir',
          dl.direction.negate().normalize());
        this.oceanMat.setVector3('u_sunColor',
          new Vector3(dl.diffuse.r, dl.diffuse.g, dl.diffuse.b));
      }

      // Wake
      this.wakeMat.setFloat('time',  this.elapsed);
      this.wakeMat.setFloat('speed', Math.min(1, Math.abs(this.boatSpeed) / 8));

      const shift = this.WAKE_L / 2 - this.BOAT_HALF_L;
      this.wakePlane.position.x = this.boatX - Math.sin(this.boatHdgR) * shift;
      this.wakePlane.position.z = this.boatZ - Math.cos(this.boatHdgR) * shift;
      this.wakePlane.rotation.y = this.boatHdgR;
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setBoatTransform(x: number, z: number, hdgRad: number, speed: number): void {
    this.boatX     = x;
    this.boatZ     = z;
    this.boatHdgR  = hdgRad;
    this.boatSpeed = speed;
  }

  updateWeather(wind: Wind, sea: SeaConditions): void {
    if (!this.oceanMat) return;
    // Choppiness scales normal perturbation strength and foam density.
    // Speed scales wave celerity (all five octave scroll speeds scale together).
    this.oceanMat.setFloat('u_choppiness', sea.choppiness);
    this.oceanMat.setFloat('u_speed',      0.38 + sea.choppiness * 0.50);
    // Wind direction is not currently wired into the hardcoded octave scroll
    // vectors.  All five octaves have well-separated compass bearings so the
    // ocean reads as wind-from-multiple-directions regardless of actual wind.
    void wind;
  }

  /** No-op — kept for API compatibility with IslandService / VesselService. */
  addToRenderList(_mesh: any): void {}

  getOceanMesh(): Mesh { return this.oceanMesh; }
}
