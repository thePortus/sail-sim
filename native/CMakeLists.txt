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
# TLS off for now (dev server is ws://localhost); for the wss:// production
# endpoint, rebuild with -DUSE_TLS=ON (SecureTransport on macOS, OpenSSL/mbedTLS
# elsewhere). zlib off to avoid the dependency (permessage-deflate is optional).
FetchContent_Declare(
  ixwebsocket
  GIT_REPOSITORY https://github.com/machinezone/IXWebSocket
  GIT_TAG        v11.4.5
  GIT_SHALLOW    ON
)
set(USE_TLS OFF CACHE BOOL "" FORCE)
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
# is the .wgsl file. Uses a raw string literal so no escaping is needed;
# reconfigure after editing a .wgsl.
set(WGSL_GEN_DIR "${CMAKE_BINARY_DIR}/gen")
file(MAKE_DIRECTORY "${WGSL_GEN_DIR}")
function(embed_wgsl SRC VARNAME OUT)
  file(READ "${SRC}" _wgsl_src)
  file(WRITE "${OUT}" "#pragma once\ninline const char* ${VARNAME} = R\"WGSL(\n${_wgsl_src})WGSL\";\n")
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
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/bloom.wgsl"            BLOOM_WGSL            "${WGSL_GEN_DIR}/bloom_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/ssao.wgsl"             SSAO_WGSL             "${WGSL_GEN_DIR}/ssao_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/dof.wgsl"              DOF_WGSL              "${WGSL_GEN_DIR}/dof_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/rain.wgsl"             RAIN_WGSL             "${WGSL_GEN_DIR}/rain_wgsl.h")
embed_wgsl("${CMAKE_CURRENT_SOURCE_DIR}/shaders/clouds_denoise.wgsl"   CLOUDS_DENOISE_WGSL   "${WGSL_GEN_DIR}/clouds_denoise_wgsl.h")

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

add_executable(sailsim_native
  src/main.cpp
  src/fft_test.cpp
  src/gltf_mesh.cpp
  src/ktx2.cpp
  src/ocean_fft.cpp
  src/net_admin.cpp
  src/net_auth.cpp
  src/net_mp.cpp
  src/session.cpp
  src/props_assets.cpp
  src/scatter.cpp
  src/sky_assets.cpp
  src/terrain.cpp
  src/terrain_biome.cpp
  src/audio.cpp
  src/stb_impl.cpp
  "${basisu_SOURCE_DIR}/transcoder/basisu_transcoder.cpp"
)

# The Basis transcoder TU is third-party; don't fail it on our -Werror-ish flags.
set_source_files_properties("${basisu_SOURCE_DIR}/transcoder/basisu_transcoder.cpp"
  PROPERTIES COMPILE_OPTIONS "-w")
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
  SAILSIM_SHIP_MODEL="${SAILSIM_SHIP_MODEL_PATH}")
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
  target_compile_options(sailsim_native PRIVATE /W4)
else()
  target_compile_options(sailsim_native PRIVATE -Wall -Wextra -Wpedantic)
endif()

# ── macOS: package as a .app bundle ──────────────────────────────────────────
# Off by default so the dev/CI loop keeps running ./build/bin/sailsim_native.
# Turn on with -DSAILSIM_MACOS_BUNDLE=ON to get build/bin/sailsim_native.app —
# a proper Cocoa app with an Info.plist (Retina-capable, dock name, bundle id).
option(SAILSIM_MACOS_BUNDLE "Build a macOS .app bundle instead of a bare executable" OFF)
if (APPLE AND SAILSIM_MACOS_BUNDLE)
  set_target_properties(sailsim_native PROPERTIES
    MACOSX_BUNDLE ON
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/cmake/Info.plist.in"
    MACOSX_BUNDLE_BUNDLE_NAME "Sail-Sim"
    MACOSX_BUNDLE_GUI_IDENTIFIER "us.theport.sailsim"
    MACOSX_BUNDLE_BUNDLE_VERSION "0.1.0"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "0.1.0"
    MACOSX_BUNDLE_COPYRIGHT "© thePortus")
endif()
