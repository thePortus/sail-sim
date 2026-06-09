'use strict';

/**
 * Server-side pier footprints for movement collision. Loads the harbor towns from the terrain manifest
 * once and turns each pier into an oriented-box footprint (aligned with the pier's seaward heading,
 * running from the shore point out over the water). movement.js rejects a (non-admin) move whose hull
 * CENTRE lands inside any box, so ships can't sail straight through a pier deck. Approximate by design —
 * a simple "no-clip" backstop, not a docking system.
 *
 * Footprints come from the pier handoff (metres): len = along-seaward extent from the shore point,
 * width = across. Boxes are inflated by ~a ship half-beam so the hull edge doesn't visibly clip the
 * deck (we block the centre a little early).
 */

const fs = require('fs');
const path = require('path');
const terrainConfig = require('./config/terrain.config');

const VARIANT_DIMS = {
  straight: { len: 14.3, width: 3.2 },
  l:        { len: 11.0, width: 13.0 },
  t:        { len: 11.0, width: 13.0 },
};
const PAD = 2.2;   // ≈ a sloop half-beam — keeps the hull off the deck, not just its centre

let loaded = false;
let boxes = [];    // { cx, cz, fx, fz, rx, rz, halfLen, halfWid }

function load() {
  loaded = true;
  try {
    const manifestPath = path.join(terrainConfig.outputDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return;
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const harbors = m.harbors || [];
    boxes = harbors.map((h) => {
      const dim = VARIANT_DIMS[h.variant] || VARIANT_DIMS.straight;
      const hr = (h.heading * Math.PI) / 180;
      const fx = Math.sin(hr), fz = Math.cos(hr);    // seaward (along the pier)
      const rx = Math.cos(hr), rz = -Math.sin(hr);   // across the pier
      return {
        cx: h.x + fx * (dim.len / 2),                // box centre: half the length seaward of shore
        cz: h.z + fz * (dim.len / 2),
        fx, fz, rx, rz,
        halfLen: dim.len / 2 + PAD,
        halfWid: dim.width / 2 + PAD,
      };
    });
    if (boxes.length) console.log(`[pier-obstacles] ${boxes.length} pier collider(s) loaded`);
  } catch (err) {
    boxes = [];
    console.warn('[pier-obstacles] load failed — pier collision disabled:', err.message);
  }
}

/** True if (x,z) lies inside any pier footprint. Fail-open (false) when no manifest/harbors. */
function blockedAt(x, z) {
  if (!loaded) load();
  for (const b of boxes) {
    const dx = x - b.cx, dz = z - b.cz;
    const along = dx * b.fx + dz * b.fz;
    if (along < -b.halfLen || along > b.halfLen) continue;
    const across = dx * b.rx + dz * b.rz;
    if (across >= -b.halfWid && across <= b.halfWid) return true;
  }
  return false;
}

module.exports = { blockedAt };
