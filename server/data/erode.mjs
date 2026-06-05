/**
 * Phase 2b — Erosion + detail touch-up for a baked elevation field (Float32, metres, signed).
 *
 * Three stacked procedural passes that ENHANCE the real terrain (kept gentle so they refine rather
 * than overwrite the believable Copernicus landforms):
 *
 *   1. hydraulicErode — droplet/particle hydraulic erosion (Sebastian Lague style). Carves subtle
 *      dendritic channels and deposits sediment in valleys/at the coast → finer drainage structure
 *      than the 30 m source resolves, and heals the slight softening from rotation resampling.
 *   2. thermalErode — talus/thermal relaxation. Material above the angle of repose slumps downhill,
 *      capping impossible verticals (directly fights "vertiginous"). Only bites on real cliffs.
 *   3. addDetail — domain-warped fBm micro-relief, slope-gated and faded out near the waterline, to
 *      crisp up close-up terrain before the runtime detail-amplification layer exists.
 *
 * All passes act ONLY on land (height > seaLevel); the seabed is left to the real bathymetry.
 */

import { mulberry32 } from './augment.mjs';

/** Bilinear height + gradient (gx,gy) at grid coords (x,y). Caller guarantees 0 ≤ x,y ≤ OUT-2. */
function heightGradient(field, OUT, x, y) {
  const xi = x | 0, yi = y | 0;
  const fx = x - xi, fy = y - yi;
  const i = yi * OUT + xi;
  const nw = field[i], ne = field[i + 1], sw = field[i + OUT], se = field[i + OUT + 1];
  return {
    h: nw * (1 - fx) * (1 - fy) + ne * fx * (1 - fy) + sw * (1 - fx) * fy + se * fx * fy,
    gx: (ne - nw) * (1 - fy) + (se - sw) * fy,
    gy: (sw - nw) * (1 - fx) + (se - ne) * fx,
  };
}

/** Hydraulic droplet erosion (in place). Faithful to the classic particle model; gentle defaults. */
export function hydraulicErode(field, OUT, seed, opts = {}) {
  const {
    droplets = 120000, maxLifetime = 30, inertia = 0.05, capacityFactor = 4,
    minSlope = 0.01, erodeSpeed = 0.3, depositSpeed = 0.3, evaporate = 0.02,
    gravity = 10, erodeRadius = 3, seaLevel = 0,
  } = opts;
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);

  // Precompute an erosion brush (radius-weighted, normalised) so removal is spread → no 1-cell pits.
  const brush = [];
  let bSum = 0;
  for (let dy = -erodeRadius; dy <= erodeRadius; dy++) {
    for (let dx = -erodeRadius; dx <= erodeRadius; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= erodeRadius) { const w = 1 - d / erodeRadius; brush.push({ dx, dy, w }); bSum += w; }
    }
  }
  for (const b of brush) b.w /= bSum;

  const deposit = (x, y, amount) => {
    const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * OUT + xi;
    field[i] += amount * (1 - fx) * (1 - fy);
    field[i + 1] += amount * fx * (1 - fy);
    field[i + OUT] += amount * (1 - fx) * fy;
    field[i + OUT + 1] += amount * fx * fy;
  };

  for (let d = 0; d < droplets; d++) {
    let x = rng() * (OUT - 2), y = rng() * (OUT - 2);
    if (field[(y | 0) * OUT + (x | 0)] <= seaLevel) continue;     // start on land only
    let dirX = 0, dirY = 0, speed = 1, water = 1, sediment = 0;

    for (let life = 0; life < maxLifetime; life++) {
      const xi = x | 0, yi = y | 0;
      const { h, gx, gy } = heightGradient(field, OUT, x, y);
      // Steer with inertia (blend current direction against the downhill gradient).
      dirX = dirX * inertia - gx * (1 - inertia);
      dirY = dirY * inertia - gy * (1 - inertia);
      const len = Math.hypot(dirX, dirY);
      if (len < 1e-6) break;
      dirX /= len; dirY /= len;
      const nx = x + dirX, ny = y + dirY;
      if (nx < 0 || ny < 0 || nx > OUT - 2 || ny > OUT - 2) { deposit(x, y, sediment); break; }

      const newH = heightGradient(field, OUT, nx, ny).h;
      const dH = newH - h;
      if (newH <= seaLevel) { deposit(x, y, sediment); break; }   // reached the sea → drop load

      const capacity = Math.max(-dH, minSlope) * speed * water * capacityFactor;
      if (sediment > capacity || dH > 0) {
        // Deposit: fill an uphill step exactly, else shed the excess over capacity.
        const amount = dH > 0 ? Math.min(dH, sediment) : (sediment - capacity) * depositSpeed;
        deposit(x, y, amount); sediment -= amount;
      } else {
        // Erode: take up to the remaining capacity (never more than the downhill step), spread by brush.
        const amount = Math.min((capacity - sediment) * erodeSpeed, -dH);
        for (const b of brush) {
          const xx = xi + b.dx, yy = yi + b.dy;
          if (xx < 0 || yy < 0 || xx >= OUT || yy >= OUT) continue;
          field[yy * OUT + xx] -= amount * b.w;
        }
        sediment += amount;
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dH * gravity));
      water *= (1 - evaporate);
      x = nx; y = ny;
    }
  }
}

/** Thermal/talus erosion (in place): slump material steeper than the repose slope to neighbours. */
export function thermalErode(field, OUT, opts = {}) {
  const { iterations = 3, talus = 18, factor = 0.5, seaLevel = 0 } = opts;
  const N = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let it = 0; it < iterations; it++) {
    for (let y = 1; y < OUT - 1; y++) {
      for (let x = 1; x < OUT - 1; x++) {
        const i = y * OUT + x;
        const h = field[i];
        if (h <= seaLevel) continue;
        for (const [dx, dy] of N) {
          const ni = (y + dy) * OUT + (x + dx);
          const diff = h - field[ni];
          if (diff > talus) {
            const move = (diff - talus) * 0.25 * factor;
            field[i] -= move; field[ni] += move;
          }
        }
      }
    }
  }
}

// ── Value-noise fBm with domain warp (for the detail pass) ───────────────────
function hash2(x, z) { return ((Math.sin(x * 127.1 + z * 311.7) * 43758.5453) % 1 + 1) % 1; }
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, z) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < 4; o++) { s += amp * vnoise(x * f + o * 19.3, z * f - o * 7.1); norm += amp; amp *= 0.5; f *= 2; }
  return s / norm;
}

/**
 * Domain-warped fBm micro-relief added to land, scaled by local slope (more texture on slopes, flats
 * stay flat) and faded out near the waterline (so coastlines don't get noisy/underwater fuzz). `amp`
 * is the peak displacement in metres; `featureM` the dominant feature size.
 */
export function addDetail(field, OUT, seed, opts = {}) {
  const { amp = 2.5, featureM = 26, worldM = 50000, seaLevel = 0 } = opts;
  const off = (mulberry32((seed ^ 0x517cc1b7) >>> 0)() * 1000) | 0;   // seed-varied noise origin
  const cell = worldM / (OUT - 1);
  const fScale = cell / featureM;                       // grid-cells → noise space
  const out = new Float32Array(field.length);
  out.set(field);
  for (let y = 1; y < OUT - 1; y++) {
    for (let x = 1; x < OUT - 1; x++) {
      const i = y * OUT + x;
      const h = field[i];
      if (h <= seaLevel) continue;
      // local slope (metres/cell) → texture weight
      const slope = (Math.abs(field[i + 1] - field[i - 1]) + Math.abs(field[i + OUT] - field[i - OUT])) * 0.5;
      const slopeW = Math.min(1, 0.25 + slope / 25);
      const coastFade = Math.min(1, h / 12);            // fade detail in over the first 12 m of land
      // Domain warp the sample coords with a second fBm, then sample.
      const nx = (x + off) * fScale, nz = (y + off) * fScale;
      const wx = nx + (fbm(nx * 0.5 + 11, nz * 0.5 - 4) - 0.5) * 2.0;
      const wz = nz + (fbm(nx * 0.5 - 7, nz * 0.5 + 9) - 0.5) * 2.0;
      out[i] = h + (fbm(wx, wz) - 0.5) * 2 * amp * slopeW * coastFade;
    }
  }
  field.set(out);
}
