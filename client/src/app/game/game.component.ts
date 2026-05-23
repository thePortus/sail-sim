import {
  Component, ElementRef, ViewChild,
  AfterViewInit, OnDestroy, inject, signal, effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { catchError, of } from 'rxjs';

import { SceneService }       from '../sailing/services/scene.service';
import { OceanService }       from '../sailing/services/ocean.service';
import { IslandService }      from '../sailing/services/island.service';
import { VesselService }      from '../sailing/services/vessel.service';
import { WeatherService }     from '../sailing/services/weather.service';
import { CloudService }       from '../sailing/services/cloud.service';
import { MultiplayerService } from '../sailing/services/multiplayer.service';
import { AuthService }        from '../services/auth.service';

import { HudComponent }            from '../sailing/components/hud/hud.component';
import { MinimapComponent }        from '../sailing/components/minimap/minimap.component';
import { VesselSelectorComponent } from '../sailing/components/vessel-selector/vessel-selector.component';
import { AdminPanelComponent }     from '../sailing/components/admin-panel/admin-panel.component';

import { Vessel } from '../sailing/models';
import { Settings } from '../app.settings';

type GamePhase = 'selecting' | 'initializing' | 'sailing';

@Component({
  selector: 'app-game',
  standalone: true,
  imports: [CommonModule, HudComponent, MinimapComponent, VesselSelectorComponent, AdminPanelComponent],
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
        <div class="minimap-anchor">
          <app-minimap />
        </div>
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
  `],
})
export class GameComponent implements AfterViewInit, OnDestroy {
  @ViewChild('gameCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private http               = inject(HttpClient);
  private router             = inject(Router);
  private authService        = inject(AuthService);
  private sceneService       = inject(SceneService);
  private oceanService       = inject(OceanService);
  private islandService      = inject(IslandService);
  private vesselService      = inject(VesselService);
  private weatherService     = inject(WeatherService);
  private cloudService       = inject(CloudService);
  private multiplayerService = inject(MultiplayerService);

  phase      = signal<GamePhase>('selecting');
  loadingMsg = signal('Charting the archipelago…');

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

  async onVesselSelected(event: { slug: string; callsign: string }): Promise<void> {
    this.selectedSlug = event.slug;
    this.callsign     = (event.callsign || 'Sailor').trim();
    this.phase.set('initializing');

    // ── 0. Verify the JWT is still accepted by this server instance ───────────
    // Guards against stale cached tokens surviving a server wipe or secret rotation.
    this.loadingMsg.set('Verifying credentials…');
    try {
      await firstValueFrom(
        this.http.get(`${Settings.apiUrl}user/me`)
      );
    } catch {
      // 401 or network error — token is invalid; force re-login
      this.authService.clearStorage();
      this.phase.set('selecting');
      this.router.navigate(['/login']);
      return;
    }

    // 1. Boot BabylonJS scene (WebGPU — async device acquisition)
    this.loadingMsg.set('Preparing the ocean…');
    await this.sceneService.initAsync(this.canvasRef.nativeElement);

    // 2. Build ocean + atmosphere
    await this.oceanService.init();
    this.cloudService.init();

    // 3. Load islands
    this.loadingMsg.set('Raising the islands…');
    await this.islandService.load();

    // 4. Fetch vessel definition
    this.loadingMsg.set('Rigging your vessel…');
    const vessel = await firstValueFrom(
      this.http.get<Vessel>(`${Settings.apiUrl}vessels/${this.selectedSlug}`)
    );

    // 5. Determine spawn — try saved location first, fall back to island spawn
    const spawnIsland = this.islandService.islands()[0];
    let spawnX       = spawnIsland?.spawnX ?? 7200;
    let spawnZ       = spawnIsland?.spawnZ ?? 0;
    let spawnHeading = 270;

    const saved = await firstValueFrom(
      this.http.get<{ x: number; z: number; heading: number } | null>(
        `${Settings.apiUrl}player-location/${encodeURIComponent(this.callsign)}`
      ).pipe(catchError(() => of(null)))
    );
    if (saved && typeof saved.x === 'number') {
      spawnX       = saved.x;
      spawnZ       = saved.z;
      spawnHeading = saved.heading ?? 270;
      this.loadingMsg.set('Returning to your last anchorage…');
    }

    this.vesselService.init(vessel, spawnX, spawnZ, spawnHeading);

    // 6. Weather
    this.loadingMsg.set('Reading the wind…');
    this.weatherService.start();

    // 7. Multiplayer — connect using the player's callsign
    this.multiplayerService.connect(this.callsign);

    // 8. Auto-save position every 30 s while sailing
    this.saveInterval = setInterval(() => this.saveLocation(), 30_000);

    // 9. Done
    this.phase.set('sailing');
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
    this.cloudService.dispose();
    this.vesselService.dispose();
    this.sceneService.dispose();
  }

  /** Called by the HUD exit button — tears down the scene and returns to vessel selection. */
  onExitGame(): void {
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
