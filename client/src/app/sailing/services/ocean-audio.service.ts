import { Injectable, inject } from '@angular/core';
import { Observer, Scene } from '@babylonjs/core';
import { SfxService } from './sfx.service';
import { WeatherService } from './weather.service';
import { SceneService } from './scene.service';

/**
 * Procedural ambient sea bed — a continuous ocean wash synthesized from looping noise, driven by the
 * weather so it's a soft low lapping in calm air and builds to a louder, brighter, hiss-laced roar as the
 * wind rises. Two layers feed a shared bed gain → the SFX master (so it respects the Sound slider):
 *   - **wash**: brown noise → lowpass → a slow swell LFO (the surge of waves coming and going), and
 *   - **whitecap hiss**: white noise → highpass, near-silent when calm and growing strongly with wind.
 * Wind speed (0 calm … rough) maps to bed volume, wash brightness, hiss level, and swell depth/rate.
 * Mirrors CloudService's rain-bed pattern (own AudioContext + SFX master, looping filtered noise).
 */
@Injectable({ providedIn: 'root' })
export class OceanAudioService {
  private sfx          = inject(SfxService);
  private weather      = inject(WeatherService);
  private sceneService = inject(SceneService);

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private observer: Observer<Scene> | null = null;
  private _acc = 0;                       // throttle accumulator (update params ~4×/s)

  // Live nodes whose params track the weather.
  private bedGain: GainNode | null = null;       // overall sea level
  private washLpf: BiquadFilterNode | null = null;
  private hissGain: GainNode | null = null;
  private swellDepth: GainNode | null = null;
  private swellLfo: OscillatorNode | null = null;
  // Looping sources — kept so dispose() can stop them (the context is now shared and never closed).
  private brownSrc: AudioBufferSourceNode | null = null;
  private whiteSrc: AudioBufferSourceNode | null = null;

  init(): void {
    const scene = this.sceneService.scene;
    if (!scene || this.ctx) { return; }
    try {
      this.ctx = this.sfx.getSharedAudioContext();   // shared SFX context (own master below)
      this.master = this.sfx.createMaster(this.ctx);
    } catch { this.ctx = null; return; }
    if (this.ctx.state === 'suspended') { void this.ctx.resume(); }
    this.build(this.ctx);
    this.update();   // set initial params from current weather
    this.observer = scene.onBeforeRenderObservable.add(() => {
      this._acc += Math.min(scene.getEngine().getDeltaTime() / 1000, 0.1);
      if (this._acc < 0.25) { return; }
      this._acc = 0;
      this.update();
    });
  }

  /** Build the (silent-at-start) noise graph and start the loops. */
  private build(ctx: AudioContext): void {
    const sr = ctx.sampleRate;

    // Brown noise (deep wash) — integrated white noise (Paul Kellet's approximation).
    const blen = Math.floor(sr * 3);
    const bbuf = ctx.createBuffer(1, blen, sr);
    const bd = bbuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < blen; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; bd[i] = last * 2.6; }
    const brown = ctx.createBufferSource(); brown.buffer = bbuf; brown.loop = true;

    // White noise (whitecap hiss).
    const wlen = Math.floor(sr * 2);
    const wbuf = ctx.createBuffer(1, wlen, sr);
    const wd = wbuf.getChannelData(0);
    for (let i = 0; i < wlen; i++) { wd[i] = Math.random() * 2 - 1; }
    const white = ctx.createBufferSource(); white.buffer = wbuf; white.loop = true;

    // Wash: brown → lowpass → swell (gain modulated by a slow LFO) → bed.
    const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 700; lpf.Q.value = 0.6;
    const swell = ctx.createGain(); swell.gain.value = 0.7;
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.1;
    const depth = ctx.createGain(); depth.gain.value = 0.15;
    lfo.connect(depth).connect(swell.gain);     // swell.gain swings 0.55…0.85 (more in wind)

    // Hiss: white → highpass → hissGain → bed.
    const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = 1600;
    const hiss = ctx.createGain(); hiss.gain.value = 0;

    const bed = ctx.createGain(); bed.gain.value = 0;   // ramps up in update() (no startup click)

    brown.connect(lpf).connect(swell).connect(bed);
    white.connect(hpf).connect(hiss).connect(bed);
    bed.connect(this.master!);

    brown.start(); white.start(); lfo.start();
    this.bedGain = bed; this.washLpf = lpf; this.hissGain = hiss; this.swellDepth = depth; this.swellLfo = lfo;
    this.brownSrc = brown; this.whiteSrc = white;
  }

  /** Map the current wind speed to the sea-bed parameters (smoothed, so weather shifts ease in). */
  private update(): void {
    const ctx = this.ctx;
    if (!ctx) { return; }
    const speed = this.weather.weather()?.wind.speed ?? 6;
    const k = Math.max(0, Math.min(1, speed / 22));     // 0 calm → 1 rough (gale ≈ 22 m/s)
    const t = ctx.currentTime, tc = 0.7;                 // ~0.7 s smoothing
    this.bedGain?.gain.setTargetAtTime(0.07 + 0.33 * k, t, tc);        // gentle when calm, louder in wind
    this.washLpf?.frequency.setTargetAtTime(480 + 1500 * k, t, tc);    // brighter, more present in wind
    this.hissGain?.gain.setTargetAtTime(k * k * 0.16, t, tc);          // whitecaps ≈ silent until it blows
    this.swellDepth?.gain.setTargetAtTime(0.10 + 0.32 * k, t, tc);     // waves surge harder in wind
    this.swellLfo?.frequency.setTargetAtTime(0.08 + 0.13 * k, t, tc);  // …and a touch quicker
  }

  dispose(): void {
    const scene = this.sceneService.scene;
    if (this.observer && scene) { scene.onBeforeRenderObservable.remove(this.observer); }
    this.observer = null;
    // Shared context: STOP our looping sources (else they run silently forever), disconnect + release our
    // master, but do NOT close the context — other SFX producers share it.
    try { this.brownSrc?.stop(); this.whiteSrc?.stop(); this.swellLfo?.stop(); } catch { /* already stopped */ }
    this.brownSrc = this.whiteSrc = null;
    if (this.master) { this.master.disconnect(); this.sfx.releaseMaster(this.master); this.master = null; }
    this.ctx = null;
    this.bedGain = this.washLpf = this.hissGain = this.swellDepth = this.swellLfo = null as never;
  }
}
