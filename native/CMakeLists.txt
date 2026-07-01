cmake_minimum_required(VERSION 3.24)

# ─────────────────────────────────────────────────────────────────────────────
# sail-sim native client — Phase 0 spike
#
# Goal of this target: bring up a Dawn (WebGPU) device on Windows (D3D12) and
# macOS (Metal), open a window, and run a clear-colour render loop. This is the
# "prove the WebGPU/Dawn thesis" milestone from PORTING.md §8, exit criteria 1–2.
#
# The next spike step (exit criteria 3–5) is to run the ocean-FFT
# INITIAL_SPECTRUM WGSL compute shader and read the result back to the CPU —
# scaffolded but stubbed under shaders/ and gated behind SPIKE_RUN_COMPUTE.
# ─────────────────────────────────────────────────────────────────────────────

project(sailsim_native LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

# Put the built binary next to the fetched Dawn shared lib so it can find it at
# runtime on Windows (the distribution copies webgpu_dawn.dll beside the exe via
# target_copy_webgpu_binaries below).
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

include(FetchContent)

# ── GLFW (windowing + input) ────────────────────────────────────────────────
set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  glfw
  GIT_REPOSITORY https://github.com/glfw/glfw
  GIT_TAG        3.4
  GIT_SHALLOW    ON
)

FetchContent_MakeAvailable(glfw)

# ── WebGPU backend ───────────────────────────────────────────────────────────
# Both wgpu-native and Dawn implement the same webgpu.h C API and run the same
# WGSL natively on Metal / D3D12 / Vulkan — so our code and our WGSL are identical
# across backends.
#
#   SAILSIM_WEBGPU_BACKEND = WGPU  → wgpu-native official prebuilt (default)
#                          = DAWN  → Google's Dawn, built from source
#
# We fetch wgpu-native's OFFICIAL release zip directly (header + lib from the same
# build) rather than a third-party redistribution — a redistribution we tried
# (eliemichel/WebGPU-distribution wgpu-static-v0.19.4.1) shipped a webgpu.h whose
# enum values were out of sync with the lib it bundled, which silently corrupts
# texture formats. Fetching upstream guarantees header/lib agreement.
set(SAILSIM_WEBGPU_BACKEND "WGPU" CACHE STRING "WebGPU backend: WGPU (prebuilt) or DAWN (source)")

if (SAILSIM_WEBGPU_BACKEND STREQUAL "DAWN")
  # Dawn, from source, via Élie Michel's distribution. NOTE: on Apple Silicon this
  # still needs its vendored fuzzers (libprotobuf-mutator) disabled and an abseil
  # `-msse4.1`-on-arm64 issue resolved — see PORTING.md. Kept wired for later.
  FetchContent_Declare(webgpu
    GIT_REPOSITORY https://github.com/eliemichel/WebGPU-distribution
    GIT_TAG        dawn-6512
    GIT_SHALLOW    ON)
  FetchContent_MakeAvailable(webgpu)
else()
  # wgpu-native official prebuilt release. Classic-callback webgpu.h (matches
  # src/main.cpp) with the modern surface API.
  set(WGPU_VER "v0.19.4.1")
  if (WIN32)
    set(WGPU_ZIP "wgpu-windows-x86_64-msvc-release.zip")
  elseif (APPLE)
    if (CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
      set(WGPU_ZIP "wgpu-macos-aarch64-release.zip")
    else()
      set(WGPU_ZIP "wgpu-macos-x86_64-release.zip")
    endif()
  else()
    set(WGPU_ZIP "wgpu-linux-x86_64-release.zip")
  endif()
  FetchContent_Declare(wgpu_native
    URL "https://github.com/gfx-rs/wgpu-native/releases/download/${WGPU_VER}/${WGPU_ZIP}")
  FetchContent_MakeAvailable(wgpu_native)

  # The zip lays webgpu.h / wgpu.h at its root; arrange a `webgpu/` subdir so
  # `#include <webgpu/webgpu.h>` resolves (matches how glfw3webgpu includes it).
  set(WGPU_INC "${CMAKE_BINARY_DIR}/gen/wgpu-include")
  file(MAKE_DIRECTORY "${WGPU_INC}/webgpu")
  file(COPY "${wgpu_native_SOURCE_DIR}/webgpu.h" "${wgpu_native_SOURCE_DIR}/wgpu.h"
       DESTINATION "${WGPU_INC}/webgpu")

  add_library(webgpu INTERFACE)
  target_include_directories(webgpu INTERFACE "${WGPU_INC}")
  target_compile_definitions(webgpu INTERFACE WEBGPU_BACKEND_WGPU)
  if (WIN32)
    # Static wgpu-native on Windows needs these system libs. If linking the static
    # lib is troublesome, switch to wgpu_native.dll + wgpu_native.dll.lib and copy
    # the DLL next to the exe.
    target_link_libraries(webgpu INTERFACE
      "${wgpu_native_SOURCE_DIR}/wgpu_native.lib"
      d3dcompiler ws2_32 userenv bcrypt ntdll opengl32 dxgi d3d12 propsys runtimeobject)
  elseif (APPLE)
    target_link_libraries(webgpu INTERFACE
      "${wgpu_native_SOURCE_DIR}/libwgpu_native.a"
      "-framework Metal" "-framework MetalKit" "-framework Foundation"
      "-framework QuartzCore" "-framework CoreGraphics" "-framework IOKit" "-framework IOSurface")
  else()
    target_link_libraries(webgpu INTERFACE
      "${wgpu_native_SOURCE_DIR}/libwgpu_native.a" dl pthread m)
  endif()
  # No-op on the static build; kept so the call site in this file stays valid.
  function(target_copy_webgpu_binaries Target)
  endfunction()
endif()

# ── glfw3webgpu (creates the WGPUSurface from a GLFWwindow, per-OS) ──────────
# Hides the Win32 HWND / Cocoa CAMetalLayer / X11 differences behind one call:
# glfwGetWGPUSurface(instance, window). Links the `webgpu` target defined above.
FetchContent_Declare(
  glfw3webgpu
  GIT_REPOSITORY https://github.com/eliemichel/glfw3webgpu
  GIT_TAG        v1.2.0
  GIT_SHALLOW    ON
)
FetchContent_MakeAvailable(glfw3webgpu)

# Embed each WGSL file as a C header at configure time — single source of truth
# is the .wgsl file. Uses a raw string literal so no escaping is needed;
# reconfigure after editing a .wgsl.
set(WGSL_GEN_DIR "${CMAKE_BINARY_DIR}/gen")
file(MAKE_DIRECTORY "${WGSL_GEN_DIR}")
function(embed_wgsl SRC VARNAME OUT)
  file(READ "${SRC}" _wgsl_src)
  file(WRITE "${OUT}" "#pragma once\ninline const char* ${VARNAME} = R\"WGSL(\n${_wgsl_src})WGSL\";\n")
endfunction()
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/initial_spectrum.wgsl" INITIAL_SPECTRUM_WGSL "${WGSL_GEN_DIR}/initial_spectrum_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/triangle.wgsl"         TRIANGLE_WGSL         "${WGSL_GEN_DIR}/triangle_wgsl.h")

add_executable(sailsim_native
  src/main.cpp
  src/fft_test.cpp
)

target_include_directories(sailsim_native PRIVATE "${WGSL_GEN_DIR}")
target_link_libraries(sailsim_native PRIVATE glfw webgpu glfw3webgpu)

# The distribution defines WEBGPU_BACKEND_DAWN / _WGPU so source can branch on
# the backend (e.g. wgpuDeviceTick vs wgpuDevicePoll). It is set on the `webgpu`
# target's interface, so it propagates automatically — no manual define here.

# On Windows, Dawn ships as a shared lib; copy it next to the exe so it loads.
if (COMMAND target_copy_webgpu_binaries)
  target_copy_webgpu_binaries(sailsim_native)
endif()

# Compiler warnings — keep the spike honest.
if (MSVC)
  target_compile_options(sailsim_native PRIVATE /W4)
else()
  target_compile_options(sailsim_native PRIVATE -Wall -Wextra -Wpedantic)
endif()
