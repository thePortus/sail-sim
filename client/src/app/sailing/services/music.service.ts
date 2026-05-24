import { Injectable, signal, computed } from '@angular/core';
import * as Tone from 'tone';
import { Midi } from '@tonejs/midi';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrackMeta {
  filename: string;
  name:     string;
  url:      string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_KEY       = 'ignis_music_enabled';
const LOOP_GAP_SEC = 1.5;   // silence between loop repetitions

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class MusicService {

  // ── Public signals ─────────────────────────────────────────────────────────
  readonly isEnabled  = signal<boolean>(this.readStoredEnabled());
  readonly isPlaying  = signal<boolean>(false);
  readonly trackIndex = signal<number>(0);
  readonly trackList  = signal<TrackMeta[]>([]);

  readonly currentTrackName = computed(() => {
    const list = this.trackList();
    const idx  = this.trackIndex();
    return list.length ? list[idx % list.length].name : '—';
  });

  // ── Private state ──────────────────────────────────────────────────────────
  private apiUrl = '';

  private synth!:  Tone.PolySynth;
  private reverb!: Tone.Reverb;

  /**
   * Parsed MIDI objects keyed by filename.
   * Populated eagerly on init so every subsequent play is instant.
   */
  private midiCache = new Map<string, Midi>();

  private initialized = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Call once after the user's first gesture (vessel selection click).
   * Builds the synth chain, fetches the track list, preloads all MIDI files,
   * and starts playback if the preference is enabled.
   */
  async init(apiUrl: string): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.apiUrl = apiUrl;

    // ── Build synth chain ──────────────────────────────────────────────────
    // Reverb must be generated (async IR build) before connecting audio.
    this.reverb = new Tone.Reverb({ decay: 3.5, wet: 0.35 });
    await this.reverb.generate();    // ← REQUIRED: without this the IR buffer is empty
    this.reverb.toDestination();

    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope:   { attack: 0.04, decay: 0.1, sustain: 0.7, release: 1.2 },
      volume:     -14,
    }).connect(this.reverb);
    // Raise polyphony ceiling so dense MIDI tracks don't drop notes
    this.synth.maxPolyphony = 32;

    // ── Fetch track list ───────────────────────────────────────────────────
    try {
      const res    = await fetch(`${apiUrl}music`);
      const tracks = (await res.json()) as TrackMeta[];
      this.trackList.set(tracks);
    } catch {
      console.warn('[MusicService] Could not fetch track list.');
      return;
    }

    if (!this.trackList().length) return;

    // ── Preload all MIDI files in the background ───────────────────────────
    // This fills midiCache so the first play (and every subsequent one) is
    // instant — no waiting for a network round-trip while the game is running.
    for (const track of this.trackList()) {
      this.fetchAndCache(track.filename).catch(() => {});
    }

    // ── Start playback if the user preference says so ──────────────────────
    if (this.isEnabled()) {
      await Tone.start();   // ensure AudioContext is running after user gesture
      await this.startCurrentTrack();
    }
  }

  /** Toggle music on/off; persists preference to localStorage. */
  async toggle(): Promise<void> {
    const next = !this.isEnabled();
    this.isEnabled.set(next);
    localStorage.setItem(LS_KEY, String(next));

    if (next) {
      await Tone.start();
      await this.startCurrentTrack();
    } else {
      this.stopPlayback();
    }
  }

  /** Advance to the next track. */
  async next(): Promise<void> {
    const list = this.trackList();
    if (!list.length) return;
    this.stopPlayback();
    this.trackIndex.set((this.trackIndex() + 1) % list.length);
    if (this.isEnabled()) await this.startCurrentTrack();
  }

  /** Full teardown — call in GameComponent.teardown(). */
  dispose(): void {
    this.stopPlayback();
    this.synth?.dispose();
    this.reverb?.dispose();
    this.midiCache.clear();
    this.initialized = false;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private readStoredEnabled(): boolean {
    try {
      const v = localStorage.getItem(LS_KEY);
      return v === null ? true : v === 'true';   // default: enabled
    } catch {
      return true;
    }
  }

  /** Stop Transport, cancel all events, reset to position 0. */
  private stopPlayback(): void {
    Tone.Transport.stop();
    Tone.Transport.cancel();           // remove all scheduled events
    Tone.Transport.position = 0;       // rewind so next start begins at the top
    this.isPlaying.set(false);
  }

  /**
   * Fetch and parse a MIDI file, storing the result in midiCache.
   * Returns the cached copy if already loaded — safe to call many times.
   */
  private async fetchAndCache(filename: string): Promise<Midi> {
    const cached = this.midiCache.get(filename);
    if (cached) return cached;

    const midi = await Midi.fromUrl(
      `${this.apiUrl}music/${encodeURIComponent(filename)}`
    );
    this.midiCache.set(filename, midi);
    return midi;
  }

  /**
   * Schedule all notes from the current track onto the Transport timeline
   * and start playing.
   *
   * Key correctness rule:
   *   Tone.Transport.schedule(cb, time) expects `time` in Transport-seconds
   *   (i.e. seconds from the start of the piece), NOT AudioContext time.
   *   note.time from @tonejs/midi is already in Transport-seconds, so we use
   *   it directly — never add Tone.now() to it.
   */
  private async startCurrentTrack(): Promise<void> {
    const list = this.trackList();
    if (!list.length) return;

    const meta = list[this.trackIndex() % list.length];

    // Clear any previous state before re-scheduling
    this.stopPlayback();

    let midi: Midi;
    try {
      midi = await this.fetchAndCache(meta.filename);
    } catch (err) {
      console.warn('[MusicService] Failed to load MIDI:', meta.filename, err);
      return;
    }

    // ── Schedule every note at its Transport-relative time ─────────────────
    for (const track of midi.tracks) {
      for (const note of track.notes) {
        // `note.time` is seconds from piece start — exactly what Transport.schedule wants.
        Tone.Transport.schedule((audioTime) => {
          this.synth.triggerAttackRelease(
            note.name,
            note.duration,
            audioTime,       // Web Audio API absolute time (supplied by Transport)
            note.velocity,
          );
        }, note.time);
      }
    }

    // ── Configure looping via Transport (avoids reschedule on every loop) ──
    Tone.Transport.loop      = true;
    Tone.Transport.loopStart = 0;
    Tone.Transport.loopEnd   = midi.duration + LOOP_GAP_SEC;

    // Small ahead-of-time offset so the scheduling queue is settled
    // before the first note fires.
    Tone.Transport.start('+0.05');
    this.isPlaying.set(true);
  }
}
