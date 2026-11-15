// Gerstner (trochoidal) wave spectrum — the single source of truth for both the
// GPU ocean shader and CPU buoyancy. CPU sampling inverts the horizontal
// displacement with fixed-point iterations so heights match the rendered surface.
import { G, clamp, lerp, damp, smoothstep } from '../core/math.js';
import { heightAt, waveAttenuation } from '../world/geography.js';

export const MAX_WAVES = 16;

export const SEA_STATES = {
  calm:      { label: 'Calm morning',   swell: 0.3, chop: 0.35, wind: 3.5 },
  afternoon: { label: 'Afternoon chop', swell: 0.6, chop: 1.05, wind: 7.5 },
  breeze:    { label: 'Breeze',         swell: 0.9, chop: 1.35, wind: 9.5 },
  fresh:     { label: 'Fresh breeze',   swell: 1.3, chop: 1.8, wind: 12.0 },
};

// Wavelengths (m) from long swell down to fine chop, plus fan offsets (rad).
const LAMBDAS = [88, 72, 58, 47, 38, 30.5, 24.5, 19.6, 15.7, 12.6, 10.1, 8.1, 6.4, 5.0, 3.8, 2.9];
const FAN = [0.0, 0.42, -0.36, 0.2, -0.55, 0.62, -0.18, 0.33, -0.66, 0.08, 0.5, -0.44, 0.27, -0.6, 0.66, -0.12];
const PHASES = [0.0, 1.7, 4.1, 2.6, 5.5, 0.8, 3.3, 6.0, 1.2, 4.8, 2.2, 5.1, 0.4, 3.8, 1.9, 4.4];

export class WaveSpectrum {
  constructor(count = 16) {
    this.count = Math.min(count, MAX_WAVES);
    this.dirX = new Float32Array(MAX_WAVES);
    this.dirZ = new Float32Array(MAX_WAVES);
    this.k = new Float32Array(MAX_WAVES);
    this.omega = new Float32Array(MAX_WAVES);
    this.amp = new Float32Array(MAX_WAVES);
    this.Q = new Float32Array(MAX_WAVES);
    this.phase = new Float32Array(MAX_WAVES);
    this.lambda = new Float32Array(MAX_WAVES);
    // Packed for GPU: vec4(dirX, dirZ, k, amp), vec4(omega, Q, phase, lambda)
    this.packedA = new Float32Array(MAX_WAVES * 4);
    this.packedB = new Float32Array(MAX_WAVES * 4);
    this.current = { swell: 0.2, chop: 0.22, wind: 3.0 };
    this.target = { swell: 0.2, chop: 0.22, wind: 3.0 };
    // wind blowing FROM the south-east, so waves travel toward the north-west
    this.windDir = Math.atan2(-0.72, -0.69); // angle of travel in XZ plane
    this.time = 0;
    this.rebuild();
  }

  setTarget(state) {
    this.target.swell = state.swell; this.target.chop = state.chop; this.target.wind = state.wind;
  }
  snap() {
    Object.assign(this.current, this.target);
    this.rebuild();
  }
  get windSpeed() { return this.current.wind; }
  windVector(out) {
    out.x = Math.cos(this.windDir) * this.current.wind;
    out.y = 0;
    out.z = Math.sin(this.windDir) * this.current.wind;
    return out;
  }

  update(dt) {
    this.time += dt;
    const c = this.current, t = this.target;
    if (Math.abs(c.swell - t.swell) + Math.abs(c.chop - t.chop) + Math.abs(c.wind - t.wind) > 1e-4) {
      c.swell = damp(c.swell, t.swell, 0.15, dt);
      c.chop = damp(c.chop, t.chop, 0.15, dt);
      c.wind = damp(c.wind, t.wind, 0.15, dt);
      this.rebuild();
    }
  }

  rebuild() {
    const n = this.count;
    const { swell, chop } = this.current;
    for (let i = 0; i < MAX_WAVES; i++) {
      const lambda = LAMBDAS[i];
      const k = (2 * Math.PI) / lambda;
      const isSwell = lambda > 40;
      // swells come slightly more from the ocean (east), chop follows the wind
      const baseDir = isSwell ? this.windDir + 0.35 : this.windDir;
      const ang = baseDir + FAN[i] * (isSwell ? 0.7 : 1.0);
      let A;
      if (isSwell) A = swell * 0.5 * [0.55, 0.46, 0.36, 0.28][i];
      else A = chop * 0.5 * 0.5 * Math.pow(lambda / 30, 0.85);
      A = Math.min(A, 0.11 / k); // steepness cap
      if (i >= n) A = 0;
      this.dirX[i] = Math.cos(ang);
      this.dirZ[i] = Math.sin(ang);
      this.k[i] = k;
      this.omega[i] = Math.sqrt(G * k); // deep-water dispersion
      this.amp[i] = A;
      this.Q[i] = A > 0 ? Math.min(0.82 / (k * A * n), 1.6) : 0;
      this.phase[i] = PHASES[i];
      this.lambda[i] = lambda;
      this.packedA[i * 4] = this.dirX[i];
      this.packedA[i * 4 + 1] = this.dirZ[i];
      this.packedA[i * 4 + 2] = k;
      this.packedA[i * 4 + 3] = A;
      this.packedB[i * 4] = this.omega[i];
      this.packedB[i * 4 + 1] = this.Q[i];
      this.packedB[i * 4 + 2] = this.phase[i];
      this.packedB[i * 4 + 3] = lambda;
    }
  }

  // Horizontal Gerstner displacement at undisplaced param point.
  _disp(px, pz, t, atten, out) {
    let dx = 0, dz = 0;
    for (let i = 0; i < this.count; i++) {
      const A = this.amp[i] * atten;
      if (A === 0) continue;
      const th = this.k[i] * (this.dirX[i] * px + this.dirZ[i] * pz) - this.omega[i] * t + this.phase[i];
      const qa = this.Q[i] * A * Math.cos(th);
      dx += qa * this.dirX[i];
      dz += qa * this.dirZ[i];
    }
    out[0] = dx; out[1] = dz;
  }

  /**
   * Sample the true surface at world (x, z). Writes into `out`:
   *  out.h, out.nx/ny/nz (normal), out.vx/vy/vz (orbital velocity), out.depth, out.atten
   */
  sample(x, z, t, out, depthHint) {
    const depth = depthHint !== undefined ? depthHint : -heightAt(x, z);
    const atten = waveAttenuation(depth);
    out.depth = depth;
    out.atten = atten;
    if (atten <= 0) {
      out.h = 0; out.nx = 0; out.ny = 1; out.nz = 0; out.vx = 0; out.vy = 0; out.vz = 0;
      return out;
    }
    const d = this._tmp || (this._tmp = [0, 0]);
    let px = x, pz = z;
    for (let it = 0; it < 4; it++) {
      this._disp(px, pz, t, atten, d);
      px = x - d[0];
      pz = z - d[1];
    }
    let h = 0, nx = 0, nz = 0, ny = 1, vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < this.count; i++) {
      const A = this.amp[i] * atten;
      if (A === 0) continue;
      const k = this.k[i], w = this.omega[i], Dx = this.dirX[i], Dz = this.dirZ[i], Q = this.Q[i];
      const th = k * (Dx * px + Dz * pz) - w * t + this.phase[i];
      const s = Math.sin(th), c = Math.cos(th);
      h += A * s;
      const wa = k * A;
      nx -= Dx * wa * c;
      nz -= Dz * wa * c;
      ny -= Q * wa * s;
      // particle velocity d/dt of displacement
      vx += Q * A * w * s * Dx;
      vz += Q * A * w * s * Dz;
      vy -= A * w * c;
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    out.h = h; out.nx = nx / l; out.ny = ny / l; out.nz = nz / l;
    out.vx = vx; out.vy = vy; out.vz = vz;
    return out;
  }

  // Cheap height-only sample (2 inversion iterations) for props and buoys.
  heightFast(x, z, t, atten = 1) {
    if (atten <= 0) return 0;
    const d = this._tmp2 || (this._tmp2 = [0, 0]);
    let px = x, pz = z;
    for (let it = 0; it < 2; it++) {
      this._disp(px, pz, t, atten, d);
      px = x - d[0]; pz = z - d[1];
    }
    let h = 0;
    for (let i = 0; i < this.count; i++) {
      const A = this.amp[i] * atten;
      if (A === 0) continue;
      h += A * Math.sin(this.k[i] * (this.dirX[i] * px + this.dirZ[i] * pz) - this.omega[i] * t + this.phase[i]);
    }
    return h;
  }

  significantHeight() {
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.amp[i] * this.amp[i];
    return 4 * Math.sqrt(s / 2);
  }
}

export function seaStateForTime(hours) {
  // automatic weather: glassy at dawn, chop builds through the afternoon, eases at night
  const a = SEA_STATES.calm, b = SEA_STATES.afternoon;
  let t;
  if (hours < 6) t = 0.15;
  else if (hours < 10) t = lerp(0.15, 0.0, smoothstep(6, 10, hours));
  else if (hours < 15) t = smoothstep(10, 15, hours);
  else if (hours < 20) t = lerp(1, 0.45, smoothstep(17, 20, hours));
  else t = lerp(0.45, 0.15, smoothstep(20, 24, hours));
  return { swell: lerp(a.swell, b.swell, t), chop: lerp(a.chop, b.chop, t), wind: lerp(a.wind, b.wind, t) };
}

export { clamp };
