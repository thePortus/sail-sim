import { Injectable, signal } from '@angular/core';

/**
 * Central volume control for procedural sound effects (cannon fire, splashes,
 * thunder, rain ambience, …), independent of the music volume.
 *
 * Each SFX-producing service owns its own AudioContext; it registers that
 * context here to get a master GainNode (routed to the speakers) and connects
 * all of its sounds to that node instead of ctx.destination. Changing the volume
 * updates every registered master gain live, so even continuous beds (rain)
 * respond immediately.
 */
@Injectable({ providedIn: 'root' })
export class SfxService {
  private static readonly STORAGE_KEY = 'sfx-volume';

  private readonly _volume = signal(this.loadVolume());
  /** Reactive SFX volume in [0, 1] for the UI to bind to. */
  readonly volume = this._volume.asReadonly();

  // One master gain per registered AudioContext.
  private readonly masters = new Set<GainNode>();

  // A single shared AudioContext + master for LIGHTWEIGHT procedural SFX (ship's bell, sail flaps, …).
  // Browsers cap a page at ~6 AudioContexts; the heavier beds (rain, ocean, cannon, gulls, music/Tone)
  // already own most of those slots, so small one-shot effects share this one instead of each grabbing
  // a slot (a 7th `new AudioContext()` throws). Created lazily on first use.
  private sharedCtx: AudioContext | null = null;
  private sharedMaster: GainNode | null = null;

  private loadVolume(): number {
    const raw = parseFloat(localStorage.getItem(SfxService.STORAGE_KEY) ?? '0.8');
    return isNaN(raw) ? 0.8 : Math.max(0, Math.min(1, raw));
  }

  getVolume(): number { return this._volume(); }

  setVolume(v: number): void {
    const vol = Math.max(0, Math.min(1, v));
    this._volume.set(vol);
    localStorage.setItem(SfxService.STORAGE_KEY, String(vol));
    for (const g of this.masters) {
      // Smooth ramp avoids clicks on continuous beds.
      g.gain.setTargetAtTime(vol, g.context.currentTime, 0.05);
    }
  }

  /**
   * Create a master GainNode for the given context (connected to its
   * destination) at the current SFX volume. Route all SFX through the returned
   * node. Tracked so volume changes apply live.
   */
  createMaster(ctx: AudioContext): GainNode {
    const g = ctx.createGain();
    g.gain.value = this._volume();
    g.connect(ctx.destination);
    this.masters.add(g);
    return g;
  }

  /** Stop tracking a master gain (call when its context is closed). */
  releaseMaster(node: GainNode | null): void {
    if (node) this.masters.delete(node);
  }

  /**
   * The shared AudioContext (lazily created once). All SFX producers route through this single context
   * so the page never approaches the browser's ~6-context cap. Callers must NOT close it — it is owned
   * here and lives for the app's lifetime. Each producer makes its OWN master via createMaster(ctx) (so
   * it can tear down independently), and stops its own looping sources on dispose.
   */
  getSharedAudioContext(): AudioContext {
    if (!this.sharedCtx) { this.sharedCtx = new AudioContext(); }
    return this.sharedCtx;
  }

  /**
   * The shared context plus a SHARED master gain (also lazily created once), for tiny one-shot producers
   * (ship's bell, sail flaps) that don't need their own sub-mix. Don't close the context or release this
   * master — both are owned here.
   */
  getSharedContext(): { ctx: AudioContext; master: GainNode } {
    const ctx = this.getSharedAudioContext();
    if (!this.sharedMaster) { this.sharedMaster = this.createMaster(ctx); }
    return { ctx, master: this.sharedMaster };
  }
}
