# Combat Port Plan — faithful C++/WebGPU port of the Angular combat stack

Source of truth studied:
- `client/.../combat.constants.ts`, `combat.service.ts`, `cannon.service.ts` (2286 lines — guns, aiming, balls, FX, decals, audio)
- `client/.../muzzle-explosion.ts` (raymarched fireball), `muzzle-smoke.ts` (simplex billboards), `mast-crack.service.ts` (audio), `salvage.service.ts`
- `client/.../vessel.service.ts` + `combat.constants.ts` (listing/capsize/sinking, mast collapse drivers), `vessel-buoyancy.service.ts`
- `server/combat.js`, `combat-constants.js`, `multiplayer.js` (message hub), `salvage.js`, `npc.js` — the server is UNCHANGED; we implement its client contract exactly.

The four vessel GLBs already carry everything combat needs and it all speaks our
existing `vanim::Controller` scrub machinery:

| ship | run-out clips | lid clips | lid nodes | mast fall | break morph |
|---|---|---|---|---|---|
| sloop | `Gun_P/S` (B_Gun_*) | `Lid_P/S` | B_LidP_0-2 / B_LidS_0-2 | `MastDown` (falls to port) | `Sloop_Mast` "Break" |
| pinnace | `Gun_P/S` (GunMount_*) | — (open mounts) | — | `MastDown` | `Pinnace_Mast` "Break" |
| brig | `NLA_Gun_P/S` | `NLA_Lid_P/S` | B_Lid_P0-3 / B_Lid_S0-3 | `MastDown_Fore` (dmg 0.40–0.70), `MastDown_Main` (0.70–1.00) | `Mast_*_Lower` "Break_*" |
| merchantman | `Gun_P/S` (+0.6 m out) | `Lid_P/S` | B_Lid_P0-2 / B_Lid_S0-2 | `MastDown_Fore/Main/Mizzen` (3 zones) | per manifest |

---

## Authority model (server is unchanged and owns everything)

- Client sends `cannon_shot {ox,oy,oz,vx,vy,vz,seq,shotType}`. Server validates:
  origin within 16 m of authPose, |v| in per-ammo band (round 45–66, bar 30–45,
  grape 20–32), per-side reload token bucket (capacity = gunsPerSide, refill over
  6 s / crewFactor). Invalid shots are silently dropped — the client must
  self-enforce the same limits so the visuals never desync.
- Server flies every shot wait-and-see (SIM_DT 0.02 s, max 6 s) against victims'
  micro-dead-reckoned poses, resolves zone + damage, then broadcasts
  `combat_hit {shooterId,victimId,seq,zone,hx,hy,hz,side,tof,grape?}` and
  `combat_state {playerId, zones, maxHp?}`.
- The client's ball (matched by key `shooterId:seq`) DEFERS the impact cosmetic
  until its own flight time reaches `tof` — visuals land in sync with the ball.
- Grape: multiple pellets, each its own `combat_hit` with `grape:true`; crew-only
  (no zone damage, no scorch decal); crew attrition arrives via `crew_state`.
- Sinking: any non-mast zone at 0 → `combat_sunk {victimId,shooterId,shooterName}`.
  Client plays capsize; `respawn` (no args) teleports to nearest harbour, hull
  restored, crew NOT restored. Dock repair = `combat_reset` → `repair_result` +
  `combat_repair` (clears decals on remotes).
- Masts at 0 → private `mast_repair {ms}` (60 s / crewFactor); server jury-rigs
  masts back to 50% when the timer lapses (arrives as a normal `combat_state`).
- Salvage: `salvage_snapshot` on connect, `salvage_spawn {id,x,z}` /
  `salvage_despawn {id}`; client sends `salvage_collect {crateId}` when within
  40 m (server re-checks 60 m); private `salvage_collected {goods,gold}` + wallet.
- NPC shots arrive as ordinary `cannon_shot` broadcasts with `id:"npc_N"` — the
  native client renders them identically to player fire (already true for poses).

## Key constants (verbatim — put in `combat_constants.hpp`)

```
G 9.81   TRAVEL_SCALE 3
MUZZLE_V: round 55 / bar 37 / grape 26 (m/s)
GRAPE: 5 pellets, ±7° azimuth, ±4° elevation
ELEV: min 0, max 18, hull 3, mast 12 (deg); rate 7°/s (Shift/Ctrl); H/M presets; G cycles ammo
LOCK: arc 42°, cone 52°, max range 320 m, aim Y 0.6 (hull) → 14 (mast); 3-iteration lead solver
STAGGER 0.18–0.42 s per gun; RELOAD base 6 s / crewFactor, ±16% per-gun, ±7% per-shot, min 0.3 s
GUN_DEPLOY_RATE 1.4/s (lid = first half, gun = second half); GUN_RECOIL_DECAY 5/s
FLASH_DUR 0.6 s, intensity 6.0, colour (1.0,0.72,0.22)
BALL_POOL 24; ball Ø0.20 m; bar = dumbbell 2×Ø0.15 m + 0.40×Ø0.045 m bar; grape scale 0.4
spin: bar z+=26·dt y+=6·dt, grape z+=14·dt, round z+=5·dt
DECAL_MAX_PER_SHIP 16; scorch base size 1.35 (0.55 for masts) ×(0.82+rnd·0.36)
ZONE_HP: sloop 90/90/130/130/100 · pinnace 55/55/80/80/60 · brig 140/140/200/200/150 · merch 150/150/220/220/160
severity: ≥0.60 green, ≥0.30 yellow, >0 red, 0 destroyed
LIST_ROLL_MAX 0.32 rad, LIST_PITCH_MAX 0.24 rad, LIST_CURVE 0.55
SINK_DUR 3.2 s (smoothstep), SINK_DEPTH 3.2 m, CAPSIZE roll 0.96 / pitch 0.49 rad, reveal +700 ms
MAST_DAMAGE_ONSET 0.60; mastDown = sqrt(t)·0.55 (1.0 at hp 0); break = linear t; speed floor 0.30; helm cap 6°/s when down
crewFactor = 0.5 + 0.5·crew/maxCrew  (scales reload, sail drive, turn rate, mast repair)
caliber: pinnace ×0.8, sloop ×1.0, brig ×1.7, merch ×1.1 (server-side; listed for HUD math only)
SALVAGE: crate 2.4×1.6×2.4 m, bob = waveH+0.5, roll 0.12·sin(0.9t+x·0.01), collect 40 m, lifetime 4 min
```

---

## Phase 0 — protocol + combat state plumbing (no visuals)

`net_mp`: parse/emit the full message set — `cannon_shot` (both directions),
`combat_hit`, `combat_state`, `crew_state`, `mast_repair`, `combat_sunk`,
`combat_repair`, `repair_result`, `respawn`, `combat_reset`, `salvage_snapshot/
spawn/despawn/collect/collected`, `recruit_result`. Queue them lock-free like the
existing chat/correction paths.

New `combat.hpp/cpp`: `CombatState` store — my zones/maxHp/crew, per-remote
zones, sunk flags, mast repair timer. Severity bands + `listingFor()` /
`capsizeFor()` / `mastDownAmount()` / `mastBreakAmount()` / `mastSpeedMult()`
(formulas above, verbatim).

HUD: damage diagram (5-zone ship silhouette, green/yellow/red like the browser),
crew count, "You were sunk by X" card + respawn button, mast jury-rig progress
bar.

Test: admin teleport two probes together, `/mast`-style admin damage or a real
NPC skirmish; verify zone updates + sunk flow headless via logs.

## Phase 1 — guns, aiming, firing, projectiles

- `vanim` profiles grow gun handling (same pattern as anchors):
  `setGunDeploy(side, t)` scrubbing `Lid_<S>` over deploy 0→0.5 and `Gun_<S>`
  over 0.5→1.0 minus recoil (pinnace: no lids, gun scrub only). Recoil impulse
  per gun decays at 5/s. Deploy eases at 1.4/s; side states stowed/arming/engaged
  (engaged only when deploy ≥ 0.99).
- Input: B toggles battle stations per side facing an enemy? — browser: Q/E?…
  keep browser bindings: G cycles ammo, H/M elevation presets, Shift/Ctrl
  elevation, Space (or click) fires the ready side; keys configurable later.
- Per-gun arrays (loadAt/loadStart/fireAt/factor) with stagger + reload variance
  exactly as cannon.service; broadside fires loaded guns rippled 0.18–0.42 s.
- Aim assist: port `solveLock()` verbatim (nearest enemy within 42° of beam,
  ≤320 m; aim height from elevation; dead-reckon target; 3-pass lead/range/tof;
  azimuth clamped ±52° cone). Muzzle offsets from the vessel definitions.
- Trajectory tubes: 40-sample arcs per gun, red (free) / green (locked) —
  instanced polyline-to-tube or camera-facing ribbon; reticle billboard with
  pulsing amber brackets at the lock point.
- Ball pool (24): instanced spheres + bar dumbbells with the exact spins; grape
  spawns 5 pellets with the spread above. Flight = closed-form ballistic
  (o + v·t, y − ½Gt²); impact vs water (y<0.5 after 0.4 s) or terrain height;
  `combat_hit` matching by `shooterId:seq` with tof-deferred execution.
- Send `cannon_shot` per gun/pellet; render remote `cannon_shot` identically
  (remote muzzle FX rigs, LRU 2 rigs, no point lights on remotes).
- Muzzle flash: point light 0.6 s (we have a light budget of exactly the sun —
  add a per-frame "flash light" slot to mesh/ocean lighting, like lightning's
  scene flash), plus ocean glow hook (ocean already has cloud/shadow plumbing;
  add a small additive glow uniform like the client's addCannonFlash).

Test: two admin probes broadside each other; screenshot arcs/balls; assert
combat_state deltas arrive; NPC aggro check against a merchant.

## Phase 2 — effects (explosion, smoke, splashes, impact particles, audio)

- **Particle system (new, shared)**: CPU-simulated pools → one instanced quad
  draw per system (storage/instance buffer of pos+size+color+rot), soft-particle
  depth fade using the pre-ocean depth snapshot we already copy. Systems +
  budgets copied from cannon.service verbatim: splash ×4 pool (600), dirt (700),
  land pall (700), splinters (900), fire gust (320, additive), soot (600),
  legacy-muzzle fallbacks unneeded — we go straight to the shader FX below.
- **Muzzle explosion**: port `muzzle-explosion.ts` WGSL-ready raymarch verbatim
  (44/26 step variants, spiral+fbm noise, additive billboard, 0.9 s life,
  growth 0.8→1.15, pool 16). It was WRITTEN to be WGSL-legal (hash noise, baked
  loop counts) — near-direct translation.
- **Muzzle smoke**: port `muzzle-smoke.ts` — billboard puffs, Ashima simplex fbm,
  belch (10 puffs over 0.6 s, 3.2→12 m, 3.6–5.8 s) + pall (3 puffs, 8→22 m,
  9–14 s), wind drift, soft depth fade, gunpowder grey ramp.
- **Impact FX**: ship hit = splinters + fire gust + soot + flash (reverse-entry
  cones, cutoffs 0.10–0.6 s); water = spout pool; land = dirt + pall. Raycast
  refinement: nudge the server impact point onto the actual hull via a ray from
  6 m behind along the shot direction (CPU ray vs vessel mesh — reuse the rigged
  vertex data at rest + palette transform of the nearest triangle region, or
  simpler: project onto the hull's OBB surface; visually equivalent at our sizes).
- **Audio** (`audio.cpp` gains a cannon bus): 6-layer synth (bang 1.4–2.2 kHz,
  blast lowpass 780→70 Hz, punch 108→34 Hz, sub 52→18 Hz, roll 3.6 s through the
  existing reverb, echo +0.45 s), compressor-style limiter (simple soft-knee),
  remote attenuation 1−d/800; splash chirp; grape same bed.

## Phase 3 — damage display (decals, listing, sinking, masts)

- **Scorch decals**: on confirmed non-grape hits, spawn an oriented decal quad
  (or small projected box mesh) parented to the vessel instance: procedural char
  albedo (blotch ramp from the client, 128² generated once) + dented normal,
  size 1.35/0.55·rnd, cap 16 per ship FIFO, cleared on `combat_repair`.
  Native approach: per-vessel decal instance buffer rendered right after the
  ship draw with polygon-offset-equivalent (depth bias in pipeline).
- **Hit reaction**: shudder impulse into the buoyancy pose (roll kick toward the
  struck side) + camera shake (client caps ~1.2 m, ~1 s decay).
- **Listing**: apply `listingFor(zones)` roll/pitch into the vessel model matrix
  (blend with buoyancy pitch/roll) for self AND remotes.
- **Sinking**: `combat_sunk` → 3.2 s smoothstep to capsize pose (roll ±0.96,
  pitch ±0.49, forced tip if flat), settle −3.2 m, hold as wreck; overlay after
  +700 ms; respawn flow resets. Remote ships identical.
- **Masts**: drive `MastDown*` scrubs + `Break*` morphs from mast HP via the
  manifest zone windows (brig fore 0.40–0.70, main 0.70–1.00; merch 3 zones;
  sloop/pinnace single) — eased 1.5–2.5 s; mast-crack AUDIO one-shot when a zone
  crosses zero (brown-noise groan 2.4 s + 8 tapering wood cracks + final crash,
  distance-attenuated 700 m); sail drive × `mastSpeedMult`, helm cap 6°/s when
  fully down. Rigging follows because the fall clips animate the mast bones our
  palette already skins.

## Phase 4 — salvage + economy round-trip

- Crate rendering: wooden box 2.4×1.6×2.4 m (simple textured cube or a GLB if
  one exists in assets), deterministic yaw, riding `fftHeight + 0.5` with the
  0.12 rad roll; spawn/despawn/snapshot wiring; proximity request at 40 m with
  re-arm on exit; `salvage_collected` toast + wallet update in HUD.
- Dock repair: the shipwright menu already exists — add "Repair hull" issuing
  `combat_reset`, showing `repair_result` (charged/mercy); crew recruit already
  exists? (tavern) — ensure `crew_state` refreshes the combat store.

## Phase 5 — polish / parity sweep

- Remote muzzle rig LRU (2 rigs), light decoupling (remotes: particles only).
- Ocean cannon-flash glow term; glow layer for the fireball (bloom already
  picks up additive HDR — verify).
- Telescope/aim-camera integration if the browser gates lock UI on it (check).
- Perf pass: ball pool + particles in one instanced pipeline family; decal caps.
- Parity eyeball: side-by-side screenshots vs browser for muzzle flash, smoke,
  splash, scorch, listing angles, sink pose.

---

## New native modules

| file | contents |
|---|---|
| `src/combat_constants.hpp` | every constant above, verbatim |
| `src/combat.hpp/cpp` | CombatState store, zone math, listing/capsize/mast formulas, reload/stagger gun arrays, lock solver, ball pool sim |
| `src/cannon_fx.hpp/cpp` | particle systems, muzzle explosion + smoke billboards, flash lights, ocean glow hook |
| `shaders/muzzle_explosion.wgsl` | raymarched fireball (44/26-step variants) |
| `shaders/muzzle_smoke.wgsl` | simplex-fbm billboard smoke w/ soft depth fade |
| `shaders/particles.wgsl` | shared instanced-billboard particle shader |
| `shaders/decal.wgsl` | scorch decal (procedural char + normal pit) |
| `src/salvage_client.hpp/cpp` | crate store + rendering + collect protocol |
| `net_mp` additions | all combat/salvage message parse/emit |
| `vanim` additions | gun deploy/recoil, mast fall zones per profile |

## Testing strategy (all headless-able)

- Two admin probes (NPROBE/NPROB2 + admin teleport) broadsiding: assert
  `combat_hit`/`combat_state` round-trips, screenshot arcs/balls/FX at fixed
  frames (`SAILSIM_FIRE=port@N` style debug envs, like SAILSIM_SHEET).
- Merchant NPC aggro: fire once, verify return `cannon_shot` renders.
- Mast zone sweep via admin `/mast [hp]` command (exists server-side).
- Salvage: sink a merchant NPC, verify crate spawn/bob/collect/toast.
- Always clean weather/time overrides; scratch HOME for probe sessions.

## Deliberately deferred

- Gun crew figures working the pieces (crew impostors — separate system).
- Wake/splash hull interaction, refraction-based hull hint (client HAS_REFRACTION).
- Boarding, quests, diplomacy consequences (out of combat-visual scope).
