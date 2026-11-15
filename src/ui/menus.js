// Menus & panels in the reference-photo design language: title, pause,
// settings (graphics / wheel & force feedback / audio / gameplay), boat
// selection (the actual models on rotating pedestals), logbook, controls,
// credits, inventory and the first-run wheel calibration wizard.
import * as THREE from 'three';
import { BOATS, BOAT_ORDER, PAINTS, TRIMS } from '../boats/boat-defs.js';
import { MILESTONES } from '../gameplay/logbook.js';
import { SEA_STATES } from '../water/spectrum.js';
import { CREDITS } from './credits.js';
import { WHEEL_ACTION_LABELS, DEFAULT_WHEEL_BUTTONS, CalibrationSession } from '../input/wheel.js';
import { DESTINATIONS, POIS } from '../world/geography.js';

const $ = (id) => document.getElementById(id);

export class Menus {
  constructor(game) {
    this.game = game;
    this.open = null;
    this.panelEl = $('panel');
    this.body = $('panel-body');
    this.preview = null;
    $('title-menu').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      game.audio.start();
      const act = b.dataset.act;
      if (act === 'start') game.startGame();
      else this.show(act);
    });
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('input', (e) => this.onInput(e));
    this.body.addEventListener('change', (e) => this.onInput(e));
    document.querySelector('[data-act="close-chart"]').addEventListener('click', () => game.toggleChart(false));
  }

  fade(t, mid) {
    const f = $('fade');
    f.style.transition = `opacity ${t / 2}s`;
    f.style.opacity = '1';
    setTimeout(() => { mid && mid(); f.style.opacity = '0'; }, (t / 2) * 1000 + 50);
  }

  close() {
    this.open = null;
    this.panelEl.classList.add('hidden');
    this.calib = null;
    this.game.onMenuClosed();
  }

  show(name, arg) {
    this.open = name;
    this.panelEl.classList.remove('hidden');
    const html = this[`html_${name}`] ? this[`html_${name}`](arg) : '';
    this.body.innerHTML = `<button class="close" data-act="close">✕</button>` + html;
    if (name === 'boats') this.startPreview();
    if (name === 'calibration') this.calib = null;
  }

  // ---------------------------------------------------------------- pause
  html_pause() {
    return `<h2>Paused</h2><p class="tiny">The bay will wait for you.</p>
      <div class="btns"><button class="primary" data-act="resume">Resume</button><button data-act="settings">Settings</button><button data-act="boats">Boats</button><button data-act="logbook">Logbook</button><button data-act="controls">Controls</button><button data-act="credits">Credits</button><button data-act="home">Return home</button><button data-act="title">Title screen</button></div>`;
  }

  // ---------------------------------------------------------------- settings
  html_settings(tab = 'graphics') {
    const s = this.game.save.data.settings;
    const sel = (key, opts) => `<select data-set="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(s[key]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const rng = (key, min, max, step, fmt = (v) => v) => `<input type="range" data-set="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}"><span data-val="${key}">${fmt(s[key])}</span>`;
    const chk = (key) => `<input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}>`;
    const row = (label, ctl, extra = '') => `<div class="row"><span>${label}</span>${ctl}<span>${extra}</span></div>`;
    const tabs = ['graphics', 'wheel', 'audio', 'gameplay'].map((t) => `<button data-tab="${t}" class="${t === tab ? 'on' : ''}">${{ graphics: 'Graphics', wheel: 'Wheel & force feedback', audio: 'Audio', gameplay: 'Gameplay' }[t]}</button>`).join('');
    let inner = '';
    if (tab === 'graphics') {
      const q = this.game.quality;
      inner = `<h3>Quality</h3>
        ${row('Preset', sel('preset', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']]), `<span class="tiny">auto-detected: ${q.detected}</span>`)}
        ${row('Resolution scale', rng('renderScale', 0.5, 1.5, 0.05, (v) => Math.round(v * 100) + '%'))}
        ${row('Water quality', sel('waterQuality', [['low', 'Low (10 waves)'], ['medium', 'Medium (13 waves)'], ['high', 'High (16 waves)'], ['ultra', 'Ultra (dense grid)']]), '<span class="tiny">reload</span>')}
        ${row('Planar reflections', chk('reflections'))}
        ${row('Shadows', chk('shadows'))}
        ${row('Bloom', chk('bloom'))}
        ${row('Anti-aliasing', sel('aa', [['msaa', 'MSAA'], ['fxaa', 'FXAA'], ['off', 'Off']]))}
        ${row('Foliage density', rng('foliage', 0.3, 1.5, 0.1, (v) => Math.round(v * 100) + '%'), '<span class="tiny">reload</span>')}
        ${row('Draw distance', rng('drawDistance', 1500, 6000, 250, (v) => v + ' m'))}
        ${row('Field of view', rng('fov', 50, 85, 1, (v) => v + '°'))}
        ${row('Show FPS', `<input type="checkbox" data-act="fps" ${this.game.showFps ? 'checked' : ''}>`)}`;
    } else if (tab === 'wheel') {
      const w = this.game.input.wheel;
      const pads = this.game.input.getPads();
      const gp = this.game.input.wheelIndex >= 0 ? pads[this.game.input.wheelIndex] : null;
      const c = w.calib || (gp ? w.autoCalib(gp) : null);
      const axisOpts = gp ? gp.axes.map((_, i) => [i, `Axis ${i}`]) : [[0, 'Axis 0']];
      const axSel = (key, cur) => `<select data-calib="${key}">${[[-1, 'None'], ...axisOpts].map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
      const btnMap = { ...DEFAULT_WHEEL_BUTTONS, ...(s.wheelButtons || {}) };
      inner = `<h3>Steering wheel ${gp ? `— ${gp.id.slice(0, 60)}` : '— not detected (press any wheel button)'}</h3>
        <div class="btns"><button class="primary" data-act="calibrate" ${gp ? '' : 'disabled'}>Recalibrate</button><button data-act="ffb">Enable force feedback (WebHID)</button><span class="tiny" id="ffb-status">${this.game.ffb.status}</span></div>
        ${row('FFB strength', rng('ffbStrength', 0, 100, 1, (v) => v + '%'))}
        ${row('Invert force direction', chk('invertFfb'))}
        ${row('Wheel lock (full rudder at)', sel('wheelLock', [[270, '270°'], [360, '360°'], [540, '540°'], [720, '720°'], [900, '900° (full travel)'], [1080, '1080°']]))}
        ${row('Wheel rotation range (G HUB)', sel('wheelRange', [[270, '270°'], [540, '540°'], [900, '900°'], [1080, '1080°']]))}
        ${row('Deadzone', rng('deadzone', 0, 0.1, 0.005, (v) => (v * 100).toFixed(1) + '%'))}
        <h3>Manual axis override</h3>
        ${row('Steering axis', axSel('steer', c ? c.steer.axis : 0), `invert ${chk('invertSteer')}`)}
        ${row('Throttle pedal axis', axSel('throttle', c ? c.throttle.axis : 2), `invert ${chk('invertThrottle')}`)}
        ${row('Brake pedal (reverse) axis', axSel('brake', c ? c.brake.axis : 5), `invert ${chk('invertBrake')}`)}
        ${row('Clutch (bow thruster) axis', axSel('clutch', c && c.clutch ? c.clutch.axis : -1), `invert ${chk('invertClutch')}`)}
        <h3>Button mapping</h3>
        ${Object.entries(WHEEL_ACTION_LABELS).map(([a, l]) => row(l, `<button data-remap="${a}">Button ${btnMap[a]}</button>`)).join('')}
        <p class="tiny">Click a mapping, then press the wheel button to assign it.</p>`;
    } else if (tab === 'audio') {
      inner = `<h3>Mix</h3>
        ${row('Master', rng('master', 0, 1, 0.01, (v) => Math.round(v * 100) + '%'))}
        ${row('Engines', rng('engineVol', 0, 1, 0.01, (v) => Math.round(v * 100) + '%'))}
        ${row('Water & ambience', rng('ambienceVol', 0, 1, 0.01, (v) => Math.round(v * 100) + '%'))}
        ${row('Radio', rng('musicVol', 0, 1, 0.01, (v) => Math.round(v * 100) + '%'))}
        ${row('Effects', rng('sfxVol', 0, 1, 0.01, (v) => Math.round(v * 100) + '%'))}
        ${row('Station', sel('radioStation', [[-1, 'Off'], [0, 'Bay FM 88.1 · lo-fi'], [1, 'Coral Radio 94.7 · bossa'], [2, 'Night Drive 101.9 · synthwave']]))}`;
    } else {
      inner = `<h3>World</h3>
        ${row('Sea state', sel('seaState', [['auto', 'Auto (follows the day)'], ...Object.entries(SEA_STATES).map(([k, v]) => [k, v.label])]))}
        ${row('Time of day', `<input type="range" data-act="tod" min="0" max="23.9" step="0.1" value="${this.game.day.hours.toFixed(1)}"><span id="tod-val">${this.game.day.clock.text}</span>`)}
        ${row('Day length', rng('dayMinutes', 5, 60, 1, (v) => v + ' min'))}
        ${row('Speed units', sel('units', [['knots', 'Knots'], ['mph', 'MPH'], ['kmh', 'km/h']]))}
        ${row('Depth units', sel('depthUnits', [['m', 'Metres'], ['ft', 'Feet']]))}
        ${row('Mouse sensitivity', rng('mouseSensitivity', 0.3, 2.5, 0.05, (v) => v.toFixed(2)))}
        ${row('Invert look', chk('invertLook'))}
        ${row('Show HUD', chk('hud'))}
        <div class="btns"><button data-act="reset" style="border-color:#ff8f7a;color:#ff8f7a">Reset save</button></div>`;
    }
    return `<h2>Settings</h2><div class="tabs">${tabs}</div>${inner}`;
  }

  // ---------------------------------------------------------------- boats
  html_boats() {
    const g = this.game, save = g.save.data;
    const unlocked = (u) => !u || save.unlocks.includes(u);
    return `<h2>Select your boat</h2><p class="tiny">Your boats are moored at Bayside Marina and your home dock. Paints and trims unlock through the logbook.</p>
      <div class="cards">${BOAT_ORDER.map((id) => {
        const d = BOATS[id], st = g.save.boatState(id);
        return `<div class="card"><canvas data-preview="${id}" width="320" height="200"></canvas><div class="body"><b>${d.name}</b><small>${d.kind}</small><div class="stats">Top speed: ${d.stats.top}<br>Handling: ${d.stats.handling}<br>Seats: ${d.stats.seats}</div><small>${d.blurb}</small>
          <div class="swatches">${PAINTS.map((p) => `<span class="swatch ${st.paint === p.id ? 'on' : ''} ${unlocked(p.unlock) ? '' : 'locked'}" title="${p.name}${unlocked(p.unlock) ? '' : ' (locked)'}" style="background:#${p.hull.toString(16).padStart(6, '0')}" data-paint="${id}:${p.id}"></span>`).join('')}</div>
          <div class="swatches">${TRIMS.map((t) => `<button style="padding:3px 8px;font-size:11px;border-radius:6px;${st.trim === t.id ? 'background:#5ff2ff' : 'background:rgba(255,255,255,0.8)'}${unlocked(t.unlock) ? '' : ';opacity:0.3'}" data-trim="${id}:${t.id}">${t.name}</button>`).join('')}</div>
          <button data-boat="${id}" class="${save.boat === id ? 'cur' : ''}">${save.boat === id ? 'Current boat' : 'Select'}</button></div></div>`;
      }).join('')}</div>`;
  }

  startPreview() {
    const g = this.game;
    if (!this.preview) {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      r.setSize(320, 200);
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.outputColorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x445566, 1.6));
      const sun = new THREE.DirectionalLight(0xffe2c0, 2.6); sun.position.set(5, 8, 6); scene.add(sun);
      const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.05, 0.2, 48), new THREE.MeshStandardMaterial({ color: 0xe9eef2, roughness: 0.3, metalness: 0.2 }));
      scene.add(pedestal);
      const models = {};
      for (const id of BOAT_ORDER) {
        const m = g.assets.cloneModel(BOATS[id].model, { cloneMaterials: false });
        const box = new THREE.Box3().setFromObject(m);
        const size = box.getSize(new THREE.Vector3());
        const s = 2.2 / Math.max(size.x, size.z);
        m.scale.setScalar(s);
        m.position.y = 0.1;
        m.visible = false;
        scene.add(m);
        models[id] = { m, s, h: size.y * s };
      }
      const cam = new THREE.PerspectiveCamera(32, 1.6, 0.1, 50);
      this.preview = { r, scene, models, cam, pedestal, t: 0 };
    }
  }

  renderPreview(dt) {
    if (this.open !== 'boats' || !this.preview) return;
    const P = this.preview;
    P.t += dt * 0.6;
    for (const cv of this.body.querySelectorAll('canvas[data-preview]')) {
      const id = cv.dataset.preview;
      for (const k of Object.keys(P.models)) P.models[k].m.visible = k === id;
      const M = P.models[id];
      M.m.rotation.y = P.t;
      P.pedestal.scale.set(1.35, 1, 1.35);
      P.cam.position.set(Math.sin(0.6) * 3.6, 1.4 + M.h * 0.4, Math.cos(0.6) * 3.6);
      P.cam.lookAt(0, M.h * 0.35, 0);
      P.r.setClearColor(0x6fa8d0, 1);
      P.r.render(P.scene, P.cam);
      const ctx = cv.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 0, 200);
      grad.addColorStop(0, '#f6b38a'); grad.addColorStop(0.55, '#7fb2d8'); grad.addColorStop(1, '#2a6a96');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, 320, 200);
      ctx.drawImage(P.r.domElement, 0, 0);
    }
  }

  // ---------------------------------------------------------------- logbook
  html_logbook() {
    const l = this.game.save.data.logbook, un = this.game.save.data.unlocks;
    const stat = (label, val) => `<div class="stat"><small>${label}</small><b>${val}</b></div>`;
    const dests = DESTINATIONS.map((d) => `<div class="ms"><span>${d.name}</span><span class="${l.visited.includes(d.id) ? 'done' : ''}">${l.visited.includes(d.id) ? '✓ visited' : '—'}</span></div>`).join('');
    return `<h2>Logbook</h2>
      <div class="stat-grid">${stat('Nautical miles', l.nm.toFixed(1))}${stat('Fastest', l.topSpeedKn.toFixed(1) + ' kn')}${stat('Longest dinghy jump', l.longestJumpM.toFixed(1) + ' m')}${stat('Cleanest docking', l.bestDock + '/100')}${stat('Places visited', `${l.visited.length}/${POIS.length}`)}${stat('Dolphins escorted', l.dolphins)}${stat('Sunsets on the water', l.sunsets)}${stat('Guests hosted', l.guests)}</div>
      <h3>Destinations</h3>${dests}
      <h3>Milestones</h3>${MILESTONES.map((m) => `<div class="ms"><span>${m.label} <small class="tiny">— ${m.hint}</small></span><span class="${un.includes(m.id) ? 'done' : ''}">${un.includes(m.id) ? '✓ unlocked' : 'locked'}</span></div>`).join('')}`;
  }

  // ---------------------------------------------------------------- controls
  html_controls() {
    const t = (rows) => `<div>${rows.map(([a, b]) => `<div class="ms"><span>${a}</span><span><kbd>${b}</kbd></span></div>`).join('')}</div>`;
    return `<h2>Controls</h2>
      <h3>Logitech G920 wheel</h3>${t([['Wheel', 'Helm / rudder'], ['Gas pedal', 'Forward throttle'], ['Brake pedal', 'Reverse throttle'], ['Clutch pedal', 'Bow thruster (yacht)'], ['A', 'Engine start (hold 1 s: stop) / interact'], ['B', 'Anchor drop / raise'], ['X', 'Horn'], ['Y', 'Docking mode'], ['LB / RB paddles', 'Cycle camera'], ['D-pad ↑ ↓', 'Minimap zoom / menu'], ['D-pad ← →', 'Radio station'], ['View', 'Settings / pause'], ['Menu', 'Chart'], ['Xbox', 'Leave the helm']])}
      <h3>Keyboard & mouse</h3>${t([['W / S', 'Throttle / reverse (ramps like pedals)'], ['A / D', 'Steer (auto-centres)'], ['Z / X', 'Bow thruster'], ['E', 'Engine (hold: stop) · interact / take helm'], ['G', 'Leave helm'], ['Space', 'Anchor'], ['H', 'Horn'], ['F', 'Docking mode'], ['C / V', 'Camera next / previous'], ['M', 'Chart'], ['R / Shift+R', 'Radio'], ['1–6', 'Context menu (docked / anchored)'], ['P / O / T', 'Passengers / hang out / call TowBoatUS'], ['Tab', 'Inventory'], ['RMB / LMB / Q', 'Aim / fire / reload'], ['Shift', 'Run'], ['Esc', 'Pause']])}
      <h3>Xbox / PlayStation controller</h3>${t([['Left stick', 'Steer / walk'], ['RT / LT', 'Throttle / reverse · fire / aim'], ['Right stick', 'Look · bow thruster at the helm'], ['A', 'Engine · interact'], ['B', 'Anchor'], ['X', 'Horn'], ['Y', 'Docking mode'], ['LB / RB', 'Camera'], ['LS click', 'Leave helm'], ['RS click', 'Inventory'], ['View / Menu', 'Pause / chart']])}
      <h3>Rules of the road</h3><p class="tiny">Keep to starboard. Meeting head-on, both turn to starboard. Crossing: the boat with the other on its starboard (right) side gives way. The overtaking boat keeps clear. Slow to no-wake speed near marinas, sandbars and destinations. AI skippers follow these rules — and sound five short blasts if you don't.</p>`;
  }

  html_credits() {
    return `<h2>Credits</h2><div class="credits"><p>Biscayne Drift — built with three.js (MIT). All audio is synthesised in real time. Coastline and building heights derived from the "Miami, Florida, USA" model.</p>
      ${CREDITS.map((c) => `<p><b>${c.title}</b> by ${c.author} — ${c.license} — <a style="color:#5ff2ff" href="${c.source}" target="_blank" rel="noopener">source</a></p>`).join('')}
      <p>Ferrari Portofino model is CC-BY-NC-SA-4.0: non-commercial use only.</p></div>`;
  }

  // ---------------------------------------------------------------- inventory
  html_inventory() {
    const p = this.game.player;
    return `<h2>Inventory</h2><p class="tiny">Select an item to equip. Hold aim (RMB / LT) and fire (LMB / RT). Shots splash the water and knock the floating targets near your dock.</p>
      <div class="inv">${p.inventory.map((it) => `<div class="item ${p.equipped === it.id ? 'on' : ''}" data-equip="${it.id}"><b>${it.name}</b><br><small class="tiny">${it.desc}</small>${it.ammo !== undefined ? `<br><small>${it.ammo}/${it.mag} · ${it.reserve} spare</small>` : ''}</div>`).join('')}
      <div class="item ${!p.equipped ? 'on' : ''}" data-equip=""><b>Empty hands</b><br><small class="tiny">Holster everything.</small></div></div>`;
  }

  // ---------------------------------------------------------------- calibration wizard
  html_calibration() {
    return `<h2>Steering wheel setup</h2><p class="tiny">A steering wheel was detected. Let's calibrate it — takes ten seconds.</p>
      <h3 id="calib-step">Center the wheel and take your feet off the pedals</h3>
      <div class="calib-meter"><i id="calib-fill"></i></div>
      <div class="axes" id="calib-axes"></div>
      <div class="btns"><button class="primary" data-act="calib-next">Next</button><button data-act="calib-skip">Skip clutch</button><button data-act="close">Use auto-mapping</button></div>`;
  }

  updateCalibration(dt) {
    if (this.open !== 'calibration') return;
    const g = this.game, pads = g.input.getPads();
    const gp = g.input.wheelIndex >= 0 ? pads[g.input.wheelIndex] : null;
    if (!gp) return;
    if (!this.calib) this.calib = new CalibrationSession(gp);
    const c = this.calib;
    c.sample(gp, dt);
    const steps = ['Center the wheel and take your feet off the pedals', 'Turn the wheel fully left, then fully right', 'Press the throttle (gas) pedal to the floor', 'Press the brake pedal to the floor', 'Press the clutch to the floor (bow thruster) — or skip', 'Done!'];
    const el = $('calib-step');
    if (el) el.textContent = `Step ${Math.min(c.step + 1, 5)} of 5 — ${steps[c.step]}`;
    const fill = $('calib-fill');
    if (fill) fill.style.width = `${c.step === 0 ? Math.min(100, c.t / 1.2 * 100) : c.progress(gp) * 100}%`;
    const ax = $('calib-axes');
    if (ax) ax.innerHTML = gp.axes.map((v, i) => `<div>A${i}: ${v.toFixed(2)}</div>`).join('');
    // auto-advance when a step is clearly complete
    if (c.step >= 1 && c.step <= 4 && c.progress(gp) > 0.95) {
      c.holdT = (c.holdT || 0) + dt;
      if (c.holdT > (c.step === 1 ? 1.2 : 0.5)) { c.next(gp.axes); c.holdT = 0; }
    }
    if (c.done) this.finishCalibration();
  }

  finishCalibration() {
    const c = this.calib;
    const r = c.result;
    if (!r.steer) r.steer = { axis: 0, left: -1, right: 1, center: 0 };
    if (!r.throttle) r.throttle = { axis: -1, rest: 1, pressed: -1 };
    if (!r.brake) r.brake = { axis: -1, rest: 1, pressed: -1 };
    this.game.input.wheel.storeCalibration(r);
    this.game.ui.toast('Wheel calibrated — enjoy the helm');
    this.close();
  }

  // ---------------------------------------------------------------- events
  onClick(e) {
    const g = this.game, save = g.save.data;
    const t = e.target.closest('[data-act],[data-tab],[data-boat],[data-paint],[data-trim],[data-equip],[data-remap]');
    if (!t) return;
    g.audio.click();
    if (t.dataset.tab) { this.show('settings', t.dataset.tab); return; }
    if (t.dataset.boat) { g.selectBoat(t.dataset.boat); this.show('boats'); return; }
    if (t.dataset.paint) {
      const [id, p] = t.dataset.paint.split(':');
      const paint = PAINTS.find((x) => x.id === p);
      if (paint.unlock && !save.unlocks.includes(paint.unlock)) { g.ui.toast('Locked — see the logbook'); return; }
      g.save.boatState(id).paint = p; g.repaint(id); this.show('boats'); return;
    }
    if (t.dataset.trim) {
      const [id, p] = t.dataset.trim.split(':');
      const tr = TRIMS.find((x) => x.id === p);
      if (tr.unlock && !save.unlocks.includes(tr.unlock)) { g.ui.toast('Locked — see the logbook'); return; }
      g.save.boatState(id).trim = p; g.repaint(id); this.show('boats'); return;
    }
    if (t.dataset.equip !== undefined) { g.player.equip(t.dataset.equip || null); this.close(); return; }
    if (t.dataset.remap) {
      t.textContent = 'Press a wheel button…';
      g.awaitRemap = t.dataset.remap;
      return;
    }
    const act = t.dataset.act;
    if (act === 'close' || act === 'resume') return this.close();
    if (act === 'settings' || act === 'boats' || act === 'logbook' || act === 'controls' || act === 'credits') return this.show(act);
    if (act === 'title') { this.close(); g.toTitle(); return; }
    if (act === 'home') { this.close(); g.goHome(); return; }
    if (act === 'calibrate') return this.show('calibration');
    if (act === 'calib-next' && this.calib) { const gp = g.input.getPads()[g.input.wheelIndex]; if (gp) this.calib.next(gp.axes); if (this.calib.done) this.finishCalibration(); return; }
    if (act === 'calib-skip' && this.calib) { this.calib.step = 5; this.finishCalibration(); return; }
    if (act === 'ffb') {
      g.ffb.enable().then((r) => {
        const el = $('ffb-status');
        const msg = r.ok ? `Force feedback active (${r.mode}) on ${r.name}` : `Could not enable: ${r.error || 'no device'} — using rumble + perceived feedback`;
        if (el) el.textContent = msg;
        g.ui.toast(msg, 5);
      });
      return;
    }
    if (act === 'fps') { g.showFps = t.checked; $('fps').classList.toggle('hidden', !g.showFps); return; }
    if (act === 'reset') { if (confirm('Erase your logbook, boats and settings?')) { g.save.reset(); location.reload(); } }
  }

  onInput(e) {
    const g = this.game, s = g.save.data.settings;
    const t = e.target;
    if (t.dataset.act === 'tod') { g.day.setHours(parseFloat(t.value)); const v = $('tod-val'); if (v) v.textContent = g.day.clock.text; return; }
    if (t.dataset.calib) {
      const w = g.input.wheel;
      const gp = g.input.getPads()[g.input.wheelIndex];
      const c = JSON.parse(JSON.stringify(w.calib || (gp ? w.autoCalib(gp) : null)));
      if (!c) return;
      const ax = parseInt(t.value, 10);
      const k = t.dataset.calib;
      if (k === 'steer') c.steer = { axis: ax, left: -1, right: 1, center: 0 };
      else c[k] = { axis: ax, rest: gp ? gp.axes[ax] ?? 1 : 1, pressed: -(gp ? gp.axes[ax] ?? 1 : 1) || -1 };
      delete c.auto;
      w.storeCalibration(c);
      return;
    }
    const key = t.dataset.set;
    if (!key) return;
    let v = t.type === 'checkbox' ? t.checked : t.type === 'range' ? parseFloat(t.value) : t.value;
    if (['wheelLock', 'wheelRange', 'radioStation'].includes(key)) v = parseInt(v, 10);
    s[key] = v;
    const lab = this.body.querySelector(`[data-val="${key}"]`);
    if (lab) {
      const f = { renderScale: (x) => Math.round(x * 100) + '%', foliage: (x) => Math.round(x * 100) + '%', drawDistance: (x) => x + ' m', fov: (x) => x + '°', ffbStrength: (x) => x + '%', deadzone: (x) => (x * 100).toFixed(1) + '%', dayMinutes: (x) => x + ' min', mouseSensitivity: (x) => x.toFixed(2) }[key] || ((x) => Math.round(x * 100) + '%');
      lab.textContent = f(v);
    }
    g.applySettings(key);
    g.save.persist();
  }
}
