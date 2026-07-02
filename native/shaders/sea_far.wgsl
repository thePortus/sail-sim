// Far sea: one big flat quad at y=0 covering the whole world, so islands sit in
// water out to the horizon. It's discarded within an inner radius of the ship,
// where the detailed FFT ocean patch takes over. Simple Fresnel sky-blend + sun
// glint (no waves) — it's the distance, so detail isn't needed.

struct SU {
  viewProj : mat4x4<f32>,
  eye      : vec4<f32>,   // xyz camera
  sun      : vec4<f32>,   // xyz sun
  origin   : vec4<f32>,   // xy = ship x,z ; z = inner radius (m)
};
@group(0) @binding(0) var<uniform> u : SU;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0)       worldPos : vec3<f32>,
};

@vertex
fn vs_main(@location(0) inXZ : vec2<f32>) -> VSOut {
  var o : VSOut;
  // Recentre the flat sheet on the ship (origin.xy) so water reaches the horizon.
  let p = vec3<f32>(inXZ.x + u.origin.x, 0.0, inXZ.y + u.origin.y);
  o.worldPos = p;
  o.position = u.viewProj * vec4<f32>(p, 1.0);
  return o;
}

fn pow5(x : f32) -> f32 { let x2 = x * x; return x2 * x2 * x; }

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let d = distance(in.worldPos.xz, u.origin.xy);
  if (d < u.origin.z) { discard; }   // leave the centre to the FFT ocean patch

  let V = normalize(u.eye.xyz - in.worldPos);
  let N = vec3<f32>(0.0, 1.0, 0.0);
  let L = normalize(u.sun.xyz);

  let deep = vec3<f32>(0.015, 0.090, 0.130);
  let sky  = vec3<f32>(0.45, 0.62, 0.82);
  var fres = pow5(clamp(1.0 - dot(N, V), 0.0, 1.0));
  var col = mix(deep, sky, clamp(fres, 0.0, 1.0));

  let H = normalize(V + L);
  col += vec3<f32>(1.0, 0.96, 0.86) * pow(max(dot(N, H), 0.0), 200.0) * 0.8;
  return vec4<f32>(col, 1.0);   // sRGB target does gamma
}
