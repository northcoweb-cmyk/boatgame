// Procedural music: lo-fi radio stations (chord pads, soft drums, bass, plucks)
// generated live with Web Audio. The same engine drives the ambient music you
// hear from the beach club, tiki bar, restaurant and sandbar boats.
const N = (semi) => 440 * Math.pow(2, (semi - 9) / 12); // semitones from C4

export const STATIONS = [
  { id: 'bayfm', name: 'Bay FM 88.1 · lo-fi', bpm: 74, root: -10, prog: [[0, 3, 7, 10, 14], [5, 8, 12, 15], [-2, 2, 5, 9, 12], [3, 7, 10, 14]], swing: 0.12, drums: 'lofi', lead: 'keys' },
  { id: 'coral', name: 'Coral Radio 94.7 · bossa', bpm: 92, root: -7, prog: [[0, 4, 7, 11, 14], [2, 5, 9, 12], [-5, -1, 2, 5], [0, 4, 7, 9]], swing: 0.05, drums: 'bossa', lead: 'pluck' },
  { id: 'night', name: 'Night Drive 101.9 · synthwave', bpm: 100, root: -12, prog: [[0, 3, 7], [-4, 0, 3], [-7, -3, 0], [-2, 2, 5]], swing: 0, drums: 'synth', lead: 'arp' },
];
export const VENUE_STYLES = {
  house: { bpm: 120, root: -9, prog: [[0, 3, 7, 10], [-4, 0, 3, 7], [-2, 2, 5, 8], [-5, -1, 2, 5]], swing: 0, drums: 'house', lead: 'stab' },
  tiki: { bpm: 96, root: -5, prog: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]], swing: 0.15, drums: 'bossa', lead: 'pluck' },
  lounge: { bpm: 84, root: -8, prog: [[0, 4, 7, 11], [9, 12, 16, 19], [2, 5, 9, 12], [7, 11, 14, 17]], swing: 0.1, drums: 'lofi', lead: 'keys' },
  sandbar: { bpm: 104, root: -6, prog: [[0, 4, 7], [-3, 0, 4], [5, 9, 12], [7, 11, 14]], swing: 0.05, drums: 'reggaeton', lead: 'pluck' },
};

export class Radio {
  constructor(ctx, out, noiseBuf, style) {
    this.ctx = ctx;
    this.out = out;
    this.noise = noiseBuf;
    this.style = style;
    this.gain = ctx.createGain();
    this.gain.connect(out);
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = 0.32;
    this.fb = ctx.createGain(); this.fb.gain.value = 0.28;
    this.delay.connect(this.fb); this.fb.connect(this.delay);
    this.delayOut = ctx.createGain(); this.delayOut.gain.value = 0.25;
    this.delay.connect(this.delayOut); this.delayOut.connect(this.gain);
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 5200;
    this.lp.connect(this.gain);
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.1;
    this.playing = false;
  }
  setStyle(style) { this.style = style; this.step = 0; }
  start() { this.playing = true; this.nextTime = Math.max(this.nextTime, this.ctx.currentTime + 0.05); }
  stop() { this.playing = false; }

  env(node, t, a, d, peak) {
    node.gain.cancelScheduledValues(t);
    node.gain.setValueAtTime(0.0001, t);
    node.gain.linearRampToValueAtTime(peak, t + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  osc(type, f, t, dur, peak, dest, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = f; o.detune.value = detune;
    const g = this.ctx.createGain();
    o.connect(g); g.connect(dest);
    this.env(g, t, Math.min(0.02, dur * 0.2), dur, peak);
    o.start(t); o.stop(t + dur + 0.1);
    return o;
  }
  noiseHit(t, dur, peak, type, freq, dest) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 1;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = 0.8;
    const g = this.ctx.createGain();
    s.connect(f); f.connect(g); g.connect(dest);
    this.env(g, t, 0.002, dur, peak);
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  }
  kick(t, peak = 0.9) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
    o.connect(g); g.connect(this.lp);
    this.env(g, t, 0.003, 0.32, peak);
    o.start(t); o.stop(t + 0.4);
  }

  // schedule ahead (call every frame)
  update() {
    if (!this.playing) return;
    const st = this.style;
    const sixteenth = 60 / st.bpm / 4;
    while (this.nextTime < this.ctx.currentTime + 0.12) {
      const s = this.step % 64;
      const bar = Math.floor(s / 16) % st.prog.length;
      const beat = s % 16;
      const swing = beat % 2 === 1 ? st.swing * sixteenth : 0;
      const t = this.nextTime + swing;
      const chord = st.prog[bar];
      const root = st.root;
      // pad on each bar
      if (beat === 0) for (const n of chord) for (const d of [-7, 7]) this.osc('sawtooth', N(root + n + 12), t, sixteenth * 15, 0.018, this.lp, d);
      // bass
      if (beat === 0 || beat === 10 || (st.drums === 'house' && beat % 4 === 2)) this.osc('triangle', N(root + chord[0] - 12), t, sixteenth * (beat === 0 ? 5 : 3), 0.16, this.lp);
      // drums
      const d = st.drums;
      if (d === 'lofi') {
        if (beat === 0 || beat === 7 || beat === 10) this.kick(t, 0.55);
        if (beat === 4 || beat === 12) this.noiseHit(t, 0.18, 0.12, 'bandpass', 1800, this.lp);
        if (beat % 2 === 0) this.noiseHit(t, 0.04, 0.03, 'highpass', 7000, this.lp);
      } else if (d === 'bossa') {
        if (beat === 0 || beat === 6 || beat === 8 || beat === 14) this.kick(t, 0.35);
        if ([0, 3, 6, 10, 12].includes(beat)) this.noiseHit(t, 0.03, 0.05, 'bandpass', 3500, this.lp);
        this.noiseHit(t, 0.03, 0.02, 'highpass', 8000, this.lp);
      } else if (d === 'synth') {
        if (beat % 4 === 0) this.kick(t, 0.6);
        if (beat === 4 || beat === 12) this.noiseHit(t, 0.25, 0.14, 'bandpass', 1400, this.lp);
        if (beat % 2 === 1) this.noiseHit(t, 0.05, 0.04, 'highpass', 9000, this.lp);
      } else if (d === 'house') {
        if (beat % 4 === 0) this.kick(t, 0.8);
        if (beat % 4 === 2) this.noiseHit(t, 0.06, 0.07, 'highpass', 8000, this.lp);
        if (beat === 4 || beat === 12) this.noiseHit(t, 0.15, 0.08, 'bandpass', 2000, this.lp);
      } else if (d === 'reggaeton') {
        if (beat === 0 || beat === 8) this.kick(t, 0.7);
        if ([3, 6, 11, 14].includes(beat)) this.noiseHit(t, 0.12, 0.1, 'bandpass', 2200, this.lp);
        if (beat % 2 === 0) this.noiseHit(t, 0.03, 0.03, 'highpass', 8000, this.lp);
      }
      // lead
      const scale = [0, 2, 3, 5, 7, 9, 10, 12];
      if (st.lead === 'arp' && beat % 2 === 0) { const n = chord[(beat / 2) % chord.length]; this.osc('square', N(root + n + 24), t, sixteenth * 1.5, 0.025, this.delay); this.osc('square', N(root + n + 24), t, sixteenth * 1.5, 0.02, this.lp); }
      else if (st.lead === 'keys' && (beat === 2 || beat === 9 || beat === 13) && Math.random() < 0.7) this.osc('triangle', N(root + 12 + scale[(Math.random() * scale.length) | 0] + 12), t, sixteenth * 4, 0.05, this.delay);
      else if (st.lead === 'pluck' && [0, 3, 6, 8, 11, 14].includes(beat) && Math.random() < 0.8) this.osc('triangle', N(root + chord[(Math.random() * chord.length) | 0] + 24), t, sixteenth * 2, 0.06, this.lp);
      else if (st.lead === 'stab' && (beat === 2 || beat === 6 || beat === 10)) for (const n of chord) this.osc('sawtooth', N(root + n + 24), t, sixteenth * 0.9, 0.02, this.delay);
      this.nextTime += sixteenth;
      this.step++;
    }
  }
}
