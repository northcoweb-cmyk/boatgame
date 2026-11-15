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
  // cumulus banks: domed projection, two fbm layers, flat grey bases, sunlit tops
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.1) * 1.15;
    vec2 wind = vec2(uTime * 0.0045, uTime * 0.0016);
    float base = bdFbm(uv * 0.85 + wind);
    float det = bdFbm(uv * 3.4 - wind * 1.6);
    float n = base * 0.82 + det * 0.32;
    float th = 0.66 - uCloudCover * 0.22;
    float cov = smoothstep(th, th + 0.12, n);
    cov *= smoothstep(0.015, 0.1, d.y) * (0.45 + 0.55 * smoothstep(0.55, 0.06, d.y));
    float thick = smoothstep(th + 0.05, th + 0.3, n);
    float sdc = max(dot(d, uSunDir), 0.0);
    vec3 top = uCloudCol * 1.05;
    vec3 bottom = mix(uCloudCol * 0.62, uHorizon * 0.7, 0.35);
    vec3 cc = mix(top, bottom, thick * 0.75);
    cc += uSunColor * (pow(sdc, 5.0) * 0.55 + pow(sdc, 30.0) * 0.8) * (1.0 - thick * 0.6); // silver lining
    cc = mix(cc, uHorizon, pow(1.0 - d.y, 8.0) * 0.55);
    col = mix(col, cc, cov * 0.95);
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
