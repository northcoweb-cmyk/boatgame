// Miami skyline: the real building footprints from the attached "Miami, Florida,
// USA" model (merged into one draw call, procedural window facade shader with
// lit windows at night), hero towers from the attached skyscraper pack at the
// tallest real sites, The Vizcayne, the Bayside Ferris wheel, port cranes and
// rooftop aviation lights.
import * as THREE from 'three';
import { bakeModel, instanceParts, makeMatrix } from '../assets/assets.js';
import { NOISE_GLSL } from '../water/glsl.js';
import { heightAt } from './geography.js';

export const cityUniforms = { uNight: { value: 0 }, uTime: { value: 0 } };

function facadeMaterial(base) {
  const mat = base || new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.05 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = cityUniforms.uNight;
    shader.uniforms.uTime = cityUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFWorld; varying vec3 vFNormal; varying vec2 vBld; varying float vHash;\nattribute vec2 aBld;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 fw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          fw = instanceMatrix * fw;
        #endif
        fw = modelMatrix * fw;
        vFWorld = fw.xyz; vFNormal = normalize(mat3(modelMatrix) * objectNormal);
        vBld = aBld;
        #ifdef USE_COLOR_ALPHA
        vHash = color.a;
        #else
        vHash = 0.5;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight; uniform float uTime;
varying vec3 vFWorld; varying vec3 vFNormal; varying vec2 vBld; varying float vHash;
${NOISE_GLSL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 n = normalize(vFNormal);
  float wall = 1.0 - smoothstep(0.35, 0.6, abs(n.y));
  vec2 t = normalize(vec2(-n.z, n.x) + 1e-5);
  float along = dot(vFWorld.xz, t);
  float floorH = 3.6;
  float fy = vFWorld.y / floorH;
  float fx = along / 2.7;
  vec2 cell = vec2(floor(fx), floor(fy));
  vec2 f = vec2(fract(fx), fract(fy));
  float glass = vBld.y;
  float ww = mix(0.52, 0.86, glass), wh = mix(0.42, 0.74, glass);
  float win = step(abs(f.x - 0.5), ww * 0.5) * step(abs(f.y - 0.55), wh * 0.5) * wall * step(4.0, vFWorld.y) * step(vFWorld.y, vBld.x - 2.0);
  float r = bdHash(cell + vec2(vHash * 97.0, floor(vHash * 1000.0)));
  // daytime glass: dark blue-grey, sky-reflective
  // dark glazing, white balcony slab at each floor line, warm stucco walls
  diffuseColor.rgb *= vec3(1.0, 0.97, 0.92);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.045, 0.07, 0.10), vec3(0.10, 0.17, 0.24), r * 0.7 + glass * 0.3), win * 0.92);
  float slab = step(0.9, f.y) * wall * step(4.0, vFWorld.y);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.92, 0.9), slab * 0.85);
  // lit windows at night: warm & cool interiors, some dark
  float lit = step(1.0 - (0.18 + 0.5 * uNight), r) * win;
  vec3 warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.75, 0.85, 1.0), step(0.78, bdHash(cell * 1.7 + vHash)));
  totalEmissiveRadiance += warm * lit * uNight * (1.6 + 1.8 * r);
  // crown lights on tall towers (Miami signature LED tops)
  float crown = smoothstep(vBld.x - 7.0, vBld.x - 1.0, vFWorld.y) * step(110.0, vBld.x) * wall;
  vec3 crownCol = 0.5 + 0.5 * cos(6.2831 * (vHash + vec3(0.0, 0.33, 0.67)) + uTime * 0.1);
  totalEmissiveRadiance += crownCol * crown * uNight * 3.0;
  // street-level retail glow
  totalEmissiveRadiance += vec3(1.0, 0.82, 0.55) * wall * (1.0 - smoothstep(0.5, 4.0, vFWorld.y - 2.4)) * uNight * 0.6 * step(0.4, r);
  roughnessFactor = mix(roughnessFactor, 0.12, win);
  metalnessFactor = mix(metalnessFactor, 0.55, win * glass);
}`);
  };
  mat.customProgramCacheKey = () => 'facade-v1';
  return mat;
}

export function buildCity(game) {
  const group = new THREE.Group();
  group.name = 'city';
  const A = game.assets;

  // --- real Miami buildings (one draw call)
  const miami = A.models.miami;
  miami.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (g.attributes.uv) { g.setAttribute('aBld', g.attributes.uv); g.deleteAttribute('uv'); }
    o.material = facadeMaterial();
    o.castShadow = false; // too large for the shadow frustum; buildings receive only
    o.receiveShadow = true;
    o.frustumCulled = true;
  });
  group.add(miami);

  // aviation lights on the tallest roofs
  const tops = [];
  miami.updateMatrixWorld(true);
  const _tv = new THREE.Vector3();
  miami.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position, bld = o.geometry.attributes.aBld;
    if (!bld) return;
    const seen = new Set();
    for (let i = 0; i < pos.count; i += 3) {
      const h = bld.getX(i);
      if (h < 120) continue;
      _tv.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (Math.abs(_tv.y - h) > 0.8) continue;
      const k = Math.round(_tv.x / 40) + ':' + Math.round(_tv.z / 40);
      if (seen.has(k)) continue;
      seen.add(k);
      tops.push(new THREE.Vector3(_tv.x, _tv.y + 0.6, _tv.z));
    }
  });

  // --- hero towers from the skyscraper pack at the tallest real sites
  const pack = A.models.skyscrapers;
  pack.updateMatrixWorld(true);
  const towers = [];
  pack.traverse((o) => {
    if (!o.isMesh) return;
    const bb = new THREE.Box3().setFromObject(o);
    const cx = (bb.min.x + bb.max.x) / 2;
    let t = towers.find((tw) => Math.abs(tw.cx - cx) < 20);
    if (!t) { t = { cx, meshes: [], box: new THREE.Box3() }; towers.push(t); }
    t.meshes.push(o); t.box.union(bb);
  });
  towers.sort((a, b) => a.cx - b.cx);
  const heroCount = { low: 0, medium: 4, high: 7, ultra: 7 }[game.quality.preset] ?? 7;
  const sites = game.data.heroTowers;
  for (let i = 0; i < Math.min(heroCount, sites.length, towers.length); i++) {
    const tw = towers[i % towers.length], site = sites[i];
    const tg = new THREE.Group();
    for (const m of tw.meshes) {
      const c = m.clone();
      m.matrixWorld.decompose(c.position, c.quaternion, c.scale); // world transform only (no double-apply)
      c.position.x -= (tw.box.min.x + tw.box.max.x) / 2;
      c.position.z -= (tw.box.min.z + tw.box.max.z) / 2;
      c.material = m.material.clone();
      if (/glass/i.test(c.material.name)) { c.material.color.setRGB(0.36, 0.52, 0.62); c.material.roughness = 0.08; c.material.metalness = 0.75; c.material.transparent = false; c.material.opacity = 1; c.material.depthWrite = true; }
      else { c.material.color.setRGB(0.92, 0.93, 0.92); }
      c.castShadow = false; c.receiveShadow = true;
      tg.add(c);
    }
    const s = site.h / (tw.box.max.y - tw.box.min.y);
    tg.scale.setScalar(s);
    tg.position.set(site.x, heightAt(site.x, site.z) - 0.5, site.z);
    tg.rotation.y = (i * 1.3) % Math.PI;
    group.add(tg);
    tops.push(new THREE.Vector3(site.x, site.h + 1, site.z));
  }

  // --- The Vizcayne next to Bayside
  const viz = A.cloneModel('vizcayne', { cloneMaterials: false });
  viz.position.set(-2450, heightAt(-2450, -540) - 0.3, -540);
  viz.rotation.y = Math.PI * 0.5;
  viz.traverse((o) => { if (o.isMesh) { o.castShadow = false; } });
  group.add(viz);
  tops.push(new THREE.Vector3(-2450, 149, -540));

  // --- Bayside Ferris wheel (attached model, with its own rotation animation)
  const wheel = A.cloneModel('ferris', { cloneMaterials: true });
  wheel.position.set(-2320, heightAt(-2320, -860) - 0.2, -860);
  wheel.rotation.y = Math.PI / 2;
  const neon = [];
  wheel.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    if (/wheel|polySurface/.test(o.name)) neon.push(o.material);
  });
  group.add(wheel);
  game.mixers.push(Object.assign(new THREE.AnimationMixer(wheel), {}));
  const mixer = game.mixers[game.mixers.length - 1];
  const clips = A.models.ferris.userData.animations || [];
  if (clips.length) { const act = mixer.clipAction(clips[0]); act.timeScale = 0.25; act.play(); }
  game.cityNeon = neon;

  // --- port gantry cranes on Dodge Island (procedural, instanced)
  const craneGeo = makeCraneGeometry();
  const craneMat = new THREE.MeshStandardMaterial({ color: 0xd8452f, roughness: 0.6, metalness: 0.3 });
  const craneSites = [[-480, 1360, 0.42], [-330, 1420, 0.42], [-180, 1480, 0.42], [-30, 1540, 0.42], [120, 1600, 0.42]];
  const cranes = new THREE.InstancedMesh(craneGeo, craneMat, craneSites.length);
  craneSites.forEach((c, i) => cranes.setMatrixAt(i, makeMatrix(c[0], heightAt(c[0], c[1]) - 0.2, c[1], c[2])));
  cranes.castShadow = false;
  group.add(cranes);

  // --- aviation / crown lights
  const avGeo = new THREE.SphereGeometry(1.2, 6, 4);
  const avMat = new THREE.MeshBasicMaterial({ color: 0xff2010 });
  const av = new THREE.InstancedMesh(avGeo, avMat, tops.length);
  tops.forEach((p, i) => av.setMatrixAt(i, makeMatrix(p.x, p.y, p.z)));
  av.visible = false;
  group.add(av);
  game.aviationLights = av;

  game.scene.add(group);
  return group;
}

function makeCraneGeometry() {
  const parts = [];
  const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); parts.push(g); };
  for (const sx of [-9, 9]) for (const sz of [-6, 6]) box(1.4, 42, 1.4, sx, 21, sz);
  box(20, 2, 14, 0, 42, 0);
  box(3, 3, 95, 0, 46, -20);       // boom over the water
  box(2, 10, 2, 0, 52, 8);
  box(6, 5, 6, 0, 40, 10);         // machinery house
  const g = mergeAll(parts);
  return g;
}

function mergeAll(geos) {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  const idx = [];
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (const i of g.index.array) idx.push(i + o);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

export { mergeAll, facadeMaterial, bakeModel, instanceParts };
