/**
 * WakeTracker — records a wake path for EVERY vessel (local + remotes) so the FFT ocean can
 * draw a curved, trailing wake behind each ship. Independent of ocean.service's 24-point path
 * (which stays for the legacy ocean); this one uses a longer buffer for a longer wake.
 *
 * Each frame: age every track's points, drop the expired, append a new point when a ship has
 * moved far enough. `assemble()` packs the nearest WAKE_MAX_BOATS ships into flat buffers the
 * material samples (local boat always included).
 */
export const WAKE_POINTS = 40;     // points per boat (longer buffer → longer wake)
export const WAKE_MAX_BOATS = 4;   // ships rendered with a wake at once (local + nearest remotes)
export const WAKE_LIFE = 12;       // seconds before a wake point fades out
const WAKE_STEP = 3;               // metres travelled between recorded points

interface Track {
  path: Float32Array;   // vec4 ×WAKE_POINTS: x, z, age, _
  count: number;
  lastX: number; lastZ: number;   // last recorded point
  curX: number; curZ: number;     // current position (for culling)
  speed: number;
}

export interface WakeSource { id: string; x: number; z: number; speed: number; }

export class WakeTracker {
  private _tracks = new Map<string, Track>();
  private _paths = new Float32Array(WAKE_MAX_BOATS * WAKE_POINTS * 4);
  private _meta = new Float32Array(WAKE_MAX_BOATS * 4);   // x, z, count, speed
  private _count = 0;

  get paths(): Float32Array { return this._paths; }
  get meta(): Float32Array { return this._meta; }
  get boatCount(): number { return this._count; }

  /** Age/extend each ship's track. `boats[0]` should be the local boat (id 'local'). */
  update(dt: number, boats: WakeSource[]): void {
    const seen = new Set<string>();
    for (const b of boats) {
      seen.add(b.id);
      let tr = this._tracks.get(b.id);
      if (!tr) {
        tr = { path: new Float32Array(WAKE_POINTS * 4), count: 0, lastX: b.x, lastZ: b.z, curX: b.x, curZ: b.z, speed: 0 };
        this._tracks.set(b.id, tr);
      }
      tr.curX = b.x; tr.curZ = b.z; tr.speed = b.speed;

      for (let i = 0; i < tr.count; i++) { tr.path[i * 4 + 2] += dt; }   // age
      let drop = 0;
      while (drop < tr.count && tr.path[drop * 4 + 2] > WAKE_LIFE) { drop++; }
      if (drop > 0) { tr.path.copyWithin(0, drop * 4, tr.count * 4); tr.count -= drop; }

      const dx = b.x - tr.lastX, dz = b.z - tr.lastZ;
      if (Math.abs(b.speed) > 0.2 && dx * dx + dz * dz >= WAKE_STEP * WAKE_STEP) {
        if (tr.count >= WAKE_POINTS) { tr.path.copyWithin(0, 4, WAKE_POINTS * 4); tr.count = WAKE_POINTS - 1; }
        const idx = tr.count * 4;
        tr.path[idx] = b.x; tr.path[idx + 1] = b.z; tr.path[idx + 2] = 0; tr.path[idx + 3] = 0;
        tr.count++; tr.lastX = b.x; tr.lastZ = b.z;
      }
    }
    // Forget ships that left.
    for (const id of [...this._tracks.keys()]) { if (!seen.has(id)) { this._tracks.delete(id); } }
  }

  /** Pack the nearest WAKE_MAX_BOATS tracks (local always first) into the flat shader buffers. */
  assemble(cx: number, cz: number): void {
    const entries = [...this._tracks.entries()];
    entries.sort((a, b) => {
      if (a[0] === 'local') { return -1; }
      if (b[0] === 'local') { return 1; }
      const da = (a[1].curX - cx) ** 2 + (a[1].curZ - cz) ** 2;
      const db = (b[1].curX - cx) ** 2 + (b[1].curZ - cz) ** 2;
      return da - db;
    });
    const n = Math.min(WAKE_MAX_BOATS, entries.length);
    for (let k = 0; k < n; k++) {
      const tr = entries[k][1];
      this._paths.set(tr.path.subarray(0, tr.count * 4), k * WAKE_POINTS * 4);
      this._meta[k * 4 + 0] = tr.curX;
      this._meta[k * 4 + 1] = tr.curZ;
      this._meta[k * 4 + 2] = tr.count;
      this._meta[k * 4 + 3] = tr.speed;
    }
    this._count = n;
  }
}
