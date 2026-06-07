# Handoff — `?terrainpbr` PBR terrain won't render (WebGPU shader compile failure)

## TL;DR
We're building an **aux-driven PBR terrain surface** for "Bay of Pirates" (sail-sim), gated behind the
`?terrainpbr` URL flag. The default StandardMaterial terrain path is untouched and works fine. The PBR
path currently **fails to compile its fragment shader on WebGPU**, so the terrain mesh never renders.

**Root cause (diagnosed, not yet fixed):** our injected GLSL in the
`Fragment_Before_FinalColorComposition` hook references a variable named **`color`**, which does **not
exist** at that injection point in `PBRCustomMaterial` (that's the *StandardMaterial* name). The fix is
to use the correct PBR final-color variable name (likely `finalColor`), verified against the Babylon PBR
fragment shader source.

## The exact errors (from browser console, WebGPU + glslang GLSL→SPIR-V)
```
ERROR: 0:1092: 'color' : undeclared identifier
ERROR: 0:1092: 'rgb' : vector swizzle selection out of range
ERROR: 0:1092: '' : compilation terminated
ERROR: 3 compilation errors.  No code generated.
Error: GLSL compilation failed   (bubbles as an unhandled promise rejection through zone.js)
```
- Stack trace runs through `pbrBaseMaterial.pure.js → isReadyForSubMesh → mesh render`, confirming this
  is **our terrain PBR material**, not something else.
- Line number varies (`0:1091` / `0:1092`) between compile attempts — same block, different define perms.

## Where the bug is
**File:** `client/src/app/sailing/services/terrain.service.ts`
**Function:** `buildTerrainMaterialPBR(...)` (gated behind `?terrainpbr` via `usePBR` ~line 176)

The offending GLSL is injected at the **`Fragment_Before_FinalColorComposition`** hook
(`#define CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION`). It does cloud shadows + aerial haze and looks
roughly like:
```glsl
color.rgb *= 1.0 - cShadow * 0.55;
color.rgb = mix(color.rgb, uHazeColor, hazeF);
```
`color` is undeclared here on `PBRCustomMaterial`. This block was inherited from phase S0 and **never
actually compiled/rendered before** (S0 was never verified on screen), so the bug was latent until now.

## The fix (next step)
1. Read the Babylon PBR fragment GLSL source to find the in-scope final-color variable at the hook:
   - `client/node_modules/@babylonjs/core/Shaders/pbr.fragment.js` (GLSL — this is the one to grep)
   - (`client/node_modules/@babylonjs/core/ShadersWGSL/pbr.fragment.js` is the WGSL variant; we use the GLSL path.)
   - Grep for `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION` and look at the variable in scope just before it.
   - **NOTE:** there is no `pbr.fragment.fx` file — Babylon's PBR shaders are `.js`.
2. Replace `color` → the correct name (expected **`finalColor`**, a `vec4`) in that injection block, e.g.
   `finalColor.rgb *= ...;` and `finalColor.rgb = mix(finalColor.rgb, uHazeColor, hazeF);`
3. Have the user **hard-reload** (`Cmd+Shift+R`) `?terrainpbr` and confirm:
   - Console prints `[TerrainPBR] shader compiled OK` (a temp diagnostic — see below).
   - The terrain renders.
4. If it compiles but renders **flat** (no displacement), switch the GPU height displacement to the proven
   StandardMaterial path: in `Vertex_Before_PositionUpdated`, do
   `positionUpdated.y = _clipHW((world * vec4(positionUpdated, 1.0)).xz);`

## Hard-won WebGPU / PBRCustomMaterial GLSL rules (DO NOT VIOLATE)
- **Injected GLSL must be STRICTLY ASCII.** A multi-byte UTF-8 char (unicode arrows/dashes/box glyphs)
  anywhere — even in a comment — desyncs glslang's comment parser and causes spurious `Parse failed`.
- **Never use `out`/`inout` function params** in injected GLSL on WebGPU → "SPIR-V requires location for
  user input/output". Return a `vec4`/`float` instead.
- **`Material.onError` does NOT fire** for WebGPU async-pipeline SPIR-V failures — errors surface as
  unhandled promise rejections via zone.js. `onCompiled` DOES fire on success. (That's why we added the
  temp diagnostic below to catch the failure deterministically.)
- The `color`-vs-`finalColor` variable-name difference between StandardMaterial and PBRCustomMaterial is
  the current blocker — the StandardMaterial hooks expose `color`, PBR ones do not.

## Temp diagnostic currently in the code (remove once it renders)
Near `this.terrainMaterialPBR = mat;` in `buildTerrainMaterialPBR`:
```ts
mat.onError = (_effect, errors) => console.error('[TerrainPBR] SHADER COMPILE FAILED:\n' + errors);
mat.onCompiled = () => { console.info('[TerrainPBR] shader compiled OK', {...}); };
```

## Known-separate issues (NOT the terrain blocker — don't get distracted)
- **`ERROR: 0:42: 'location' : SPIR-V requires location for user input/output`** — stack runs through
  `gpuParticleSystem.pure.js`. This is the **GPU particle system** shader, a separate (possibly
  pre-existing) compile failure. Set aside.
- **Tile `400 Bad Request` for `…_ao` / `…_rough` maps** — rough/AO terrain tiles aren't served, so the
  ORM texture array falls back to defaults. Pre-existing; not a compile blocker. May need
  `npm run download:terrain-tiles` and/or a server route that serves those suffixes.
- **`Canvas2D … willReadFrequently` warning at terrain.service.ts:430** (`updateTerrainShadowMask`) —
  pre-existing perf warning, harmless.
- **`precision mediump int; precision highp float;` warnings** — benign glslang noise.

## Build / environment gotchas
- Always `cd /Users/thomaei/git/apps/sail-sim/client` before any `npx`/`npm` — cwd resets between shells.
- **Hard-reload (`Cmd+Shift+R`) after every shader/material edit** — HMR corrupts WebGPU shader state and
  produces stale/false errors. When in doubt, do a clean `npm start` (the previous stale-bundle `wetter`
  errors only vanished after a genuinely fresh `ng serve` restart).
- Engine is **BabylonJS 9.10.1, WebGPU-primary**. Client is Angular 19; server is Express/Node.
- **Commit/push ONLY when explicitly asked.**

## Project / roadmap context
- This is the **terrain skinning roadmap** (APPROVED, phase-by-phase with sign-off). Current phase: **S3**
  (anti-tiling + macro color). Phases: S0 (PBR parity spike) → S1 (PBR tiles + texture arrays) → S2
  (control-map bake) → **S3** → S4 (flow & erosion) → S5 (coastal & biome-edge) → S6 (tune/perf + retire
  StandardMaterial).
- Constraint that shaped the whole design: **16-sampler Metal cap** → albedo/ORM packed into
  `RawTexture2DArray` (albedo 8 layers, ORM 5 layers), sampled via `texture(uArr, vec3(uv, float(layer)))`.
- Terrain is a **camera-centric clipmap**: GPU vertex displacement from an R32F heightfield via manual
  texelFetch bilinear (`_clipHW`), Sobel normals.

## Immediate next action
Grep `client/node_modules/@babylonjs/core/Shaders/pbr.fragment.js` for
`CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION`, identify the final-color variable in scope, patch the
injection block in `terrain.service.ts`, then have the user hard-reload `?terrainpbr` and report whether
`[TerrainPBR] shader compiled OK` appears and the terrain renders.
