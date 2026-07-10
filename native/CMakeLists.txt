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

# Single source of truth for the client version — feeds the compiled-in SAILSIM_VERSION string (shown by
# --version, and the value Sparkle/WinSparkle will compare against the appcast) and the macOS bundle version.
set(SAILSIM_VERSION "0.1.4")

# Auto-update config: the per-platform appcast feed URLs (override for your deployment — Sparkle/WinSparkle
# require https in production) and the shared Ed25519 public key (printed by `client-release.js keygen`; the one
# key signs BOTH macOS and Windows builds). macOS bakes these into the Info.plist; Windows into compile defs.
set(SAILSIM_SPARKLE_FEED_URL     "https://CHANGEME.example/client/appcast-mac.xml" CACHE STRING "Sparkle (macOS) appcast feed URL")
set(SAILSIM_SPARKLE_FEED_URL_WIN "https://CHANGEME.example/client/appcast-win.xml" CACHE STRING "WinSparkle appcast feed URL")
set(SAILSIM_SPARKLE_PUBKEY       "tRLH7wCxtVSWI6d2lwbwliBgNoJGizATw2qG4XQSfvo=" CACHE STRING "Ed25519 public key (SUPublicEDKey / WinSparkle EdDSA)")

# Backend the client connects to (login + gameplay WebSocket + asset streaming). Baked into the build; a player
# never types a server address. SAILSIM_HOST/SAILSIM_PORT/SAILSIM_TLS env vars override at runtime (for dev).
set(SAILSIM_SERVER_HOST "localhost" CACHE STRING "Default backend host the client connects to")
set(SAILSIM_SERVER_PORT "9080"      CACHE STRING "Default backend port")
# Reverse-proxy base path for HTTP (e.g. "/api" when nginx routes the API+assets under a prefix). Empty = talk
# straight to Node. The WebSocket is never prefixed. Set to /api to match the production Angular client's apiUrl.
set(SAILSIM_SERVER_PATH ""          CACHE STRING "HTTP base path (e.g. /api behind a reverse proxy)")
option(SAILSIM_SERVER_TLS "Default to TLS (https/wss) at runtime" OFF)
# Compile TLS support (https/wss) — needs OpenSSL. On: one build speaks both http/ws and https/wss, scheme
# chosen at runtime by SAILSIM_SERVER_TLS / $SAILSIM_TLS. Off: http/ws only, no OpenSSL dependency.
option(SAILSIM_TLS "Compile TLS (https/wss) support — requires OpenSSL" ON)
if (SAILSIM_TLS)
  find_package(OpenSSL REQUIRED)
endif()

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

# ── glm (header-only math: matrices, vectors) ───────────────────────────────
FetchContent_Declare(
  glm
  GIT_REPOSITORY https://github.com/g-truc/glm
  GIT_TAG        1.0.1
  GIT_SHALLOW    ON
)
FetchContent_MakeAvailable(glm)

# ── cgltf (single-header glTF/GLB loader) ───────────────────────────────────
# SOURCE_SUBDIR points at a non-existent dir so MakeAvailable only downloads the
# header (cgltf's own CMakeLists builds test exes we don't want).
FetchContent_Declare(
  cgltf
  GIT_REPOSITORY https://github.com/jkuhlmann/cgltf
  GIT_TAG        v1.14
  GIT_SHALLOW    ON
  SOURCE_SUBDIR  do_not_configure
)
FetchContent_MakeAvailable(cgltf)

# ── Basis Universal transcoder (decodes KTX2 / KHR_texture_basisu) ───────────
# We only need the transcoder (one .cpp), not the encoder/tools — SOURCE_SUBDIR
# skips its CMakeLists. BASISD_SUPPORT_KTX2_ZSTD=0 drops the zstd dependency
# (our textures use Basis ETC1S/UASTC supercompression, not zstd).
FetchContent_Declare(
  basisu
  GIT_REPOSITORY https://github.com/BinomialLLC/basis_universal
  GIT_TAG        v1_60
  GIT_SHALLOW    ON
  SOURCE_SUBDIR  do_not_configure
)
FetchContent_MakeAvailable(basisu)

# ── stb (single-header PNG writer for headless screenshots) ──────────────────
FetchContent_Declare(
  stb
  GIT_REPOSITORY https://github.com/nothings/stb
  GIT_TAG        master
  GIT_SHALLOW    ON
  SOURCE_SUBDIR  do_not_configure
)
FetchContent_MakeAvailable(stb)

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

# VR (OpenXR) — opt-in, OFF by default. Declared HERE (before the backend fetch) because the VR
# render bridge needs Dawn built on D3D12 (see native/VR_PLAN.md), which patches the Dawn fetch below.
# The probe + OpenXR loader are wired at the end of this file.
option(SAILSIM_VR "Build the OpenXR VR probe + support" OFF)

if (SAILSIM_WEBGPU_BACKEND STREQUAL "DAWN")
  # Dawn, from source, via Élie Michel's distribution. NOTE: on Apple Silicon this
  # still needs its vendored fuzzers (libprotobuf-mutator) disabled and an abseil
  # `-msse4.1`-on-arm64 issue resolved — see PORTING.md. Kept wired for later.
  #
  # Dawn UNCONDITIONALLY builds libprotobuf-mutator (third_party/CMakeLists.txt:
  # `if(NOT TARGET libprotobuf-mutator) include(BUILD.cmake)`), a fuzzer-only dep that
  # needs protobuf we never fetch (→ "google/protobuf/any.pb.h: No such file"). Pre-define
  # the target as a stub so Dawn's guard skips it (nothing in a non-fuzzer build links it).
  if (NOT TARGET libprotobuf-mutator)
    add_library(libprotobuf-mutator INTERFACE)
  endif()

  FetchContent_Declare(webgpu
    GIT_REPOSITORY https://github.com/eliemichel/WebGPU-distribution
    GIT_TAG        dawn-6512
    GIT_SHALLOW    ON)
  if (SAILSIM_VR)
    # ⚠ Build the VR/Dawn variant with CMake 3.x (3.28–3.31), NOT CMake 4.x: enabling D3D12 pulls in
    # DirectX Shader Compiler (an old LLVM fork, chromium/6512) whose CMake uses `cmake_policy(SET
    # CMP0051 OLD)` and `cmake_minimum_required(VERSION 2.8.8)` — both removed in CMake 4.0.
    # `-DCMAKE_POLICY_VERSION_MINIMUM=3.5` only covers the min-version part, not CMP0051. Use cmake 3.31.
    #
    # The distribution builds Vulkan-only Dawn on Windows (D3D12/D3D11 OFF). VR wants the D3D12
    # OpenXR binding (it just takes an existing ID3D12Device — no Vulkan extension-injection). So
    # populate the distribution, flip its FetchDawn.cmake backend flags to D3D12, then add it.
    FetchContent_GetProperties(webgpu)
    if (NOT webgpu_POPULATED)
      FetchContent_Populate(webgpu)
    endif()
    # Patch EVERY configure (idempotent — the REPLACEs no-op once already flipped), so a reused build
    # dir also gets D3D12, and add the subdir OUTSIDE the populate guard (it must run every configure).
    set(_fd "${webgpu_SOURCE_DIR}/cmake/FetchDawn.cmake")
    file(READ "${_fd}" _fdsrc)
    string(REPLACE "set(DAWN_ENABLE_D3D11 OFF)" "set(DAWN_ENABLE_D3D11 ON)  # VR" _fdsrc "${_fdsrc}")
    # Enable D3D12 AND build DXC: with DAWN_USE_BUILT_DXC OFF (Dawn's default) the dxc headers
    # (dxcapi.h/IDxcCompiler3) are never put on the include path and the Windows 10 SDK doesn't ship
    # them, so the D3D backend fails to compile; ON adds the headers, builds DXC, and links it (our
    # compute shaders need DXC→DXIL at runtime too).
    string(REPLACE "set(DAWN_ENABLE_D3D12 OFF)"
                   "set(DAWN_ENABLE_D3D12 ON)  # VR\n\tset(DAWN_USE_BUILT_DXC ON)  # VR"
                   _fdsrc "${_fdsrc}")
    string(REPLACE "set(USE_VULKAN ON)"         "set(USE_VULKAN OFF) # VR"       _fdsrc "${_fdsrc}")
    file(WRITE "${_fd}" "${_fdsrc}")
    file(READ "${_fd}" _fdcheck)
    if (NOT _fdcheck MATCHES "DAWN_ENABLE_D3D12 ON" OR NOT _fdcheck MATCHES "DAWN_USE_BUILT_DXC ON")
      message(FATAL_ERROR "[vr] FAILED to patch Dawn to D3D12+DXC in ${_fd} — distribution strings changed?")
    endif()
    # The distribution's curated dep-fetch list (patch/tools/fetch_dawn_dependencies.py) is Vulkan-only
    # and omits the DirectX Shader Compiler, so Dawn's D3D backend can't find dxcapi.h (IDxcCompiler3).
    # Add the D3D deps so the D3D12 backend builds. (Idempotent — guarded on 'third_party/dxc'.)
    set(_fdeps "${webgpu_SOURCE_DIR}/patch/tools/fetch_dawn_dependencies.py")
    if (EXISTS "${_fdeps}")
      file(READ "${_fdeps}" _dsrc)
      if (NOT _dsrc MATCHES "third_party/dxc")
        string(REPLACE "'third_party/abseil-cpp',"
                       "'third_party/abseil-cpp',\n        'third_party/dxc',\n        'third_party/dxheaders',"
                       _dsrc "${_dsrc}")
        file(WRITE "${_fdeps}" "${_dsrc}")
      endif()
      file(READ "${_fdeps}" _dcheck)
      if (NOT _dcheck MATCHES "third_party/dxc")
        message(FATAL_ERROR "[vr] FAILED to add DXC to Dawn's fetch list in ${_fdeps}")
      endif()
    else()
      message(WARNING "[vr] ${_fdeps} not found — DXC dep may be missing; D3D build could fail")
    endif()
    message(STATUS "============================================================")
    message(STATUS "  [vr] Dawn D3D12 patch ACTIVE (D3D12 ON, Vulkan OFF, +DXC dep)")
    message(STATUS "============================================================")
    add_subdirectory("${webgpu_SOURCE_DIR}" "${webgpu_BINARY_DIR}")
    # Dawn links the `dxcompiler` target for DXC, but this old DXC doesn't export its include dir as
    # INTERFACE, so dawn_native's d3d sources can't find dxcapi.h (→ IDxcCompiler3 undeclared, cascading
    # DAWN_TRY errors). Add the DXC headers to dawn_native explicitly. Layout: .../dxc/include/dxc/dxcapi.h,
    # so add both the root (for `<dxc/dxcapi.h>`) and the dxc/ subdir (for `<dxcapi.h>`).
    if (TARGET dawn_native)
      set(_dxcinc "${CMAKE_BINARY_DIR}/_deps/dawn-src/third_party/dxc/include")
      if (EXISTS "${_dxcinc}/dxc/dxcapi.h")
        target_include_directories(dawn_native PRIVATE "${_dxcinc}" "${_dxcinc}/dxc")
        message(STATUS "[vr] added DXC headers to dawn_native: ${_dxcinc}")
      else()
        message(WARNING "[vr] DXC headers not found at ${_dxcinc}/dxc/dxcapi.h — D3D build may fail")
      endif()
      # Dawn's d3d12 code does `#include <d3d12.h>` expecting the modern DirectX-Headers version (newer
      # enums like D3D12_RESOURCE_STATE_ALL_SHADER_RESOURCE that the Win10 19041 SDK lacks), but the dep
      # isn't wired to dawn_native. Prepend DirectX-Headers so its d3d12.h shadows the SDK's (superset,
      # designed as a drop-in). include/directx holds d3d12.h; include holds directx/*.
      set(_dxh "${CMAKE_BINARY_DIR}/_deps/dawn-src/third_party/dxheaders/include")
      if (EXISTS "${_dxh}/directx/d3d12.h")
        target_include_directories(dawn_native BEFORE PRIVATE "${_dxh}/directx" "${_dxh}")
        message(STATUS "[vr] prepended DirectX-Headers to dawn_native: ${_dxh}")
      else()
        message(WARNING "[vr] DirectX-Headers not found at ${_dxh}/directx/d3d12.h — d3d12 enums may be missing")
      endif()
    endif()
  else()
    FetchContent_MakeAvailable(webgpu)
  endif()
else()
  # wgpu-native official prebuilt release. Classic-callback webgpu.h (matches
  # src/main.cpp) with the modern surface API.
  set(WGPU_VER "v0.19.4.1")
  if (WIN32)
    # NB: the v0.19.4.1 Windows asset has no toolchain suffix — it's
    # "wgpu-windows-x86_64-release.zip" (an earlier "-msvc" name 404s).
    set(WGPU_ZIP "wgpu-windows-x86_64-release.zip")
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

# ── Dear ImGui (immediate-mode UI: login screen, HUD) ───────────────────────
# ImGui ships only sources (no CMakeLists), so we compile it ourselves as a
# static lib from the core + the GLFW and WebGPU backends. v1.90.9 targets the
# classic (pre-WGPUStringView) webgpu.h that matches wgpu-native v0.19.
FetchContent_Declare(
  imgui
  GIT_REPOSITORY https://github.com/ocornut/imgui
  GIT_TAG        v1.90.9
  GIT_SHALLOW    ON
  SOURCE_SUBDIR  do_not_configure
)
FetchContent_MakeAvailable(imgui)
add_library(imgui STATIC
  "${imgui_SOURCE_DIR}/imgui.cpp"
  "${imgui_SOURCE_DIR}/imgui_draw.cpp"
  "${imgui_SOURCE_DIR}/imgui_tables.cpp"
  "${imgui_SOURCE_DIR}/imgui_widgets.cpp"
  "${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp"
  "${imgui_SOURCE_DIR}/backends/imgui_impl_wgpu.cpp"
)
target_include_directories(imgui PUBLIC "${imgui_SOURCE_DIR}" "${imgui_SOURCE_DIR}/backends")
target_link_libraries(imgui PUBLIC glfw webgpu)
# Tell the WebGPU backend which webgpu.h flavour we build against.
target_compile_definitions(imgui PUBLIC IMGUI_IMPL_WEBGPU_BACKEND_WGPU)
target_compile_options(imgui PRIVATE -w)   # third-party; don't fail our warnings

# ── cpp-httplib (header-only HTTP client for the auth REST calls) ────────────
FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib
  GIT_TAG        v0.16.3
  GIT_SHALLOW    ON
  SOURCE_SUBDIR  do_not_configure
)
FetchContent_MakeAvailable(httplib)

# ── nlohmann/json (header-only JSON parse/serialise) ────────────────────────
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json
  GIT_TAG        v3.11.3
  GIT_SHALLOW    ON
)
set(JSON_BuildTests OFF CACHE INTERNAL "")
FetchContent_MakeAvailable(nlohmann_json)

# ── IXWebSocket (raw WebSocket client for gameplay) ──────────────────────────
# TLS follows SAILSIM_TLS: on -> wss:// via OpenSSL (same backend as httplib, cross-platform); off -> ws:// only.
# zlib off to avoid the dependency (permessage-deflate is optional).
FetchContent_Declare(
  ixwebsocket
  GIT_REPOSITORY https://github.com/machinezone/IXWebSocket
  GIT_TAG        v11.4.5
  GIT_SHALLOW    ON
)
if (SAILSIM_TLS)
  set(USE_TLS ON CACHE BOOL "" FORCE)
  set(USE_OPEN_SSL ON CACHE BOOL "" FORCE)
else()
  set(USE_TLS OFF CACHE BOOL "" FORCE)
endif()
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(ixwebsocket)

# ── miniaudio (header-only audio output; the procedural ocean/rain sound beds) ─
FetchContent_Declare(
  miniaudio
  GIT_REPOSITORY https://github.com/mackron/miniaudio
  GIT_TAG        0.11.21
  GIT_SHALLOW    ON
)
FetchContent_MakeAvailable(miniaudio)

# Embed each WGSL file as a C header at configure time — single source of truth
# is the .wgsl file. Uses a raw string literal so no escaping is needed.
set(WGSL_GEN_DIR "${CMAKE_BINARY_DIR}/gen")
file(MAKE_DIRECTORY "${WGSL_GEN_DIR}")
function(embed_wgsl SRC VARNAME OUT)
  # Embedding happens at CONFIGURE time, so editing a .wgsl must re-run cmake —
  # without this dependency, shader edits silently never reach the binary.
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${SRC}")
  file(READ "${SRC}" _wgsl_src)
  # MSVC caps a single string literal at 16380 bytes (error C2026). Split the
  # shader into <16 KB raw-string chunks and let adjacent-literal concatenation
  # rejoin them — no shader contains the )WGSL delimiter, so byte-splitting is
  # safe (and UTF-8 comment bytes survive raw-string concatenation intact).
  string(LENGTH "${_wgsl_src}" _wgsl_len)
  set(_wgsl_body "")
  set(_wgsl_pos 0)
  while(_wgsl_pos LESS _wgsl_len)
    math(EXPR _wgsl_remain "${_wgsl_len} - ${_wgsl_pos}")
    if(_wgsl_remain LESS 8000)
      set(_wgsl_take ${_wgsl_remain})
    else()
      set(_wgsl_take 8000)
    endif()
    string(SUBSTRING "${_wgsl_src}" ${_wgsl_pos} ${_wgsl_take} _wgsl_piece)
    string(APPEND _wgsl_body "R\"WGSL(${_wgsl_piece})WGSL\"\n")
    math(EXPR _wgsl_pos "${_wgsl_pos} + ${_wgsl_take}")
  endwhile()
  file(WRITE "${OUT}" "#pragma once\ninline const char* ${VARNAME} =\n${_wgsl_body};\n")
endfunction()
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/initial_spectrum.wgsl" INITIAL_SPECTRUM_WGSL "${WGSL_GEN_DIR}/initial_spectrum_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/mesh.wgsl"             MESH_WGSL             "${WGSL_GEN_DIR}/mesh_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/ocean_surface.wgsl"    OCEAN_SURFACE_WGSL    "${WGSL_GEN_DIR}/ocean_surface_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/sky.wgsl"              SKY_WGSL              "${WGSL_GEN_DIR}/sky_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/terrain.wgsl"          TERRAIN_WGSL          "${WGSL_GEN_DIR}/terrain_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/sea_far.wgsl"          SEA_FAR_WGSL          "${WGSL_GEN_DIR}/sea_far_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/clouds.wgsl"           CLOUDS_WGSL           "${WGSL_GEN_DIR}/clouds_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/godrays.wgsl"          GODRAYS_WGSL          "${WGSL_GEN_DIR}/godrays_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/post.wgsl"             POST_WGSL             "${WGSL_GEN_DIR}/post_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/taa.wgsl"              TAA_WGSL              "${WGSL_GEN_DIR}/taa_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/ssr.wgsl"              SSR_WGSL              "${WGSL_GEN_DIR}/ssr_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/volumetric.wgsl"       VOLUMETRIC_WGSL       "${WGSL_GEN_DIR}/volumetric_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/lumadapt.wgsl"         LUMADAPT_WGSL         "${WGSL_GEN_DIR}/lumadapt_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/contact.wgsl"          CONTACT_WGSL          "${WGSL_GEN_DIR}/contact_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/bloom.wgsl"            BLOOM_WGSL            "${WGSL_GEN_DIR}/bloom_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/ssao.wgsl"             SSAO_WGSL             "${WGSL_GEN_DIR}/ssao_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/dof.wgsl"              DOF_WGSL              "${WGSL_GEN_DIR}/dof_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/rain.wgsl"             RAIN_WGSL             "${WGSL_GEN_DIR}/rain_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/lightning.wgsl"        LIGHTNING_WGSL        "${WGSL_GEN_DIR}/lightning_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/clouds_denoise.wgsl"   CLOUDS_DENOISE_WGSL   "${WGSL_GEN_DIR}/clouds_denoise_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/fxaa.wgsl"             FXAA_WGSL             "${WGSL_GEN_DIR}/fxaa_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/smaa.wgsl"             SMAA_WGSL             "${WGSL_GEN_DIR}/smaa_wgsl.h")

# ── UI fonts ─────────────────────────────────────────────────────────────────
# Two fonts, downloaded at configure time (kept out of git, re-fetchable) and
# embedded into the binary as byte arrays, so the .app ships self-contained with
# no runtime font file to locate:
#   body  — Inter  (clean proportional sans) for all UI text
#   title — Cinzel (Roman-inscription serif caps) for headings / the login screen
# Swap either via -DSAILSIM_FONT_*_URL. A proprietary font can use the same path
# but must NOT be redistributed in the built binary — ship it as a bundle
# resource loaded at runtime instead.
set(SAILSIM_FONT_BODY_URL
    "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf"
    CACHE STRING "URL of the TTF to embed as the body UI font")
set(SAILSIM_FONT_TITLE_URL
    "https://github.com/google/fonts/raw/main/ofl/cinzel/Cinzel%5Bwght%5D.ttf"
    CACHE STRING "URL of the TTF to embed as the title UI font")
# Icon glyphs — Font Awesome 6 Free (Solid), SIL OFL. Merged into the body atlas
# so ICON_FA_* codepoints (src/IconsFontAwesome6.h, Zlib) render inline with text.
set(SAILSIM_FONT_ICONS_URL
    "https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.2/webfonts/fa-solid-900.ttf"
    CACHE STRING "URL of the TTF to embed as the icon font")

function(fetch_font URL DEST)
  if (NOT EXISTS "${DEST}")
    message(STATUS "Downloading UI font: ${URL}")
    file(DOWNLOAD "${URL}" "${DEST}" STATUS _dl TLS_VERIFY ON)
    list(GET _dl 0 _rc)
    if (NOT _rc EQUAL 0)
      file(REMOVE "${DEST}")
      list(GET _dl 1 _err)
      message(FATAL_ERROR "UI font download failed: ${_err}")
    endif()
  endif()
endfunction()
fetch_font("${SAILSIM_FONT_BODY_URL}"  "${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/UIBody.ttf")
fetch_font("${SAILSIM_FONT_TITLE_URL}" "${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/UITitle.ttf")
fetch_font("${SAILSIM_FONT_ICONS_URL}" "${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/UIIcons.ttf")

# Emit a header with the TTF bytes as a C array (newline every 20 bytes so no
# single line is absurdly long for MSVC).
function(embed_binary SRC VARNAME OUT)
  file(READ "${SRC}" _hex HEX)
  string(REGEX REPLACE "(..)" "0x\\1," _bytes "${_hex}")
  string(REGEX REPLACE "((0x..,){20})" "\\1\n" _bytes "${_bytes}")
  file(WRITE "${OUT}"
    "#pragma once\ninline const unsigned char ${VARNAME}[] = {\n${_bytes}\n};\ninline const unsigned int ${VARNAME}_SIZE = sizeof(${VARNAME});\n")
endfunction()
embed_binary("${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/UIBody.ttf"  UI_FONT_BODY  "${WGSL_GEN_DIR}/ui_font_body.h")
embed_binary("${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/UITitle.ttf" UI_FONT_TITLE "${WGSL_GEN_DIR}/ui_font_title.h")
embed_binary("${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/UIIcons.ttf" UI_FONT_ICONS "${WGSL_GEN_DIR}/ui_font_icons.h")

add_executable(sailsim_native
  src/main.cpp
  src/fft_test.cpp
  src/gltf_mesh.cpp
  src/gltf_rig.cpp
  src/vessel_anim.cpp
  src/crew.cpp
  src/ktx2.cpp
  src/ocean_fft.cpp
  src/net_admin.cpp
  src/net_auth.cpp
  src/net_mp.cpp
  src/asset_cache.cpp
  src/netcfg.cpp
  src/paths.cpp
  src/session.cpp
  src/props_assets.cpp
  src/scatter.cpp
  src/sky_assets.cpp
  src/terrain.cpp
  src/terrain_biome.cpp
  src/audio.cpp
  src/music.cpp
  src/settings.cpp
  src/combat.cpp
  src/cannon.cpp
  src/cannon_fx.cpp
  src/prims.cpp
  src/stb_impl.cpp
  "${basisu_SOURCE_DIR}/transcoder/basisu_transcoder.cpp"
)

# The Basis transcoder TU is third-party; don't fail it on our -Werror-ish flags.
set_source_files_properties("${basisu_SOURCE_DIR}/transcoder/basisu_transcoder.cpp"
  PROPERTIES COMPILE_OPTIONS "-w")
# stb_impl.cpp is nothing but third-party stb headers (stb_image_resize2.h floods the log with hundreds of
# -Wc99-extensions notes for its NEON compound literals); silence it like the transcoder above.
set_source_files_properties(src/stb_impl.cpp PROPERTIES COMPILE_OPTIONS "-w")
set_source_files_properties(src/ktx2.cpp
  PROPERTIES COMPILE_DEFINITIONS "BASISD_SUPPORT_KTX2_ZSTD=0")
target_compile_definitions(sailsim_native PRIVATE BASISD_SUPPORT_KTX2_ZSTD=0)

target_include_directories(sailsim_native PRIVATE
  "${WGSL_GEN_DIR}" "${cgltf_SOURCE_DIR}" "${basisu_SOURCE_DIR}/transcoder" "${stb_SOURCE_DIR}"
  "${httplib_SOURCE_DIR}" "${miniaudio_SOURCE_DIR}")
get_filename_component(SAILSIM_SHIP_MODEL_PATH
  "${CMAKE_CURRENT_SOURCE_DIR}/../server/assets/geometry/merchantman.glb" ABSOLUTE)
target_compile_definitions(sailsim_native PRIVATE
  SAILSIM_ASSET_DIR="${CMAKE_CURRENT_SOURCE_DIR}/assets"
  SAILSIM_VERSION="${SAILSIM_VERSION}"
  SAILSIM_SHIP_MODEL="${SAILSIM_SHIP_MODEL_PATH}"
  SAILSIM_SERVER_HOST="${SAILSIM_SERVER_HOST}"
  SAILSIM_SERVER_PORT=${SAILSIM_SERVER_PORT}
  SAILSIM_SERVER_PATH="${SAILSIM_SERVER_PATH}")
# TLS: compile OpenSSL support into httplib (globally, so every TU sees the same Client layout) + link OpenSSL.
# The runtime default scheme is SAILSIM_SERVER_TLS ($<BOOL> -> 0/1); env $SAILSIM_TLS overrides it per launch.
if (SAILSIM_TLS)
  target_compile_definitions(sailsim_native PRIVATE
    SAILSIM_HAVE_TLS=1 CPPHTTPLIB_OPENSSL_SUPPORT=1
    SAILSIM_SERVER_TLS_DEFAULT=$<BOOL:${SAILSIM_SERVER_TLS}>)
  target_link_libraries(sailsim_native PRIVATE OpenSSL::SSL OpenSSL::Crypto)

  # DISTRIBUTION: the TLS build dynamically links OpenSSL, so a machine WITHOUT
  # OpenSSL installed fails at launch with "libssl-4-x64.dll not found". Ship the
  # OpenSSL runtime DLLs next to the exe so the zipped release is self-contained.
  if (WIN32)
    # (a) Modern path — runtime DLLs of imported shared targets (vcpkg OpenSSL, etc.).
    add_custom_command(TARGET sailsim_native POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E $<IF:$<BOOL:$<TARGET_RUNTIME_DLLS:sailsim_native>>,copy_if_different,true>
              $<TARGET_RUNTIME_DLLS:sailsim_native> $<TARGET_FILE_DIR:sailsim_native>
      COMMAND_EXPAND_LISTS
      COMMENT "Copying imported runtime DLLs (OpenSSL, …) next to the executable")
    # (b) Robust find — locate the actual libssl/libcrypto DLLs by NAME (OpenSSL 3 =
    #     *-3-x64, OpenSSL 4 = *-4-x64; some builds ship plain libssl.dll). Search the
    #     OpenSSL install dirs AND the PATH (where the running exe resolves them), so
    #     this works no matter how OpenSSL was installed (vcpkg/installer/choco/system).
    get_filename_component(_ssl_libdir "${OPENSSL_SSL_LIBRARY}" DIRECTORY)
    get_filename_component(_ssl_root   "${OPENSSL_INCLUDE_DIR}" DIRECTORY)   # <root>/include -> <root>
    set(_ssl_hints
      "${OPENSSL_ROOT_DIR}/bin" "${_ssl_root}/bin" "${_ssl_libdir}"
      "${_ssl_libdir}/../bin" "${_ssl_libdir}/../../bin" "${_ssl_libdir}/../../../bin")
    find_file(SAILSIM_LIBSSL_DLL
      NAMES libssl-4-x64.dll libssl-3-x64.dll libssl-1_1-x64.dll libssl.dll
      HINTS ${_ssl_hints} PATHS ENV PATH)
    find_file(SAILSIM_LIBCRYPTO_DLL
      NAMES libcrypto-4-x64.dll libcrypto-3-x64.dll libcrypto-1_1-x64.dll libcrypto.dll
      HINTS ${_ssl_hints} PATHS ENV PATH)
    message(STATUS "OpenSSL runtime DLLs to bundle: ssl=[${SAILSIM_LIBSSL_DLL}]  crypto=[${SAILSIM_LIBCRYPTO_DLL}]")
    if (SAILSIM_LIBSSL_DLL AND SAILSIM_LIBCRYPTO_DLL)
      add_custom_command(TARGET sailsim_native POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${SAILSIM_LIBSSL_DLL}" "${SAILSIM_LIBCRYPTO_DLL}" "$<TARGET_FILE_DIR:sailsim_native>"
        COMMENT "Copying OpenSSL DLLs next to the executable")
    else()
      message(WARNING
        "Could NOT locate the OpenSSL runtime DLLs (libssl/libcrypto) to bundle — the release will fail on "
        "machines without OpenSSL. Fix: pass -DOPENSSL_ROOT_DIR=<your OpenSSL dir> (whose bin/ holds the DLLs), "
        "or copy libssl-*-x64.dll + libcrypto-*-x64.dll into the zip beside the exe by hand.")
    endif()
  endif()
else()
  target_compile_definitions(sailsim_native PRIVATE SAILSIM_HAVE_TLS=0 SAILSIM_SERVER_TLS_DEFAULT=0)
endif()

# DISTRIBUTION: bundle the MSVC runtime (vcruntime140.dll, msvcp140.dll, …) so a
# machine without the "Visual C++ Redistributable" installed doesn't fail with the
# next missing-DLL error after OpenSSL is handled. Copied next to the exe for the zip.
if (WIN32 AND MSVC)
  set(CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS_SKIP TRUE)   # collect the paths only; we copy, not install()
  include(InstallRequiredSystemLibraries)
  if (CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS)
    add_custom_command(TARGET sailsim_native POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different ${CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS} "$<TARGET_FILE_DIR:sailsim_native>"
      COMMAND_EXPAND_LISTS
      COMMENT "Copying MSVC runtime DLLs next to the executable")
  endif()
endif()
target_link_libraries(sailsim_native PRIVATE glfw webgpu glfw3webgpu glm::glm imgui nlohmann_json::nlohmann_json ixwebsocket)

# The distribution defines WEBGPU_BACKEND_DAWN / _WGPU so source can branch on
# the backend (e.g. wgpuDeviceTick vs wgpuDevicePoll). It is set on the `webgpu`
# target's interface, so it propagates automatically — no manual define here.

# On Windows, Dawn ships as a shared lib; copy it next to the exe so it loads.
if (COMMAND target_copy_webgpu_binaries)
  target_copy_webgpu_binaries(sailsim_native)
endif()

# Compiler warnings — keep the spike honest.
if (MSVC)
  # /FIctype.h force-includes <ctype.h> into every TU: libc++ pulls isdigit/isalpha
  # in transitively but MSVC doesn't, and third-party headers (basisu transcoder,
  # stb) call them unqualified (C3861). Harmless (guarded, idempotent) elsewhere.
  target_compile_options(sailsim_native PRIVATE /W4 /FIctype.h)
  # Windows/MSVC hygiene: NOMINMAX drops the min()/max() macros that mangle
  # std::min/std::max and std::numeric_limits<>::max(); WIN32_LEAN_AND_MEAN trims
  # <windows.h>; _USE_MATH_DEFINES exposes M_PI (audio.cpp); _CRT_SECURE_NO_WARNINGS
  # silences the getenv/sscanf C4996 spam. (The far/near/small macros from the RPC
  # headers are dodged by not naming identifiers after them — see the sources.)
  target_compile_definitions(sailsim_native PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN _USE_MATH_DEFINES _CRT_SECURE_NO_WARNINGS)
  # Emit a PDB even in Release (/Zi + /DEBUG, but keep optimization) so the crash handler
  # (sailsimCrashHandler) can print function names + file:line for frames in the exe. /OPT:REF,ICF
  # undo /DEBUG's default of keeping unreferenced code. dbghelp provides SymFromAddr/SymGetLine.
  target_compile_options(sailsim_native PRIVATE /Zi)
  target_link_options(sailsim_native PRIVATE /DEBUG /OPT:REF /OPT:ICF)
  target_link_libraries(sailsim_native PRIVATE dbghelp version)   # version: DXC DLL probe (GetFileVersionInfo)
else()
  target_compile_options(sailsim_native PRIVATE -Wall -Wextra -Wpedantic)
endif()

# ── Windows: hide the console window on release ──────────────────────────────
# Dev/CI builds stay a console app so stdout/stderr (and crash logs) are visible.
# Package a release with -DSAILSIM_WINDOWS_GUI=ON to build a GUI-subsystem exe:
# double-clicking shows only the game window, no terminal. /ENTRY:mainCRTStartup
# keeps plain int main() as the entry point under /SUBSYSTEM:WINDOWS. (The macOS
# .app bundle already launches without a terminal.)
option(SAILSIM_WINDOWS_GUI "Windows: build as a GUI app (no console window) for release" OFF)
if (WIN32 AND SAILSIM_WINDOWS_GUI)
  set_target_properties(sailsim_native PROPERTIES WIN32_EXECUTABLE ON)
  target_link_options(sailsim_native PRIVATE "/ENTRY:mainCRTStartup")
endif()

# ── macOS: package as a .app bundle + Sparkle auto-updater ───────────────────
# Off by default so the dev/CI loop keeps running ./build/bin/sailsim_native (a bare executable with a no-op
# updater). Turn on with -DSAILSIM_MACOS_BUNDLE=ON to get build/bin/sailsim_native.app — a proper Cocoa app
# with an Info.plist that self-updates via Sparkle. The updater impl is picked to match: Sparkle for the
# bundle, a no-op stub otherwise.
option(SAILSIM_MACOS_BUNDLE "Build a macOS .app bundle instead of a bare executable" OFF)
if (APPLE AND SAILSIM_MACOS_BUNDLE)
  # Prebuilt (universal arm64+x86_64) Sparkle framework — a binary release, so just download + extract.
  include(FetchContent)
  FetchContent_Declare(sparkle
    URL https://github.com/sparkle-project/Sparkle/releases/download/2.6.4/Sparkle-2.6.4.tar.xz)
  FetchContent_MakeAvailable(sparkle)   # binary release, no CMakeLists — just populates ${sparkle_SOURCE_DIR}

  # Generate the Info.plist (bundle keys + the Sparkle feed/key set above).
  set(MACOSX_BUNDLE_EXECUTABLE_NAME "sailsim_native")
  set(MACOSX_BUNDLE_GUI_IDENTIFIER "us.theport.sailsim")
  set(MACOSX_BUNDLE_BUNDLE_NAME "Sail-Sim")
  set(MACOSX_BUNDLE_SHORT_VERSION_STRING "${SAILSIM_VERSION}")
  set(MACOSX_BUNDLE_BUNDLE_VERSION "${SAILSIM_VERSION}")
  set(MACOSX_BUNDLE_COPYRIGHT "© thePortus")
  configure_file("${CMAKE_CURRENT_SOURCE_DIR}/cmake/Info.plist.in"
                 "${CMAKE_CURRENT_BINARY_DIR}/Info.plist" @ONLY)

  set_target_properties(sailsim_native PROPERTIES
    MACOSX_BUNDLE ON
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_BINARY_DIR}/Info.plist"
    INSTALL_RPATH "@executable_path/../Frameworks"
    BUILD_WITH_INSTALL_RPATH ON)

  # App icon → Contents/Resources/sail-sim.icns (CFBundleIconFile in Info.plist points at it).
  set(_mac_icon "${CMAKE_CURRENT_SOURCE_DIR}/icons/sail-sim.icns")
  target_sources(sailsim_native PRIVATE "${_mac_icon}")
  set_source_files_properties("${_mac_icon}" PROPERTIES MACOSX_PACKAGE_LOCATION "Resources")

  # Sparkle: the Obj-C++ shim (ARC + framework header search path), link the framework, and embed it in the
  # bundle's Contents/Frameworks (ditto preserves the framework's version symlinks) so @rpath resolves at run.
  target_sources(sailsim_native PRIVATE src/updater_mac.mm)
  set_source_files_properties(src/updater_mac.mm PROPERTIES
    COMPILE_FLAGS "-fobjc-arc -F${sparkle_SOURCE_DIR}")
  target_compile_definitions(sailsim_native PRIVATE SAILSIM_SPARKLE=1)
  target_link_libraries(sailsim_native PRIVATE "-F${sparkle_SOURCE_DIR}" "-framework Sparkle")
  add_custom_command(TARGET sailsim_native POST_BUILD
    COMMAND ditto "${sparkle_SOURCE_DIR}/Sparkle.framework"
                  "$<TARGET_BUNDLE_CONTENT_DIR:sailsim_native>/Frameworks/Sparkle.framework"
    COMMENT "Embedding Sparkle.framework into the app bundle")

  # Deep-sign the finished bundle AFTER the framework is embedded. The linker only ad-hoc-signs the inner
  # Mach-O; the bundle itself (Info.plist, CodeResources) and the embedded Sparkle.framework stay unsealed,
  # so an Apple-Silicon *download* is rejected as "damaged", and Sparkle's nested helpers/XPC services won't
  # launch (arm64 refuses unsigned code). --deep seals inside-out: Sparkle's Autoupdate/Updater.app/XPC, the
  # framework, then the .app. Identity defaults to "-" (ad-hoc). Set SAILSIM_MACOS_SIGN_IDENTITY to a
  # "Developer ID Application: …" identity (and add --options runtime) when moving to a notarized build.
  set(SAILSIM_MACOS_SIGN_IDENTITY "-" CACHE STRING "codesign identity for the .app bundle (\"-\" = ad-hoc)")
  add_custom_command(TARGET sailsim_native POST_BUILD
    COMMAND codesign --force --deep --timestamp=none
            --sign "${SAILSIM_MACOS_SIGN_IDENTITY}" "$<TARGET_BUNDLE_DIR:sailsim_native>"
    COMMENT "Deep-signing the app bundle (identity: ${SAILSIM_MACOS_SIGN_IDENTITY})")

elseif (WIN32)
  # Windows always ships the updater (the .exe IS the distributable — no bundle concept). WinSparkle 0.9.3+
  # shares Sparkle's appcast format + Ed25519 signatures, so the same signing key covers both platforms.
  include(FetchContent)
  FetchContent_Declare(winsparkle
    URL https://github.com/vslavik/winsparkle/releases/download/v0.9.3/WinSparkle-0.9.3.zip)
  FetchContent_MakeAvailable(winsparkle)   # prebuilt DLL/import-lib, no CMakeLists — just populates
  # The zip carries a versioned top dir; tolerate CMake stripping it or not.
  set(_ws "${winsparkle_SOURCE_DIR}")
  if (EXISTS "${_ws}/WinSparkle-0.9.3/include/winsparkle.h")
    set(_ws "${_ws}/WinSparkle-0.9.3")
  endif()
  # Arch subdir in the release zip: x64/Release (default), ARM64/Release, or Release (32-bit x86).
  set(SAILSIM_WINSPARKLE_ARCHDIR "x64/Release" CACHE STRING "WinSparkle prebuilt arch subdir")

  # App icon: the .rc (references icons/sail-sim.ico) is compiled by the RC compiler and linked
  # into the .exe, so Explorer/taskbar/Alt-Tab show it. project() only enables C/CXX, so enable RC
  # explicitly (portable across the VS and Ninja generators) before adding the resource script.
  enable_language(RC)
  target_sources(sailsim_native PRIVATE src/updater_win.cpp icons/app.rc)
  target_compile_definitions(sailsim_native PRIVATE SAILSIM_WINSPARKLE=1
    SAILSIM_SPARKLE_FEED_URL_WIN="${SAILSIM_SPARKLE_FEED_URL_WIN}"
    SAILSIM_SPARKLE_PUBKEY="${SAILSIM_SPARKLE_PUBKEY}")
  target_include_directories(sailsim_native PRIVATE "${_ws}/include")
  target_link_libraries(sailsim_native PRIVATE "${_ws}/${SAILSIM_WINSPARKLE_ARCHDIR}/WinSparkle.lib")
  add_custom_command(TARGET sailsim_native POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${_ws}/${SAILSIM_WINSPARKLE_ARCHDIR}/WinSparkle.dll" "$<TARGET_FILE_DIR:sailsim_native>"
    COMMENT "Copying WinSparkle.dll next to the executable")

else()
  target_sources(sailsim_native PRIVATE src/updater_stub.cpp)
endif()

# ── VR (OpenXR) — opt-in, OFF by default ─────────────────────────────────────
# See native/VR_PLAN.md. Head-tracked stereo via OpenXR; targeting OpenXR once makes
# Meta Link, Virtual Desktop (VDXR), and SteamVR all work with no runtime-specific code.
#
# P0.0: a standalone probe (src/vr_probe.cpp) that brings up an OpenXR instance and reports the
# runtime, HMD, per-eye resolution, and available graphics-binding extensions. It creates NO session
# and needs NO graphics API or Dawn, so it builds on any WebGPU backend / OS and links only the OpenXR
# loader. The real per-eye render bridge (Dawn ↔ D3D12 XR swapchain) needs the Dawn backend built on
# D3D12 — enable both:  cmake -S native -B build-win-vr -DSAILSIM_WEBGPU_BACKEND=DAWN -DSAILSIM_VR=ON
# (SAILSIM_VR is declared up by the WebGPU-backend section, which applies the Dawn→D3D12 patch.)
if (SAILSIM_VR)
  # Upstream loader + headers (like wgpu-native, we fetch the source of truth, not a
  # redistribution). Builds the openxr_loader target; disable its tests/api-layers.
  set(BUILD_TESTS       OFF CACHE BOOL "" FORCE)
  set(BUILD_API_LAYERS  OFF CACHE BOOL "" FORCE)
  set(BUILD_CONFORMANCE_TESTS OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(openxr
    GIT_REPOSITORY https://github.com/KhronosGroup/OpenXR-SDK
    GIT_TAG        release-1.1.61
    GIT_SHALLOW    ON)
  FetchContent_MakeAvailable(openxr)

  add_executable(sailsim_vr_probe src/vr_probe.cpp)
  target_link_libraries(sailsim_vr_probe PRIVATE openxr_loader)
  # openxr_loader usually propagates its include dir; add it explicitly in case it doesn't.
  target_include_directories(sailsim_vr_probe PRIVATE "${openxr_SOURCE_DIR}/include")
  message(STATUS "SAILSIM_VR ON — building sailsim_vr_probe (OpenXR ${openxr_SOURCE_DIR})")

  # Dawn's D3D12 backend loads dxcompiler.dll (+ dxil.dll, for shader signing) at RUNTIME via
  # LoadLibrary from the exe dir. They build to ${CMAKE_BINARY_DIR}/$<CONFIG>/, not next to the exe,
  # so D3D12 init fails ("DXC dlls were built, but are not available") and Dawn falls back to D3D11 —
  # whose swapchain never produces a surface texture (white screen, GetCurrentTexture null forever).
  #
  # BUT: Dawn's own DXC build produces an open-source dxil.dll that Dawn rejects as too old (< 1.6),
  # so even copying its built DLLs still fails the "DXC available" check and drops to D3D11. The fix
  # is to ship the dxcompiler.dll + dxil.dll from a DirectXShaderCompiler GitHub *release* (signed,
  # >= 1.6). Point -DSAILSIM_DXC_DLL_DIR at the folder holding those two DLLs and they win; otherwise
  # we fall back to Dawn's built ones (which will drop to D3D11 — a loud warning says so).
  # SAILSIM_DXC_DLL_DIR: explicit override (empty by default). When empty we fall back to the
  # DLLs vendored in the repo (native/third_party/dxc/bin/x64) so the VR build works out of the
  # box. A LOCAL var derives the effective dir so a stale empty cache entry can't defeat the
  # vendored default (a CACHE default wouldn't override an already-cached "").
  set(SAILSIM_DXC_DLL_DIR "" CACHE PATH
      "Override folder with a release dxcompiler.dll + dxil.dll (~1.8/1.9.x) for Dawn D3D12 (blank = vendored)")
  set(_dxc_dll_dir "${SAILSIM_DXC_DLL_DIR}")
  if (NOT _dxc_dll_dir)
    set(_dxc_dll_dir "${CMAKE_CURRENT_SOURCE_DIR}/third_party/dxc/bin/x64")   # vendored default
  endif()
  if (EXISTS "${_dxc_dll_dir}/dxil.dll")
    add_custom_command(TARGET sailsim_native POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
              "${_dxc_dll_dir}/dxcompiler.dll" "$<TARGET_FILE_DIR:sailsim_native>"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
              "${_dxc_dll_dir}/dxil.dll" "$<TARGET_FILE_DIR:sailsim_native>"
      COMMENT "Copying RELEASE DXC DLLs from ${_dxc_dll_dir} next to the exe (Dawn D3D12)")
    message(STATUS "[vr] DXC runtime DLLs sourced from ${_dxc_dll_dir}")
  elseif (TARGET dxcompiler AND TARGET sailsim_native)
    add_custom_command(TARGET sailsim_native POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
              "$<TARGET_FILE:dxcompiler>" "$<TARGET_FILE_DIR:sailsim_native>"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
              "$<TARGET_FILE_DIR:dxcompiler>/dxil.dll" "$<TARGET_FILE_DIR:sailsim_native>"
      COMMENT "Copying Dawn's BUILT DXC DLLs next to the exe (WILL likely drop to D3D11 — vendor release DLLs)")
    message(WARNING "[vr] No release DXC DLLs found at ${_dxc_dll_dir} — copying Dawn's built dxil.dll, which Dawn "
                    "rejects as too old → D3D12 init fails and falls back to D3D11 (white screen). Drop a release "
                    "dxcompiler.dll + dxil.dll (~1.8/1.9.x) into native/third_party/dxc/bin/x64 (see its README).")
  endif()
endif()
