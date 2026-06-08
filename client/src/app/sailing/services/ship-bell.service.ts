import { Injectable, inject } from '@angular/core';
import { Observer, Scene } from '@babylonjs/core';
import { SceneService } from './scene.service';
import { SfxService } from './sfx.service';

/**
 * Ship's bell ambience: a brief "clang clang" at the four watch marks — midnight, dawn, noon and dusk
 * (gameTime 0 / 6 / 12 / 18). The bell is synthesised on the fly (inharmonic struck-bell partials), like
 * the rain/thunder beds, and routed through SfxService so it follows the SFX volume. `?nobells` skips it.
 *
 * The day clock (SceneService.gameTime, 0–24h) advances ~1 game-hour per real minute, so a render-loop
 * observer polls it and rings whenever it crosses one of the marks. A large clock jump (server time sync)
 * is ignored so a re-sync can't trigger a spurious clang.
 */
@Injectable({ providedIn: 'root' })
export class ShipBellService {
  private sceneService = inject(SceneService);
  private sfx          = inject(SfxService);

  private observer: Observer<Scene> | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;   // the SHARED SFX master (owned by SfxService, not closed here)

  private static readonly MARKS = [0, 6, 12, 18];   // midnight, dawn, noon, dusk (game hours)
  private prevHours = -1;

  init(): void {
    const scene = this.sceneService.scene;
    if (!scene || this.observer) { return; }
    this.observer = scene.onBeforeRenderObservable.add(() => this.tick());
  }

  private tick(): void {
    const cur  = this.sceneService.gameTime();
    const prev = this.prevHours;
    this.prevHours = cur;
    if (prev < 0) { return; }                       // first frame: establish a baseline, never ring
    let delta = cur - prev;
    if (delta < 0) { delta += 24; }                 // wrapped past midnight
    if (delta <= 0 || delta > 1.0) { return; }      // no advance, or a big jump (clock re-sync) → skip
    for (const mark of ShipBellService.MARKS) {
      // Did the clock cross `mark` going forward in (prev, cur]? (handle the midnight wrap)
      const crossed = prev < cur ? (prev < mark && mark <= cur) : (mark > prev || mark <= cur);
      if (crossed) { this.ring(); break; }
    }
  }

  /** A brief "clang … clang" — two strikes of a synthetic bell. */
  private ring(): void {
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const t0 = ctx.currentTime + 0.02;
    this.strike(ctx, t0);
    this.strike(ctx, t0 + 0.5);
  }

  /** One bell strike: inharmonic sine partials with a sharp attack + exponential ring-out, plus a short
   *  band-passed noise transient for the metallic "clang". */
  private strike(ctx: AudioContext, t: number): void {
    const master = this.master;
    if (!master) { return; }
    const f0 = 920;                                  // higher pitch — brighter, "clangier" bell
    // [ratio, relative gain, decay seconds] — clangier: the upper inharmonic partials are louder and the
    // whole thing rings out much longer than a plain hum.
    const partials: readonly [number, number, number][] = [
      [1.00, 1.00, 3.0],
      [2.00, 0.70, 2.5],
      [2.76, 0.62, 2.1],
      [4.07, 0.46, 1.6],
      [5.43, 0.34, 1.3],
      [6.80, 0.24, 1.0],
    ];
    const out = ctx.createGain();
    out.gain.value = 0.22;                           // headroom: the partials sum to ~3.4 at the strike peak
    out.connect(master);

    for (const [ratio, g, dec] of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f0 * ratio;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(g, t + 0.004);     // sharp strike
      env.gain.exponentialRampToValueAtTime(0.0001, t + dec);  // ring-out
      osc.connect(env); env.connect(out);
      osc.start(t);
      osc.stop(t + dec + 0.05);
    }

    // Metallic strike transient.
    const len = Math.max(1, Math.floor(ctx.sampleRate * 0.05));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) { d[i] = (Math.random() * 2 - 1) * (1 - i / len); }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f0 * 3; bp.Q.value = 0.8;
    const ng = ctx.createGain(); ng.gain.value = 0.7;
    src.connect(bp); bp.connect(ng); ng.connect(out);
    src.start(t); src.stop(t + 0.06);
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const shared = this.sfx.getSharedContext();   // shared lightweight-SFX context (within the ~6 cap)
      this.ctx = shared.ctx;
      this.master = shared.master;
    }
    return this.ctx;
  }

  dispose(): void {
    const scene = this.sceneService.scene;
    if (this.observer && scene) { scene.onBeforeRenderObservable.remove(this.observer); }
    this.observer = null;
    // The context + master are SHARED (owned by SfxService) — don't close/release them here.
    this.ctx = null;
    this.master = null;
    this.prevHours = -1;
  }
}
