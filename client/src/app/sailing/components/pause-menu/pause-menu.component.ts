import { Component, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MusicService } from '../../services/music.service';
import { TerrainService } from '../../services/terrain.service';

@Component({
  selector: 'app-pause-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- Backdrop -->
    <div class="pause-backdrop" (click)="onResume()"></div>

    <!-- Panel -->
    <div class="pause-panel" (click)="$event.stopPropagation()">

      <!-- Header -->
      <div class="pause-header">
        <div class="pause-title">⚓ Anchored</div>
        <div class="pause-subtitle">Game Paused</div>
      </div>

      <!-- Music section -->
      <div class="pause-section">
        <div class="pause-section-label">Music</div>

        <div class="now-playing">
          <span class="now-playing-icon">{{ music.isPlaying() ? '♫' : '♩' }}</span>
          <span class="now-playing-name">{{ music.currentTrackName() }}</span>
        </div>

        <div class="music-controls">
          <button class="music-btn"
                  [class.music-btn--active]="music.isEnabled()"
                  (click)="toggleMusic()">
            {{ music.isEnabled() ? '🔊 Music On' : '🔇 Music Off' }}
          </button>
          <button class="music-btn" (click)="nextTrack()"
                  [disabled]="music.trackList().length <= 1">
            ⏭ Next Track
          </button>
        </div>
      </div>

      <!-- Graphics section -->
      <div class="pause-section">
        <div class="pause-section-label">Graphics</div>

        <div class="quality-row">
          <span class="quality-label">Shadows</span>
          <span class="quality-value">{{ shadowLabels[shadowQuality] }}</span>
        </div>
        <input type="range" min="0" max="3" step="1"
               [value]="shadowQuality"
               (input)="onShadowQuality($event)"
               class="quality-slider" />
        <div class="quality-ticks">
          <span>Off</span><span>Low</span><span>Medium</span><span>High</span>
        </div>
      </div>

      <!-- Navigation buttons -->
      <div class="pause-actions">
        <button class="pause-btn pause-btn--primary" (click)="onResume()">
          ▶ Resume Sailing
        </button>
        <button class="pause-btn pause-btn--danger" (click)="onQuit()">
          ← Return to Harbour
        </button>
      </div>

      <!-- Footer hint -->
      <div class="pause-hint">Press <kbd>Esc</kbd> to resume</div>
    </div>
  `,
  styles: [`
    /* ── Backdrop ─────────────────────────────────────────────────────────── */
    .pause-backdrop {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(4, 10, 20, 0.72);
      backdrop-filter: blur(4px);
      cursor: pointer;
    }

    /* ── Panel ────────────────────────────────────────────────────────────── */
    .pause-panel {
      position: fixed; z-index: 201;
      top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(400px, 90vw);
      background: linear-gradient(160deg, #0c1e35 0%, #081628 100%);
      border: 1px solid rgba(200, 170, 100, 0.30);
      border-radius: 12px;
      padding: 2rem 2rem 1.5rem;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7),
                  0 0 0 1px rgba(255, 255, 255, 0.04) inset;
      display: flex; flex-direction: column; gap: 1.5rem;
    }

    /* ── Header ───────────────────────────────────────────────────────────── */
    .pause-header { text-align: center; }
    .pause-title  {
      font-family: monospace; font-size: 1.75rem; font-weight: bold;
      color: #c8a44a; letter-spacing: 0.04em;
    }
    .pause-subtitle {
      font-family: monospace; font-size: 0.75rem; letter-spacing: 0.12em;
      text-transform: uppercase; color: rgba(255,255,255,0.35);
      margin-top: 0.25rem;
    }

    /* ── Section ──────────────────────────────────────────────────────────── */
    .pause-section {
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 1rem;
      background: rgba(0,0,0,0.25);
      display: flex; flex-direction: column; gap: 0.75rem;
    }
    .pause-section-label {
      font-family: monospace; font-size: 0.65rem;
      text-transform: uppercase; letter-spacing: 0.12em;
      color: rgba(200, 170, 100, 0.60);
    }

    /* ── Now playing ──────────────────────────────────────────────────────── */
    .now-playing {
      display: flex; align-items: center; gap: 0.5rem;
      font-family: monospace; font-size: 0.9rem;
      color: rgba(255,255,255,0.75);
    }
    .now-playing-icon { color: #c8a44a; font-size: 1rem; }
    .now-playing-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Music controls ───────────────────────────────────────────────────── */
    .music-controls { display: flex; gap: 0.5rem; }
    .music-btn {
      flex: 1; padding: 0.5rem 0.75rem;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 6px;
      font-family: monospace; font-size: 0.8rem;
      color: rgba(255,255,255,0.70);
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .music-btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); color: #fff; }
    .music-btn--active { border-color: rgba(200, 170, 100, 0.45); color: #c8a44a; }
    .music-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    /* ── Action buttons ───────────────────────────────────────────────────── */
    .pause-actions { display: flex; flex-direction: column; gap: 0.6rem; }
    .pause-btn {
      width: 100%; padding: 0.75rem;
      border-radius: 8px;
      font-family: monospace; font-size: 0.95rem; font-weight: bold;
      cursor: pointer; border: none;
      transition: filter 0.15s, transform 0.1s;
    }
    .pause-btn:hover  { filter: brightness(1.12); transform: translateY(-1px); }
    .pause-btn:active { transform: translateY(0); }

    .pause-btn--primary {
      background: linear-gradient(135deg, #1e5a8a, #1a4a72);
      color: #d0e8ff;
      border: 1px solid rgba(100, 180, 255, 0.25);
    }
    .pause-btn--danger {
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.50);
      border: 1px solid rgba(255,255,255,0.12);
    }
    .pause-btn--danger:hover { color: rgba(255,100,100,0.85); border-color: rgba(255,100,100,0.25); }

    /* ── Quality slider ───────────────────────────────────────────────────── */
    .quality-row {
      display: flex; justify-content: space-between; align-items: baseline;
    }
    .quality-label {
      font-family: monospace; font-size: 0.8rem; color: rgba(255,255,255,0.60);
    }
    .quality-value {
      font-family: monospace; font-size: 0.75rem; color: #c8a44a;
      min-width: 3.5rem; text-align: right;
    }
    .quality-slider {
      width: 100%; height: 4px; margin: 0.25rem 0;
      appearance: none; -webkit-appearance: none;
      background: rgba(255,255,255,0.12);
      border-radius: 2px; cursor: pointer; outline: none;
    }
    .quality-slider::-webkit-slider-thumb {
      appearance: none; -webkit-appearance: none;
      width: 14px; height: 14px; border-radius: 50%;
      background: #c8a44a;
      box-shadow: 0 0 6px rgba(200,164,74,0.50);
      cursor: pointer;
    }
    .quality-slider::-moz-range-thumb {
      width: 14px; height: 14px; border-radius: 50%; border: none;
      background: #c8a44a;
      box-shadow: 0 0 6px rgba(200,164,74,0.50);
      cursor: pointer;
    }
    .quality-ticks {
      display: flex; justify-content: space-between;
      font-family: monospace; font-size: 0.6rem;
      color: rgba(255,255,255,0.25);
      margin-top: 0.1rem;
    }

    /* ── Footer ───────────────────────────────────────────────────────────── */
    .pause-hint {
      text-align: center; font-family: monospace;
      font-size: 0.7rem; color: rgba(255,255,255,0.20);
    }
    .pause-hint kbd {
      display: inline-block; padding: 1px 5px;
      border: 1px solid rgba(255,255,255,0.20);
      border-radius: 3px; color: rgba(255,255,255,0.30);
    }
  `],
})
export class PauseMenuComponent {
  @Output() resume = new EventEmitter<void>();
  @Output() quit   = new EventEmitter<void>();

  readonly music   = inject(MusicService);
  private readonly terrain = inject(TerrainService);

  readonly shadowLabels = ['Off', 'Low', 'Medium', 'High'];
  shadowQuality = this.terrain.getShadowQuality();

  onResume(): void { this.resume.emit(); }
  onQuit():   void { this.quit.emit();   }

  async toggleMusic(): Promise<void> {
    await this.music.toggle();
  }

  async nextTrack(): Promise<void> {
    await this.music.next();
  }

  onShadowQuality(event: Event): void {
    this.shadowQuality = +(event.target as HTMLInputElement).value;
    this.terrain.setShadowQuality(this.shadowQuality);
  }
}
