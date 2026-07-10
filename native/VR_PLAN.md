# Native VR plan — head-tracked stereo projection via OpenXR

Goal: render the native client in **head-tracked stereo** to a PC-VR headset,
working with **any active OpenXR runtime** — Meta Link/Air Link, Virtual Desktop
(VDXR), SteamVR, ALVR, WMR — with **no code that special-cases any of them**.

**Explicit scope decisions (from the design chat):**
- **No VR controllers.** Keyboard + mouse stay exactly as they are and remain the
  only input. We use OpenXR for *head pose only* — the entire action/input system
  is skipped. You sail with WASD/mouse and physically look around with your head.
- **Windows-only.** OpenXR is effectively unavailable on macOS; the Mac build keeps
  shipping flat. VR is a Windows feature gated behind a flag/backend.
- **Dawn backend only for VR.** See §2 — this is not optional.

---

## 1. Why "one OpenXR app" covers Link *and* Desktop Streamers

Meta Link, Virtual Desktop, and SteamVR are not three integrations — they are three
**OpenXR runtimes**. Link exposes the Oculus OpenXR runtime; Virtual Desktop exposes
VDXR (or routes through SteamVR); ALVR/WMR go through SteamVR. A single well-behaved
OpenXR app binds to whichever runtime the user has set active. We enumerate/`xrCreateInstance`
and render; the user's choice of streamer is invisible to us. This is the entire
answer to "work via Link and via Desktop Streamer apps."

## 2. The hard part: WebGPU has no OpenXR binding

OpenXR hands us a swapchain of **native** textures (D3D11/D3D12/Vulkan `VkImage`) and
expects eye images rendered into them. OpenXR's graphics bindings are
`XR_KHR_D3D11_enable` / `XR_KHR_D3D12_enable` / `XR_KHR_vulkan_enable2` /
`XR_KHR_opengl_enable`. **There is no WebGPU binding.** So we must bridge our
WebGPU-rendered frame into OpenXR's native swapchain.

- **Readback+upload per eye is a non-starter** (two ~2K textures at 90 Hz).
- We need **zero-copy shared textures**, and that is exactly where **Dawn** beats
  wgpu-native: Dawn exposes `wgpu::SharedTextureMemory` + `wgpu::SharedFence` (import a
  D3D11/D3D12 texture as a WebGPU texture, sync via a shared fence) and lets us reach its
  underlying `ID3D12Device`. wgpu-native's interop is immature and would fight us.

**Decision:** the VR build is `SAILSIM_WEBGPU_BACKEND=DAWN` on Windows (D3D12). We render
each eye into an OpenXR D3D12 swapchain image imported into Dawn as a shared texture.

**Two viable bindings, pick during the P0 spike:**
- **(A) D3D12 binding, shared device** — create the XR session with
  `XR_KHR_D3D12_enable` using Dawn's own `ID3D12Device` + queue (via `dawn::native::d3d12`).
  Import the XR swapchain's `ID3D12Resource`s as `SharedTextureMemory`. Truly zero-copy,
  one device. Preferred if Dawn will surrender its device/queue cleanly.
- **(B) D3D11 binding, cross-API share** — XR session on a D3D11 device (simplest XR
  binding), Dawn on D3D12, share via DXGI shared NT handle + keyed-mutex, imported as
  `SharedTextureMemory`. More plumbing, but D3D11 is the least fussy XR binding and the
  D3D11↔D3D12 share path is well-trodden. Fallback if (A) is awkward.

## 3. Engine changes (grounded in the current code)

Today `main.cpp` is a single-view engine: one frame loop (`while (!glfwWindowShouldClose)`
~`main.cpp:4285`), one `viewProj`, an HDR scene target, then `wgpuSurfacePresent` (~`main.cpp:9968`).

1. **Frame-loop restructure (medium).** In VR mode the loop is paced by OpenXR:
   `xrWaitFrame` → `xrBeginFrame` → `xrLocateViews` → **run the full render pipeline twice**
   (one eye each, into that eye's XR swapchain image) → `xrEndFrame` with a projection
   composition layer. The GLFW window becomes a cheap **mirror** (blit one eye).

2. **Per-eye camera (medium).** OpenXR gives a pose + an **asymmetric FOV** per eye:
   `viewProj = projFromXrFov(fov) · inverse(worldEye)`.
   ⚠️ **The X-mirrored projection hack** (`proj[0][0] = -proj[0][0]`, the glTF-handedness
   workaround around `main.cpp:7558`) must be re-derived per eye — applied naively it can
   **swap left/right eyes** or **flip winding so everything backface-culls**. Budget a day
   for getting handedness/winding/eye-order correct against the asymmetric frustum.

3. **Head pose ∘ keyboard/mouse (small) — the core ask.** Game camera stays 100% k/m driven
   (position, heading, orbit). HMD pose composites *on top*:
   `worldEye = gameCamera ∘ headPose ∘ eyeOffset`. Seated `LOCAL` reference space + a
   "recenter" key.

4. **HUD / ImGui in VR (medium).** A 2D overlay on the eye framebuffer sits at infinity and
   is nauseating. MVP: render ImGui to a texture and composite it as an OpenXR **quad layer**
   (or in-world billboard) parked slightly below center like a cockpit HUD. Complex menus
   (inventory/settings) stay on the flat mirror or pause immersive rendering. No controllers ⇒
   the in-VR HUD is display-only; interaction remains mouse-on-mirror.

5. **Performance / VR quality tier (ongoing).** The renderer is heavy (TAA, godrays,
   volumetrics, puddle SSR, dense scatter, cannon FX). VR wants **2 eyes × ~2K × 72–90 Hz**
   stable, plus streaming encode latency on Air Link/VD. Expect a dedicated tier:
   - Let the compositor do reprojection; **drop or heavily simplify TAA** (per-eye history +
     reprojection fights the runtime's ASW).
   - Scale down volumetrics/godrays/scatter density.
   - **Fixed-foveated rendering** (`XR_FB_foveation` / `XR_META_foveation_eye_tracked`) +
     dynamic resolution.

## 4. Phasing

| Phase | Deliverable | Risk |
|---|---|---|
| **P0 — Spike (throwaway)** | Dawn build + OpenXR loader; a session that submits a **solid-color stereo layer** via a Dawn-shared XR swapchain, visible in-headset. Proves the bridge (§2). | **This is the whole risk. Retire it first.** |
| P1 | Full scene rendered per-eye into XR swapchains; GLFW window as mirror | Medium |
| P2 | Head pose ∘ k/m camera; reference space + recenter | Low |
| P3 | HUD-in-VR (head-locked quad layer) | Medium |
| P4 | VR quality tier: foveation, dynamic res, effect scaling | Medium, ongoing |
| P5 | Comfort/polish: IPD from XR, seated origin, menu handling, `--vr` flag / auto-detect | Low |

## 5. P0 spike — concrete checklist

**CMake / deps**
- Force `SAILSIM_WEBGPU_BACKEND=DAWN` for the VR target (guard VR code behind a `SAILSIM_VR`
  CMake option, Windows-only).
- Fetch the **OpenXR loader** (`KhronosGroup/OpenXR-SDK`, `FetchContent`) — provides
  `openxr_loader` + headers. Define `XR_USE_GRAPHICS_API_D3D12` (or `_D3D11`) and
  `XR_USE_PLATFORM_WIN32` before `<openxr/openxr_platform.h>`.

**OpenXR bring-up (new `src/vr.cpp` / `vr.hpp`)**
- `xrCreateInstance` (enable `XR_KHR_D3D12_enable`, optionally foveation exts) → `xrGetSystem`
  (`FORM_FACTOR_HEAD_MOUNTED_DISPLAY`).
- `xrGetD3D12GraphicsRequirementsKHR` → confirm the adapter LUID matches Dawn's D3D12 adapter
  (this is the interop pivot — Dawn must be on the XR-required adapter).
- `xrCreateSession` with `XrGraphicsBindingD3D12KHR { device = Dawn's ID3D12Device, queue = Dawn's queue }`.
- `xrCreateReferenceSpace` (`LOCAL`), `xrEnumerateViewConfigurationViews` (stereo, 2 views).
- Per eye: `xrCreateSwapchain` (color, `DXGI_FORMAT_R8G8B8A8_UNORM_SRGB` or `R16G16B16A16_FLOAT`),
  `xrEnumerateSwapchainImages` → `ID3D12Resource[]`.

**Dawn bridge**
- Import each XR swapchain `ID3D12Resource` via `wgpu::SharedTextureMemory`
  (`SharedTextureMemoryD3D12ResourceDescriptor`), create a `wgpu::Texture` view per image.
- Each frame per eye: `xrAcquireSwapchainImage`/`WaitSwapchainImage` → `BeginAccess`
  (SharedTextureMemory, wait fence) → render → `EndAccess` (signal fence) → `xrReleaseSwapchainImage`.

**Frame loop (spike)**
- `xrPollEvent` (session state machine: `READY`→`xrBeginSession`, `STOPPING`→`xrEndSession`).
- `xrWaitFrame`/`xrBeginFrame` → `xrLocateViews` → clear each eye to a distinct solid color →
  `xrEndFrame` with one `XrCompositionLayerProjection` (2 views).
- **Exit criteria:** two solid-color eyes visible and head-stable in the headset over Link
  **and** Virtual Desktop. If green, the architecture is proven end-to-end.

## 6. Open questions to resolve in P0/P1
- Can Dawn hand us its `ID3D12Device`/queue on the **XR-required adapter**, or must we force
  Dawn's adapter selection to the XR LUID? (Drives binding A vs B.)
- HDR: our scene target is RGBA16F; XR swapchains are typically 8-bit sRGB. Where does tonemap
  land per eye — reuse the existing post pass writing into the (sRGB) XR image.
- Mirror window cost — blit one eye vs. a cheap third "spectator" view.
- Menu UX without controllers: head-locked quad for HUD; drop to mirror for deep menus.

---

*Related: `native-graphics-upgrade-roadmap` (perf/temporal work this shares budget with),
the X-mirrored-projection handedness convention in `main.cpp`, and the Dawn/wgpu backend
switch in `CMakeLists.txt` (§111 `SAILSIM_WEBGPU_BACKEND`).*
