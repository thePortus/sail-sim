import {
  Component, ElementRef, ViewChild,
  AfterViewInit, OnDestroy, inject, signal, effect,
  HostListener, untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { catchError, of } from 'rxjs';

import { SceneService }       from '../sailing/services/scene.service';
import { OceanService }       from '../sailing/services/ocean.service';
import { OceanFFTEngine }      from '../sailing/services/ocean-fft-engine.service';
import { OceanFFTRenderer }    from '../sailing/services/ocean-fft-renderer.service';
import { TerrainService }     from '../sailing/services/terrain.service';
import { VesselService }      from '../sailing/services/vessel.service';
import { WeatherService }     from '../sailing/services/weather.service';
import { CloudService }       from '../sailing/services/cloud.service';
import { ScatterService }     from '../sailing/services/scatter/scatter.service';
import { MultiplayerService } from '../sailing/services/multiplayer.service';
import { CannonService }       from '../sailing/services/cannon.service';
import { CombatService }       from '../sailing/services/combat.service';
import { MusicService }        from '../sailing/services/music.service';
import { AuthService }        from '../services/auth.service';

import { HudComponent }            from '../sailing/components/hud/hud.component';
import { MinimapComponent }        from '../sailing/components/minimap/minimap.component';
import { VesselSelectorComponent } from '../sailing/components/vessel-selector/vessel-selector.component';
import { AdminPanelComponent }     from '../sailing/components/admin-panel/admin-panel.component';
import { PauseMenuComponent }      from '../sailing/components/pause-menu/pause-menu.component';
import { SettingsMenuComponent }   from '../sailing/components/settings-menu/settings-menu.component';

import { Vessel } from '../sailing/models';
import { Settings } from '../app.settings';

type GamePhase = 'selecting' | 'initializing' | 'sailing';

@Component({
  selector: 'app-game',
  standalone: true,
  imports: [CommonModule, HudComponent, MinimapComponent, VesselSelectorComponent, AdminPanelComponent, PauseMenuComponent, SettingsMenuComponent],
  template: `
    <div class="game-root">
      <!-- BabylonJS canvas -->
      <canvas #gameCanvas class="game-canvas"
              [class.game-canvas--visible]="phase() === 'sailing'"></canvas>

      <!-- Vessel selection screen -->
      @if (phase() === 'selecting') {
        <app-vessel-selector (vesselSelected)="onVesselSelected($event)" />
      }

      <!-- Kicked / banned notice (prominent, dismissable) -->
      @if (kickedNotice()) {
        <div class="kick-notice-backdrop" (click)="dismissKicked()">
          <div class="kick-notice" (click)="$event.stopPropagation()">
            <div class="kick-notice-icon">⚓</div>
            <div class="kick-notice-title">Disconnected</div>
            <div class="kick-notice-text">{{ kickedNotice() }}</div>
            <button class="kick-notice-btn" (click)="dismissKicked()">Dismiss</button>
          </div>
        </div>
      }

      <!-- Loading overlay -->
      @if (phase() === 'initializing') {
        <div class="loading-overlay">
          <div class="text-5xl mb-4">⛵</div>
          <div class="text-white text-xl font-light tracking-widest mb-3">Setting sail…</div>
          <div class="w-48 h-1 bg-white/10 rounded-full overflow-hidden">
            <div class="h-full bg-blue-400 rounded-full animate-pulse" style="width: 60%"></div>
          </div>
          <div class="text-slate-500 text-sm mt-4 font-mono">{{ loadingMsg() }}</div>
        </div>
      }

      <!-- In-game HUD -->
      @if (phase() === 'sailing') {
        <app-hud (exitGame)="onExitGame()" />

        <!-- Pause menu — shown when Esc is pressed -->
        @if (paused()) {
          <app-pause-menu (resume)="onResume()" (quit)="onExitGame()"
                          (openSettings)="showSettings.set(true)" />
        }
        <!-- Settings panel — opened from the pause menu -->
        @if (showSettings()) {
          <app-settings-menu (close)="showSettings.set(false)" />
        }
        <div class="minimap-anchor">
          <app-minimap />
        </div>

        @if (isAdmin) {
          <app-admin-panel #adminPanel />
          <div class="admin-hint">Press <kbd>&#96;</kbd> for admin controls</div>
        }

        <!-- Sunk overlay — acknowledge to restore the hull to full -->
        @if (combatService.sunk()) {
          <div class="sunk-backdrop">
            <div class="sunk-card">
              <div class="sunk-icon">🌊</div>
              <div class="sunk-title">Your ship was sunk</div>
              <div class="sunk-text">Sent to the depths by {{ combatService.sunkBy() }}.</div>
              <button class="sunk-btn" (click)="onConfirmSunk()">Repair &amp; Sail On</button>
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .sunk-backdrop { position: absolute; inset: 0; z-index: 220; display: flex;
                     align-items: center; justify-content: center;
                     background: rgba(4, 10, 20, 0.78); backdrop-filter: blur(5px); }
    .sunk-card { background: rgba(10, 20, 34, 0.96); border: 1px solid rgba(248,81,73,0.35);
                 border-radius: 16px; padding: 32px 40px; text-align: center; max-width: 380px;
                 box-shadow: 0 18px 60px rgba(0,0,0,0.6); }
    .sunk-icon  { font-size: 3rem; margin-bottom: 8px; }
    .sunk-title { color: #f85149; font-size: 1.4rem; font-weight: 600; margin-bottom: 8px; }
    .sunk-text  { color: #cfe3f5; opacity: 0.8; margin-bottom: 22px; font-family: ui-monospace, monospace; }
    .sunk-btn   { padding: 10px 22px; border-radius: 10px; border: 1px solid rgba(96,165,250,0.5);
                  background: rgba(59,130,246,0.22); color: #dbeafe; font-weight: 600; cursor: pointer;
                  transition: all 0.15s; }
    .sunk-btn:hover { background: rgba(59,130,246,0.38); }
    .game-root   { position: fixed; inset: 0; background: #08111e; overflow: hidden; }
    .game-canvas { position: absolute; inset: 0; width: 100%; height: 100%;
                   opacity: 0; transition: opacity 0.8s ease; }
    .game-canvas--visible { opacity: 1; }
    .loading-overlay { position: absolute; inset: 0; display: flex; flex-direction: column;
                        align-items: center; justify-content: center;
                        background: radial-gradient(ellipse at center, #0d2240 0%, #08111e 70%); }
    .minimap-anchor { position: absolute; bottom: 1.5rem; right: 1.5rem; z-index: 50; }
    .admin-hint {
      position: absolute; bottom: 1.5rem; left: 1.5rem; z-index: 50;
      font-family: monospace; font-size: 10px; color: rgba(255,255,255,0.22);
      pointer-events: none; letter-spacing: 0.04em;
    }
    .admin-hint kbd {
      display: inline-block; padding: 0 4px; border-radius: 3px;
      border: 1px solid rgba(255,255,255,0.18); color: rgba(255,255,255,0.35);
    }
  `],
})
export class GameComponent implements AfterViewInit, OnDestroy {
  @ViewChild('gameCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private http               = inject(HttpClient);
  private router             = inject(Router);
  private authService        = inject(AuthService);
  private sceneService       = inject(SceneService);
  private oceanService       = inject(OceanService);
  private oceanFftEngine      = inject(OceanFFTEngine);
  private oceanFftRenderer     = inject(OceanFFTRenderer);
  private terrainService     = inject(TerrainService);
  private vesselService      = inject(VesselService);
  private weatherService     = inject(WeatherService);
  private cloudService       = inject(CloudService);
  private scatterService     = inject(ScatterService);
  private multiplayerService = inject(MultiplayerService);
  protected combatService    = inject(CombatService);
  readonly cannonService      = inject(CannonService);    // public: template reads signals
  readonly musicService       = inject(MusicService);    // public: PauseMenuComponent also injects it

  phase      = signal<GamePhase>('selecting');
  paused       = signal<boolean>(false);
  showSettings = signal<boolean>(false);
  loadingMsg = signal('Charting the archipelago…');

  @HostListener('window:keydown.escape')
  onEscKey(): void {
    if (this.phase() !== 'sailing') return;
    // Esc backs out of Settings first; then stands down an armed gun; then pause.
    if (this.showSettings()) {
      this.showSettings.set(false);
      return;
    }
    if (this.cannonService.anyCancellable()) {
      this.cannonService.cancel();
      return;
    }
    this.paused.update(v => !v);
  }

  /** True if the logged-in user has admin or owner role — controls admin panel visibility. */
  isAdmin = false;

  private selectedSlug = '';
  private callsign     = '';
  private saveInterval: ReturnType<typeof setInterval> | null = null;

  // Wire weather → ocean + vessel
  constructor() {
    // Resolve admin role from localStorage (inject() context is live here)
    try {
      const raw = this.authService.getUserDetails();
      if (raw) {
        const data = JSON.parse(raw);
        const role = (data?.role ?? '').toLowerCase();
        this.isAdmin = role === 'admin' || role === 'owner';
      }
    } catch { /* malformed userData — leave isAdmin false */ }

    effect(() => {
      const w = this.weatherService.weather();
      if (!w) return;
      // Gameplay-critical first: the vessel MUST get its wind every tick or it can't sail.
      this.vesselService.updateWeather(w.wind, w.sea);
      this.oceanService.updateWeather(w.wind, w.sea);
      this.sceneService.updateSkyFromWeather(w);
      this.sceneService.updateFogDensity(w.fog.density);
      this.cloudService.updateWeather(w);
      // FFT ocean spectrum is cosmetic — never let it abort the effect above.
      try { this.oceanFftEngine.updateWeather(w.wind, w.sea); }
      catch (err) { console.warn('[OceanFFT] updateWeather failed (ignored):', err); }
    });

    // Day/night clock is server-authoritative — apply the server's offset so every
    // client shares one time of day (and admin time changes hit the whole server).
    effect(() => {
      this.sceneService.setServerTimeOffset(this.weatherService.timeOffsetSec());
    });

    // Wire vessel state → multiplayer broadcast
    effect(() => {
      const vs = this.vesselService.state();
      this.multiplayerService.updateLocalState(
        vs.x, vs.z, vs.heading, vs.speed, vs.sailState, 'Sloop', this.selectedSlug,
        vs.turnRate ?? 0, vs.sheetAngle, vs.isPortTack, vs.anchored, vs.anchorSide,
      );
    });

    // Kicked by the server (duplicate login, /kick, or /ban) — tear down this session,
    // return to the selection screen, and show a prominent dismissable notice.
    effect(() => {
      const reason = this.multiplayerService.kickedReason();
      if (!reason) return;
      untracked(() => {
        if (this.phase() !== 'selecting') this.onExitGame();
        this.kickedNotice.set(reason);
      });
    });
  }

  // Prominent "you were disconnected" banner (kick/ban/duplicate-login).
  kickedNotice = signal<string | null>(null);
  dismissKicked(): void {
    this.kickedNotice.set(null);
    this.multiplayerService.kickedReason.set(null);
  }

  ngAfterViewInit(): void {
    // Scene initialises only after vessel selection (canvas not yet visible)
  }

  async onVesselSelected(event: { slug: string }): Promise<void> {
    this.selectedSlug = event.slug;
    // Read the permanent callsign from stored credentials
    try {
      const raw = this.authService.getUserDetails();
      this.callsign = raw ? (JSON.parse(raw)?.callsign || 'Sailor').trim() : 'Sailor';
    } catch {
      this.callsign = 'Sailor';
    }
    this.phase.set('initializing');

    try {
      await this.runInitStep('verify-auth', 'Verifying credentials…', async () => {
        await firstValueFrom(this.http.get(`${Settings.apiUrl}user/me`));
      });

      // 1. Boot BabylonJS scene (WebGPU/WebGL)
      await this.runInitStep('init-scene', 'Preparing the ocean…', async () => {
        await this.sceneService.initAsync(this.canvasRef.nativeElement);
      });

      // 2. Build ocean + atmosphere
      await this.runInitStep('init-ocean-clouds', 'Preparing the ocean…', async () => {
        await this.oceanService.init();
        // FFT ocean compute core (WebGPU only; no-op on WebGL). Phase 1: runs the cascades
        // live so the pipeline is verifiable — the render swap that consumes it is Phase 3.
        this.oceanFftEngine.init();
        // Build the FFT ocean surface (clipmap + PBR material), disabled. Ctrl+Shift+O
        // A/Bs it against the procedural ocean while the rewrite is in progress.
        this.oceanFftRenderer.init();
        this.cloudService.init();
      });

      // 3. Load terrain
      await this.runInitStep('init-terrain', 'Surveying the coastline…', async () => {
        await this.terrainService.init();
      });

      // 3b. Asset scattering (grass/trees/butterflies) — needs the terrain ready.
      await this.runInitStep('init-scatter', 'Planting the wilds…', async () => {
        await this.scatterService.init();
      });

      // 4. Fetch vessel
      const vessel = await this.runInitStep('fetch-vessel', 'Rigging your vessel…', async () => {
        return await firstValueFrom(
          this.http.get<Vessel>(`${Settings.apiUrl}vessels/${this.selectedSlug}`),
        );
      });

      // 5. Determine spawn.
      // First-time players start at the world origin (0, 0) — the map centre.
      // If (0, 0) happens to be on land, find the nearest navigable water.
      let spawnX: number;
      let spawnZ: number;
      let spawnHeading: number;

      if (!this.terrainService.isOnLand(0, 0)) {
        spawnX = 0; spawnZ = 0; spawnHeading = 270;
      } else {
        const s = this.terrainService.nearestSpawn(0, 0);
        spawnX = s.spawnX; spawnZ = s.spawnZ; spawnHeading = s.heading;
      }

      const saved = await this.runInitStep('load-player-location', 'Checking your last anchorage…', async () => {
        return await firstValueFrom(
          this.http.get<{ x: number; z: number; heading: number } | null>(
            `${Settings.apiUrl}player-location/${encodeURIComponent(this.callsign)}`,
          ).pipe(catchError(() => of(null))),
        );
      });

      if (saved && typeof saved.x === 'number') {
        if (!this.terrainService.isOnLand(saved.x, saved.z)) {
          spawnX = saved.x;
          spawnZ = saved.z;
          spawnHeading = saved.heading ?? 270;
          this.loadingMsg.set('Returning to your last anchorage…');
        } else {
          const safe = this.terrainService.nearestSpawn(saved.x, saved.z);
          spawnX = safe.spawnX;
          spawnZ = safe.spawnZ;
          spawnHeading = safe.heading;
          this.loadingMsg.set('Relocating you to safe waters…');
        }
      }

      await this.runInitStep('init-vessel', 'Rigging your vessel…', async () => {
        await this.vesselService.init(vessel, spawnX, spawnZ, spawnHeading);
      });

      await this.runInitStep('init-cannons', 'Arming the cannons…', async () => {
        this.cannonService.init();
      });

      await this.runInitStep('init-music', 'Tuning the instruments…', async () => {
        this.musicService.init(Settings.apiUrl);
      });

      await this.runInitStep('start-weather', 'Reading the wind…', async () => {
        this.weatherService.start();
      });

      await this.runInitStep('connect-multiplayer', 'Raising signal flags…', async () => {
        this.multiplayerService.connect(this.callsign);
      });

      this.saveInterval = setInterval(() => this.saveLocation(), 30_000);
      this.phase.set('sailing');

      // Build the physical atmosphere LAST — after every scene material has compiled — so its
      // construction can't corrupt their WebGPU GLSL→SPIR-V compile (varying-location failures).
      // Fire-and-forget: it waits for scene-ready internally and falls back to the Preetham sky.
      void this.sceneService.activateAtmosphere();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[GameInit] Fatal startup error:', err);
      this.loadingMsg.set('Startup failed. Check browser console for [GameInit] logs.');
      this.phase.set('selecting');
      return;
    }
  }

  private async runInitStep<T>(tag: string, message: string, fn: () => Promise<T>): Promise<T> {
    this.loadingMsg.set(message);
    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[GameInit:${tag}]`, err);
      throw err;
    }
  }

  /** PUT the current position to the server so it survives a reload. */
  private saveLocation(): void {
    if (!this.callsign) return;
    const vs = this.vesselService.state();
    this.http.put(
      `${Settings.apiUrl}player-location/${encodeURIComponent(this.callsign)}`,
      { x: vs.x, z: vs.z, heading: vs.heading, vesselSlug: this.selectedSlug },
    ).subscribe();
  }

  /** Full teardown of the running game — safe to call from both exit and destroy. */
  private teardown(): void {
    if (this.phase() !== 'sailing') return;   // nothing to tear down if we never sailed
    this.saveLocation();
    if (this.saveInterval) { clearInterval(this.saveInterval); this.saveInterval = null; }
    this.weatherService.stop();
    this.multiplayerService.disconnect();
    this.cannonService.dispose();
    this.musicService.dispose();
    this.cloudService.dispose();
    this.terrainService.dispose();
    this.vesselService.dispose();
    this.sceneService.dispose();
  }

  /** Called by the pause menu Resume button or Esc toggle. */
  onResume(): void {
    this.paused.set(false);
    this.showSettings.set(false);
  }

  /** Acknowledge a sinking → ask the server to restore the hull to full. */
  onConfirmSunk(): void {
    this.multiplayerService.requestCombatReset();
  }

  /** Called by the HUD exit button or pause menu — tears down the scene and returns to vessel selection. */
  onExitGame(): void {
    this.paused.set(false);
    this.showSettings.set(false);
    this.teardown();
    this.selectedSlug = '';
    this.callsign     = '';
    this.loadingMsg.set('Charting the archipelago…');
    this.phase.set('selecting');
  }

  ngOnDestroy(): void {
    this.teardown();
  }
}
