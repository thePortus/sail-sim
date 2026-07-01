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

# ── WebGPU backend ───────────────────────────────────────────────────────────
# Élie Michel's WebGPU-distribution exposes a single `webgpu` CMake target and a
# consistent webgpu.h C API regardless of which implementation backs it — so our
# code and (crucially) our WGSL are identical across backends.
#
#   SAILSIM_WEBGPU_BACKEND = WGPU  → wgpu-native, prebuilt (default; fast, robust)
#                          = DAWN  → Google's Dawn, built from source
#
# Why WGPU is the spike default: both implement WebGPU and run WGSL natively on
# Metal / D3D12 / Vulkan, so the "our WGSL ports 1:1" thesis is validated either
# way. But building Dawn from source through CMake 4.x on Apple Silicon currently
# trips over its vendored fuzzers (libprotobuf-mutator) and an abseil `-msse4.1`
# flag on arm64 — a build-config rabbit hole that proves nothing extra. wgpu is a
# prebuilt binary: it links in seconds. The production backend choice (Dawn vs
# wgpu) stays open — see PORTING.md — and DAWN here keeps that path wired up.
set(SAILSIM_WEBGPU_BACKEND "WGPU" CACHE STRING "WebGPU backend: WGPU (prebuilt) or DAWN (source)")

if (SAILSIM_WEBGPU_BACKEND STREQUAL "DAWN")
  # Dawn, from source. NOTE: on Apple Silicon this still needs DAWN_BUILD_TESTS
  # disabled at the distribution level and the abseil arm64 flag issue resolved.
  set(WEBGPU_DIST_TAG "dawn-6512")
else()
  # wgpu-native, prebuilt. v0.19.4.1 ships the classic-callback webgpu.h that
  # src/main.cpp targets, with the modern surface API.
  set(WEBGPU_DIST_TAG "wgpu-static-v0.19.4.1")
endif()

FetchContent_Declare(
  webgpu
  GIT_REPOSITORY https://github.com/eliemichel/WebGPU-distribution
  GIT_TAG        ${WEBGPU_DIST_TAG}
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
