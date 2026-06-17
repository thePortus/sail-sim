/**
 * TelescopeService — a hold-to-look "spyglass": while the player holds RIGHT-mouse on the 3D view, a circular
 * brass-rimmed lens follows the cursor and magnifies the scene (5×) so distant ships/harbours can be read.
 *
 * It's a screen-space magnifier post-process (mirrors the [[rain_lens_effect]] RainLens pattern): the rendered
 * frame is resampled around the cursor at 1/zoom inside a circle, with a slight barrel bulge + chromatic
 * fringing toward the rim for a real-glass feel, a vignette, and a shaded brass ring border. GLSL — Babylon
 * transpiles it to WGSL on WebGPU (glslang) and runs it natively on WebGL; the scene read uses textureLod (an
 * explicit LOD → WGSL-legal). Attached only while held (no cost otherwise).
 *
 * Right-click is otherwise unused on the main canvas (left = camera drag, firing is server-side), and the
 * browser context menu is suppressed over the canvas so the hold reads cleanly.
 */
import { inject, Injectable } from '@angular/core';
import { Effect, Observer, PointerEventTypes, PointerInfo, PostProcess, Texture } from '@babylonjs/core';
import { SceneService } from './scene.service';

const TELESCOPE_FRAG = `
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec2  uCenter;       // lens centre in UV (cursor)
uniform float uRadius;       // lens radius in Y-normalized units (round regardless of aspect)
uniform float uZoom;         // magnification
uniform vec2  uResolution;

void main(void) {
  float aspect = uResolution.x / uResolution.y;
  // Aspect-corrected offset from the lens centre → the circle stays round on a wide screen.
  vec2 d = vUV - uCenter;
  d.x *= aspect;
  float dist = length(d);

  float R  = uRadius;
  float bw = R * 0.11;                 // brass ring thickness
  float aa = 1.5 / uResolution.y;      // ~1.5 px edge feather

  vec3 scene = textureLod(textureSampler, vUV, 0.0).rgb;   // pass-through frame (outside the lens)

  // Outside the ring entirely → just the scene (cheap path).
  if (dist > R + bw + aa) { gl_FragColor = vec4(scene, 1.0); return; }

  // ── Magnified lens interior ───────────────────────────────────────────────
  float rr = clamp(dist / R, 0.0, 1.0);           // 0 centre … 1 rim
  vec2 off = vUV - uCenter;                        // screen-space offset (sample in plain UV)
  float bulge = 1.0 + 0.34 * rr * rr;              // barrel distortion: image compresses toward the rim
  vec2 base = uCenter + (off / uZoom) * bulge;
  // Chromatic aberration grows toward the rim — coloured fringes like a cheap glass.
  float ca = 0.006 * rr;
  vec3 lens;
  lens.r = textureLod(textureSampler, uCenter + (off / uZoom) * bulge * (1.0 + ca), 0.0).r;
  lens.g = textureLod(textureSampler, base, 0.0).g;
  lens.b = textureLod(textureSampler, uCenter + (off / uZoom) * bulge * (1.0 - ca), 0.0).b;
  // Vignette: darken toward the rim so the glass seats into the ring.
  lens *= mix(1.0, 0.5, smoothstep(0.55, 1.0, rr));

  // ── Brass ring ────────────────────────────────────────────────────────────
  vec3 brassHi = vec3(0.58, 0.46, 0.20);
  vec3 brassLo = vec3(0.22, 0.15, 0.04);
  float ring = clamp((dist - R) / bw, 0.0, 1.0);   // 0 inner … 1 outer
  vec3 brass = mix(brassHi, brassLo, ring);
  brass += brassHi * 0.28 * smoothstep(0.16, 0.0, abs(ring - 0.28));  // subdued highlight band near the inner edge
  brass *= 0.9 + 0.1 * cos(ring * 12.0);                              // faint machined sheen

  // Compose: scene → lens (inside R) → brass (the R..R+bw annulus).
  float inLens   = smoothstep(R + aa, R - aa, dist);
  float onRing   = smoothstep(R - aa, R + aa, dist) * smoothstep(R + bw + aa, R + bw - aa, dist);
  vec3 col = mix(scene, lens, inLens);
  col = mix(col, brass, onRing);

  gl_FragColor = vec4(col, 1.0);
}
`;

@Injectable({ providedIn: 'root' })
export class TelescopeService {
  private sceneService = inject(SceneService);

  private pp: PostProcess | null = null;
  private attached = false;
  private active = false;

  private centerX = 0.5;        // lens centre in UV
  private centerY = 0.5;
  private canvas: HTMLCanvasElement | null = null;
  private pointerObserver: Observer<PointerInfo> | null = null;

  private readonly RADIUS = 0.255;  // lens radius (Y-normalized) — ~½ of screen height across
  private readonly ZOOM   = 5.0;

  init(): void {
    if (this.pp) { return; }
    const camera = this.sceneService.camera;
    const engine = this.sceneService.engine;
    const scene  = this.sceneService.scene;
    this.canvas = engine?.getRenderingCanvas() ?? null;
    if (!camera || !engine || !scene) { return; }

    Effect.ShadersStore['telescopeFragmentShader'] = TELESCOPE_FRAG;
    this.pp = new PostProcess(
      'telescope', 'telescope',
      ['uCenter', 'uRadius', 'uZoom', 'uResolution'], null,
      1.0, null,                                   // full-res; attached only while held
      Texture.BILINEAR_SAMPLINGMODE, engine, false,
    );
    this.pp.onApply = (effect) => {
      effect.setFloat2('uCenter', this.centerX, this.centerY);
      effect.setFloat('uRadius', this.RADIUS);
      effect.setFloat('uZoom', this.ZOOM);
      effect.setFloat2('uResolution', engine.getRenderWidth(), engine.getRenderHeight());
    };

    // Input via Babylon's pointer observable — raw canvas listeners get swallowed by the scene's own
    // internal listeners (same reason VesselService routes camera-drag through this observable).
    this.pointerObserver = scene.onPointerObservable.add((info: PointerInfo) => {
      const ev = info.event as PointerEvent;
      switch (info.type) {
        case PointerEventTypes.POINTERDOWN:
          if (ev.button === 2) { this.updateCenter(ev); this.setActive(true); }
          break;
        case PointerEventTypes.POINTERMOVE:
          if (this.active) { this.updateCenter(ev); }
          break;
        case PointerEventTypes.POINTERUP:
          if (ev.button === 2) { this.setActive(false); }
          break;
      }
    });

    // Suppress the browser context menu over the game canvas so the right-hold reads as a telescope.
    this.canvas?.addEventListener('contextmenu', this.onContextMenu);
    // A right-up that lands off-canvas (cursor left the window mid-hold) won't reach the observable.
    window.addEventListener('mouseup', this.onWindowUp);
    window.addEventListener('blur', this.onBlur);
  }

  private onContextMenu = (e: MouseEvent): void => { e.preventDefault(); };
  private onWindowUp = (e: MouseEvent): void => { if (e.button === 2) { this.setActive(false); } };
  private onBlur = (): void => { this.setActive(false); };

  private updateCenter(e: { clientX: number; clientY: number }): void {
    const c = this.canvas;
    if (!c) { return; }
    const r = c.getBoundingClientRect();
    this.centerX = (e.clientX - r.left) / r.width;
    this.centerY = 1.0 - (e.clientY - r.top) / r.height;   // UV origin is bottom-left
  }

  /** Attach the magnifier pass while held, detach when released — no cost otherwise. (No isReady() gate:
   *  an unready pass simply doesn't render until its effect compiles, and gating silently hid failures.) */
  private setActive(on: boolean): void {
    if (on === this.active) { return; }
    this.active = on;
    if (!this.pp) { return; }
    const camera = this.sceneService.camera;
    if (on && !this.attached) { camera?.attachPostProcess(this.pp); this.attached = true; }
    else if (!on && this.attached) { camera?.detachPostProcess(this.pp); this.attached = false; }
  }

  dispose(): void {
    this.canvas?.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('mouseup', this.onWindowUp);
    window.removeEventListener('blur', this.onBlur);
    if (this.pointerObserver) { this.sceneService.scene?.onPointerObservable.remove(this.pointerObserver); this.pointerObserver = null; }
    if (this.pp && this.attached) { this.sceneService.camera?.detachPostProcess(this.pp); }
    this.pp?.dispose();
    this.pp = null;
    this.attached = false;
    this.active = false;
    this.canvas = null;
  }
}
