// HDR post chain: scene -> half-float MSAA target -> bloom mip chain ->
// composite (exposure, ACES filmic, bloom, vignette, underwater tint + god rays,
// lens droplets, FXAA-lite, dithering, sRGB). Few, cheap passes.
import * as THREE from 'three';

const fsVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const brightFrag = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
  gl_FragColor = vec4(min(c * k, vec3(40.0)), 1.0);
}`;

const downFrag = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;

const upFrag = /* glsl */ `
uniform sampler2D tSrc; uniform sampler2D tPrev; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 12.0 + texture2D(tPrev, vUv).rgb, 1.0);
}`;

const compositeFrag = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tBloom;
uniform vec2 uTexel; uniform float uExposure; uniform float uBloom; uniform float uVignette;
uniform float uUnderwater; uniform float uTime; uniform float uDroplets; uniform float uFxaa;
uniform vec3 uUnderColor; uniform float uFlash; uniform vec3 uFlashColor;
varying vec2 vUv;
vec3 aces(vec3 x) {
  // Stephen Hill's fitted ACES
  const mat3 m1 = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 m2 = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = m1 * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(m2 * (a / b), 0.0, 1.0);
}
float h21(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
vec3 tonemap(vec3 c) { return aces(c * uExposure); }
vec3 sampleScene(vec2 uv) { return texture2D(tScene, uv).rgb + texture2D(tBloom, uv).rgb * uBloom; }
void main() {
  vec2 uv = vUv;
  // lens droplets (spray on the lens): refract through procedural drops
  if (uDroplets > 0.001) {
    vec2 g = uv * vec2(16.0, 9.0) * 1.6;
    vec2 id = floor(g); vec2 f = fract(g) - 0.5;
    float r = h21(id);
    float life = fract(uTime * (0.15 + r * 0.25) + r * 7.0);
    vec2 off = vec2(h21(id + 3.1) - 0.5, h21(id + 7.7) - 0.5) * 0.6;
    float d = length(f - off);
    float size = 0.12 + 0.18 * h21(id + 1.3);
    float drop = smoothstep(size, size * 0.6, d) * step(0.55, r) * (1.0 - life) * uDroplets;
    uv += (f - off) * drop * 0.08;
  }
  vec3 col = tonemap(sampleScene(uv));
  if (uFxaa > 0.5) {
    vec3 n = tonemap(sampleScene(uv + vec2(0.0, uTexel.y)));
    vec3 s = tonemap(sampleScene(uv - vec2(0.0, uTexel.y)));
    vec3 e = tonemap(sampleScene(uv + vec2(uTexel.x, 0.0)));
    vec3 w = tonemap(sampleScene(uv - vec2(uTexel.x, 0.0)));
    vec3 L = vec3(0.299, 0.587, 0.114);
    float lm = dot(col, L), ln = dot(n, L), ls = dot(s, L), le = dot(e, L), lw = dot(w, L);
    float mx = max(lm, max(max(ln, ls), max(le, lw))), mn = min(lm, min(min(ln, ls), min(le, lw)));
    float contrast = mx - mn;
    if (contrast > max(0.05, mx * 0.12)) {
      vec2 dir = vec2(-((ln + ls) - (le + lw)) * 0.0, 0.0);
      dir = normalize(vec2(-(ln - ls), (le - lw)) + 1e-5);
      vec3 a = tonemap(sampleScene(uv + dir * uTexel * 0.75));
      vec3 b = tonemap(sampleScene(uv - dir * uTexel * 0.75));
      col = mix(col, (a + b) * 0.5, 0.65);
    }
  }
  if (uUnderwater > 0.0) {
    float depthFog = 0.55;
    col = mix(col, uUnderColor, depthFog * uUnderwater);
    // god rays from the surface
    float x = uv.x * 14.0 + sin(uv.y * 3.0 + uTime * 0.4) * 0.6;
    float rays = pow(abs(sin(x + uTime * 0.25) * sin(x * 1.7 - uTime * 0.17)), 6.0);
    rays *= smoothstep(0.1, 1.0, uv.y);
    col += uUnderColor * rays * 1.4 * uUnderwater + vec3(0.3, 0.6, 0.6) * rays * 0.15 * uUnderwater;
  }
  // vignette
  vec2 q = vUv - 0.5;
  col *= 1.0 - uVignette * dot(q, q) * 1.6;
  col = mix(col, uFlashColor, uFlash);
  // sRGB encode + dither
  col = pow(col, vec3(1.0 / 2.2));
  col += (h21(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.samples = 4;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(geo);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.main = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType, samples: this.samples, depthBuffer: true });
    this.levels = [];
    for (let i = 0; i < 5; i++) this.levels.push(new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType, depthBuffer: false }));
    this.ups = [];
    for (let i = 0; i < 4; i++) this.ups.push(new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType, depthBuffer: false }));
    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: fsVert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.bright = mk(brightFrag, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.6 } });
    this.down = mk(downFrag, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.up = mk(upFrag, { tSrc: { value: null }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.composite = mk(compositeFrag, {
      tScene: { value: null }, tBloom: { value: null }, uTexel: { value: new THREE.Vector2() },
      uExposure: { value: 1 }, uBloom: { value: 0.12 }, uVignette: { value: 0.32 }, uUnderwater: { value: 0 },
      uTime: { value: 0 }, uDroplets: { value: 0 }, uFxaa: { value: 0 }, uUnderColor: { value: new THREE.Color(0.02, 0.18, 0.22) },
      uFlash: { value: 0 }, uFlashColor: { value: new THREE.Color(1, 1, 1) },
    });
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;
    this.bloomEnabled = true;
  }

  setSamples(n) {
    if (n === this.samples) return;
    this.samples = n;
    const w = this.main.width, h = this.main.height;
    this.main.dispose();
    this.main = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: n, depthBuffer: true });
  }

  setSize(w, h) {
    this.main.setSize(w, h);
    let lw = Math.max(1, w >> 1), lh = Math.max(1, h >> 1);
    for (let i = 0; i < this.levels.length; i++) {
      this.levels[i].setSize(lw, lh);
      if (i < this.ups.length) this.ups[i].setSize(lw, lh);
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
    }
    this.composite.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  render(dt, time) {
    const r = this.renderer;
    let bloomTex = this.black;
    if (this.bloomEnabled) {
      const L = this.levels;
      this.bright.uniforms.tSrc.value = this.main.texture;
      this.bright.uniforms.uTexel.value.set(1 / this.main.width, 1 / this.main.height);
      this.pass(this.bright, L[0]);
      for (let i = 1; i < L.length; i++) {
        this.down.uniforms.tSrc.value = L[i - 1].texture;
        this.down.uniforms.uTexel.value.set(1 / L[i - 1].width, 1 / L[i - 1].height);
        this.pass(this.down, L[i]);
      }
      // upsample: ups[i] = blur(L[i+1] or ups[i+1]) + L[i]
      let src = L[L.length - 1];
      for (let i = this.ups.length - 1; i >= 0; i--) {
        this.up.uniforms.tSrc.value = src.texture;
        this.up.uniforms.tPrev.value = L[i].texture;
        this.up.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
        this.pass(this.up, this.ups[i]);
        src = this.ups[i];
      }
      bloomTex = this.ups[0].texture;
    }
    const c = this.composite.uniforms;
    c.tScene.value = this.main.texture;
    c.tBloom.value = bloomTex;
    c.uTime.value = time;
    this.pass(this.composite, null);
    void dt; void r;
  }
}
