#!/usr/bin/env node
/**
 * One-time KTX2 texture encoder (asset-prep, NOT a runtime dependency).
 *
 * Converts the heavy STANDALONE textures under assets/ to GPU-compressed .ktx2 (Basis Universal). KTX2 transcodes
 * in the browser to the client's native GPU format (BC7/BC5/ASTC/ETC) — typically a 4–8× VRAM cut, which is the
 * lever against the live descriptor-heap OOM. The .ktx2 files are written NEXT TO the originals (which are kept as
 * a fallback). Re-run only when a source texture changes; the live Ubuntu server needs NONE of this — it just
 * serves the resulting static .ktx2 files (+ Babylon self-hosts/CDN-fetches the small transcoder WASM for clients).
 *
 * ── Install the `ktx` CLI (KTX-Software — the SAME tool on dev + server/CI) ──────────────────────────────────
 *   macOS (dev):   download the latest .pkg from https://github.com/KhronosGroup/KTX-Software/releases and install,
 *                  or `brew install --cask` if a tap provides it. Verify: `ktx --version`.
 *   Ubuntu (CI):   apt-get install -y libktx-tools   (or install the official .deb from the releases page).
 *
 * ── Run ─────────────────────────────────────────────────────────────────────────────────────────────────────
 *   node server/scripts/encode-ktx2.mjs            # encode everything below
 *   node server/scripts/encode-ktx2.mjs --force    # re-encode even if the .ktx2 is newer than the source
 *
 * ── Encode profiles ─────────────────────────────────────────────────────────────────────────────────────────
 *   color   — sRGB albedo/photographic (sky, diffuse): ETC1S (smallest), perceptual.
 *   normal  — tangent normals: UASTC (preserves the precision ETC1S would wreck), LINEAR, no sRGB.
 *   data    — AO / roughness / specular / splat / aux: UASTC LINEAR (banding-sensitive control maps).
 * Tune the lists below to match the textures your build actually loads via `new Texture(...)` (the texture-ARRAY
 * tile path can't consume KTX2 through <img>, so those tiles are intentionally NOT listed here).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const FORCE = process.argv.includes('--force');

/**
 * Resolve the `ktx` binary WITHOUT relying on the caller's interactive PATH (which varies between Terminal.app,
 * VS Code's integrated terminal, tmux, CI, etc.). Honors KTX_BIN, then the standard macOS/Linux install dirs,
 * then falls back to the PATH lookup. So `node encode-ktx2.mjs` works even if `ktx` isn't on your shell PATH.
 */
function resolveKtx() {
  const candidates = [
    process.env.KTX_BIN,
    '/usr/local/bin/ktx',     // macOS .pkg + most Linux installs
    '/opt/homebrew/bin/ktx',  // Apple-Silicon Homebrew
    '/usr/bin/ktx',           // Ubuntu libktx-tools (apt)
  ].filter(Boolean);
  for (const c of candidates) { if (existsSync(c)) return c; }
  return 'ktx';   // last resort: hope it's on PATH
}
const KTX = resolveKtx();

// [relative-path-from-assets, profile]. Add/remove as the loaders change. Only list textures the client actually
// loads via `new Texture(...)` (so the .ktx2 can be served + consumed 1:1). Keep the source files as fallback.
const TARGETS = [
  ['sky/stars.jpg', 'color'],   // 4096² star map: ~33 MB RGBA in VRAM → ~8 MB BC7/ASTC. Client prefers stars.ktx2.
  // NOTE: terrain/ao_map.png is a ~0.1 KB empty placeholder — not worth encoding.
  // NOTE: terrain/tiles/* feed a RawTexture2DArray via <img>→canvas and can't consume KTX2 through that loader
  //       (a separate refactor — the real future VRAM win). Add standalone `new Texture(...)` sources here as wired.
];

/** Build the `ktx create` args for a profile. KTX-Software 4.x CLI. */
function argsFor(profile, src, dst) {
  const common = ['create', '--generate-mipmap'];   // `ktx create` always writes .ktx2
  if (profile === 'color') {
    // BasisLZ/ETC1S — smallest, perceptual; for sRGB albedo / photographic. (No --zstd: illegal with BasisLZ.)
    return [...common, '--format', 'R8G8B8A8_SRGB', '--assign-tf', 'srgb',
            '--encode', 'basis-lz', '--clevel', '4', '--qlevel', '128', src, dst];
  }
  // normal + data: UASTC, linear (no sRGB), RDO + zstd for size. Keeps the precision BasisLZ would crush.
  return [...common, '--format', 'R8G8B8A8_UNORM', '--assign-tf', 'linear',
          '--encode', 'uastc', '--uastc-quality', '2', '--uastc-rdo', '--zstd', '18', src, dst];
}

function upToDate(src, dst) {
  if (FORCE || !existsSync(dst)) return false;
  try { return statSync(dst).mtimeMs >= statSync(src).mtimeMs; } catch { return false; }
}

// Sanity-check the CLI is present so the error is obvious, not a cryptic ENOENT per file.
try { execFileSync(KTX, ['--version'], { stdio: 'ignore' }); }
catch {
  console.error(`[ktx2] could not run the 'ktx' CLI (tried: ${KTX}).`);
  console.error('[ktx2] Install KTX-Software (see header) or set KTX_BIN=/path/to/ktx. It does NOT need to be on your shell PATH.');
  process.exit(1);
}

let done = 0, skipped = 0, failed = 0;
for (const [rel, profile] of TARGETS) {
  const src = join(ASSETS, rel);
  if (!existsSync(src)) { console.warn(`[ktx2] SKIP (missing source): ${rel}`); skipped++; continue; }
  const dst = join(dirname(src), basename(src, extname(src)) + '.ktx2');
  if (upToDate(src, dst)) { console.log(`[ktx2] up-to-date: ${rel}`); skipped++; continue; }
  try {
    execFileSync(KTX, argsFor(profile, src, dst), { stdio: 'inherit' });
    console.log(`[ktx2] ✓ ${profile.padEnd(6)} ${rel} → ${basename(dst)}`);
    done++;
  } catch (err) {
    console.error(`[ktx2] ✗ FAILED ${rel}: ${err.message}`);
    failed++;
  }
}
console.log(`\n[ktx2] done=${done} skipped=${skipped} failed=${failed}`);
process.exit(failed ? 1 : 0);
