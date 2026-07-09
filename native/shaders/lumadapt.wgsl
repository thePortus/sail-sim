// Auto-exposure metering + eye adaptation (opt-in). Samples the composited HDR scene on a coarse
// grid, averages its luminance, and blends toward the previous frame's adapted value at a fixed
// rate (the "eye" easing into bright/dark). Output is a 1x1 R16Float texture the post pass reads to
// scale exposure so the image self-levels. History read + write are ping-ponged by the caller (this
// frame's result is copied back over the history texture), so the post pass can bind a fixed view.

struct LumU {
  params : vec4<f32>,   // x = adaptation rate [0..1] per frame ; y = min luminance clamp ; z,w unused
};
@group(0) @binding(0) var<uniform> u : LumU;
@group(0) @binding(1) var sceneTex : texture_2d<f32>;
@group(0) @binding(2) var histTex  : texture_2d<f32>;   // 1x1 previous adapted luminance

struct VSOut { @builtin(position) position : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let p = pts[vid];
  var o : VSOut;
  o.position = vec4<f32>(p, 0.0, 1.0);
  o.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return o;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(sceneTex, 0));
  // 8x8 grid of taps, centre-weighted a touch (the subject usually sits mid-frame). Average in log
  // space so a few bright specular hits don't dominate the metering.
  var sumLog = 0.0;
  var sumW   = 0.0;
  for (var y = 0; y < 8; y = y + 1) {
    for (var x = 0; x < 8; x = x + 1) {
      let uv = (vec2<f32>(f32(x), f32(y)) + 0.5) / 8.0;
      let ip = vec2<i32>(clamp(uv * dims, vec2<f32>(0.0), dims - 1.0));
      let c = textureLoad(sceneTex, ip, 0).rgb;
      let lum = max(dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)), 1e-4);
      let d = length(uv - vec2<f32>(0.5));
      let w = 1.0 - 0.6 * d;                 // gentle centre weight
      sumLog = sumLog + log(lum) * w;
      sumW   = sumW + w;
    }
  }
  let avg = exp(sumLog / max(sumW, 1e-4));    // geometric mean luminance
  let cur = max(avg, u.params.y);

  let prev = max(textureLoad(histTex, vec2<i32>(0, 0), 0).r, u.params.y);
  let adapted = mix(prev, cur, clamp(u.params.x, 0.0, 1.0));
  return vec4<f32>(adapted, 0.0, 0.0, 1.0);
}
