# Handoff — Terrain Overhaul (the big picture: shape → skin)

This is the strategic handoff for the **two-roadmap terrain overhaul** in "Bay of Pirates" (sail-sim).
A second doc, `HANDOFF_terrainpbr.md`, covers the WebGPU shader debugging journey (the original compile
blocker is now RESOLVED — see below). This doc explains **where we are in the larger plan and why**.

> **STATUS (commit `e9ad9c7` "terrain pbr restored"): S0 is VERIFIED ON SCREEN.** The `?terrainpbr`
> PBRCustomMaterial GPU-displaced clipmap terrain renders SOLID on WebGPU for the first time. We got here
> by resetting a corrupted tree back to clean HEAD (`1ddcaad`) and re-applying 4 surgical fixes. S1–S3
> code exists in the material but is NOT yet visually validated (blocked on rough/AO + splat tiles being
> served, and on the RTT-variant link errors). See "Where to pick up".

Engine: **BabylonJS 9.10.1, WebGPU-primary**. Client = Angular 19 (`client/`), server = Express/Node
(`server/`). Commit/push ONLY when explicitly asked. Hard-reload (Cmd+Shift+R) after shader edits.

---

## The two roadmaps (and how they relate)

The terrain overhaul is split into **shape** and **skin** — two separate, sequential roadmaps:

1. **Landscape Generation Roadmap (P0–P6) — the SHAPE.** ✅ **COMPLETE.**
   Real-world DEM + bathymetry (Copernicus GLO-30 land + GEBCO 2024 seabed via OpenTopography),
   procedurally augmented, eroded, reef-detailed, served as a chunked heightfield, rendered with a
   camera-centric **clipmap** (GPU vertex displacement + Sobel normals). It also **baked aux maps**
   (slope / shore-distance / wetness / flow / biome-id) as a deliberate *substrate* for the next roadmap.

2. **Terrain Skinning Roadmap (S0–S6) — the SKIN.** 🔶 **IN PROGRESS (S0 VERIFIED on screen; S1–S3 coded, not yet validated).**
   Replaces the terrain's *surface look*: moves from a StandardMaterial triplanar-splat `CustomMaterial`
   to a **`PBRCustomMaterial`** driven by the baked aux maps + new CC0 PBR texture sets, with texture
   arrays to beat the sampler cap, anti-tiling, and flow/coastal detail. **This is the active work.**

> Mental model: P-roadmap built the *terrain mesh and the data maps describing it*. S-roadmap is the
> *consumer* of those maps — it makes the surface look photoreal and art-directable. Nothing consumed the
> aux maps until S-roadmap started.

---

## ROADMAP 1 — Landscape Generation (P0–P6) — SHAPE — ✅ COMPLETE

**Locked strategy:** real-world data, procedurally augmented; re-seedable multiple worlds; covers far AND
close-up. World = 50km × 50km, output res 2048 (~24 m/cell), signed elevation field (land +, seabed −).

| Phase | What it delivered | Status |
|-------|-------------------|--------|
| **P0** | Data acquisition: 7 curated archipelagos (`region-catalog.mjs`), fetch COP30+GEBCO GeoTIFFs (`fetch-terrain-sources.mjs`). | ✅ DONE |
| **P1** | Unified merge (land-over-bathy) → square metric grid, signed-quantize, chunk, v2 manifest. Client signed-decode. "Looks SO good." | ✅ DONE |
| **P2** | Procedural augmentation — the "seed": mirror/rotate/zoom/pan/sea-level (`augment.mjs`) + hydraulic/thermal/detail erosion (`erode.mjs`). | ✅ DONE |
| **P3** | Bathymetry polish: fringing reefs + navigable passes, lagoon shelves (flood-fill enclosure), seamounts (some breach into islets) — `reefs.mjs`. | ✅ DONE |
| **P4** | Runtime chunked LoD / **clipmap** (fork of the ocean clipmap): heightfield texture (R32F) displaced in vertex shader, GPU Sobel normals in fragment. CPU heightfield stays for gameplay (buoyancy/collision/scatter). Flipped to default (no flag). | ✅ DONE |
| **P5** | GPU detail amplification — **normal-detail only** (analytic value-noise fBm perturbing the lighting normal), deliberately NOT vertex geometry (would desync from CPU `getElevation` → scatter float/sink bug). | ✅ DONE |
| **P6** | **Aux maps** (`aux-maps.mjs`): slope, shoreDist, moisture, D8 flow accumulation, biome-id → `aux_map.png` (RGBA) + `biome_map.png` + manifest `auxMaps`. The substrate for S-roadmap. (Deferred sub-items: spawn/harbour scoring, biome-threshold retune, perf pass — subjective, do with user.) | ✅ DONE |

**Key shape files:** `server/scripts/{make-world,fetch-terrain-sources,build-terrain-region}.mjs`;
`server/data/{region-catalog,augment,erode,reefs,aux-maps}.mjs`; `server/config/terrain.config.js`;
client `terrain.service.ts` (signed decode, clipmap build).

**One-shot world gen:** `cd server && npm run terrain` (fetch-if-needed + build). `-- <id> 42` = region +
seed. `npm run download:terrain-tiles` = skin TILE textures (independent).

---

## ROADMAP 2 — Terrain Skinning (S0–S6) — SKIN — 🔶 IN PROGRESS

### Locked decisions
- **Scope = FULL aux-driven rebuild** (S0–S6, not a light polish).
- **Material = PBR** (`PBRCustomMaterial`, metallic-roughness), replacing the StandardMaterial
  `CustomMaterial`. Precedent: the FFT **ocean already uses PBRCustomMaterial on WebGPU**, so
  GLSL-injection PBR is proven here. Lit by the **Atmosphere addon** (physical sky/sun).
- **Textures = source NEW higher-quality CC0 PBR sets** per biome (albedo/normal/roughness/AO + 1–2
  anti-tiling variants each).

### HARD CONSTRAINT — the 16-sampler cap (the reason texture arrays exist)
Metal caps a fragment stage at **16 samplers**. The old terrain already binds ~13. Adding rough/AO per
biome blows past 16. **Foundational fix: pack biome tiles into `RawTexture2DArray`** — one array sampler
for ALL biome albedos, one for ORM (rough/AO) — counts as 1 sampler each regardless of layer count, and
makes adding biomes/variants cheap. All array layers must be SAME size+format (curated to 1024²).

### What we're replacing
The old skin (`buildTerrainMaterial`, clipmap mode): StandardMaterial `CustomMaterial`, triplanar splat of
tiling Polyhaven diffuse tiles, biome weights computed LIVE in-shader from height/slope/moisture, macro
tint, detail normals, cloud shadows, aerial haze, ragged waterline. Gaps: procedural (can't see the baked
reefs/erosion/flow), not art-directable, visibly repeats up close, **diffuse-only** (no roughness/AO → no
wet-vs-dry response).

### Phase status

| Phase | Goal | Status |
|-------|------|--------|
| **S0** | Spike: stand up `PBRCustomMaterial` clipmap parity behind `?terrainpbr` — port displacement + Sobel + triplanar/biome/macro/detail-normal/cloud-shadow/haze onto PBR; verify on WebGPU under Atmosphere. De-risk the material switch before investing in textures. | ✅ **VERIFIED ON SCREEN** (commit `e9ad9c7`) |
| **S1a** | Tile pipeline: `download-terrain-tiles.js` fetches rough+ao (optional per-file) + `--2k` knob; PBR gains `Fragment_Custom_MetallicRoughness` procedural wet/dry stopgap. | ✅ DONE |
| **S1b** | Pack 5 core biomes into two `RawTexture2DArray` @1024² (**uAlbedoArr** RGB, **uOrmArr** R=rough/G=AO) via canvas pixel extraction; 5 diffuse samplers → 2 `sampler2DArray`; real per-biome roughness + AO crevice darkening. | ✅ DONE (needs WebGPU verify) |
| **S2** | Control-map bake: server `auxSplat` bakes SOFT flow-aware per-biome weights → `splat_map.png` (2048); route `/terrain/splat-map`; client `uSplat` + `_biomeSplat()` re-sharpens cliffs with geometry slope; falls back to live `_biomeW` (gated by `uHasSplat`). Art-directable control + flow data for S4. | ✅ DONE (needs WebGPU verify + **server restart** for the new route) |
| **S3** | Anti-tiling + macro color: albedo array → 8 layers (5 core + sand2/grass2/rock2); cross-fade fine triplanar with variant via ~600 m noise so tiles don't align; macro cool↔warm ±13% tint over ~300–900 m. Shader-only (no rebuild). | 🔶 Coded; not yet validated (needs tiles served) |
| **S4** | Flow & erosion skinning: flow map → wetter/darker/sediment-toned, water-polished drainage channels + deposition fans; erosion-aware roughness. | ⬜ TODO |
| **S5** | Coastal & biome-edge detail: wet-sand tide line + foam stains + spray near waterline; richer biome borders (grass creeping onto sand, scree at rock/grass), height-based blend transitions. | ⬜ TODO |
| **S6** | Tune + perf + retire old path: sampler/VRAM budget, mip/detail LOD, per-region threshold tune, final art pass; **remove the StandardMaterial path once PBR is default**. | ⬜ TODO |

**S0 is verified on screen. S1–S3 code is present in the material but can't be judged yet** because the
real `_rough`/`_ao` ORM tiles and the splat map aren't being served (placeholders bound), and the ocean
RTT shader variants fail to link (see "Where to pick up").

### Key skin files
- Client `terrain.service.ts`: `buildTerrainMaterialPBR(scene, manifest)` (the PBR path, behind
  `?terrainpbr`); `loadBiomeArrays` (packs the texture arrays); `createClipHeightTexture`; clipmap
  vertex/fragment GLSL injections; `onBindObservable` uniforms. The default `buildTerrainMaterial`
  (StandardMaterial) is untouched.
- Server: `data/aux-maps.mjs` (`auxSplat` control-map bake, S2), `scripts/build-terrain-region.mjs`,
  tile fetch (`download:terrain-tiles`).
- Manifest `auxMaps` block (incl. `splat` descriptor).

---

## ✅ ORIGINAL BLOCKER — RESOLVED (the journey is in `HANDOFF_terrainpbr.md`)

The `?terrainpbr` material now COMPILES and renders solid terrain. It took **four** distinct fixes, not the
one the original handoff guessed:
1. **`color` → `finalColor` AND wrong hook.** `Fragment_Before_FinalColorComposition` fires BEFORE
   `finalColor` is even declared on PBR (and there's no `color` var). Moved the cloud-shadow/haze block to
   **`Fragment_Before_Fog`** (where the composed `finalColor` vec4 exists, still linear/pre-tonemap).
2. **`//` comments inside the metallic-roughness injection.** `'wetter' : undeclared identifier` was NOT
   unicode (red herring) — `PBRCustomMaterial` runs the fragment shader through `ShaderCodeInliner`, which
   inlines `pbr_inline` functions and collapses newlines, so a `//` comment in the (inlined)
   `Fragment_Custom_MetallicRoughness` block ate its newline and the next tokens parsed as code. Converted
   those to `/* */` block comments.
3. **`vPositionW` not re-synced after displacement.** Displacing `worldPos.y` in
   `Vertex_After_WorldPosComputed` moves the geometry but Babylon froze `vPositionW = worldPos` BEFORE that
   hook → fragment read a flat sea-level Y → the waterline `discard` culled nearly everything (terrain
   appeared in sparse stripes). Added `vPositionW = worldPos.xyz;` in the hook.
4. **Glossy "wet water" look** — the `wet` term drove roughness to ~0.33 on the flat beach → mirror-sky.
   Raised the floor: `metallicRoughness.g = clamp(mix(rgh, rgh*0.78, wet), 0.62, 1.0)`.

---

## Hard-won WebGPU GLSL-injection rules (recurring pain — DO NOT VIOLATE)
1. **Never use `out`/`inout` function params** in injected GLSL on WebGPU → "SPIR-V requires location for
   user input/output". Return a `vec4`/`float` instead. (`_biomeW`/`_biomeSplat` return vec4.)
2. **Inside any injection that lands in a `pbr_inline` function** (notably
   `Fragment_Custom_MetallicRoughness`, `Fragment_Custom_MicroSurface`) use **`/* */` block comments only —
   never `//`**. The PBR `ShaderCodeInliner` collapses newlines and a `//` comment then eats real code.
   (`//` is fine in StandardMaterial — no inliner — and in PBR `main()`-level injections like Before_Lights.)
3. **Post-process the composed color at `Fragment_Before_Fog`** using `finalColor` (vec4). The
   `*_FinalColorComposition` hook is too early (`finalColor` not declared yet); `*_FragColor` is too late
   (post-tonemap). There is **no `color` var** on PBR — that's StandardMaterial.
4. **Any vertex displacement in `Vertex_After_WorldPosComputed` must also re-assign `vPositionW`** — it was
   frozen from the pre-displacement worldPos earlier in the shader.
5. **Keep injected GLSL ASCII** (still good practice; a unicode glyph CAN desync glslang) — but note it was
   NOT the `wetter` culprit here; #2 was.
6. **`Material.onError` does NOT fire** for WebGPU SPIR-V failures (they're unhandled zone.js rejections);
   `onCompiled` DOES fire on success — used as the `[TerrainPBR] shader compiled OK` signal.

## Outstanding non-blocking issues (the "Where to pick up" work)
- **`Link failed: Missing entry point` ×5** — the terrain PBR material fails to build shader VARIANTS for
  the ocean reflection/refraction RTTs (clipmap meshes are enrolled via `oceanService.addToRenderList`).
  Affects the *water's* reflection/refraction of the land, not the main view. Likely the
  PBRCustomMaterial `_createdShaderName` shader-cache returning early for a different define permutation.
- Tile `400`/`404` for `_ao`/`_rough` suffixes — ORM array falls back to a matte placeholder, so S1b's real
  per-biome roughness/AO isn't visible yet.
- `/terrain/splat-map` (S2) needs a **server restart** (+ region rebuild) to be served; until then
  `uHasSplat=0` and the shader uses live `_biomeW`.
- **GPU particle system** `ERROR: 0:42: 'location'` — separate shader (`gpuParticleSystem.pure.js`), not terrain.
- `Canvas2D willReadFrequently` warning — pre-existing, harmless.

## Risks carried forward
WebGPU GLSL-injection fragility (recurring); 16-sampler cap (mitigated via arrays, S1); Atmosphere↔PBR
lighting/haze double-up (S0 decision — may drop manual haze); texture-array format/size uniformity; VRAM
(arrays × layers × channels — budget in S6); keeping clipmap vertex displacement + Sobel normals correct
under the new material; CC0 licensing/attribution for new tile sets.

---

## Where to pick up (S0 is done & committed — paused here)
Pick any thread; they're largely independent:
1. **Fix the RTT link errors** (`Missing entry point` ×5) so the water correctly reflects/refracts the
   terrain. Investigate how `PBRCustomMaterial.Builder` caches by `_createdShaderName` across the main pass
   vs the ocean reflection (clip-plane) / refraction RTT passes — the cache likely returns early for a
   permutation whose I/O doesn't match, yielding an empty fragment entry point. Terrain is enrolled in the
   ocean RTTs in `terrain.service.buildClipmap` (`oceanService.addToRenderList(cm)`).
2. **Get rough/AO + splat served** so S1–S3 become real: `npm run download:terrain-tiles` (confirm
   `_rough`/`_ao` actually land + are served by `terrain/tile/<name>`), and restart the server (+ rebuild
   region) so `/terrain/splat-map` serves. THEN judge S1b (wet/dry + AO), S2 (splat tracks terrain, crisp
   cliffs), S3 (anti-tiling + macro colour).
3. **Then S3 sign-off**, and proceed S4 (flow/erosion) → S5 (coastal) → S6 (perf + retire StandardMaterial).
   Each phase: build + run-on-WebGPU + user commit between phases.

**Temp diagnostic still in code:** `mat.onCompiled = () => console.info('[TerrainPBR] shader compiled OK')`
near the end of `buildTerrainMaterialPBR` — remove once the surface is fully signed off.
