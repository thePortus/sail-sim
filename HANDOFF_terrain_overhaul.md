# Handoff — Terrain Overhaul (the big picture: shape → skin)

This is the strategic handoff for the **two-roadmap terrain overhaul** in "Bay of Pirates" (sail-sim).
A second doc, `HANDOFF_terrainpbr.md`, covers the *immediate* WebGPU compile blocker — read that for the
"what do I do right now" task. This doc explains **where we are in the larger plan and why**.

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

2. **Terrain Skinning Roadmap (S0–S6) — the SKIN.** 🔶 **IN PROGRESS (S0–S3 implemented, at S3 verify).**
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
| **S0** | Spike: stand up `PBRCustomMaterial` clipmap parity behind `?terrainpbr` — port displacement + Sobel + triplanar/biome/macro/detail-normal/cloud-shadow/haze onto PBR; verify on WebGPU under Atmosphere. De-risk the material switch before investing in textures. | ✅ Implemented (needs WebGPU verify) |
| **S1a** | Tile pipeline: `download-terrain-tiles.js` fetches rough+ao (optional per-file) + `--2k` knob; PBR gains `Fragment_Custom_MetallicRoughness` procedural wet/dry stopgap. | ✅ DONE |
| **S1b** | Pack 5 core biomes into two `RawTexture2DArray` @1024² (**uAlbedoArr** RGB, **uOrmArr** R=rough/G=AO) via canvas pixel extraction; 5 diffuse samplers → 2 `sampler2DArray`; real per-biome roughness + AO crevice darkening. | ✅ DONE (needs WebGPU verify) |
| **S2** | Control-map bake: server `auxSplat` bakes SOFT flow-aware per-biome weights → `splat_map.png` (2048); route `/terrain/splat-map`; client `uSplat` + `_biomeSplat()` re-sharpens cliffs with geometry slope; falls back to live `_biomeW` (gated by `uHasSplat`). Art-directable control + flow data for S4. | ✅ DONE (needs WebGPU verify + **server restart** for the new route) |
| **S3** | Anti-tiling + macro color: albedo array → 8 layers (5 core + sand2/grass2/rock2); cross-fade fine triplanar with variant via ~600 m noise so tiles don't align; macro cool↔warm ±13% tint over ~300–900 m. Shader-only (no rebuild). | ✅ DONE (needs WebGPU verify) — **CURRENT PHASE** |
| **S4** | Flow & erosion skinning: flow map → wetter/darker/sediment-toned, water-polished drainage channels + deposition fans; erosion-aware roughness. | ⬜ TODO |
| **S5** | Coastal & biome-edge detail: wet-sand tide line + foam stains + spray near waterline; richer biome borders (grass creeping onto sand, scree at rock/grass), height-based blend transitions. | ⬜ TODO |
| **S6** | Tune + perf + retire old path: sampler/VRAM budget, mip/detail LOD, per-region threshold tune, final art pass; **remove the StandardMaterial path once PBR is default**. | ⬜ TODO |

**Everything S0–S3 is "implemented, needs WebGPU runtime verify."** None of it has been confirmed on
screen yet — see the blocker below.

### Key skin files
- Client `terrain.service.ts`: `buildTerrainMaterialPBR(scene, manifest)` (the PBR path, behind
  `?terrainpbr`); `loadBiomeArrays` (packs the texture arrays); `createClipHeightTexture`; clipmap
  vertex/fragment GLSL injections; `onBindObservable` uniforms. The default `buildTerrainMaterial`
  (StandardMaterial) is untouched.
- Server: `data/aux-maps.mjs` (`auxSplat` control-map bake, S2), `scripts/build-terrain-region.mjs`,
  tile fetch (`download:terrain-tiles`).
- Manifest `auxMaps` block (incl. `splat` descriptor).

---

## ⚠️ ACTIVE BLOCKER (read `HANDOFF_terrainpbr.md` for the fix)

The `?terrainpbr` PBR material currently **fails its WebGPU fragment-shader compile**, so the PBR terrain
never renders (you only ever saw the StandardMaterial default). **Root cause:** the
`Fragment_Before_FinalColorComposition` injection uses a variable named `color`, which doesn't exist at
that hook in `PBRCustomMaterial` (that's the StandardMaterial name) →
`'color' : undeclared identifier` + `'rgb' : vector swizzle selection out of range`. **Fix:** use the
correct PBR final-color variable (likely `finalColor`), verified against
`node_modules/@babylonjs/core/Shaders/pbr.fragment.js`. Until this compiles, **S0–S3 cannot be visually
verified.**

---

## Hard-won WebGPU GLSL-injection rules (recurring pain — DO NOT VIOLATE)
These cost real debugging time across S1b–S3:
1. **Injected GLSL must be STRICTLY ASCII** — a unicode arrow/dash/box-glyph in a *comment* desyncs
   glslang's parser and produces phantom errors (e.g. a later word like `wetter` "leaking out as code").
2. **Never use `out`/`inout` function params** in injected GLSL on WebGPU → "SPIR-V requires location for
   user input/output". Return a `vec4`/`float` instead. (`_biomeW`/`_biomeSplat` were refactored for this.)
3. **`Material.onError` does NOT fire** for WebGPU async-pipeline SPIR-V failures — they surface as
   unhandled promise rejections via zone.js. `onCompiled` DOES fire on success.
4. **StandardMaterial vs PBRCustomMaterial expose different final-color variable names** at the
   composition hook (`color` vs `finalColor`) — the current blocker.
5. Backticks inside the GLSL template-literal comments break the JS string.

## Outstanding non-blocking issues (don't get distracted)
- **GPU particle system** `ERROR: 0:42: 'location'` — separate shader (`gpuParticleSystem.pure.js`), not terrain.
- Tile `400` for `_ao`/`_rough` suffixes — server may not serve those; ORM array falls back to defaults.
- `/terrain/splat-map` (S2) needs a **server restart** to be served.
- `Canvas2D willReadFrequently` warning (terrain.service.ts:430) — pre-existing, harmless.

## Risks carried forward
WebGPU GLSL-injection fragility (recurring); 16-sampler cap (mitigated via arrays, S1); Atmosphere↔PBR
lighting/haze double-up (S0 decision — may drop manual haze); texture-array format/size uniformity; VRAM
(arrays × layers × channels — budget in S6); keeping clipmap vertex displacement + Sobel normals correct
under the new material; CC0 licensing/attribution for new tile sets.

---

## Where to pick up
1. **Unblock the compile** (see `HANDOFF_terrainpbr.md`): fix `color` → `finalColor` in the
   `Fragment_Before_FinalColorComposition` block of `buildTerrainMaterialPBR`. Hard-reload `?terrainpbr`,
   confirm `[TerrainPBR] shader compiled OK` + terrain renders.
2. **Verify S0–S3 visually** (now that it renders): displacement + Sobel normals correct; texture arrays
   bind on WebGPU; real wet/dry + AO crevice darkening (S1b); splat control map tracks terrain, cliffs
   crisp (S2 — restart server first); repetition broken on beaches/grass/rock + macro colour variation
   (S3); FPS (S3 is ~36 taps/px near field — perf is an S6 concern).
3. **Remove the temp `onError`/`onCompiled` diagnostic** once it renders.
4. **Get S3 sign-off**, then proceed to **S4 (flow/erosion skinning)** → S5 (coastal) → S6 (perf + retire
   StandardMaterial). Each phase: build + run-on-WebGPU + user commit between phases.
