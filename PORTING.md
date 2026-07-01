# Porting the sail-sim client to a native C++ executable

Status: **planning**. This document is the living plan for replacing the Angular/Babylon.js
browser client with a native, compilable client for Windows and macOS. The Node server, the
terrain-generation pipeline, and all art/audio assets are **unchanged** — this is a rewrite of one
tier of three.

Decisions locked (2026-07-01):
- **Language:** C++17/20 (C libraries used freely where they fit).
- **Rendering:** Native WebGPU via **Dawn**, targeting D3D12 (Windows) and Metal (macOS).

---

## 1. Why native, and why this strategy

### The performance premise is sound
The renderer is already largely GPU-bound (the client runs on Babylon's `WebGPUEngine`). The real
ceiling is the **CPU / memory / scheduling envelope of the browser**:

| Browser limit today | What the native process removes |
|---|---|
| JS single main thread — sim, AI, animation, buoyancy compete with render submission | Real threads: sim/AI/streaming off the render thread |
| GC pauses (per-frame allocs in buoyancy, BOIDS, dead-reckoning) | Deterministic memory, no GC hitches |
| Heap/texture caps (~2–4 GB), tab throttling, backgrounding | Full process memory, no throttling |
| Descriptor-heap pressure we already fight (gated shadow casters, RTT budgets) | Direct control of the D3D12 / Metal device |
| Long asset loads (73 glb + KTX2 over HTTP into WASM) | mmap'd/streamed local assets, background decode |

### The key insight: the client is already a WebGPU app
The hardest, riskiest code is **WGSL** — the FFT ocean (3 cascades), GPU scatter placement,
terrain-shadow compute, procedural sky, cloud raymarch. Targeting **native WebGPU via Dawn** means
those shaders port **~1:1**, and the WebGPU architecture (render targets, compute passes, bind
groups) carries over. This turns "write a render engine" into "port a WebGPU app we already have,"
which is the single biggest risk reduction available.

Rejected alternatives: bgfx/sokol (would require translating all WGSL to another shader language,
losing WebGPU parity); from-scratch engine (re-solves graphics from zero, re-introduces solved bugs,
adds many months).

---

## 2. Native stack

| Concern | Choice | Notes |
|---|---|---|
| Window / input | GLFW or SDL3 | SDL3 if we want bundled gamepad/audio |
| GPU | **Dawn** (WebGPU) | the linchpin; reuse WGSL |
| Math | glm | |
| glTF | cgltf (+ Draco decoder) | matches the Draco TODO item |
| Textures | libktx / Basis Universal | transcode to BC7/ASTC/ETC2 as today |
| UI | **Dear ImGui** (docking) | has a native WebGPU backend |
| Audio | miniaudio | single-header; synth authored on top |
| Networking | IXWebSocket (simple) or libwebsockets | JSON via nlohmann/json or simdjson |
| Build | CMake + vcpkg | GitHub Actions matrix Win/mac |

---

## 3. Layer-by-layer port map

Difficulty: 🟢 low · 🟠 medium · 🔴 high.

| Current (Angular / TS / Babylon) | Native target | Diff | Notes |
|---|---|:--:|---|
| Babylon `WebGPUEngine` | Dawn (WebGPU) → D3D12/Metal | 🟠 | rewrite scene-graph/material wrappers; GPU concepts carry |
| WGSL compute — ocean FFT ×3, scatter placement, terrain shadow, shore map | WGSL on Dawn | 🟢 | ~1:1 port; the crown jewel |
| WGSL/GLSL shaders — ocean PBR, procedural sky, volumetric clouds, terrain triplanar, grass, muzzle FX, 8 material plugins | WGSL on Dawn | 🟠 | WGSL ports directly; GLSL-only fallbacks dropped. Babylon's plugin-injection model replaced with our own shader composition |
| Cascaded shadows, planar reflection/refraction RTTs, SSAO2, bloom, DOF, god-rays, glow, depth prepasses | hand-written passes | 🔴 | Babylon gave these free; the **long pole** of engine work |
| glTF load (73 glb, skeletal + morph) | cgltf + own skinning/morph | 🟠 | write the animation sampler Babylon provided |
| KTX2 textures | libktx / Basis | 🟢 | |
| Gerstner wave engine + buoyancy (8-wave, 8-point hull sampling) | direct C++ port | 🟢 | pure math, ports verbatim |
| Vessel physics v2 + 4 rig controllers + animation state machines | direct C++ port | 🟠 | clear logic, volume is the cost |
| Combat (zone HP, listing, dismasting, sink/capsize, ballistics, decals) | direct C++ port | 🟢 | server-authoritative; client renders + predicts |
| AI — crew stations, bird/dolphin/fish BOIDS, squadron | direct C++ port | 🟠 | |
| Terrain (heightfield decode, clipmap, harbor/town streaming, collision) | direct port + clipmap gen | 🟠 | |
| Multiplayer (WebSocket + JSON, JWT, 100 ms tick, interp/dead-reckoning) | IXWebSocket + JSON | 🟢 | **server untouched**; keep wire format identical |
| Angular UI (~30 components) | Dear ImGui | 🔴 | not hard per-widget, but ~30 screens is real volume |
| Audio (Tone.js MIDI synth + procedural WebAudio SFX, zero samples) | miniaudio + rebuilt synth | 🟠 | rebuild wavetable/FM MIDI synth + biquad/noise SFX graph |
| Angular routing / auth screens | native windows + ImGui + REST | 🟠 | store JWT locally |

**Unchanged:** the Node server (`ws` + Express + Sequelize/MySQL), terrain generation
(OpenTopography GeoTIFF → heightmaps), all art/audio/MIDI assets.

---

## 4. What must be reimplemented on the CPU (from the sim audit)

1. Wave physics — 8-wave Gerstner + hull sampling (heave/pitch/roll/speed-mod/steering-bias).
2. Vessel physics v2 — force-based sail drive, drag, heel, turn inertia, sea drag, reefing spill.
3. Animation state machines — sail furl, boom/gaff swing, rudder pose, mast-damage scrub, gun deploy/recoil.
4. Combat — zone damage, listing tilt, dismasting, sink/capsize progression.
5. Fleet AI — crew stations, bird flocks (BOIDS + takeoff/landing/bow-riding/breaching), dolphins, fish schools.
6. Terrain collision — heightfield queries for aground checks; island data.
7. Harbor logic — docking range checks, pier geometry, specialty-driven town economy.
8. Game economy — market quotes, ledger, quest progression, reputation math.
9. Crew mechanics — casualty count, repair-duration scaling, station assignment.
10. Time — server-authoritative day/night + local interpolation.

Stays on GPU (not ported to CPU): FFT ocean compute, terrain clipmap normals, refraction RTT,
scatter, and all visual FX.

---

## 5. Networking contract (must match the existing server byte-for-byte)

- Transport: WebSocket (ws/wss), JWT as `?token=` query param (browsers can't set WS headers; keep this).
- Encoding: **JSON only** (`JSON.parse` on the wire today). Close code 4401 on bad/expired token.
- Client→server: `update` every **100 ms** `{x,z,heading,speed,sailState,vesselName,vesselSlug,callsign,seq,turnRate,sheetAngle,isPortTack,anchored,anchorSide}`; ping/pong every 2 s.
- Server→client: relayed `update`, `correction` (authoritative clamp), `welcome`, `snapshot`, combat (`cannon_shot`, `combat_hit`, `combat_state`, `combat_sunk`), economy (`wallet`, `market_state`), social (`chat`, `friend_*`, `squadron_*`), quests (`quest_update`, `quest_narrative`), `salvage_*`, admin (`kick`/`ban`/`teleport`/`reload_assets`), weather/diplomacy every 5 s.
- Client-side smoothing to replicate: 110 ms interpolation delay, 12-snapshot circular buffer per
  remote, up to 1 s dead-reckoning extrapolation, reconciliation ease 0.25. Visibility radius 15 km;
  >500 m ships swap to billboard impostor + nameplate.
- REST (same JWT): `/music`, `/music/{file}`, admin endpoints, auth (login/register/update/profile).

---

## 6. Audio contract

- **Music:** Tone.js MIDI synthesis, no sample assets. Per-track `PolySynth` (32 voices) with
  timbres selected per instrument family (bass/brass/strings/organ/guitar/pipe/lead/pad/piano),
  shared reverb (decay 3.5 s, wet 0.35), 300 ms lookahead, auto-advance. Rebuild as a native
  wavetable/FM synth over miniaudio + a MIDI note-event scheduler.
- **SFX (all synthesized):** ocean ambience (brown+white noise → biquad filters → LFO swell),
  sail flaps (noise bursts, bandpass, event-timed by wind + sail state), ship's bell (6 inharmonic
  partials + metallic transient, on 6-hour game marks). Port the Web Audio graphs to miniaudio DSP.
- No spatialization today (stereo bed) — a native rewrite is a chance to add positional audio cheaply.

---

## 7. Phased roadmap (ordered to de-risk first)

- **Phase 0 — Spike.** Prove the WGSL/Dawn thesis. (Detailed below.)
- **Phase 1 — Engine spine.** Scene graph, camera, glTF + PBR + skeletal/morph, cascaded shadows,
  main pipeline (bloom/FXAA/tonemap). One ship on a plane, animating, shadowed.
- **Phase 2 — Ocean.** Port 3-cascade FFT compute + ocean PBR material + Gerstner buoyancy. Ship floats/heaves.
- **Phase 3 — Sim & control.** Physics v2, 4 rig controllers, animation state machines, input. Sail one ship offline.
- **Phase 4 — World.** Terrain clipmap + PBR, GPU scatter, harbors/towns, sky, clouds.
- **Phase 5 — Multiplayer.** WS client, JSON protocol, JWT, interp/dead-reckoning, remote ships +
  impostor LOD. Connects to the **existing, unmodified server**.
- **Phase 6 — Combat + AI.** Ballistics, zone damage, dismasting/sinking, crew, birds/dolphins/fish.
- **Phase 7 — UI + audio.** ImGui HUD/minimap/chat/menus, then synth/SFX. Stubbed (console HUD,
  silence) through phases 1–6 so it stays off the critical path.
- **Phase 8 — Polish & ship.** SSAO2/DOF/god-rays, installers, code-signing (Win + notarized mac), auto-update.

---

## 8. Phase 0 spike — concrete task breakdown

Goal: **prove that our existing WGSL runs on Dawn on both platforms with a correct GPU→CPU
readback**, before committing to the full port. If this is painful, we rethink the approach.

Exit criteria (all must hold):
1. A Dawn-backed window opens and clears to a color on Windows (D3D12) and macOS (Metal).
2. One existing WGSL **compute** shader — the ocean FFT `INITIAL_SPECTRUM` pass from
   `client/src/app/sailing/services/ocean-fft/wgsl.ts` — compiles under Dawn unmodified (or with a
   documented, minimal diff).
3. It dispatches over an 8×8 workgroup grid, writes a storage texture, and we **read the result
   back to CPU** and print a few texel values that match the browser's output for the same inputs.
4. One trivial render pass draws a textured full-screen triangle sampling that texture.
5. CI builds the spike on a Windows and a macOS runner.

Tasks:
1. **Scaffold** — CMake project, vcpkg manifest, fetch Dawn + GLFW. Win/mac toolchain notes in the
   README. (~0.5 wk)
2. **Device bringup** — instance/adapter/device request, surface config, swapchain, clear-color
   render loop on both OSes. Wire Dawn's error/device-lost callbacks to logging early. (~0.5 wk)
3. **Extract the reference** — pull `INITIAL_SPECTRUM_WGSL` and its uniform layout out of
   `wgsl.ts`; capture the exact inputs and a few expected output texels from the running browser
   client for a fixed seed (the oracle). (~0.5 wk)
4. **Compute path** — create the shader module, bind group layout (uniform params + storage
   textures), pipeline; dispatch; copy storage texture → buffer → map → CPU. Diff against the
   oracle within float tolerance. This is where Dawn's stricter validation vs. browsers will surface
   — budget debugging time here. (~1 wk)
5. **Draw path** — sampled full-screen triangle to visualize the texture; confirms the render +
   sampler + bind-group basics. (~0.5 wk)
6. **CI** — GitHub Actions matrix (windows-latest, macos-latest) building the spike; artifact the
   binaries. (~0.5 wk)

Estimated spike: **~3–4 weeks**. Deliverable: a written go/no-go with the validation diff and any
WGSL changes Dawn required.

**Scaffold:** tasks 1–2 (device bringup + clear-colour loop) are scaffolded in
[`native/`](native/) — CMake + FetchContent (Dawn via WebGPU-distribution, GLFW, glfw3webgpu) and a
commented `src/main.cpp`. Tasks 3–4 (the compute + readback) have a concrete binding-level recipe in
[`native/shaders/README.md`](native/shaders/README.md). See [`native/README.md`](native/README.md)
to build.

---

## 9. Effort & risk

- Renderer to parity alone: **~4–6 months** (one strong graphics engineer).
- Full client (sim + UI + audio): realistically **~9–15 months solo**; faster with a small team or
  by trimming effects. Dawn/WebGPU is what keeps this from being worse.

Top risks:
1. **Babylon did a lot invisibly** — material-plugin injection, prepass/G-buffer wiring, RTT
   management. Re-authoring these passes is a bigger job than porting the shaders.
2. **WGSL parity isn't total** — Dawn is stricter than browsers on some validation; expect a
   debugging tail on the compute shaders (Phase 0 flushes this out).
3. **UI volume** — ~30 screens in ImGui is weeks of unglamorous work; easy to underestimate.
4. **"Keep all features" vs. scope** — every effect (god-rays, SSAO, grain, rain-lens) is separately
   re-earned. Rank effects by gameplay value up front so the last 20% doesn't eat half the schedule.
