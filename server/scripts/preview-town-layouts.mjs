/**
 * Town-layout debug plotter: reads the baked terrain manifest and renders every town's street
 * network, buildings, plaza, and pad into one SVG grid — so all 50 layouts can be eyeballed in
 * seconds without booting a client. Each cell draws in the town's LOCAL frame (inland = up).
 *
 * Usage (from server/):  node scripts/preview-town-layouts.mjs [manifest.json] [out.svg]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import terrainConfig from '../config/terrain.config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = process.argv[2] || join(terrainConfig.outputDir, 'manifest.json');
const outPath = process.argv[3] || join(__dirname, '..', 'assets', 'terrain', 'town-layouts.svg');

const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const harbors = (m.harbors || []).slice().sort((a, b) =>
  (a.tier === b.tier ? 0 : a.tier === 'capital' ? -1 : b.tier === 'capital' ? 1 : a.tier === 'medium' ? -1 : 1));

const CELL = 420, PAD = 26, COLS = 8;
const rows = Math.ceil(harbors.length / COLS);
const W = COLS * CELL, H = rows * CELL;
const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
  `<rect width="${W}" height="${H}" fill="#0b1016"/>`];

const factionCol = { spanish: '#e2b13c', english: '#d96a6a', french: '#7aa0e0', dutch: '#e08c46' };

harbors.forEach((h, i) => {
  const cx0 = (i % COLS) * CELL + CELL / 2, cy0 = Math.floor(i / COLS) * CELL + CELL / 2;
  const hr = (h.heading || 0) * Math.PI / 180;
  const fwd = [-Math.sin(hr), -Math.cos(hr)], rgt = [Math.cos(hr), -Math.sin(hr)];
  // World → local (f = inland, s = across), centred on the pad; SVG: s → +x, f → -y (inland up).
  const p0 = h.pad ? { x: h.pad.cx, z: h.pad.cz } : { x: h.x, z: h.z };
  const halfMax = h.pad ? Math.max(h.pad.halfX, h.pad.halfZ) + 30 : 90;
  const scale = (CELL / 2 - PAD) / halfMax;
  const T = (x, z) => {
    const dx = x - p0.x, dz = z - p0.z;
    const f = fwd[0] * dx + fwd[1] * dz, s = rgt[0] * dx + rgt[1] * dz;
    return [cx0 + s * scale, cy0 - f * scale];
  };
  // Pad rectangle
  if (h.pad) {
    const hx = h.pad.halfX * scale, hz = h.pad.halfZ * scale;
    parts.push(`<rect x="${cx0 - hx}" y="${cy0 - hz}" width="${2 * hx}" height="${2 * hz}" fill="#16202c" stroke="#2a3b4d"/>`);
  }
  // Sea side marker (below = seaward)
  parts.push(`<line x1="${cx0 - CELL / 2 + 8}" y1="${cy0 + (h.pad ? h.pad.halfZ * scale + 10 : 80)}" x2="${cx0 + CELL / 2 - 8}" y2="${cy0 + (h.pad ? h.pad.halfZ * scale + 10 : 80)}" stroke="#1d4a63" stroke-width="3"/>`);
  // Streets
  for (const st of h.streets || []) {
    const [x1, y1] = T(st.x1, st.z1), [x2, y2] = T(st.x2, st.z2);
    parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#7d6b4f" stroke-width="${Math.max(1.5, (st.width || 5) * scale)}" stroke-linecap="round"/>`);
  }
  // Square/plaza
  if (h.square && h.square.halfX > 0) {
    const [qx, qy] = T(h.square.cx, h.square.cz);
    const hx = h.square.halfX * scale, hz = h.square.halfZ * scale;
    parts.push(`<rect x="${qx - hx}" y="${qy - hz}" width="${2 * hx}" height="${2 * hz}" fill="#3a3325" stroke="#8a7a50"/>`);
  }
  // Buildings (dot per building; civic = brighter)
  for (const b of h.buildings || []) {
    const [bx, by] = T(b.x, b.z);
    const civic = /townhall|fountain|shipwright/.test(b.asset);
    const r = civic ? 4 : 2.6;
    const col = /townhall/.test(b.asset) ? '#e8d9a0' : /fountain/.test(b.asset) ? '#9ad0e0'
              : /shipwright/.test(b.asset) ? '#a0c8a0' : /tavern/.test(b.asset) ? '#d0a0a0'
              : /shack/.test(b.asset) ? '#6a8a9a' : '#b0a08a';
    parts.push(`<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${r}" fill="${col}"/>`);
  }
  // Label
  const fcol = factionCol[h.faction] || '#9aa8b8';
  parts.push(`<text x="${cx0 - CELL / 2 + 10}" y="${cy0 - CELL / 2 + 20}" fill="${fcol}" font-family="monospace" font-size="14">${h.name} — ${h.tier}${h.pattern ? ' / ' + h.pattern : ''} (${h.faction || '?'})</text>`);
  parts.push(`<text x="${cx0 - CELL / 2 + 10}" y="${cy0 - CELL / 2 + 36}" fill="#5a6a7a" font-family="monospace" font-size="11">${(h.streets || []).length} street segs · ${(h.buildings || []).length} buildings</text>`);
});

parts.push('</svg>');
writeFileSync(outPath, parts.join('\n'));
console.log(`Wrote ${outPath} (${harbors.length} towns).`);
