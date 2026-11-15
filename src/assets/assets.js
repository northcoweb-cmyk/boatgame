// Asset pipeline: loads every attached model (meshopt-compressed GLB, webp
// textures — see README "Asset analysis"), normalises scale / pivot /
// orientation to the game's conventions (metres, Y up, forward = -Z), fixes
// materials, and offers baking helpers for instancing and merged draw calls.
import * as THREE from 'three';
import { GLTFLoader } from '../../vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from '../../vendor/three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from '../../vendor/three/addons/utils/BufferGeometryUtils.js';

// Per-model normalisation spec. `fit` scales the model so the given bounding
// box axis (after rotation) matches `size` metres.
export const MODEL_SPECS = {
  runabout:      { url: 'assets/models/runabout.glb',      rotY: Math.PI,      fit: { axis: 'z', size: 6.7 }, base: 'keel' },
  rib:           { url: 'assets/models/rib.glb',           rotY: 0,            fit: { axis: 'z', size: 4.13 }, base: 'keel' },
  bass:          { url: 'assets/models/bass.glb',          rotY: Math.PI,      fit: { axis: 'z', size: 6.6 }, base: 'keel' },
  yacht:         { url: 'assets/models/yacht-small.glb',   rotY: -Math.PI / 2, fit: { axis: 'z', size: 11.8 }, base: 'keel' },
  superyacht:    { url: 'assets/models/yacht-frickie.glb', rotY: 0,            fit: { axis: 'z', size: 62 }, base: 'keel' },
  towboat:       { url: 'assets/models/towboat.glb',       rotY: Math.PI,      fit: { axis: 'z', size: 11.2 }, base: 'keel' },
  man:           { url: 'assets/models/man.glb',           rotY: 0,            fit: { axis: 'y', size: 1.8 }, base: 'feet' },
  woman:         { url: 'assets/models/woman.glb',         rotY: 0,            fit: { axis: 'y', size: 1.68 }, base: 'feet' },
  womanSeatedA:  { url: 'assets/models/woman-seated-a.glb', rotY: 0,           fit: { axis: 'y', size: 0.86 }, base: 'feet' },
  womanSeatedB:  { url: 'assets/models/woman-seated-b.glb', rotY: 0,           fit: { axis: 'y', size: 0.9 }, base: 'feet' },
  palm:          { url: 'assets/models/palm.glb',          rotY: 0,            fit: { axis: 'y', size: 11 }, base: 'feet', trunkPivot: true },
  dock:          { url: 'assets/models/dock.glb',          rotY: 0,            fit: null, base: 'none' },
  beachPack:     { url: 'assets/models/beach-pack.glb',    rotY: 0,            fit: null, base: 'none' },
  ferris:        { url: 'assets/models/ferris-wheel.glb',  rotY: 0,            fit: { axis: 'y', size: 58 }, base: 'feet' },
  vizcayne:      { url: 'assets/models/vizcayne.glb',      rotY: 0,            fit: { axis: 'y', size: 148 }, base: 'feet' },
  skyscrapers:   { url: 'assets/models/skyscrapers.glb',   rotY: 0,            fit: null, base: 'none' },
  miami:         { url: 'assets/models/miami-buildings.glb', rotY: 0,          fit: null, base: 'none' },
  villaSea:      { url: 'assets/models/villa-sea.glb',     rotY: 0,            fit: null, base: 'feet' },
  villaSmall:    { url: 'assets/models/villa-small.glb',   rotY: 0,            fit: null, base: 'none' },
  villaModern:   { url: 'assets/models/villa-modern.glb',  rotY: 0,            fit: null, base: 'none' },
  shack:         { url: 'assets/models/shack.glb',         rotY: 0,            fit: { axis: 'x', size: 11 }, base: 'feet' },
  plane:         { url: 'assets/models/plane.glb',         rotY: Math.PI,            fit: { axis: 'x', size: 11.6 }, base: 'none' },
  carFerrari:    { url: 'assets/models/car-ferrari.glb',   rotY: Math.PI,      fit: { axis: 'z', size: 4.59 }, base: 'feet' },
  carF22:        { url: 'assets/models/car-bmw-f22.glb',   rotY: Math.PI,      fit: { axis: 'z', size: 4.43 }, base: 'feet' },
  carM4:         { url: 'assets/models/car-bmw-m4.glb',    rotY: Math.PI,      fit: { axis: 'z', size: 4.67 }, base: 'feet' },
  cars:          { url: 'assets/models/cars.glb',          rotY: 0,            fit: null, base: 'none' },
  road:          { url: 'assets/models/road.glb',          rotY: 0,            fit: null, base: 'none' },
  bridge:        { url: 'assets/models/bridge.glb',        rotY: 0,            fit: null, base: 'none' },
  lighthouse:    { url: 'assets/models/lighthouse.glb',    rotY: 0,            fit: { axis: 'y', size: 36 }, base: 'feet' },
  pistol:        { url: 'assets/models/pistol.glb',        rotY: 0,            fit: { axis: 'max', size: 0.2 }, base: 'center' },
};

export class Assets {
  constructor(renderer) {
    this.loader = new GLTFLoader();
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.renderer = renderer;
    this.raw = {};
    this.models = {};
    this.textures = {};
    this.maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  }

  async loadAll(names, onProgress) {
    let done = 0;
    await Promise.all(names.map(async (n) => {
      const spec = MODEL_SPECS[n];
      const gltf = await this.loader.loadAsync(spec.url);
      this.raw[n] = gltf;
      this.models[n] = this.normalise(gltf, spec, n);
      done++;
      onProgress && onProgress(done / names.length, n);
    }));
  }

  async loadTexture(name, url, opts = {}) {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.maxAniso);
    this.textures[name] = tex;
    return tex;
  }

  // Skinned meshes (e.g. the bass boat's cubby-lid rig) are baked to static
  // geometry in their bind pose so measuring, raycasting and baking all see
  // real vertex positions.
  bakeSkinned(root) {
    const list = [];
    root.traverse((o) => { if (o.isSkinnedMesh) list.push(o); });
    const v = new THREE.Vector3();
    for (const sm of list) {
      sm.skeleton.update();
      const src = sm.geometry;
      const g = src.clone();
      for (const k of ['skinIndex', 'skinWeight']) g.deleteAttribute(k);
      toFloatAttrs(g, ['position', 'normal']);
      const pos = g.attributes.position;
      const srcPos = src.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(srcPos, i);
        sm.applyBoneTransform(i, v);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      g.computeVertexNormals();
      g.computeBoundingBox(); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, sm.material);
      m.name = sm.name;
      // applyBoneTransform returns positions in the mesh's local space
      m.position.copy(sm.position); m.quaternion.copy(sm.quaternion); m.scale.copy(sm.scale);
      sm.parent.add(m);
      sm.parent.remove(sm);
    }
  }

  normalise(gltf, spec, name) {
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    this.bakeSkinned(root);
    root.updateMatrixWorld(true);
    const inner = new THREE.Group();
    inner.add(root);
    inner.rotation.y = spec.rotY || 0;
    inner.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(inner, true);
    const size = box.getSize(new THREE.Vector3());
    let scale = 1;
    if (spec.fit) {
      const cur = spec.fit.axis === 'max' ? Math.max(size.x, size.y, size.z) : size[spec.fit.axis];
      scale = spec.fit.size / cur;
    }
    inner.scale.setScalar(scale);
    inner.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(inner, true);
    const c = box.getCenter(new THREE.Vector3());
    const wrapper = new THREE.Group();
    wrapper.name = name;
    wrapper.add(inner);
    if (spec.base === 'keel' || spec.base === 'feet') inner.position.set(-c.x, -box.min.y, -c.z);
    else if (spec.base === 'center') inner.position.set(-c.x, -c.y, -c.z);
    wrapper.updateMatrixWorld(true);
    wrapper.userData.size = box.getSize(new THREE.Vector3());
    wrapper.userData.animations = gltf.animations;
    this.fixMaterials(wrapper);
    return wrapper;
  }

  fixMaterials(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (let i = 0; i < mats.length; i++) {
        let m = mats[i];
        if (!m) continue;
        // photogrammetry scans ship unlit: relight them so they sit in the scene
        if (m.isMeshBasicMaterial) {
          const lit = new THREE.MeshStandardMaterial({ map: m.map, color: m.color, roughness: 0.85, metalness: 0, transparent: m.transparent, opacity: m.opacity, side: m.side });
          lit.name = m.name;
          if (Array.isArray(o.material)) o.material[i] = lit; else o.material = lit;
          m = lit;
        }
        if (m.map) { m.map.anisotropy = Math.min(8, this.maxAniso); }
        // glass: keep cheap — no transmission pass
        if (m.transmission > 0) { m.transmission = 0; m.transparent = true; m.opacity = Math.min(m.opacity, 0.4); }
        if (m.transparent && m.opacity < 0.7) { m.depthWrite = false; o.castShadow = false; }
        if (m.alphaTest === 0 && m.map && m.transparent && !/glass|verre|window/i.test(m.name)) { m.alphaTest = 0.4; m.transparent = false; m.depthWrite = true; }
        m.envMapIntensity = m.envMapIntensity ?? 1;
      }
    });
  }

  // Deep clone with cloned (independent) materials so paint can be changed.
  cloneModel(name, { cloneMaterials = true } = {}) {
    const src = this.models[name];
    const copy = src.clone(true);
    if (cloneMaterials) {
      copy.traverse((o) => {
        if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      });
    }
    copy.userData = { ...src.userData };
    return copy;
  }
}

// Quantized (meshopt) attributes must become floats BEFORE any matrix is applied.
export function toFloatAttrs(g, keys) {
  for (const k of keys) {
    const a = g.attributes[k];
    if (!a) continue;
    if (a.normalized || !(a.array instanceof Float32Array)) {
      const f = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) f[i * a.itemSize + j] = a.getComponent(i, j);
      g.setAttribute(k, new THREE.BufferAttribute(f, a.itemSize));
    }
  }
}

// Bake a model hierarchy into one geometry per material (model-space), so
// many copies can be drawn as InstancedMeshes with a handful of draw calls.
// Untextured opaque materials are collapsed into a single vertex-coloured one.
export function bakeModel(root, { mergeUntextured = true, filter = null } = {}) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  const tmpColor = new THREE.Color();
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    if (filter && !filter(o)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const geo = o.geometry;
    const parts = mats.length > 1 && geo.groups.length ? geo.groups.map((g) => ({ start: g.start, count: g.count, mat: mats[g.materialIndex] })) : [{ start: 0, count: Infinity, mat: mats[0] }];
    for (const part of parts) {
      const m = part.mat;
      const untextured = !m.map && !m.normalMap && !m.transparent && mergeUntextured;
      const key = untextured ? '__vc' : m.uuid;
      let g = geo.index ? geo.toNonIndexed() : geo.clone();
      if (parts.length > 1) {
        const s = part.start, e = Math.min(part.start + part.count, g.attributes.position.count);
        const sub = new THREE.BufferGeometry();
        for (const k of Object.keys(g.attributes)) {
          const a = g.attributes[k];
          sub.setAttribute(k, new THREE.BufferAttribute(a.array.slice(s * a.itemSize, e * a.itemSize), a.itemSize, a.normalized));
        }
        g = sub;
      }
      toFloatAttrs(g, ['position', 'normal', 'uv']);
      g.applyMatrix4(o.matrixWorld);
      // normalise attribute set
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      for (const k of ['position', 'normal', 'uv']) {
        const a = g.attributes[k];
        if (a.normalized || !(a.array instanceof Float32Array)) {
          const f = new Float32Array(a.count * a.itemSize);
          for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) f[i * a.itemSize + j] = a.getComponent(i, j);
          g.setAttribute(k, new THREE.BufferAttribute(f, a.itemSize));
        }
      }
      if (untextured) {
        tmpColor.copy(m.color || new THREE.Color(1, 1, 1));
        if (m.emissive && m.emissive.getHex() !== 0) tmpColor.lerp(m.emissive, 0.3);
        const col = new Float32Array(g.attributes.position.count * 3);
        for (let i = 0; i < col.length; i += 3) { col[i] = tmpColor.r; col[i + 1] = tmpColor.g; col[i + 2] = tmpColor.b; }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      } else if (g.attributes.color) g.deleteAttribute('color');
      if (!groups.has(key)) groups.set(key, { mat: m, geos: [], untextured, rough: 0, metal: 0, n: 0 });
      const grp = groups.get(key);
      grp.geos.push(g);
      grp.rough += m.roughness ?? 0.7; grp.metal += m.metalness ?? 0; grp.n++;
    }
  });
  const out = [];
  for (const [, grp] of groups) {
    const geo = mergeGeometries(grp.geos, false);
    if (!geo) continue;
    geo.computeBoundingSphere();
    let mat;
    if (grp.untextured) {
      mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: grp.rough / grp.n, metalness: Math.min(0.6, grp.metal / grp.n) });
    } else {
      mat = grp.mat.clone();
    }
    out.push({ geometry: geo, material: mat });
  }
  return out;
}

// Create InstancedMeshes for baked parts at the given transforms.
export function instanceParts(parts, matrices, { castShadow = true, receiveShadow = true, name = 'inst' } = {}) {
  const group = new THREE.Group();
  group.name = name;
  for (const p of parts) {
    const im = new THREE.InstancedMesh(p.geometry, p.material, matrices.length);
    for (let i = 0; i < matrices.length; i++) im.setMatrixAt(i, matrices[i]);
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = castShadow && !p.material.transparent;
    im.receiveShadow = receiveShadow;
    im.computeBoundingSphere();
    group.add(im);
  }
  return group;
}

export function makeMatrix(x, y, z, rotY = 0, s = 1, sy = s) {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(s, sy, s));
  return m;
}

// Average colour of a texture (for collapsing textured parts into vertex colours).
const _avgCache = new WeakMap();
export function textureAverage(tex) {
  if (!tex || !tex.image) return new THREE.Color(1, 1, 1);
  if (_avgCache.has(tex)) return _avgCache.get(tex);
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const g = c.getContext('2d', { willReadFrequently: true });
  let col = new THREE.Color(0.7, 0.7, 0.7);
  try {
    g.drawImage(tex.image, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    col = new THREE.Color().setRGB(r / 64 / 255, gg / 64 / 255, b / 64 / 255, THREE.SRGBColorSpace);
  } catch (e) { /* cross-origin or decode issue: keep neutral */ }
  _avgCache.set(tex, col);
  return col;
}

// Collapse a whole hierarchy into ONE vertex-coloured geometry (model space).
// Used for far LODs and many-instance props (cars, traffic boats, umbrellas).
export function bakeToVertexColor(root, { filter = null, tint = null } = {}) {
  root.updateMatrixWorld(true);
  const geos = [];
  const tmp = new THREE.Color();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    if (filter && !filter(o)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m.transparent && m.opacity < 0.5) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    toFloatAttrs(g, ['position', 'normal']);
    g.applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
    for (const k of ['position', 'normal']) {
      const a = g.attributes[k];
      if (!a) continue;
      if (a.normalized || !(a.array instanceof Float32Array)) {
        const f = new Float32Array(a.count * 3);
        for (let i = 0; i < a.count; i++) for (let j = 0; j < 3; j++) f[i * 3 + j] = a.getComponent(i, j);
        g.setAttribute(k, new THREE.BufferAttribute(f, 3));
      }
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    tmp.copy(m.color || new THREE.Color(1, 1, 1));
    if (m.map) tmp.multiply(textureAverage(m.map));
    if (tint) tint(o, m, tmp);
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) { col[i] = tmp.r; col[i + 1] = tmp.g; col[i + 2] = tmp.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
  });
  const geo = mergeGeometries(geos, false);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

// Depth-only waterline cap for instanced boats (hides water inside open hulls).
// Shares the instance matrices of the boat mesh it is paired with.
export function addHullMask(im, height = 0.62) {
  const geo0 = im.geometry;
  const bb = geo0.boundingBox || (geo0.computeBoundingBox(), geo0.boundingBox);
  // hull footprint from the geometry itself: per length slice, the half-beam
  // of the vertices in the lower hull band (ignores T-tops, rails, outboards)
  const pos = geo0.attributes.position, N = 24;
  // cross-section of the hull at the mask height (plus a little below)
  const yLo = height - 0.45, yHi = height + 0.12;
  const half = new Float32Array(N), L = bb.max.z - bb.min.z;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i); if (y > yHi || y < yLo) continue;
    const k = Math.min(N - 1, Math.max(0, Math.floor(((pos.getZ(i) - bb.min.z) / L) * N)));
    half[k] = Math.max(half[k], Math.abs(pos.getX(i)));
  }
  // drop narrow appendages at the ends (outboard legs, bow pulpits)
  let mx = 0; for (let k = 0; k < N; k++) mx = Math.max(mx, half[k]);
  let first = 0, last = N - 1;
  while (first < N && half[first] < mx * 0.3) first++;
  while (last > 0 && half[last] < mx * 0.45) last--;
  for (let k = first; k <= last; k++) half[k] = Math.min(half[k], k > 0 ? Math.max(half[k - 1], mx * 0.3) * 1.6 : half[k]);
  const pts = [];
  const zAt = (k) => bb.min.z + ((k + 0.5) / N) * L;
  for (let k = first; k <= last; k++) pts.push(new THREE.Vector2(-half[k] * 0.8, zAt(k)));
  for (let k = last; k >= first; k--) pts.push(new THREE.Vector2(half[k] * 0.8, zAt(k)));
  if (pts.length < 6) { const hw = (bb.max.x - bb.min.x) * 0.4; pts.length = 0; pts.push(new THREE.Vector2(-hw, bb.min.z + 0.4), new THREE.Vector2(-hw, bb.max.z - 0.4), new THREE.Vector2(hw, bb.max.z - 0.4), new THREE.Vector2(hw, bb.min.z + 0.4)); }
  const geo = new THREE.ShapeGeometry(new THREE.Shape(pts));
  geo.rotateX(Math.PI / 2);
  geo.translate(0, height, 0);
  const mask = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }), im.instanceMatrix.count);
  mask.instanceMatrix = im.instanceMatrix;
  mask.renderOrder = 0.5;
  mask.frustumCulled = false;
  mask.onBeforeRender = () => { mask.count = im.count; };
  im.parent.add(mask);
  return mask;
}
