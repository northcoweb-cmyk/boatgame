// Graphics presets + first-run auto-detection from the GPU.
export const PRESETS = {
  low: { renderScale: 0.75, grid: 160, waves: 10, reflections: false, reflScale: 0.35, shadows: false, shadowSize: 1024, msaa: 0, foliage: 0.5, palmNear: 110, drawDistance: 2600, terrain: 'low', traffic: 8, bloom: true, dpr: 1, terrainRes: 768 },
  medium: { renderScale: 0.9, grid: 224, waves: 13, reflections: true, reflScale: 0.4, shadows: true, shadowSize: 1024, msaa: 2, foliage: 0.75, palmNear: 170, drawDistance: 3500, terrain: 'medium', traffic: 12, bloom: true, dpr: 1, terrainRes: 1024 },
  high: { renderScale: 1.0, grid: 288, waves: 16, reflections: true, reflScale: 0.5, shadows: true, shadowSize: 2048, msaa: 4, foliage: 1.0, palmNear: 240, drawDistance: 4500, terrain: 'high', traffic: 16, bloom: true, dpr: 1.25, terrainRes: 1024 },
  ultra: { renderScale: 1.0, grid: 384, waves: 16, reflections: true, reflScale: 0.6, shadows: true, shadowSize: 4096, msaa: 4, foliage: 1.3, palmNear: 330, drawDistance: 6000, terrain: 'ultra', traffic: 20, bloom: true, dpr: 1.5, terrainRes: 1024 },
};

export function detectPreset(renderer) {
  const gl = renderer.getContext();
  let name = 'unknown';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { /* privacy-restricted */ }
  const n = String(name);
  const maxTex = renderer.capabilities.maxTextureSize;
  let preset = 'high';
  if (/swiftshader|llvmpipe|software|microsoft basic/i.test(n)) preset = 'low';
  else if (/RTX\s?(30|40|50)|RX\s?(68|69|78|79|9\d)|Apple M\d (Max|Ultra|Pro)/i.test(n)) preset = 'ultra';
  else if (/GTX|RTX|Radeon RX|RX\s?\d|Arc A|Radeon Pro|Apple M[2-9]/i.test(n)) preset = 'high';
  else if (/Iris Xe|Apple M1|Radeon\(TM\) Graphics|Vega/i.test(n)) preset = 'medium';
  else if (/Intel|UHD|HD Graphics|Mali|Adreno|PowerVR/i.test(n)) preset = 'low';
  if (maxTex < 8192 && preset !== 'low') preset = 'medium';
  if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) preset = 'low';
  return { preset, gpu: n };
}

export function resolveQuality(settings, detected) {
  const preset = settings.preset || detected;
  const p = { ...PRESETS[preset] };
  p.preset = preset;
  p.detected = detected;
  const wq = settings.waterQuality;
  if (wq === 'low') { p.grid = Math.min(p.grid, 160); p.waves = 10; }
  else if (wq === 'medium') { p.grid = Math.min(p.grid, 224); p.waves = 13; }
  else if (wq === 'ultra') { p.grid = 384; p.waves = 16; }
  p.foliage = settings.foliage ?? p.foliage;
  p.drawDistance = settings.drawDistance ?? p.drawDistance;
  return p;
}
