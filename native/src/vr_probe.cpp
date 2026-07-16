// ── OpenXR probe (VR P0.0) ───────────────────────────────────────────────────
//
// A standalone diagnostic that brings up an OpenXR *instance* (no session, no
// graphics binding, no Dawn) and reports:
//   • the active OpenXR runtime (name + version)          → confirms Link / Virtual Desktop / SteamVR is reachable
//   • the head-mounted system + its properties            → confirms an HMD is present
//   • the per-eye recommended/max render resolution       → the target size for the eye swapchains
//   • which graphics-binding extensions the runtime offers → decides the WebGPU↔native bridge (D3D12 vs D3D11 vs Vulkan)
//   • available environment blend modes + reference spaces
//
// Because it never creates a session, it needs NO graphics API and links only the
// OpenXR loader — so it builds on any WebGPU backend and on any OS (it just reports
// "no runtime" where none is installed, e.g. macOS). Run it on Windows with Meta
// Link or Virtual Desktop active. This retires the "does the loader integrate and
// see the runtime" risk before we touch the hard per-eye render bridge (see VR_PLAN.md).
//
// Build:  cmake -S native -B native/build -DSAILSIM_VR=ON  &&  cmake --build native/build --target sailsim_vr_probe
// Run:    ./sailsim_vr_probe

#include <openxr/openxr.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

// xrResultToString needs an instance; before we have one (e.g. xrCreateInstance itself
// failing), map the common codes by hand so the message is legible, else the raw int.
std::string resStr(XrInstance instance, XrResult r) {
  if (instance != XR_NULL_HANDLE) {
    char buf[XR_MAX_RESULT_STRING_SIZE] = {0};
    if (XR_SUCCEEDED(xrResultToString(instance, r, buf)) && buf[0]) { return buf; }
  }
  switch (r) {
    case XR_ERROR_VALIDATION_FAILURE:       return "XR_ERROR_VALIDATION_FAILURE";
    case XR_ERROR_RUNTIME_FAILURE:          return "XR_ERROR_RUNTIME_FAILURE";
    case XR_ERROR_OUT_OF_MEMORY:            return "XR_ERROR_OUT_OF_MEMORY";
    case XR_ERROR_API_VERSION_UNSUPPORTED:  return "XR_ERROR_API_VERSION_UNSUPPORTED";
    case XR_ERROR_INITIALIZATION_FAILED:    return "XR_ERROR_INITIALIZATION_FAILED";
    case XR_ERROR_EXTENSION_NOT_PRESENT:    return "XR_ERROR_EXTENSION_NOT_PRESENT";
    case XR_ERROR_FORM_FACTOR_UNAVAILABLE:  return "XR_ERROR_FORM_FACTOR_UNAVAILABLE";
    case XR_ERROR_RUNTIME_UNAVAILABLE:      return "XR_ERROR_RUNTIME_UNAVAILABLE";
    default:                                return std::to_string(static_cast<int>(r));
  }
}

#define XR_TRY(instance, call)                                                        \
  do {                                                                                \
    XrResult _r = (call);                                                             \
    if (XR_FAILED(_r)) {                                                              \
      std::fprintf(stderr, "[vr-probe] %s FAILED: %s\n", #call,                       \
                   resStr(instance, _r).c_str());                                     \
      return _r;                                                                      \
    }                                                                                 \
  } while (0)

// Report whether a named extension is advertised by the active runtime.
bool hasExt(const std::vector<XrExtensionProperties>& exts, const char* name) {
  for (const auto& e : exts) {
    if (std::strcmp(e.extensionName, name) == 0) { return true; }
  }
  return false;
}

XrResult run() {
  // 1. Which instance extensions does the active runtime advertise? (No instance needed yet.)
  //    This is the first runtime call, so a missing/asleep runtime surfaces here.
  uint32_t extCount = 0;
  {
    XrResult r = xrEnumerateInstanceExtensionProperties(nullptr, 0, &extCount, nullptr);
    if (r == XR_ERROR_RUNTIME_UNAVAILABLE || r == XR_ERROR_INSTANCE_LOST || XR_FAILED(r)) {
      std::fprintf(stderr, "[vr-probe] no active OpenXR runtime (%s).\n", resStr(XR_NULL_HANDLE, r).c_str());
      std::fprintf(stderr, "[vr-probe] → Start Meta Link / Virtual Desktop / SteamVR (and set it as the active "
                           "OpenXR runtime), put the headset on, and retry. Expected on macOS (no runtime).\n");
      return r;
    }
  }
  std::vector<XrExtensionProperties> exts(extCount, {XR_TYPE_EXTENSION_PROPERTIES});
  XR_TRY(XR_NULL_HANDLE,
         xrEnumerateInstanceExtensionProperties(nullptr, extCount, &extCount, exts.data()));

  std::printf("[vr-probe] %u instance extensions advertised by the runtime.\n", extCount);
  // The graphics-binding extensions are what decide our WebGPU↔native bridge.
  struct { const char* ext; const char* note; } bindings[] = {
    {"XR_KHR_D3D12_enable",       "D3D12 binding  — preferred (share Dawn's D3D12 device / import XR textures)"},
    {"XR_KHR_D3D11_enable",       "D3D11 binding  — fallback (own D3D11 device, DXGI-share into Dawn)"},
    {"XR_KHR_vulkan_enable2",     "Vulkan binding — alt path if Dawn runs its Vulkan backend"},
    {"XR_KHR_opengl_enable",      "OpenGL binding — not used"},
    {"XR_FB_foveation",           "fixed foveation (perf, later)"},
    {"XR_FB_composition_layer_image_layout", "layer layout (HUD quad, later)"},
  };
  std::printf("[vr-probe] graphics-binding & useful extensions:\n");
  for (const auto& b : bindings) {
    std::printf("           [%s] %-40s  %s\n", hasExt(exts, b.ext) ? "yes" : " no", b.ext, b.note);
  }

  // 2. Create an instance. We enable NO extensions — pure enumeration works without a
  //    graphics binding, and enabling one we can't back would only fail creation.
  XrInstanceCreateInfo ci{XR_TYPE_INSTANCE_CREATE_INFO};
  std::snprintf(ci.applicationInfo.applicationName, XR_MAX_APPLICATION_NAME_SIZE, "%s", "sailsim-vr-probe");
  ci.applicationInfo.applicationVersion = 1;
  std::snprintf(ci.applicationInfo.engineName, XR_MAX_ENGINE_NAME_SIZE, "%s", "sailsim");
  ci.applicationInfo.engineVersion = 1;
  // Request OpenXR 1.0 (not XR_CURRENT_API_VERSION from the SDK headers): many runtimes still
  // cap at 1.0.x and reject a 1.1 request with XR_ERROR_API_VERSION_UNSUPPORTED. We use no
  // 1.1-only features, and every runtime supports 1.0 — so 1.0 is the maximally compatible ask.
  ci.applicationInfo.apiVersion = XR_MAKE_VERSION(1, 0, 0);

  XrInstance instance = XR_NULL_HANDLE;
  {
    XrResult r = xrCreateInstance(&ci, &instance);
    if (XR_FAILED(r)) {
      std::fprintf(stderr, "[vr-probe] xrCreateInstance FAILED: %s\n", resStr(XR_NULL_HANDLE, r).c_str());
      if (r == XR_ERROR_API_VERSION_UNSUPPORTED) {
        std::fprintf(stderr, "[vr-probe] → runtime rejected the requested OpenXR API version.\n");
      } else {
        std::fprintf(stderr, "[vr-probe] → runtime present but instance creation failed (see loader errors above).\n");
      }
      return r;
    }
  }

  XrInstanceProperties ip{XR_TYPE_INSTANCE_PROPERTIES};
  XR_TRY(instance, xrGetInstanceProperties(instance, &ip));
  std::printf("[vr-probe] runtime: \"%s\"  version %u.%u.%u\n", ip.runtimeName,
              XR_VERSION_MAJOR(ip.runtimeVersion), XR_VERSION_MINOR(ip.runtimeVersion),
              XR_VERSION_PATCH(ip.runtimeVersion));

  // 3. Find the head-mounted system.
  XrSystemGetInfo sgi{XR_TYPE_SYSTEM_GET_INFO};
  sgi.formFactor = XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
  XrSystemId systemId = XR_NULL_SYSTEM_ID;
  {
    XrResult r = xrGetSystem(instance, &sgi, &systemId);
    if (r == XR_ERROR_FORM_FACTOR_UNAVAILABLE) {
      std::fprintf(stderr, "[vr-probe] runtime is up but NO HMD is connected/awake. Put the headset on and retry.\n");
      xrDestroyInstance(instance);
      return r;
    }
    if (XR_FAILED(r)) { std::fprintf(stderr, "[vr-probe] xrGetSystem FAILED: %s\n", resStr(instance, r).c_str());
                        xrDestroyInstance(instance); return r; }
  }

  XrSystemProperties sp{XR_TYPE_SYSTEM_PROPERTIES};
  XR_TRY(instance, xrGetSystemProperties(instance, systemId, &sp));
  std::printf("[vr-probe] system: \"%s\"  (vendorId %u)\n", sp.systemName, sp.vendorId);
  std::printf("           max swapchain image: %u x %u, %u layers\n",
              sp.graphicsProperties.maxSwapchainImageWidth,
              sp.graphicsProperties.maxSwapchainImageHeight,
              sp.graphicsProperties.maxLayerCount);
  std::printf("           orientation tracking: %s, position tracking: %s\n",
              sp.trackingProperties.orientationTracking ? "yes" : "no",
              sp.trackingProperties.positionTracking ? "yes" : "no");

  // 4. Per-eye render target sizing (PRIMARY_STEREO = 2 views).
  uint32_t viewCount = 0;
  XR_TRY(instance, xrEnumerateViewConfigurationViews(
                       instance, systemId, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 0, &viewCount, nullptr));
  std::vector<XrViewConfigurationView> views(viewCount, {XR_TYPE_VIEW_CONFIGURATION_VIEW});
  XR_TRY(instance, xrEnumerateViewConfigurationViews(
                       instance, systemId, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO,
                       viewCount, &viewCount, views.data()));
  std::printf("[vr-probe] PRIMARY_STEREO: %u views\n", viewCount);
  for (uint32_t i = 0; i < viewCount; ++i) {
    const auto& v = views[i];
    std::printf("           eye %u: recommended %u x %u (max %u x %u), sampleCount %u\n", i,
                v.recommendedImageRectWidth, v.recommendedImageRectHeight,
                v.maxImageRectWidth, v.maxImageRectHeight, v.recommendedSwapchainSampleCount);
  }

  // 5. Environment blend modes (opaque expected for VR) + reference spaces (seated origin).
  uint32_t blendCount = 0;
  XR_TRY(instance, xrEnumerateEnvironmentBlendModes(
                       instance, systemId, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 0, &blendCount, nullptr));
  std::vector<XrEnvironmentBlendMode> blends(blendCount);
  XR_TRY(instance, xrEnumerateEnvironmentBlendModes(
                       instance, systemId, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO,
                       blendCount, &blendCount, blends.data()));
  std::printf("[vr-probe] environment blend modes:");
  for (auto b : blends) {
    std::printf(" %s", b == XR_ENVIRONMENT_BLEND_MODE_OPAQUE ? "OPAQUE"
                     : b == XR_ENVIRONMENT_BLEND_MODE_ADDITIVE ? "ADDITIVE"
                     : b == XR_ENVIRONMENT_BLEND_MODE_ALPHA_BLEND ? "ALPHA_BLEND" : "?");
  }
  std::printf("\n");

  std::printf("[vr-probe] OK — OpenXR up, HMD detected, sizing known. Bridge decision: "
              "use the first 'yes' graphics binding above (prefer D3D12).\n");
  xrDestroyInstance(instance);
  return XR_SUCCESS;
}

}  // namespace

int main() {
  std::printf("[vr-probe] OpenXR probe (VR P0.0) — no session, no graphics binding.\n");
  XrResult r = run();
  if (XR_FAILED(r)) {
    std::fprintf(stderr, "[vr-probe] probe failed (%d). See messages above.\n", static_cast<int>(r));
    return 1;
  }
  std::printf("[vr-probe] done.\n");
  return 0;
}
