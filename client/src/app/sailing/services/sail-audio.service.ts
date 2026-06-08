import { Injectable, inject } from '@angular/core';
import { Observer, Scene } from '@babylonjs/core';
import { SceneService } from './scene.service';
import { VesselService } from './vessel.service';
import { WeatherService } from './weather.service';
import { SfxService } from './sfx.service';

/**
 * Sail ambience: an occasional rustle / flap of canvas whenever sails are SET — sparse and soft under
 * topsails (half), more frequent and punchier under full sail, and picking up with the wind. Silent when
 * reefed. Synthesised (filtered brown-noise "whumps"), routed through the SHARED SFX context so it follows
 * the SFX volume without grabbing one of the browser's scarce AudioContext slots. `?nosailsfx` skips it.
 */
@Injectable({ providedIn: 'root' })
export class SailAudioService {
  private sceneService  = inject(SceneService);
  private vesselService = inject(VesselService);
  private weatherService = inject(WeatherService);
  private sfx           = inject(SfxService);

  private observer: Observer<Scene> | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;   // SHARED SFX master (owned by SfxService)

  private next = 4;   // seconds until the next flap event

  init(): void {
    const scene = this.sceneService.scene;
    if (!scene || this.observer) { return; }
    this.observer = scene.onBeforeRenderObservable.add(() => this.tick());
  }

  private tick(): void {
    const scene = this.sceneService.scene;
    if (!scene) { return; }
    const sail = this.vesselService.state()?.sailState ?? 'reefed';
    if (sail === 'reefed') { this.next = 3 + Math.random() * 3; return; }   // sails furled → silence

    this.next -= Math.min(0.1, scene.getEngine().getDeltaTime() / 1000);
    if (this.next > 0) { return; }

    const full  = sail === 'full';
    const wind  = this.weatherService.weather()?.wind.speed ?? 8;   // 0..35 m/s
    const windF = Math.min(1, wind / 22);                            // 0..1

    // Next event: full sails flap noticeably more often; stronger wind shortens the gap. Randomised so it
    // never sounds metronomic.
    const base = full ? 5.0 : 10.0;
    this.next = Math.max(1.2, (base - windF * (full ? 2.8 : 4.0)) * (0.6 + Math.random() * 0.9));

    // Loudness + burst length. Full + windy = a snapping luff of 2–3 flaps; half = usually a single rustle.
    const strength = (full ? 0.21 : 0.13) + windF * (full ? 0.21 : 0.11);
    let count = 1;
    if (full && Math.random() < 0.35 + windF * 0.40) { count = 2 + (Math.random() < windF ? 1 : 0); }
    else if (!full && Math.random() < windF * 0.30)  { count = 2; }

    this.playFlaps(strength, count);
  }

  private playFlaps(strength: number, count: number): void {
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    let t = ctx.currentTime + 0.01;
    for (let i = 0; i < count; i++) {
      this.flap(ctx, t, strength * (0.8 + Math.random() * 0.4));
      t += 0.10 + Math.random() * 0.13;   // quick succession within a luffing burst
    }
  }

  /** One canvas flap: a soft brown-noise "whump" through a bandpass + lowpass, with a fast swell and snap-decay. */
  private flap(ctx: AudioContext, t: number, peak: number): void {
    const master = this.master;
    if (!master) { return; }
    const dur = 0.22 + Math.random() * 0.22;
    const len = Math.max(1, Math.floor(ctx.sampleRate * (dur + 0.05)));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Brown-ish noise (leaky-integrated white) → a soft canvas "whump", not a hiss.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.04 * w) / 1.04;
      d[i] = Math.max(-1, Math.min(1, last * 3.2));
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 280 + Math.random() * 320; bp.Q.value = 0.8;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.02 + Math.random() * 0.03);  // swell
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);                                            // snap-out
    src.connect(bp); bp.connect(lp); lp.connect(env); env.connect(master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const shared = this.sfx.getSharedContext();
      this.ctx = shared.ctx;
      this.master = shared.master;
    }
    return this.ctx;
  }

  dispose(): void {
    const scene = this.sceneService.scene;
    if (this.observer && scene) { scene.onBeforeRenderObservable.remove(this.observer); }
    this.observer = null;
    // Context + master are shared (owned by SfxService) — not closed here.
    this.ctx = null;
    this.master = null;
  }
}
