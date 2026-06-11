import { Component, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MusicService } from '../../services/music.service';
import { SfxService } from '../../services/sfx.service';
import { TerrainService } from '../../services/terrain.service';
import { CloudService } from '../../services/cloud.service';
import { SceneService } from '../../services/scene.service';
import { OceanService } from '../../services/ocean.service';
import { OceanFFTRenderer } from '../../services/ocean-fft-renderer.service';
import { ScatterService } from '../../services/scatter/scatter.service';
import { BirdService } from '../../services/bird.service';

/**
 * Settings panel — opened from the pause menu's "Settings" button. Houses all
 * audio and graphics options (migrated out of the pause menu). Render Scale is
 * the headline perf lever; the rest are the existing quality dials.
 */
@Component({
  selector: 'app-settings-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="set-backdrop" (click)="onClose()"></div>

    <div class="set-panel" (click)="$event.stopPropagation()">
      <div class="set-header">
        <div class="set-title">⚙ Settings</div>
      </div>

      <div class="set-scroll">
        <!-- ── Graphics ─────────────────────────────────────────────────── -->
        <div class="set-section">
          <div class="set-section-label">Graphics</div>

          <div class="preset-row">
            @for (p of presetNames; track p) {
              <button class="preset-btn" [class.preset-btn--active]="activePreset === p"
                      (click)="applyPreset(p)">{{ p }}</button>
            }
          </div>
          <div class="q-hint" style="margin-bottom:0.7rem">One-tap quality preset. Tweak anything below and it becomes “Custom”.</div>

          <div class="q-row">
            <span class="q-label">Render Scale</span>
            <span class="q-value">{{ renderScalePct() }}%</span>
          </div>
          <input type="range" min="0.5" max="1" step="0.05"
                 [value]="renderScale"
                 (input)="onRenderScale($event)"
                 class="q-slider" />
          <div class="q-hint">Lower = much faster, softer image. The biggest FPS lever.</div>

          <div class="q-row" style="margin-top:0.7rem">
            <span class="q-label">Adaptive Resolution</span>
            <button class="toggle-btn" [class.toggle-btn--on]="adaptiveRes"
                    (click)="toggleAdaptiveRes()">{{ adaptiveRes ? 'On' : 'Off' }}</button>
          </div>
          <div class="q-hint">Auto-lowers render scale under load to hold a steady frame rate (never above your Render Scale). Recovers FPS in heavy scenes; the image softens only when needed.</div>

          <div class="q-row" style="margin-top:0.7rem">
            <span class="q-label">Shadows</span>
            <span class="q-value">{{ shadowLabels[shadowQuality] }}</span>
          </div>
          <input type="range" min="0" max="3" step="1"
                 [value]="shadowQuality"
                 (input)="onShadowQuality($event)"
                 class="q-slider" />
          <div class="q-ticks"><span>Off</span><span>Low</span><span>Med</span><span>High</span></div>

          <div class="q-row" style="margin-top:0.7rem">
            <span class="q-label">Cloud Quality</span>
            <span class="q-value">{{ cloudLabels[cloudQuality] }}</span>
          </div>
          <input type="range" min="0" max="3" step="1"
                 [value]="cloudQuality"
                 (input)="onCloudQuality($event)"
                 class="q-slider" />
          <div class="q-ticks"><span>Low</span><span>Med</span><span>High</span><span>Ultra</span></div>

          <div class="q-row" style="margin-top:0.7rem">
            <span class="q-label">Grass &amp; Foliage</span>
            <span class="q-value">{{ grassLabels[grassQuality] }}</span>
          </div>
          <input type="range" min="0" max="4" step="1"
                 [value]="grassQuality"
                 (input)="onGrassQuality($event)"
                 class="q-slider" />
          <div class="q-ticks"><span>Off</span><span>Low</span><span>Med</span><span>High</span><span>Ultra</span></div>
          <div class="q-hint">Coastal grass density + draw distance. Lower is faster — foliage is GPU-heavy.</div>

          <div class="q-row" style="margin-top:0.7rem">
            <span class="q-label">Wildlife</span>
            <span class="q-value">{{ wildlifeLabels[wildlifeQuality] }}</span>
          </div>
          <input type="range" min="0" max="4" step="1"
                 [value]="wildlifeQuality"
                 (input)="onWildlifeQuality($event)"
                 class="q-slider" />
          <div class="q-ticks"><span>Off</span><span>Low</span><span>Med</span><span>High</span><span>Ultra</span></div>
          <div class="q-hint">Coastal bird flocks near land. Off removes them entirely. Higher = more flocks, spawning faster.</div>

          <div class="q-row" style="margin-top:0.7rem">
            <span class="q-label">Anti-aliasing</span>
            <span class="q-value">{{ aaLabels[aaQuality] }}</span>
          </div>
          <input type="range" min="0" max="3" step="1"
                 [value]="aaQuality"
                 (input)="onAaQuality($event)"
                 class="q-slider" />
          <div class="q-ticks"><span>Off</span><span>FXAA</span><span>2×</span><span>4×</span></div>

          <div class="q-row" style="margin-top:0.8rem">
            <span class="q-label">Reflections</span>
            <button class="toggle-btn" [class.toggle-btn--on]="reflectionsOn"
                    (click)="toggleReflections()">{{ reflectionsOn ? 'On' : 'Off' }}</button>
          </div>
          <div class="q-hint">Water mirror reflections. Off is faster — drops a full mirrored scene render.</div>

          <div class="q-row" style="margin-top:0.7rem">
            <span class="q-label">Water Transparency</span>
            <button class="toggle-btn" [class.toggle-btn--on]="transparencyOn"
                    (click)="toggleTransparency()">{{ transparencyOn ? 'On' : 'Off' }}</button>
          </div>
          <div class="q-hint">See-through shallows over sand. Off is faster — drops a terrain render pass.</div>

          <div class="q-row" style="margin-top:0.7rem">
            <span class="q-label">PBR Terrain</span>
            <button class="toggle-btn" [class.toggle-btn--on]="terrainPbrOn"
                    (click)="toggleTerrainPbr()">{{ terrainPbrOn ? 'On' : 'Off' }}</button>
          </div>
          <div class="q-hint">Physically-based terrain surfacing (richer rock/sand). Off uses the simpler classic skin.</div>

          <div class="q-row" style="margin-top:0.7rem">
            <span class="q-label">Ocean Quality</span>
            <span class="q-value">{{ oceanLabels[oceanQuality] }}</span>
          </div>
          <input type="range" min="0" max="2" step="1"
                 [value]="oceanQuality"
                 (input)="onOceanQuality($event)"
                 class="q-slider" />
          <div class="q-ticks"><span>Cheap</span><span>High</span><span>Ultra</span></div>
          <div class="q-hint">Cheap: fast procedural waves (big FPS save, simpler look). High/Ultra: full FFT
            wave simulation (WebGPU only — falls back to procedural otherwise); Ultra uses a crisper 256² grid.</div>
        </div>

        <!-- ── Audio ────────────────────────────────────────────────────── -->
        <div class="set-section">
          <div class="set-section-label">Audio</div>

          <div class="music-controls">
            <button class="music-btn" [class.music-btn--active]="music.isEnabled()"
                    (click)="toggleMusic()">
              {{ music.isEnabled() ? '🔊 Music On' : '🔇 Music Off' }}
            </button>
            <button class="music-btn" (click)="nextTrack()"
                    [disabled]="music.trackList().length <= 1">⏭ Next Track</button>
          </div>

          <div class="q-row" style="margin-top:0.6rem">
            <span class="q-label">Music Volume</span>
            <span class="q-value">{{ volumePct() }}%</span>
          </div>
          <input type="range" min="0" max="1" step="0.01"
                 [value]="music.volume()" (input)="onVolume($event)" class="q-slider" />

          <div class="q-row" style="margin-top:0.6rem">
            <span class="q-label">Sound Effects</span>
            <span class="q-value">{{ sfxVolumePct() }}%</span>
          </div>
          <input type="range" min="0" max="1" step="0.01"
                 [value]="sfx.volume()" (input)="onSfxVolume($event)" class="q-slider" />
        </div>
      </div>

      <button class="set-back" (click)="onClose()">← Back</button>
    </div>
  `,
  styles: [`
    .set-backdrop { position: fixed; inset: 0; z-index: 210; background: rgba(4,10,20,0.78);
      backdrop-filter: blur(4px); cursor: pointer; }
    .set-panel { position: fixed; z-index: 211; top: 50%; left: 50%;
      transform: translate(-50%,-50%); width: min(420px, 92vw); max-height: 88vh;
      background: linear-gradient(160deg,#0c1e35 0%,#081628 100%);
      border: 1px solid rgba(200,170,100,0.30); border-radius: 12px;
      padding: 1.5rem 1.5rem 1.25rem; box-shadow: 0 24px 60px rgba(0,0,0,0.7);
      display: flex; flex-direction: column; gap: 1rem; }
    .set-header { text-align: center; }
    .set-title { font-family: monospace; font-size: 1.4rem; font-weight: bold;
      color: #c8a44a; letter-spacing: 0.04em; }
    .set-scroll { display: flex; flex-direction: column; gap: 1rem;
      overflow-y: auto; padding-right: 0.25rem; }
    .set-section { border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
      padding: 1rem; background: rgba(0,0,0,0.25); }
    .set-section-label { font-family: monospace; font-size: 0.65rem; text-transform: uppercase;
      letter-spacing: 0.12em; color: rgba(200,170,100,0.60); margin-bottom: 0.5rem; }
    .music-controls { display: flex; gap: 0.5rem; }
    .music-btn { flex: 1; padding: 0.5rem 0.75rem; background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; font-family: monospace;
      font-size: 0.8rem; color: rgba(255,255,255,0.70); cursor: pointer; }
    .music-btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); color: #fff; }
    .music-btn--active { border-color: rgba(200,170,100,0.45); color: #c8a44a; }
    .music-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    .q-row { display: flex; justify-content: space-between; align-items: baseline; }
    .q-label { font-family: monospace; font-size: 0.8rem; color: rgba(255,255,255,0.60); }
    .q-value { font-family: monospace; font-size: 0.75rem; color: #c8a44a;
      min-width: 3.5rem; text-align: right; }
    .q-hint { font-family: monospace; font-size: 0.6rem; color: rgba(255,255,255,0.28);
      margin-top: 0.15rem; }
    .q-slider { width: 100%; height: 4px; margin: 0.25rem 0; appearance: none;
      -webkit-appearance: none; background: rgba(255,255,255,0.12); border-radius: 2px;
      cursor: pointer; outline: none; }
    .q-slider::-webkit-slider-thumb { appearance: none; -webkit-appearance: none;
      width: 14px; height: 14px; border-radius: 50%; background: #c8a44a;
      box-shadow: 0 0 6px rgba(200,164,74,0.50); cursor: pointer; }
    .q-slider::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; border: none;
      background: #c8a44a; box-shadow: 0 0 6px rgba(200,164,74,0.50); cursor: pointer; }
    .q-ticks { display: flex; justify-content: space-between; font-family: monospace;
      font-size: 0.6rem; color: rgba(255,255,255,0.25); margin-top: 0.1rem; }
    .toggle-btn { padding: 0.25rem 0.9rem; border-radius: 6px; cursor: pointer;
      font-family: monospace; font-size: 0.75rem; font-weight: bold;
      background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.55);
      border: 1px solid rgba(255,255,255,0.14); }
    .toggle-btn--on { color: #c8a44a; border-color: rgba(200,170,100,0.45);
      background: rgba(200,170,100,0.10); }
    .preset-row { display: flex; gap: 0.3rem; }
    .preset-btn { flex: 1; padding: 0.4rem 0.2rem; border-radius: 6px; cursor: pointer;
      font-family: monospace; font-size: 0.68rem; font-weight: bold;
      background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.55);
      border: 1px solid rgba(255,255,255,0.12); }
    .preset-btn:hover { color: #fff; background: rgba(255,255,255,0.10); }
    .preset-btn--active { color: #0c1e35; background: #c8a44a; border-color: #c8a44a; }
    .set-back { width: 100%; padding: 0.7rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.75); font-family: monospace;
      font-size: 0.9rem; font-weight: bold; cursor: pointer; }
    .set-back:hover { background: rgba(255,255,255,0.12); color: #fff; }
  `],
})
export class SettingsMenuComponent {
  @Output() close = new EventEmitter<void>();

  readonly music   = inject(MusicService);
  readonly sfx     = inject(SfxService);
  private readonly terrain  = inject(TerrainService);
  private readonly cloudSvc = inject(CloudService);
  private readonly sceneSvc = inject(SceneService);
  private readonly ocean    = inject(OceanService);
  private readonly oceanFftR = inject(OceanFFTRenderer);
  private readonly scatter  = inject(ScatterService);
  private readonly birds    = inject(BirdService);

  readonly shadowLabels = ['Off', 'Low', 'Medium', 'High'];
  readonly cloudLabels  = ['Low', 'Medium', 'High', 'Ultra'];
  readonly oceanLabels  = ['Cheap', 'High (FFT)', 'Ultra (FFT)'];
  readonly aaLabels     = ['Off', 'FXAA', 'MSAA 2×', 'MSAA 4×'];
  readonly grassLabels  = ['Off', 'Low', 'Medium', 'High', 'Ultra'];
  readonly wildlifeLabels = ['Off', 'Low', 'Medium', 'High', 'Ultra'];

  shadowQuality = this.terrain.getShadowQuality();
  cloudQuality  = this.cloudSvc.getCloudQuality();
  grassQuality  = this.scatter.getScatterQuality();
  wildlifeQuality = this.birds.getWildlifeQuality();
  aaQuality     = this.sceneSvc.getAaQuality();
  renderScale   = this.sceneSvc.getRenderScale();
  adaptiveRes   = this.sceneSvc.isAdaptiveResolution();
  reflectionsOn  = this.ocean.isReflectionsEnabled();
  transparencyOn = this.ocean.isWaterTransparencyEnabled();
  terrainPbrOn   = this.terrain.isTerrainPBREnabled();
  oceanQuality   = this.ocean.getOceanQuality();

  // ── Graphics presets ───────────────────────────────────────────────────────
  // Each bundles every graphics dial. Tweaking an individual control afterwards
  // drops the selection to "Custom" (activePreset = null).
  readonly presetNames = ['Potato', 'Low', 'Medium', 'High', 'Ultra'] as const;
  private readonly PRESETS: Record<string, {
    render: number; shadows: number; clouds: number; aa: number; grass: number; wildlife: number;
    ocean: number; reflections: boolean; transparency: boolean;
  }> = {
    Potato: { render: 0.50, shadows: 0, clouds: 0, aa: 0, grass: 0, wildlife: 0, ocean: 0, reflections: false, transparency: false },
    Low:    { render: 0.65, shadows: 1, clouds: 0, aa: 1, grass: 1, wildlife: 1, ocean: 0, reflections: false, transparency: false },
    Medium: { render: 0.80, shadows: 2, clouds: 1, aa: 1, grass: 2, wildlife: 2, ocean: 1, reflections: false, transparency: true  },
    High:   { render: 1.00, shadows: 2, clouds: 2, aa: 2, grass: 3, wildlife: 3, ocean: 1, reflections: true,  transparency: true  },
    Ultra:  { render: 1.00, shadows: 3, clouds: 3, aa: 3, grass: 4, wildlife: 4, ocean: 2, reflections: true,  transparency: true  },
  };
  activePreset: string | null = localStorage.getItem('ignis_graphics_preset');

  onClose(): void { this.close.emit(); }

  renderScalePct(): number { return Math.round(this.renderScale * 100); }
  onRenderScale(e: Event): void {
    this.renderScale = +(e.target as HTMLInputElement).value;
    this.sceneSvc.setRenderScale(this.renderScale);
    this.markCustom();
  }

  toggleAdaptiveRes(): void {
    this.adaptiveRes = !this.adaptiveRes;
    this.sceneSvc.setAdaptiveResolution(this.adaptiveRes);
  }

  volumePct(): number { return Math.round(this.music.volume() * 100); }
  onVolume(e: Event): void { this.music.setVolume(+(e.target as HTMLInputElement).value); }
  sfxVolumePct(): number { return Math.round(this.sfx.volume() * 100); }
  onSfxVolume(e: Event): void { this.sfx.setVolume(+(e.target as HTMLInputElement).value); }

  async toggleMusic(): Promise<void> { await this.music.toggle(); }
  async nextTrack(): Promise<void> { await this.music.next(); }

  onShadowQuality(e: Event): void {
    this.shadowQuality = +(e.target as HTMLInputElement).value;
    this.terrain.setShadowQuality(this.shadowQuality);
    this.markCustom();
  }
  onCloudQuality(e: Event): void {
    this.cloudQuality = +(e.target as HTMLInputElement).value;
    this.cloudSvc.setCloudQuality(this.cloudQuality);
    this.markCustom();
  }
  onGrassQuality(e: Event): void {
    this.grassQuality = +(e.target as HTMLInputElement).value;
    this.scatter.setScatterQuality(this.grassQuality);
    this.markCustom();
  }
  onWildlifeQuality(e: Event): void {
    this.wildlifeQuality = +(e.target as HTMLInputElement).value;
    this.birds.setWildlifeQuality(this.wildlifeQuality);
    this.markCustom();
  }
  onAaQuality(e: Event): void {
    this.aaQuality = +(e.target as HTMLInputElement).value;
    this.sceneSvc.setAaQuality(this.aaQuality);
    this.markCustom();
  }

  toggleReflections(): void {
    this.reflectionsOn = !this.reflectionsOn;
    this.ocean.setReflectionsEnabled(this.reflectionsOn);
    this.markCustom();
  }
  toggleTransparency(): void {
    this.transparencyOn = !this.transparencyOn;
    this.ocean.setWaterTransparencyEnabled(this.transparencyOn);
    this.markCustom();
  }
  onOceanQuality(e: Event): void {
    this.oceanQuality = +(e.target as HTMLInputElement).value;
    this.ocean.setOceanQuality(this.oceanQuality);
    void this.oceanFftR.applyQuality(this.oceanQuality);
    this.markCustom();
  }
  toggleTerrainPbr(): void {
    this.terrainPbrOn = !this.terrainPbrOn;
    this.terrain.setTerrainPBREnabled(this.terrainPbrOn);
  }

  applyPreset(name: string): void {
    const p = this.PRESETS[name];
    if (!p) return;
    this.renderScale = p.render;          this.sceneSvc.setRenderScale(p.render);
    this.shadowQuality = p.shadows;       this.terrain.setShadowQuality(p.shadows);
    this.cloudQuality = p.clouds;         this.cloudSvc.setCloudQuality(p.clouds);
    this.grassQuality = p.grass;          this.scatter.setScatterQuality(p.grass);
    this.wildlifeQuality = p.wildlife;    this.birds.setWildlifeQuality(p.wildlife);
    this.aaQuality = p.aa;                this.sceneSvc.setAaQuality(p.aa);
    this.reflectionsOn = p.reflections;   this.ocean.setReflectionsEnabled(p.reflections);
    this.transparencyOn = p.transparency; this.ocean.setWaterTransparencyEnabled(p.transparency);
    this.oceanQuality = p.ocean;          this.ocean.setOceanQuality(p.ocean);
    void this.oceanFftR.applyQuality(p.ocean);
    this.activePreset = name;
    localStorage.setItem('ignis_graphics_preset', name);
  }

  /** An individual tweak drops the preset selection to "Custom". */
  private markCustom(): void {
    if (this.activePreset !== null) {
      this.activePreset = null;
      localStorage.removeItem('ignis_graphics_preset');
    }
  }
}
