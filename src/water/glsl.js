// Shared GLSL chunks. The wave code mirrors water/spectrum.js exactly.
import { MAX_WAVES } from './spectrum.js';
import { WORLD_HALF } from '../world/geography.js';

export const NOISE_GLSL = /* glsl */ `
float bdHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float bdNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = bdHash(i), b = bdHash(i + vec2(1.0, 0.0)), c = bdHash(i + vec2(0.0, 1.0)), d = bdHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float bdFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * bdNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
`;

export const TERRAIN_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uTerrain;
const float WORLD_HALF = ${WORLD_HALF.toFixed(1)};
vec2 terrainUV(vec2 xz) { return (xz + WORLD_HALF) / (2.0 * WORLD_HALF); }
vec4 terrainData(vec2 xz) { return texture(uTerrain, terrainUV(xz)); }
`;

export const WAVES_GLSL = /* glsl */ `
#define MAX_WAVES ${MAX_WAVES}
uniform vec4 uWaveA[MAX_WAVES]; // dirX, dirZ, k, amp
uniform vec4 uWaveB[MAX_WAVES]; // omega, Q, phase, lambda
uniform int uWaveCount;
uniform float uTime;

// Gerstner displacement at undisplaced param point p. 'spacing' fades waves
// shorter than the local grid resolution.
vec3 gerstnerDisp(vec2 p, float atten, float spacing) {
  vec3 d = vec3(0.0);
  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uWaveCount) break;
    vec4 A = uWaveA[i]; vec4 B = uWaveB[i];
    float fade = smoothstep(2.0 * spacing, 5.0 * spacing, B.w);
    float amp = A.w * atten * fade;
    float th = A.z * dot(A.xy, p) - B.x * uTime + B.z;
    float c = cos(th), s = sin(th);
    d.x += B.y * amp * c * A.x;
    d.z += B.y * amp * c * A.y;
    d.y += amp * s;
  }
  return d;
}

// Analytic normal + Jacobian (for whitecaps) at param point, with per-wave
// filtering by pixel footprint to avoid aliasing at distance.
void gerstnerNormal(vec2 p, float atten, float footprint, out vec3 n, out float jac) {
  float nx = 0.0, nz = 0.0, ny = 1.0;
  float jxx = 1.0, jzz = 1.0, jxz = 0.0;
  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uWaveCount) break;
    vec4 A = uWaveA[i]; vec4 B = uWaveB[i];
    float fade = 1.0 - smoothstep(B.w * 0.18, B.w * 0.5, footprint);
    float amp = A.w * atten * fade;
    if (amp <= 0.0) continue;
    float th = A.z * dot(A.xy, p) - B.x * uTime + B.z;
    float c = cos(th), s = sin(th);
    float wa = A.z * amp;
    nx -= A.x * wa * c;
    nz -= A.y * wa * c;
    ny -= B.y * wa * s;
    float qwas = B.y * wa * s;
    jxx -= qwas * A.x * A.x;
    jzz -= qwas * A.y * A.y;
    jxz -= qwas * A.x * A.y;
  }
  n = normalize(vec3(nx, ny, nz));
  jac = jxx * jzz - jxz * jxz;
}
`;

// Seabed colour shared by the water shader (seen through the surface) and the
// terrain shader (exposed sand) so the shoreline is seamless.
export const SEABED_GLSL = /* glsl */ `
uniform sampler2D uSandTex;
vec3 sandAlbedo(vec2 xz) {
  vec3 t1 = texture(uSandTex, xz * 0.31).rgb;
  vec3 t2 = texture(uSandTex, xz * 0.053 + 0.37).rgb;
  vec3 tex = mix(t1, t2, 0.45);
  float lum = dot(tex, vec3(0.333));
  vec3 base = vec3(0.84, 0.76, 0.61);
  float n = bdNoise(xz * 0.02);
  base = mix(base, vec3(0.90, 0.84, 0.70), n * 0.5);
  return base * (0.4 + 0.45 * lum);
}
vec3 seabedColor(vec2 xz, float h, float grass) {
  vec3 sand = sandAlbedo(xz);
  vec3 grassCol = mix(vec3(0.20, 0.27, 0.12), vec3(0.32, 0.36, 0.18), bdNoise(xz * 0.3));
  // Biscayne flats: turtle-grass meadows with pale sand blowouts; bare sand
  // only on the sandbars / beaches (shallower than ~0.7 m) and in channels
  float meadow = smoothstep(0.38, 0.58, bdFbm(xz * 0.012) * 0.7 + bdNoise(xz * 0.07) * 0.3);
  float g = max(grass, meadow) * smoothstep(-0.7, -1.6, h) * smoothstep(-7.5, -4.5, h);
  // submerged sand is wet: darker and a touch greener (algae film)
  vec3 c = mix(sand * vec3(0.62, 0.66, 0.6), grassCol * (0.75 + 0.35 * bdNoise(xz * 2.7)), g * (0.7 + 0.3 * bdNoise(xz * 1.3)));
  // channels: darker muddy sand
  c = mix(c, c * vec3(0.55, 0.58, 0.6), smoothstep(-5.5, -8.0, h));
  return c;
}
// Animated caustics (two layers of warped cells)
float caustics(vec2 xz, float t) {
  vec2 p = xz * 0.55;
  float c = 0.0;
  for (int i = 0; i < 2; i++) {
    vec2 q = p + vec2(sin(t * 0.7 + p.y * 0.6), cos(t * 0.6 + p.x * 0.5)) * 0.9;
    vec2 f = fract(q) - 0.5;
    float d = length(f);
    c += pow(1.0 - smoothstep(0.0, 0.5, d), 3.0);
    p = p * 1.7 + vec2(3.1, 1.7);
  }
  return c * 0.5;
}
`;

export const HAZE_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform vec3 uHazeSunColor;
uniform vec3 uSunDir;
uniform float uFogDensity;
vec3 applyHaze(vec3 col, vec3 worldPos) {
  vec3 v = worldPos - cameraPosition;
  float dist = length(v);
  vec3 dir = v / max(dist, 1e-3);
  float sunAmt = pow(max(dot(dir, uSunDir), 0.0), 6.0);
  vec3 haze = mix(uFogColor, uHazeSunColor, sunAmt);
  float f = 1.0 - exp(-(dist * uFogDensity) * (dist * uFogDensity));
  return mix(col, haze, clamp(f, 0.0, 1.0));
}
`;
