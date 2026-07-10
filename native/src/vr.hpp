// ── VR bridge (OpenXR ⇄ Dawn-D3D12) ──────────────────────────────────────────
//
// The proven P0 bridge, extracted from src/vr_spike.cpp so both the spike and the
// game can drive it. Windows + Dawn only (VR needs the D3D12 OpenXR binding and
// Dawn's ID3D12Device). On any other build this header is inert.
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

#if defined(_WIN32) && defined(WEBGPU_BACKEND_DAWN)

#include <cstdint>
#include <webgpu/webgpu.h>

namespace vr {

struct Bridge;   // opaque; defined in vr.cpp

// Create the OpenXR session on the app's Dawn device (extracts its ID3D12Device). Returns null if
// there's no active runtime / HMD, the device lacks the shared-handle feature, or setup fails.
Bridge* create(WGPUInstance instance, WGPUDevice device);
void    destroy(Bridge* b);

// Drain the OpenXR event queue. `running` = between xrBeginSession/xrEndSession (render when true);
// `exitRequested` = the runtime asked us to quit.
void poll(Bridge* b, bool& running, bool& exitRequested);

// Pace to the compositor and locate the eyes. Returns true if this frame should be rendered
// (false → still call endFrame, which submits an empty frame). Opens shared-texture access per eye.
bool beginFrame(Bridge* b);

int             eyeCount(Bridge* b);
WGPUTextureView eyeTarget(Bridge* b, int eye);      // render the eye here (valid between begin/endFrame)
uint32_t        eyeWidth(Bridge* b, int eye);
uint32_t        eyeHeight(Bridge* b, int eye);

// HMD pose + asymmetric FOV for `eye` this frame. pose7 = {px,py,pz, qx,qy,qz,qw}; fov4 =
// {angleLeft, angleRight, angleUp, angleDown} in radians (left/down are negative).
void eyeCamera(Bridge* b, int eye, float pose7[7], float fov4[4]);

// Close each eye's access, copy the rendered RT into the acquired XR image, and submit the frame.
void endFrame(Bridge* b);

}  // namespace vr

#endif  // _WIN32 && WEBGPU_BACKEND_DAWN
