// Terrain: bakes the analytic height field into a data texture (used by the
// water shader for depth tint / shoreline foam / wave attenuation, the chart and
// the minimap) and builds a chunked LOD mesh with skirts.
import * as THREE from 'three';
import { heightAt, urbanMask, seagrassMask, WORLD_HALF, WORLD_SIZE } from './geography.js';
import { NOISE_GLSL, SEABED_GLSL, TERRAIN_SAMPLE_GLSL } from '../water/glsl.js';

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

export class Terrain {
  constructor() {
    this.mesh = null;
    this.texture = null;
    this.heights = null;
    this.res = 0;
  }

  async bake(res, onProgress) {
    this.res = res;
    const n = res * res;
    const half = new Uint16Array(n * 4);
    const heights = new Float32Array(n);
    const step = WORLD_SIZE / (res - 1);
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let j = 0; j < res; j++) {
      const z = -WORLD_HALF + j * step;
      for (let i = 0; i < res; i++) {
        const x = -WORLD_HALF + i * step;
        const h = heightAt(x, z);
        const k = j * res + i;
        heights[k] = h;
        half[k * 4] = toHalf(h);
        half[k * 4 + 1] = toHalf(h > -0.5 ? urbanMask(x, z) : 0);
        half[k * 4 + 2] = toHalf(seagrassMask(x, z));
        half[k * 4 + 3] = toHalf(1);
      }
      if ((j & 31) === 0) { onProgress && onProgress(j / res); await nextFrame(); }
    }
    this.heights = heights;
    const tex = new THREE.DataTexture(half, res, res, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.texture = tex;
    return tex;
  }

  // Bilinear lookup in the baked grid (cheap, used by minimap/chart/AI).
  sampleBaked(x, z) {
    const r = this.res, f = (r - 1) / WORLD_SIZE;
    const gx = Math.min(r - 1.001, Math.max(0, (x + WORLD_HALF) * f));
    const gz = Math.min(r - 1.001, Math.max(0, (z + WORLD_HALF) * f));
    const ix = gx | 0, iz = gz | 0, fx = gx - ix, fz = gz - iz;
    const h = this.heights, k = iz * r + ix;
    return (h[k] * (1 - fx) + h[k + 1] * fx) * (1 - fz) + (h[k + r] * (1 - fx) + h[k + r + 1] * fx) * fz;
  }

  async buildMesh(quality, sandTex, onProgress) {
    const chunks = 12, size = WORLD_SIZE / chunks;
    const hiRes = { low: 40, medium: 64, high: 88, ultra: 120 }[quality] || 88;
    const positions = [], normals = [], indices = [];
    let vbase = 0;
    for (let cz = 0; cz < chunks; cz++) {
      for (let cx = 0; cx < chunks; cx++) {
        const x0 = -WORLD_HALF + cx * size, z0 = -WORLD_HALF + cz * size;
        // classify chunk from the baked grid
        let mn = 1e9, mx = -1e9;
        for (let s = 0; s <= 8; s++) for (let t = 0; t <= 8; t++) {
          const h = this.sampleBaked(x0 + (s / 8) * size, z0 + (t / 8) * size);
          mn = Math.min(mn, h); mx = Math.max(mx, h);
        }
        let n;
        if (mx < -3.0) n = 10;                       // deep water only
        else if (mn > 1.2 && mx - mn < 2.5) n = Math.max(16, hiRes >> 2); // flat inland
        else n = hiRes;                               // shoreline / shallows / islands
        const verts = (n + 1) * (n + 1);
        const hgt = new Float32Array(verts);
        for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
          const x = x0 + (i / n) * size, z = z0 + (j / n) * size;
          const h = heightAt(x, z);
          hgt[j * (n + 1) + i] = h;
          positions.push(x, h, z);
        }
        // normals by central differences on the grid (edge: one-sided)
        const d = size / n;
        for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
          const hl = i > 0 ? hgt[j * (n + 1) + i - 1] : heightAt(x0 + (i - 1) * d, z0 + j * d);
          const hr = i < n ? hgt[j * (n + 1) + i + 1] : heightAt(x0 + (i + 1) * d, z0 + j * d);
          const hd = j > 0 ? hgt[(j - 1) * (n + 1) + i] : heightAt(x0 + i * d, z0 + (j - 1) * d);
          const hu = j < n ? hgt[(j + 1) * (n + 1) + i] : heightAt(x0 + i * d, z0 + (j + 1) * d);
          const nx = hl - hr, nz = hd - hu, ny = 2 * d;
          const l = Math.hypot(nx, ny, nz);
          normals.push(nx / l, ny / l, nz / l);
        }
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
          const a = vbase + j * (n + 1) + i, b = a + 1, c = a + (n + 1), e = c + 1;
          indices.push(a, c, b, b, c, e);
        }
        // skirts hide cracks between chunks of different resolution
        const edge = (idxs) => {
          const start = positions.length / 3;
          for (const k of idxs) {
            const p = (vbase + k) * 3;
            positions.push(positions[p], positions[p + 1] - 4, positions[p + 2]);
            normals.push(normals[p], normals[p + 1], normals[p + 2]);
          }
          for (let k = 0; k < idxs.length - 1; k++) {
            const a = vbase + idxs[k], b = vbase + idxs[k + 1], c = start + k, e = start + k + 1;
            indices.push(a, b, c, b, e, c, a, c, b, b, c, e); // double-sided skirt
          }
        };
        const top = [], bot = [], left = [], right = [];
        for (let i = 0; i <= n; i++) { top.push(i); bot.push(n * (n + 1) + i); left.push(i * (n + 1)); right.push(i * (n + 1) + n); }
        const before = positions.length / 3;
        edge(top); edge(bot); edge(left); edge(right);
        vbase = positions.length / 3;
        void before;
      }
      onProgress && onProgress(cz / chunks);
      await nextFrame();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    this.uniforms = { uTerrain: { value: this.texture }, uSandTex: { value: sandTex }, uTime: { value: 0 } };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
uniform float uTime;
${NOISE_GLSL}
${TERRAIN_SAMPLE_GLSL}
${SEABED_GLSL}
`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 xz = vWPos.xz;
  float h = vWPos.y;
  vec4 td = terrainData(xz);
  float urban = td.g;
  float slope = 1.0 - clamp(vWNormal.y, 0.0, 1.0);
  vec3 sand = sandAlbedo(xz);
  vec3 col;
  if (h < 0.0) {
    col = seabedColor(xz, h, td.b);
    col += vec3(0.9, 1.0, 1.0) * caustics(xz, uTime) * 0.35 * smoothstep(-6.0, -0.2, h);
  } else {
    float n = bdFbm(xz * 0.05);
    vec3 grass = mix(vec3(0.24, 0.36, 0.12), vec3(0.36, 0.45, 0.17), n);
    grass = mix(grass, vec3(0.42, 0.40, 0.24), bdNoise(xz * 0.21) * 0.35);
    vec3 concrete = mix(vec3(0.62, 0.60, 0.56), vec3(0.74, 0.72, 0.68), bdNoise(xz * 0.08));
    // pavers / promenade pattern
    vec2 g = abs(fract(xz * 0.25) - 0.5);
    concrete *= 0.94 + 0.06 * step(0.47, max(g.x, g.y));
    float sandAmt = 1.0 - smoothstep(1.2 + n * 0.6, 2.2 + n * 0.6, h);
    vec3 land = mix(grass, concrete, smoothstep(0.3, 0.7, urban));
    col = mix(land, sand, sandAmt * (1.0 - urban * 0.8));
    // wet sand line + rocks on steep faces
    col *= mix(0.68, 1.0, smoothstep(0.05, 0.45, h));
    col = mix(col, vec3(0.42, 0.40, 0.37) * (0.8 + 0.4 * bdNoise(xz * 0.7)), smoothstep(0.35, 0.6, slope) * (1.0 - urban));
  }
  diffuseColor.rgb = col;
}`);
    };
    mat.customProgramCacheKey = () => 'terrain-v1';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';
    this.mesh.matrixAutoUpdate = false;
    return this.mesh;
  }

  update(time) { if (this.uniforms) this.uniforms.uTime.value = time; }
}
