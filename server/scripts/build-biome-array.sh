#!/usr/bin/env bash
# Build the GPU-compressed biome ALBEDO layers as PER-LAYER KTX2 files (Basis-LZ), consumed by the PBR
# terrain skin (client terrain.service.assembleCompressedBiomeArray, which GPU-stacks them into ONE
# compressed 2D-array — Babylon 9.x can't load an array-KTX2 directly). Run after the terrain tiles change:
#
#   bash server/scripts/build-biome-array.sh
#
# Output: server/assets/geometry/terrain/biome/albedo_NN.ktx2  (one per layer, committed → /geometry static).
# The layer INDEX NN MUST match ALBEDO_LAYERS order in client/.../terrain.service.ts. The client copies each
# layer into array slice NN, so a gap/rename = wrong biome. ~4× less VRAM than the uncompressed fallback.
# Requires the `ktx` CLI (KTX-Software) + `magick` (ImageMagick) for resize. Cross-platform (mac + Linux
# server) — runs automatically as the tail of `npm run download:terrain-tiles`.
set -euo pipefail
cd "$(dirname "$0")/.."
# Resolve binaries: env override → PATH → common install locations (mac /usr/local + /opt/homebrew, Linux /usr/bin).
resolve_bin() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return; }; done; echo "$1"; }
KTX="${KTX_BIN:-$(resolve_bin ktx /usr/local/bin/ktx /usr/bin/ktx)}"
# `magick` (ImageMagick 7, mac/Alpine) OR `convert` (ImageMagick 6, Debian server) — same CLI for our ops.
MAGICK="${MAGICK_BIN:-$(resolve_bin magick convert /opt/homebrew/bin/magick /usr/bin/magick /usr/bin/convert)}"
TILES=assets/terrain/tiles
OUTDIR=assets/geometry/terrain/biome
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUTDIR"
rm -f "$OUTDIR"/albedo_*.ktx2 assets/geometry/terrain/biome_albedo.ktx2  # drop stale per-layer + old array

# ORDER = ALBEDO_LAYERS (0-4 core · 5-7 anti-tiling · 8-12 regional variants).
LAYERS=(sand grass gravel rock snow sand2 grass2 rock2 sand3 sand4 grass3 rock3 rock4)
for i in "${!LAYERS[@]}"; do
  src=$(printf '%s/%02d.png' "$TMP" "$i")
  "$MAGICK" "$TILES/${LAYERS[$i]}_diff.jpg" -resize '1024x1024!' "$src" >/dev/null 2>&1
  out=$(printf '%s/albedo_%02d.ktx2' "$OUTDIR" "$i")
  "$KTX" create --generate-mipmap --format R8G8B8A8_SRGB --assign-tf srgb \
    --encode basis-lz --clevel 4 --qlevel 128 "$src" "$out"
done

echo "✓ ${#LAYERS[@]} layers → $OUTDIR/albedo_NN.ktx2  ($(du -ch "$OUTDIR"/albedo_*.ktx2 | tail -1 | cut -f1) total)"
