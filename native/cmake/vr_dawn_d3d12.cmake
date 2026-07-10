# Portable patch (run via `cmake -P`): flip the eliemichel WebGPU-distribution's Dawn
# backend selection to D3D12 for the VR build. The distribution defaults Windows Dawn to
# Vulkan with D3D11/D3D12 OFF; OpenXR's D3D12 binding is far friendlier than Vulkan
# (no VkInstance/VkDevice extension-injection), so we build Dawn on D3D12 instead.
#   -DFETCHDAWN=<path to distribution/cmake/FetchDawn.cmake>
file(READ "${FETCHDAWN}" _src)
string(REPLACE "set(DAWN_ENABLE_D3D11 OFF)" "set(DAWN_ENABLE_D3D11 ON)  # VR patch" _src "${_src}")
string(REPLACE "set(DAWN_ENABLE_D3D12 OFF)" "set(DAWN_ENABLE_D3D12 ON)  # VR patch" _src "${_src}")
string(REPLACE "set(USE_VULKAN ON)"         "set(USE_VULKAN OFF) # VR patch" _src "${_src}")
file(WRITE "${FETCHDAWN}" "${_src}")
message(STATUS "[vr] patched Dawn backend selection to D3D12 in ${FETCHDAWN}")
