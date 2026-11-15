// Progression-lite logbook: nautical miles, fastest speed, longest jump,
// cleanest docking, destinations visited, dolphins escorted, sunsets, guests.
// Milestones unlock paints and trims. Nothing is missable.
import { POIS, DESTINATIONS } from '../world/geography.js';
import { NM } from '../core/math.js';
import { bus } from '../core/events.js';

export const MILESTONES = [
  { id: 'aqua', label: 'Biscayne Aqua paint', test: (l) => l.nm >= 5, hint: 'Sail 5 nautical miles' },
  { id: 'coral', label: 'Coral Pink paint', test: (l) => l.visited.length >= 4, hint: 'Visit 4 places' },
  { id: 'sunset', label: 'Sunset Orange paint', test: (l) => l.bestDock >= 80, hint: 'Score 80+ docking' },
  { id: 'midnight', label: 'Midnight paint', test: (l) => l.dolphins >= 1 || l.sunsets >= 2, hint: 'Escort dolphins or watch two sunsets' },
  { id: 'rainbow', label: 'Rainbow hull stripe', test: (l) => DESTINATIONS.every((d) => l.visited.includes(d.id)), hint: 'Visit all seven destinations' },
  { id: 'gold', label: 'Gold cleats & rails', test: (l) => l.topSpeedKn >= 35 && l.longestJumpM >= 4, hint: 'Hit 35 kn and jump the dinghy 4 m' },
];

export class Logbook {
  constructor(game) {
    this.game = game;
    this.l = game.save.data.logbook;
    this.unlocks = game.save.data.unlocks;
    this._last = null;
    bus.on('dolphins', (e) => { if (!e.start && e.escorted) { this.l.dolphins++; game.ui.toast('Dolphins escorted your bow 🐬'); this.check(); } });
    bus.on('landing', (e) => { if (game.boat && game.boat.id === 'marsh' && e.dist > this.l.longestJumpM) { this.l.longestJumpM = Math.round(e.dist * 10) / 10; game.ui.toast(`New longest jump: ${this.l.longestJumpM} m`); this.check(); } });
    this.sunsetSeen = false;
  }

  update(dt) {
    const g = this.game, b = g.boat;
    if (b && g.player.mode === 'helm') {
      const p = b.phys.body.pos;
      if (this._last) {
        const d = Math.hypot(p.x - this._last.x, p.z - this._last.z);
        if (d < 50) this.l.nm += d / NM;
      }
      this._last = { x: p.x, z: p.z };
      if (b.phys.t.speedKn > this.l.topSpeedKn && b.phys.t.wet > 0.05) this.l.topSpeedKn = Math.round(b.phys.t.speedKn * 10) / 10;
    } else this._last = null;
    // visits
    const pos = g.player.pos;
    for (const poi of POIS) {
      if (this.l.visited.includes(poi.id)) continue;
      if (Math.hypot(pos.x - poi.x, pos.z - poi.z) < poi.r) {
        this.l.visited.push(poi.id);
        g.ui.toast(`Logbook: visited ${poi.name}`);
        this.check();
      }
    }
    // sunsets watched from the water
    const el = g.day.sunElevation;
    if (el < 0.5 && el > -1 && !this.sunsetSeen && g.player.mode === 'helm') { this.sunsetSeen = true; this.l.sunsets++; this.check(); }
    if (el > 5) this.sunsetSeen = false;
    this.l.hours += dt / 3600;
    this.checkT = (this.checkT || 0) + dt;
    if (this.checkT > 5) { this.checkT = 0; this.check(); }
  }

  docked(score) { this.l.docks++; if (score > this.l.bestDock) this.l.bestDock = score; this.check(); }
  collision() { this.l.collisions++; }
  rescue() { this.l.rescues++; }
  guests(n) { this.l.guests += n; }

  check() {
    for (const m of MILESTONES) {
      if (!this.unlocks.includes(m.id) && m.test(this.l)) {
        this.unlocks.push(m.id);
        this.game.ui.toast(`Unlocked: ${m.label}`, 5);
        this.game.audio.chime();
      }
    }
  }
}
