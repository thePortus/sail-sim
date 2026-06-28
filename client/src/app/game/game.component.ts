import {
  Component, ElementRef, ViewChild,
  AfterViewInit, OnDestroy, inject, signal, computed, effect,
  HostListener, untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { catchError, of } from 'rxjs';

import { FACTIONS, factionColor, factionName } from '../sailing/faction.config';
import type { TerrainHarbor }  from '../sailing/models';
import { SceneService }       from '../sailing/services/scene.service';
import { OceanService }       from '../sailing/services/ocean.service';
import { OceanFFTEngine }      from '../sailing/services/ocean-fft-engine.service';
import { OceanFFTRenderer }    from '../sailing/services/ocean-fft-renderer.service';
import { TerrainService }     from '../sailing/services/terrain.service';
import { HarborService }      from '../sailing/services/harbor.service';
import { VesselService }      from '../sailing/services/vessel.service';
import { VesselAssetCacheService } from '../sailing/services/vessel-asset-cache.service';
import { clearScatterCache } from '../sailing/services/scatter/asset-loader';
import { WeatherService }     from '../sailing/services/weather.service';
import { CloudService }       from '../sailing/services/cloud.service';
import { TelescopeService }   from '../sailing/services/telescope.service';
import { OceanAudioService }  from '../sailing/services/ocean-audio.service';
import { ScatterService }     from '../sailing/services/scatter/scatter.service';
import { BirdService }         from '../sailing/services/bird.service';
import { DolphinService }      from '../sailing/services/dolphin.service';
import { FishSchoolService }   from '../sailing/services/fish-school.service';
import { QuestActionService }  from '../sailing/services/quest-action.service';
import { SeaweedService }      from '../sailing/services/seaweed.service';
import { ReedService }         from '../sailing/services/reed.service';
import { ShipBellService }     from '../sailing/services/ship-bell.service';
import { SailAudioService }    from '../sailing/services/sail-audio.service';
import { MultiplayerService } from '../sailing/services/multiplayer.service';
import { CannonService }       from '../sailing/services/cannon.service';
import { CombatService }       from '../sailing/services/combat.service';
import { MusicService }        from '../sailing/services/music.service';
import { AuthService }        from '../services/auth.service';

import { HudComponent }            from '../sailing/components/hud/hud.component';
import { MinimapComponent }        from '../sailing/components/minimap/minimap.component';
import { AdminPanelComponent }     from '../sailing/components/admin-panel/admin-panel.component';
import { PauseMenuComponent }      from '../sailing/components/pause-menu/pause-menu.component';
import { SettingsMenuComponent }   from '../sailing/components/settings-menu/settings-menu.component';
import { HelpMenuComponent }       from '../sailing/components/help-menu/help-menu.component';
import { TraderMenuComponent }     from './trader-menu.component';
import { ShipwrightMenuComponent } from './shipwright-menu.component';
import { TavernMenuComponent } from './tavern-menu.component';
import { GovernorMenuComponent } from './governor-menu.component';
import { DiplomacyMenuComponent } from './diplomacy-menu.component';
import { QuestModalComponent } from './quest-modal.component';
import { ShipNameModalComponent } from './ship-name-modal.component';
import { QuestTrackerComponent } from './quest-tracker.component';
import { QuestGuidanceComponent } from './quest-guidance.component';
import { QuestToastComponent } from './quest-toast.component';

import { Vessel } from '../sailing/models';
import { Settings } from '../app.settings';

type GamePhase = 'selecting' | 'initializing' | 'sailing';

@Component({
  selector: 'app-game',
  standalone: true,
  imports: [CommonModule, HudComponent, MinimapComponent, AdminPanelComponent, PauseMenuComponent, SettingsMenuComponent, HelpMenuComponent, TraderMenuComponent, ShipwrightMenuComponent, TavernMenuComponent, GovernorMenuComponent, DiplomacyMenuComponent, QuestModalComponent, QuestTrackerComponent, QuestGuidanceComponent, QuestToastComponent, ShipNameModalComponent],
  template: `
    <div class="game-root" [class.photo-mode]="photoMode()">
      <!-- BabylonJS canvas -->
      <canvas #gameCanvas class="game-canvas"
              [class.game-canvas--visible]="phase() === 'sailing'"></canvas>

      <!-- No vessel-selection screen anymore: the game auto-boots into the player's OWNED ship (bought at a
           port shipwright). The 'selecting' phase is now just a transient pre-boot state; if startup fails it
           shows a retry card. -->
      @if (phase() === 'selecting' && initError()) {
        <div class="kick-notice-backdrop">
          <div class="kick-notice" (click)="$event.stopPropagation()">
            <div class="kick-notice-icon">⚓</div>
            <div class="kick-notice-title">Becalmed</div>
            <div class="kick-notice-text">{{ initError() }}</div>
            <button class="kick-notice-btn" (click)="startGame()">Retry</button>
          </div>
        </div>
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

      <!-- Lost connection to the server (server down / network drop) — OK returns to the home screen -->
      @if (serverLostNotice()) {
        <div class="kick-notice-backdrop">
          <div class="kick-notice" (click)="$event.stopPropagation()">
            <div class="kick-notice-icon">⚠️</div>
            <div class="kick-notice-title">Connection Lost</div>
            <div class="kick-notice-text">Lost contact with the server — it may be down or restarting. Please try again shortly.</div>
            <button class="kick-notice-btn" (click)="onConnectionLostOk()">OK</button>
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
        <app-hud (exitGame)="onReturnToHarbor()" (photoModeChange)="photoMode.set($event)" />

        <!-- Quests: the objective tracker HUD + the story modal (intro tutorial + future storyline). Hidden in
             photo mode so it doesn't clutter a screenshot. -->
        @if (!photoMode()) {
          <app-quest-tracker />
          <app-quest-guidance />
          <app-quest-modal />
          <app-quest-toast />
        }

        <!-- Ship-naming modal — opens on tutorial completion, buying a hull, or the Shipwright's Rename button. -->
        <app-ship-name-modal />

        <!-- Pause menu — shown when Esc is pressed -->
        @if (paused()) {
          <app-pause-menu (resume)="onResume()" (quit)="onReturnToHarbor()"
                          (openSettings)="showSettings.set(true)" (openHelp)="showHelp.set(true)" />
        }
        <!-- Settings panel — opened from the pause menu -->
        @if (showSettings()) {
          <app-settings-menu (close)="showSettings.set(false)" />
        }
        <!-- Help / controls reference — opened from the pause menu -->
        @if (showHelp()) {
          <app-help-menu (close)="showHelp.set(false)" />
        }
        <div class="minimap-anchor">
          <app-minimap />
        </div>

        @if (isAdmin) {
          <app-admin-panel #adminPanel />
          <div class="admin-hint">Press <kbd>&#96;</kbd> for admin controls</div>
        }

        <!-- Dock prompt + town menu (when near a harbor and not sunk) -->
        @if (!combatService.sunk() && harborService.dockable(); as town) {
          @if (vesselService.tiedUp()) {
            <div class="dock-menu">
              <div class="dock-name">{{ town.name }}</div>
              @if (town.faction) {
                <div class="dock-faction"><span class="dock-faction-dot" [style.background]="factionColor(town.faction)"></span>{{ factionLabel(town) }}</div>
              }
              <div class="dock-desc">{{ town.description }}</div>
              <button class="dock-opt" data-guide="trade" (click)="onTrade(town.id)">Trade Goods</button>
              <button class="dock-opt" (click)="onShipwright()">Shipwright</button>
              <button class="dock-opt" data-guide="tavern" (click)="onTavern()">Tavern</button>
              @if (town.faction) {
                <button class="dock-opt" (click)="onGovernor()">{{ town.tier === 'capital' ? "Governor's Mansion" : "Mayor's House" }}</button>
              }
              <button class="dock-cast" (click)="onCastOff()">Cast Off</button>
            </div>
          } @else if (vesselService.docking()) {
            <div class="dock-prompt dock-mooring">⚓ Mooring at {{ town.name }}…</div>
          } @else {
            <button class="dock-prompt" data-guide="dock" (click)="onDock(town)">⚓ Dock at {{ town.name }}</button>
          }
        }

        <!-- Physics v2 tuning overlay (only when localStorage.ignis_physics='v2') -->
        @if (vesselService.physDebug(); as pd) {
          <div class="phys-debug">
            <div class="phys-row"><span>app wind</span><b>{{ pd.appAngle | number:'1.0-0' }}° · {{ pd.appWind | number:'1.1-1' }}</b></div>
            <div class="phys-row"><span>true wind</span><b>{{ pd.trueAngle | number:'1.0-0' }}°</b></div>
            <div class="phys-row"><span>speed</span><b>{{ pd.speed | number:'1.2-2' }}</b></div>
            <div class="phys-row"><span>VMG</span><b>{{ pd.vmg | number:'1.2-2' }}</b></div>
            <div class="phys-row"><span>trim</span><b>{{ pd.trim * 100 | number:'1.0-0' }}%</b></div>
            <div class="phys-row"><span>heel</span><b [class.phys-warn]="pd.reef">{{ pd.heel | number:'1.0-0' }}°{{ pd.reef ? ' ⚠ reef' : '' }}</b></div>
            <div class="phys-row"><span>thrust / drag</span><b>{{ pd.thrust | number:'1.1-1' }} / {{ pd.drag | number:'1.1-1' }}</b></div>
          </div>
        }

        <!-- Trader panel (opened from the dock menu's Trade button) -->
        @if (tradeMenuOpen()) {
          <app-trader-menu (close)="tradeMenuOpen.set(false)" />
        }

        <!-- Shipwright panel (opened from the dock menu's Shipwright button) -->
        @if (shipwrightOpen()) {
          <app-shipwright-menu [admin]="isAdmin" (close)="shipwrightOpen.set(false)" />
        }

        <!-- Tavern panel (opened from the dock menu's Tavern button) -->
        @if (tavernOpen()) {
          <app-tavern-menu (close)="tavernOpen.set(false)" />
        }

        <!-- Governor's Mansion / Mayor's House (opened from the dock menu) — buy back bad standing -->
        @if (governorOpen() && harborService.dockable(); as govTown) {
          <app-governor-menu [town]="govTown" [admin]="isAdmin" (close)="governorOpen.set(false)" />
        }

        <!-- Diplomacy panel (opened from the Ship's Hold or the K key) — faction relations + your standing -->
        @if (diplomacyOpen()) {
          <app-diplomacy-menu (close)="diplomacyOpen.set(false)" />
        }

        <!-- Salvage toast — flashes when you scoop a sunk merchant's crate -->
        @if (salvageNotice(); as note) {
          <div class="salvage-toast">📦 {{ note }}</div>
        }

        <!-- Reputation toast — flashes the per-nation standing change after attacking shipping -->
        @if (repNotice(); as rep) {
          <div class="rep-toast">{{ rep }}</div>
        }

        <!-- Diplomacy banner — a prominent flash when nations declare war / make peace / ally -->
        @if (diploBanner(); as b) {
          <div class="diplo-banner" [class.war]="b.war">{{ b.text }}</div>
        }

        <!-- Ship's Hold — gold + cargo, viewable anytime with I or Tab -->
        @if (inventoryOpen()) {
          <div class="inv-backdrop" (click)="inventoryOpen.set(false)"></div>
          <div class="inv-panel">
            <div class="inv-header">
              <span class="inv-title">Ship's Hold</span>
              <span class="inv-gold">⚜ {{ multiplayerService.gold() }} gold</span>
            </div>
            <div class="inv-cap">Hold {{ inventoryUsed() }}/{{ multiplayerService.capacity() }}</div>
            @if (inventoryList().length) {
              <div class="inv-list">
                @for (it of inventoryList(); track it.id) {
                  <div class="inv-row"><span>{{ it.name }}</span><span class="inv-qty">{{ it.qty }}</span></div>
                }
              </div>
            } @else {
              <div class="inv-empty">Your hold is empty — visit a town's trader to buy goods.</div>
            }
            <div class="inv-rep-title">Standing with the Powers</div>
            <div class="inv-rep">
              @for (f of factionStandings(); track f.id) {
                <div class="inv-rep-row">
                  <span class="inv-rep-swatch" [style.background]="f.color"></span>
                  <span class="inv-rep-name">{{ f.name }}</span>
                  <span class="inv-rep-val" [class.pos]="f.value > 0" [class.neg]="f.value < 0">{{ f.label }}</span>
                </div>
              }
            </div>
            <button class="inv-diplo-btn" (click)="openDiplomacy()">⚔ View Faction Relations</button>
            <div class="inv-hint">Press I or Tab to close · K for diplomacy</div>
          </div>
        }

        <!-- Sunk overlay — acknowledge to respawn at the nearest port -->
        @if (combatService.sunk()) {
          <div class="sunk-backdrop">
            <div class="sunk-card">
              <div class="sunk-icon">🌊</div>
              <div class="sunk-title">Your ship was sunk</div>
              <div class="sunk-text">Sent to the depths by {{ combatService.sunkBy() }}.</div>
              <button class="sunk-btn" (click)="onConfirmSunk()">Respawn at Nearest Port</button>
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
    /* Dock prompt + town menu (screen centre) */
    .dock-prompt { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
                   z-index: 60; padding: 12px 24px; border-radius: 10px; cursor: pointer;
                   border: 1px solid rgba(232,211,160,0.55); background: rgba(20,28,40,0.86);
                   color: #ffe9b0; font-weight: 600; font-family: ui-monospace, monospace;
                   box-shadow: 0 6px 20px rgba(0,0,0,0.5); transition: all 0.15s; }
    .dock-prompt:hover { background: rgba(40,52,68,0.92); }
    .dock-mooring { cursor: default; opacity: 0.8; }
    .dock-mooring:hover { background: rgba(20,28,40,0.86); }
    .dock-menu { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
                 z-index: 60; min-width: 280px; padding: 22px 26px; text-align: center;
                 border-radius: 14px; border: 1px solid rgba(232,211,160,0.4);
                 background: rgba(12,20,32,0.95); box-shadow: 0 14px 44px rgba(0,0,0,0.6); }
    .dock-name { color: #ffe9b0; font-size: 1.2rem; font-weight: 700; }
    .dock-faction { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: #dbe7f0; font-size: 0.82rem; }
    .dock-faction-dot { width: 10px; height: 10px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.5); flex: none; }
    .dock-desc { color: #cfe3f5; opacity: 0.75; font-size: 0.85rem; margin: 6px 0 16px;
                 font-family: ui-monospace, monospace; }
    .dock-opt  { display: block; width: 100%; padding: 10px; margin-bottom: 8px; cursor: pointer;
                 border-radius: 9px; border: 1px solid rgba(96,165,250,0.5);
                 background: rgba(59,130,246,0.22); color: #dbeafe; font-weight: 600; transition: all 0.15s; }
    .dock-opt:hover { background: rgba(59,130,246,0.4); }
    .dock-cast { display: block; width: 100%; padding: 7px; cursor: pointer; border-radius: 9px;
                 border: 1px solid rgba(255,255,255,0.15); background: transparent;
                 color: rgba(255,255,255,0.6); font-family: ui-monospace, monospace; }
    .dock-cast:hover { color: #fff; }
    /* Salvage toast (top-centre) */
    .salvage-toast { position: absolute; top: 5.5rem; left: 50%; transform: translateX(-50%); z-index: 85;
                     padding: 8px 16px; border-radius: 9px; border: 1px solid rgba(232,211,160,0.5);
                     background: rgba(20,28,40,0.92); color: #ffe9b0; font-weight: 600;
                     font-family: 'IBM Plex Serif', Georgia, serif; box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
    /* Ship's Hold (inventory) — walnut/brass, viewable anytime with I / Tab */
    .inv-backdrop { position: absolute; inset: 0; z-index: 80; background: rgba(8,6,3,0.45); }
    .inv-panel { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 81;
                 width: min(360px, 90vw); max-height: 80vh; overflow: hidden auto;
                 padding: 1.1rem 1.2rem; border-radius: 12px; border: 1px solid #6e5326;
                 background: linear-gradient(160deg, #2e2013, #15100a); color: #f0e3c6;
                 font-family: 'IBM Plex Serif', Georgia, serif; box-shadow: 0 18px 50px rgba(0,0,0,0.6); }
    .inv-header { display: flex; align-items: baseline; justify-content: space-between;
                  border-bottom: 1px solid rgba(184,138,62,0.3); padding-bottom: 0.5rem; }
    .inv-title { font-size: 1.2rem; font-weight: 600; color: #e8d3a0; }
    .inv-gold { color: #f0c869; font-weight: 600; }
    .inv-cap { color: #cdbb95; font-size: 0.85rem; margin: 0.55rem 0 0.4rem; }
    .inv-list { display: flex; flex-direction: column; gap: 2px; }
    .inv-row { display: flex; justify-content: space-between; padding: 0.32rem 0.2rem; border-radius: 5px; }
    .inv-row:nth-child(odd) { background: rgba(255,255,255,0.03); }
    .inv-qty { color: #f0c869; font-variant-numeric: tabular-nums; font-weight: 600; }
    .inv-empty { padding: 1.2rem 0; text-align: center; color: #b89a62; font-style: italic; }
    .inv-rep-title { margin: 0.9rem 0 0.4rem; padding-top: 0.6rem; border-top: 1px solid rgba(184,138,62,0.25);
                     color: #b89a62; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .inv-rep { display: flex; flex-direction: column; gap: 2px; }
    .inv-rep-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.28rem 0.2rem; border-radius: 5px; }
    .inv-rep-row:nth-child(odd) { background: rgba(255,255,255,0.03); }
    .inv-rep-swatch { width: 11px; height: 11px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.45); flex: none; }
    .inv-rep-name { flex: 1; color: #f0e3c6; }
    .inv-rep-val { color: #cdbb95; font-variant-numeric: tabular-nums; }
    .inv-rep-val.pos { color: #9fe0a0; }
    .inv-rep-val.neg { color: #f0a8a0; }
    .inv-diplo-btn { margin-top: 0.7rem; width: 100%; padding: 0.5rem; cursor: pointer; background: rgba(184,138,62,0.14); color: #e7d6ab; border: 1px solid rgba(184,138,62,0.4); border-radius: 6px; font-family: inherit; font-size: 0.85rem; }
    .inv-diplo-btn:hover { background: rgba(184,138,62,0.24); }
    .rep-toast { position: absolute; top: 8.5rem; left: 50%; transform: translateX(-50%); z-index: 85; padding: 8px 16px; border-radius: 8px; background: rgba(20,12,6,0.86); border: 1px solid rgba(184,138,62,0.4); color: #f0e3c6; font-family: 'IBM Plex Serif', Georgia, serif; font-size: 0.9rem; white-space: nowrap; box-shadow: 0 6px 24px rgba(0,0,0,0.5); }
    .diplo-banner { position: absolute; top: 30%; left: 50%; transform: translateX(-50%); z-index: 86; padding: 12px 26px; border-radius: 10px; background: rgba(20,12,6,0.92); border: 1px solid rgba(184,138,62,0.5); color: #f0e3c6; font-family: 'IBM Plex Serif', Georgia, serif; font-size: 1.05rem; font-weight: 600; text-align: center; max-width: 80vw; box-shadow: 0 10px 40px rgba(0,0,0,0.6); }
    .diplo-banner.war { border-color: rgba(248,81,73,0.7); color: #ffd9d4; }
    .inv-hint { margin-top: 0.8rem; text-align: center; color: #8a7448; font-size: 0.72rem; }
    .game-root   { position: fixed; inset: 0; background: #08111e; overflow: hidden; }
    .game-canvas { position: absolute; inset: 0; width: 100%; height: 100%;
                   opacity: 0; transition: opacity 0.8s ease; }
    .game-canvas--visible { opacity: 1; }
    /* Physics v2 tuning overlay */
    .phys-debug { position: absolute; top: 4.5rem; left: 1rem; z-index: 55; min-width: 168px;
                  padding: 8px 10px; border-radius: 8px; background: rgba(10,16,24,0.74);
                  border: 1px solid rgba(120,160,200,0.35); color: #cfe3f5; pointer-events: none;
                  font-family: ui-monospace, monospace; font-size: 0.72rem; line-height: 1.5; }
    .phys-row { display: flex; justify-content: space-between; gap: 14px; }
    .phys-row span { opacity: 0.66; }
    .phys-row b { color: #ffe9b0; font-weight: 600; }
    .phys-row b.phys-warn { color: #ff9a6b; }
    .loading-overlay { position: absolute; inset: 0; display: flex; flex-direction: column;
                        align-items: center; justify-content: center;
                        background: radial-gradient(ellipse at center, #3a2817 0%, #15100a 70%); }
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
    /* Photo mode (driven by the HUD): hide our own chrome too — minimap + admin hint/panel. */
    .game-root.photo-mode .minimap-anchor,
    .game-root.photo-mode .admin-hint,
    .game-root.photo-mode app-admin-panel { display: none !important; }
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
  protected harborService    = inject(HarborService);   // template reads dockable()
  protected vesselService    = inject(VesselService);   // template reads docking()/tiedUp()
  private vesselAssetCache   = inject(VesselAssetCacheService);
  private weatherService     = inject(WeatherService);
  private cloudService       = inject(CloudService);
  private telescopeService   = inject(TelescopeService);
  private oceanAudioService  = inject(OceanAudioService);
  private scatterService     = inject(ScatterService);
  private birdService        = inject(BirdService);
  private dolphinService     = inject(DolphinService);
  private fishSchoolService  = inject(FishSchoolService);
  private questActionService = inject(QuestActionService);
  private seaweedService     = inject(SeaweedService);
  private reedService        = inject(ReedService);
  private shipBellService    = inject(ShipBellService);
  private sailAudioService   = inject(SailAudioService);
  protected multiplayerService = inject(MultiplayerService);   // template reads gold()/etc. for the trader
  protected combatService    = inject(CombatService);
  readonly cannonService      = inject(CannonService);    // public: template reads signals
  readonly musicService       = inject(MusicService);    // public: PauseMenuComponent also injects it

  phase      = signal<GamePhase>('selecting');
  initError  = signal<string | null>(null);   // shown as a retry card if auto-boot fails
  /** True once the BabylonJS scene/engine has been booted this session. Gates teardown so it runs for
   *  a partially-initialised game (e.g. aborting mid-init on an auth failure), not just while sailing. */
  private sceneStarted = false;
  paused       = signal<boolean>(false);
  showSettings = signal<boolean>(false);
  showHelp     = signal<boolean>(false);   // the Help / controls reference, opened from the pause menu
  dockMenuOpen = signal<boolean>(false);   // the town interaction menu (opened from the Dock prompt)
  tradeMenuOpen = signal<boolean>(false);  // the trader panel (opened from the town menu's Trade button)
  shipwrightOpen = signal<boolean>(false); // the shipwright panel (opened from the town menu's Shipwright button)
  tavernOpen = signal<boolean>(false);     // the tavern panel (opened from the town menu's Tavern button — recruit crew)
  governorOpen = signal<boolean>(false);   // the Governor's Mansion / Mayor's House panel (buy back bad standing)
  inventoryOpen = signal<boolean>(false);  // the Ship's Hold panel (I / Tab) — viewable anytime
  diplomacyOpen = signal<boolean>(false);  // the Diplomacy panel (K / Ship's Hold button) — faction relations + standing
  salvageNotice = signal<string | null>(null);   // transient "Salvaged: …" toast after collecting a crate
  private salvageTimer: ReturnType<typeof setTimeout> | null = null;
  repNotice = signal<string | null>(null);       // transient reputation-change toast after attacking shipping
  private repTimer: ReturnType<typeof setTimeout> | null = null;
  diploBanner = signal<{ text: string; war: boolean } | null>(null);   // prominent war/peace/alliance flash
  private diploTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cargo as a sorted display list { id, name, qty } using the server-sent goods catalogue. */
  protected inventoryList = computed(() => {
    const cat = this.multiplayerService.goodsCatalog();
    return Object.entries(this.multiplayerService.cargo())
      .filter(([, q]) => q > 0)
      .map(([id, qty]) => ({ id, name: cat[id] ?? id, qty }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  protected inventoryUsed = computed(() =>
    Object.values(this.multiplayerService.cargo()).reduce((a, b) => a + (b || 0), 0));

  /** Faction colour for a town (dock menu swatch). */
  protected factionColor(id?: string | null): string { return factionColor(id); }
  /** Dock-menu faction label: nation (+ "contested by Rival" note). */
  protected factionLabel(town: TerrainHarbor): string {
    return factionName(town.faction) + (town.contested && town.rivalFaction ? ` — contested by ${factionName(town.rivalFaction)}` : '');
  }

  /** Faction standings for the Ship's Hold readout — every nation, neutral by default (scaffold; no effects). */
  protected factionStandings = computed(() => {
    const rep = this.multiplayerService.factionRep();
    return FACTIONS.map((f) => {
      const v = Math.round(rep[f.id] ?? 0);
      return { id: f.id, name: f.name, color: f.color, value: v, label: v === 0 ? 'Neutral' : (v > 0 ? `+${v}` : String(v)) };
    });
  });
  photoMode    = signal<boolean>(false);   // mirrored from the HUD; hides our chrome (minimap, admin hint)
  loadingMsg = signal('Charting the archipelago…');

  @HostListener('window:keydown.escape')
  onEscKey(): void {
    if (this.phase() !== 'sailing') return;
    // Esc backs out of the hold/diplomacy first; then Settings; then stands down an armed gun; then pause.
    if (this.inventoryOpen()) {
      this.inventoryOpen.set(false);
      return;
    }
    if (this.diplomacyOpen()) {
      this.diplomacyOpen.set(false);
      return;
    }
    if (this.showSettings()) {
      this.showSettings.set(false);
      return;
    }
    if (this.showHelp()) {
      this.showHelp.set(false);
      return;
    }
    if (this.cannonService.anyCancellable()) {
      this.cannonService.cancel();
      return;
    }
    this.paused.update(v => !v);
  }

  // Toggle the Ship's Hold (inventory + gold) with I or Tab — viewable anytime while sailing.
  @HostListener('window:keydown.i', ['$event'])
  @HostListener('window:keydown.tab', ['$event'])
  onInventoryKey(e: KeyboardEvent): void {
    if (this.phase() !== 'sailing' || this.typingInField()) return;
    e.preventDefault();                          // Tab would otherwise move focus
    this.inventoryOpen.update(v => !v);
  }

  // Toggle the Diplomacy panel (faction relations + standing) with K — viewable anytime while sailing.
  @HostListener('window:keydown.k', ['$event'])
  onDiplomacyKey(e: KeyboardEvent): void {
    if (this.phase() !== 'sailing' || this.typingInField()) return;
    e.preventDefault();
    this.diplomacyOpen.update(v => !v);
  }

  /** Open Diplomacy from the Ship's Hold button (and close the hold so one panel shows at a time). */
  protected openDiplomacy(): void { this.inventoryOpen.set(false); this.diplomacyOpen.set(true); }

  /** True when a text field (e.g. chat) is focused, so game hotkeys don't hijack typing. */
  private typingInField(): boolean {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  /** True if the logged-in user has admin or owner role — controls admin panel visibility. */
  isAdmin = false;

  private selectedSlug = '';
  private callsign     = '';

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

    // Websocket rejected our JWT (close 4401) — the session token is invalid/expired. Force a fresh
    // login (full teardown + clear creds + route to /login), reusing the startup re-auth path.
    effect(() => {
      if (!this.multiplayerService.authFailed()) return;
      untracked(() => {
        this.multiplayerService.authFailed.set(false);
        this.forceReauth();
      });
    });

    // Socket dropped unexpectedly (server down / network loss) → show the lost-connection popup (OK → home).
    effect(() => {
      if (!this.multiplayerService.connectionLost()) return;
      untracked(() => this.serverLostNotice.set(true));
    });

    // Moored at a berth → open the town menu; cast off → close it. dockMenuOpen mirrors the vessel's tied
    // state so all the existing panel-close logic (below) keeps working unchanged.
    effect(() => {
      const tied = this.vesselService.tiedUp();
      untracked(() => this.dockMenuOpen.set(tied));
    });

    // Sailed away from the pier → close the town menu (and trader/shipwright panels) if they were open.
    effect(() => {
      if (!this.harborService.dockable()) {
        untracked(() => {
          if (this.dockMenuOpen()) this.dockMenuOpen.set(false);
          if (this.tradeMenuOpen()) { this.tradeMenuOpen.set(false); this.multiplayerService.closeTrade(); }
          if (this.shipwrightOpen()) this.shipwrightOpen.set(false);
          if (this.tavernOpen()) this.tavernOpen.set(false);
          if (this.governorOpen()) this.governorOpen.set(false);
        });
      }
    });

    // Photo mode hides the DOM chrome (CSS) AND the 3-D floating nameplates (ship + town) for a clean screenshot.
    effect(() => {
      const pm = this.photoMode();
      this.multiplayerService.setLabelsHidden(pm);
      this.harborService.setLabelsHidden(pm);
    });

    // Closing the town menu (Cast Off, or any path) closes the trader + shipwright + tavern + governor panels too.
    effect(() => {
      if (!this.dockMenuOpen()) {
        untracked(() => {
          if (this.tradeMenuOpen()) { this.tradeMenuOpen.set(false); this.multiplayerService.closeTrade(); }
          if (this.shipwrightOpen()) this.shipwrightOpen.set(false);
          if (this.tavernOpen()) this.tavernOpen.set(false);
          if (this.governorOpen()) this.governorOpen.set(false);
        });
      }
    });

    // Shipwright purchase succeeded → refit the in-world vessel into the new hull (fetch its full def, then
    // hot-swap in place), close the panel, and clear the signal. Server already updated gold + ownedShip.
    effect(() => {
      const slug = this.multiplayerService.purchasedShip();
      if (!slug) return;
      untracked(() => {
        this.multiplayerService.purchasedShip.set(null);
        this.shipwrightOpen.set(false);
        void this.refitVessel(slug);
      });
    });

    // Arrived at the rumoured town → the rumour is fulfilled, clear its map beacon.
    effect(() => {
      const here = this.harborService.dockable();
      if (here && here.id === this.multiplayerService.hintedHarbor()) {
        untracked(() => this.multiplayerService.hintedHarbor.set(null));
      }
    });

    // Collected salvage → flash a transient "Salvaged: …" toast (good names from the catalogue).
    effect(() => {
      const t = this.multiplayerService.salvageToast();
      if (!t) return;
      untracked(() => {
        const cat = this.multiplayerService.goodsCatalog();
        const parts = Object.entries(t.goods).map(([id, q]) => `${q} ${cat[id] ?? id}`);
        if (t.gold > 0) parts.push(`${t.gold} gold`);
        this.salvageNotice.set(parts.length ? 'Salvaged: ' + parts.join(', ') : 'Salvaged the wreck');
        this.multiplayerService.salvageToast.set(null);
        if (this.salvageTimer) clearTimeout(this.salvageTimer);
        this.salvageTimer = setTimeout(() => this.salvageNotice.set(null), 3500);
      });
    });

    // Pirate head-bounty paid instantly → flash a "Bounty: …" toast (reuses the salvage-notice banner).
    effect(() => {
      const b = this.multiplayerService.bountyToast();
      if (!b) return;
      untracked(() => {
        this.salvageNotice.set(`⚓ Bounty: ${b.gold} gold — ${b.name} sent to the bottom`);
        this.multiplayerService.bountyToast.set(null);
        if (this.salvageTimer) clearTimeout(this.salvageTimer);
        this.salvageTimer = setTimeout(() => this.salvageNotice.set(null), 3500);
      });
    });

    // Reputation change (attacked/sank a nation's shipping) → flash the per-nation deltas as a toast.
    effect(() => {
      const t = this.multiplayerService.repToast();
      if (!t) return;
      untracked(() => {
        const parts = Object.entries(t.deltas)
          .filter(([, d]) => d)
          .map(([fid, d]) => `${d > 0 ? '+' : ''}${d} ${factionName(fid)}`);
        if (parts.length) this.repNotice.set('Reputation: ' + parts.join(' · '));
        this.multiplayerService.repToast.set(null);
        if (this.repTimer) clearTimeout(this.repTimer);
        this.repTimer = setTimeout(() => this.repNotice.set(null), 3500);
      });
    });

    // Diplomacy shift (war / peace / alliance) → a prominent banner for a few seconds (also in chat).
    effect(() => {
      const b = this.multiplayerService.diplomacyBanner();
      if (!b) return;
      untracked(() => {
        this.diploBanner.set({ text: b.text, war: b.to === 'war' });
        this.multiplayerService.diplomacyBanner.set(null);
        if (this.diploTimer) clearTimeout(this.diploTimer);
        this.diploTimer = setTimeout(() => this.diploBanner.set(null), 6000);
      });
    });
  }

  // Prominent "you were disconnected" banner (kick/ban/duplicate-login).
  kickedNotice = signal<string | null>(null);
  dismissKicked(): void {
    this.kickedNotice.set(null);
    this.multiplayerService.kickedReason.set(null);
  }

  // Lost-connection popup (mirrors kickedNotice, but driven by the service's connectionLost signal). OK
  // returns to the home screen (navigation destroys this component → ngOnDestroy tears multiplayer down).
  serverLostNotice = signal(false);
  onConnectionLostOk(): void {
    this.serverLostNotice.set(false);
    this.multiplayerService.connectionLost.set(false);
    this.onReturnToHarbor();
  }

  ngAfterViewInit(): void {
    // No vessel-selection step anymore — boot straight into the player's owned ship once the canvas exists.
    void this.startGame();
  }

  /** Boot straight into the game with the player's OWNED ship (no vessel-selection screen — ships are now
   *  bought at a port shipwright). Re-runnable: a Retry on the error card calls it again. */
  async startGame(): Promise<void> {
    this.initError.set(null);
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

      // Owned vessel (map-independent) — build whatever hull the player owns. Defaults to the pinnace for
      // a brand-new player. Fetched here, before the vessel build below reads this.selectedSlug.
      this.selectedSlug = await this.runInitStep('fetch-ship', 'Mustering your crew…', async () => {
        try {
          const r = await firstValueFrom(this.http.get<{ ship: string }>(`${Settings.apiUrl}player-ship`));
          return (r?.ship) || 'pinnace';
        } catch { return 'pinnace'; }
      });

      // 1. Boot BabylonJS scene (WebGPU/WebGL)
      await this.runInitStep('init-scene', 'Preparing the ocean…', async () => {
        await this.sceneService.initAsync(this.canvasRef.nativeElement);
        this.sceneStarted = true;
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
        // PERF DIAGNOSTIC: ?noclouds skips the volumetric clouds (raymarch) to isolate their cost.
        if (!location.search.includes('noclouds')) { this.cloudService.init(); }
        // Hold-right-click spyglass magnifier (camera + canvas exist by now).
        this.telescopeService.init();
        // Weather-driven ambient sea bed (filtered-noise wash + whitecap hiss).
        this.oceanAudioService.init();
      });

      // 3. Load terrain
      await this.runInitStep('init-terrain', 'Surveying the coastline…', async () => {
        await this.terrainService.init();
      });

      // 3a. Harbor towns — piers at the detected sites (needs the terrain manifest).
      await this.runInitStep('init-harbors', 'Raising the harbours…', async () => {
        await this.harborService.init();
      });
      // Floating salvage crates (from sunk NPC merchants) — render + sail-over collection.
      this.multiplayerService.salvageService.init(this.sceneService.scene);

      // 3b. Asset scattering (grass/rocks/driftwood/trees/palms) — needs the terrain ready.
      // PERF DIAGNOSTIC: ?noscatter skips all grass/reed instancing to isolate its cost.
      await this.runInitStep('init-scatter', 'Planting the wilds…', async () => {
        if (!location.search.includes('noscatter')) { await this.scatterService.init(); }
        // Coastal birds — flocks of gulls near land (rafts on the water + circling overhead). Own
        // service (they move, unlike static scatter). PERF DIAGNOSTIC: ?nobirds skips them.
        if (!location.search.includes('nobirds')) { await this.birdService.init(); }
        // A single pod of dolphins that frolics around the boat. PERF DIAGNOSTIC: ?nodolphins skips it.
        if (!location.search.includes('nodolphins')) { await this.dolphinService.init(); }
        // Colored bait-fish schools in the shallows (seen through the refraction). PERF DIAGNOSTIC: ?nofish skips.
        if (!location.search.includes('nofish')) { await this.fishSchoolService.init(); }
        // Intro-tutorial action detection (look/steer/trim acks complete by DOING them, not a button).
        this.questActionService.start();
        // Underwater seaweed clumps, shallows-only, seen through the shallow refraction. ?noseaweed skips.
        if (!location.search.includes('noseaweed')) { await this.seaweedService.init(); }
        // Shoreline reeds — rooted in the water's edge, tops peeking above the surface. ?noreeds skips.
        if (!location.search.includes('noreeds')) { await this.reedService.init(); }
        // Ship's bell: a brief "clang clang" at midnight / dawn / noon / dusk. ?nobells skips it.
        if (!location.search.includes('nobells')) { this.shipBellService.init(); }
        // Sail canvas rustle/flap when sails are set (more under full sail + wind). ?nosailsfx skips it.
        if (!location.search.includes('nosailsfx')) { this.sailAudioService.init(); }
      });

      // 4. Fetch vessel
      const vessel = await this.runInitStep('fetch-vessel', 'Rigging your vessel…', async () => {
        return await firstValueFrom(
          this.http.get<Vessel>(`${Settings.apiUrl}vessels/${this.selectedSlug}`),
        );
      });

      // 5. Determine spawn.
      // First-time players (no saved location) spawn just off a random town's pier, facing it — so the
      // game opens "arriving at a harbour". harborSpawn() falls back to coastalSpawn() (then to
      // nearestSpawn(0,0)) if there are no towns / the spot isn't navigable.
      const s = this.terrainService.harborSpawn();
      let spawnX = s.spawnX;
      let spawnZ = s.spawnZ;
      let spawnHeading = s.heading;

      const saved = await this.runInitStep('load-player-location', 'Checking your last anchorage…', async () => {
        return await firstValueFrom(
          this.http.get<{ x: number; z: number; heading: number } | null>(
            `${Settings.apiUrl}player-location/${encodeURIComponent(this.callsign)}`,
          ).pipe(catchError((err: HttpErrorResponse) => {
            // An auth failure here means the session token is invalid — we must NOT silently fall back
            // to the (0,0) new-player spawn, or the player loses their real position. Re-throw so the
            // outer catch routes them to the login screen. Any OTHER error (network/5xx) is transient →
            // swallow and use the default spawn.
            if (err.status === 401 || err.status === 403) throw err;
            return of(null);
          })),
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

      // Location persistence is now SERVER-authoritative: the websocket server saves the validated
      // pose every 30 s + on disconnect. No client-side save (it would be a tamper vector).
      this.phase.set('sailing');
    } catch (error) {
      // A 401/403 anywhere in startup (verify-auth or the player-location fetch) means the stored
      // session is no longer valid. Force a fresh login rather than dropping the player into the game
      // at the wrong spot — they come back authenticated, with their real saved location.
      const status = (error instanceof HttpErrorResponse) ? error.status : 0;
      if (status === 401 || status === 403) {
        console.warn('[GameInit] auth failure during startup — sending to login to re-authenticate');
        this.forceReauth();
        return;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[GameInit] Fatal startup error:', err);
      this.loadingMsg.set('Startup failed. Check browser console for [GameInit] logs.');
      this.initError.set('Could not set sail. Check your connection and try again.');
      this.phase.set('selecting');
      return;
    }
  }

  /** Abort a half-built startup on an auth failure: tear down (full engine dispose — navigating away
   *  destroys this component + its canvas, so the next /game entry must boot a fresh engine), clear the
   *  stale credentials, and route to the login screen. */
  private forceReauth(): void {
    this.callsign = '';        // suppress teardown's location-save — the token is invalid anyway
    this.teardown(false);      // full teardown (engine included) of whatever booted so far
    this.selectedSlug = '';
    this.phase.set('selecting');
    this.authService.flagSessionExpired();   // login screen explains WHY they were bounced here
    this.authService.clearStorage();
    this.router.navigate(['/login']);
  }

  private async runInitStep<T>(tag: string, message: string, fn: () => Promise<T>): Promise<T> {
    this.loadingMsg.set(message);
    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[GameInit:${tag}]`, err);
      throw error;   // rethrow the ORIGINAL (preserves HttpErrorResponse + its status for re-auth)
    }
  }

  /** Full teardown of the running game — safe to call from both exit and destroy.
   *  keepEngine=true (Return to Harbour) rebuilds only the Scene next session, reusing the WebGPU
   *  engine; false (component destroy) disposes the engine too. */
  private teardown(keepEngine = false): void {
    if (!this.sceneStarted) return;   // scene never booted → nothing to tear down
    this.sceneStarted = false;
    // Location is saved server-side (on the ws disconnect below + a 30 s autosave) — no client PUT.
    this.weatherService.stop();
    this.multiplayerService.disconnect();
    this.cannonService.dispose();
    this.musicService.dispose();
    this.cloudService.dispose();
    this.telescopeService.dispose();
    this.oceanAudioService.dispose();
    this.dolphinService.dispose();
    this.fishSchoolService.dispose();
    this.questActionService.stop();
    this.seaweedService.dispose();
    this.reedService.dispose();
    this.shipBellService.dispose();
    this.sailAudioService.dispose();
    this.terrainService.dispose();
    this.harborService.dispose();
    this.vesselService.dispose();
    // The FFT ocean engine + renderer are root singletons whose init() early-returns on persisted
    // fields (_active / _geometry). Without disposing them here they'd keep dead-engine compute
    // generators + clipmap geometry across a return-to-harbour and skip rebuilding on the new engine.
    this.oceanFftRenderer.dispose();
    this.oceanFftEngine.dispose();
    // Drop the cached vessel AssetContainers BEFORE the engine dies. They hold GPU
    // buffers/materials bound to THIS engine; if they survive into the next session
    // (the cache is a root singleton), instantiateRigged() would clone stale, dead-engine
    // resources into the fresh scene → "Invalid BindGroup" in the ocean-reflection /
    // prePass passes (a broken pipeline that only a hard reload cleared). Clearing here
    // makes the next vessel load fetch + parse fresh against the new engine.
    this.vesselAssetCache.clearCache();
    // Same hazard for the scatter (rocks/trees/palms/birds/dolphins/seaweed/reeds) GLB containers:
    // a module-level cache that would hand the next session dead-engine containers (→ "Cannot read
    // getChildMeshes of undefined" on instantiate). Drop it so each session re-fetches fresh.
    clearScatterCache();
    if (keepEngine) { this.sceneService.disposeScene(); }
    else { this.sceneService.dispose(); }
  }

  /** Called by the pause menu Resume button or Esc toggle. */
  onResume(): void {
    this.paused.set(false);
    this.showSettings.set(false);
    this.showHelp.set(false);
  }

  /** Acknowledge a sinking → respawn at the nearest harbor town (teleport + full repair). The server
   *  respawn clears our authoritative pose so the teleport isn't clamped by movement validation. */
  onConfirmSunk(): void {
    const pos = this.vesselService.getPosition();
    const s = this.terrainService.nearestHarborSpawn(pos.x, pos.z);
    this.vesselService.respawnAt(s.spawnX, s.spawnZ, s.heading);
    this.multiplayerService.requestRespawn();
  }

  /** Dock prompt: auto-steer the boat to a tie-up berth alongside the pier, then moor (the town menu
   *  opens once tied — see the effect in the constructor). */
  onDock(town: TerrainHarbor): void {
    const p = this.vesselService.getPosition();
    const heading = this.vesselService.state().heading;
    const berth = this.harborService.computeBerth(town, p.x, p.z, heading);
    this.vesselService.dockAt(berth);
  }

  /** Cast off: release the mooring so the helm answers again (closes the town menu via the tiedUp effect). */
  onCastOff(): void {
    this.vesselService.castOff();
  }

  /** Dock action: open the town trader (asks the server for this town's market quote). */
  onTrade(townId: string): void {
    this.multiplayerService.openTrade(townId);
    this.tradeMenuOpen.set(true);
  }

  /** Dock action: open the shipwright (hull repair + buy/commission vessels). The panel fetches the catalogue itself. */
  onShipwright(): void {
    this.multiplayerService.shipError.set(null);
    this.shipwrightOpen.set(true);
  }

  /** Dock action: open the tavern (recruit crew lost to grapeshot). The panel reads the live crew count. */
  /** Dock action: open the Governor's Mansion / Mayor's House (buy back bad standing with the town's nation). */
  onGovernor(): void {
    this.multiplayerService.pardonError.set(null);
    this.governorOpen.set(true);
  }

  onTavern(): void {
    this.multiplayerService.recruitError.set(null);
    this.tavernOpen.set(true);
  }

  /** Refit the local vessel into a freshly-bought hull: fetch its full def, then hot-swap in place. */
  private async refitVessel(slug: string): Promise<void> {
    try {
      const vessel = await firstValueFrom(this.http.get<Vessel>(`${Settings.apiUrl}vessels/${slug}`));
      await this.vesselService.swapVessel(vessel);
      this.selectedSlug = slug;
    } catch (err) {
      console.warn('[Shipwright] refit failed:', err);
    }
  }

  /** Called by the HUD exit button or pause menu — tears down the scene and returns to vessel selection. */
  onExitGame(): void {
    this.paused.set(false);
    this.showSettings.set(false);
    this.showHelp.set(false);
    this.teardown(true);   // keep the WebGPU engine alive; only the Scene is rebuilt on re-entry
    this.selectedSlug = '';
    this.callsign     = '';
    this.loadingMsg.set('Charting the archipelago…');
    this.phase.set('selecting');
  }

  /** "Return to Harbour" → leave the game session entirely and go to the home screen.
   *  Navigation destroys this component, so ngOnDestroy → teardown() disconnects multiplayer and
   *  disposes the scene/engine (teardown is idempotent, so the explicit path stays clean). */
  onReturnToHarbor(): void {
    this.paused.set(false);
    this.showSettings.set(false);
    this.showHelp.set(false);
    this.router.navigate(['/home']);
  }

  ngOnDestroy(): void {
    this.teardown();
  }
}
