# Vendored DirectX Shader Compiler runtime DLLs (Windows / Dawn-D3D12 VR build)

Dawn's D3D12 backend (`SAILSIM_WEBGPU_BACKEND=DAWN`, `SAILSIM_VR=ON`) loads
`dxcompiler.dll` + `dxil.dll` at **runtime** to compile WGSL→HLSL→DXIL and to
**sign** the DXIL (D3D12 rejects unsigned shaders). Dawn requires a real DXC
release pair (version ~`1.8`/`1.9.x`). The Windows SDK's `dxil.dll`
(`10.0.19041.x`) is **too old** — Dawn prints *"DXC dlls were built, but are not
available"* and silently falls back to the D3D11 backend, whose swapchain never
produces a surface texture → **white screen**.

## What goes here

Drop the two DLLs from a DirectXShaderCompiler release into **this folder**:

- `dxcompiler.dll`
- `dxil.dll`

Get them from a release zip: https://github.com/microsoft/DirectXShaderCompiler/releases
→ `bin/x64/dxcompiler.dll` and `bin/x64/dxil.dll`. Confirm the version is a DXC
one (`~1.8`/`1.9.xxxx`), **not** `10.0.19041.x`:

```powershell
(Get-Item dxil.dll).VersionInfo.FileVersion   # want 1.8.xxxx / 1.9.xxxx, NOT 10.0.19041
```

These two DLLs are **committed to the repo** (MIT-licensed, redistributable) so
the VR build works out of the box. `CMakeLists.txt` defaults
`SAILSIM_DXC_DLL_DIR` to this folder and the POST_BUILD step copies both next to
`sailsim_native.exe` on every build. Override `-DSAILSIM_DXC_DLL_DIR=<dir>` to
use a different copy.
