// Time of day -> sun position + a hand-tuned palette keyed on sun elevation.
// Palette colours come from the reference photos (Miami blue noon, amber/pink
// golden hour, violet blue hour, deep navy night with warm city light).
import { Color, Vector3 } from 'three';
import { DEG, clamp, lerp, smoothstep } from '../core/math.js';

const K = (el, o) => ({ el, ...o });
// colours in sRGB hex, converted to linear on use
const KEYS = [
  K(-90, { zenith: 0x02040c, horizon: 0x081022, sun: 0x6f86b8, sunI: 0.12, sky: 0x0d1830, ground: 0x05070c, fog: 0x0a1222, haze: 0x0f1a30, exposure: 1.9, glow: 0x0f1a30, cloud: 0x10182a, water: 0x01050c }),
  K(-14, { zenith: 0x040a1c, horizon: 0x0e1a36, sun: 0x6f86b8, sunI: 0.15, sky: 0x101d38, ground: 0x06080e, fog: 0x0e182c, haze: 0x182440, exposure: 1.85, glow: 0x1a2240, cloud: 0x141c30, water: 0x020710 }),
  K(-6, { zenith: 0x10204e, horizon: 0x6a4a7e, sun: 0xff6a4a, sunI: 0.2, sky: 0x2a3466, ground: 0x0e0f18, fog: 0x3a3664, haze: 0x9a5a7a, exposure: 1.45, glow: 0xc85a66, cloud: 0x5a3a5e, water: 0x05101f }),
  K(-1.5, { zenith: 0x22397e, horizon: 0xff7a4e, sun: 0xff5a24, sunI: 1.0, sky: 0x4a5a90, ground: 0x2a1a18, fog: 0x9a6a7a, haze: 0xff8a4a, exposure: 1.15, glow: 0xff6a30, cloud: 0xff8a6a, water: 0x0a1a32 }),
  K(3, { zenith: 0x2d58a8, horizon: 0xffa25a, sun: 0xff8a32, sunI: 2.0, sky: 0x6a82b8, ground: 0x4a3020, fog: 0xd29a7e, haze: 0xffaa60, exposure: 1.0, glow: 0xff9440, cloud: 0xffb58a, water: 0x0b2846 }),
  K(9, { zenith: 0x2f66bc, horizon: 0xf7c48e, sun: 0xffc07a, sunI: 2.7, sky: 0x86acd8, ground: 0x5a4a38, fog: 0xc6c4c0, haze: 0xffd09a, exposure: 1.0, glow: 0xffc080, cloud: 0xfff0e0, water: 0x0b2f52 }),
  K(25, { zenith: 0x1e5ec4, horizon: 0x9cc8ec, sun: 0xfff2dc, sunI: 3.1, sky: 0x8ab8e8, ground: 0x6a6050, fog: 0xa6c6e2, haze: 0xdce8f4, exposure: 0.95, glow: 0xfff4e0, cloud: 0xffffff, water: 0x0a3058 }),
  K(70, { zenith: 0x1656c2, horizon: 0x92c2ec, sun: 0xfffaf2, sunI: 3.3, sky: 0x86b6ea, ground: 0x6e6656, fog: 0x9cc0e2, haze: 0xe4eef8, exposure: 0.92, glow: 0xfffaf0, cloud: 0xffffff, water: 0x09305a }),
];
for (const k of KEYS) for (const key of Object.keys(k)) if (key !== 'el' && key !== 'sunI' && key !== 'exposure') k[key] = new Color(k[key]); // Color() converts sRGB hex to linear

const fields = ['zenith', 'horizon', 'sun', 'sky', 'ground', 'fog', 'haze', 'glow', 'cloud', 'water'];

export class DayCycle {
  constructor() {
    this.hours = 17.2;
    this.dayMinutes = 20;
    this.paused = false;
    this.sunDir = new Vector3();
    this.moonDir = new Vector3();
    this.sunElevation = 0;
    this.sunAzimuth = 0;
    this.p = {};
    for (const f of fields) this.p[f] = new Color();
    this.p.sunI = 1; this.p.exposure = 1;
    this.night = 0;      // 0 day .. 1 full night
    this.golden = 0;     // golden-hour factor
    this.update(0);
  }

  setHours(h) { this.hours = ((h % 24) + 24) % 24; this.update(0); }

  update(dt) {
    if (!this.paused && dt > 0) this.hours = (this.hours + dt * (24 / (this.dayMinutes * 60))) % 24;
    const h = this.hours;
    // Miami-ish summer: sunrise 6:40 at az 64deg, sunset 20:10 at az 296deg (behind the skyline's west end)
    const rise = 6.75, set = 19.95, noon = (rise + set) / 2;
    let el, az;
    if (h >= rise && h <= set) {
      const t = (h - rise) / (set - rise);
      el = 74 * Math.sin(Math.PI * t);
      az = lerp(64, 296, t);
    } else {
      const span = 24 - (set - rise);
      const tn = ((h - set + 24) % 24) / span; // 0 at sunset .. 1 at sunrise
      el = -32 * Math.sin(Math.PI * tn);
      az = lerp(296, 64 + 360, tn) % 360;
    }
    this.sunElevation = el;
    this.sunAzimuth = az;
    const e = el * DEG, a = az * DEG;
    this.sunDir.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
    this.moonDir.set(-this.sunDir.x * 0.8, Math.abs(this.sunDir.y) * 0.8 + 0.25, -this.sunDir.z * 0.8 + 0.2).normalize();

    // palette interpolation
    let i = 0;
    while (i < KEYS.length - 2 && el > KEYS[i + 1].el) i++;
    const k0 = KEYS[i], k1 = KEYS[i + 1];
    const t = clamp((el - k0.el) / (k1.el - k0.el), 0, 1);
    for (const f of fields) this.p[f].copy(k0[f]).lerp(k1[f], t);
    this.p.sunI = lerp(k0.sunI, k1.sunI, t);
    this.p.exposure = lerp(k0.exposure, k1.exposure, t);
    this.night = 1 - smoothstep(-8, 2, el);
    this.golden = smoothstep(16, 4, el) * smoothstep(-4, 1.5, el);
    this.noonish = smoothstep(10, 40, el);
    void noon;
  }

  // Light direction used for shading: the moon at night, the sun by day.
  lightDir(out) {
    if (this.sunElevation > -3) return out.copy(this.sunDir).setY(Math.max(this.sunDir.y, 0.03)).normalize();
    return out.copy(this.moonDir);
  }

  get clock() {
    const h = Math.floor(this.hours), m = Math.floor((this.hours - h) * 60);
    return { h, m, text: `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` };
  }

  // Minutes (game) until golden hour / sunset for the HUD "vibe" line.
  vibeHint() {
    const h = this.hours;
    const toHours = (target) => ((target - h + 24) % 24);
    const gh = toHours(19.0), ss = toHours(19.95), sr = toHours(6.75);
    const realMin = (gameH) => Math.round(gameH * this.dayMinutes * 60 / 24 / 60);
    if (this.golden > 0.4 && this.sunElevation > 0) return 'Golden hour — the water is glowing';
    if (gh < 1.5 && gh > 0) return `Golden hour in ${Math.max(1, realMin(gh))} min`;
    if (ss < 0.4) return 'Sunset — the lighthouse is the best seat in the bay';
    if (this.night > 0.8) return sr < 1.5 ? `Sunrise in ${Math.max(1, realMin(sr))} min` : 'Night cruise — mind the nav lights';
    if (this.sunElevation > 55) return 'High noon — perfect sandbar weather';
    if (h < 11) return 'Glassy morning — best water of the day';
    return 'Afternoon breeze filling in from the southeast';
  }
}
