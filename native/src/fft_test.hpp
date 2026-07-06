// Phase 0 exit criteria 3-5: run the ocean-FFT initial-spectrum WGSL compute
// shader natively and verify the result read back to the CPU.
#pragma once
#include <webgpu/webgpu.h>

// Dispatches the initial-spectrum compute pass, reads WavesData + H0K back, and
// checks WavesData against a CPU reimplementation of the same formula (exact,
// deterministic oracle) plus H0K for finiteness / non-zero in-band energy.
// Prints a human-readable PASS/FAIL report. Returns true on pass.
bool runInitialSpectrumTest(WGPUDevice device, WGPUQueue queue);
