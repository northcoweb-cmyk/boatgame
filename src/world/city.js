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
  float H = vBld.x;
  // building style from its hash: 0 = glass curtain-wall tower, 1 = white
  // balcony condo, 2 = pastel Art-Deco / MiMo low-rise with punched windows
  float sty = H > 34.0 ? (vHash > 0.45 || glass > 0.5 ? 0.0 : 1.0) : 2.0;
  float isGlass = step(sty, 0.5), isCondo = step(0.5, sty) * step(sty, 1.5), isDeco = step(1.5, sty);
  float ww = mix(mix(0.52, 0.86, glass), 0.96, isGlass), wh = mix(mix(0.42, 0.74, glass), 0.9, isGlass);
  ww = mix(ww, 0.34, isDeco); wh = mix(wh, 0.5, isDeco);
  float win = step(abs(f.x - 0.5), ww * 0.5) * step(abs(f.y - 0.55), wh * 0.5) * wall * step(4.0, vFWorld.y) * step(vFWorld.y, H - 2.0);
  float r = bdHash(cell + vec2(vHash * 97.0, floor(vHash * 1000.0)));
  vec3 pastel[4];
  pastel[0] = vec3(0.98, 0.86, 0.80); pastel[1] = vec3(0.80, 0.93, 0.90); pastel[2] = vec3(0.99, 0.95, 0.80); pastel[3] = vec3(0.95, 0.95, 0.93);
  vec3 deco = pastel[int(mod(floor(vHash * 37.0), 4.0))];
  diffuseColor.rgb *= vec3(1.0, 0.97, 0.92);
  diffuseColor.rgb = mix(diffuseColor.rgb, deco * 0.95, isDeco * wall * 0.85);
  // glass towers: blue-green tinted panels with per-panel variation and thin mullions
  vec3 gPanel = mix(vec3(0.10, 0.20, 0.26), vec3(0.20, 0.34, 0.40), r * 0.6 + 0.2 * sin(vFWorld.y * 0.05 + vHash * 6.0));
  vec3 winCol = mix(mix(vec3(0.045, 0.07, 0.10), vec3(0.10, 0.17, 0.24), r * 0.7 + glass * 0.3), gPanel, isGlass);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.75, 0.78, 0.8), vec3(0.15, 0.22, 0.27), isGlass), isGlass * wall * step(4.0, vFWorld.y));
  diffuseColor.rgb = mix(diffuseColor.rgb, winCol, win * 0.92);
  float slab = step(0.9, f.y) * wall * step(4.0, vFWorld.y) * (isCondo + isDeco * 0.4 + isGlass * 0.15);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.92, 0.9), slab * 0.85);
  // podium / lobby band
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.18, 0.2, 0.22), wall * (1.0 - step(4.0, vFWorld.y)) * 0.6);
  // flat roofs: light grey membrane with darker equipment patches
  float roof = 1.0 - wall;
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.62, 0.62, 0.6), vec3(0.4, 0.42, 0.43), step(0.7, bdHash(floor(vFWorld.xz / 4.0)))), roof * 0.8);
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
  roughnessFactor = mix(roughnessFactor, 0.08, max(win, isGlass * wall));
  metalnessFactor = mix(metalnessFactor, 0.7, max(win * glass, isGlass * wall * 0.9));
}`);
  };
  mat.customProgramCacheKey = () => 'facade-v2';
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
  const coreMat = facadeMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.1, envMapIntensity: 1.4 }));
  const heroCount = { low: 5, medium: 10, high: 14, ultra: 14 }[game.quality.preset] ?? 14;
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
      c.material.transparent = false; c.material.opacity = 1; c.material.alphaTest = 0; c.material.alphaMap = null; c.material.depthWrite = true; c.material.side = THREE.DoubleSide;
      if ('transmission' in c.material) c.material.transmission = 0;
      if (/glass|window|mirror/i.test(c.material.name) || (c.material.map === null && c.material.metalness > 0.3)) { c.material.color.setRGB(0.5, 0.66, 0.76); c.material.roughness = 0.12; c.material.metalness = 0.35; c.material.transparent = false; c.material.opacity = 1; c.material.depthWrite = true; }
      else { c.material.color.setRGB(0.95, 0.95, 0.93); c.material.roughness = 0.6; }
      c.castShadow = false; c.receiveShadow = true;
      tg.add(c);
    }
    // opaque glass core inside the frame: no tower can ever read see-through
    {
      const bw = tw.box.max.x - tw.box.min.x, bd = tw.box.max.z - tw.box.min.z, bh = tw.box.max.y - tw.box.min.y;
      const cg = new THREE.BoxGeometry(bw * 0.84, bh * 0.985, bd * 0.84).toNonIndexed();
      const n = cg.attributes.position.count, col = new Float32Array(n * 4), bld = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) { col.set([0.55, 0.62, 0.66, 0.2 + i * 0.05], k * 4); bld.set([site.h + 2, 0.95], k * 2); }
      cg.setAttribute('color', new THREE.BufferAttribute(col, 4)); cg.setAttribute('aBld', new THREE.BufferAttribute(bld, 2)); cg.deleteAttribute('uv');
      const core = new THREE.Mesh(cg, coreMat);
      core.position.set(0, tw.box.min.y + bh * 0.4925, 0);
      tg.add(core);
    }
    const s = site.h / (tw.box.max.y - tw.box.min.y);
    tg.scale.setScalar(s);
    tg.position.set(site.x, heightAt(site.x, site.z) - 0.5, site.z);
    tg.rotation.y = (i * 1.3) % Math.PI;
    tg.traverse((o) => { if (o.isMesh) o.material.envMapIntensity = 1.2; });
    group.add(tg);
    tops.push(new THREE.Vector3(site.x, site.h + 1, site.z));
  }

  // --- The Vizcayne next to Bayside
  const viz = A.cloneModel('vizcayne', { cloneMaterials: false });
  viz.position.set(-2450, heightAt(-2450, -540) - 0.3, -540);
  viz.rotation.y = Math.PI * 0.5;
  viz.traverse((o) => { if (o.isMesh) { o.castShadow = false; for (const m of [].concat(o.material)) { m.color.setRGB(0.62, 0.72, 0.8); m.metalness = 0.45; m.roughness = 0.22; m.envMapIntensity = 1.2; } } });
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

  // no see-through towers: every glazed material in the skyline is an opaque,
  // tinted, sky-reflecting curtain wall (alpha-blended glass reads as a ghost)
  const fixed = new Set();
  group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh && !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || fixed.has(m) || !m.isMeshStandardMaterial) continue;
      fixed.add(m);
      const glassy = m.transparent || m.opacity < 1 || (m.transmission || 0) > 0 || /glass|window|vidro|cristal/i.test(m.name);
      if (!glassy) continue;
      m.transparent = false; m.opacity = 1; m.depthWrite = true; m.alphaTest = 0; m.alphaMap = null;
      if ('transmission' in m) m.transmission = 0;
      m.color.setRGB(0.22, 0.34, 0.42); m.metalness = 0.75; m.roughness = 0.08; m.envMapIntensity = 1.4;
      m.side = THREE.DoubleSide; m.needsUpdate = true;
    }
  });
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
