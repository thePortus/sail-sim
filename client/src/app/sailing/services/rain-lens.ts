/**
 * RainLens — raindrops-on-the-camera post-process. Adapted from Martijn Steinrucken (BigWings) "Heartfelt"
 * (2017), CC BY-NC-SA 3.0 — the "heart"/story scaffolding is stripped; the rain amount is driven live by
 * storminess (drizzle → heavy storm) instead of the mouse, and the input image is OUR rendered scene
 * (textureSampler) so the drops refract/fog the game itself. Attached to the camera only while it's raining.
 *
 * GLSL (Babylon transpiles it to WGSL on WebGPU via glslang, same path the terrain clipmap uses, and runs it
 * natively on WebGL). Normals are the faithful (expensive) analytic version for the best look; the effect only
 * runs while raining, so the cost is paid only during weather. If storm-time FPS suffers we can switch to the
 * cheap dFdx normals.
 */
import { AbstractEngine, Camera, Effect, PostProcess, Texture } from '@babylonjs/core';

const RAIN_LENS_FRAG = `
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform float uTime;
uniform float uRain;        // 0 = dry, 1 = heavy storm
uniform vec2  uResolution;

#define S(a, b, t) smoothstep(a, b, t)

vec3 N13(float p) {
  vec3 p3 = fract(vec3(p) * vec3(.1031, .11369, .13787));
  p3 += dot(p3, p3.yzx + 19.19);
  return fract(vec3((p3.x + p3.y) * p3.z, (p3.x + p3.z) * p3.y, (p3.y + p3.z) * p3.x));
}
float N(float t) { return fract(sin(t * 12345.564) * 7658.76); }
float Saw(float b, float t) { return S(0., b, t) * S(1., b, t); }

vec2 DropLayer2(vec2 uv, float t) {
  vec2 UV = uv;
  uv.y += t * 0.75;
  vec2 a = vec2(3.2, 1.);   // trailing-drop column density (was 6.) — spaced out so drops don't cluster
  vec2 grid = a * 2.;
  vec2 id = floor(uv * grid);
  float colShift = N(id.x);
  uv.y += colShift;
  id = floor(uv * grid);
  vec3 n = N13(id.x * 35.2 + id.y * 2376.1);
  vec2 st = fract(uv * grid) - vec2(.5, 0);
  float x = n.x - .5;
  float y = UV.y * 20.;
  float wiggle = sin(y + sin(y));
  x += wiggle * (.5 - abs(x)) * (n.z - .5);
  x *= .7;
  float ti = fract(t + n.z);
  y = (Saw(.85, ti) - .5) * .9 + .5;
  vec2 p = vec2(x, y);
  float d = length((st - p) * a.yx);
  float mainDrop = S(.4, .0, d);
  float r = sqrt(S(1., y, st.y));
  float cd = abs(st.x - x);
  float trail = S(.23 * r, .15 * r * r, cd);
  float trailFront = S(-.02, .02, st.y - y);
  trail *= trailFront * r * r;
  y = UV.y;
  float trail2 = S(.2 * r, .0, cd);
  float droplets = max(0., (sin(y * (1. - y) * 120.) - st.y)) * trail2 * trailFront * n.z;
  y = fract(y * 10.) + (st.y - .5);
  float dd = length(st - vec2(x, y));
  droplets = S(.3, 0., dd);
  float m = mainDrop + droplets * r * trailFront;
  return vec2(m, trail);
}

float StaticDrops(vec2 uv, float t) {
  uv *= 18.;   // static-drop grid density (was 40.) — much coarser = ~80% fewer, well-spaced speckle drops
  vec2 id = floor(uv);
  uv = fract(uv) - .5;
  vec3 n = N13(id.x * 107.45 + id.y * 3543.654);
  vec2 p = (n.xy - .5) * .7;
  float d = length(uv - p);
  float fade = Saw(.025, fract(t + n.z));
  float c = S(.3, 0., d) * fract(n.z * 10.) * fade;
  return c;
}

vec2 Drops(vec2 uv, float t, float l0, float l1, float l2) {
  float s = StaticDrops(uv, t) * l0;
  vec2 m1 = DropLayer2(uv, t) * l1;
  vec2 m2 = DropLayer2(uv * 1.85, t) * l2;
  float c = s + m1.x + m2.x;
  c = S(.3, 1., c);
  return vec2(c, max(m1.y * l0, m2.y * l1));
}

void main(void) {
  vec2 fragCoord = vUV * uResolution;
  vec2 uv = (fragCoord - 0.5 * uResolution) / uResolution.y;   // aspect-correct, centred
  vec2 UV = vUV;
  float rainAmount = clamp(uRain, 0.0, 1.0);
  float t = uTime * 0.2;

  // Drop density. The heaviest pour stays tapered + de-cluttered (kept readable, per earlier tuning), while
  // the LOW end (drizzle) is lifted so a light rain still reads as rain: pow(rain, 0.55) raises low/mid values
  // but leaves full pour (rain ≈ 1) unchanged. A fade envelope avoids a pop when the pass attaches near 0.
  float fade = S(0.0, 0.08, rainAmount);
  float rd = pow(rainAmount, 0.55) * (1.0 - 0.2 * rainAmount);
  float staticDrops = S(-.5, 1.0, rd) * 0.7 * fade;   // *0.7 (was *1.3, orig *2.0) — far fewer speckle drops, de-cluttered
  float layer1 = S(.25, .75, rd) * fade;
  float layer2 = S(.0, .5, rd) * fade;

  vec2 c = Drops(uv, t, staticDrops, layer1, layer2);
  vec2 e = vec2(.001, 0.0);
  float cx = Drops(uv + e,    t, staticDrops, layer1, layer2).x;
  float cy = Drops(uv + e.yx, t, staticDrops, layer1, layer2).x;
  vec2 n = vec2(cx - c.x, cy - c.x);          // refraction normal — the drops lens the scene (no blur/fog)

  // Pure refraction, no foggy-glass blur (removed for readability). Explicit LOD keeps WGSL happy.
  vec3 col = textureLod(textureSampler, UV + n, 0.0).rgb;

  gl_FragColor = vec4(col, 1.0);
}
`;

export class RainLens {
  private pp: PostProcess | null = null;
  private amount = 0;
  private attached = false;
  private readonly startMs = performance.now();

  constructor(private camera: Camera, private engine: AbstractEngine) {
    Effect.ShadersStore['rainLensFragmentShader'] = RAIN_LENS_FRAG;
    this.pp = new PostProcess(
      'rainLens', 'rainLens',
      ['uTime', 'uRain', 'uResolution'], null,
      1.0, null,                              // full-res; not auto-attached (we attach only while raining)
      Texture.BILINEAR_SAMPLINGMODE, engine, false,
    );
    this.pp.onApply = (effect) => {
      effect.setFloat('uTime', (performance.now() - this.startMs) / 1000);
      effect.setFloat('uRain', this.amount);
      effect.setFloat2('uResolution', this.engine.getRenderWidth(), this.engine.getRenderHeight());
    };
  }

  /**
   * Drive the rain amount (0..1). Attaches the pass while raining, detaches when dry (no cost when clear).
   * WebGPU-safe: we only attach once `isReady()` is true (the shader has compiled). If the GLSL→WGSL
   * transpile ever fails, the pass simply never readies → never attaches → the effect is silently skipped
   * rather than blanking the screen (the failure mode the built-in god-rays was chosen to avoid).
   */
  setAmount(a: number): void {
    this.amount = a;
    if (!this.pp) { return; }
    const want = a > 0.02 && this.pp.isReady();
    if (want === this.attached) { return; }
    if (want) { this.camera.attachPostProcess(this.pp); }
    else      { this.camera.detachPostProcess(this.pp); }
    this.attached = want;
  }

  dispose(): void {
    if (this.pp && this.attached) { this.camera.detachPostProcess(this.pp); }
    this.pp?.dispose();
    this.pp = null;
    this.attached = false;
  }
}
