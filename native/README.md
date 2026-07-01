# sail-sim native client

Native, compilable client for Windows and macOS, built on **C++20 + WebGPU**.
This replaces the Angular/Babylon.js browser client; the Node server and all assets are unchanged.
See [`../PORTING.md`](../PORTING.md) for the full plan.

Current status: **Phase 0 spike** — WebGPU device bringup + clear-colour render loop.
Verified running on macOS (Metal, Apple M3 Pro): opens a window, renders, exits cleanly.

## What this builds

`sailsim_native` opens a 1280×720 window and clears it to sea-blue every frame using a real WebGPU
device. On launch it prints the resolved native backend, e.g. (actual output on this machine):

```
[spike] adapter: backend=Metal  vendor=  device=Apple M3 Pro
[spike] surface configured: 2560x1440 format=24 — entering render loop
[spike] render loop exited after 120 frames — tearing down cleanly
```

Seeing `backend=Metal` on macOS (or `backend=D3D12` on Windows) satisfies Phase 0 exit criteria 1–2.

## WebGPU backend: wgpu-native (default) vs Dawn

Both Dawn and wgpu-native implement the same `webgpu.h` C API and run the same WGSL natively on
Metal / D3D12 / Vulkan — so the "our WGSL ports 1:1" thesis is validated by either. The spike
defaults to **wgpu-native (prebuilt)** because it links in seconds:

```sh
cmake -B build -DSAILSIM_WEBGPU_BACKEND=WGPU   # default — prebuilt, fast
cmake -B build -DSAILSIM_WEBGPU_BACKEND=DAWN   # Google's Dawn, built from source
```

> **Dawn from source is not yet green on Apple Silicon.** Building `dawn-6512` through CMake 4.x
> pulls Dawn's vendored fuzzers (`libprotobuf-mutator`, which wants generated protobuf headers that
> aren't present) and hits an abseil `-msse4.1` flag on arm64. Resolving that is a build-config task,
> not a code task — tracked as a follow-up. The production Dawn-vs-wgpu decision (see PORTING.md)
> stays open; the spike proves the WebGPU/WGSL path regardless of which backs it.

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

## Next steps (Phase 0 → Phase 1)

1. **Compute + readback (Phase 0 exit criteria 3–5).** Port the ocean-FFT `INITIAL_SPECTRUM` WGSL
   from `../client/src/app/sailing/services/ocean-fft/wgsl.ts` into `shaders/`, dispatch it, copy the
   storage texture to a buffer, map it, and diff a few texels against the browser output for a fixed
   seed. See [`shaders/README.md`](shaders/README.md) for the exact binding layout. This is the real
   proof that our WGSL survives the port.
2. **First draw (Phase 1).** Add a pipeline + vertex/fragment WGSL and draw a triangle where the
   comment marks it in `src/main.cpp`.
3. **glTF + PBR + shadows**, then the ocean — see `../PORTING.md` §7.
4. **Windows/D3D12 + CI.** Build on a Windows runner to confirm `backend=D3D12`, then wire the
   GitHub Actions matrix (Phase 0 task 6).

## Layout

```
native/
  CMakeLists.txt      FetchContent deps + backend toggle + the sailsim_native target
  src/main.cpp        device bringup + clear-colour loop (headless frame cap via SAILSIM_MAX_FRAMES)
  shaders/            WGSL lives here as we port it (see shaders/README.md)
  README.md           this file
```
