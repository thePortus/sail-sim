# sail-sim native client

Native, compilable client for Windows and macOS, built on **C++20 + Dawn (WebGPU)**.
This replaces the Angular/Babylon.js browser client; the Node server and all assets are unchanged.
See [`../PORTING.md`](../PORTING.md) for the full plan.

Current status: **Phase 0 spike** — Dawn device bringup + clear-colour render loop.

## What this builds

`sailsim_native` opens a 1280×720 window and clears it to sea-blue every frame using a real Dawn
WebGPU device. On launch it prints the resolved native backend, e.g.:

```
[spike] adapter: backend=Metal  vendor=Apple  device=Apple M-series
[spike] surface configured: 2560x1440 format=... — entering render loop
```

Seeing `backend=D3D12` on Windows or `backend=Metal` on macOS satisfies Phase 0 exit criteria 1–2.

## Prerequisites

- **CMake ≥ 3.24** and a C++20 compiler
  - Windows: Visual Studio 2022 (MSVC)
  - macOS: Xcode command-line tools (Apple Clang)
- **Git** (dependencies are fetched at configure time)
- A working network connection for the **first** configure — CMake downloads and builds Dawn, which
  is large and takes a while (10–30+ min the first time; cached afterwards).

Dependencies are pulled via CMake `FetchContent`, so there is nothing to install by hand:
`glfw` (windowing), `WebGPU-distribution` (Dawn), `glfw3webgpu` (per-OS surface creation).

## Build & run

```sh
cd native
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
./build/bin/sailsim_native          # macOS/Linux
# build\bin\Release\sailsim_native.exe   # Windows
```

## Troubleshooting

- **Configure fails on the `webgpu` GIT_TAG.** The upstream distribution uses a moving branch for
  Dawn. Open `CMakeLists.txt` and set the `webgpu` `GIT_TAG` to one of `dawn`, `main`, or `wgpu`
  (checked against https://github.com/eliemichel/WebGPU-distribution).
- **Compile error on `depthSlice` or a surface-status enum.** These are the two known
  version-sensitive spots in `src/main.cpp`. If your fetched `webgpu.h` predates the `depthSlice`
  field, delete that one line. The surface fetch already avoids enum-name churn by null-checking
  `surfaceTex.texture` instead of comparing the status enum.
- **`requestAdapter did not resolve synchronously`.** A newer header made the request truly async;
  pump `wgpuInstanceProcessEvents(instance)` in a loop inside the request helpers until `done`.
- **Windows: exe starts then exits / DLL not found.** Ensure `target_copy_webgpu_binaries` ran
  (it copies `webgpu_dawn.dll` next to the exe). Rebuild if you moved the binary.

### vcpkg alternative

If you'd rather manage Dawn through vcpkg, add a `vcpkg.json` manifest with the `dawn` dependency
and replace the `webgpu` + `glfw3webgpu` FetchContent blocks with `find_package(dawn CONFIG REQUIRED)`
(and your own surface-creation shim). It's more work to get green on both OSes, which is why the
spike defaults to FetchContent.

## Next steps (Phase 0 → Phase 1)

1. **Compute + readback (Phase 0 exit criteria 3–5).** Port the ocean-FFT `INITIAL_SPECTRUM` WGSL
   from `../client/src/app/sailing/services/ocean-fft/wgsl.ts` into `shaders/`, dispatch it over an
   8×8 workgroup grid, copy the storage texture to a buffer, map it, and diff a few texels against
   the browser output for a fixed seed. This is the real proof that our WGSL survives the port.
2. **First draw (Phase 1).** Add a pipeline + vertex/fragment WGSL and draw a triangle in the render
   pass where the comment marks it.
3. **glTF + PBR + shadows**, then the ocean — see `../PORTING.md` §7.

## Layout

```
native/
  CMakeLists.txt      FetchContent deps + the sailsim_native target
  src/main.cpp        device bringup + clear-colour loop
  shaders/            WGSL lives here as we port it (see shaders/README.md)
  README.md           this file
```
