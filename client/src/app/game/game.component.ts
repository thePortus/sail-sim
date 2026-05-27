import {
  Component, ElementRef, ViewChild,
  AfterViewInit, OnDestroy, inject, signal, effect, computed,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { catchError, of } from 'rxjs';

import { SceneService }       from '../sailing/services/scene.service';
import { OceanService }       from '../sailing/services/ocean.service';
import { TerrainService }     from '../sailing/services/terrain.service';
import { VesselService }      from '../sailing/services/vessel.service';
import { WeatherService }     from '../sailing/services/weather.service';
import { CloudService }       from '../sailing/services/cloud.service';
import { MultiplayerService } from '../sailing/services/multiplayer.service';
import { CannonService }       from '../sailing/services/cannon.service';
import { MusicService }        from '../sailing/services/music.service';
import { AuthService }        from '../services/auth.service';

import { HudComponent }            from '../sailing/components/hud/hud.component';
import { MinimapComponent }        from '../sailing/components/minimap/minimap.component';
import { VesselSelectorComponent } from '../sailing/components/vessel-selector/vessel-selector.component';
import { AdminPanelComponent }     from '../sailing/components/admin-panel/admin-panel.component';
import { PauseMenuComponent }      from '../sailing/components/pause-menu/pause-menu.component';

import { Vessel } from '../sailing/models';
import { Settings } from '../app.settings';

type GamePhase = 'selecting' | 'initializing' | 'sailing';

@Component({
  selector: 'app-game',
  standalone: true,
  imports: [CommonModule, HudComponent, MinimapComponent, VesselSelectorComponent, AdminPanelComponent, PauseMenuComponent],
  template: `
    <div class="game-root">
      <!-- BabylonJS canvas -->
      <canvas #gameCanvas class="game-canvas"
              [class.game-canvas--visible]="phase() === 'sailing'"></canvas>

      <!-- Vessel selection screen -->
      @if (phase() === 'selecting') {
        <app-vessel-selector (vesselSelected)="onVesselSelected($event)" />
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
          <app-pause-menu (resume)="onResume()" (quit)="onExitGame()" />
        }
        <div class="minimap-anchor">
          <app-minimap />
        </div>

        <!-- Cannon charge indicator — visible while right-click is held -->
        @if (cannonService.isCharging()) {
          <div class="cannon-charge-hud">
            <div class="cannon-charge-label">⚫ {{ cannonService.activeSide() === 'port' ? 'PORT' : 'STBD' }} CANNON</div>
            <div class="cannon-charge-track">
              <div class="cannon-charge-fill"
                   [style.width.%]="cannonService.chargeLevel() * 100"
                   [class.cannon-charge-full]="cannonService.chargeLevel() >= 0.98"></div>
            </div>
            <div class="cannon-charge-range">
              {{ chargeRangeLabel() }}
            </div>
          </div>
        }

        @if (isAdmin) {
          <app-admin-panel #adminPanel />
          <div class="admin-hint">Press <kbd>&#96;</kbd> for admin controls</div>
        }
      }
    </div>
  `,
  styles: [`
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
    /* ── Cannon charge HUD ────────────────────────────────────────────── */
    .cannon-charge-hud {
      position: absolute; bottom: 5.5rem; left: 50%; transform: translateX(-50%);
      z-index: 60; pointer-events: none;
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      background: rgba(8, 16, 28, 0.75);
      border: 1px solid rgba(255, 200, 50, 0.35);
      border-radius: 8px; padding: 8px 16px;
      backdrop-filter: blur(6px);
    }
    .cannon-charge-label {
      font-family: monospace; font-size: 11px; font-weight: bold;
      color: rgba(255, 200, 50, 0.90); letter-spacing: 0.12em;
    }
    .cannon-charge-track {
      width: 180px; height: 6px;
      background: rgba(255,255,255,0.10); border-radius: 3px; overflow: hidden;
    }
    .cannon-charge-fill {
      height: 100%; border-radius: 3px;
      background: linear-gradient(90deg, #f97316, #facc15);
      transition: width 0.05s linear, background 0.2s;
    }
    .cannon-charge-fill.cannon-charge-full {
      background: linear-gradient(90deg, #ef4444, #f97316);
      animation: charge-pulse 0.25s ease-in-out infinite alternate;
    }
    @keyframes charge-pulse { from { opacity: 0.85; } to { opacity: 1.0; } }
    .cannon-charge-range {
      font-family: monospace; font-size: 10px; color: rgba(255,220,100,0.65);
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
  private terrainService     = inject(TerrainService);
  private vesselService      = inject(VesselService);
  private weatherService     = inject(WeatherService);
  private cloudService       = inject(CloudService);
  private multiplayerService = inject(MultiplayerService);
  readonly cannonService      = inject(CannonService);    // public: template reads signals
  readonly musicService       = inject(MusicService);    // public: PauseMenuComponent also injects it

  phase      = signal<GamePhase>('selecting');
  paused     = signal<boolean>(false);
  loadingMsg = signal('Charting the archipelago…');

  @HostListener('window:keydown.escape')
  onEscKey(): void {
    if (this.phase() === 'sailing') {
      this.paused.update(v => !v);
    }
  }

  /** Display the approximate range in the charge bar (20 m … 80 m). */
  chargeRangeLabel = computed(() => {
    const c = this.cannonService.chargeLevel();
    const range = Math.round((20 + c * 60) / 5) * 5;   // snap to 5 m grid
    return `~${range} m range`;
  });

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
      this.oceanService.updateWeather(w.wind, w.sea);
      this.vesselService.updateWeather(w.wind, w.sea);
      this.sceneService.updateSkyFromWeather(w);
      this.sceneService.updateFogDensity(w.fog.density);
      this.cloudService.updateWeather(w);
    });

    // Wire vessel state → multiplayer broadcast
    effect(() => {
      const vs = this.vesselService.state();
      this.multiplayerService.updateLocalState(
        vs.x, vs.z, vs.heading, vs.speed, vs.sailState, 'Sloop', this.selectedSlug,
      );
    });
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
        this.cloudService.init();
      });

      // 3. Load terrain
      await this.runInitStep('init-terrain', 'Surveying the coastline…', async () => {
        await this.terrainService.init();
      });

      // 4. Fetch vessel
      const vessel = await this.runInitStep('fetch-vessel', 'Rigging your vessel…', async () => {
        return await firstValueFrom(
          this.http.get<Vessel>(`${Settings.apiUrl}vessels/${this.selectedSlug}`),
        );
      });

      // 5. Determine spawn
      const defaultSpawn = this.terrainService.nearestSpawn(0, 0);
      let spawnX = defaultSpawn.spawnX;
      let spawnZ = defaultSpawn.spawnZ;
      let spawnHeading = defaultSpawn.heading;

      const saved = await this.runInitStep('load-player-location', 'Checking your last anchorage…', async () => {
        return await firstValueFrom(
          this.http.get<{ x: number; z: number; heading: number } | null>(
            `${Settings.apiUrl}player-location/${encodeURIComponent(this.callsign)}`,
          ).pipe(catchError(() => of(null))),
        );
      });

      if (saved && typeof saved.x === 'number') {
        spawnX = saved.x;
        spawnZ = saved.z;
        spawnHeading = saved.heading ?? 270;
        this.loadingMsg.set('Returning to your last anchorage…');
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
  }

  /** Called by the HUD exit button or pause menu — tears down the scene and returns to vessel selection. */
  onExitGame(): void {
    this.paused.set(false);
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
