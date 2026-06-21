#!/usr/bin/env bash
# Build the GPU-compressed biome ORM array texture (KTX2, UASTC linear) for the PBR terrain skin.
# Packs R=roughness, G=ambient-occlusion (B=0) for the 5 CORE biomes, in BIOME_TILES order, into a
# 5-layer array. UASTC (not basis-lz) because R/G are INDEPENDENT data channels (etc1s would bleed them).
# Run after `npm run download:terrain-tiles`. Output: assets/geometry/terrain/biome_orm.ktx2 (committed).
# Requires `ktx` (KTX-Software) + `magick` (ImageMagick).
set -euo pipefail
cd "$(dirname "$0")/.."
KTX="${KTX_BIN:-/usr/local/bin/ktx}"
MAGICK="${MAGICK_BIN:-/opt/homebrew/bin/magick}"
TILES=assets/terrain/tiles
OUT=assets/geometry/terrain/biome_orm.ktx2
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$(dirname "$OUT")"

BIOMES=(sand grass gravel rock snow)   # = BIOME_TILES (the ORM core layers)
ARGS=()
"$MAGICK" -size 1024x1024 xc:black "$TMP/black.png"
for i in "${!BIOMES[@]}"; do
  b="${BIOMES[$i]}"; out=$(printf '%s/%02d.png' "$TMP" "$i")
  "$MAGICK" "$TILES/${b}_rough.jpg" -resize '1024x1024!' -colorspace Gray "$TMP/r.png"
  "$MAGICK" "$TILES/${b}_ao.jpg"    -resize '1024x1024!' -colorspace Gray "$TMP/a.png"
  "$MAGICK" "$TMP/r.png" "$TMP/a.png" "$TMP/black.png" -combine -colorspace sRGB "$out"  # R=rough G=ao B=0
  ARGS+=("$out")
done

"$KTX" create --generate-mipmap --format R8G8B8A8_UNORM --assign-tf linear \
  --encode uastc --uastc-quality 2 --zstd 18 --layers "${#BIOMES[@]}" "${ARGS[@]}" "$OUT"
echo "✓ $OUT  ($("$KTX" info "$OUT" | awk '/layerCount/{print $2" layers"}'))"
