// FFT ocean surface — 3 cascades summed (250/17/5 m tiles), shaded with the
// client's ocean-material math: derivative-map normals, Jacobian/turbulence foam,
// subsurface-scatter glow on wave backs, Fresnel sky reflection.

struct Camera {
    viewProj : mat4x4<f32>,
    eye      : vec4<f32>,   // xyz camera position
    params   : vec4<f32>,   // xyz = lengthScale0/1/2 (metres per tile); w = slope (wave-normal) amp
    screen   : vec4<f32>,   // xy = framebuffer size (px); zw = ocean origin (ship)
    lod      : vec4<f32>,   // x = vertex displacement amp; y = inner discard radius (far ring)
    sun      : vec4<f32>,   // xyz = light dir (sun by day, moon by night); w = daylight [0..1]
    tbounds  : vec4<f32>,   // terrain heightfield world bounds: minX, maxX, minZ, maxZ
    tmisc    : vec4<f32>,   // x,y = heightfield texel size; z = field ready; w = see-depth (m)
};
@group(0) @binding(0)  var<uniform> cam : Camera;
@group(0) @binding(11) var reflTex : texture_2d<f32>;   // planar reflection RTT
@group(0) @binding(1)  var disp0  : texture_2d<f32>;
@group(0) @binding(2)  var deriv0 : texture_2d<f32>;
@group(0) @binding(3)  var turb0  : texture_2d<f32>;
@group(0) @binding(4)  var disp1  : texture_2d<f32>;
@group(0) @binding(5)  var deriv1 : texture_2d<f32>;
@group(0) @binding(6)  var turb1  : texture_2d<f32>;
@group(0) @binding(7)  var disp2  : texture_2d<f32>;
@group(0) @binding(8)  var deriv2 : texture_2d<f32>;
@group(0) @binding(9)  var turb2  : texture_2d<f32>;
@group(0) @binding(10) var samp   : sampler;
@group(0) @binding(12) var terrainH : texture_2d<f32>;   // R32F signed elevation (shallows)

// Material constants (from ocean-material.ts).
const _Color       = vec3<f32>(0.015, 0.090, 0.130);
const _SkyColor    = vec3<f32>(0.45, 0.62, 0.82);
const _ReflStrength = 0.35;
const _SSSColor    = vec3<f32>(0.1541919, 0.8857628, 0.990566);
const _SSSStrength = 0.205;
const _SSSBase     = -0.261;
const _SSSScale    = 4.7;
const _FoamScale   = 2.6;
const _FoamBias    = 2.80;   // LOD2 (3 cascades)
const _Choppiness  = 0.3;

struct VSOut {
    @builtin(position) position : vec4<f32>,
    @location(0)       worldPos : vec3<f32>,
    @location(1)       worldUV  : vec2<f32>,   // undisplaced grid xz (for texture sampling)
    @location(2)       height   : f32,          // summed displacement.y (for SSS)
};

@vertex
fn vs_main(@location(0) inXZ : vec2<f32>) -> VSOut {
    let world = inXZ + cam.screen.zw;   // grid follows the ship (cam.screen.zw = ocean origin)
    let uv0 = world / cam.params.x;
    let uv1 = world / cam.params.y;
    let uv2 = world / cam.params.z;
    var disp = textureSampleLevel(disp0, samp, uv0, 0.0).xyz;
    disp += textureSampleLevel(disp1, samp, uv1, 0.0).xyz;
    disp += textureSampleLevel(disp2, samp, uv2, 0.0).xyz;
    disp = disp * cam.lod.x;   // vertex displacement amp (0 on the flat far ring)

    let p = vec3<f32>(world.x + disp.x, disp.y, world.y + disp.z);
    var out : VSOut;
    out.position = cam.viewProj * vec4<f32>(p, 1.0);
    out.worldPos = p;
    out.worldUV = world;
    out.height = disp.y;
    return out;
}

fn pow5(x : f32) -> f32 { let x2 = x * x; return x2 * x2 * x; }

// Bilinear terrain elevation at a world XZ (same mapping as terrain.wgsl) — gives
// the TRUE vertical seabed depth per water fragment for the shallows reveal.
fn tLoadH(ix : i32, iz : i32) -> f32 {
    let w = i32(cam.tmisc.x); let h = i32(cam.tmisc.y);
    return textureLoad(terrainH, vec2<i32>(clamp(ix, 0, w - 1), clamp(iz, 0, h - 1)), 0).r;
}
fn tSampleH(wx : f32, wz : f32) -> f32 {
    let ux = (wx - cam.tbounds.x) / (cam.tbounds.y - cam.tbounds.x);
    let uz = (cam.tbounds.w - wz) / (cam.tbounds.w - cam.tbounds.z);   // +Z is south
    let tc = vec2<f32>(ux * cam.tmisc.x - 0.5, uz * cam.tmisc.y - 0.5);
    let i0 = vec2<i32>(floor(tc));
    let f  = fract(tc);
    let h00 = tLoadH(i0.x, i0.y);     let h10 = tLoadH(i0.x + 1, i0.y);
    let h01 = tLoadH(i0.x, i0.y + 1); let h11 = tLoadH(i0.x + 1, i0.y + 1);
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
    // Far ring leaves the centre to the detailed near grid (cam.lod.y = 0 on near).
    if (distance(in.worldUV, cam.screen.zw) < cam.lod.y) { discard; }
    let uv0 = in.worldUV / cam.params.x;
    let uv1 = in.worldUV / cam.params.y;
    let uv2 = in.worldUV / cam.params.z;

    // Normal from summed derivative maps.
    var derivatives = textureSample(deriv0, samp, uv0);
    derivatives += textureSample(deriv1, samp, uv1);
    derivatives += textureSample(deriv2, samp, uv2);
    let slope = vec2<f32>(derivatives.x * cam.params.w / (1.0 + derivatives.z),
                          derivatives.y * cam.params.w / (1.0 + derivatives.w));
    let N = normalize(vec3<f32>(-slope.x, 1.0, -slope.y));

    let V = normalize(cam.eye.xyz - in.worldPos);
    let L = normalize(cam.sun.xyz);   // sun by day, moon by night

    // Foam from summed turbulence (Jacobian): folds/breaks read white.
    let foamChop = 1.0 - _Choppiness * 0.32;
    var jacobian = textureSample(turb0, samp, uv0).x
                 + textureSample(turb1, samp, uv1).x
                 + textureSample(turb2, samp, uv2).x;
    jacobian = min(1.0, max(0.0, (-jacobian + _FoamBias * foamChop) * _FoamScale));

    // Subsurface scattering — back-lit turquoise glow on wave backs, sun-gated.
    let sunUp = smoothstep(0.0, 0.12, L.y);
    let H = normalize(-N + L);
    let viewDotH = pow5(clamp(dot(V, -H), 0.0, 1.0)) * 30.0 * _SSSStrength * sunUp;
    let sssW = max(in.height - _SSSBase, 0.0) / _SSSScale;
    let color = clamp(_Color + _SSSColor * viewDotH * sssW, vec3<f32>(0.0), vec3<f32>(1.0));

    // ── Coastal shallows (client ocean-material Phase 4): TRUE vertical seabed
    //    depth from the terrain heightfield. reveal = the sand shows through up
    //    close; shallow = the broad band that suppresses the blue water terms;
    //    shoal = a turquoise water-column ring just past the clear-view depth. ──
    var reveal = 0.0;
    var shallow = 0.0;
    var shoal = 0.0;
    if (cam.tmisc.z > 0.5) {
        let dz = max(0.0, -tSampleH(in.worldUV.x, in.worldUV.y));
        // Visibility falls off with view distance (scattering through the column):
        // full reach up close, opaque by ~400 m — also kills grazing-angle noise.
        let viewDist = distance(cam.eye.xyz, in.worldPos);
        let distFade = 1.0 - smoothstep(150.0, 400.0, viewDist);
        let seeD = cam.tmisc.w;
        reveal  = (1.0 - smoothstep(0.0, seeD, dz)) * distFade;
        shallow = (1.0 - smoothstep(0.0, seeD * 2.2, dz)) * distFade;
        shoal   = smoothstep(seeD, seeD * 1.8, dz)
                * (1.0 - smoothstep(seeD * 1.8, seeD * 3.5, dz)) * distFade * (1.0 - reveal);
    }

    // Fresnel sky reflection.
    var fresnel = clamp(1.0 - dot(N, V), 0.0, 1.0);
    fresnel = pow5(fresnel);
    var waterCol = color * (1.0 - fresnel);
    // Shoal water-column tint just beyond the clear-view depth (client: 0.10 * sunUp).
    waterCol = mix(waterCol, vec3<f32>(0.10, 0.48, 0.50) * (1.0 - fresnel), shoal * 0.10 * sunUp);
    // Kill the mirror glint across the shallows — transparent water over sand
    // reads as wet sand, never mirroring the sky (client reflCut).
    let reflCut = clamp(1.0 - max(reveal, shallow) * 1.6, 0.0, 1.0);
    // Planar reflection (sky + ship), rippled by the surface normal, at grazing angles.
    let reflUV = clamp(in.position.xy / cam.screen.xy + slope * 0.12, vec2<f32>(0.001), vec2<f32>(0.999));
    let reflColor = textureSample(reflTex, samp, reflUV).rgb;
    waterCol += reflColor * fresnel * _ReflStrength * reflCut;

    // Sun glint.
    let Hs = normalize(V + L);
    waterCol += vec3<f32>(1.0, 0.96, 0.86) * pow(max(dot(N, Hs), 0.0), 300.0) * 1.2 * reflCut;

    // Composite foam (lit white) over water.
    let foamLit = vec3<f32>(1.0) * (0.55 + 0.45 * max(dot(N, L), 0.0));
    var outColor = mix(waterCol, foamLit, jacobian);   // sRGB target does gamma
    // Day/night: darken and cool the sea toward night. The planar reflection (sky +
    // ship in reflTex) is already dark at night, so this only crushes the deep-water
    // body + glint; the surface still catches the moon and its reflection.
    let dayK = cam.sun.w;
    let bright = mix(0.10, 1.0, dayK);
    let tint   = mix(vec3<f32>(0.42, 0.54, 0.82), vec3<f32>(1.0), dayK);
    outColor = outColor * bright * tint;
    // REAL transparency over the shallows — the client's exact composite: it mixed
    // the revealed seabed in at reveal * 0.9 (10% water colour always remains), so
    // our alpha is 1 - reveal * 0.9. Foam stays opaque on top (composited last there
    // too), so breakers read solid white even over sand.
    let alpha = clamp(1.0 - reveal * 0.9 + jacobian, 0.0, 1.0);
    return vec4<f32>(outColor, alpha);
}
