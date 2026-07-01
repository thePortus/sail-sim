// Cloud denoise — WGSL port of the client's 5x5 bilateral filter. Smooths the
// ray-march dither/noise while a tone-compressed range weight preserves edges.
// Operates on the offscreen (premultiplied) cloud buffer; the whole RGBA is
// filtered together, then blended over the scene.

struct DU { screenSize : vec2<f32>, pad : vec2<f32> };
@group(0) @binding(0) var<uniform> u : DU;
@group(0) @binding(1) var cloudTex  : texture_2d<f32>;
@group(0) @binding(2) var cloudSamp : sampler;

fn vc_luma(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }
fn vc_tone(c : vec3<f32>) -> f32 { let l = vc_luma(c); return l / (1.0 + l); }

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0)       uv       : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let p = pts[vid];
  var o : VSOut;
  o.position = vec4<f32>(p, 0.0, 1.0);
  o.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);   // flip Y to texture space
  return o;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let px = 1.0 / u.screenSize;
  let center = textureSampleLevel(cloudTex, cloudSamp, in.uv, 0.0);
  let cl = vc_tone(center.rgb);
  var sum = vec4<f32>(0.0);
  var wt = 0.0;
  for (var x = -2; x <= 2; x = x + 1) {
    for (var y = -2; y <= 2; y = y + 1) {
      let uv = in.uv + vec2<f32>(f32(x), f32(y)) * px;
      let s = textureSampleLevel(cloudTex, cloudSamp, uv, 0.0);
      let sw = exp(-f32(x * x + y * y) / 4.5);         // spatial gaussian (sigma ~1.5)
      let rw = exp(-abs(vc_tone(s.rgb) - cl) * 10.0);  // range — edge-preserving in tone space
      let w = sw * rw;
      sum = sum + s * w;
      wt = wt + w;
    }
  }
  return sum / wt;   // premultiplied cloud; blended over the scene by the pipeline
}
