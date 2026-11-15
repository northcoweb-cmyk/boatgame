// Procedural sky dome: gradient + Rayleigh-ish horizon band + Mie sun glow,
// sun & moon discs, two layers of drifting cloud banks, stars at night.
import * as THREE from 'three';
import { NOISE_GLSL } from '../water/glsl.js';

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // at far plane
}`;

const frag = /* glsl */ `
uniform vec3 uZenith, uHorizon, uSunColor, uGlow, uCloudCol, uSunDir, uMoonDir;
uniform float uNight, uTime, uSunI, uCloudCover;
varying vec3 vDir;
${NOISE_GLSL}
vec3 skyColor(vec3 d) {
  float y = max(d.y, -0.02);
  float h = pow(1.0 - clamp(y, 0.0, 1.0), 4.5);
  vec3 c = mix(uZenith, uHorizon, h);
  float sd = max(dot(d, uSunDir), 0.0);
  // horizon glow concentrated toward the sun azimuth at dusk
  vec3 flatD = normalize(vec3(d.x, 0.0, d.z) + 1e-5);
  vec3 flatS = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-5);
  float az = max(dot(flatD, flatS), 0.0);
  float sunLow = 1.0 - smoothstep(0.0, 0.35, abs(uSunDir.y));
  c += uGlow * pow(az, 3.0) * h * sunLow * 0.9;
  c += uSunColor * (pow(sd, 8.0) * 0.18 + pow(sd, 64.0) * 0.5) * (0.25 + sunLow);
  return c;
}
void main() {
  vec3 d = normalize(vDir);
  vec3 col = skyColor(d);
  // below-horizon: fade to a haze colour (ocean horizon is drawn by water)
  if (d.y < 0.0) col = mix(col, uHorizon * 0.8, smoothstep(0.0, -0.1, d.y));
  // sun disc
  float sd = dot(d, uSunDir);
  float disc = smoothstep(0.99955, 0.99975, sd);
  col += uSunColor * disc * 40.0 * step(-0.02, uSunDir.y);
  // moon
  float md = dot(d, uMoonDir);
  col += vec3(0.85, 0.9, 1.0) * smoothstep(0.99935, 0.9996, md) * 3.0 * uNight;
  col += vec3(0.25, 0.3, 0.45) * pow(max(md, 0.0), 60.0) * 0.4 * uNight;
  // stars
  if (uNight > 0.01 && d.y > 0.0) {
    vec3 sp = d * 420.0;
    vec3 cell = floor(sp);
    float h = bdHash(cell.xy + cell.z * 13.1);
    float star = step(0.9965, h) * smoothstep(0.6, 0.0, length(fract(sp) - 0.5));
    float tw = 0.6 + 0.4 * sin(uTime * 3.0 + h * 50.0);
    col += vec3(0.9, 0.95, 1.0) * star * tw * uNight * smoothstep(0.0, 0.2, d.y) * 1.6;
  }
  // cumulus: billowy domain-warped fbm on a curved layer, self-shadowed by
  // sampling the density a step toward the sun (lit tops, grey flat bases,
  // bright silver edges when back-lit), thinning and flattening to the horizon
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.12) * 1.1;
    vec2 wind = vec2(uTime * 0.0045, uTime * 0.0016);
    vec2 warp = vec2(bdFbm(uv * 0.6 + wind * 0.5), bdFbm(uv * 0.6 + 7.3 - wind * 0.5)) - 0.5;
    vec2 q = uv + warp * 0.55 + wind;
    float th = 0.62 - uCloudCover * 0.22;
    float base = bdFbm(q * 0.8);
    float puff = 1.0 - abs(bdNoise(q * 3.1 - wind * 2.0) * 2.0 - 1.0);
    float det = bdFbm(q * 6.5 + wind * 3.0);
    float n = base * 0.78 + puff * 0.14 + det * 0.16;
    float dens = smoothstep(th, th + 0.2, n);
    // light probe toward the sun (projected into the layer)
    vec2 sDir = normalize(uSunDir.xz + 1e-4) * (0.09 + 0.12 * (1.0 - clamp(uSunDir.y, 0.0, 1.0)));
    vec2 q2 = q + sDir;
    float n2 = bdFbm(q2 * 0.8) * 0.78 + (1.0 - abs(bdNoise(q2 * 3.1 - wind * 2.0) * 2.0 - 1.0)) * 0.14 + det * 0.16;
    float shadow = clamp((n2 - n) * 5.0 + 0.5, 0.0, 1.0);
    float lit = exp(-max(smoothstep(th, th + 0.35, n2), 0.0) * 1.6);
    float alpha = 1.0 - exp(-dens * 3.2);
    alpha *= smoothstep(0.01, 0.09, d.y);
    float sdc = max(dot(d, uSunDir), 0.0);
    float day = clamp(uSunI, 0.0, 1.0);
    vec3 ambient = mix(uHorizon * 0.75, uZenith * 0.9 + uHorizon * 0.25, 0.5) * (0.55 + 0.25 * day);
    vec3 sunlit = uCloudCol * (0.75 + 0.55 * lit) * (0.6 + 0.4 * (1.0 - shadow));
    vec3 cc = mix(ambient * 0.85 + uCloudCol * 0.2, sunlit, clamp(lit * 0.75 + (1.0 - dens) * 0.45, 0.0, 1.0));
    cc += uSunColor * (pow(sdc, 6.0) * 0.5 + pow(sdc, 40.0) * 1.1) * (1.0 - dens * 0.7) * (0.5 + 0.5 * lit); // silver lining
    cc += uGlow * pow(max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-5)), 0.0), 2.0) * (1.0 - smoothstep(0.0, 0.3, abs(uSunDir.y))) * 0.6;
    cc = mix(cc, skyColor(d), pow(1.0 - d.y, 10.0) * 0.6); // aerial perspective
    col = mix(col, cc, alpha * 0.97);
    // high cirrus streaks
    vec2 cu = d.xz / (d.y + 0.25) * vec2(0.35, 1.6) + vec2(uTime * 0.002, 0.0);
    float ci = smoothstep(0.55, 0.85, bdFbm(cu * 1.3)) * smoothstep(0.05, 0.35, d.y) * (1.0 - alpha);
    col = mix(col, uCloudCol * 1.02 + uSunColor * pow(sdc, 8.0) * 0.3, ci * 0.28);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
      uCloudCol: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uNight: { value: 0 }, uTime: { value: 0 },
      uSunI: { value: 1 }, uCloudCover: { value: 0.38 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms,
      side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(15000, 48, 24), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
    scene.add(this.mesh);
  }

  update(day, time, camPos) {
    const u = this.uniforms, p = day.p;
    u.uZenith.value.copy(p.zenith);
    u.uHorizon.value.copy(p.horizon);
    u.uSunColor.value.copy(p.sun).multiplyScalar(Math.max(0.2, p.sunI * 0.5));
    u.uGlow.value.copy(p.glow);
    u.uCloudCol.value.copy(p.cloud);
    u.uSunDir.value.copy(day.sunDir);
    u.uMoonDir.value.copy(day.moonDir);
    u.uNight.value = day.night;
    u.uTime.value = time;
    this.mesh.position.copy(camPos);
  }
}
