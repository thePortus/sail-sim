#!/usr/bin/env bash
# Build the GPU-compressed biome ORM layers as PER-LAYER KTX2 files (UASTC linear) for the PBR terrain skin.
# Each packs R=roughness, G=ambient-occlusion (B=0) for one of the 5 CORE biomes, in BIOME_TILES order.
# UASTC (not basis-lz) because R/G are INDEPENDENT data channels (etc1s would bleed them). The client
# (terrain.service.assembleCompressedBiomeArray) GPU-stacks them into ONE compressed 2D-array.
# Run after the terrain tiles change. Requires `ktx` (KTX-Software) + `magick` (ImageMagick).
#
#   bash server/scripts/build-biome-orm.sh
#
# Output: server/assets/geometry/terrain/biome/orm_NN.ktx2  (one per layer, committed → /geometry static).
set -euo pipefail
cd "$(dirname "$0")/.."
# Resolve binaries: env override → PATH → common install locations (mac + Linux server). Cross-platform.
resolve_bin() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 && { command -v "$c"; return; }; done; echo "$1"; }
KTX="${KTX_BIN:-$(resolve_bin ktx /usr/local/bin/ktx /usr/bin/ktx)}"
# `magick` (ImageMagick 7, mac/Alpine) OR `convert` (ImageMagick 6, Debian server) — same CLI for our ops.
MAGICK="${MAGICK_BIN:-$(resolve_bin magick convert /opt/homebrew/bin/magick /usr/bin/magick /usr/bin/convert)}"
TILES=assets/terrain/tiles
OUTDIR=assets/geometry/terrain/biome
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUTDIR"
rm -f "$OUTDIR"/orm_*.ktx2 assets/geometry/terrain/biome_orm.ktx2  # drop stale per-layer + old array

BIOMES=(sand grass gravel rock snow)   # = BIOME_TILES (the ORM core layers)
"$MAGICK" -size 1024x1024 xc:black "$TMP/black.png"
for i in "${!BIOMES[@]}"; do
  b="${BIOMES[$i]}"
  "$MAGICK" "$TILES/${b}_rough.jpg" -resize '1024x1024!' -colorspace Gray "$TMP/r.png"
  "$MAGICK" "$TILES/${b}_ao.jpg"    -resize '1024x1024!' -colorspace Gray "$TMP/a.png"
  "$MAGICK" "$TMP/r.png" "$TMP/a.png" "$TMP/black.png" -combine -colorspace sRGB "$TMP/orm.png"  # R=rough G=ao B=0
  out=$(printf '%s/orm_%02d.ktx2' "$OUTDIR" "$i")
  "$KTX" create --generate-mipmap --format R8G8B8A8_UNORM --assign-tf linear \
    --encode uastc --uastc-quality 2 --zstd 18 "$TMP/orm.png" "$out"
done
echo "✓ ${#BIOMES[@]} layers → $OUTDIR/orm_NN.ktx2  ($(du -ch "$OUTDIR"/orm_*.ktx2 | tail -1 | cut -f1) total)"
