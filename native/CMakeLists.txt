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

# ── WebGPU via Dawn ──────────────────────────────────────────────────────────
# Élie Michel's WebGPU-distribution exposes a single `webgpu` CMake target and a
# consistent webgpu.h C API across backends. The `dawn` branch bundles Google's
# Dawn (the same implementation Chrome ships), compiling to D3D12 / Metal / Vulkan.
#
# NOTE: this pins a moving branch. If the first configure fails on the GIT_TAG,
# the upstream branch names are typically one of: `dawn`, `main`, `wgpu`. See
# https://github.com/eliemichel/WebGPU-distribution and README.md "Troubleshooting".
#
# vcpkg alternative (if you prefer a package manager): add `dawn` to a
# vcpkg.json manifest and replace this block + the glfw3webgpu block with
# `find_package(dawn CONFIG REQUIRED)`. It is heavier to get green on both OSes,
# which is why the spike defaults to FetchContent.
FetchContent_Declare(
  webgpu
  GIT_REPOSITORY https://github.com/eliemichel/WebGPU-distribution
  GIT_TAG        dawn
  GIT_SHALLOW    ON
)

# ── glfw3webgpu (creates the WGPUSurface from a GLFWwindow, per-OS) ──────────
# This is the piece that hides the Win32 HWND / Cocoa CAMetalLayer / X11
# differences behind one call: glfwGetWGPUSurface(instance, window).
FetchContent_Declare(
  glfw3webgpu
  GIT_REPOSITORY https://github.com/eliemichel/glfw3webgpu
  GIT_TAG        v1.2.0
  GIT_SHALLOW    ON
)

FetchContent_MakeAvailable(glfw webgpu glfw3webgpu)

add_executable(sailsim_native
  src/main.cpp
)

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
