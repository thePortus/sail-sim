import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { Zone, ZoneState, Severity, severityFor, ZONE_HP } from './combat.constants';

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

  /** Per-zone MAX HP for the local vessel (from combat_state); sizes the HUD severity bands. */
  readonly maxHp = signal<ZoneState>({ ...ZONE_HP });

  /** True while the local ship is sunk (shows the sunk overlay until confirmed). */
  readonly sunk   = signal(false);
  readonly sunkBy = signal<string>('');

  // ── Crew resource (C1/C2) — local sailor count + the efficiency factor it drives ───────────────────────
  /** Remaining sailors aboard / full complement (authoritative, from the server's crew_state). */
  readonly crew    = signal<number>(0);
  readonly maxCrew = signal<number>(0);
  /** Crew-efficiency factor 0.5..1 (floor 0.5 with no crew, 1.0 fully manned). Scales sail speed, turn rate,
   *  and reload time; the server scales mast-repair duration with the same formula. */
  // Crew-efficiency factor — MIRRORS server combat-constants.crewEfficiency (the authoritative curve;
  // keep the three constants in lockstep with it and native sail::crewEfficiency). A ship does NOT need
  // every hand: at/above CREW_KNEE of complement there's no penalty at all. Below that the effect ramps
  // in and bites harder as the crew thins, bottoming out at CREW_FLOOR so a skeleton crew is crippled
  // but still limps home. Scales sail drive, helm/turn rate and the gun reload window.
  private readonly CREW_KNEE  = 0.85;
  private readonly CREW_FLOOR = 0.33;   // floor: still makes 33% speed / ~3x reload
  private readonly CREW_EXP   = 1.25;
  readonly crewFactor = computed(() => {
    const max = this.maxCrew();
    if (max <= 0) return 1;
    const r = Math.max(0, Math.min(1, this.crew() / max));
    if (r >= this.CREW_KNEE) return 1;
    return this.CREW_FLOOR + (1 - this.CREW_FLOOR) * Math.pow(r / this.CREW_KNEE, this.CREW_EXP);
  });
  /** Apply an authoritative crew count from the server. */
  setCrew(crew: number, maxCrew: number): void {
    this.zoneNg.run(() => { this.crew.set(Math.max(0, crew)); this.maxCrew.set(Math.max(0, maxCrew)); });
  }

  /** Mast jury-rig progress for the HUD repair bar: null = not repairing, 0..1 = filling. Driven by the
   *  server-supplied duration (mast_repair message) so it stays accurate when crew later makes it variable. */
  readonly mastRepairProgress = signal<number | null>(null);
  private repairStart = 0;
  private repairDur   = 0;
  private repairTimer: ReturnType<typeof setInterval> | null = null;

  /** Apply an authoritative hull state from the server (+ the vessel's per-zone max HP). */
  setLocalZones(z: ZoneState, maxHp?: ZoneState): void {
    this.zoneNg.run(() => {
      this.zones.set({ ...z });
      if (maxHp) this.maxHp.set({ ...maxHp });
    });
    // The jury-rig is done the instant masts HP rises above 0 (authoritative) — clear the bar.
    if ((z.masts ?? 0) > 0) this.stopMastRepair();
  }

  /** Server told us a mast jury-rig started and how long it takes (ms). Run the HUD progress bar over it. */
  startMastRepair(ms: number): void {
    if (!(ms > 0)) return;
    this.repairStart = Date.now();
    this.repairDur   = ms;
    if (this.repairTimer) clearInterval(this.repairTimer);
    this.zoneNg.run(() => this.mastRepairProgress.set(0));
    this.repairTimer = setInterval(() => {
      const p = Math.min(1, (Date.now() - this.repairStart) / this.repairDur);
      this.zoneNg.run(() => this.mastRepairProgress.set(p));
      if (p >= 1 && this.repairTimer) { clearInterval(this.repairTimer); this.repairTimer = null; }  // hold full until masts>0 clears it
    }, 120);
  }

  private stopMastRepair(): void {
    if (this.repairTimer) { clearInterval(this.repairTimer); this.repairTimer = null; }
    if (this.mastRepairProgress() !== null) this.zoneNg.run(() => this.mastRepairProgress.set(null));
  }

  /** Local ship was sunk by `by` (callsign). */
  markSunk(by: string): void {
    this.stopMastRepair();   // a sinking ship doesn't jury-rig
    this.zoneNg.run(() => { this.sunk.set(true); this.sunkBy.set(by || 'another ship'); });
  }

  /** Dismiss the sunk overlay (after the server has restored full HP). */
  clearSunk(): void {
    this.zoneNg.run(() => this.sunk.set(false));
  }

  /** Severity band for a zone (drives the HUD colour), sized to the local vessel's max HP. */
  severity(zone: Zone): Severity {
    const z = this.zones();
    return z ? severityFor(zone, z[zone], this.maxHp()) : 'none';
  }

  /** Reset to undamaged (e.g. on disconnect). */
  reset(): void {
    this.stopMastRepair();
    this.zoneNg.run(() => this.zones.set(null));
  }
}
