// ── OpenXR D3D12 render spike (VR P0.1) — now a thin harness over the vr module ──
//
// The proven bridge lives in vr.cpp/vr.hpp (so the game can share it). This spike is
// just a test app: make a Dawn device, drive vr::, and clear each eye to a pulsing
// solid colour. It builds fast (no game) so the module can be validated in-headset
// before folding it into sailsim_native. Windows + Dawn only.
//
// Build:  cmake --build build-win-vr --target sailsim_vr_spike --config Release
// Run:    build-win-vr\bin\Release\sailsim_vr_spike.exe   (Link / Virtual Desktop active, headset on)

#include <cstdio>

#if defined(_WIN32) && defined(WEBGPU_BACKEND_DAWN)

#include <windows.h>
#include <webgpu/webgpu.h>
#include "vr.hpp"

#include <cmath>
#include <vector>

namespace {

WGPUAdapter requestAdapterSync(WGPUInstance instance) {
  struct S { WGPUAdapter a; bool done; } s{nullptr, false};
  WGPURequestAdapterOptions opt{};
  opt.powerPreference = WGPUPowerPreference_HighPerformance;
  wgpuInstanceRequestAdapter(instance, &opt,
    [](WGPURequestAdapterStatus st, WGPUAdapter a, char const* m, void* ud) {
      auto* s = static_cast<S*>(ud);
      if (st == WGPURequestAdapterStatus_Success) s->a = a;
      else std::fprintf(stderr, "[vr-spike] requestAdapter failed: %s\n", m ? m : "(no message)");
      s->done = true;
    }, &s);
  for (int i = 0; i < 10000 && !s.done; ++i) wgpuInstanceProcessEvents(instance);
  return s.a;
}

WGPUDevice requestDeviceSync(WGPUInstance instance, WGPUAdapter adapter) {
  std::vector<WGPUFeatureName> feats;
  auto want = [&](WGPUFeatureName f, const char* name) {
    if (wgpuAdapterHasFeature(adapter, f)) { feats.push_back(f); std::printf("[vr-spike] enable feature: %s\n", name); }
    else std::fprintf(stderr, "[vr-spike] adapter LACKS feature: %s\n", name);
  };
  want(WGPUFeatureName_SharedTextureMemoryDXGISharedHandle, "SharedTextureMemoryDXGISharedHandle");
  want(WGPUFeatureName_SharedFenceDXGISharedHandle,         "SharedFenceDXGISharedHandle");
  struct S { WGPUDevice d; bool done; } s{nullptr, false};
  WGPUDeviceDescriptor dd{};
  dd.label = "sailsim-vr-spike-device";
  dd.requiredFeatureCount = feats.size();
  dd.requiredFeatures = feats.empty() ? nullptr : feats.data();
  wgpuAdapterRequestDevice(adapter, &dd,
    [](WGPURequestDeviceStatus st, WGPUDevice d, char const* m, void* ud) {
      auto* s = static_cast<S*>(ud);
      if (st == WGPURequestDeviceStatus_Success) s->d = d;
      else std::fprintf(stderr, "[vr-spike] requestDevice failed: %s\n", m ? m : "(no message)");
      s->done = true;
    }, &s);
  for (int i = 0; i < 10000 && !s.done; ++i) wgpuInstanceProcessEvents(instance);
  return s.d;
}

}  // namespace

int main() {
  std::printf("[vr-spike] OpenXR D3D12 render spike — thin harness over the vr module.\n");

  WGPUInstance instance = wgpuCreateInstance(nullptr);
  if (!instance) { std::fprintf(stderr, "[vr-spike] wgpuCreateInstance failed\n"); return 1; }
  WGPUAdapter adapter = requestAdapterSync(instance);
  if (!adapter) return 1;
  WGPUDevice device = requestDeviceSync(instance, adapter);
  if (!device) return 1;
  wgpuDeviceSetUncapturedErrorCallback(device,
    [](WGPUErrorType t, char const* m, void*) {
      std::fprintf(stderr, "[vr-spike] Dawn error (%d): %s\n", (int)t, m ? m : "(no message)");
    }, nullptr);
  WGPUQueue queue = wgpuDeviceGetQueue(device);

  vr::Bridge* b = vr::create(instance, device);
  if (!b) { std::fprintf(stderr, "[vr-spike] vr::create failed (runtime/HMD/features?).\n"); return 1; }

  bool running = false, exitReq = false;
  long frame = 0;
  while (!exitReq) {
    vr::poll(b, running, exitReq);
    if (!running) { Sleep(10); continue; }

    if (vr::beginFrame(b)) {
      float pulse = 0.5f + 0.5f * (float)std::sin(frame * 0.03);
      for (int e = 0; e < vr::eyeCount(b); ++e) {
        const float left[4]  = { 0.85f * pulse, 0.20f, 0.15f, 1.0f };
        const float right[4] = { 0.10f, 0.35f, 0.85f * pulse, 1.0f };
        const float* col = (e == 0) ? left : right;
        WGPURenderPassColorAttachment ca{};
        ca.view = vr::eyeTarget(b, e);
        ca.loadOp = WGPULoadOp_Clear;
        ca.storeOp = WGPUStoreOp_Store;
        ca.clearValue = WGPUColor{ col[0], col[1], col[2], col[3] };
#ifdef WGPU_DEPTH_SLICE_UNDEFINED
        ca.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDescriptor rp{};
        rp.colorAttachmentCount = 1;
        rp.colorAttachments = &ca;
        WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, nullptr);
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
        WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
        wgpuQueueSubmit(queue, 1, &cmd);
        wgpuCommandBufferRelease(cmd);
        wgpuCommandEncoderRelease(enc);
      }
      if ((frame % 90) == 0) std::printf("[vr-spike] frame %ld\n", frame);
    }
    vr::endFrame(b);
    ++frame;
  }

  vr::destroy(b);
  std::printf("[vr-spike] clean exit after %ld frames.\n", frame);
  return 0;
}

#else  // not (Windows + Dawn)

int main() {
  std::printf("[vr-spike] VR needs the Windows + Dawn backend "
              "(-DSAILSIM_WEBGPU_BACKEND=DAWN -DSAILSIM_VR=ON). Nothing to do here.\n");
  return 0;
}

#endif
