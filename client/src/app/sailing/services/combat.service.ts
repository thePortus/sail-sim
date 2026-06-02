import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Zone, ZoneState, Severity, severityFor } from './combat.constants';

/**
 * Holds the LOCAL player's authoritative hull damage, pushed by the server's
 * `combat_state` message. The HUD damage diagram reads `severity(zone)`.
 * The server owns the numbers; this is a read-model for the UI.
 */
@Injectable({ providedIn: 'root' })
export class CombatService {
  private zoneNg = inject(NgZone);

  /** Per-zone HP, or null until the first hit syncs state. */
  readonly zones = signal<ZoneState | null>(null);

  /** True while the local ship is sunk (shows the sunk overlay until confirmed). */
  readonly sunk   = signal(false);
  readonly sunkBy = signal<string>('');

  /** Apply an authoritative hull state from the server. */
  setLocalZones(z: ZoneState): void {
    this.zoneNg.run(() => this.zones.set({ ...z }));
  }

  /** Local ship was sunk by `by` (callsign). */
  markSunk(by: string): void {
    this.zoneNg.run(() => { this.sunk.set(true); this.sunkBy.set(by || 'another ship'); });
  }

  /** Dismiss the sunk overlay (after the server has restored full HP). */
  clearSunk(): void {
    this.zoneNg.run(() => this.sunk.set(false));
  }

  /** Severity band for a zone (drives the HUD colour). */
  severity(zone: Zone): Severity {
    const z = this.zones();
    return z ? severityFor(zone, z[zone]) : 'none';
  }

  /** Reset to undamaged (e.g. on disconnect). */
  reset(): void {
    this.zoneNg.run(() => this.zones.set(null));
  }
}
