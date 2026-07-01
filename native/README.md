# sail-sim native client

Native, compilable client for Windows and macOS, built on **C++20 + WebGPU**.
This replaces the Angular/Babylon.js browser client; the Node server and all assets are unchanged.
See [`../PORTING.md`](../PORTING.md) for the full plan.

Current status: **Phase 0 complete on macOS; Phase 1 started.** WebGPU device bringup, a render loop
that clears to sea-blue and draws a first triangle through a real render pipeline + vertex buffer,
**and** the ocean-FFT `INITIAL_SPECTRUM` WGSL running natively with a verified GPU→CPU readback
(matches a CPU oracle to ~4e-6). Verified on Metal (Apple M3 Pro). Windows/D3D12 pending a Windows
machine.

## What this builds

`sailsim_native` opens a 1280×720 window, clears it to sea-blue, and draws a vertex-coloured triangle
every frame using a real WebGPU device. On launch it prints the resolved native backend, e.g. (actual
output on this machine):

```
[spike] adapter: backend=Metal  vendor=  device=Apple M3 Pro
[spike] surface configured: 2560x1440 format=24 — entering render loop
[spike] render loop exited after 120 frames — tearing down cleanly
```

Seeing `backend=Metal` on macOS (or `backend=D3D12` on Windows) satisfies Phase 0 exit criteria 1–2.

It also runs the ocean-FFT compute + readback test (criteria 3–5) on startup:

```
[fft-test] WavesData: PASS — 0/65536 components mismatched, max abs err 3.81e-06
[fft-test] H0K: PASS — 0 non-finite, 32766 non-zero of 32768
[fft-test] RESULT: PASS — WGSL runs natively and reads back correctly
```

`WavesData` (k-vector, 1/‖k‖, ω) is deterministic from the params, so the test diffs the GPU output
against a CPU reimplementation of the same formula — a self-contained oracle, no browser capture
needed. Run it headless (no window, exits 0/1) with `SAILSIM_FFT_ONLY=1 ./build/bin/sailsim_native`.

## WebGPU backend: wgpu-native (default) vs Dawn

Both Dawn and wgpu-native implement the same `webgpu.h` C API and run the same WGSL natively on
Metal / D3D12 / Vulkan — so the "our WGSL ports 1:1" thesis is validated by either. The spike
defaults to **wgpu-native (prebuilt)** because it links in seconds:

```sh
cmake -B build -DSAILSIM_WEBGPU_BACKEND=WGPU   # default — official prebuilt, fast
cmake -B build -DSAILSIM_WEBGPU_BACKEND=DAWN   # Google's Dawn, built from source
```

The WGPU path fetches wgpu-native's **official release zip** (`gfx-rs/wgpu-native` v0.19.4.1),
per-platform, and defines the `webgpu` target from the header + lib in that same zip.

> **Why upstream and not a redistribution:** we first used `eliemichel/WebGPU-distribution`
> (`wgpu-static-v0.19.4.1`) but its bundled `webgpu.h` had `WGPUTextureFormat` enum values out of
> sync with the lib it shipped — the header's `RGBA32Float` (0x23) was `RGBA32Uint` to the lib, which
> silently corrupts every texture format. Fetching the upstream release guarantees the header and lib
> come from the same build. (glfw3webgpu is still used, only for its per-OS surface creation.)

> **Dawn from source is not yet green on Apple Silicon.** Building `dawn-6512` through CMake 4.x
> pulls Dawn's vendored fuzzers (`libprotobuf-mutator`) and hits an abseil `-msse4.1` flag on arm64.
> A build-config task, tracked as a follow-up. The production Dawn-vs-wgpu decision stays open; the
> spike proves the WebGPU/WGSL path regardless of which backs it.

## Prerequisites

- **CMake ≥ 3.24** and a C++20 compiler
  - macOS: Xcode command-line tools (Apple Clang) — verified with Apple clang 17
  - Windows: Visual Studio 2022 (MSVC)
- **Git** and a network connection for the first configure (deps are fetched via `FetchContent`:
  `glfw`, the WebGPU distribution + prebuilt wgpu-native lib, `glfw3webgpu`).

The default (wgpu) build is fast — no large source build. (The Dawn build is the slow one.)

## Build & run

```sh
cd native
cmake -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build build --config Release -j

# interactive window (close it to quit):
./build/bin/sailsim_native

# headless smoke test — render 120 frames then exit 0 (good for CI):
SAILSIM_MAX_FRAMES=120 ./build/bin/sailsim_native
```

`-DCMAKE_POLICY_VERSION_MINIMUM=3.5` is required with CMake 4.x: some fetched subprojects declare a
`cmake_minimum_required` below 3.5, which CMake 4 rejects without this shim.

## Troubleshooting

- **CMake 4.x: "Compatibility with CMake < 3.5 has been removed".** Add
  `-DCMAKE_POLICY_VERSION_MINIMUM=3.5` (see above).
- **Switching backends doesn't take effect.** The backend selects the fetched distribution tag, so
  after changing `SAILSIM_WEBGPU_BACKEND` do a clean reconfigure: `rm -rf build && cmake -B build …`.
- **No output when piped/killed.** Fixed in-tree by line-buffering stdout; if you still see nothing,
  the window failed to open — run without a frame cap to see the GLFW/adapter error.
- **Windows: exe starts then exits / DLL not found.** With the default static wgpu build there's no
  runtime DLL. If you switch to a dynamic distribution, ensure `target_copy_webgpu_binaries` runs.

## Next steps

1. ~~Compute + readback (Phase 0 criteria 3–5).~~ **Done** — see `src/fft_test.cpp` and the PASS output above.
2. **Windows/D3D12.** Build on a Windows machine to confirm `backend=D3D12` and that the FFT test
   passes there too. The CMake WGPU path already selects the Windows zip; the static-lib system-lib
   list in `CMakeLists.txt` may need a tweak (noted inline). Then wire a GitHub Actions matrix.
3. ~~First draw (Phase 1).~~ **Done** — `shaders/triangle.wgsl` + `createTriangle()` in
   `src/main.cpp` draw a vertex-coloured triangle through a real render pipeline.
4. **Phase 1 proper.** A camera (uniform buffer + MVP), a depth buffer, then glTF mesh loading +
   PBR + cascaded shadows — one ship on a plane. See `../PORTING.md` §7.
5. **Rest of the FFT chain (Phase 2).** Port `CONJUGATE`, `TIME_DEPENDENT_SPECTRUM`, the butterfly
   `FFT_*` passes and `WAVES_MERGER` on top of the readback harness already in `src/fft_test.cpp`.

## Layout

```
native/
  CMakeLists.txt      FetchContent deps + backend toggle + WGSL embed + the target
  src/main.cpp        device bringup + render loop (clear + triangle); runs the FFT test on startup
  src/fft_test.*      ocean-FFT INITIAL_SPECTRUM compute + CPU-oracle readback verification
  shaders/            WGSL: initial_spectrum.wgsl (from the client) + triangle.wgsl; embedded at build time
  README.md           this file
```
