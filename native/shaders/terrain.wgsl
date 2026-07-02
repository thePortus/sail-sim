// Terrain: a camera-following grid displaced by the world height texture (R32F,
// signed elevation in metres), shaded by height-band biome colours with a Sobel
// normal. The grid recentres on the ship each frame (origin in misc.zw) and
// samples the fixed world heightfield, so land stays put in world space.

struct TU {
  viewProj : mat4x4<f32>,
  eye      : vec4<f32>,   // xyz camera
  bounds   : vec4<f32>,   // minX, maxX, minZ, maxZ (world metres)
  misc     : vec4<f32>,   // x,y = texW,texH ; z,w = origin (ship x,z)
  sun      : vec4<f32>,   // xyz sun direction
};
@group(0) @binding(0) var<uniform> u : TU;
@group(0) @binding(1) var heightTex : texture_2d<f32>;

fn worldToTexel(wx : f32, wz : f32) -> vec2<f32> {
  let ux = (wx - u.bounds.x) / (u.bounds.y - u.bounds.x);
  let uz = (u.bounds.w - wz) / (u.bounds.w - u.bounds.z);   // +Z is south
  return vec2<f32>(ux * u.misc.x - 0.5, uz * u.misc.y - 0.5);
}
fn loadH(ix : i32, iz : i32) -> f32 {
  let w = i32(u.misc.x); let h = i32(u.misc.y);
  return textureLoad(heightTex, vec2<i32>(clamp(ix, 0, w - 1), clamp(iz, 0, h - 1)), 0).r;
}
fn sampleH(wx : f32, wz : f32) -> f32 {
  let tc = worldToTexel(wx, wz);
  let i0 = vec2<i32>(floor(tc));
  let f  = fract(tc);
  let h00 = loadH(i0.x, i0.y);     let h10 = loadH(i0.x + 1, i0.y);
  let h01 = loadH(i0.x, i0.y + 1); let h11 = loadH(i0.x + 1, i0.y + 1);
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0)       worldPos : vec3<f32>,
  @location(1)       elev     : f32,   // raw (uncurved) elevation for colour + waterline cull
};

@vertex
fn vs_main(@location(0) inXZ : vec2<f32>) -> VSOut {
  let wx = inXZ.x + u.misc.z;   // grid follows the ship
  let wz = inXZ.y + u.misc.w;
  let y  = sampleH(wx, wz);
  var o : VSOut;
  o.worldPos = vec3<f32>(wx, y, wz);
  o.elev     = y;
  o.position = u.viewProj * vec4<f32>(o.worldPos, 1.0);
  return o;
}

// Height-banded biome colour (Palau: beaches, jungle, bare rock; peaks ~217 m).
fn biomeColor(h : f32) -> vec3<f32> {
  let sand   = vec3<f32>(0.78, 0.72, 0.52);
  let grass  = vec3<f32>(0.34, 0.46, 0.20);
  let jungle = vec3<f32>(0.15, 0.30, 0.12);
  let rock   = vec3<f32>(0.42, 0.38, 0.33);
  var c = sand;
  c = mix(c, grass,  smoothstep(0.6, 5.0, h));
  c = mix(c, jungle, smoothstep(10.0, 45.0, h));
  c = mix(c, rock,   smoothstep(70.0, 150.0, h));
  return c;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  // Only land above the waterline draws; the sea (FFT ocean / far sea) covers the
  // seabed, so shallow reef flats read as water, not exposed green land.
  if (in.elev < 0.2) { discard; }

  let wx = in.worldPos.x; let wz = in.worldPos.z;
  let e = (u.bounds.y - u.bounds.x) / u.misc.x;   // ~one texel in metres
  let hl = sampleH(wx - e, wz); let hr = sampleH(wx + e, wz);
  let hd = sampleH(wx, wz - e); let hu = sampleH(wx, wz + e);
  let N = normalize(vec3<f32>(hl - hr, 2.0 * e, hd - hu));
  let L = normalize(u.sun.xyz);
  let diff = max(dot(N, L), 0.0);

  var col = biomeColor(in.elev);   // colour by real elevation, not the curved Y
  col = mix(col * vec3<f32>(0.72, 0.68, 0.55), col, smoothstep(0.2, 1.5, in.elev));  // wet sand at the shore
  col = col * (0.32 + 0.68 * diff);
  return vec4<f32>(col, 1.0);   // sRGB target does gamma
}
