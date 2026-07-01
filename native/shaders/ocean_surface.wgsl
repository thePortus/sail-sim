// FFT ocean surface — 3 cascades summed (250/17/5 m tiles), shaded with the
// client's ocean-material math: derivative-map normals, Jacobian/turbulence foam,
// subsurface-scatter glow on wave backs, Fresnel sky reflection.

struct Camera {
    viewProj : mat4x4<f32>,
    eye      : vec4<f32>,   // xyz camera position
    params   : vec4<f32>,   // xyz = lengthScale0/1/2 (metres per tile)
    screen   : vec4<f32>,   // xy = framebuffer size (px)
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
    disp = disp * cam.params.w;   // wind-driven wave amplitude (Beaufort)

    let p = vec3<f32>(world.x + disp.x, disp.y, world.y + disp.z);
    var out : VSOut;
    out.position = cam.viewProj * vec4<f32>(p, 1.0);
    out.worldPos = p;
    out.worldUV = world;
    out.height = disp.y;
    return out;
}

fn pow5(x : f32) -> f32 { let x2 = x * x; return x2 * x2 * x; }

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
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
    let L = normalize(vec3<f32>(0.5, 1.0, 0.4));   // sun

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

    // Fresnel sky reflection.
    var fresnel = clamp(1.0 - dot(N, V), 0.0, 1.0);
    fresnel = pow5(fresnel);
    var waterCol = color * (1.0 - fresnel);
    // Planar reflection (sky + ship), rippled by the surface normal, at grazing angles.
    let reflUV = clamp(in.position.xy / cam.screen.xy + slope * 0.12, vec2<f32>(0.001), vec2<f32>(0.999));
    let reflColor = textureSample(reflTex, samp, reflUV).rgb;
    waterCol += reflColor * fresnel * _ReflStrength;

    // Sun glint.
    let Hs = normalize(V + L);
    waterCol += vec3<f32>(1.0, 0.96, 0.86) * pow(max(dot(N, Hs), 0.0), 300.0) * 1.2;

    // Composite foam (lit white) over water.
    let foamLit = vec3<f32>(1.0) * (0.55 + 0.45 * max(dot(N, L), 0.0));
    let outColor = mix(waterCol, foamLit, jacobian);   // sRGB target does gamma
    return vec4<f32>(outColor, 1.0);
}
