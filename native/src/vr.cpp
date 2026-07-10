// ── VR bridge (OpenXR ⇄ Dawn-D3D12) — implementation ─────────────────────────
// See vr.hpp. Extracted from the proven src/vr_spike.cpp increment-3 path:
// Dawn renders each eye into its own ALLOW_SIMULTANEOUS_ACCESS shared RT, which we
// CopyResource into the runtime's XR swapchain image on the OpenXR binding queue.

#include "vr.hpp"

#if defined(_WIN32) && defined(WEBGPU_BACKEND_DAWN)

#include <windows.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include <wrl/client.h>

#define XR_USE_GRAPHICS_API_D3D12
#define XR_USE_PLATFORM_WIN32
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>

#include <dawn/native/D3D12Backend.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace vr {

namespace {
std::string xrStr(XrInstance inst, XrResult r) {
  if (inst != XR_NULL_HANDLE) { char b[XR_MAX_RESULT_STRING_SIZE] = {0};
    if (XR_SUCCEEDED(xrResultToString(inst, r, b)) && b[0]) return b; }
  return std::to_string((int)r);
}
}  // namespace

struct EyeChain {
  XrSwapchain handle = XR_NULL_HANDLE;
  uint32_t width = 0, height = 0;
  std::vector<XrSwapchainImageD3D12KHR> images;   // .texture is ID3D12Resource*
  ComPtr<ID3D12Resource> ownRT;                   // Dawn renders here; copied into the XR image
  WGPUSharedTextureMemory mem = nullptr;
  WGPUTexture tex = nullptr;
  WGPUTextureView view = nullptr;
  // per-frame:
  XrView xrView{XR_TYPE_VIEW};
  uint32_t acquiredIdx = 0;
};

struct Bridge {
  // app-provided
  WGPUInstance winst = nullptr;
  WGPUDevice   wdevice = nullptr;
  WGPUQueue    dawnQueue = nullptr;
  // D3D12
  ComPtr<ID3D12Device> device;
  ComPtr<ID3D12CommandQueue> queue;           // OpenXR binding queue (does the copies)
  ComPtr<ID3D12CommandAllocator> cmdAlloc;
  ComPtr<ID3D12GraphicsCommandList> cmdList;
  ComPtr<ID3D12Fence> fence;
  UINT64 fenceVal = 0;
  HANDLE fenceEvent = nullptr;
  // OpenXR
  XrInstance instance = XR_NULL_HANDLE;
  XrSystemId systemId = XR_NULL_SYSTEM_ID;
  XrSession session = XR_NULL_HANDLE;
  XrSpace appSpace = XR_NULL_HANDLE;
  DXGI_FORMAT colorFormat = DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
  std::vector<EyeChain> eyes;
  // frame state
  XrFrameState frameState{XR_TYPE_FRAME_STATE};
  bool inFrame = false;
  bool shouldRender = false;
};

namespace {

bool setupSwapchains(Bridge* b) {
  uint32_t viewCount = 0;
  if (XR_FAILED(xrEnumerateViewConfigurationViews(b->instance, b->systemId,
        XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 0, &viewCount, nullptr))) return false;
  std::vector<XrViewConfigurationView> cfgs(viewCount, {XR_TYPE_VIEW_CONFIGURATION_VIEW});
  if (XR_FAILED(xrEnumerateViewConfigurationViews(b->instance, b->systemId,
        XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, viewCount, &viewCount, cfgs.data()))) return false;

  uint32_t fmtCount = 0;
  xrEnumerateSwapchainFormats(b->session, 0, &fmtCount, nullptr);
  std::vector<int64_t> fmts(fmtCount);
  xrEnumerateSwapchainFormats(b->session, fmtCount, &fmtCount, fmts.data());
  auto has = [&](int64_t f){ for (auto x : fmts) if (x == f) return true; return false; };
  if      (has(DXGI_FORMAT_R8G8B8A8_UNORM_SRGB)) b->colorFormat = DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
  else if (has(DXGI_FORMAT_B8G8R8A8_UNORM_SRGB)) b->colorFormat = DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
  else if (fmtCount) b->colorFormat = (DXGI_FORMAT)fmts[0];

  b->eyes.resize(viewCount);
  for (uint32_t e = 0; e < viewCount; ++e) {
    EyeChain& eye = b->eyes[e];
    eye.width = cfgs[e].recommendedImageRectWidth;
    eye.height = cfgs[e].recommendedImageRectHeight;

    XrSwapchainCreateInfo sc{XR_TYPE_SWAPCHAIN_CREATE_INFO};
    sc.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT | XR_SWAPCHAIN_USAGE_TRANSFER_DST_BIT;
    sc.format = b->colorFormat; sc.width = eye.width; sc.height = eye.height;
    sc.sampleCount = 1; sc.faceCount = 1; sc.arraySize = 1; sc.mipCount = 1;
    if (XR_FAILED(xrCreateSwapchain(b->session, &sc, &eye.handle))) return false;

    uint32_t n = 0;
    xrEnumerateSwapchainImages(eye.handle, 0, &n, nullptr);
    eye.images.assign(n, {XR_TYPE_SWAPCHAIN_IMAGE_D3D12_KHR});
    xrEnumerateSwapchainImages(eye.handle, n, &n,
                               reinterpret_cast<XrSwapchainImageBaseHeader*>(eye.images.data()));

    // Own shared RT (Dawn renders here) — the XR images aren't importable (no mutex / no
    // simultaneous-access), so make ours WITH those flags, import it, and CopyResource each frame.
    D3D12_HEAP_PROPERTIES hp{}; hp.Type = D3D12_HEAP_TYPE_DEFAULT;
    D3D12_RESOURCE_DESC rd{};
    rd.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    rd.Width = eye.width; rd.Height = eye.height; rd.DepthOrArraySize = 1; rd.MipLevels = 1;
    rd.Format = b->colorFormat; rd.SampleDesc.Count = 1;
    rd.Flags = D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET | D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;
    if (FAILED(b->device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_SHARED, &rd,
          D3D12_RESOURCE_STATE_COMMON, nullptr, IID_PPV_ARGS(&eye.ownRT)))) return false;
    HANDLE sh = nullptr;
    if (FAILED(b->device->CreateSharedHandle(eye.ownRT.Get(), nullptr, GENERIC_ALL, nullptr, &sh)) || !sh)
      return false;
    WGPUSharedTextureMemoryDXGISharedHandleDescriptor dxgi{};
    dxgi.chain.sType = WGPUSType_SharedTextureMemoryDXGISharedHandleDescriptor;
    dxgi.handle = sh; dxgi.useKeyedMutex = false;
    WGPUSharedTextureMemoryDescriptor smd{};
    smd.nextInChain = &dxgi.chain; smd.label = "vr-eye-own-rt";
    eye.mem = wgpuDeviceImportSharedTextureMemory(b->wdevice, &smd);
    CloseHandle(sh);
    if (!eye.mem) return false;
    // A failed import (e.g. the device feature wasn't enabled) returns an INVALID-but-non-null
    // object; GetProperties reports that so we fail here instead of at BeginAccess with a black screen.
    WGPUSharedTextureMemoryProperties props = {};
    if (wgpuSharedTextureMemoryGetProperties(eye.mem, &props) != WGPUStatus_Success) {
      std::fprintf(stderr, "[vr] eye %u: imported shared texture is invalid — is the device's "
                           "SharedTextureMemoryDXGISharedHandle feature enabled?\n", e);
      return false;
    }
    eye.tex = wgpuSharedTextureMemoryCreateTexture(eye.mem, nullptr);
    if (!eye.tex) return false;
    eye.view = wgpuTextureCreateView(eye.tex, nullptr);
    std::printf("[vr] eye %u: %ux%u, %u images\n", e, eye.width, eye.height, n);
  }
  return true;
}

}  // namespace

Bridge* create(WGPUInstance instance, WGPUDevice wdevice) {
  auto* b = new Bridge();
  b->winst = instance;
  b->wdevice = wdevice;
  b->dawnQueue = wgpuDeviceGetQueue(wdevice);

  // OpenXR instance with the D3D12 binding.
  uint32_t extCount = 0;
  if (XR_FAILED(xrEnumerateInstanceExtensionProperties(nullptr, 0, &extCount, nullptr))) {
    std::fprintf(stderr, "[vr] no active OpenXR runtime\n"); delete b; return nullptr;
  }
  const char* exts[] = { XR_KHR_D3D12_ENABLE_EXTENSION_NAME };
  XrInstanceCreateInfo ci{XR_TYPE_INSTANCE_CREATE_INFO};
  std::snprintf(ci.applicationInfo.applicationName, XR_MAX_APPLICATION_NAME_SIZE, "%s", "sailsim");
  ci.applicationInfo.applicationVersion = 1;
  std::snprintf(ci.applicationInfo.engineName, XR_MAX_ENGINE_NAME_SIZE, "%s", "sailsim");
  ci.applicationInfo.apiVersion = XR_MAKE_VERSION(1, 0, 0);
  ci.enabledExtensionCount = 1; ci.enabledExtensionNames = exts;
  XrResult r = xrCreateInstance(&ci, &b->instance);
  if (XR_FAILED(r)) { std::fprintf(stderr, "[vr] xrCreateInstance: %s\n", xrStr(XR_NULL_HANDLE, r).c_str());
                      delete b; return nullptr; }

  XrSystemGetInfo sgi{XR_TYPE_SYSTEM_GET_INFO};
  sgi.formFactor = XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
  r = xrGetSystem(b->instance, &sgi, &b->systemId);
  if (XR_FAILED(r)) { std::fprintf(stderr, "[vr] xrGetSystem (HMD present?): %s\n", xrStr(b->instance, r).c_str());
                      destroy(b); return nullptr; }

  // Confirm Dawn's device is on the OpenXR-required adapter.
  PFN_xrGetD3D12GraphicsRequirementsKHR getReqs = nullptr;
  xrGetInstanceProcAddr(b->instance, "xrGetD3D12GraphicsRequirementsKHR",
                        reinterpret_cast<PFN_xrVoidFunction*>(&getReqs));
  XrGraphicsRequirementsD3D12KHR reqs{XR_TYPE_GRAPHICS_REQUIREMENTS_D3D12_KHR};
  if (!getReqs || XR_FAILED(getReqs(b->instance, b->systemId, &reqs))) {
    std::fprintf(stderr, "[vr] xrGetD3D12GraphicsRequirementsKHR failed\n"); destroy(b); return nullptr;
  }
  b->device = dawn::native::d3d12::GetD3D12Device(wdevice);
  if (!b->device) { std::fprintf(stderr, "[vr] GetD3D12Device null (Dawn not on D3D12?)\n"); destroy(b); return nullptr; }
  LUID dl = b->device->GetAdapterLuid();
  if (dl.LowPart != reqs.adapterLuid.LowPart || dl.HighPart != reqs.adapterLuid.HighPart)
    std::fprintf(stderr, "[vr] WARNING: Dawn adapter LUID != OpenXR-required LUID (multi-GPU)\n");

  D3D12_COMMAND_QUEUE_DESC qd{}; qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
  if (FAILED(b->device->CreateCommandQueue(&qd, IID_PPV_ARGS(&b->queue)))) { destroy(b); return nullptr; }
  b->device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&b->cmdAlloc));
  b->device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, b->cmdAlloc.Get(), nullptr,
                               IID_PPV_ARGS(&b->cmdList));
  b->cmdList->Close();
  b->device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&b->fence));
  b->fenceEvent = CreateEventA(nullptr, FALSE, FALSE, nullptr);

  XrGraphicsBindingD3D12KHR gb{XR_TYPE_GRAPHICS_BINDING_D3D12_KHR};
  gb.device = b->device.Get(); gb.queue = b->queue.Get();
  XrSessionCreateInfo sci{XR_TYPE_SESSION_CREATE_INFO};
  sci.next = &gb; sci.systemId = b->systemId;
  r = xrCreateSession(b->instance, &sci, &b->session);
  if (XR_FAILED(r)) { std::fprintf(stderr, "[vr] xrCreateSession: %s\n", xrStr(b->instance, r).c_str());
                      destroy(b); return nullptr; }

  XrReferenceSpaceCreateInfo rsci{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
  rsci.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_LOCAL;
  rsci.poseInReferenceSpace.orientation.w = 1.0f;
  if (XR_FAILED(xrCreateReferenceSpace(b->session, &rsci, &b->appSpace))) { destroy(b); return nullptr; }

  if (!setupSwapchains(b)) { std::fprintf(stderr, "[vr] swapchain setup failed\n"); destroy(b); return nullptr; }
  std::fprintf(stderr, "[vr] post-setup deviceLost=%d (0 = alive after create; loss is later, in the frame loop)\n",
               b->eyes.empty() ? -1 : (int)wgpuSharedTextureMemoryIsDeviceLost(b->eyes[0].mem));
  std::printf("[vr] session ready (Dawn D3D12 binding).\n");
  return b;
}

void poll(Bridge* b, bool& running, bool& exitRequested) {
  if (!b) return;
  XrEventDataBuffer ev{XR_TYPE_EVENT_DATA_BUFFER};
  while (xrPollEvent(b->instance, &ev) == XR_SUCCESS) {
    if (ev.type == XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED) {
      auto* s = reinterpret_cast<XrEventDataSessionStateChanged*>(&ev);
      if (s->state == XR_SESSION_STATE_READY) {
        XrSessionBeginInfo bi{XR_TYPE_SESSION_BEGIN_INFO};
        bi.primaryViewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
        if (XR_SUCCEEDED(xrBeginSession(b->session, &bi))) running = true;
      } else if (s->state == XR_SESSION_STATE_STOPPING) {
        xrEndSession(b->session); running = false;
      } else if (s->state == XR_SESSION_STATE_EXITING || s->state == XR_SESSION_STATE_LOSS_PENDING) {
        exitRequested = true;
      }
    } else if (ev.type == XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING) {
      exitRequested = true;
    }
    ev = {XR_TYPE_EVENT_DATA_BUFFER};
  }
}

bool beginFrame(Bridge* b) {
  if (!b) return false;
  XrFrameWaitInfo fwi{XR_TYPE_FRAME_WAIT_INFO};
  b->frameState = {XR_TYPE_FRAME_STATE};
  if (XR_FAILED(xrWaitFrame(b->session, &fwi, &b->frameState))) return false;
  XrFrameBeginInfo fbi{XR_TYPE_FRAME_BEGIN_INFO};
  xrBeginFrame(b->session, &fbi);
  b->inFrame = true;
  b->shouldRender = b->frameState.shouldRender != 0;
  if (!b->shouldRender) return false;

  XrViewLocateInfo vli{XR_TYPE_VIEW_LOCATE_INFO};
  vli.viewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
  vli.displayTime = b->frameState.predictedDisplayTime;
  vli.space = b->appSpace;
  XrViewState vs{XR_TYPE_VIEW_STATE};
  std::vector<XrView> views(b->eyes.size(), {XR_TYPE_VIEW});
  uint32_t got = 0;
  if (XR_FAILED(xrLocateViews(b->session, &vli, &vs, (uint32_t)views.size(), &got, views.data())))
    { b->shouldRender = false; return false; }

  // Open Dawn access to each eye's RT so the app can render into it this frame.
  for (size_t e = 0; e < b->eyes.size(); ++e) {
    b->eyes[e].xrView = views[e];
    WGPUSharedTextureMemoryBeginAccessDescriptor ba{};
    ba.concurrentRead = false; ba.initialized = false; ba.fenceCount = 0;
    // Capture WHY BeginAccess fails (it works in the spike but not the game): wrap it in a
    // validation error scope. A message = a validation reason; empty = a soft false.
    wgpuDevicePushErrorScope(b->wdevice, WGPUErrorFilter_Validation);
    bool ok = wgpuSharedTextureMemoryBeginAccess(b->eyes[e].mem, b->eyes[e].tex, &ba);
    struct ES { std::string msg; bool done; } es{"", false};
    wgpuDevicePopErrorScope(b->wdevice,
      [](WGPUErrorType t, char const* m, void* ud) {
        auto* s = static_cast<ES*>(ud);
        if (t != WGPUErrorType_NoError && m) s->msg = m;
        s->done = true;
      }, &es);
    for (int k = 0; k < 100000 && !es.done; ++k) { wgpuInstanceProcessEvents(b->winst); wgpuDeviceTick(b->wdevice); }
    if (!ok) {
      std::fprintf(stderr, "[vr] BeginAccess failed (eye %zu): deviceLost=%d scopeErr=\"%s\"\n",
                   e, (int)wgpuSharedTextureMemoryIsDeviceLost(b->eyes[e].mem), es.msg.c_str());
      b->shouldRender = false; return false;
    }
  }
  return true;
}

int             eyeCount(Bridge* b) { return b ? (int)b->eyes.size() : 0; }
WGPUTextureView eyeTarget(Bridge* b, int e) { return b ? b->eyes[e].view : nullptr; }
uint32_t        eyeWidth(Bridge* b, int e)  { return b ? b->eyes[e].width : 0; }
uint32_t        eyeHeight(Bridge* b, int e) { return b ? b->eyes[e].height : 0; }
WGPUTextureFormat eyeFormat(Bridge* b) {
  // Match the DXGI swapchain/own-RT format to a wgpu format (the eye views' format).
  if (!b) return WGPUTextureFormat_RGBA8UnormSrgb;
  switch (b->colorFormat) {
    case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB: return WGPUTextureFormat_RGBA8UnormSrgb;
    case DXGI_FORMAT_R8G8B8A8_UNORM:      return WGPUTextureFormat_RGBA8Unorm;
    case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB: return WGPUTextureFormat_BGRA8UnormSrgb;
    case DXGI_FORMAT_B8G8R8A8_UNORM:      return WGPUTextureFormat_BGRA8Unorm;
    default:                              return WGPUTextureFormat_RGBA8UnormSrgb;
  }
}

void eyeCamera(Bridge* b, int e, float pose7[7], float fov4[4]) {
  const XrView& v = b->eyes[e].xrView;
  pose7[0] = v.pose.position.x; pose7[1] = v.pose.position.y; pose7[2] = v.pose.position.z;
  pose7[3] = v.pose.orientation.x; pose7[4] = v.pose.orientation.y;
  pose7[5] = v.pose.orientation.z; pose7[6] = v.pose.orientation.w;
  fov4[0] = v.fov.angleLeft; fov4[1] = v.fov.angleRight; fov4[2] = v.fov.angleUp; fov4[3] = v.fov.angleDown;
}

void endFrame(Bridge* b) {
  if (!b || !b->inFrame) return;
  std::vector<XrCompositionLayerProjectionView> projViews;
  XrCompositionLayerProjection layer{XR_TYPE_COMPOSITION_LAYER_PROJECTION};

  if (b->shouldRender) {
    projViews.resize(b->eyes.size());
    for (size_t e = 0; e < b->eyes.size(); ++e) {
      EyeChain& eye = b->eyes[e];
      // Close Dawn's access, then CPU-sync so the render is complete before we copy.
      WGPUSharedTextureMemoryEndAccessState es{};
      wgpuSharedTextureMemoryEndAccess(eye.mem, eye.tex, &es);
      struct W { bool done; } w{false};
      wgpuQueueOnSubmittedWorkDone(b->dawnQueue,
        [](WGPUQueueWorkDoneStatus, void* ud){ static_cast<W*>(ud)->done = true; }, &w);
      for (int k = 0; k < 200000 && !w.done; ++k) { wgpuInstanceProcessEvents(b->winst); wgpuDeviceTick(b->wdevice); }
      wgpuSharedTextureMemoryEndAccessStateFreeMembers(es);

      // Acquire the XR image and copy our RT into it on the binding queue.
      uint32_t idx = 0;
      XrSwapchainImageAcquireInfo ai{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
      xrAcquireSwapchainImage(eye.handle, &ai, &idx);
      XrSwapchainImageWaitInfo wi{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO}; wi.timeout = XR_INFINITE_DURATION;
      xrWaitSwapchainImage(eye.handle, &wi);

      b->cmdAlloc->Reset();
      b->cmdList->Reset(b->cmdAlloc.Get(), nullptr);
      D3D12_RESOURCE_BARRIER toCopy{};
      toCopy.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
      toCopy.Transition.pResource = eye.images[idx].texture;
      toCopy.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
      toCopy.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_DEST;
      toCopy.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
      b->cmdList->ResourceBarrier(1, &toCopy);
      b->cmdList->CopyResource(eye.images[idx].texture, eye.ownRT.Get());
      D3D12_RESOURCE_BARRIER toRT = toCopy;
      toRT.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_DEST;
      toRT.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
      b->cmdList->ResourceBarrier(1, &toRT);
      b->cmdList->Close();
      ID3D12CommandList* lists[] = { b->cmdList.Get() };
      b->queue->ExecuteCommandLists(1, lists);
      const UINT64 sig = ++b->fenceVal;
      b->queue->Signal(b->fence.Get(), sig);
      if (b->fence->GetCompletedValue() < sig) {
        b->fence->SetEventOnCompletion(sig, b->fenceEvent);
        WaitForSingleObject(b->fenceEvent, INFINITE);
      }
      XrSwapchainImageReleaseInfo ri{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};
      xrReleaseSwapchainImage(eye.handle, &ri);

      XrCompositionLayerProjectionView& pv = projViews[e];
      pv = {XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW};
      pv.pose = eye.xrView.pose; pv.fov = eye.xrView.fov;
      pv.subImage.swapchain = eye.handle;
      pv.subImage.imageRect.offset = {0, 0};
      pv.subImage.imageRect.extent = {(int32_t)eye.width, (int32_t)eye.height};
    }
    layer.space = b->appSpace;
    layer.viewCount = (uint32_t)projViews.size();
    layer.views = projViews.data();
  }

  XrFrameEndInfo fei{XR_TYPE_FRAME_END_INFO};
  fei.displayTime = b->frameState.predictedDisplayTime;
  fei.environmentBlendMode = XR_ENVIRONMENT_BLEND_MODE_OPAQUE;
  const XrCompositionLayerBaseHeader* layers[] = { reinterpret_cast<XrCompositionLayerBaseHeader*>(&layer) };
  fei.layerCount = (b->shouldRender && !projViews.empty()) ? 1u : 0u;
  fei.layers = fei.layerCount ? layers : nullptr;
  xrEndFrame(b->session, &fei);
  b->inFrame = false;
}

void destroy(Bridge* b) {
  if (!b) return;
  for (auto& eye : b->eyes) {
    if (eye.view) wgpuTextureViewRelease(eye.view);
    if (eye.tex)  wgpuTextureRelease(eye.tex);
    if (eye.mem)  wgpuSharedTextureMemoryRelease(eye.mem);
    if (eye.handle) xrDestroySwapchain(eye.handle);
  }
  if (b->appSpace) xrDestroySpace(b->appSpace);
  if (b->session)  xrDestroySession(b->session);
  if (b->fenceEvent) CloseHandle(b->fenceEvent);
  if (b->instance) xrDestroyInstance(b->instance);
  delete b;
}

}  // namespace vr

#endif  // _WIN32 && WEBGPU_BACKEND_DAWN
