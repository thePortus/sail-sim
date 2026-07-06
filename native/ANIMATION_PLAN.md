# Vessel animation plan — porting the Angular controllers

Goal: replicate the browser's per-ship animation drivers (`SloopController`,
`PinnaceController`, `BrigController`, `MerchantmanController`) in the native
client: full sail trim with rigging that follows, animated sail states,
animated anchors, and wind-streaming flags. Gunnery + mast damage are designed
for now, implemented with combat later.

## Why the pinnace looks broken today (and what it tells us)

`gltf_mesh.cpp` reads raw vertex positions per primitive and **ignores the node
hierarchy, node transforms, skins and morph targets entirely**. The three
symptoms observed on the pinnace are all this one gap:

- **Sails rotated 90°** — the pinnace's sails/rigging are *skinned* to the
  `MainTrim`/`JibTrim` bones (its manifest: "all running rigging is skinned to
  them"). Skinned vertices are authored in bind space; without applying joint
  matrices they render in the wrong orientation.
- **Anchor amidships** — the anchor is positioned by its node/bone (stowed "in
  the cathead" via the `AnchorDrop` clip's frame-0 pose); raw vertices sit at
  the authored origin.
- The sloop/brig/merchantman *mostly* look right because their hull geometry is
  authored at identity transforms — but they have the same latent bugs on every
  posed part.

So the foundation of all animation work is a real scene-graph importer, and it
fixes the pinnace's static pose as a side effect.

## What the browser does (summary of the four controllers)

Common machinery (all four):
- **Scrubbed clips** — animation groups are never *played*; they're started,
  paused and `goToFrame`'d to pose rudder / yard-trim / anchors / guns.
  Normalized scrubs (`poseNorm`) hit the clip's true `[from, to]`.
- **Morph targets** — sail furl (0 set → 1 furled) driven directly, with the
  paired rigging morphs (`sail_sheet_pairs` in the per-ship manifest) driven in
  lockstep so sheets/clews gather with the sail.
- **Free bones** — flags/pennants/wheel rotated in code, composed onto a
  captured rest pose; flags yaw about **world** up so they stream downwind and
  stay horizontal regardless of heel.
- **Easing** — everything eases: furl 0.6/s, boom swing 1.8 rad/s, trim 1.6–2.0/s,
  anchors 0.7/s, so state changes animate rather than snap.
- **Per-instance state** — every vessel (local + each remote) owns its own
  controller, cloned node/skeleton/morph state.
- The skinned rigging only follows if the skeleton matrices are recomputed
  after posing the nodes each frame.

Per-ship differences that must be preserved:

| | sloop | pinnace | brig | merchantman |
|---|---|---|---|---|
| Trim clip | one-sided 0..1 (yards) **+ manual B_Boom/B_Gaff swing overwritten after the clip** (leeward per tack) | symmetric 0=port tack, 0.5=amidships, 1=stbd; lug rig: eased → leeward end | symmetric; square-rig mapping: braced when close-hauled, square (0.5) running, tack sign | symmetric, like brig (yards + spanker gaff share the clip) |
| Sails | 6, morph furl + sheet_morph pairs | 2 (`Mainsail`, `Jib`), furl + rigging_morphs; topsails state = main reefed **0.5**, jib up | 13, `Furl_<sail>` morphs on shared rope meshes | 13, rope follow via `Furl_Sail_<name>` on rig_running / rig_sailgear / rig_headsheets |
| Rudder | composed spin on `B_Rudder` (one-sided clip unusable) + `B_Wheel` spin | `Rudder` node set **absolutely** (bind pose is hard-over +30°!), tiller follows as child | symmetric clip; wheel spins about local **X** | symmetric clip; wheel spins about local **Y** |
| Anchors | `AnchorDrop_S/P` clips | **one** anchor: `AnchorDrop` clip + `AnchorCable` morph | two; **clip↔morph side pairing swapped on purpose** | two; cable pays out via gradient skin (no morph) |
| Flags | `B_Flag`, `B_Pennant` (world-Y stream + flutter) | `Flag1>2>3` chain, travelling-wave ripple | Ensign / Burgee / Pennant, limp in dead air | four flags (Ensign / Fore / Pennant / Mizzen) |
| Quirks | clips are FULL-SKELETON bakes → **prune constant channels** or layered scrubs clobber each other | starboard = **−X** (opposite the sloop); schema-2 manifest | `NLA_` clip-name prefixes | `NLA_` prefixes; hull authored at `baseYawDeg: 90` |
| Import | `importFlipY: true` | `importFlipY: false`, `rightSign: -1` | — | `baseYawDeg: 90` |

Manifests (`server/assets/geometry/<ship>.manifest.json`) carry the semantic
map: joints, clip semantics, `sail_sheet_pairs` (sail → morph node+index +
rigging morphs), `mast_damage`, constants (rudder_max_deg, frame ranges). The
native port should fetch and parse them rather than hard-coding indices.

Network: pose updates already carry `sheetAngle` + `isPortTack` (server relays
them; NPCs send sheetAngle 0) — remote ships trim from those exactly like the
browser (`multiplayer.service` line ~1707).

## Native implementation phases

### Phase 0 — scene-graph importer (the heavy lift; fixes the pinnace statically)
Extend `gltf_mesh` / vessel loading to retain:
1. **Node hierarchy** with rest TRS per node, node→mesh association; per-frame
   world-matrix evaluation. Draw each submesh with `shipModel × nodeWorld`
   (per-submesh matrix slot in the existing dynamic-offset uniform scheme).
2. **Skins**: JOINTS_0/WEIGHTS_0 vertex attributes + inverse bind matrices;
   GPU skinning with a per-vessel-instance bone palette (≤ ~24 bones, one
   mat4 array in the per-instance uniform block). Skinned pipeline variant.
3. **Morph targets**: per-primitive delta-position buffer(s) + per-submesh
   weight uniforms (each sail mesh has few morphs — Furl (+Break later);
   2-slot GPU morphing covers everything the controllers drive).
4. **Animations**: parse channels/samplers into named clips (strip `NLA_` and
   `.NNN` suffixes), sample-at-time evaluation for scrubbing, constant-channel
   pruning (the sloop's full-bake clips require it).
5. **Manifest fetch + parse** alongside each GLB.
6. Apply the per-ship import quirks (`importFlipY`, `baseYawDeg`) at load.

Static acceptance: pinnace renders with sails on the mast line, anchor at the
starboard cathead, rudder centred — screenshot vs the browser.

### Phase 1 — controller framework
`VesselAnim` interface mirroring the TS contract: `setRudder`, `setSailTrim
(sheetDeg, isPortTack)`, `applySailState`, `dropAnchor(side, t)`, `idleWind
(windLocalRad, strength, t)`, `tickRig(dt)` (+ gun/mast API stubbed). Four
implementations with the per-ship logic in the table above, including all the
easing rates and the composition rules (boom swing applied AFTER the trim clip;
skeleton recompute after posing).

### Phase 2 — drive it from game state
- **Local ship**: helm → `setRudder`; `vessel.sheetAngleDeg` + tack →
  `setSailTrim` (tack already computed in `sail_physics`; expose it);
  W/S → `applySailState`; P → `dropAnchor`; wind → `idleWind`; `tickRig(dt)`
  every frame.
- **Remote ships**: add `sheetAngle`/`isPortTack` to the native pose send +
  parse (`net_mp`); one controller instance per remote vessel (per-instance
  bone palettes + morph weights — the current shared-Mesh draw needs a
  per-instance animation state block).
- **Flags** stream downwind per the client formulas (they also read wind).

### Phase 3 — delivery order (visible wins first)
1. Phase 0 + static pose fixes (pinnace!) — verify all four hulls at rest.
2. Trim: yards/boom/gaff + skinned rigging follow Q/E/T and tack changes.
3. Sail states: eased furl morphs + rope follow (client per-ship tables).
4. Anchors animated on P (per-ship: one vs two, cable morph vs skin).
5. Flags/pennants streaming + fluttering with the wind.
6. Wheel + rudder deflection with helm.
7. *(with combat later)*: gunport lids, run-out, recoil, mast damage/dismasting.

### Polish (optional, after the above)
- `SailBillowPlugin` port: vertex-shader wind ripple on set sails.
- First-person/V camera interactions with animated rig (n/a until V exists).

## Verification
Headless screenshots per ship per state (SAILSIM_MODEL override + SAILSIM_*
hooks): rest pose, trimmed hard in/out on each tack, each sail state, anchor
down, storm flags. Compare against the browser side-by-side.
