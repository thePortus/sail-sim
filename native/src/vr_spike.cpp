// ── OpenXR D3D12 render spike (VR P0.1, increment 1) ─────────────────────────
//
// Retires the biggest VR risk — "does OpenXR D3D12 rendering actually reach the
// headset through Meta Link / Virtual Desktop" — with the SMALLEST possible code
// and NO Dawn dependency. It creates its OWN plain D3D12 device (on the adapter
// OpenXR requires), opens an OpenXR session with the D3D12 graphics binding, makes
// a stereo swapchain per eye, and every frame clears each eye to a slowly pulsing
// solid colour (left warm, right cool) submitted as a projection composition layer.
//
// Because it uses raw D3D12 (no webgpu / no Dawn / no DXC), it builds in seconds and
// iterates without the Dawn rebuild. Exit criteria: two solid, head-STABLE colour
// fields in the headset over Link AND Virtual Desktop, head pose logged live. Once
// green, increment 2 swaps this throwaway D3D12 device for Dawn's ID3D12Device
// (dawn::native::d3d12::GetD3D12Device), then increment 3 renders via Dawn into the
// XR swapchain through SharedTextureMemory. See native/VR_PLAN.md.
//
// Build:  cmake -S native -B build-win-vr -DSAILSIM_VR=ON  (Dawn backend not required
//         for THIS target) && cmake --build build-win-vr --target sailsim_vr_spike --config Release
// Run:    build-win-vr\bin\Release\sailsim_vr_spike.exe   (Link / Virtual Desktop active, headset on)

#include <windows.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include <wrl/client.h>

#define XR_USE_GRAPHICS_API_D3D12
#define XR_USE_PLATFORM_WIN32
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>

// Increment 2: when built with the Dawn backend, drive the OpenXR session with DAWN's own
// ID3D12Device (so increment 3 can render the real scene via wgpu into the XR swapchain).
// Without the Dawn backend the spike falls back to its own D3D12 device (increment 1).
#if defined(WEBGPU_BACKEND_DAWN)
#include <webgpu/webgpu.h>
#include <dawn/native/D3D12Backend.h>
#endif

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

// ── error plumbing ───────────────────────────────────────────────────────────
std::string xrStr(XrInstance instance, XrResult r) {
  if (instance != XR_NULL_HANDLE) {
    char buf[XR_MAX_RESULT_STRING_SIZE] = {0};
    if (XR_SUCCEEDED(xrResultToString(instance, r, buf)) && buf[0]) return buf;
  }
  return std::to_string(static_cast<int>(r));
}

XrInstance gInstance = XR_NULL_HANDLE;   // for the macros' message lookup

#define XR_TRY(call)                                                                     \
  do {                                                                                   \
    XrResult _r = (call);                                                                \
    if (XR_FAILED(_r)) {                                                                 \
      std::fprintf(stderr, "[vr-spike] %s FAILED: %s\n", #call, xrStr(gInstance, _r).c_str()); \
      return _r;                                                                         \
    }                                                                                    \
  } while (0)

#define HR_TRY(call)                                                                     \
  do {                                                                                   \
    HRESULT _hr = (call);                                                                \
    if (FAILED(_hr)) {                                                                    \
      std::fprintf(stderr, "[vr-spike] %s FAILED: HRESULT 0x%08lx\n", #call, (unsigned long)_hr); \
      return XR_ERROR_RUNTIME_FAILURE;                                                    \
    }                                                                                    \
  } while (0)

bool hasExt(const std::vector<XrExtensionProperties>& exts, const char* name) {
  for (const auto& e : exts) if (std::strcmp(e.extensionName, name) == 0) return true;
  return false;
}

// One eye's swapchain + its D3D12 back-buffer images and render-target views.
struct EyeSwapchain {
  XrSwapchain handle = XR_NULL_HANDLE;
  uint32_t width = 0, height = 0;
  std::vector<XrSwapchainImageD3D12KHR> images;   // .texture is ID3D12Resource*
  // Raw-D3D12 path (increment 1/2): RTVs for a ClearRenderTargetView.
  ComPtr<ID3D12DescriptorHeap> rtvHeap;
  UINT rtvStride = 0;
  DXGI_FORMAT format = DXGI_FORMAT_R8G8B8A8_UNORM;
#if defined(WEBGPU_BACKEND_DAWN)
  // Dawn path (increment 3): each XR image imported as a Dawn shared texture, rendered via wgpu.
  std::vector<WGPUSharedTextureMemory> mem;   // one per swapchain image
  std::vector<WGPUTexture> tex;
  std::vector<WGPUTextureView> view;
#endif
};

#if defined(WEBGPU_BACKEND_DAWN)
// Minimal synchronous Dawn adapter/device requests. Dawn resolves the callbacks while its
// instance event loop is pumped, so spin wgpuInstanceProcessEvents until they fire.
WGPUAdapter requestAdapterSync(WGPUInstance instance) {
  struct S { WGPUAdapter adapter; bool done; } s{nullptr, false};
  WGPURequestAdapterOptions opt{};
  opt.powerPreference = WGPUPowerPreference_HighPerformance;
  wgpuInstanceRequestAdapter(instance, &opt,
    [](WGPURequestAdapterStatus status, WGPUAdapter a, char const* msg, void* ud) {
      auto* s = static_cast<S*>(ud);
      if (status == WGPURequestAdapterStatus_Success) s->adapter = a;
      else std::fprintf(stderr, "[vr-spike] requestAdapter failed: %s\n", msg ? msg : "(no message)");
      s->done = true;
    }, &s);
  for (int i = 0; i < 10000 && !s.done; ++i) wgpuInstanceProcessEvents(instance);
  return s.adapter;
}
WGPUDevice requestDeviceSync(WGPUInstance instance, WGPUAdapter adapter) {
  struct S { WGPUDevice device; bool done; } s{nullptr, false};
  WGPUDeviceDescriptor dd{};
  dd.label = "sailsim-vr-spike-device";
  wgpuAdapterRequestDevice(adapter, &dd,
    [](WGPURequestDeviceStatus status, WGPUDevice d, char const* msg, void* ud) {
      auto* s = static_cast<S*>(ud);
      if (status == WGPURequestDeviceStatus_Success) s->device = d;
      else std::fprintf(stderr, "[vr-spike] requestDevice failed: %s\n", msg ? msg : "(no message)");
      s->done = true;
    }, &s);
  for (int i = 0; i < 10000 && !s.done; ++i) wgpuInstanceProcessEvents(instance);
  return s.device;
}
#endif

XrResult run() {
  // 1. Runtime up? Enumerate instance extensions (first runtime call).
  uint32_t extCount = 0;
  {
    XrResult r = xrEnumerateInstanceExtensionProperties(nullptr, 0, &extCount, nullptr);
    if (XR_FAILED(r)) {
      std::fprintf(stderr, "[vr-spike] no active OpenXR runtime (%s). Start Link / Virtual Desktop, headset on.\n",
                   xrStr(XR_NULL_HANDLE, r).c_str());
      return r;
    }
  }
  std::vector<XrExtensionProperties> exts(extCount, {XR_TYPE_EXTENSION_PROPERTIES});
  XR_TRY(xrEnumerateInstanceExtensionProperties(nullptr, extCount, &extCount, exts.data()));
  if (!hasExt(exts, XR_KHR_D3D12_ENABLE_EXTENSION_NAME)) {
    std::fprintf(stderr, "[vr-spike] runtime does NOT advertise %s — cannot use the D3D12 binding.\n",
                 XR_KHR_D3D12_ENABLE_EXTENSION_NAME);
    return XR_ERROR_EXTENSION_NOT_PRESENT;
  }

  // 2. Instance with the D3D12 graphics binding extension enabled.
  const char* enabledExts[] = { XR_KHR_D3D12_ENABLE_EXTENSION_NAME };
  XrInstanceCreateInfo ci{XR_TYPE_INSTANCE_CREATE_INFO};
  std::snprintf(ci.applicationInfo.applicationName, XR_MAX_APPLICATION_NAME_SIZE, "%s", "sailsim-vr-spike");
  ci.applicationInfo.applicationVersion = 1;
  std::snprintf(ci.applicationInfo.engineName, XR_MAX_ENGINE_NAME_SIZE, "%s", "sailsim");
  ci.applicationInfo.engineVersion = 1;
  ci.applicationInfo.apiVersion = XR_MAKE_VERSION(1, 0, 0);   // maximally compatible (see vr_probe)
  ci.enabledExtensionCount = 1;
  ci.enabledExtensionNames = enabledExts;
  XR_TRY(xrCreateInstance(&ci, &gInstance));
  XrInstance instance = gInstance;

  XrInstanceProperties ip{XR_TYPE_INSTANCE_PROPERTIES};
  XR_TRY(xrGetInstanceProperties(instance, &ip));
  std::printf("[vr-spike] runtime: \"%s\" %u.%u.%u\n", ip.runtimeName,
              XR_VERSION_MAJOR(ip.runtimeVersion), XR_VERSION_MINOR(ip.runtimeVersion),
              XR_VERSION_PATCH(ip.runtimeVersion));

  // 3. HMD system.
  XrSystemGetInfo sgi{XR_TYPE_SYSTEM_GET_INFO};
  sgi.formFactor = XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
  XrSystemId systemId = XR_NULL_SYSTEM_ID;
  XR_TRY(xrGetSystem(instance, &sgi, &systemId));

  // 4. D3D12 graphics requirements → which adapter (LUID) + min feature level OpenXR needs.
  //    xrGetD3D12GraphicsRequirementsKHR is an extension entry point — load it dynamically.
  PFN_xrGetD3D12GraphicsRequirementsKHR pfnGetReqs = nullptr;
  XR_TRY(xrGetInstanceProcAddr(instance, "xrGetD3D12GraphicsRequirementsKHR",
                               reinterpret_cast<PFN_xrVoidFunction*>(&pfnGetReqs)));
  if (!pfnGetReqs) { std::fprintf(stderr, "[vr-spike] xrGetD3D12GraphicsRequirementsKHR not found\n");
                     return XR_ERROR_FUNCTION_UNSUPPORTED; }
  XrGraphicsRequirementsD3D12KHR reqs{XR_TYPE_GRAPHICS_REQUIREMENTS_D3D12_KHR};
  XR_TRY(pfnGetReqs(instance, systemId, &reqs));
  std::printf("[vr-spike] D3D12 requirements: adapterLUID=%08lx:%08lx minFeatureLevel=0x%x\n",
              (unsigned long)reqs.adapterLuid.HighPart, (unsigned long)reqs.adapterLuid.LowPart,
              (unsigned)reqs.minFeatureLevel);

  // 5. Obtain the D3D12 device the OpenXR session will render with, on the required adapter.
  ComPtr<ID3D12Device> device;
  ComPtr<ID3D12CommandQueue> queue;

#if defined(WEBGPU_BACKEND_DAWN)
  // Increment 2: use DAWN's D3D12 device. Create a minimal Dawn device (Dawn selects the
  // adapter), extract its ID3D12Device via the native interop, and make our OWN command queue
  // on it (6512's D3D12Backend.h has no queue accessor; a second queue on the device is fine).
  WGPUInstance winst = wgpuCreateInstance(nullptr);
  if (!winst) { std::fprintf(stderr, "[vr-spike] wgpuCreateInstance failed\n"); return XR_ERROR_RUNTIME_FAILURE; }
  WGPUAdapter wadapter = requestAdapterSync(winst);
  if (!wadapter) { std::fprintf(stderr, "[vr-spike] no WebGPU adapter\n"); return XR_ERROR_RUNTIME_FAILURE; }
  WGPUDevice wdevice = requestDeviceSync(winst, wadapter);
  if (!wdevice) { std::fprintf(stderr, "[vr-spike] no WebGPU device\n"); return XR_ERROR_RUNTIME_FAILURE; }
  device = dawn::native::d3d12::GetD3D12Device(wdevice);
  if (!device) { std::fprintf(stderr, "[vr-spike] GetD3D12Device returned null (Dawn not on D3D12?)\n");
                 return XR_ERROR_RUNTIME_FAILURE; }
  LUID dawnLuid = device->GetAdapterLuid();
  std::printf("[vr-spike] using DAWN's ID3D12Device (adapter LUID %08lx:%08lx)\n",
              (unsigned long)dawnLuid.HighPart, (unsigned long)dawnLuid.LowPart);
  if (dawnLuid.LowPart != reqs.adapterLuid.LowPart || dawnLuid.HighPart != reqs.adapterLuid.HighPart) {
    std::fprintf(stderr, "[vr-spike] WARNING: Dawn's adapter LUID != OpenXR-required LUID — the runtime "
                         "may reject the session (multi-GPU: force Dawn onto the XR adapter).\n");
  }
  D3D12_COMMAND_QUEUE_DESC qd{};
  qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
  HR_TRY(device->CreateCommandQueue(&qd, IID_PPV_ARGS(&queue)));
  WGPUQueue dawnQueue = wgpuDeviceGetQueue(wdevice);   // Dawn's render queue (increment 3)
  wgpuDeviceSetUncapturedErrorCallback(wdevice,
    [](WGPUErrorType t, char const* m, void*) {
      std::fprintf(stderr, "[vr-spike] Dawn uncaptured error (%d): %s\n", (int)t, m ? m : "(no message)");
    }, nullptr);
#else
  // Increment 1: our own plain D3D12 device on the OpenXR-required adapter (LUID match).
  ComPtr<IDXGIFactory4> factory;
  HR_TRY(CreateDXGIFactory1(IID_PPV_ARGS(&factory)));
  ComPtr<IDXGIAdapter1> adapter;
  bool found = false;
  for (UINT i = 0; factory->EnumAdapters1(i, adapter.ReleaseAndGetAddressOf()) != DXGI_ERROR_NOT_FOUND; ++i) {
    DXGI_ADAPTER_DESC1 desc{};
    adapter->GetDesc1(&desc);
    if (desc.AdapterLuid.LowPart == reqs.adapterLuid.LowPart &&
        desc.AdapterLuid.HighPart == reqs.adapterLuid.HighPart) {
      char name[128] = {0};
      std::snprintf(name, sizeof(name), "%ls", desc.Description);
      std::printf("[vr-spike] using adapter: %s\n", name);
      found = true;
      break;
    }
  }
  if (!found) { std::fprintf(stderr, "[vr-spike] no DXGI adapter matches the OpenXR-required LUID\n");
                return XR_ERROR_RUNTIME_FAILURE; }
  HR_TRY(D3D12CreateDevice(adapter.Get(), reqs.minFeatureLevel, IID_PPV_ARGS(&device)));
  D3D12_COMMAND_QUEUE_DESC qd{};
  qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
  HR_TRY(device->CreateCommandQueue(&qd, IID_PPV_ARGS(&queue)));
#endif

  ComPtr<ID3D12CommandAllocator> cmdAlloc;
  HR_TRY(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&cmdAlloc)));
  ComPtr<ID3D12GraphicsCommandList> cmdList;
  HR_TRY(device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, cmdAlloc.Get(), nullptr,
                                   IID_PPV_ARGS(&cmdList)));
  cmdList->Close();
  ComPtr<ID3D12Fence> fence;
  HR_TRY(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence)));
  UINT64 fenceVal = 0;
  HANDLE fenceEvent = CreateEventA(nullptr, FALSE, FALSE, nullptr);

  // 6. Session with the D3D12 binding (our device + queue).
  XrGraphicsBindingD3D12KHR gb{XR_TYPE_GRAPHICS_BINDING_D3D12_KHR};
  gb.device = device.Get();
  gb.queue  = queue.Get();
  XrSessionCreateInfo sci{XR_TYPE_SESSION_CREATE_INFO};
  sci.next = &gb;
  sci.systemId = systemId;
  XrSession session = XR_NULL_HANDLE;
  XR_TRY(xrCreateSession(instance, &sci, &session));
  std::printf("[vr-spike] session created (D3D12 binding accepted).\n");

  // 7. Reference space (seated LOCAL) for the composition layer poses.
  XrReferenceSpaceCreateInfo rsci{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
  rsci.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_LOCAL;
  rsci.poseInReferenceSpace.orientation.w = 1.0f;   // identity
  XrSpace appSpace = XR_NULL_HANDLE;
  XR_TRY(xrCreateReferenceSpace(session, &rsci, &appSpace));

  // 8. View config (stereo, 2 eyes) + per-eye size.
  uint32_t viewCount = 0;
  XR_TRY(xrEnumerateViewConfigurationViews(instance, systemId, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO,
                                           0, &viewCount, nullptr));
  std::vector<XrViewConfigurationView> viewConfigs(viewCount, {XR_TYPE_VIEW_CONFIGURATION_VIEW});
  XR_TRY(xrEnumerateViewConfigurationViews(instance, systemId, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO,
                                           viewCount, &viewCount, viewConfigs.data()));

  // 9. Pick a colour swapchain format the runtime supports (prefer 8-bit sRGB).
  uint32_t fmtCount = 0;
  XR_TRY(xrEnumerateSwapchainFormats(session, 0, &fmtCount, nullptr));
  std::vector<int64_t> fmts(fmtCount);
  XR_TRY(xrEnumerateSwapchainFormats(session, fmtCount, &fmtCount, fmts.data()));
  auto supports = [&](int64_t f) { for (auto x : fmts) if (x == f) return true; return false; };
  DXGI_FORMAT colorFormat = DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
  if      (supports(DXGI_FORMAT_R8G8B8A8_UNORM_SRGB)) colorFormat = DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
  else if (supports(DXGI_FORMAT_B8G8R8A8_UNORM_SRGB)) colorFormat = DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
  else if (fmtCount > 0)                               colorFormat = (DXGI_FORMAT)fmts[0];
  std::printf("[vr-spike] swapchain colour format: %d\n", (int)colorFormat);

  // 10. One swapchain per eye + RTVs for each of its images.
  std::vector<EyeSwapchain> eyes(viewCount);
  for (uint32_t e = 0; e < viewCount; ++e) {
    EyeSwapchain& eye = eyes[e];
    eye.width  = viewConfigs[e].recommendedImageRectWidth;
    eye.height = viewConfigs[e].recommendedImageRectHeight;
    eye.format = colorFormat;

    XrSwapchainCreateInfo scci{XR_TYPE_SWAPCHAIN_CREATE_INFO};
    scci.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT;
    scci.format = colorFormat;
    scci.width = eye.width;
    scci.height = eye.height;
    scci.sampleCount = 1;
    scci.faceCount = 1;
    scci.arraySize = 1;
    scci.mipCount = 1;
    XR_TRY(xrCreateSwapchain(session, &scci, &eye.handle));

    uint32_t imgCount = 0;
    XR_TRY(xrEnumerateSwapchainImages(eye.handle, 0, &imgCount, nullptr));
    eye.images.assign(imgCount, {XR_TYPE_SWAPCHAIN_IMAGE_D3D12_KHR});
    XR_TRY(xrEnumerateSwapchainImages(eye.handle, imgCount, &imgCount,
                                      reinterpret_cast<XrSwapchainImageBaseHeader*>(eye.images.data())));

    D3D12_DESCRIPTOR_HEAP_DESC hd{};
    hd.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    hd.NumDescriptors = imgCount;
    HR_TRY(device->CreateDescriptorHeap(&hd, IID_PPV_ARGS(&eye.rtvHeap)));
    eye.rtvStride = device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    D3D12_CPU_DESCRIPTOR_HANDLE rtv = eye.rtvHeap->GetCPUDescriptorHandleForHeapStart();
    D3D12_RENDER_TARGET_VIEW_DESC rtvd{};
    rtvd.Format = colorFormat;
    rtvd.ViewDimension = D3D12_RTV_DIMENSION_TEXTURE2D;
    for (uint32_t i = 0; i < imgCount; ++i) {
      device->CreateRenderTargetView(eye.images[i].texture, &rtvd, rtv);
      rtv.ptr += eye.rtvStride;
    }

#if defined(WEBGPU_BACKEND_DAWN)
    // Import each XR image (shareable — probe confirmed) into Dawn as a shared texture so we can
    // render into it directly with wgpu. CreateSharedHandle → wgpuDeviceImportSharedTextureMemory.
    eye.mem.resize(imgCount, nullptr);
    eye.tex.resize(imgCount, nullptr);
    eye.view.resize(imgCount, nullptr);
    for (uint32_t i = 0; i < imgCount; ++i) {
      HANDLE sh = nullptr;
      HRESULT hr = device->CreateSharedHandle(eye.images[i].texture, nullptr, GENERIC_ALL, nullptr, &sh);
      if (FAILED(hr) || !sh) { std::fprintf(stderr, "[vr-spike] eye %u img %u CreateSharedHandle failed 0x%08lx\n",
                                            e, i, (unsigned long)hr); return XR_ERROR_RUNTIME_FAILURE; }
      WGPUSharedTextureMemoryDXGISharedHandleDescriptor dxgi = {};
      dxgi.chain.sType = WGPUSType_SharedTextureMemoryDXGISharedHandleDescriptor;
      dxgi.handle = sh;
      dxgi.useKeyedMutex = true;   // VD's cross-process XR images carry a keyed mutex (acquire key 0)
      WGPUSharedTextureMemoryDescriptor smd = {};
      smd.nextInChain = &dxgi.chain;
      smd.label = "xr-eye-image";
      eye.mem[i] = wgpuDeviceImportSharedTextureMemory(wdevice, &smd);
      CloseHandle(sh);   // Dawn duplicates the handle on import
      if (!eye.mem[i]) { std::fprintf(stderr, "[vr-spike] eye %u img %u ImportSharedTextureMemory returned null\n", e, i);
                         return XR_ERROR_RUNTIME_FAILURE; }
      eye.tex[i]  = wgpuSharedTextureMemoryCreateTexture(eye.mem[i], nullptr);   // null => infer from shared memory
      if (!eye.tex[i]) { std::fprintf(stderr, "[vr-spike] eye %u img %u CreateTexture returned null\n", e, i);
                         return XR_ERROR_RUNTIME_FAILURE; }
      eye.view[i] = wgpuTextureCreateView(eye.tex[i], nullptr);
    }
    std::printf("[vr-spike] eye %u swapchain: %ux%u, %u images (imported into Dawn)\n", e, eye.width, eye.height, imgCount);
#else
    std::printf("[vr-spike] eye %u swapchain: %ux%u, %u images\n", e, eye.width, eye.height, imgCount);
#endif
  }

  // Interop probe (increment 3 design decision): can we make a DXGI shared handle from an XR
  // swapchain image? If yes, Dawn can import it directly (SharedTextureMemoryDXGISharedHandle) and
  // render straight in — zero copy. If not, we must render into our own shared texture and
  // CopyResource into the XR image. 6512 Dawn has no direct ID3D12Resource import, so this decides it.
  if (!eyes.empty() && !eyes[0].images.empty()) {
    HANDLE sh = nullptr;
    HRESULT hr = device->CreateSharedHandle(eyes[0].images[0].texture, nullptr, GENERIC_ALL, nullptr, &sh);
    std::printf("[vr-spike] XR image CreateSharedHandle: %s (hr=0x%08lx)\n",
                SUCCEEDED(hr) ? "SHAREABLE -> Dawn can import the XR image directly (zero-copy)"
                              : "NOT shareable -> render to own shared texture + CopyResource",
                (unsigned long)hr);
    if (sh) CloseHandle(sh);
  }

  // 11. Frame loop, driven by the OpenXR session state machine.
  bool running = false;      // between xrBeginSession and xrEndSession
  bool exitLoop = false;
  XrSessionState state = XR_SESSION_STATE_UNKNOWN;
  long frame = 0;

  while (!exitLoop) {
    // Drain events (session-state transitions).
    XrEventDataBuffer ev{XR_TYPE_EVENT_DATA_BUFFER};
    while (xrPollEvent(instance, &ev) == XR_SUCCESS) {
      if (ev.type == XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED) {
        auto* ssc = reinterpret_cast<XrEventDataSessionStateChanged*>(&ev);
        state = ssc->state;
        if (state == XR_SESSION_STATE_READY) {
          XrSessionBeginInfo bi{XR_TYPE_SESSION_BEGIN_INFO};
          bi.primaryViewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
          XR_TRY(xrBeginSession(session, &bi));
          running = true;
          std::printf("[vr-spike] session READY → begun.\n");
        } else if (state == XR_SESSION_STATE_STOPPING) {
          XR_TRY(xrEndSession(session));
          running = false;
          std::printf("[vr-spike] session STOPPING → ended.\n");
        } else if (state == XR_SESSION_STATE_EXITING || state == XR_SESSION_STATE_LOSS_PENDING) {
          exitLoop = true;
          std::printf("[vr-spike] session exiting.\n");
        }
      } else if (ev.type == XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING) {
        exitLoop = true;
      }
      ev = {XR_TYPE_EVENT_DATA_BUFFER};
    }

    if (!running) {
      // Not rendering yet (idle/synchronized handshake) — yield briefly.
      Sleep(10);
      continue;
    }

    // Pace to the compositor.
    XrFrameWaitInfo fwi{XR_TYPE_FRAME_WAIT_INFO};
    XrFrameState fs{XR_TYPE_FRAME_STATE};
    XR_TRY(xrWaitFrame(session, &fwi, &fs));

    XrFrameBeginInfo fbi{XR_TYPE_FRAME_BEGIN_INFO};
    XR_TRY(xrBeginFrame(session, &fbi));

    std::vector<XrCompositionLayerProjectionView> projViews;
    XrCompositionLayerProjection layer{XR_TYPE_COMPOSITION_LAYER_PROJECTION};

    if (fs.shouldRender) {
      // Locate the eyes for this predicted display time.
      XrViewLocateInfo vli{XR_TYPE_VIEW_LOCATE_INFO};
      vli.viewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
      vli.displayTime = fs.predictedDisplayTime;
      vli.space = appSpace;
      XrViewState vs{XR_TYPE_VIEW_STATE};
      std::vector<XrView> xrViews(viewCount, {XR_TYPE_VIEW});
      uint32_t got = 0;
      XR_TRY(xrLocateViews(session, &vli, &vs, viewCount, &got, xrViews.data()));

      // Slowly pulse so it's obviously LIVE, and distinct per eye.
      double t = (double)fs.predictedDisplayTime * 1e-9;
      float pulse = 0.5f + 0.5f * (float)std::sin(t * 1.5);

      projViews.resize(viewCount);
      for (uint32_t e = 0; e < viewCount; ++e) {
        EyeSwapchain& eye = eyes[e];
        uint32_t idx = 0;
        XrSwapchainImageAcquireInfo ai{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
        XR_TRY(xrAcquireSwapchainImage(eye.handle, &ai, &idx));
        XrSwapchainImageWaitInfo wi{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO};
        wi.timeout = XR_INFINITE_DURATION;
        XR_TRY(xrWaitSwapchainImage(eye.handle, &wi));

        const float left[4]  = { 0.85f * pulse, 0.20f, 0.15f, 1.0f };   // warm (left eye)
        const float right[4] = { 0.10f, 0.35f, 0.85f * pulse, 1.0f };   // cool (right eye)
        const float* col = (e == 0) ? left : right;

#if defined(WEBGPU_BACKEND_DAWN)
        // Increment 3: render into the XR image THROUGH Dawn (proves the wgpu↔XR bridge).
        WGPUSharedTextureMemoryBeginAccessDescriptor ba = {};
        ba.concurrentRead = false;
        ba.initialized = false;   // clearing fresh; xrWaitSwapchainImage already freed the image
        ba.fenceCount = 0;
        if (!wgpuSharedTextureMemoryBeginAccess(eye.mem[idx], eye.tex[idx], &ba)) {
          std::fprintf(stderr, "[vr-spike] BeginAccess failed (eye %u img %u)\n", e, idx);
          return XR_ERROR_RUNTIME_FAILURE;
        }
        WGPURenderPassColorAttachment ca = {};
        ca.view = eye.view[idx];
        ca.loadOp = WGPULoadOp_Clear;
        ca.storeOp = WGPUStoreOp_Store;
        ca.clearValue = WGPUColor{ col[0], col[1], col[2], col[3] };
#ifdef WGPU_DEPTH_SLICE_UNDEFINED
        ca.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
#endif
        WGPURenderPassDescriptor rp = {};
        rp.colorAttachmentCount = 1;
        rp.colorAttachments = &ca;
        WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(wdevice, nullptr);
        WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(enc, &rp);
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);
        WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
        wgpuQueueSubmit(dawnQueue, 1, &cmd);
        wgpuCommandBufferRelease(cmd);
        wgpuCommandEncoderRelease(enc);

        WGPUSharedTextureMemoryEndAccessState es = {};
        wgpuSharedTextureMemoryEndAccess(eye.mem[idx], eye.tex[idx], &es);
        // OpenXR waits on OUR binding queue, not Dawn's — so CPU-sync: block until Dawn's GPU work
        // is done before releasing the image back to the runtime. Simple + correct for a spike.
        {
          struct W { bool done; } w{false};
          wgpuQueueOnSubmittedWorkDone(dawnQueue,
            [](WGPUQueueWorkDoneStatus, void* ud) { static_cast<W*>(ud)->done = true; }, &w);
          for (int k = 0; k < 200000 && !w.done; ++k) { wgpuInstanceProcessEvents(winst); wgpuDeviceTick(wdevice); }
        }
        wgpuSharedTextureMemoryEndAccessStateFreeMembers(es);
#else
        // Increment 1/2: raw-D3D12 clear on our own queue (image arrives in RENDER_TARGET state).
        HR_TRY(cmdAlloc->Reset());
        HR_TRY(cmdList->Reset(cmdAlloc.Get(), nullptr));
        D3D12_CPU_DESCRIPTOR_HANDLE rtv = eye.rtvHeap->GetCPUDescriptorHandleForHeapStart();
        rtv.ptr += (SIZE_T)idx * eye.rtvStride;
        cmdList->ClearRenderTargetView(rtv, col, 0, nullptr);
        HR_TRY(cmdList->Close());
        ID3D12CommandList* lists[] = { cmdList.Get() };
        queue->ExecuteCommandLists(1, lists);
        const UINT64 signal = ++fenceVal;
        HR_TRY(queue->Signal(fence.Get(), signal));
        if (fence->GetCompletedValue() < signal) {
          HR_TRY(fence->SetEventOnCompletion(signal, fenceEvent));
          WaitForSingleObject(fenceEvent, INFINITE);
        }
#endif

        XrSwapchainImageReleaseInfo ri{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};
        XR_TRY(xrReleaseSwapchainImage(eye.handle, &ri));

        XrCompositionLayerProjectionView& pv = projViews[e];
        pv = {XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW};
        pv.pose = xrViews[e].pose;
        pv.fov  = xrViews[e].fov;
        pv.subImage.swapchain = eye.handle;
        pv.subImage.imageRect.offset = {0, 0};
        pv.subImage.imageRect.extent = {(int32_t)eye.width, (int32_t)eye.height};
      }

      layer.space = appSpace;
      layer.viewCount = (uint32_t)projViews.size();
      layer.views = projViews.data();

      if ((frame % 90) == 0) {
        const XrPosef& p = xrViews[0].pose;
        std::printf("[vr-spike] frame %ld  head pos (% .2f,% .2f,% .2f)  quat(% .2f,% .2f,% .2f,% .2f)\n",
                    frame, p.position.x, p.position.y, p.position.z,
                    p.orientation.x, p.orientation.y, p.orientation.z, p.orientation.w);
      }
    }

    XrFrameEndInfo fei{XR_TYPE_FRAME_END_INFO};
    fei.displayTime = fs.predictedDisplayTime;
    fei.environmentBlendMode = XR_ENVIRONMENT_BLEND_MODE_OPAQUE;
    const XrCompositionLayerBaseHeader* layers[] = { reinterpret_cast<XrCompositionLayerBaseHeader*>(&layer) };
    fei.layerCount = (fs.shouldRender && !projViews.empty()) ? 1u : 0u;
    fei.layers = (fei.layerCount > 0) ? layers : nullptr;
    XR_TRY(xrEndFrame(session, &fei));
    ++frame;
  }

  // 12. Teardown.
#if defined(WEBGPU_BACKEND_DAWN)
  for (auto& eye : eyes) {
    for (auto v : eye.view) if (v) wgpuTextureViewRelease(v);
    for (auto t : eye.tex)  if (t) wgpuTextureRelease(t);
    for (auto m : eye.mem)  if (m) wgpuSharedTextureMemoryRelease(m);
  }
#endif
  for (auto& eye : eyes) if (eye.handle) xrDestroySwapchain(eye.handle);
  if (appSpace) xrDestroySpace(appSpace);
  if (session)  xrDestroySession(session);
  if (fenceEvent) CloseHandle(fenceEvent);
  xrDestroyInstance(instance);
  std::printf("[vr-spike] clean exit after %ld frames.\n", frame);
  return XR_SUCCESS;
}

}  // namespace

int main() {
  std::printf("[vr-spike] OpenXR D3D12 render spike (VR P0.1) — solid-colour stereo eyes, own D3D12 device.\n");
  XrResult r = run();
  if (XR_FAILED(r)) {
    std::fprintf(stderr, "[vr-spike] FAILED (%d). See messages above.\n", (int)r);
    return 1;
  }
  return 0;
}
