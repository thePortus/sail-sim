import {
  Component, inject, signal, computed, OnInit, OnDestroy,
} from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminService }   from '../../services/admin.service';
import { WeatherService } from '../../services/weather.service';
import { SceneService }   from '../../services/scene.service';
import { VesselService }  from '../../services/vessel.service';

const CARDINALS = [
  'N','NNE','NE','ENE','E','ESE','SE','SSE',
  'S','SSW','SW','WSW','W','WNW','NW','NNW',
];

@Component({
  selector: 'app-admin-panel',
  standalone: true,
  imports: [CommonModule, DecimalPipe, FormsModule],
  templateUrl: './admin-panel.component.html',
  styles: [`
    .admin-panel {
      position: fixed; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 340px;
      background: rgba(8, 16, 28, 0.96);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      color: #d0dce8;
      font-family: 'JetBrains Mono', 'Fira Mono', monospace;
      font-size: 12px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.7);
      z-index: 200;
      user-select: none;
    }
    .panel-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .panel-title { font-size: 13px; font-weight: 600; letter-spacing: 0.05em; color: #88aacc; }
    .close-btn {
      background: none; border: none; color: #667; font-size: 14px; cursor: pointer;
      padding: 2px 4px; border-radius: 4px; line-height: 1;
      transition: color 0.15s;
    }
    .close-btn:hover { color: #aac; }
    .panel-section {
      padding: 12px 14px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .panel-section:last-child { border-bottom: none; }
    .section-title {
      margin: 0 0 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; color: #5588aa;
      display: flex; align-items: center; gap: 8px;
    }
    .badge {
      font-size: 9px; padding: 1px 6px; border-radius: 3px; letter-spacing: 0.06em;
    }
    .badge--active { background: rgba(0,220,100,0.18); color: #44dd88; border: 1px solid #44dd8844; }
    .field-label {
      display: block; margin-bottom: 4px; color: #8899aa; font-size: 11px;
    }
    .value-tag { color: #ccddee; font-weight: 600; }
    .slider {
      width: 100%; margin-bottom: 10px;
      -webkit-appearance: none; appearance: none;
      height: 4px; border-radius: 2px;
      background: rgba(255,255,255,0.12);
      outline: none; cursor: pointer;
    }
    .slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px; border-radius: 50%;
      background: #3388cc; border: 2px solid #aaccee; cursor: pointer;
    }
    .btn-row { display: flex; gap: 8px; margin-top: 4px; }
    .btn {
      flex: 1; padding: 5px 0; border-radius: 4px; border: none; cursor: pointer;
      font-family: inherit; font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
      transition: background 0.15s, opacity 0.15s;
    }
    .btn:disabled { opacity: 0.35; cursor: default; }
    .btn--apply { background: #1a5080; color: #aaddff; }
    .btn--apply:hover:not(:disabled) { background: #226699; }
    .btn--clear { background: rgba(80,30,20,0.7); color: #ffaa88; }
    .btn--clear:hover:not(:disabled) { background: rgba(120,40,25,0.8); }
    .btn--teleport { background: #1a4a30; color: #88ffbb; }
    .btn--teleport:hover:not(:disabled) { background: #226040; }
    .coord-row { display: flex; gap: 8px; margin-bottom: 8px; }
    .coord-field { flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .coord-label { font-size: 10px; color: #8899aa; letter-spacing: 0.06em; }
    .coord-input {
      width: 100%; padding: 4px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.06); color: #ccddee;
      font-family: inherit; font-size: 12px; outline: none; box-sizing: border-box;
    }
    .coord-input:focus { border-color: rgba(51,136,204,0.6); background: rgba(51,136,204,0.08); }
    .current-pos { font-size: 10px; color: #556677; margin-bottom: 8px; }
  `],
})
export class AdminPanelComponent implements OnInit, OnDestroy {
  private adminService   = inject(AdminService);
  private weatherService = inject(WeatherService);
  private sceneService   = inject(SceneService);
  private vesselService  = inject(VesselService);

  // ── Panel visibility ──────────────────────────────────────────────────────
  visible = signal(false);

  // ── Weather controls ──────────────────────────────────────────────────────
  windSpeed   = signal(10);    // m/s
  windBearing = signal(0);     // degrees FROM
  cloudiness  = signal(0.25);  // 0 = clear → 1 = storm

  weatherOverrideActive = signal(false);

  beaufort = computed(() => Math.min(12, Math.floor(this.windSpeed() / 2.5)));
  cardinalDir = computed(() =>
    CARDINALS[Math.round(this.windBearing() / 22.5) % 16]
  );
  skyConditionLabel = computed(() => {
    const c = this.cloudiness();
    if (c > 0.94) return 'Storm';
    if (c > 0.82) return 'Rain';
    if (c > 0.68) return 'Drizzle';
    if (c > 0.50) return 'Overcast';
    if (c > 0.28) return 'Partly Cloudy';
    return 'Clear';
  });

  // ── Teleport controls ────────────────────────────────────────────────────
  teleportX = signal('0');
  teleportZ = signal('0');

  vesselPos = computed(() => {
    const s = this.vesselService.state();
    return { x: Math.round(s.x), z: Math.round(s.z) };
  });

  // ── Time controls ─────────────────────────────────────────────────────────
  targetHour = signal(12.0);   // 0–24
  timeOverrideActive = signal(false);

  timeLabel = computed(() => {
    const h  = this.targetHour();
    const hh = Math.floor(h);
    const mm = Math.round((h % 1) * 60);
    return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  });

  // ── Keyboard toggle (backtick) ────────────────────────────────────────────
  private keyHandler = (e: KeyboardEvent) => {
    if (e.code === 'Backquote') this.toggle();
  };

  ngOnInit(): void {
    window.addEventListener('keydown', this.keyHandler);
    // Pre-fill sliders with the live weather if available
    const w = this.weatherService.weather();
    if (w) {
      this.windSpeed.set(w.wind.speed);
      this.windBearing.set(w.wind.fromBearingDeg);
      this.cloudiness.set(parseFloat(w.cloudiness.toFixed(2)));
    }
    // Pre-fill time from scene
    this.targetHour.set(parseFloat(this.sceneService.gameTime().toFixed(2)));
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.keyHandler);
  }

  toggle(): void { this.visible.update(v => !v); }
  hide():   void { this.visible.set(false); }

  // ── Weather actions ───────────────────────────────────────────────────────

  applyWeather(): void {
    const bearing    = this.windBearing();
    const speed      = this.windSpeed();
    const cloudiness = this.cloudiness();

    // Weather is fully server-authoritative: send the override to the server, which
    // broadcasts the new state to EVERY client (including this admin) over the WS.
    // No local apply — that would diverge this admin from everyone else.
    this.adminService.setWeatherOverride(speed, bearing, cloudiness).subscribe({
      error: (err) => console.warn('[AdminPanel] weather override rejected:', err.status),
    });

    this.weatherOverrideActive.set(true);
  }

  clearWeather(): void {
    this.adminService.clearWeatherOverride().subscribe({
      error: (err) => console.warn('[AdminPanel] clear weather rejected:', err.status),
    });
    this.weatherOverrideActive.set(false);
  }

  // ── Time actions ──────────────────────────────────────────────────────────

  applyTime(): void {
    const h = this.targetHour();
    // Day/night is server-authoritative too. The server computes the offset and
    // broadcasts it; the scene picks it up via the weather snapshot for all players.
    this.adminService.setTimeOffset(h).subscribe({
      error: (err) => console.warn('[AdminPanel] time offset rejected:', err.status),
    });
    this.timeOverrideActive.set(true);
  }

  // ── Teleport actions ──────────────────────────────────────────────────────

  useCurrentPos(): void {
    const pos = this.vesselPos();
    this.teleportX.set(String(pos.x));
    this.teleportZ.set(String(pos.z));
  }

  teleport(): void {
    const x = parseFloat(this.teleportX());
    const z = parseFloat(this.teleportZ());
    if (isNaN(x) || isNaN(z)) return;

    // Server verifies admin role first; only move the vessel on a 200 response.
    this.adminService.teleport(x, z).subscribe({
      next: () => this.vesselService.teleportTo(x, z),
      error: (err) => console.warn('[AdminPanel] teleport rejected:', err.status),
    });
  }

  clearTime(): void {
    this.sceneService.clearTimeOffset();
    this.adminService.clearTimeOffset().subscribe({
      error: (err) => console.warn('[AdminPanel] clear time rejected:', err.status),
    });
    this.timeOverrideActive.set(false);
  }
}
