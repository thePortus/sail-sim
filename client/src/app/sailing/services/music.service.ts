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

const LS_KEY        = 'ignis_music_enabled';
const LS_VOL_KEY    = 'ignis_music_volume';
const TRACK_GAP_SEC = 1.5;   // silence at end of a track before advancing to the next

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class MusicService {

  // ── Public signals ─────────────────────────────────────────────────────────
  readonly isEnabled  = signal<boolean>(this.readStoredEnabled());
  readonly isPlaying  = signal<boolean>(false);
  readonly trackIndex = signal<number>(0);
  readonly trackList  = signal<TrackMeta[]>([]);
  /** Linear volume 0→1.  Persisted to localStorage. */
  readonly volume     = signal<number>(this.readStoredVolume());

  readonly currentTrackName = computed(() => {
    const list = this.trackList();
    const idx  = this.trackIndex();
    return list.length ? list[idx % list.length].name : '—';
  });

  // ── Private state ──────────────────────────────────────────────────────────
  private apiUrl = '';

  // Shared reverb bus — all per-track synths connect to this.
  private reverb!: Tone.Reverb;

  // One PolySynth per active MIDI track, created in startCurrentTrack() and
  // disposed by stopPlayback(). Per-track synths keep voice pools separate so
  // a dense bass line can never steal voices from the melody.
  private trackSynths: Tone.PolySynth[] = [];

  /**
   * Parsed MIDI objects keyed by filename.
   * Populated eagerly on init so every subsequent play is instant.
   */
  private midiCache = new Map<string, Midi>();

  private initialized = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Call once after the user's first gesture (vessel selection click).
   * Builds the reverb bus, fetches the track list, preloads all MIDI files,
   * and starts playback if the preference is enabled.
   */
  async init(apiUrl: string): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.apiUrl = apiUrl;

    // Schedule notes well AHEAD of the audio clock so the music survives main-thread jank. Tone's Transport runs
    // its scheduling clock on the MAIN thread; with the default 0.1 s lookAhead, any stall longer than that (much
    // more likely on a slower Windows machine, e.g. while a held turn-key drives extra render/CD work) makes the
    // clock fall behind → notes batch up and "chunk"/hold. 0.3 s tolerates a 300 ms stall with no audible effect
    // (background music has no interactive-timing need; the only cost is a one-time ~0.2 s longer start latency).
    Tone.getContext().lookAhead = 0.3;

    // ── Build shared reverb bus ────────────────────────────────────────────
    // Reverb must be generated (async IR build) before connecting audio.
    this.reverb = new Tone.Reverb({ decay: 3.5, wet: 0.35 });
    await this.reverb.generate();    // ← REQUIRED: without this the IR buffer is empty
    this.reverb.toDestination();

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

    // Start on a random track so every session feels fresh
    this.trackIndex.set(Math.floor(Math.random() * this.trackList().length));

    // ── Preload all MIDI files in the background ───────────────────────────
    // This fills midiCache so the first play (and every subsequent one) is
    // instant — no waiting for a network round-trip while the game is running.
    for (const track of this.trackList()) {
      this.fetchAndCache(track.filename).catch(() => {});
    }

    // ── Make actual playback reflect the saved settings on entry ───────────
    // Always drive the output bus from the stored preference: the saved volume when music is on, fully silent
    // when it's off. This guarantees a player who turned music off hears nothing (no stray full-volume bus),
    // and that the saved volume is honoured on every entry — not just the first.
    this.applyOutputVolume();
    if (this.isEnabled()) {
      await Tone.start();   // ensure AudioContext is running after user gesture
      await this.startCurrentTrack();
    }
  }

  /** Set master volume (0 = silent, 1 = full).  Persists to localStorage. */
  setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v));
    this.volume.set(clamped);
    localStorage.setItem(LS_VOL_KEY, String(clamped));
    this.applyOutputVolume();   // reflect on the bus now (stays silent while music is toggled OFF)
  }

  /** Drive the actual output bus from the CURRENT settings: the saved volume when music is enabled, fully
   *  SILENT when it's off — so playback always matches the user's preference (no stray full-volume audio),
   *  without clobbering the stored volume. Called on entry, on every volume change, and on toggle. */
  private applyOutputVolume(): void {
    const v = this.isEnabled() ? this.volume() : 0;
    // Tone.gainToDb(0) would be -Infinity; clamp to −60 dB for silence.
    Tone.Destination.volume.value = v < 0.001 ? -60 : 20 * Math.log10(v);
  }

  /** Toggle music on/off; persists preference to localStorage. */
  async toggle(): Promise<void> {
    const next = !this.isEnabled();
    this.isEnabled.set(next);
    localStorage.setItem(LS_KEY, String(next));
    this.applyOutputVolume();   // unmute to the saved volume / mute, matching the new state

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
    this.stopPlayback();   // disposes trackSynths
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

  private readStoredVolume(): number {
    // Default to 10% on a NEW device (no stored value) so music is gentle on first load. A previously set
    // volume — including 0 (muted) — is stored as a string, so this default only applies when the key is
    // genuinely absent, leaving any prior preference untouched.
    const DEFAULT_VOL = 0.1;
    try {
      const raw = localStorage.getItem(LS_VOL_KEY);
      if (raw === null) { return DEFAULT_VOL; }
      const v = parseFloat(raw);
      return isNaN(v) ? DEFAULT_VOL : Math.max(0, Math.min(1, v));
    } catch {
      return DEFAULT_VOL;
    }
  }

  /**
   * Stop Transport, cancel all scheduled events, dispose per-track synths,
   * and rewind to position 0.
   */
  private stopPlayback(): void {
    Tone.Transport.stop();
    Tone.Transport.cancel();           // remove all scheduled events
    Tone.Transport.position = 0;       // rewind so next start begins at the top

    // Dispose the synths that were created for the previous song.
    // Each call to startCurrentTrack() creates a fresh set.
    for (const s of this.trackSynths) s.dispose();
    this.trackSynths = [];

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
   * Build a PolySynth whose timbre is matched to a MIDI instrument family.
   *
   * General MIDI instrument families (from @tonejs/midi track.instrument.family):
   *   "piano" | "chromatic percussion" | "organ" | "guitar" | "bass" |
   *   "strings" | "ensemble" | "brass" | "reed" | "pipe" |
   *   "synth lead" | "synth pad" | ...
   *
   * Each synth gets its own 32-voice pool so tracks never compete for voices.
   * All synths connect to the shared reverb bus.
   */
  private makeSynthForTrack(track: { instrument: { family: string } }): Tone.PolySynth {
    const family = (track.instrument?.family ?? '').toLowerCase();

    // Defaults (melody / unknown)
    let osc:     Tone.ToneOscillatorType = 'triangle';
    let attack   = 0.04;
    let decay    = 0.10;
    let sustain  = 0.70;
    let release  = 1.20;
    let volume   = -14;

    if (family.includes('bass')) {
      // Deep, punchy low-end
      osc     = 'sawtooth';
      attack  = 0.02;
      decay   = 0.15;
      sustain = 0.60;
      release = 0.80;
      volume  = -11;
    } else if (family.includes('brass') || family.includes('reed')) {
      // Bright, slightly buzzy horn/woodwind
      osc     = 'sawtooth';
      attack  = 0.08;
      decay   = 0.12;
      sustain = 0.80;
      release = 0.60;
    } else if (family.includes('strings') || family.includes('ensemble')) {
      // Slow bowed attack, long tail
      osc     = 'triangle';
      attack  = 0.14;
      decay   = 0.20;
      sustain = 0.75;
      release = 2.00;
      volume  = -15;
    } else if (family.includes('organ')) {
      // Immediate organ — no attack swell, sustained
      osc     = 'square';
      attack  = 0.01;
      decay   = 0.05;
      sustain = 0.90;
      release = 0.25;
    } else if (family.includes('guitar') || family.includes('plucked')) {
      // Sharp pluck, fast decay
      osc     = 'sawtooth';
      attack  = 0.01;
      decay   = 0.35;
      sustain = 0.20;
      release = 0.50;
    } else if (family.includes('pipe')) {
      // Flute-like — soft attack, steady tone
      osc     = 'triangle';
      attack  = 0.10;
      decay   = 0.08;
      sustain = 0.85;
      release = 0.40;
    } else if (family.includes('synth lead')) {
      osc     = 'sawtooth';
      attack  = 0.02;
      release = 0.80;
    } else if (family.includes('synth pad')) {
      osc     = 'triangle';
      attack  = 0.20;
      decay   = 0.30;
      sustain = 0.65;
      release = 2.50;
      volume  = -16;
    } else if (family.includes('piano') || family.includes('chromatic')) {
      // Piano-ish: fast attack, decaying sustain
      osc     = 'triangle';
      attack  = 0.01;
      decay   = 0.30;
      sustain = 0.45;
      release = 1.00;
    }

    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: osc },
      envelope:   { attack, decay, sustain, release },
      volume,
    }).connect(this.reverb);

    // 32 voices per track is plenty — the pools are now independent.
    synth.maxPolyphony = 32;
    return synth;
  }

  /**
   * Schedule all notes from the current MIDI file onto the Transport timeline
   * and start playing.
   *
   * Each MIDI track gets its own PolySynth so voice pools are independent.
   * Percussion tracks (channel 10) are skipped — they have no pitched notes.
   *
   * Scheduling correctness:
   *   Tone.Transport.schedule(cb, time) expects `time` in Transport-seconds
   *   (i.e. seconds from the start of the piece), NOT AudioContext time.
   *   note.time from @tonejs/midi is already in Transport-seconds.
   */
  private async startCurrentTrack(): Promise<void> {
    // HARD GUARD: music must NEVER play while the user has it disabled, no matter how we got here
    // (auto-advance, a re-init, a stray caller). The user has hit "music turns itself back on after I
    // muted it" repeatedly; gating the single place that creates+schedules synths closes every path.
    if (!this.isEnabled()) { this.stopPlayback(); return; }

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

    // ── One synth per active MIDI track ───────────────────────────────────
    for (const track of midi.tracks) {
      if (!track.notes.length) continue;            // empty / tempo / meta tracks
      if (track.instrument?.percussion) continue;   // skip drums — no pitched notes

      const synth = this.makeSynthForTrack(track);
      this.trackSynths.push(synth);

      // Capture synth reference for each closure (const in loop is safe)
      for (const note of track.notes) {
        Tone.Transport.schedule((audioTime) => {
          synth.triggerAttackRelease(
            note.name,
            note.duration,
            audioTime,       // Web Audio API absolute time (supplied by Transport)
            note.velocity,
          );
        }, note.time);
      }
    }

    // Don't loop — advance to the next track when this one ends.
    Tone.Transport.loop = false;

    // Schedule the auto-advance at Transport time = track end + gap.
    // The callback runs inside the audio render quantum so we defer it
    // via setTimeout to get back onto the normal JS task queue.
    Tone.Transport.schedule(() => {
      setTimeout(() => this.next());
    }, midi.duration + TRACK_GAP_SEC);

    // Small ahead-of-time offset so the scheduling queue is settled
    // before the first note fires.
    Tone.Transport.start('+0.05');
    this.isPlaying.set(true);
  }
}
