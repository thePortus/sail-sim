import { Component, computed, inject, output, signal, OnInit, OnDestroy, ViewChild, HostListener, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VesselService } from '../../services/vessel.service';
import { WeatherService } from '../../services/weather.service';
import { SceneService } from '../../services/scene.service';
import { CannonService } from '../../services/cannon.service';
import { CombatService } from '../../services/combat.service';
import { MultiplayerService } from '../../services/multiplayer.service';
import { SquadronService } from '../../services/squadron.service';
import { SailState } from '../../models';
import { ChatComponent } from '../chat/chat.component';
import { DamageDiagramComponent } from './damage-diagram.component';

@Component({
  selector: 'app-hud',
  standalone: true,
  imports: [CommonModule, ChatComponent, DamageDiagramComponent],
  templateUrl: './hud.component.html',
})
export class HudComponent implements OnInit, OnDestroy {
  vesselService  = inject(VesselService);
  weatherService = inject(WeatherService);
  sceneService   = inject(SceneService);
  cannonService  = inject(CannonService);
  combatService  = inject(CombatService);
  multiplayerService = inject(MultiplayerService);
  squadronService    = inject(SquadronService);
  private zone   = inject(NgZone);

  @ViewChild(ChatComponent) private chat?: ChatComponent;

  /**
   * Global hotkeys: Enter focuses the chat input; "/" focuses it pre-filled with "/".
   * Ignored while any input/textarea is already focused (so typing in chat — or any
   * other field — isn't hijacked).
   */
  @HostListener('window:keydown', ['$event'])
  onGlobalKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.chat?.focusInput();
    } else if (e.key === '/') {
      e.preventDefault();
      this.chat?.focusInput('/');
    }
  }

  vessel  = this.vesselService.state;
  weather = this.weatherService.weather;

  // Wind FROM bearing for compass arrow (SVG rotation)
  windFromDeg = computed(() => this.weather()?.wind.fromBearingDeg ?? 0);

  // Heading in compass cardinal form
  headingCardinal = computed(() => {
    const h = this.vessel().heading;
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(h / 22.5) % 16];
  });

  // Knots: 1 unit/s ≈ 1.94 knots (using 1 unit = 1 m/s)
  speedKnots = computed(() => Math.abs(this.vessel().speed * 1.94).toFixed(1));

  // Wind speed in knots
  windKnots = computed(() => {
    const w = this.weather()?.wind;
    return w ? (w.speed * 1.94).toFixed(1) : '--';
  });

  // ── Sheet / trim helpers ──────────────────────────────────────────────────

  /** Same table as vessel.service optimalSheetAngle() — duplicated for HUD. */
  private optimalSheet(a: number): number {
    if (a < 38)  return 5;
    if (a < 60)  return 18;
    if (a < 90)  return 35;
    if (a < 115) return 52;
    if (a < 145) return 68;
    if (a < 165) return 82;
    return 88;
  }

  /** 0–100 fill for the sheet gauge bar (5°=0%, 88°=100%). */
  sheetFill = computed(() => ((this.vessel().sheetAngle - 5) / 83) * 100);

  /** Marker position for the optimal angle on the gauge. */
  optimalFill = computed(() =>
    ((this.optimalSheet(this.vessel().windAngle) - 5) / 83) * 100);

  /** 0–100 trim quality percentage. */
  trimPct = computed(() => Math.round((this.vessel().trimQuality ?? 1) * 100));

  trimColor = computed(() => {
    const q = this.vessel().trimQuality ?? 1;
    if (q > 0.75) return 'text-green-400';
    if (q > 0.40) return 'text-yellow-400';
    return 'text-red-400';
  });

  trimBarColor = computed(() => {
    const q = this.vessel().trimQuality ?? 1;
    if (q > 0.75) return 'bg-green-500';
    if (q > 0.40) return 'bg-yellow-400';
    return 'bg-red-500';
  });

  // ── Point-of-sail label — thresholds mirror sailEfficiency() ─────────────
  pointOfSail = computed(() => {
    const a = this.vessel().windAngle;
    if (a < 32)  return 'In Irons';
    if (a < 45)  return 'Close Hauled';
    if (a < 60)  return 'Close Reach';
    if (a < 90)  return 'Beam Reach';
    if (a < 145) return 'Broad Reach';
    if (a < 165) return 'Running';
    return 'Dead Downwind';
  });

  sailLabel = computed(() => {
    switch (this.vessel().sailState) {
      case 'reefed':   return 'Sails Furled';
      case 'topsails': return 'Reduced Sail';
      case 'full':     return 'Full Sail';
    }
  });

  // Clock: 12-hour format with AM/PM and a phase icon
  gameTimeStr = computed(() => {
    const h    = this.sceneService.gameTime();
    const hrs  = Math.floor(h);
    const mins = Math.floor((h - hrs) * 60);
    const h12  = hrs === 0 ? 12 : hrs > 12 ? hrs - 12 : hrs;
    const ampm = hrs < 12 ? 'AM' : 'PM';
    return `${h12}:${mins.toString().padStart(2, '0')} ${ampm}`;
  });

  dayPhaseIcon = computed(() => {
    const h = this.sceneService.gameTime();
    // Long summer day: sun up 05:00–21:00 (see SceneService.computeSunDir DAY_START/DAY_END).
    if (h >= 5  && h < 7)  return '🌅';   // sunrise
    if (h >= 7  && h < 19) return '☀️';   // day
    if (h >= 19 && h < 21) return '🌇';   // sunset
    return '🌙';                          // night
  });

  /** Crew readout colour: green when well-crewed, amber/red as casualties mount. */
  crewColor = computed(() => {
    const max = this.combatService.maxCrew();
    if (max <= 0) return 'text-white';
    const f = this.combatService.crew() / max;
    if (f > 0.66) return 'text-green-400';
    if (f > 0.33) return 'text-yellow-400';
    return 'text-red-400';
  });

  grounded  = this.vesselService.grounded;
  anchored  = this.vesselService.anchored;
  exitGame  = output<void>();
  /** Emitted whenever photo mode toggles, so the parent can hide its own chrome (minimap, admin hint). */
  photoModeChange = output<boolean>();

  // ── Fullscreen ────────────────────────────────────────────────────────────
  isFullscreen = signal(!!document.fullscreenElement);
  // Photo mode: fullscreen + every HUD element hidden for a clean screenshot. The photo button itself
  // stays visible (it's the only way back).
  photoMode = signal(false);
  private onFullscreenChange = () => {
    const fs = !!document.fullscreenElement;
    this.isFullscreen.set(fs);
    // Leaving fullscreen (e.g. via Esc) also leaves photo mode, so the HUD reappears.
    if (!fs && this.photoMode()) { this.setPhotoMode(false); }
  };

  /** Set photo mode and notify the parent (so it hides its own chrome too). */
  private setPhotoMode(v: boolean): void {
    if (this.photoMode() === v) { return; }
    this.photoMode.set(v);
    this.photoModeChange.emit(v);
  }

  // Esc leaves photo mode. Registered in the CAPTURE phase so it runs before the bubble-phase
  // window:keydown HostListeners (incl. game.component's Esc→pause), and stopImmediatePropagation blocks
  // them — so Esc exits photo mode WITHOUT also opening the pause menu. Covers the no-fullscreen case too
  // (if the fullscreen request was denied, the fullscreenchange path wouldn't fire).
  private onEscCapture = (e: KeyboardEvent): void => {
    if (e.repeat || e.key !== 'Escape' || !this.photoMode()) { return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    // Registered outside the Angular zone (see ngOnInit) so it doesn't run change detection on every
    // keydown; re-enter the zone for the actual action so the HUD reflects leaving photo mode.
    this.zone.run(() => void this.togglePhotoMode());
  };

  ngOnInit(): void {
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    // Outside the zone: this is a global keydown listener, so leaving it in-zone would fire a change-
    // detection pass on EVERY keypress (incl. held-key repeats) — a main-thread hog that starves the
    // MIDI music scheduler. (vessel.service swallows repeats in the capture phase, but this listener is
    // ALSO capture-phase, so that swallow can't block it — it must opt out of the zone itself.)
    this.zone.runOutsideAngular(() => window.addEventListener('keydown', this.onEscCapture, true));
  }

  ngOnDestroy(): void {
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('keydown', this.onEscCapture, true);
  }

  async toggleFullscreen(): Promise<void> {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen().catch(() => {});
    } else {
      await document.exitFullscreen().catch(() => {});
    }
  }

  /** Photo mode: enter fullscreen + hide the whole HUD (toggle off to restore both). */
  async togglePhotoMode(): Promise<void> {
    const entering = !this.photoMode();
    this.setPhotoMode(entering);
    if (entering) {
      if (!document.fullscreenElement) { await document.documentElement.requestFullscreen().catch(() => {}); }
    } else if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }
  }

  setSail(state: SailState): void {
    this.vesselService.setSailState(state);
  }

  toggleAnchor(): void {
    this.vesselService.toggleAnchor();
  }

  // ── Gunnery ─────────────────────────────────────────────────────────────────
  fireGun(side: 'port' | 'stbd'): void {
    this.cannonService.armOrFire(side);
  }

  /** Button label per gun state. */
  gunLabel(state: string): string {
    switch (state) {
      case 'arming':    return 'Running out…';
      case 'ready':     return 'FIRE!';
      case 'firing':    return 'Firing…';
      case 'reloading': return 'Reloading…';
      default:          return 'Run out';
    }
  }

  /** Active/highlight class per gun state (reuses the sail-btn active styling). */
  gunBtnClass(state: string): string {
    return state === 'ready' ? 'sail-btn--active' : '';
  }

  /** [0..gunCount) — one entry per cannon on a side, for the "ready cannons" pip readout. */
  pipArray(): number[] {
    return Array.from({ length: this.cannonService.gunCount() }, (_, i) => i);
  }

  refloat(): void {
    this.vesselService.refloat();
  }

  // ── Squadrons (Phase B) ─────────────────────────────────────────────────────
  acceptSquadron(): void  { this.multiplayerService.squadronAccept(); }
  declineSquadron(): void { this.multiplayerService.squadronDecline(); }
  leaveSquadron(): void   { this.multiplayerService.squadronLeave(); }

  exit(): void {
    this.exitGame.emit();
  }
}
