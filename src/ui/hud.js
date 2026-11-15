// HUD: speed (knots / mph / km/h), RPM arc + gear, compass strip, depth sounder
// with shallow alarm, hull + fuel meters, trim, wind arrow, clock, place name,
// vibe line, radio, context prompts, action menu, docking assist readout,
// toasts, crosshair/ammo, control hints for the active device.
import { KNOT, MPH, clamp } from '../core/math.js';
import { POIS } from '../world/geography.js';

const $ = (id) => document.getElementById(id);

function arcPath(frac, r = 86) {
  const a0 = (135 * Math.PI) / 180, span = (270 * Math.PI) / 180;
  const a1 = a0 + span * clamp(frac, 0, 1);
  const p = (a) => `${100 + Math.cos(a) * r} ${100 + Math.sin(a) * r}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return frac <= 0.001 ? '' : `M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}`;
}

export class HUD {
  constructor(game) {
    this.game = game;
    this.el = $('hud');
    this.prompts = new Map();
    this.menuSel = 0;
    this.menuOpts = [];
    this.buildCompass();
    this.t = 0;
    $('action-menu').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this.game.menuAction(b.dataset.id);
    });
  }

  show(on) { this.el.classList.toggle('hidden', !on); }

  buildCompass() { /* the minimap carries heading; no compass strip in the minimal HUD */ }

  prompt(p, key) {
    if (p) this.prompts.set(key, p); else this.prompts.delete(key);
  }

  toast(text, secs = 3.2) {
    const box = $('toasts');
    if ([...box.children].some((c) => c.textContent === text)) return;
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = text;
    box.appendChild(d);
    while (box.children.length > 2) box.removeChild(box.firstChild);
    setTimeout(() => d.remove(), secs * 1000);
  }

  setMenu(title, opts) {
    const m = $('action-menu');
    const key = title + opts.map((o) => o.id).join();
    if (!opts.length) { m.classList.add('hidden'); this.menuOpts = []; this._menuKey = null; return; }
    m.classList.remove('hidden');
    if (key !== this._menuKey) { this.menuSel = 0; this._menuKey = key; }
    this.menuOpts = opts;
    const dev = this.game.input.device;
    m.innerHTML = `<h3>${title}</h3>` + opts.map((o, i) => `<button data-id="${o.id}" class="${i === this.menuSel ? 'sel' : ''}"><kbd>${dev === 'keyboard' ? i + 1 : i === this.menuSel ? 'A' : '·'}</kbd>${o.label}</button>`).join('');
  }

  toggleDetails() { this.detailsOn = !this.detailsOn; document.getElementById('hud-details').classList.toggle('hidden', !this.detailsOn); }
  toggleControls(on = !this.controlsOn) { this.controlsOn = on; document.getElementById('hud-controls').classList.toggle('hidden', !on); }

  update(dt) {
    const g = this.game, b = g.boat, s = g.save.data.settings;
    this.t += dt;
    if (!s.hud) { this.el.style.opacity = '0'; return; }
    this.el.style.opacity = '1';
    const atHelm = g.player.mode === 'helm' && b;
    $('hud-gauges').style.display = atHelm ? 'block' : 'none';
    $('help-hint').style.opacity = this.t < 25 ? '1' : '0';
    if (atHelm) {
      const t = b.phys.t;
      const unit = s.units;
      const v = unit === 'mph' ? t.speed / MPH : unit === 'kmh' ? t.speed * 3.6 : t.speedKn;
      $('hud-speed').textContent = Math.round(v);
      $('hud-unit').textContent = unit === 'mph' ? 'mph' : unit === 'kmh' ? 'km/h' : 'kn';
      $('hud-rpm').textContent = b.phys.engineOn ? Math.round(t.rpm / 10) * 10 : 'off';
      { const et = b.phys.engineTrim || 0; const tt = et > 0.05 ? `▲${Math.round(et * 10)}` : et < -0.05 ? `▼${Math.round(-et * 10)}` : '0'; if (tt !== this._tt) { this._tt = tt; $('hud-ptrim').textContent = tt; $('hud-ptrim').style.color = b.phys.t.porpoise > 0.3 ? '#ffb36b' : ''; } }
      $('hud-gear').textContent = !b.phys.engineOn ? '—' : b.phys.gear > 0 ? 'F' : b.phys.gear < 0 ? 'R' : 'N';
      const depth = t.waterDepth;
      const du = s.depthUnits === 'ft' ? 3.281 : 1;
      $('hud-depth').textContent = `${(depth * du).toFixed(1)} ${s.depthUnits}`;
      const shallow = depth < b.def.draft + 0.6 && !g.sea.docked;
      $('alarm').classList.toggle('hidden', !shallow);
      $('hud-hull').style.width = `${b.phys.integrity * 100}%`;
      $('hud-hull').style.background = b.phys.integrity < 0.35 ? '#ff6b5a' : b.phys.integrity < 0.7 ? '#ffd166' : '';
      $('hud-fuel').style.width = `${b.phys.fuel * 100}%`;
      $('hud-trim').textContent = `${((t.trim * 180) / Math.PI).toFixed(1)}°`;
      const warn = [];
      if (b.phys.integrity < 0.5) warn.push(`Hull ${Math.round(b.phys.integrity * 100)}%`);
      if (b.phys.fuel < 0.15) warn.push(`Fuel ${Math.round(b.phys.fuel * 100)}%`);
      if (g.sea.anchor) warn.push('Anchored');
      $('hud-warn').textContent = warn.join(' · ');
      if (shallow && this.t % 1 < dt) g.audio.tone('square', 1200, 0.08, 0.04);
    } else $('alarm').classList.add('hidden');
    if (this.detailsOn) {
      $('hud-clock').textContent = g.day.clock.text;
      $('hud-weather').textContent = g.day.night > 0.7 ? '☾' : g.day.golden > 0.3 ? '🌅' : '☀';
      $('hud-temp').textContent = `${Math.round(78 + 8 * g.day.noonish - 4 * g.day.night)}°F`;
      $('hud-wind').textContent = `${Math.round(g.waves.current.wind / KNOT)} kn SE`;
      $('hud-vibe').textContent = g.day.vibeHint();
      $('hud-radio').textContent = g.audio.stationName;
    }
    // place name
    const p = g.player.pos;
    let place = null, pd = 1e9;
    for (const poi of POIS) { const d = Math.hypot(p.x - poi.x, p.z - poi.z); if (d < poi.r * 1.2 && d < pd) { pd = d; place = poi; } }
    if (g.villas.home && Math.hypot(p.x - g.villas.home.lot.x, p.z - g.villas.home.lot.z) < 90) place = { name: 'Home · Venetian Islands' };
    else if (!place && p.z > -700 && p.z < 100 && p.x > -1600 && p.x < 2200) place = { name: 'Venetian Islands' };
    $('hud-place-name').textContent = place ? place.name : 'Biscayne Bay';
    // prompts (first one wins)
    const pr = $('prompt');
    const first = [...this.prompts.values()][0];
    if (first) { pr.classList.remove('hidden'); $('prompt-key').textContent = first.key; $('prompt-text').textContent = first.text; }
    else pr.classList.add('hidden');
    this.prompts.clear();
    // docking assist readout (only while docking)
    const di = $('dock-info');
    if (g.sea.dockMode && g.sea.dockInfo) {
      const d = g.sea.dockInfo;
      di.classList.remove('hidden');
      di.innerHTML = `<span>${g.sea.berthLabel(g.sea.target)}</span><span class="${d.inside ? 'ok' : 'bad'}">${d.inside ? 'In berth' : `${d.dist.toFixed(1)} m`}</span><span class="${d.align < 25 ? 'ok' : 'bad'}">${d.align.toFixed(0)}°</span><span class="${d.slow ? 'ok' : 'bad'}">${d.slow ? '<1 kn' : 'Slow'}</span>`;
    } else di.classList.add('hidden');
    // weapon
    const pl = g.player;
    const armed = pl.equipped === 'pistol' && pl.mode === 'foot';
    $('crosshair').classList.toggle('hidden', !(armed && g.input.state.aim));
    $('crosshair').classList.toggle('safe', pl.safety);
    $('ammo').classList.toggle('hidden', !armed);
    if (armed) { const it = pl.inventory[0]; $('ammo').textContent = pl.reloadT > 0 ? 'Reloading…' : `9mm ${it.ammo}/${it.reserve}`; }
    // controls overlay (on demand: F1, and briefly on first play)
    if (this.controlsOn) {
      const I = g.input;
      const rows = atHelm
        ? [['throttle', 'Throttle'], ['reverse', 'Reverse'], ['steer', 'Steer'], ['engine', b.phys.engineOn ? 'Engine (hold: stop)' : 'Start engine'], ['anchor', 'Anchor'], ['dock', 'Docking mode'], ['camNext', 'Camera'], ['leaveHelm', 'Leave helm'], ['map', 'Chart'], ['horn', 'Horn'], ['trimUp', 'Trim up'], ['trimDown', 'Trim down'], ['jobs', 'Jobs board']]
        : [['steer', 'Walk'], ['interact', 'Interact / board'], ['inventory', 'Inventory'], ['camNext', 'Camera'], ['map', 'Chart'], ['jobs', 'Jobs board']];
      if (b && b.def.thruster && atHelm) rows.splice(3, 0, ['thruster', 'Bow thruster']);
      const key = I.device + rows.map((r) => r[1]).join();
      if (key !== this._ctlKey) { this._ctlKey = key; $('hud-controls').innerHTML = rows.map(([a, l]) => `<div><kbd>${I.hint(a)}</kbd>${l}</div>`).join(''); }
    }
  }
}
