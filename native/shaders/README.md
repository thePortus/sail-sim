# shaders/

WGSL lives here as we port it from the browser client. Nothing is wired into `main.cpp` yet —
this is the recipe for **Phase 0 exit criteria 3–5** (run one existing compute shader + read it back).

## First shader to port: ocean-FFT initial spectrum

Source: `INITIAL_SPECTRUM_WGSL` in
[`../../client/src/app/sailing/services/ocean-fft/wgsl.ts`](../../client/src/app/sailing/services/ocean-fft/wgsl.ts).
Copy it here verbatim as `initial_spectrum.wgsl` — the point of the spike is that it needs **no**
changes to run under Dawn. Entry point: `calculateInitialSpectrum`, `@workgroup_size(8,8,1)`.

### Bind group 0 layout (must match the WGSL exactly)

| Binding | Name | Type | Direction | Notes |
|:--:|---|---|---|---|
| 1 | `WavesData` | storage texture `rgba32float` | write | output: wave vector, 1/‖k‖, ω |
| 2 | `H0K` | storage texture `rg32float` | write | output: initial spectrum h0(k) |
| 4 | `Noise` | `texture_2d<f32>` (sampled) | read | input: gaussian noise, one texel per cell |
| 5 | `params` | uniform buffer | read | see struct below |
| 6 | `spectrums` | storage buffer (read) | read | `array<SpectrumParameter>` (≥2 elements) |

`Params` (std140/uniform, in order): `Size: u32`, `LengthScale: f32`, `CutoffHigh: f32`,
`CutoffLow: f32`, `GravityAcceleration: f32`, `Depth: f32`.

`SpectrumParameter` (8× f32 each): `scale, angle, spreadBlend, swell, alpha, peakOmega, gamma,
shortWavesFade`.

### Dispatch

`Size = 128` (spike default). Workgroup is 8×8, so dispatch `Size/8 × Size/8 = 16 × 16 × 1`.

### The readback (this is the actual proof)

1. Create the two storage textures + noise texture + the two buffers, fill `params`/`spectrums`/
   `Noise` with the **same values the browser used** for a fixed seed (capture them from the running
   Angular client — that's your oracle).
2. Encode: `beginComputePass` → set pipeline + bind group → `dispatchWorkgroups(16,16,1)` → end.
3. Copy `H0K` (a storage texture) to a `WGPUBuffer` via `copyTextureToBuffer` (mind the 256-byte
   row-padding alignment), submit, then `wgpuBufferMapAsync` + read.
4. Print a handful of texels and diff against the oracle within float tolerance. Match = Phase 0 done.

> Capturing the oracle: in the browser client, after the initial-spectrum pass, read back the same
> texture (or log a few known texels) for a pinned `Size`, `LengthScale`, wind, and noise seed. Keep
> those inputs identical on the native side so the comparison is apples-to-apples.

## After this

The rest of the FFT chain (`CONJUGATE`, `TIME_DEPENDENT_SPECTRUM`, the butterfly `FFT_*` passes,
`WAVES_MERGER`) ports the same way and belongs in Phase 2. Get one pass byte-comparable first.
