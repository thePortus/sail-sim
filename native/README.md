# sail-sim native client

Native, compilable client for Windows and macOS, built on **C++20 + WebGPU**.
This replaces the Angular/Babylon.js browser client; the Node server and all assets are unchanged.
See [`../PORTING.md`](../PORTING.md) for the full plan.

Current status: **Phase 0 complete on macOS; Phase 1 in progress.** A textured, PBR-lit glTF ship
floats on an animated Gerstner-wave ocean. The render loop: loads a **glTF/GLB mesh** (`cgltf`) with
its **PBR materials and KTX2/Basis textures** (base-colour, normal, metallic-roughness — decoded by
the Basis Universal transcoder), split into per-material submeshes, drawn with **metallic-roughness
Cook-Torrance shading** and tangent-space normal mapping; renders a **Gerstner ocean surface** (WGSL
vertex displacement + water shading) and **floats the ship on it** using the same wave field on the
CPU (`src/wave.hpp`) to heave + tilt the hull; **plus** the ocean-FFT `INITIAL_SPECTRUM` WGSL running
natively with a verified GPU→CPU readback (matches a CPU oracle to ~4e-6). Verified on Metal (Apple
M3 Pro): the 90k-vertex merchantman, 14 textures across 39 submeshes, floating on the sea, 0 errors.
You **sail a textured ship on the real FFT ocean.** The client's ocean-fft compute chain is ported
to native WebGPU (JONSWAP → conjugate → time evolution → 4× IFFT → merge), run as **3 cascades**
(250/17/5 m) and shaded with the client's ocean-material math (derivative normals, turbulence foam,
subsurface scatter, Fresnel). A **procedural sky** and a **planar reflection** (mirror-camera RTT of
sky + ship) complete the water. **Arrow keys / WASD** steer and trim sail; a chase camera follows,
and the ocean grid follows the ship so it sails freely. The hull's heave and tilt are driven by the
**real FFT surface** — each frame the cascade displacement textures are read back to the CPU and
sampled at the ship's position (summed cascades for height, central differences for the normal), so
the ship rides the very waves it's floating in. Screenshots via `SAILSIM_SHOT=out.png`.

You **sign in and sail online.** A **Dear ImGui** UI (Inter + Cinzel fonts) provides the login /
register screen and in-game HUD; auth is the server's JWT flow (`/user/login`, `/user/register`,
`/user/me`), with an optional **remembered session**. Gameplay runs over a **WebSocket** to the server
(`mp::Client`, IXWebSocket): it adopts your **server-authoritative vessel** from the `wallet` message
(pinnace / sloop / brig / merchantman — not assumed), streams your pose at ~10 Hz, and renders **every
remote player's ship** at their real position, each hull drawn from its own `vesselSlug`. Vessels are
loaded lazily by slug and drawn as instances of shared geometry via **dynamic uniform offsets** — one
draw per ship, so per-ship animation (cannons, masts) can be layered on later. Windows/D3D12 and the
deeper game systems (combat, economy, chat) are the road ahead.

## What this builds

`sailsim_native` opens a 1280×720 window and draws a textured, PBR-lit glTF ship floating on a
Gerstner-wave ocean. With no argument it loads the merchantman (falling back to the vendored
`assets/rock_e.glb`, then a cube, if that path isn't present). Pass a path to draw any `.glb`:

```sh
./build/bin/sailsim_native                                   # default: the merchantman
./build/bin/sailsim_native assets/rock_e.glb                 # the vendored rock
SAILSIM_MODEL=/path/to/model.glb ./build/bin/sailsim_native  # or via env
```

On launch it prints the resolved native backend and the loaded mesh, e.g. (actual output here):

```
[spike] adapter: backend=Metal  vendor=  device=Apple M3 Pro
[gltf] loaded .../assets/rock_e.glb: 70 verts, 240 indices
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
- **OpenSSL** — only for the default TLS build (`SAILSIM_TLS=ON`, so one binary speaks both `ws://`
  and `wss://`). macOS/Linux usually ship it; **Windows does not**. Either install it (below) or build
  without TLS: `-DSAILSIM_TLS=OFF` (drops the OpenSSL dependency, `ws://` only).
  - Windows via **vcpkg** (cleanest for CMake): `vcpkg install openssl:x64-windows`, then configure with
    `-DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake`.
  - Or Chocolatey `choco install openssl`, or the "Win64 OpenSSL" **full** (not "Light") dev installer.
    If CMake still can't find it, point at the install: `-DOPENSSL_ROOT_DIR="C:/Program Files/OpenSSL-Win64"`.

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

## UI fonts

The UI pairs two OFL fonts: **Inter** for body text and **Cinzel** (Roman-inscription serif caps)
for titles / the login screen. Both are **downloaded at configure time** into
`assets/fonts/UIBody.ttf` and `UITitle.ttf` — which are **git-ignored, never committed** — and then
**embedded into the binary** as byte arrays (`build/gen/ui_font_*.h`), so the app ships
self-contained with no runtime font file to locate. To use different fonts, override the URLs:

```sh
cmake -B build -DSAILSIM_FONT_BODY_URL="https://…/YourSans.ttf" \
               -DSAILSIM_FONT_TITLE_URL="https://…/YourDisplay.ttf"
```

> A **proprietary / license-restricted** font can be dropped in via the same mechanism, but must not
> be redistributed inside the compiled binary — for those, ship the TTF as a bundle **resource** and
> load it at runtime instead of embedding. The download-and-gitignore flow already keeps it out of
> the repo.

## Packaging a macOS `.app`

By default the build produces a bare Unix executable (`build/bin/sailsim_native`) so the dev/CI loop
stays simple. To build a proper Cocoa **application bundle** instead:

```sh
cmake -B build -DSAILSIM_MACOS_BUNDLE=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build build --config Release -j
open build/bin/sailsim_native.app
```

This produces `sailsim_native.app` with an `Info.plist` (from `cmake/Info.plist.in`) carrying the
bundle id (`us.theport.sailsim`), display name, version, and — importantly — `NSHighResolutionCapable`
so it renders at native Retina resolution. An app icon (`.icns`) can be added later via
`MACOSX_BUNDLE_ICON_FILE`. (Assets are still referenced by baked absolute paths for now; a
distributable build would copy them into `Contents/Resources`.)

## Cutting a Windows release (auto-update)

The client self-updates via **WinSparkle** (Windows) / **Sparkle** (macOS): each launch polls a signed
*appcast* XML and installs anything newer. Checklist to ship a new Windows build:

1. **Bump the version.** Edit `SAILSIM_VERSION` in `CMakeLists.txt` (e.g. `0.1.4` → `0.1.5`). **This is
   mandatory every release** — the updater only offers a build whose appcast version is *strictly greater*
   than the installed one. Same version = no update, ever (the single most common mistake).
2. **Build as a release** — GUI subsystem (no console window) + the real appcast feed URL baked in:
   ```bat
   cmake -S native -B native/build-win -DSAILSIM_WINDOWS_GUI=ON ^
     -DSAILSIM_SPARKLE_FEED_URL_WIN=https://sail-sim.theport.us/api/client/appcast-win.xml
   cmake --build native/build-win --config Release
   ```
3. **Verify the runtime DLLs shipped** next to the exe (the TLS build needs OpenSSL, and a clean machine
   has neither it nor the VC++ redist — the build copies both automatically):
   ```bat
   dir native\build-win\bin\Release\*.dll
   ```
   Expect `libssl-*.dll`, `libcrypto-*.dll`, `WinSparkle.dll`, `vcruntime140.dll`, `msvcp140.dll`. If the
   OpenSSL pair is missing, your install has an odd layout — copy them from your OpenSSL `bin` into the zip
   by hand. (`wgpu-native` is statically linked on Windows, so there is no WebGPU DLL.)
4. **Zip** the whole `Release` folder as `SailSim-<version>-win.zip` (exe + all the DLLs above).
5. **Publish** — signs the artifact (Ed25519, `server/.sparkle/` key) and writes `appcast-win.xml` into
   `server/assets/client/`, which the server serves at `/client`:
   ```sh
   node server/scripts/client-release.js publish --platform win --version 0.1.5 \
     --file SailSim-0.1.5-win.zip --base-url https://sail-sim.theport.us/api/client
   ```
6. **Deploy the server** so the new appcast + zip are live, then confirm the feed:
   `curl https://sail-sim.theport.us/api/client/appcast-win.xml` shows the new `<sparkle:version>`.
7. **Test:** on an already-installed client, **Settings → Check for updates** forces a check past
   WinSparkle's once-a-day throttle; watch that it not only *detects* but *applies* the zip.

Gotchas worth remembering:
- A client can only auto-update if **it already had the correct feed URL baked in.** Any build made before
  you started passing `-DSAILSIM_SPARKLE_FEED_URL_WIN=…` (or that shipped the `CHANGEME.example` default) is
  a dead end — distribute one correctly-configured build manually; updates flow from there.
- The signing **public** key in `CMakeLists.txt` (`SAILSIM_SPARKLE_PUBKEY`) must match the **private** key
  in `server/.sparkle/` (generated once via `client-release.js keygen`). Back that private key up — losing
  it breaks updates for every installed client.
- macOS releases use the same tooling with `--platform mac` against the `.app` bundle (see below).

## Troubleshooting

- **CMake 4.x: "Compatibility with CMake < 3.5 has been removed".** Add
  `-DCMAKE_POLICY_VERSION_MINIMUM=3.5` (see above).
- **Windows: `libssl-4-x64.dll` (or `vcruntime140.dll`) not found on another machine.** The release build
  copies OpenSSL + the MSVC runtime next to the exe — make sure you zipped the *whole* `Release` folder,
  not just the `.exe`. See "Cutting a Windows release" above.
- **"Could NOT find OpenSSL" (common on Windows).** The default `SAILSIM_TLS=ON` build needs OpenSSL.
  Install it (vcpkg/Chocolatey/installer — see Prerequisites) or configure with `-DSAILSIM_TLS=OFF`
  for an OpenSSL-free `ws://`-only build.
- **Switching backends doesn't take effect.** The backend selects the fetched distribution tag, so
  after changing `SAILSIM_WEBGPU_BACKEND` do a clean reconfigure: `rm -rf build && cmake -B build …`.
- **No output when piped/killed.** stdout is line-buffered on Unix and **unbuffered on Windows** (MSVCRT
  treats `_IOLBF` as full buffering, so a crash would otherwise discard a redirected log). If a redirected
  log is still empty, the process died before the first print — run without the redirect to see it live.
- **Windows: exe starts then exits / DLL not found.** With the default static wgpu build there's no
  runtime DLL. If you switch to a dynamic distribution, ensure `target_copy_webgpu_binaries` runs.

## Next steps

1. ~~Compute + readback (Phase 0 criteria 3–5).~~ **Done** — see `src/fft_test.cpp` and the PASS output above.
2. **Windows/D3D12.** Build on a Windows machine to confirm `backend=D3D12` and that the FFT test
   passes there too. The CMake WGPU path already selects the Windows zip; the static-lib system-lib
   list in `CMakeLists.txt` may need a tweak (noted inline). Then wire a GitHub Actions matrix.
3. ~~First draw + camera + depth (Phase 1).~~ **Done** — `shaders/cube.wgsl` + `createCube()` in
   `src/main.cpp` draw a spinning depth-tested cube through an MVP camera uniform.
4. ~~glTF meshes.~~ **Done** — `src/gltf_mesh.*` (cgltf) loads any `.glb`; `createMesh()` draws it
   with directional shading. Verified from a 70-vert rock to the 90k-vert merchantman.
5. ~~PBR materials + shading.~~ **Done** — `mesh.wgsl` does metallic-roughness Cook-Torrance; the
   loader reads per-primitive base-colour/metallic/roughness factors (per-vertex).
6. ~~KTX2 textures (base-colour, normal, metallic-roughness).~~ **Done** — `src/ktx2.*` (Basis
   transcoder) decodes all three map types; the fragment does tangent-space normal mapping (frame
   from screen-space derivatives, no TANGENT needed) and per-texel metallic/roughness.
7. ~~Ship on the ocean.~~ **Done** — `shaders/ocean.wgsl` (Gerstner surface) + `src/wave.hpp` (shared
   CPU wave field); the ship heaves + tilts on the waves. `createOcean()` in `src/main.cpp`.
8. ~~Real FFT ocean (Phase 2).~~ **Done (single cascade)** — `src/ocean_fft.*` ports the full compute
   chain (`CONJUGATE`, `TIME_DEPENDENT_SPECTRUM`, butterfly `FFT_*`, `WAVES_MERGER`); the surface
   samples its displacement/derivatives/turbulence (`shaders/ocean_surface.wgsl`).
9. **Multi-cascade ocean + reflections.** Add the 2nd/3rd cascades (17 m, 5 m tiles) summed in the
   surface shader to kill tiling, then planar reflection/refraction. Optionally drive buoyancy from an
   FFT displacement readback instead of Gerstner.
10. **Sailing physics + input.** Port the client's force-based vessel model so the ship sails under control.
11. **Windows/D3D12** — build + verify on Windows, wire a CI matrix.

## Layout

```
native/
  CMakeLists.txt      FetchContent deps + backend toggle + WGSL embed + the target
  src/main.cpp        device bringup + render loop (clear + camera + depth + glTF mesh); FFT test on startup
  src/gltf_mesh.*     cgltf .glb loader — positions, normals, UVs, material factors, per-material submeshes
  src/ktx2.*          Basis Universal transcoder wrapper: KTX2 (KHR_texture_basisu) -> RGBA
  src/wave.hpp        analytic Gerstner wave field (CPU) — ship buoyancy heave/tilt
  src/ocean_fft.*     FFT ocean compute cascade (spectrum -> IFFT -> displacement/derivatives/turbulence)
  src/ocean_fft_wgsl.hpp  the FFT compute kernels (verbatim from the client)
  src/fft_test.*      ocean-FFT INITIAL_SPECTRUM compute + CPU-oracle readback verification
  shaders/            WGSL: initial_spectrum, mesh (textured PBR), ocean_surface (FFT ocean); embedded
  assets/             vendored sample model (rock_e.glb) used as the default
  README.md           this file
```
