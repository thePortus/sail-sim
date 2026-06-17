import { Injectable, inject } from '@angular/core';
import { SceneService } from './scene.service';
import { SfxService } from './sfx.service';

/**
 * "By the board!" — the drawn-out timber-cracking groan of a mast carrying away. Synthesised on the fly
 * (like the ship's bell / rain beds) and routed through SfxService so it follows the SFX volume. Fired by
 * VesselService (own ship) and MultiplayerService (remotes) the instant a ship's masts-zone HP crosses to
 * zero — a one-shot, distance-attenuated for remotes via the active camera.
 *
 * The sound is a ~2.5 s creaking-timber bed under a volley of irregular wood cracks (a big initial snap,
 * splintering reports tapering off, then a heavier final crash as the spar comes down).
 */
@Injectable({ providedIn: 'root' })
export class MastCrackService {
  private sceneService = inject(SceneService);
  private sfx          = inject(SfxService);

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;   // the SHARED SFX master (owned by SfxService, not closed here)

  /** Play the demasting crack at world (x,z), attenuated by the camera's distance (remote ships). */
  crackAt(x: number, z: number): void {
    const cam = this.sceneService.scene?.activeCamera;
    if (!cam) { return; }
    const dx = cam.position.x - x, dz = cam.position.z - z;
    const vol = Math.max(0, 1 - Math.hypot(dx, dz) / 700);   // audible across the bay, fading with range
    this.crack(vol);
  }

  /** Play the demasting crack at an explicit volume (1 = own ship, full). */
  crack(vol: number): void {
    const v = Math.max(0, Math.min(1, vol));
    if (v <= 0.01) { return; }
    const ctx = this.ensureCtx();
    const master = this.master;
    if (!master) { return; }
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }

    const out = ctx.createGain();
    out.gain.value = v * 0.6;   // headroom for overlapping cracks (the shared master has no limiter)
    out.connect(master);
    const t0 = ctx.currentTime + 0.02;

    // Creaking-timber bed under the whole collapse (the mast straining and tearing free).
    this.groan(ctx, out, t0, 2.4);

    // A volley of irregular wood cracks: a big initial snap, then splintering reports tapering off.
    const beats = [0.0, 0.16, 0.4, 0.72, 1.08, 1.45, 1.9, 2.25];
    for (let i = 0; i < beats.length; i++) {
      const jitter    = (Math.random() - 0.5) * 0.06;
      const intensity = i === 0 ? 1.0 : Math.max(0.25, 0.9 - i * 0.07 + (Math.random() - 0.5) * 0.2);
      this.woodCrack(ctx, out, t0 + beats[i] + jitter, intensity);
    }
    // Heavier final crash — the spar hits the deck / goes into the sea.
    this.woodCrack(ctx, out, t0 + 2.5, 1.15);
  }

  /** One wood crack: a sharp band-passed noise report plus a low woody thud for body. */
  private woodCrack(ctx: AudioContext, out: GainNode, t: number, intensity: number): void {
    // Filtered-noise report (the splinter/snap).
    const len = Math.max(1, Math.floor(ctx.sampleRate * 0.14));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) { d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2); }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 220 + Math.random() * 750;
    bp.Q.value = 1.4 + Math.random() * 3;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.6 * intensity, t + 0.003);   // sharp crack
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.09 + Math.random() * 0.06);
    src.connect(bp); bp.connect(ng); ng.connect(out);
    src.start(t); src.stop(t + 0.25);

    // Low woody thud (the timber's body).
    const osc = ctx.createOscillator(); osc.type = 'triangle';
    osc.frequency.setValueAtTime(110 + Math.random() * 70, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.13);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.5 * intensity, t + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.connect(og); og.connect(out);
    osc.start(t); osc.stop(t + 0.22);
  }

  /** Creaking-timber bed: brown noise through a low-pass whose cutoff a slow LFO wobbles (the groan). */
  private groan(ctx: AudioContext, out: GainNode, t: number, dur: number): void {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 5;

    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 2.3;
    const lfoG = ctx.createGain(); lfoG.gain.value = 170;
    lfo.connect(lfoG); lfoG.connect(lp.frequency);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.25);
    g.gain.setValueAtTime(0.2, t + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp); lp.connect(g); g.connect(out);
    lfo.start(t); lfo.stop(t + dur);
    src.start(t); src.stop(t + dur);
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const shared = this.sfx.getSharedContext();   // shared lightweight-SFX context (within the ~6 cap)
      this.ctx = shared.ctx;
      this.master = shared.master;
    }
    return this.ctx;
  }
}
