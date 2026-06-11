import { Component, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MusicService } from '../../services/music.service';
import { SfxService } from '../../services/sfx.service';

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

      <!-- Now playing -->
      <div class="now-playing">
        <span class="now-playing-icon">{{ music.isPlaying() ? '♫' : '♩' }}</span>
        <span class="now-playing-name">{{ music.currentTrackName() }}</span>
      </div>

      <!-- Audio controls -->
      <div class="pause-audio">
        <div class="audio-buttons">
          <button class="audio-btn" [class.audio-btn--on]="music.isEnabled()" (click)="toggleMusic()">
            {{ music.isEnabled() ? '🔊 Music On' : '🔇 Music Off' }}
          </button>
          <button class="audio-btn" (click)="nextTrack()"
                  [disabled]="music.trackList().length <= 1">⏭ Next Track</button>
        </div>
        <div class="audio-slider-row">
          <span class="audio-label">Music</span>
          <input type="range" min="0" max="1" step="0.01"
                 [value]="music.volume()" (input)="onVolume($event)" class="audio-slider" />
          <span class="audio-pct">{{ volumePct() }}%</span>
        </div>
        <div class="audio-slider-row">
          <span class="audio-label">Sound</span>
          <input type="range" min="0" max="1" step="0.01"
                 [value]="sfx.volume()" (input)="onSfxVolume($event)" class="audio-slider" />
          <span class="audio-pct">{{ sfxVolumePct() }}%</span>
        </div>
      </div>

      <!-- Navigation buttons -->
      <div class="pause-actions">
        <button class="pause-btn pause-btn--primary" (click)="onResume()">
          ▶ Resume Sailing
        </button>
        <button class="pause-btn pause-btn--settings" (click)="onSettings()">
          ⚙ Settings
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
    .pause-backdrop {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(4, 10, 20, 0.72);
      backdrop-filter: blur(4px);
      cursor: pointer;
    }
    .pause-panel {
      position: fixed; z-index: 201;
      top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: min(400px, 90vw);
      background: linear-gradient(160deg, #2e2013 0%, #15100a 100%);
      border: 1px solid rgba(200, 170, 100, 0.30);
      border-radius: 12px;
      padding: 2rem 2rem 1.5rem;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7),
                  0 0 0 1px rgba(255, 255, 255, 0.04) inset;
      display: flex; flex-direction: column; gap: 1.5rem;
    }
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
    .now-playing {
      display: flex; align-items: center; gap: 0.5rem; justify-content: center;
      font-family: monospace; font-size: 0.85rem;
      color: rgba(255,255,255,0.65);
    }
    .now-playing-icon { color: #c8a44a; font-size: 1rem; }
    .now-playing-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Audio controls */
    .pause-audio {
      display: flex; flex-direction: column; gap: 0.5rem;
      padding: 0.85rem; border-radius: 8px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .audio-buttons { display: flex; gap: 0.5rem; }
    .audio-btn {
      flex: 1; padding: 0.45rem; border-radius: 6px;
      font-family: monospace; font-size: 0.8rem; font-weight: bold; cursor: pointer;
      background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.72);
      border: 1px solid rgba(255,255,255,0.12);
      transition: filter 0.15s, color 0.15s, background 0.15s;
    }
    .audio-btn:hover:not(:disabled) { filter: brightness(1.15); color: #fff; }
    .audio-btn:disabled { opacity: 0.4; cursor: default; }
    .audio-btn--on { color: #c8a44a; border-color: rgba(200,170,100,0.35); }
    .audio-slider-row { display: flex; align-items: center; gap: 0.6rem; }
    .audio-label {
      font-family: monospace; font-size: 0.75rem; color: rgba(255,255,255,0.55);
      width: 3.2rem; flex-shrink: 0;
    }
    .audio-slider { flex: 1; accent-color: #c8a44a; cursor: pointer; }
    .audio-pct {
      font-family: monospace; font-size: 0.72rem; color: rgba(255,255,255,0.45);
      width: 2.6rem; text-align: right; flex-shrink: 0;
    }

    .pause-actions { display: flex; flex-direction: column; gap: 0.6rem; }
    .pause-btn {
      width: 100%; padding: 0.75rem;
      border-radius: 8px;
      font-family: monospace; font-size: 0.95rem; font-weight: bold;
      cursor: pointer; border: none;
      transition: filter 0.15s, transform 0.1s, background 0.15s, color 0.15s;
    }
    .pause-btn:hover  { filter: brightness(1.12); transform: translateY(-1px); }
    .pause-btn:active { transform: translateY(0); }
    .pause-btn--primary {
      background: linear-gradient(135deg, #c89a4a, #a3792f);
      color: #2c1d09;
      border: 1px solid #7d5a24;
    }
    .pause-btn--settings {
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.78);
      border: 1px solid rgba(200, 170, 100, 0.30);
    }
    .pause-btn--settings:hover { color: #c8a44a; }
    .pause-btn--danger {
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.50);
      border: 1px solid rgba(255,255,255,0.12);
    }
    .pause-btn--danger:hover { color: rgba(255,100,100,0.85); border-color: rgba(255,100,100,0.25); }
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
  @Output() resume       = new EventEmitter<void>();
  @Output() quit         = new EventEmitter<void>();
  @Output() openSettings = new EventEmitter<void>();

  readonly music = inject(MusicService);
  readonly sfx   = inject(SfxService);

  onResume():   void { this.resume.emit(); }
  onQuit():     void { this.quit.emit(); }
  onSettings(): void { this.openSettings.emit(); }

  // Audio controls (mirror the settings menu; both bind the same MusicService/SfxService signals).
  volumePct(): number { return Math.round(this.music.volume() * 100); }
  onVolume(e: Event): void { this.music.setVolume(+(e.target as HTMLInputElement).value); }
  sfxVolumePct(): number { return Math.round(this.sfx.volume() * 100); }
  onSfxVolume(e: Event): void { this.sfx.setVolume(+(e.target as HTMLInputElement).value); }
  async toggleMusic(): Promise<void> { await this.music.toggle(); }
  async nextTrack(): Promise<void> { await this.music.next(); }
}
