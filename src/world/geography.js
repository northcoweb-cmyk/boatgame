// The map of Biscayne Bay. Coastline comes from the attached "Miami, Florida,
// USA" model: its real building footprints were rasterised into a land mask and
// a signed-distance field (assets/map/miami-sdf.png, 10 m cells, + inland).
// On top of that real geography we add the game's destinations: spoil islands,
// sandbars, channels and dredged marina basins.
//
// heightAt() is the single source of truth for terrain mesh, seabed shading,
// physics grounding, wave attenuation, chart and minimap.
//
// Coordinates: metres, Y up, sea level y = 0. North = -Z, East = +X.
// Game origin = model (1800, 300): roughly the middle of the bay.
import { fbm2, valueNoise2 } from '../core/noise.js';
import { clamp, clamp01, smoothstep, distToSegment2, lerp } from '../core/math.js';

export const WORLD_HALF = 5000;
export const WORLD_SIZE = WORLD_HALF * 2;
export const PLAY_LIMIT = 4600;
export const SEAWALL_TOP = 2.4;
export const ATLANTIC_X = 4650;

// ---------------------------------------------------------------- SDF data
let SDF = null, SDF_RES = 0, SDF_CELL = 10;
export function setMapData(data, res) { SDF = data; SDF_RES = res; SDF_CELL = WORLD_SIZE / res; }
export async function loadMapData(url) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, img.width, img.height).data;
  const out = new Float32Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = ((px[i * 4] << 8) | px[i * 4 + 1]) / 50 - 600;
  setMapData(out, img.width);
}
// signed distance to the real coastline (m), + inland. Bilinear.
export function shoreDistance(x, z) {
  if (!SDF) return -500;
  const f = 1 / SDF_CELL;
  const gx = clamp((x + WORLD_HALF) * f - 0.5, 0, SDF_RES - 1.001);
  const gz = clamp((z + WORLD_HALF) * f - 0.5, 0, SDF_RES - 1.001);
  const ix = gx | 0, iz = gz | 0, fx = gx - ix, fz = gz - iz;
  const k = iz * SDF_RES + ix, r = SDF_RES;
  return (SDF[k] * (1 - fx) + SDF[k + 1] * fx) * (1 - fz) + (SDF[k + r] * (1 - fx) + SDF[k + r + 1] * fx) * fz;
}

// ---------------------------------------------------------------- features
export const ISLANDS = [
  { id: 'capelight', name: 'Cape Light Key', x: -400, z: -1700, r: 150, h: 3.6, shelf: 120, seed: 1.7, lighthouse: true },
  { id: 'flamingo', name: 'Flamingo Key', x: -300, z: 2700, r: 175, h: 2.8, shelf: 120, seed: 4.2, beachClub: true },
  { id: 'pelican', name: 'Pelican Spoil Island', x: 1300, z: -2100, r: 75, h: 2.2, shelf: 90, seed: 2.9 },
  { id: 'picnic', name: 'Picnic Island', x: -1250, z: -2250, r: 65, h: 2.0, shelf: 80, seed: 6.1 },
  { id: 'sunrise', name: 'Sunrise Spoil Island', x: 1100, z: 3600, r: 70, h: 2.1, shelf: 90, seed: 8.8 },
];

export const SANDBARS = [
  { id: 'venetian', name: 'Venetian Sandbar', x: 900, z: -1450, a: 400, b: 140, rot: 18, social: true },
  { id: 'bayflats', name: 'Bay Flats', x: -700, z: 3350, a: 320, b: 120, rot: -30, social: true },
];
for (const s of SANDBARS) { s.c = Math.cos(s.rot * Math.PI / 180); s.s = Math.sin(s.rot * Math.PI / 180); }

// Marinas: origin on the bulkhead line, `out` = unit vector toward open water.
export const MARINAS = [
  { id: 'bayside', name: 'Bayside Marina', x: -2222, z: -690, out: [1, 0], width: 180, depth: 120, main: true },
  { id: 'sunset', name: 'Sunset Harbour Marina', x: 2005, z: -1500, out: [-1, 0], width: 160, depth: 110 },
  { id: 'southbeach', name: 'South Beach Marina', x: 3036, z: 2450, out: [-1, 0], width: 170, depth: 120 },
];
for (const m of MARINAS) { m.along = [-m.out[1], m.out[0]]; }

// Destination docks that also carve a basin (restaurant quay on Watson Island)
export const QUAYS = [
  { id: 'restaurant', x: -1100, z: 46, out: [0, -1], width: 90, depth: 45 },
];
for (const q of QUAYS) { q.along = [-q.out[1], q.out[0]]; }

export const CHANNELS = [
  { id: 'icw', width: 70, pts: [[-1960, -4600], [-1960, -1300], [-1920, -450], [-1960, 900], [-1820, 3200], [-1700, 4600]] },
  { id: 'main', width: 90, pts: [[5000, 3050], [4050, 3000], [3250, 2790], [2000, 2330], [600, 1720], [-700, 1450], [-1900, 1150]] },
  { id: 'beach', width: 60, pts: [[1880, -4600], [1880, -2600], [1800, -1500], [1700, -600], [2150, 1200], [2350, 2200]] },
];
for (const ch of CHANNELS) {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of ch.pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
  ch.bb = [minX - ch.width * 1.5, maxX + ch.width * 1.5, minZ - ch.width * 1.5, maxZ + ch.width * 1.5];
}

// Bridges: Julia Tuttle (north, high-rise centre span) and the Venetian
// Causeway spans between the real Venetian Islands.
export const BRIDGES = [
  { id: 'tuttle', name: 'Julia Tuttle Causeway', x0: -2205, x1: 2320, z: -2810, deck: 9.5, highSpan: [-260, 260], highDeck: 21, pierEvery: 42, width: 22 },
  { id: 'venetian', name: 'Venetian Causeway', z: -372, deck: 6.2, pierEvery: 30, width: 12,
    spans: [[-2215, -1520], [-725, -595], [-85, 125], [395, 565], [835, 965], [1275, 1685], [2115, 2285]] },
];

export const LANDMARKS = [
  { id: 'lighthouse', name: 'Cape Light', x: -400 + 110, z: -1700 - 40, kind: 'lighthouse' },
  { id: 'tuttle', name: 'Julia Tuttle Causeway', x: 0, z: -2810, kind: 'bridge' },
  { id: 'wheel', name: 'Bayside Wheel', x: -2320, z: -860, kind: 'wheel' },
  { id: 'vizcayne', name: 'The Vizcayne', x: -2450, z: -540, kind: 'tower' },
];

// The seven destinations ("the little places we go")
export const DESTINATIONS = [
  { id: 'sandbar', name: 'Venetian Sandbar', x: 900, z: -1450, r: 420, kind: 'sandbar' },
  { id: 'beachclub', name: 'Flamingo Beach Club', x: -110, z: 2700, r: 260, kind: 'beachclub' },
  { id: 'tiki', name: "Pelican's Tiki Bar", x: 1395, z: -2030, r: 200, kind: 'tiki' },
  { id: 'restaurant', name: 'Watson Island Grill', x: -1100, z: 30, r: 220, kind: 'restaurant' },
  { id: 'lighthouse', name: 'Cape Light Key', x: -400, z: -1700, r: 300, kind: 'lighthouse' },
  { id: 'marinas', name: 'The Marinas', x: -2160, z: -690, r: 260, kind: 'marina' },
  { id: 'bridge', name: 'Julia Tuttle Bridge', x: 0, z: -2810, r: 300, kind: 'bridge' },
];

export const POIS = [
  ...DESTINATIONS.map((d) => ({ ...d })),
  ...ISLANDS.filter((i) => !i.lighthouse && !i.beachClub).map((i) => ({ id: i.id, name: i.name, x: i.x, z: i.z, r: i.r + 150, kind: 'island' })),
  { id: 'bayflats', name: 'Bay Flats', x: -700, z: 3350, r: 330, kind: 'sandbar' },
  { id: 'govcut', name: 'Government Cut', x: 3900, z: 3000, r: 300, kind: 'landmark' },
  ...MARINAS.map((m) => ({ id: 'm_' + m.id, name: m.name, x: m.x + m.out[0] * 60, z: m.z + m.out[1] * 60, r: 160, kind: 'marina' })),
];

// ---------------------------------------------------------------- profiles
function beachProfile(s, plateau, shelf, beachW = 60) {
  if (s < 0) return s * (4.6 / shelf);
  const t = clamp01(s / beachW);
  return plateau * (1 - (1 - t) * (1 - t));
}
function seawallProfile(s) {
  if (s >= 0) return SEAWALL_TOP + Math.min(s, 300) * 0.0025;
  return Math.max(-5.5, SEAWALL_TOP + s * 2.4);
}
export function isBeachShore(x, z) {
  return x > 4050 && z < 3000;
}

function islandHeight(isl, x, z) {
  const dx = x - isl.x, dz = z - isl.z;
  const reach = isl.r * 1.35 + isl.shelf + 10;
  const d2 = dx * dx + dz * dz;
  if (d2 > reach * reach) return -99;
  const d = Math.sqrt(d2);
  const a = Math.atan2(dz, dx);
  const wob = 1 + 0.15 * Math.sin(a * 3 + isl.seed) + 0.08 * Math.sin(a * 5 + isl.seed * 2.1) + 0.05 * Math.sin(a * 9 + isl.seed * 0.7);
  const s = isl.r * wob - d;
  let h = beachProfile(s, isl.h, isl.shelf, 50);
  if (s > 50) h += fbm2(x * 0.012, z * 0.012, 2) * 0.7 * clamp01((s - 50) / 60);
  return h;
}

function sandbarHeight(sb, x, z) {
  const dx = x - sb.x, dz = z - sb.z;
  const u = (dx * sb.c + dz * sb.s) / sb.a;
  const v = (-dx * sb.s + dz * sb.c) / sb.b;
  const r2 = u * u + v * v;
  if (r2 > 4.5) return -99;
  const shape = Math.exp(-Math.pow(r2, 1.6) * 0.9);
  const ripple = Math.sin((u * sb.a) * 0.55 + Math.sin(v * 3.0) * 1.5) * 0.04;
  const spit = smoothstep(0.55, 0.85, valueNoise2(x * 0.012 + sb.x, z * 0.012)) * 0.35 * shape;
  return -2.8 + 2.6 * shape + ripple * shape + spit;
}

function channelCarve(h, x, z) {
  if (h > -0.6) return h;
  for (let c = 0; c < CHANNELS.length; c++) {
    const ch = CHANNELS[c];
    if (x < ch.bb[0] || x > ch.bb[1] || z < ch.bb[2] || z > ch.bb[3]) continue;
    let d = 1e9;
    for (let i = 0; i < ch.pts.length - 1; i++) {
      const a = ch.pts[i], b = ch.pts[i + 1];
      d = Math.min(d, distToSegment2(x, z, a[0], a[1], b[0], b[1]));
    }
    const m = 1 - smoothstep(ch.width * 0.45, ch.width, d);
    if (m > 0) h = Math.min(h, lerp(h, -9.5, m));
  }
  return h;
}

function basinCarve(h, x, z, m) {
  const dx = x - m.x, dz = z - m.z;
  const v = dx * m.out[0] + dz * m.out[1];
  const u = dx * m.along[0] + dz * m.along[1];
  const hw = m.width * 0.5 + 25;
  if (Math.abs(u) > hw + 60 || v < -75 || v > m.depth + 120) return h;
  const edgeU = 1 - smoothstep(hw, hw + 50, Math.abs(u));
  if (v >= 0) {
    const m2 = edgeU * (1 - smoothstep(m.depth + 30, m.depth + 110, v));
    const wall = Math.max(-4.4, SEAWALL_TOP - v * 2.6);
    h = lerp(h, Math.min(h, wall), m2);
    h = lerp(h, Math.min(h, -4.4), m2 * smoothstep(0, 3, v));
  } else {
    const m2 = edgeU * (1 - smoothstep(45, 75, -v));
    h = lerp(h, Math.max(h, SEAWALL_TOP), m2);
  }
  return h;
}

// ---------------------------------------------------------------- height
export function bayFloor(x, z) {
  let h = -4.6 + fbm2(x * 0.0021, z * 0.0021, 3) * 1.3;
  if (x > ATLANTIC_X - 150) h = lerp(h, -16 + fbm2(x * 0.003, z * 0.003, 2) * 2, smoothstep(ATLANTIC_X - 150, ATLANTIC_X + 500, x));
  return h;
}

export function heightAt(x, z) {
  let h = bayFloor(x, z);
  const s = shoreDistance(x, z);
  if (s > -260) {
    const beach = isBeachShore(x, z) ? 1 : 0;
    const hs = beach ? beachProfile(s, 3.0, 200, 90) : seawallProfile(s);
    if (hs > h) h = hs;
    if (s > 0) h += fbm2(x * 0.004, z * 0.004, 2) * 0.35 * clamp01(s / 80);
  }
  for (let i = 0; i < ISLANDS.length; i++) {
    const v = islandHeight(ISLANDS[i], x, z);
    if (v > h) h = v;
  }
  for (let i = 0; i < SANDBARS.length; i++) {
    const v = sandbarHeight(SANDBARS[i], x, z);
    if (v > h) h = v;
  }
  h = channelCarve(h, x, z);
  for (let i = 0; i < MARINAS.length; i++) h = basinCarve(h, x, z, MARINAS[i]);
  for (let i = 0; i < QUAYS.length; i++) h = basinCarve(h, x, z, QUAYS[i]);
  return h;
}

export function waveAttenuation(depth) {
  return smoothstep(0.15, 5.5, depth);
}

// Masks used for terrain colouring.
export function urbanMask(x, z) {
  const s = shoreDistance(x, z);
  if (isBeachShore(x, z)) return smoothstep(150, 240, s);
  return smoothstep(4, 18, s);
}
export function seagrassMask(x, z) {
  return smoothstep(0.52, 0.68, valueNoise2(x * 0.006 + 31.0, z * 0.006 - 7.0));
}

// Current field (m/s): gentle tidal drift, stronger along channels, and a soft
// push back toward the bay beyond the play area.
export function currentAt(x, z, out) {
  let cx = 0.03, cz = -0.08;
  const r = Math.max(Math.abs(x) - PLAY_LIMIT, Math.abs(z) - PLAY_LIMIT, 0);
  if (r > 0) {
    const l = Math.hypot(x, z) || 1;
    const k = smoothstep(0, 350, r) * 2.6;
    cx -= (x / l) * k;
    cz -= (z / l) * k;
  }
  out.x = cx; out.y = 0; out.z = cz;
  return out;
}

export function distToShoreApprox(x, z) { return -shoreDistance(x, z); }

export function nearestMarina(x, z) {
  let best = null, bd = 1e9;
  for (const m of MARINAS) {
    const d = Math.hypot(x - m.x, z - m.z);
    if (d < bd) { bd = d; best = m; }
  }
  return { marina: best, dist: bd };
}
