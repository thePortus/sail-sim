// sail-sim native client — Phase 0 spike: Dawn (WebGPU) device bringup + clear-colour loop.
//
// This is the smallest program that proves the PORTING.md thesis on real hardware:
// a Dawn-backed WebGPU device, running on D3D12 (Windows) or Metal (macOS), driving a
// swapchain. It prints the resolved backend so you can see D3D12/Metal/Vulkan at a glance.
//
// The WebGPU C API (webgpu.h) is version-sensitive. This file targets the "classic"
// callback style shipped by the eliemichel/WebGPU-distribution `dawn` branch, where
// requestAdapter/requestDevice resolve their callbacks synchronously. If your pinned
// header differs, the two request helpers below and the surface-status check are the
// only spots likely to need a one-line reconcile — see native/README.md.

#include <webgpu/webgpu.h>
#include <glfw3webgpu.h>
#include <GLFW/glfw3.h>

#include <cstdio>
#include <cstdlib>

// ── async request helpers (resolve synchronously on Dawn/wgpu in this distribution) ──

static WGPUAdapter requestAdapterSync(WGPUInstance instance, const WGPURequestAdapterOptions* options) {
  struct Result { WGPUAdapter adapter = nullptr; bool done = false; } result;
  auto onAdapter = [](WGPURequestAdapterStatus status, WGPUAdapter adapter,
                      char const* message, void* userdata) {
    auto* r = static_cast<Result*>(userdata);
    if (status == WGPURequestAdapterStatus_Success) r->adapter = adapter;
    else std::fprintf(stderr, "[spike] requestAdapter failed: %s\n", message ? message : "(no message)");
    r->done = true;
  };
  wgpuInstanceRequestAdapter(instance, options, onAdapter, &result);
  // If a future header makes this genuinely async, pump events here instead of asserting.
  if (!result.done) std::fprintf(stderr, "[spike] requestAdapter did not resolve synchronously\n");
  return result.adapter;
}

static WGPUDevice requestDeviceSync(WGPUAdapter adapter, const WGPUDeviceDescriptor* descriptor) {
  struct Result { WGPUDevice device = nullptr; bool done = false; } result;
  auto onDevice = [](WGPURequestDeviceStatus status, WGPUDevice device,
                     char const* message, void* userdata) {
    auto* r = static_cast<Result*>(userdata);
    if (status == WGPURequestDeviceStatus_Success) r->device = device;
    else std::fprintf(stderr, "[spike] requestDevice failed: %s\n", message ? message : "(no message)");
    r->done = true;
  };
  wgpuAdapterRequestDevice(adapter, descriptor, onDevice, &result);
  if (!result.done) std::fprintf(stderr, "[spike] requestDevice did not resolve synchronously\n");
  return result.device;
}

static const char* backendTypeName(WGPUBackendType t) {
  switch (t) {
    case WGPUBackendType_D3D11:  return "D3D11";
    case WGPUBackendType_D3D12:  return "D3D12";
    case WGPUBackendType_Metal:  return "Metal";
    case WGPUBackendType_Vulkan: return "Vulkan";
    case WGPUBackendType_OpenGL: return "OpenGL";
    case WGPUBackendType_WebGPU: return "WebGPU";
    default:                     return "unknown";
  }
}

int main() {
  if (!glfwInit()) {
    std::fprintf(stderr, "[spike] glfwInit failed\n");
    return EXIT_FAILURE;
  }

  // WebGPU manages the drawing surface; tell GLFW not to create an OpenGL context.
  glfwWindowHint(GLFW_CLIENT_API, GLFW_NO_API);
  GLFWwindow* window = glfwCreateWindow(1280, 720, "sail-sim native — Phase 0 spike", nullptr, nullptr);
  if (!window) {
    std::fprintf(stderr, "[spike] glfwCreateWindow failed\n");
    glfwTerminate();
    return EXIT_FAILURE;
  }

  // 1. Instance
  WGPUInstanceDescriptor instanceDesc = {};
  WGPUInstance instance = wgpuCreateInstance(&instanceDesc);
  if (!instance) {
    std::fprintf(stderr, "[spike] wgpuCreateInstance failed\n");
    return EXIT_FAILURE;
  }

  // 2. Surface (per-OS creation hidden inside glfw3webgpu)
  WGPUSurface surface = glfwGetWGPUSurface(instance, window);

  // 3. Adapter
  WGPURequestAdapterOptions adapterOpts = {};
  adapterOpts.compatibleSurface = surface;
  adapterOpts.powerPreference = WGPUPowerPreference_HighPerformance;
  WGPUAdapter adapter = requestAdapterSync(instance, &adapterOpts);
  if (!adapter) return EXIT_FAILURE;

  // Report which native backend Dawn selected — the visible proof of the thesis.
  WGPUAdapterInfo adapterInfo = {};
  wgpuAdapterGetInfo(adapter, &adapterInfo);
  std::printf("[spike] adapter: backend=%s  vendor=%s  device=%s\n",
              backendTypeName(adapterInfo.backendType),
              adapterInfo.vendor ? adapterInfo.vendor : "?",
              adapterInfo.device ? adapterInfo.device : "?");

  // 4. Device + queue
  WGPUDeviceDescriptor deviceDesc = {};
  deviceDesc.label = "sailsim-device";
  WGPUDevice device = requestDeviceSync(adapter, &deviceDesc);
  if (!device) return EXIT_FAILURE;

  wgpuDeviceSetUncapturedErrorCallback(
    device,
    [](WGPUErrorType type, char const* message, void*) {
      std::fprintf(stderr, "[spike] uncaptured device error (%d): %s\n",
                   (int)type, message ? message : "(no message)");
    },
    nullptr);

  WGPUQueue queue = wgpuDeviceGetQueue(device);

  // 5. Configure the surface (swapchain)
  WGPUSurfaceCapabilities caps = {};
  wgpuSurfaceGetCapabilities(surface, adapter, &caps);
  WGPUTextureFormat surfaceFormat = caps.formatCount > 0 ? caps.formats[0] : WGPUTextureFormat_BGRA8Unorm;

  int fbWidth = 0, fbHeight = 0;
  glfwGetFramebufferSize(window, &fbWidth, &fbHeight);

  WGPUSurfaceConfiguration surfaceConfig = {};
  surfaceConfig.device = device;
  surfaceConfig.format = surfaceFormat;
  surfaceConfig.usage = WGPUTextureUsage_RenderAttachment;
  surfaceConfig.width = (uint32_t)fbWidth;
  surfaceConfig.height = (uint32_t)fbHeight;
  surfaceConfig.presentMode = WGPUPresentMode_Fifo;   // vsync
  surfaceConfig.alphaMode = WGPUCompositeAlphaMode_Auto;
  wgpuSurfaceConfigure(surface, &surfaceConfig);

  std::printf("[spike] surface configured: %dx%d format=%d — entering render loop\n",
              fbWidth, fbHeight, (int)surfaceFormat);

  // 6. Clear-colour render loop (a calm sea-blue, because of course)
  while (!glfwWindowShouldClose(window)) {
    glfwPollEvents();

    WGPUSurfaceTexture surfaceTex;
    wgpuSurfaceGetCurrentTexture(surface, &surfaceTex);
    if (!surfaceTex.texture) continue;  // e.g. minimised / needs reconfigure

    WGPUTextureView view = wgpuTextureCreateView(surfaceTex.texture, nullptr);

    WGPUCommandEncoderDescriptor encDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(device, &encDesc);

    WGPURenderPassColorAttachment colorAttachment = {};
    colorAttachment.view = view;
    colorAttachment.loadOp = WGPULoadOp_Clear;
    colorAttachment.storeOp = WGPUStoreOp_Store;
    colorAttachment.clearValue = WGPUColor{0.10, 0.32, 0.45, 1.0};
    colorAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;  // remove if your header predates this field

    WGPURenderPassDescriptor passDesc = {};
    passDesc.colorAttachmentCount = 1;
    passDesc.colorAttachments = &colorAttachment;

    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc);
    // Phase 1 adds the first draw here; Phase 0 just clears.
    wgpuRenderPassEncoderEnd(pass);
    wgpuRenderPassEncoderRelease(pass);

    WGPUCommandBufferDescriptor cmdDesc = {};
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(encoder, &cmdDesc);
    wgpuQueueSubmit(queue, 1, &cmd);

    wgpuCommandBufferRelease(cmd);
    wgpuCommandEncoderRelease(encoder);
    wgpuTextureViewRelease(view);

#ifndef __EMSCRIPTEN__
    wgpuSurfacePresent(surface);
#endif

    // Let Dawn/wgpu service their internal work queues each frame.
#if defined(WEBGPU_BACKEND_DAWN)
    wgpuDeviceTick(device);
#elif defined(WEBGPU_BACKEND_WGPU)
    wgpuDevicePoll(device, false, nullptr);
#endif
  }

  // 7. Teardown
  wgpuQueueRelease(queue);
  wgpuDeviceRelease(device);
  wgpuAdapterRelease(adapter);
  wgpuSurfaceRelease(surface);
  wgpuInstanceRelease(instance);
  glfwDestroyWindow(window);
  glfwTerminate();
  return EXIT_SUCCESS;
}
