// ── VR bridge (OpenXR ⇄ Dawn-D3D12) ──────────────────────────────────────────
//
// The proven P0 bridge, extracted from src/vr_spike.cpp so both the spike and the
// game can drive it. The REAL implementation (vr.cpp, SAILSIM_VR_REAL) is Windows +
// Dawn only (VR needs the D3D12 OpenXR binding and Dawn's ID3D12Device); every other
// build gets inert stubs — headsetPresent() is false and create() is null, so the
// game's VR code paths compile (and are exercised by the compiler) on every platform
// but can never activate off Windows.
//
// Lifecycle (per frame):
//   vr::poll(b, running, exit);              // session state machine
//   if (running && vr::beginFrame(b)) {      // xrWaitFrame/BeginFrame/LocateViews + open access
//     for (int e = 0; e < vr::eyeCount(b); ++e) {
//       vr::eyeCamera(b, e, pose, fov);      // build view/proj from the HMD pose + asymmetric FOV
//       // ... render the scene into vr::eyeTarget(b, e) (a Dawn sRGB texture view) ...
//     }
//   }
//   vr::endFrame(b);                         // close access, copy each eye into the XR image, submit
//
// The app supplies the Dawn device (which MUST enable the SharedTextureMemoryDXGISharedHandle
// feature) and does all rendering; the bridge owns the OpenXR + shared-texture plumbing.

#pragma once

#include <cstdint>
#include <webgpu/webgpu.h>

namespace vr {

struct Bridge;   // opaque; defined in vr.cpp

// Lightweight headset probe: a throwaway XrInstance + xrGetSystem(HMD), no session, no
// graphics binding. Safe to call repeatedly (e.g. every few seconds from a worker thread)
// to light up an "enter VR" button when a headset/runtime appears. False when there is no
// active OpenXR runtime, no HMD, or on stub builds.
bool headsetPresent();

// Create the OpenXR session on the app's Dawn device (extracts its ID3D12Device). Returns null if
// there's no active runtime / HMD, the device lacks the shared-handle feature, or setup fails.
Bridge* create(WGPUInstance instance, WGPUDevice device);
void    destroy(Bridge* b);

// Drain the OpenXR event queue. `running` = between xrBeginSession/xrEndSession (render when true);
// `exitRequested` = the runtime asked us to quit.
void poll(Bridge* b, bool& running, bool& exitRequested);

// True once the Dawn/D3D12 device is lost (BeginAccess failed with a dead device). Unrecoverable:
// the app should log, destroy the bridge (clean xrDestroySession so the runtime releases), and exit
// instead of spinning on a dead session (which wedges Virtual Desktop until a reboot).
bool lost(Bridge* b);

// Pace to the compositor and locate the eyes. Returns true if this frame should be rendered
// (false → still call endFrame, which submits an empty frame). Opens shared-texture access per eye.
bool beginFrame(Bridge* b);

int             eyeCount(Bridge* b);
WGPUTextureView eyeTarget(Bridge* b, int eye);      // render the eye here (valid between begin/endFrame)
uint32_t        eyeWidth(Bridge* b, int eye);
uint32_t        eyeHeight(Bridge* b, int eye);
WGPUTextureFormat eyeFormat(Bridge* b);             // the eye texture's wgpu format (for matching pipelines)

// HMD pose + asymmetric FOV for `eye` this frame. pose7 = {px,py,pz, qx,qy,qz,qw}; fov4 =
// {angleLeft, angleRight, angleUp, angleDown} in radians (left/down are negative).
void eyeCamera(Bridge* b, int eye, float pose7[7], float fov4[4]);

// MONO bring-up only: the aspect (w/h) of the flat frame the app blits into both eyes. When set
// (>0), the composition layer uses an aspect-matched symmetric FOV so the image isn't squashed by
// the eye texture's different shape. Remove with the mono path once true stereo rendering lands.
void setMonoLayerAspect(Bridge* b, float aspect);

// STEREO: the app rendered this eye with a symmetric frustum of these half-angles (radians).
// The composition layer must submit exactly the rendered FOV; when set (per frame), it overrides
// both the eye's native asymmetric FOV and the mono-aspect hack, and the eye's REAL pose is used.
void setEyeSubmitFov(Bridge* b, int eye, float halfW, float halfH);

// Close each eye's access, copy the rendered RT into the acquired XR image, and submit the frame.
void endFrame(Bridge* b);

}  // namespace vr
