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
}
