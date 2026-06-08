import {
  Scene, Vector3, MeshBuilder, Mesh, StandardMaterial, Texture, Color3,
  Constants, ShaderLanguage, ProceduralTexture,
} from '@babylonjs/core';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';

/**
 * Homegrown physically-styled day/night sky for the WebGPU path.
 *
 * Replaces the Babylon `@babylonjs/addons/atmosphere` addon (which triggered non-fatal
 * `Missing entry point` SPIR-V link failures on WebGPU when it swapped the scene
 * environment / sky-IBL). This is a port of the BitOfGold "Day and night sky cycle"
 * single-scattering shader (https://www.shadertoy.com/view/ltlSWB) with its CLOUDS and
 * STARS paths removed — the game's existing volumetric-cloud plugin and star dome stay
 * authoritative. We keep only the Rayleigh/Mie atmospheric-scattering COLOUR.
 *
 * Authored in WGSL (native to WebGPU — avoids the GLSL->SPIR-V translator that has caused
 * every shader failure on this engine). With clouds off the scatter is a smooth function
 * of (view direction, sun direction) only, so we bake it into a low-res equirectangular
 * LUT (a ProceduralTexture) that re-bakes only when the sun moves, then sample it cheaply
 * on a StandardMaterial skybox using Babylon's built-in FIXED_EQUIRECTANGULAR reflection
 * mode — no custom dome shader needed.
 *
 * Babylon's FIXED_EQUIRECTANGULAR sampling (see core ShadersWGSL/.../reflectionFunction):
 *     s = atan2(dir.z, dir.x) / (2*PI) + 0.5
 *     t = acos(dir.y) / PI                       (t=0 zenith, t=1 nadir)
 * The bake shader INVERTS this: for texel (s,t) it reconstructs `dir`, scatters, writes colour.
 */

const SKY_BAKE_WGSL = `
varying vUV: vec2f;

uniform uSunDir: vec3f;   // unit vector FROM origin TOWARD the sun (scene space)

const M_PI:   f32 = 3.1415926535;
const HR:     f32 = 8000.0;        // Rayleigh scale height
const HM:     f32 = 1000.0;        // Mie scale height
const R0:     f32 = 6360000.0;     // planet radius
const RA:     f32 = 6380000.0;     // atmosphere radius
const HEIGHT: f32 = 500.0;         // viewer height above surface
const HAZE:   f32 = 0.0;           // aerosol Mie floor. >0 washes the horizon tan/cream; 0 = clean blue sky
const I_SUN:  f32 = 10.0;          // sun light power
const G:      f32 = 0.45;          // Mie phase asymmetry
const ENV:    f32 = 1.0;           // output gain (linear HDR; pipeline ACES-tonemaps). TUNE.

// Reduced march counts vs the reference (132x16): with clouds OFF the integral is smooth.
const STEPS:  i32 = 24;
const STEPSS: i32 = 6;

const BR: vec3f = vec3f(5.8e-6, 13.5e-6, 33.1e-6);  // Rayleigh coefficients (earth-like)
const BM: vec3f = vec3f(21e-6, 21e-6, 21e-6);       // Mie coefficient
const C:  vec3f = vec3f(0.0, -6360000.0, 0.0);      // planet centre (= vec3(0,-R0,0))

fn sky_densities(pos: vec3f) -> vec2f {
    let h = length(pos - C) - R0;
    let rayleigh = exp(-h / HR);
    let mie = exp(-h / HM) + HAZE;
    return vec2f(rayleigh, mie);
}

fn sky_escape(p: vec3f, d: vec3f, R: f32) -> f32 {
    let v = p - C;
    let b = dot(v, d);
    let c = dot(v, v) - R * R;
    let det2 = b * b - c;
    if (det2 < 0.0) { return -1.0; }
    let det = sqrt(det2);
    let t1 = -b - det;
    let t2 = -b + det;
    if (t1 >= 0.0) { return t1; }
    return t2;
}

fn sky_scatter(o: vec3f, d: vec3f, Ds: vec3f) -> vec3f {
    let L = sky_escape(o, d, RA);
    let mu = dot(d, Ds);
    let g2 = G * G;
    let opmu2 = 1.0 + mu * mu;
    let phaseR = 0.0596831 * opmu2;
    let phaseM = 0.1193662 * (1.0 - g2) * opmu2 / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * G * mu, 1e-4), 1.5));

    var depthR = 0.0;
    var depthM = 0.0;
    var R = vec3f(0.0, 0.0, 0.0);
    var M = vec3f(0.0, 0.0, 0.0);

    let dl = L / f32(STEPS);
    for (var i: i32 = 0; i < STEPS; i = i + 1) {
        let l = f32(i) * dl;
        let p = o + d * l;
        let dens = sky_densities(p);
        let dR = dens.x * dl;
        let dM = dens.y * dl;
        depthR = depthR + dR;
        depthM = depthM + dM;

        let Ls = sky_escape(p, Ds, RA);
        if (Ls > 0.0) {
            let dls = Ls / f32(STEPSS);
            var depthRs = 0.0;
            var depthMs = 0.0;
            for (var j: i32 = 0; j < STEPSS; j = j + 1) {
                let ls = f32(j) * dls;
                let ps = p + Ds * ls;
                let densS = sky_densities(ps);
                depthRs = depthRs + densS.x * dls;
                depthMs = depthMs + densS.y * dls;
            }
            let A = exp(-(BR * (depthRs + depthR) + BM * (depthMs + depthM)));
            R = R + A * dR;
            M = M + A * dM;
        }
    }
    return I_SUN * (R * BR * phaseR + M * BM * phaseM);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // Reconstruct the view direction Babylon's FIXED_EQUIRECTANGULAR mode maps to this texel.
    // If the sky ends up vertically flipped, change t to (1.0 - input.vUV.y).
    let s = input.vUV.x;
    let t = input.vUV.y;
    let lon = (s - 0.5) * 2.0 * M_PI;
    let lat = t * M_PI;                 // 0 = zenith (up), PI = nadir (down)
    let sinLat = sin(lat);
    var D = vec3f(sinLat * cos(lon), cos(lat), sinLat * sin(lon));

    // Below-horizon fold (from the reference) so the lower hemisphere isn't pure black.
    if (D.y <= -0.15) {
        D = normalize(vec3f(D.x, -0.3 - D.y, D.z));
    }


    // Night handling: smoothly fade sky brightness as the sun sinks past the horizon, so dusk
    // eases gradually into a dark, star-friendly night with NO hard pop. (We have a separate moon
    // + star dome, so the sky is MEANT to go dark at night.) We deliberately drop the reference's
    // "mirror the sun back above the horizon" hack -- that snapped a fresh orange glow on in a
    // single frame at dusk. The scattering integral has no planet terminator, so the att ramp
    // below is what actually darkens the night side as the sun goes down.
    let Ds = normalize(uniforms.uSunDir);
    let att = mix(0.02, 1.0, smoothstep(-0.25, 0.06, Ds.y));

    let O = vec3f(0.0, HEIGHT, 0.0);
    var color = sky_scatter(O, D, Ds) * att * ENV;

    // ── Daytime blue ────────────────────────────────────────────────────────────────────────────
    // This single-scatter model has no multiple-scattering term, so over the long horizon path it
    // over-extinguishes blue and the horizon turns yellow/olive. When the sun is UP, blend toward a
    // clean blue gradient (deep zenith -> pale horizon). dayF fades this out by dusk so the warm
    // sunset scatter below takes over untouched. Tune DAY_ZENITH / DAY_HORIZON for the blue.
    let dayF = smoothstep(0.0, 0.30, Ds.y);          // 1 when the sun is well up, 0 at/below horizon
    let DAY_ZENITH  = vec3f(0.07, 0.20, 0.52);       // deep blue overhead
    let DAY_HORIZON = vec3f(0.42, 0.60, 0.85);       // pale blue at the horizon
    let dayGrad = mix(DAY_HORIZON, DAY_ZENITH, smoothstep(0.0, 0.6, D.y));
    color = mix(color, dayGrad, dayF * 0.78);

    // ── Sundown shaping ───────────────────────────────────────────────────────────────────────
    // warmF: how "sunset" the sky is. Active across the whole golden-hour window (sun from ~30 deg
    // up down to the horizon), NOT just the last moment. dusk: same but faded out for deep night so
    // the night sky stays dark. Widen the 0.55 to start the shaping while the sun is higher.
    let warmF = 1.0 - smoothstep(0.0, 0.30, max(Ds.y, 0.0));
    let dusk  = warmF * smoothstep(-0.35, -0.05, Ds.y);

    // (1) Warm grade of the horizon band (deep orange, not pale peach). Raise toward 1.0 for paler.
    let SUNSET_GRADE = vec3f(0.98, 0.86, 0.66);
    color = color * mix(vec3f(1.0, 1.0, 1.0), SUNSET_GRADE, warmF);

    // (2) Dusk gradient: zenith DARKEST, horizon BRIGHTEST (the natural twilight gradient). As the sun sets,
    //     progressively DARKEN the upper sky (high D.y) while leaving the warm horizon band (low D.y) brightest.
    //     Replaces an older term that mixed the zenith toward a BRIGHT blue -- that inverted the gradient into a
    //     bright-blue cap sitting OVER a dark horizon (backwards). dusk (= warmF gated to sundown) ramps this in
    //     through golden hour and fades by deep night (att has crushed the whole sky by then). KNOBS: 0.88 (max
    //     zenith darken), smoothstep(0.03, 0.45, D.y) (how far down toward the horizon the darkening reaches).
    let upDark = smoothstep(0.03, 0.45, D.y) * dusk;
    color = color * (1.0 - upDark * 0.88);

    fragmentOutputs.color = vec4f(color, 1.0);
}
`;

/**
 * Content-hashed shader name. Babylon caches compiled effects/pipelines keyed by the shader NAME,
 * not its source — so reusing a fixed name like "skyBake" lets a previously-compiled effect for an
 * OLD version of the WGSL survive (even across reloads via on-disk pipeline caches), silently
 * ignoring edits. Deriving the name from a hash of the source means every edit yields a NEW name,
 * forcing a fresh compile. (This is why several earlier shader edits appeared to do nothing.)
 */
function skyShaderHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0; }
  return h.toString(36);
}
const SKY_BAKE_NAME = 'skyBake_' + skyShaderHash(SKY_BAKE_WGSL);

export interface ProceduralSkyOptions {
  /** Box size for the skybox mesh (world units). Default 150000 to match the Preetham dome. */
  domeSize?: number;
  /** Equirect LUT width.  Default 256. */
  lutWidth?: number;
  /** Equirect LUT height. Default 128. */
  lutHeight?: number;
}

/**
 * Re-bake when the sun moves more than ~0.25 degrees (cos threshold). Over a 24-min day
 * cycle this is a few hundred sub-millisecond bakes total — negligible.
 */
const SUN_MOVE_COS = 0.99999;

export class ProceduralSky {
  private readonly lut: ProceduralTexture;
  private readonly mat: StandardMaterial;
  private readonly mesh: Mesh;
  private readonly _lastSunDir = new Vector3(0, 1, 0);
  private _primed = false;

  constructor(private readonly scene: Scene, opts: ProceduralSkyOptions = {}) {
    const domeSize  = opts.domeSize  ?? 150000;
    const lutWidth  = opts.lutWidth  ?? 256;
    const lutHeight = opts.lutHeight ?? 128;

    // Register under the content-hashed name so a changed shader always compiles fresh (see
    // skyShaderHash). The hash in the log tells you the source actually changed between reloads.
    ShaderStore.ShadersStoreWGSL[SKY_BAKE_NAME + 'PixelShader'] = SKY_BAKE_WGSL;
    console.info('[ProceduralSky] bake shader registered: ' + SKY_BAKE_NAME);

    // Equirect LUT: WGSL fragment, half-float HDR, manual refresh (re-baked on sun-move).
    this.lut = new ProceduralTexture(
      'skyLUT',
      { width: lutWidth, height: lutHeight },
      SKY_BAKE_NAME,
      scene,
      { shaderLanguage: ShaderLanguage.WGSL, fallbackTexture: null },
      /* generateMipMaps */ false,
      /* isCube */ false,
      Constants.TEXTURETYPE_HALF_FLOAT,
    );
    this.lut.refreshRate = 0; // REFRESHRATE_RENDER_ONCE -> bake once; we re-arm via resetRefreshCounter() on sun-move
    this.lut.wrapU = Texture.WRAP_ADDRESSMODE;              // longitude wraps
    this.lut.wrapV = Texture.CLAMP_ADDRESSMODE;             // latitude clamps at the poles
    this.lut.gammaSpace = false;                            // contents are LINEAR HDR radiance
    // Seed a daytime sun so the very first bake (which can fire before the first tick) isn't black.
    this.lut.setVector3('uSunDir', new Vector3(0.3, 0.7, 0.3).normalize());

    this.lut.onGeneratedObservable.addOnce(() => {
      console.info('[ProceduralSky] LUT baked OK');
    });

    // Skybox: built-in StandardMaterial, coloured purely by the LUT in fixed-equirect mode.
    this.mat = new StandardMaterial('proceduralSkyMat', scene);
    this.mat.backFaceCulling = false;
    this.mat.disableLighting  = true;
    // CRITICAL: the skybox is at infiniteDistance (~150000 u); with FOGMODE_EXP2 the fog factor
    // saturates to 100% at that distance, which would wash the ENTIRE sky to the (time-of-day,
    // orange-at-sunset) fog colour and completely hide the baked LUT. Disable fog on the sky.
    this.mat.fogEnabled = false;
    this.mat.diffuseColor     = new Color3(0, 0, 0);
    this.mat.specularColor    = new Color3(0, 0, 0);
    this.mat.reflectionTexture = this.lut;
    this.mat.reflectionTexture.coordinatesMode = Texture.FIXED_EQUIRECTANGULAR_MODE;

    this.mesh = MeshBuilder.CreateBox('proceduralSky', { size: domeSize }, scene);
    this.mesh.material         = this.mat;
    this.mesh.infiniteDistance = true;
    this.mesh.renderingGroupId = 0;
    this.mesh.isPickable       = false;
  }

  /** The skybox mesh (for reflection-RTT enrollment, enable/disable, disposal). */
  get skyMesh(): Mesh { return this.mesh; }

  /** The baked equirect LUT (linear HDR), e.g. for sampling representative sky colours later. */
  get lutTexture(): ProceduralTexture { return this.lut; }

  /**
   * Drive the sky from the day/night clock. Call every tick with the unit sun direction
   * (FROM origin TOWARD sun). Re-bakes only when the sun has moved enough.
   */
  setSunDir(dir: Vector3): void {
    this.lut.setVector3('uSunDir', dir);
    if (!this._primed || Vector3.Dot(dir, this._lastSunDir) < SUN_MOVE_COS) {
      this._primed = true;
      this._lastSunDir.copyFrom(dir);
      this.lut.resetRefreshCounter(); // re-bake on the next frame with the new sun direction
    }
  }

  setEnabled(enabled: boolean): void { this.mesh.setEnabled(enabled); }

  dispose(): void {
    this.mesh.dispose();
    this.mat.dispose();
    this.lut.dispose();
  }
}
