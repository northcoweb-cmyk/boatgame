// Fits physics + gameplay anchors to the actual boat mesh: measures bow, transom,
// beam, keel and gunwale from the vertices, and ray-casts seat/helm slots onto
// the real deck surfaces so passengers sit on cushions, not in mid-air.
import * as THREE from 'three';

const _v = new THREE.Vector3();

export function measureHull(model) {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const pts = [];
  model.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const pos = o.geometry.attributes.position;
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const step = Math.max(1, Math.floor(pos.count / 6000));
    for (let i = 0; i < pos.count; i += step) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m);
      pts.push(_v.x, _v.y, _v.z);
    }
  });
  let minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9, maxX = 0;
  for (let i = 0; i < pts.length; i += 3) {
    minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
    minZ = Math.min(minZ, pts[i + 2]); maxZ = Math.max(maxZ, pts[i + 2]);
    maxX = Math.max(maxX, Math.abs(pts[i]));
  }
  const H = maxY - minY, Lb = maxZ - minZ;
  // keel: lowest centreline vertex in the middle of the hull (excludes outboard skegs)
  let keel = 1e9;
  for (let i = 0; i < pts.length; i += 3) {
    const z = pts[i + 2];
    if (Math.abs(pts[i]) < maxX * 0.25 && z > minZ + Lb * 0.25 && z < minZ + Lb * 0.65) keel = Math.min(keel, pts[i + 1]);
  }
  if (keel > 1e8) keel = minY;
  // transom: aft-most hull vertex away from the centreline, low on the hull
  let transom = -1e9;
  for (let i = 0; i < pts.length; i += 3) {
    if (Math.abs(pts[i]) > maxX * 0.45 && pts[i + 1] < keel + H * 0.3) transom = Math.max(transom, pts[i + 2]);
  }
  if (transom < -1e8) transom = maxZ;
  // gunwale: highest outboard vertex amidships (rub rail / sheer)
  let gunwale = -1e9;
  for (let i = 0; i < pts.length; i += 3) {
    const z = pts[i + 2];
    if (Math.abs(pts[i]) > maxX * 0.88 && z > minZ + Lb * 0.3 && z < minZ + Lb * 0.7) gunwale = Math.max(gunwale, pts[i + 1]);
  }
  if (gunwale < -1e8) gunwale = keel + H * 0.4;
  return { bow: minZ, transom, sternMax: maxZ, beam: maxX * 2, keel, gunwale, top: maxY, length: transom - minZ };
}

// Raycast a deck slot down onto the model. Returns model-space point.
export function deckPoint(model, x, z, fromY, fallbackY) {
  const rc = new THREE.Raycaster(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0), 0, 50);
  model.updateMatrixWorld(true);
  const meshes = [];
  model.traverse((o) => { if (o.isMesh && o.visible && !o.material.transparent) meshes.push(o); });
  const hits = rc.intersectObjects(meshes, false);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  if (hits.length) return hits[0].point.clone().applyMatrix4(inv);
  return new THREE.Vector3(x, fallbackY, z);
}
