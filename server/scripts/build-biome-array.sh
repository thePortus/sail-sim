#!/usr/bin/env bash
# Build the GPU-compressed biome ALBEDO array texture (KTX2, Basis-LZ) consumed by the PBR terrain skin
# (client terrain.service loadKtx2Array). Run after `npm run download:terrain-tiles` adds/changes tiles.
#
#   bash server/scripts/build-biome-array.sh
#
# Output: server/assets/geometry/terrain/biome_albedo.ktx2  (committed — served via /geometry static).
# The layer ORDER MUST match ALBEDO_LAYERS in client/.../terrain.service.ts. ~4× less VRAM than the
# uncompressed RawTexture2DArray fallback. Requires the `ktx` CLI (KTX-Software) + macOS `sips` for resize.
set -euo pipefail
cd "$(dirname "$0")/.."
KTX="${KTX_BIN:-/usr/local/bin/ktx}"
TILES=assets/terrain/tiles
OUT=assets/geometry/terrain/biome_albedo.ktx2
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$(dirname "$OUT")"

# ORDER = ALBEDO_LAYERS (0-4 core · 5-7 anti-tiling · 8-12 regional variants).
LAYERS=(sand grass gravel rock snow sand2 grass2 rock2 sand3 sand4 grass3 rock3 rock4)
ARGS=()
for i in "${!LAYERS[@]}"; do
  out=$(printf '%s/%02d.png' "$TMP" "$i")
  sips -Z 1024 "$TILES/${LAYERS[$i]}_diff.jpg" --out "$out" >/dev/null 2>&1
  ARGS+=("$out")
done

"$KTX" create --generate-mipmap --format R8G8B8A8_SRGB --assign-tf srgb \
  --encode basis-lz --clevel 4 --qlevel 128 --layers "${#LAYERS[@]}" "${ARGS[@]}" "$OUT"

echo "✓ $OUT  ($("$KTX" info "$OUT" | awk '/layerCount/{print $2" layers"}'))"
