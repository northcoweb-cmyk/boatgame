// All audio is synthesised with Web Audio: per-boat engine voices driven by real
// RPM, water (bow wash, lapping, slaps, cavitation), ambience (wind, gulls, city
// hum, marina clanging, crickets), venue music, radio, horns, impacts, grinding,
// anchor, ropes, passengers, the pistol, and positional AI engines with Doppler.
import { Radio, STATIONS, VENUE_STYLES } from './radio.js';
import { clamp } from '../core/math.js';

export class AudioSystem {
  constructor(save) {
    this.save = save;
    this.ctx = null;
    this.started = false;
    this.stationIndex = save.data.settings.radioStation ?? 0;
  }

  // Must be called from a user gesture.
  start() {
    if (this.started) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.started = true;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.master = ctx.createGain(); this.master.connect(comp);
    const bus = (name) => { const g = ctx.createGain(); g.connect(this.master); this[name] = g; return g; };
    bus('engineBus'); bus('waterBus'); bus('ambBus'); bus('musicBus'); bus('sfxBus');
    this.applyVolumes();
    // noise buffers
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; // pink-ish
    }
    this.white = ctx.createBuffer(1, len, ctx.sampleRate);
    const wd = this.white.getChannelData(0);
    for (let i = 0; i < len; i++) wd[i] = Math.random() * 2 - 1;
    // reverb (short, outdoor slap)
    this.reverb = ctx.createConvolver();
    const ir = ctx.createBuffer(2, ctx.sampleRate * 1.2, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const ch = ir.getChannelData(c); for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 3) * 0.6; }
    this.reverb.buffer = ir;
    const rv = ctx.createGain(); rv.gain.value = 0.35; this.reverb.connect(rv); rv.connect(this.sfxBus);
    this.makeEngine();
    this.makeWater();
    this.makeAmbience();
    this.radio = new Radio(ctx, this.musicBus, this.noise, STATIONS[this.stationIndex % STATIONS.length]);
    if (this.stationIndex >= 0) this.radio.start();
    this.venue = null;
    this.aiVoices = [this.makeAiVoice(), this.makeAiVoice()];
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.save.data.settings;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.master, t, 0.05);
    this.engineBus.gain.setTargetAtTime(s.engineVol, t, 0.05);
    this.waterBus.gain.setTargetAtTime(s.ambienceVol * 0.9, t, 0.05);
    this.ambBus.gain.setTargetAtTime(s.ambienceVol, t, 0.05);
    this.musicBase = s.musicVol;
    this.sfxBus.gain.setTargetAtTime(s.sfxVol, t, 0.05);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }

  loopNoise(buf = this.noise) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.start(0, Math.random() * 1.9);
    return s;
  }

  // ---------------------------------------------------------------- engine
  makeEngine() {
    const ctx = this.ctx;
    const e = {};
    // harmonic-rich pulse train for combustion
    const real = new Float32Array(32), imag = new Float32Array(32);
    for (let n = 1; n < 32; n++) imag[n] = (n % 2 ? 1 : 0.55) / Math.pow(n, 0.85);
    e.wave = ctx.createPeriodicWave(real, imag);
    e.osc = ctx.createOscillator(); e.osc.setPeriodicWave(e.wave);
    e.sub = ctx.createOscillator(); e.sub.type = 'sawtooth';
    e.whine = ctx.createOscillator(); e.whine.type = 'sine';
    e.oscG = ctx.createGain(); e.subG = ctx.createGain(); e.whineG = ctx.createGain();
    e.noise = this.loopNoise(this.white);
    e.noiseF = ctx.createBiquadFilter(); e.noiseF.type = 'bandpass'; e.noiseF.Q.value = 1.4;
    e.noiseG = ctx.createGain();
    e.am = ctx.createGain(); // amplitude modulation for the putt-putt
    e.lfo = ctx.createOscillator(); e.lfo.type = 'square';
    e.lfoG = ctx.createGain(); e.lfoG.gain.value = 0;
    e.lfo.connect(e.lfoG); e.lfoG.connect(e.am.gain);
    e.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.2); }
    e.shaper.curve = curve;
    e.lp = ctx.createBiquadFilter(); e.lp.type = 'lowpass'; e.lp.Q.value = 0.9;
    e.out = ctx.createGain(); e.out.gain.value = 0;
    e.osc.connect(e.oscG); e.sub.connect(e.subG); e.noise.connect(e.noiseF); e.noiseF.connect(e.noiseG);
    for (const n of [e.oscG, e.subG, e.noiseG]) n.connect(e.am);
    e.am.connect(e.shaper); e.shaper.connect(e.lp); e.lp.connect(e.out);
    e.whine.connect(e.whineG); e.whineG.connect(e.out);
    e.out.connect(this.engineBus);
    e.osc.start(); e.sub.start(); e.whine.start(); e.lfo.start();
    // hydraulic steering whir
    e.hyd = this.loopNoise();
    e.hydF = ctx.createBiquadFilter(); e.hydF.type = 'bandpass'; e.hydF.frequency.value = 900; e.hydF.Q.value = 4;
    e.hydG = ctx.createGain(); e.hydG.gain.value = 0;
    e.hyd.connect(e.hydF); e.hydF.connect(e.hydG); e.hydG.connect(this.sfxBus);
    this.engine = e;
  }

  updateEngine(boat, ctxInfo) {
    const e = this.engine, t = this.ctx.currentTime;
    if (!boat) { e.out.gain.setTargetAtTime(0, t, 0.2); return; }
    const p = boat.phys, def = boat.def.engine;
    const rpm = p.rpm, rf = p.t.rpmFrac, load = clamp(Math.max(p.input.throttle, p.input.reverse) * (p.gear !== 0 ? 1 : 0.3), 0, 1);
    const type = def.sound;
    const firing = type === 'diesel' ? rpm / 60 * 4 : type === 'putt' ? rpm / 60 * 0.5 : rpm / 60 * 3;
    const on = p.engineOn && rpm > 50;
    const dock = ctxInfo.dockMode ? 0.45 : 1;
    const base = type === 'diesel' ? 0.5 : type === 'putt' ? 0.32 : 0.36;
    e.out.gain.setTargetAtTime(on ? base * (0.55 + rf * 0.6) * dock : 0, t, 0.08);
    e.osc.frequency.setTargetAtTime(Math.max(8, firing), t, 0.03);
    e.sub.frequency.setTargetAtTime(Math.max(4, firing * 0.5), t, 0.03);
    e.oscG.gain.setTargetAtTime(type === 'putt' ? 0.5 : 0.65, t, 0.05);
    e.subG.gain.setTargetAtTime(type === 'diesel' ? 0.45 : 0.18, t, 0.05);
    e.noiseF.frequency.setTargetAtTime(firing * (type === 'putt' ? 9 : 5), t, 0.05);
    e.noiseG.gain.setTargetAtTime(0.25 + load * 0.5 + (type === 'putt' ? 0.4 : 0), t, 0.05);
    const cut = type === 'diesel' ? 180 + 1300 * (rf * 0.5 + load * 0.5) : 500 + 3800 * (rf * 0.6 + load * 0.4);
    e.lp.frequency.setTargetAtTime(cut, t, 0.05);
    e.lfo.frequency.setTargetAtTime(Math.max(2, firing), t, 0.03);
    e.lfoG.gain.setTargetAtTime(type === 'putt' ? 0.55 : 0.0, t, 0.1);
    e.am.gain.setTargetAtTime(type === 'putt' ? 0.5 : 1, t, 0.1);
    // hole-shot whine while getting on plane (outboards), cavitation rev
    const holeshot = type === 'outboard' ? p.t.plane * (1 - p.t.plane) * 4 * load : 0;
    e.whine.frequency.setTargetAtTime(rpm / 60 * 14, t, 0.05);
    e.whineG.gain.setTargetAtTime(on ? 0.012 * rf + holeshot * 0.03 + (p.t.ventilating ? 0.04 : 0) : 0, t, 0.05);
    // hydraulic steering catch-up
    e.hydG.gain.setTargetAtTime(clamp(Math.abs(ctxInfo.steerRate) * 0.06, 0, 0.08), t, 0.05);
    e.hydF.frequency.setTargetAtTime(700 + Math.abs(ctxInfo.steerRate) * 300, t, 0.05);
  }

  // ---------------------------------------------------------------- water + ambience
  makeWater() {
    const ctx = this.ctx;
    const mk = (type, f, q) => { const src = this.loopNoise(); const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; src.connect(fl); fl.connect(g); g.connect(this.waterBus); return { src, fl, g }; };
    this.wash = mk('bandpass', 800, 0.6);
    this.lap = mk('lowpass', 500, 0.5);
    this.cav = mk('highpass', 3500, 0.7);
    this.grindN = mk('bandpass', 260, 2.5);
    this.grindN.g.disconnect(); this.grindN.g.connect(this.sfxBus);
  }
  makeAmbience() {
    const ctx = this.ctx;
    const mk = (type, f, q, dest = this.ambBus) => { const src = this.loopNoise(); const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; src.connect(fl); fl.connect(g); g.connect(dest); return { src, fl, g }; };
    this.wind = mk('lowpass', 420, 0.8);
    this.city = mk('bandpass', 110, 0.8);
    this.cityTone = ctx.createOscillator(); this.cityTone.frequency.value = 60; this.cityToneG = ctx.createGain(); this.cityToneG.gain.value = 0;
    this.cityTone.connect(this.cityToneG); this.cityToneG.connect(this.ambBus); this.cityTone.start();
    this.cricketT = 0; this.clangT = 1;
  }

  updateAmbience(dt, info) {
    const t = this.ctx.currentTime;
    const sp = info.speed;
    this.wash.g.gain.setTargetAtTime(clamp(sp / 14, 0, 1) * 0.35 * info.wet, t, 0.1);
    this.wash.fl.frequency.setTargetAtTime(500 + sp * 90, t, 0.1);
    this.lap.g.gain.setTargetAtTime((0.05 + info.chop * 0.06) * (1 - clamp(sp / 6, 0, 0.8)) * (info.onWater ? 1 : 0.4), t, 0.3);
    this.lap.fl.frequency.setTargetAtTime(300 + Math.sin(t * 0.7) * 120, t, 0.3);
    this.cav.g.gain.setTargetAtTime(info.ventilating ? 0.12 : 0, t, 0.03);
    this.grindN.g.gain.setTargetAtTime(clamp(info.grind * 3, 0, 0.5), t, 0.05);
    this.grindN.fl.frequency.setTargetAtTime(180 + Math.random() * 200, t, 0.02);
    const w = clamp((info.wind + sp * 0.6) / 18, 0, 1);
    this.wind.g.gain.setTargetAtTime(0.04 + w * 0.22, t, 0.3);
    this.wind.fl.frequency.setTargetAtTime(250 + w * 700, t, 0.3);
    this.city.g.gain.setTargetAtTime(info.cityK * 0.08, t, 0.5);
    this.cityToneG.gain.setTargetAtTime(info.cityK * 0.01, t, 0.5);
    // marina clanging (halyards on masts)
    this.clangT -= dt;
    if (info.marinaK > 0.05 && this.clangT < 0) { this.clangT = 0.6 + Math.random() * 2.5; this.bell(1800 + Math.random() * 900, 0.05 * info.marinaK); }
    // crickets at night near land
    this.cricketT -= dt;
    if (info.night > 0.6 && info.landK > 0.1 && this.cricketT < 0) { this.cricketT = 0.25 + Math.random() * 0.5; this.chirp(4200 + Math.random() * 600, 0.02 * info.landK); }
    // ducking: music sits under the engine
    const duck = 1 - clamp(info.engineLoud * 0.55, 0, 0.55);
    this.musicBus.gain.setTargetAtTime(this.musicBase * duck * (info.hangout ? 1.6 : 1), t, 0.3);
    if (this.radio) this.radio.update();
    // venue music (positional)
    this.updateVenue(info);
  }

  updateVenue(info) {
    const v = info.venue;
    if (!v) { if (this.venue) { this.venue.radio.stop(); this.venue.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5); this.venue = null; } return; }
    if (!this.venue || this.venue.id !== v.id) {
      if (this.venue) this.venue.radio.stop();
      const g = this.ctx.createGain(); g.gain.value = 0;
      const pan = this.ctx.createPanner(); pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse'; pan.refDistance = 25; pan.rolloffFactor = 1.1;
      g.connect(pan); pan.connect(this.ambBus);
      const radio = new Radio(this.ctx, g, this.noise, VENUE_STYLES[v.station] || VENUE_STYLES.house);
      radio.start();
      this.venue = { id: v.id, radio, g, pan };
    }
    this.venue.pan.positionX.value = v.x; this.venue.pan.positionY.value = 2; this.venue.pan.positionZ.value = v.z;
    this.venue.g.gain.setTargetAtTime(0.55, this.ctx.currentTime, 0.5);
    this.venue.radio.update();
  }

  listener(cam) {
    if (!this.ctx) return;
    const L = this.ctx.listener, t = this.ctx.currentTime;
    const p = cam.position;
    const f = cam.getWorldDirection(this._f || (this._f = cam.position.clone()));
    if (L.positionX) {
      L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(f.x, t, 0.02); L.forwardY.setTargetAtTime(f.y, t, 0.02); L.forwardZ.setTargetAtTime(f.z, t, 0.02);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
  }

  // ---------------------------------------------------------------- AI engines with Doppler
  makeAiVoice() {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = ctx.createGain(); g.gain.value = 0;
    const pan = ctx.createPanner(); pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse'; pan.refDistance = 12; pan.rolloffFactor = 1.3; pan.maxDistance = 2000;
    const n = this.loopNoise(); const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 600; const ng = ctx.createGain(); ng.gain.value = 0.3;
    o.connect(lp); n.connect(nf); nf.connect(ng); ng.connect(lp); lp.connect(g); g.connect(pan); pan.connect(this.engineBus);
    o.start();
    return { o, lp, g, pan };
  }
  updateAi(list, cam, camVel) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    list.forEach((b, i) => {
      const v = this.aiVoices[i];
      if (!v) return;
      const dx = b.x - cam.position.x, dz = b.z - cam.position.z;
      const d = Math.hypot(dx, dz) || 1;
      // Doppler: relative radial velocity
      const vr = ((b.vx - camVel.x) * dx + (b.vz - camVel.z) * dz) / d;
      const dop = 343 / (343 + vr);
      const rpm = 800 + (b.speed / Math.max(1, b.cruise)) * 3600;
      v.o.frequency.setTargetAtTime((rpm / 60) * 3 * dop, t, 0.05);
      v.lp.frequency.setTargetAtTime(500 + b.speed * 120, t, 0.1);
      v.g.gain.setTargetAtTime(b.sinking ? 0 : 0.25 * clamp(b.speed / 4 + 0.2, 0, 1), t, 0.1);
      v.pan.positionX.value = b.x; v.pan.positionY.value = b.y + 1; v.pan.positionZ.value = b.z;
    });
  }

  // ---------------------------------------------------------------- one-shots
  env(g, t, a, d, peak) { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
  tone(type, f, dur, peak, dest = this.sfxBus, f2 = null, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = this.ctx.createGain(); o.connect(g); g.connect(dest);
    this.env(g, t, 0.01, dur, peak);
    o.start(t); o.stop(t + dur + 0.05);
  }
  burst(dur, peak, type, freq, q = 0.8, dest = this.sfxBus, delay = 0, buf = this.noise) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource(); s.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    s.connect(f); f.connect(g); g.connect(dest);
    this.env(g, t, 0.004, dur, peak);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  bell(f, peak) { this.tone('sine', f, 1.6, peak, this.ambBus); this.tone('sine', f * 2.76, 0.6, peak * 0.4, this.ambBus); }
  chirp(f, peak) { for (let i = 0; i < 3; i++) this.tone('sine', f, 0.03, peak, this.ambBus, null, i * 0.05); }

  horn(type, blasts = 1, short = false) {
    if (!this.ctx) return;
    const len = short ? 0.35 : 1.1;
    for (let b = 0; b < blasts; b++) {
      const d = b * (len + 0.25);
      if (type === 'yacht') { this.tone('sawtooth', 165, len, 0.22, this.sfxBus, null, d); this.tone('sawtooth', 208, len, 0.18, this.sfxBus, null, d); this.tone('square', 82, len, 0.08, this.sfxBus, null, d); }
      else if (type === 'dinghy') { this.tone('square', 520, len * 0.6, 0.12, this.sfxBus, 480, d); }
      else { this.tone('square', 420, len, 0.13, this.sfxBus, null, d); this.tone('square', 528, len, 0.09, this.sfxBus, null, d); }
    }
  }
  aiHorn(b, blasts, cam) {
    if (!this.ctx) return;
    const d = Math.hypot(b.x - cam.position.x, b.z - cam.position.z);
    const k = clamp(60 / Math.max(d, 20), 0.05, 1);
    for (let i = 0; i < blasts; i++) this.tone('square', 360, 0.3, 0.12 * k, this.sfxBus, null, i * 0.5);
  }
  impact(speed) {
    const k = clamp(speed / 6, 0.1, 1);
    this.burst(0.5, 0.5 * k, 'lowpass', 300, 0.7);
    this.tone('sine', 90, 0.4, 0.5 * k, this.sfxBus, 40);
    this.burst(0.25, 0.25 * k, 'bandpass', 1500, 1.5, this.sfxBus, 0.02, this.white);
  }
  slap(v) { this.burst(0.18, clamp(v / 5, 0.05, 0.4), 'lowpass', 600, 0.6, this.waterBus); }
  splash(k) { this.burst(0.7, clamp(k, 0.05, 0.6), 'bandpass', 1200, 0.5, this.waterBus); }
  anchorDrop() { this.splash(0.4); for (let i = 0; i < 18; i++) this.burst(0.03, 0.08, 'bandpass', 3000 + Math.random() * 2000, 4, this.sfxBus, i * 0.08, this.white); }
  anchorRaise() { for (let i = 0; i < 30; i++) this.burst(0.03, 0.06, 'bandpass', 2600, 4, this.sfxBus, i * 0.12, this.white); }
  creak() { this.tone('sawtooth', 180, 0.5, 0.04, this.sfxBus, 260); this.burst(0.4, 0.05, 'bandpass', 700, 8); }
  whoop() { const d = Math.random() * 0.2; this.tone('sawtooth', 380, 0.45, 0.06, this.sfxBus, 760, d); this.tone('sine', 780, 0.45, 0.03, this.sfxBus, 1300, d); }
  starter() { for (let i = 0; i < 6; i++) this.tone('square', 28, 0.08, 0.12, this.engineBus, null, i * 0.09); }
  chime() { this.tone('sine', 880, 0.5, 0.08); this.tone('sine', 1320, 0.6, 0.06, this.sfxBus, null, 0.12); }
  click() { this.tone('sine', 1400, 0.04, 0.03); }
  gunshot() {
    if (!this.ctx) return;
    this.burst(0.18, 0.7, 'lowpass', 2400, 0.7, this.sfxBus, 0, this.white);
    this.tone('sine', 140, 0.15, 0.5, this.sfxBus, 50);
    this.burst(0.25, 0.35, 'bandpass', 900, 0.8, this.reverb, 0, this.white);
  }
  dryFire() { this.tone('square', 2200, 0.02, 0.05); }
  reload() { this.burst(0.05, 0.15, 'bandpass', 2500, 3, this.sfxBus, 0, this.white); this.burst(0.05, 0.15, 'bandpass', 1800, 3, this.sfxBus, 0.25, this.white); }
  gull(k = 0.06) {
    if (!this.ctx) return;
    for (let i = 0; i < 2 + (Math.random() * 3 | 0); i++) this.tone('sawtooth', 1500 + Math.random() * 300, 0.18, k, this.ambBus, 900, i * 0.22);
  }
  sinking() { this.burst(3, 0.35, 'lowpass', 400, 0.6, this.waterBus); for (let i = 0; i < 12; i++) this.burst(0.15, 0.1, 'bandpass', 500 + Math.random() * 600, 3, this.waterBus, i * 0.25); }

  setStation(i) {
    this.stationIndex = i;
    this.save.data.settings.radioStation = i;
    if (!this.radio) return;
    if (i < 0) { this.radio.stop(); return; }
    this.radio.setStyle(STATIONS[i % STATIONS.length]);
    this.radio.start();
  }
  get stationName() { return this.stationIndex < 0 ? 'Radio off' : STATIONS[this.stationIndex % STATIONS.length].name; }

}
