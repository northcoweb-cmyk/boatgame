// The camera-following Gerstner ocean. Geometry is a warped grid (dense under
// the camera, stretching to a 12 km horizon), snapped to the centre spacing so
// vertices stay world-anchored. Shading: analytic normals + micro detail,
// Schlick Fresnel, planar reflection, Beer-Lambert seabed refraction, crest
// subsurface scattering, GGX sun glitter, four kinds of foam, underwater view.
import * as THREE from 'three';
import { WAVES_GLSL, NOISE_GLSL, SEABED_GLSL, TERRAIN_SAMPLE_GLSL, HAZE_GLSL } from './glsl.js';
import { MAX_WAVES } from './spectrum.js';

const vertexShader = /* glsl */ `
attribute float aSpacing;
uniform vec3 uGridOrigin;
uniform mat4 uTextureMatrix;
uniform sampler2D uWake;
uniform vec3 uWakeRect;
uniform float uSigH;
${TERRAIN_SAMPLE_GLSL}
${WAVES_GLSL}
varying vec3 vWorld;
varying vec2 vParam;
varying float vAtten;
varying float vCrest;
varying vec4 vReflCoord;
void main() {
  vec2 p = position.xz + uGridOrigin.xz;
  float depth = -textureLod(uTerrain, terrainUV(p), 0.0).r;
  float atten = smoothstep(0.15, 5.5, depth);
  vec3 d = gerstnerDisp(p, atten, aSpacing);
  vec2 wuv = (p - uWakeRect.xy) / uWakeRect.z;
  float wakeH = 0.0;
  if (wuv.x > 0.0 && wuv.y > 0.0 && wuv.x < 1.0 && wuv.y < 1.0) wakeH = textureLod(uWake, wuv, 0.0).g * smoothstep(0.0, 0.08, min(min(wuv.x, wuv.y), min(1.0 - wuv.x, 1.0 - wuv.y)));
  // wake height shapes shading normals + buoyancy only: displacing the coarse grid by a fine texture makes ridges
  vec3 w = vec3(p.x + d.x, d.y + wakeH * 0.0, p.y + d.z);
  vWorld = w;
  vParam = p;
  vAtten = atten;
  vCrest = (d.y + wakeH) / max(uSigH * 0.5, 0.05);
  vReflCoord = uTextureMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const fragmentShader = /* glsl */ `
uniform sampler2D uReflection;
uniform float uReflectOn;
uniform sampler2D uWake;
uniform vec3 uWakeRect;
uniform sampler2D uDetail;
uniform vec3 uSunColor;
uniform vec3 uLightDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uDeepColor;
uniform vec3 uAmbient;
uniform float uNight;
uniform float uWhitecaps;
uniform float uChop;
uniform float uSunVisible;
uniform float uUnderwater;
${TERRAIN_SAMPLE_GLSL}
${WAVES_GLSL}
${NOISE_GLSL}
${SEABED_GLSL}
${HAZE_GLSL}
varying vec3 vWorld;
varying vec2 vParam;
varying float vAtten;
varying float vCrest;
varying vec4 vReflCoord;

vec3 skyGrad(vec3 d) {
  float h = pow(1.0 - clamp(d.y, 0.0, 1.0), 4.0);
  return mix(uSkyZenith, uSkyHorizon, h);
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec4 td = terrainData(vWorld.xz);
  float depth = vWorld.y - td.r;
  float shoreAlpha = smoothstep(-0.03, 0.2, depth);
  if (shoreAlpha < 0.004) discard;

  float footprint = length(fwidth(vParam)) + dist * 0.0006;
  vec3 N; float jac;
  gerstnerNormal(vParam, vAtten, footprint, N, jac);

  // wake: foam (r) and height (g) with gradient for normals
  vec2 wuv = (vWorld.xz - uWakeRect.xy) / uWakeRect.z;
  float wakeFoam = 0.0;
  if (wuv.x > 0.0 && wuv.y > 0.0 && wuv.x < 1.0 && wuv.y < 1.0) {
    vec2 px = vec2(1.0 / 1024.0);
    vec4 wk = texture(uWake, wuv);
    float hx = texture(uWake, wuv + vec2(px.x, 0.0)).g - texture(uWake, wuv - vec2(px.x, 0.0)).g;
    float hz = texture(uWake, wuv + vec2(0.0, px.y)).g - texture(uWake, wuv - vec2(0.0, px.y)).g;
    float edge = smoothstep(0.0, 0.06, min(min(wuv.x, wuv.y), min(1.0 - wuv.x, 1.0 - wuv.y)));
    float texel = uWakeRect.z / 1024.0;
    N = normalize(N + clamp(vec3(-hx, 0.0, -hz) / (2.0 * texel), -0.6, 0.6) * 0.5 * edge);
    wakeFoam = wk.a * edge;
  }

  // micro detail (normal map derived from the ocean reference texture)
  float detailFade = 1.0 - smoothstep(20.0, 450.0, dist);
  vec2 d1 = texture(uDetail, vWorld.xz * 0.043 + uTime * vec2(0.011, 0.007)).rg * 2.0 - 1.0;
  vec2 d2 = texture(uDetail, vWorld.xz * 0.117 - uTime * vec2(0.008, 0.016)).rg * 2.0 - 1.0;
  vec2 d3 = texture(uDetail, vWorld.xz * 0.37 + uTime * vec2(0.021, -0.013)).rg * 2.0 - 1.0;
  vec2 det = (d1 + d2 * 0.8 + d3 * 0.5 * detailFade) * (0.2 + 0.2 * uChop) * max(detailFade, 0.25) * max(vAtten, 0.35);
  N = normalize(N + vec3(det.x, 0.0, det.y));

  vec3 L = uLightDir;
  vec3 col;

  if (!gl_FrontFacing || uUnderwater > 0.5) {
    // ---------------- seen from below: Snell's window + total internal reflection
    vec3 Nd = -N;
    float c = abs(dot(Nd, V));
    float window = smoothstep(0.6, 0.72, c);
    vec3 through = skyGrad(normalize(vec3(-V.x, abs(V.y) + 0.2, -V.z))) * 1.2 + uSunColor * pow(max(dot(-V, L), 0.0), 40.0) * 2.0;
    vec3 under = uDeepColor * (0.6 + uAmbient * 0.6);
    col = mix(under, through, window);
    col = mix(col, uDeepColor * 0.7, 1.0 - exp(-dist * 0.06));
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  float NdV = max(dot(N, V), 0.001);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // ---------------- reflection
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl = skyGrad(R);
  if (uReflectOn > 0.5) {
    vec4 rc = vReflCoord;
    // coherent, wave-rippled mirror image (strong offsets scramble hulls)
    rc.xy += N.xz * rc.w * 0.13 / (1.0 + dist * 0.006);
    vec3 rtex = textureProj(uReflection, rc).rgb;
    refl = mix(rtex, refl, 0.3); // rough water averages part of the mirror image into sky colour
  } else {
    refl += uSunColor * pow(max(dot(R, L), 0.0), 600.0) * 0.0;
  }

  // ---------------- refraction: seabed through the water column (Beer-Lambert)
  vec3 Rr = refract(-V, N, 0.75);
  float dcol = max(depth, 0.0);
  vec2 bedXZ = vWorld.xz + Rr.xz / max(-Rr.y, 0.25) * min(dcol, 5.0);
  vec4 tb = terrainData(bedXZ);
  float bedH = tb.r;
  float column = max(vWorld.y - bedH, 0.0);
  vec3 bed = seabedColor(bedXZ, bedH, tb.b);
  float sunAmt = max(L.y, 0.0) * uSunVisible;
  float caus = caustics(bedXZ, uTime) * smoothstep(7.0, 0.3, column);
  vec3 bedLit = bed * 0.7 * (uSunColor * sunAmt * (0.6 + caus * 0.7) + uAmbient * 0.8);
  float path = column * (1.0 + 1.0 / max(-Rr.y, 0.3));
  vec3 absorb = vec3(0.46, 0.125, 0.085);
  vec3 T = exp(-absorb * path);
  vec3 scatter = uDeepColor * (uSunColor * sunAmt * 0.55 + uAmbient * 0.9);
  vec3 body = bedLit * T + scatter * (1.0 - T);

  // ---------------- subsurface glow in back-lit crests (teal-green)
  float backLit = pow(clamp(dot(-V, L), 0.0, 1.0), 3.5);
  float crest = clamp(vCrest, 0.0, 1.5);
  vec3 sss = vec3(0.08, 0.62, 0.52) * uSunColor * (backLit * crest * 0.55 + crest * 0.06) * sunAmt * (0.6 + uChop * 0.4) * vAtten;

  // ---------------- sun glitter (GGX)
  vec3 H = normalize(V + L);
  float NdH = max(dot(N, H), 0.0);
  float NdL = max(dot(N, L), 0.0);
  float rough = 0.045 + min(dist * 0.00004, 0.08);
  float a2 = rough * rough;
  float dd = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dd * dd);
  float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  vec3 spec = uSunColor * D * Fs * NdL * 0.25 * uSunVisible;
  // moon glitter at night
  spec += vec3(0.6, 0.7, 0.9) * pow(NdH, 400.0) * uNight * 0.6;

  // ---------------- foam
  float n1 = bdFbm(vParam * 0.35 + uTime * 0.04);
  float n2 = bdNoise(vParam * 2.3 - uTime * 0.2);
  // (a) whitecaps from the Jacobian, softly dissolving
  float capThresh = mix(0.25, 0.7, uWhitecaps);
  float caps = smoothstep(capThresh, capThresh - 0.3, jac) * smoothstep(0.35, 0.7, n1 + n2 * 0.3) * uWhitecaps;
  caps += smoothstep(capThresh + 0.15, capThresh - 0.1, jac) * smoothstep(0.62, 0.8, n1) * 0.35 * uWhitecaps; // fading trail
  // (b) a thin lapping line right at the waterline (not across the flats) +
  //     breaking only where the bottom shoals steeply under a real crest
  float shore = (1.0 - smoothstep(0.0, 0.32, dcol)) * (0.5 + 0.5 * sin(dcol * 14.0 - uTime * 1.7 + n1 * 6.0));
  shore *= smoothstep(0.35, 0.65, n2 + 0.25) * smoothstep(0.0, 0.05, dcol);
  float shoal = clamp(length(vec2(dFdx(dcol), dFdy(dcol))) / max(footprint, 0.05), 0.0, 1.0);
  float breakZone = smoothstep(1.2, 0.55, dcol) * smoothstep(0.2, 0.45, dcol) * smoothstep(0.08, 0.3, shoal);
  float breaking = breakZone * smoothstep(0.5, 0.9, vCrest) * smoothstep(0.45, 0.7, n1) * (0.15 + uWhitecaps * 0.6);
  // (c) boat wakes: foam coverage thresholds a two-scale lace noise, so fresh
  //     wake is dense churn and ageing wake breaks into patches and threads
  //     over a band of brighter, aerated turquoise water (no solid white)
  float lace = bdNoise(vWorld.xz * 3.1 + uTime * 0.15) * 0.45 + bdNoise(vWorld.xz * 8.7 - uTime * 0.3) * 0.33 + bdNoise(vWorld.xz * 21.0 + uTime * 0.1) * 0.22;
  float cover = clamp(wakeFoam, 0.0, 1.0);
  float wf = smoothstep(1.02 - cover, 1.3 - cover, lace) * smoothstep(0.03, 0.25, cover) * (0.45 + 0.4 * cover);
  float aerated = smoothstep(0.02, 0.5, cover) * (1.0 - wf);
  float foam = clamp(caps + shore * 0.7 + breaking + wf, 0.0, 1.0);
  vec3 foamCol = vec3(0.92, 0.95, 0.96) * (uSunColor * (0.35 + 0.65 * max(N.y, 0.0)) * sunAmt + uAmbient * 1.3);

  col = mix(body, refl, F) + spec + sss;
  col = mix(col, col * 0.6 + vec3(0.30, 0.62, 0.62) * (uSunColor * sunAmt * 0.5 + uAmbient), aerated * 0.45);
  col = mix(col, foamCol, foam * 0.92);
  col = applyHaze(col, vWorld);
  gl_FragColor = vec4(col, shoreAlpha);
}`;

export function buildOceanGrid(N, radius, centerSpacing) {
  const du = 2 / (N - 1);
  const a = Math.min(0.95, (centerSpacing / du) / radius);
  const p = 3.4;
  const warp = (u) => Math.sign(u) * (a * Math.abs(u) + (1 - a) * Math.pow(Math.abs(u), p)) * radius;
  const dwarp = (u) => (a + (1 - a) * p * Math.pow(Math.abs(u), p - 1)) * radius * du;
  const pos = new Float32Array(N * N * 3);
  const sp = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const v = -1 + j * du;
    for (let i = 0; i < N; i++) {
      const u = -1 + i * du;
      const k = j * N + i;
      pos[k * 3] = warp(u);
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = warp(v);
      sp[k] = Math.max(dwarp(u), dwarp(v));
    }
  }
  const idx = new Uint32Array((N - 1) * (N - 1) * 6);
  let t = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a0 = j * N + i, b0 = a0 + 1, c0 = a0 + N, d0 = c0 + 1;
    idx[t++] = a0; idx[t++] = c0; idx[t++] = b0;
    idx[t++] = b0; idx[t++] = c0; idx[t++] = d0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSpacing', new THREE.BufferAttribute(sp, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 1.5);
  return { geometry: g, centerSpacing: a * radius * du };
}

// Normal map (RG) from the luminance of the ocean reference texture.
export function makeDetailNormalTexture(image) {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, S, S);
  const src = ctx.getImageData(0, 0, S, S).data;
  const h = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) h[i] = (src[i * 4] * 0.3 + src[i * 4 + 1] * 0.59 + src[i * 4 + 2] * 0.11) / 255;
  // flatten low frequencies so only ripples remain
  const out = ctx.createImageData(S, S);
  const at = (x, y) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 2 + (at(x + 1, y - 1) - at(x - 1, y - 1)) + (at(x + 1, y + 1) - at(x - 1, y + 1));
    const dy = (at(x, y + 1) - at(x, y - 1)) * 2 + (at(x - 1, y + 1) - at(x - 1, y - 1)) + (at(x + 1, y + 1) - at(x + 1, y - 1));
    const k = (y * S + x) * 4;
    out.data[k] = Math.max(0, Math.min(255, 128 + dx * 90));
    out.data[k + 1] = Math.max(0, Math.min(255, 128 + dy * 90));
    out.data[k + 2] = 255;
    out.data[k + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

export class Ocean {
  constructor({ spectrum, terrainTex, sandTex, detailTex, gridN }) {
    this.spectrum = spectrum;
    const { geometry, centerSpacing } = buildOceanGrid(gridN, 12000, 0.55);
    this.centerSpacing = centerSpacing;
    const blank = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    blank.needsUpdate = true;
    this.uniforms = {
      uWaveA: { value: spectrum.packedA }, uWaveB: { value: spectrum.packedB },
      uWaveCount: { value: spectrum.count }, uTime: { value: 0 }, uSigH: { value: 0.5 },
      uGridOrigin: { value: new THREE.Vector3() },
      uTextureMatrix: { value: new THREE.Matrix4() },
      uTerrain: { value: terrainTex }, uSandTex: { value: sandTex }, uDetail: { value: detailTex },
      uReflection: { value: blank }, uReflectOn: { value: 0 },
      uWake: { value: blank }, uWakeRect: { value: new THREE.Vector3(-1e6, -1e6, 1) },
      uSunColor: { value: new THREE.Color() }, uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uSkyZenith: { value: new THREE.Color() }, uSkyHorizon: { value: new THREE.Color() },
      uDeepColor: { value: new THREE.Color() }, uAmbient: { value: new THREE.Color() },
      uNight: { value: 0 }, uWhitecaps: { value: 0 }, uChop: { value: 0 }, uSunVisible: { value: 1 },
      uUnderwater: { value: 0 },
      uFogColor: { value: new THREE.Color() }, uHazeSunColor: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uFogDensity: { value: 0.0001 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, uniforms: this.uniforms,
      side: THREE.DoubleSide, transparent: true, depthWrite: true,
      defines: {},
    });
    this.material.extensions = { derivatives: true };
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'ocean';
    void MAX_WAVES;
  }

  setReflection(texture, enabled) {
    this.uniforms.uReflection.value = texture;
    this.uniforms.uReflectOn.value = enabled ? 1 : 0;
  }

  update(camera, day, time, fogDensity, underwater) {
    const u = this.uniforms, s = this.spectrum;
    const step = this.centerSpacing * 4; // snap to a multiple so all rings stay world-locked
    u.uGridOrigin.value.set(Math.round(camera.position.x / step) * step, 0, Math.round(camera.position.z / step) * step);
    u.uTime.value = time;
    u.uWaveCount.value = s.count;
    u.uSigH.value = s.significantHeight();
    const p = day.p;
    day.lightDir(u.uLightDir.value);
    const sunUp = day.sunElevation > -3;
    u.uSunColor.value.copy(sunUp ? p.sun : new THREE.Color(0.55, 0.65, 0.9)).multiplyScalar(sunUp ? p.sunI : 0.12);
    u.uSunVisible.value = sunUp ? 1 : 0.35;
    u.uSkyZenith.value.copy(p.zenith);
    u.uSkyHorizon.value.copy(p.horizon);
    u.uDeepColor.value.copy(p.water);
    u.uAmbient.value.copy(p.sky).multiplyScalar(0.55);
    u.uNight.value = day.night;
    u.uChop.value = Math.min(1, s.current.chop / 1.2);
    u.uWhitecaps.value = Math.max(0, Math.min(1, (s.current.wind - 4.5) / 6.5));
    u.uFogColor.value.copy(p.fog);
    u.uHazeSunColor.value.copy(p.haze);
    u.uSunDir.value.copy(day.sunDir);
    u.uFogDensity.value = fogDensity;
    u.uUnderwater.value = underwater ? 1 : 0;
  }
}
