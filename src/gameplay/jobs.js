// Captain's jobs: things to DO on the bay, offered on the radio / job board (J).
//  * Charter    — pick up a party at one spot, deliver them to another. Pay
//                 depends on distance, time and how comfortable the ride was
//                 (every slam off a wave spills drinks and costs stars).
//  * Gate run   — a slalom of buoy gates laid out across open water from where
//                 you are; beat the par time for gold.
//  * Delivery   — rush a cooler of stone crabs to a restaurant before the
//                 clock runs out.
//  * Sunset cruise — be on the water at a scenic spot when the sun touches the
//                 horizon with guests aboard.
// Active objectives get a light beacon in the world, a marker on the chart and
// minimap and a compact objective card in the HUD. Cash earned is saved.
import * as THREE from 'three';
import { DESTINATIONS, MARINAS, heightAt } from '../world/geography.js';
import { bus } from '../core/events.js';
import { clamp, KNOT } from '../core/math.js';

const $ = (id) => document.getElementById(id);
const PARTIES = ['the Alvarez birthday crew', 'two honeymooners', 'a bachelorette party', 'a film crew scouting locations', 'four tech founders', 'a fishing guide and clients', 'grandma Rosa and the cousins', 'a wedding photographer'];
const FOOD = ['stone crabs', 'Cuban sandwiches', 'a birthday cake', 'fresh mahi-mahi', 'ice and limes', 'a case of champagne'];

function stops(game) {
  const list = [];
  for (const d of DESTINATIONS) if (d.kind !== 'bridge') list.push({ id: d.id, name: d.name, x: d.x, z: d.z, r: Math.min(140, d.r * 0.55) });
  for (const m of MARINAS) list.push({ id: m.id, name: m.name, x: m.x + m.out[0] * 60, z: m.z + m.out[1] * 60, r: 140 });
  const hb = game.homeBerth;
  if (hb) list.push({ id: 'home', name: 'Home dock', x: hb.x, z: hb.z, r: 60 });
  return list;
}

export class Jobs {
  constructor(game) {
    this.game = game;
    this.data = game.save.data;
    if (typeof this.data.cash !== 'number') this.data.cash = 0;
    if (!this.data.jobStats) this.data.jobStats = { done: 0, gold: 0, best: {} };
    this.offers = [];
    this.active = null;
    this.boardOpen = false;
    this.offerT = 25;
    this.group = new THREE.Group();
    this.group.name = 'jobs';
    game.scene.add(this.group);
    this.buildVisuals();
    this.refreshOffers();
    bus.on('slam', (e) => { const v = e.v || 0; if (this.active && this.active.guestsAboard) this.active.comfort = Math.max(0, this.active.comfort - clamp((v - 1.5) * 4, 1, 14)); });
    $('jobs-board').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (b) this.accept(+b.dataset.i);
      if (e.target.closest('[data-close]')) this.toggleBoard(false);
    });
  }

  // ------------------------------------------------------------ visuals
  buildVisuals() {
    // light beacon: tall additive column fading upward + a ring on the water
    const beamGeo = new THREE.CylinderGeometry(2.6, 4.5, 140, 24, 1, true);
    beamGeo.translate(0, 70, 0);
    const beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0.25, 0.75, 1.0) } },
      vertexShader: 'varying float vY; varying vec3 vN; varying vec3 vV; void main(){ vY = position.y / 140.0; vec4 w = modelMatrix * vec4(position,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'uniform float uTime; uniform vec3 uColor; varying float vY; varying vec3 vN; varying vec3 vV; void main(){ float rim = pow(1.0 - abs(dot(vN, vV)), 1.5); float a = (1.0 - vY) * (1.0 - vY) * (0.35 + 0.65 * rim) * (0.75 + 0.25 * sin(uTime * 3.0 - vY * 20.0)); gl_FragColor = vec4(uColor * a * 0.9, 1.0); }',
    });
    this.beamMat = beamMat;
    this.beacon = new THREE.Mesh(beamGeo, beamMat);
    this.beacon.frustumCulled = false;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), new THREE.MeshBasicMaterial({ color: 0x5fd0ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    this.ring = ring;
    this.beaconGroup = new THREE.Group();
    this.beaconGroup.add(this.beacon, ring);
    this.beaconGroup.visible = false;
    this.group.add(this.beaconGroup);
    // gate buoys (instanced): orange ball + white mast + light
    const ball = new THREE.SphereGeometry(0.9, 16, 10);
    const pole = new THREE.CylinderGeometry(0.08, 0.08, 2.4, 6); pole.translate(0, 1.6, 0);
    const lamp = new THREE.SphereGeometry(0.22, 8, 6); lamp.translate(0, 2.9, 0);
    const N = 40;
    this.buoyBall = new THREE.InstancedMesh(ball, new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.45 }), N);
    this.buoyPole = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }), N);
    this.buoyLamp = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ color: 0xffffff }), N);
    for (const im of [this.buoyBall, this.buoyPole, this.buoyLamp]) { im.count = 0; im.frustumCulled = false; this.group.add(im); }
    this.buoyBall.castShadow = true;
    // the next gate's arch
    const arch = new THREE.TorusGeometry(1, 0.035, 6, 48, Math.PI);
    this.arch = new THREE.Mesh(arch, new THREE.MeshBasicMaterial({ color: 0x66ddff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.arch.visible = false;
    this.group.add(this.arch);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1); this._c = new THREE.Color();
  }

  // ------------------------------------------------------------ offers
  refreshOffers() {
    const g = this.game, S = stops(g);
    const pick = (not) => { let s; for (let k = 0; k < 20; k++) { s = S[(Math.random() * S.length) | 0]; if (!not || s.id !== not.id) break; } return s; };
    const offers = [];
    const a = pick(), b = pick(a);
    const party = PARTIES[(Math.random() * PARTIES.length) | 0];
    const dist = Math.hypot(a.x - b.x, a.z - b.z);
    offers.push({ type: 'charter', title: `Charter: ${a.name} → ${b.name}`, desc: `Pick up ${party} at ${a.name} and take them to ${b.name}. Smooth ride = bigger tip.`, from: a, to: b, pay: Math.round(150 + dist * 0.12) });
    const d = pick(), food = FOOD[(Math.random() * FOOD.length) | 0];
    offers.push({ type: 'delivery', title: `Rush delivery to ${d.name}`, desc: `They're out of ${food}. Get it there fast — the clock starts when you accept.`, to: d, pay: 0, food });
    offers.push({ type: 'gates', title: 'Gate run: Biscayne slalom', desc: 'Ten buoy gates laid out ahead of you across open water. Beat par for gold.', pay: 240 });
    const hrs = g.day ? g.day.hours : 12;
    if (hrs > 15 && hrs < 19.3) {
      const sp = DESTINATIONS.find((x) => x.id === 'lighthouse');
      offers.push({ type: 'sunset', title: 'Sunset cruise at Cape Light Key', desc: 'Have guests aboard and be at Cape Light Key when the sun meets the horizon.', to: { id: sp.id, name: sp.name, x: sp.x, z: sp.z, r: 300 }, pay: 300 });
    }
    this.offers = offers;
    this.renderBoard();
  }

  toggleBoard(on = !this.boardOpen) {
    this.boardOpen = on;
    $('jobs-board').classList.toggle('hidden', !on);
    if (on) this.renderBoard();
  }

  renderBoard() {
    const el = $('jobs-board');
    if (!el) return;
    const st = this.data.jobStats;
    el.innerHTML = `<div class="jb-head"><b>Captain's jobs</b><span class="jb-cash">$${this.data.cash.toLocaleString()}</span><button class="jb-x" data-close>✕</button></div>`
      + (this.active ? `<div class="jb-active">Active: ${this.active.title}<br><small>Press J then 0 to abandon</small></div>` : '')
      + this.offers.map((o, i) => `<button class="jb-offer" data-i="${i}"><kbd>${i + 1}</kbd><div><b>${o.title}</b><small>${o.desc}</small></div><span>${o.type === 'gates' ? 'up to $' + o.pay : o.type === 'delivery' ? 'timed' : '$' + o.pay}</span></button>`).join('')
      + `<div class="jb-foot">${st.done} jobs done · ${st.gold} gold</div>`;
  }

  accept(i) {
    const o = this.offers[i];
    if (!o) return;
    const g = this.game, b = g.boat;
    if (!b || g.player.mode !== 'helm') { g.ui.toast('Take the helm of a boat first'); return; }
    this.abandon(true);
    const pos = b.phys.body.pos;
    const job = { ...o, t: 0, comfort: 100, step: 0, guestsAboard: false };
    if (o.type === 'charter') { job.target = o.from; job.stepText = `Pick up at ${o.from.name}`; }
    if (o.type === 'delivery') {
      job.target = o.to;
      const dist = Math.hypot(pos.x - o.to.x, pos.z - o.to.z);
      job.limit = Math.round(45 + dist / (22 * KNOT));
      job.pay = Math.round(120 + dist * 0.1);
      job.stepText = `Deliver ${o.food} to ${o.to.name}`;
    }
    if (o.type === 'sunset') { job.target = o.to; job.stepText = g.passengers.count ? 'Head to Cape Light Key' : 'Invite guests (dock), then head to Cape Light Key'; }
    if (o.type === 'gates') {
      const course = this.layCourse(pos.x, pos.z, b.phys.heading);
      if (!course) { g.ui.toast('Not enough open water here — head out into the bay'); return; }
      job.gates = course.gates; job.par = course.par; job.next = 0;
      job.stepText = 'Pass through gate 1';
      job.target = null;
    }
    this.active = job;
    this.offers.splice(i, 1);
    this.toggleBoard(false);
    g.audio.radioChirp && g.audio.radioChirp();
    g.ui.toast(`Job accepted — ${job.title}`, 4);
  }

  abandon(silent) {
    if (!this.active) return;
    if (!silent) this.game.ui.toast('Job abandoned');
    this.active = null;
    this.beaconGroup.visible = false; this.arch.visible = false;
    for (const im of [this.buoyBall, this.buoyPole, this.buoyLamp]) im.count = 0;
  }

  layCourse(x0, z0, heading) {
    const deep = (x, z) => heightAt(x, z) < -2.4;
    const clear = (ax, az, bx, bz) => { for (let t = 0; t <= 1; t += 0.1) if (!deep(ax + (bx - ax) * t, az + (bz - az) * t)) return false; return true; };
    for (let attempt = 0; attempt < 40; attempt++) {
      const gates = [];
      let h = heading + (attempt ? (Math.random() - 0.5) * 2.5 : 0);
      let x = x0 + Math.sin(h) * 120, z = z0 - Math.cos(h) * 120;
      let ok = deep(x, z) && clear(x0, z0, x, z), len = 120;
      for (let i = 0; i < 10 && ok; i++) {
        const w = 28 - i * 0.8;
        // gate centre + perpendicular half-width; check both buoys are in water
        const px = Math.cos(h), pz = Math.sin(h);
        if (!deep(x + px * w / 2, z + pz * w / 2) || !deep(x - px * w / 2, z - pz * w / 2)) { ok = false; break; }
        gates.push({ x, z, h, w });
        const turn = (i % 2 ? 1 : -1) * (0.35 + Math.random() * 0.45);
        h += turn;
        const step = 170 + Math.random() * 90;
        const nx = x + Math.sin(h) * step, nz = z - Math.cos(h) * step;
        if (!deep(nx, nz) || !clear(x, z, nx, nz)) { ok = false; break; }
        x = nx; z = nz; len += step;
      }
      if (ok && gates.length === 10) return { gates, par: Math.round(len / (27 * KNOT)) };
    }
    return null;
  }

  // ------------------------------------------------------------ per-frame
  update(dt, time) {
    const g = this.game, I = g.input;
    this.beamMat.uniforms.uTime.value = time;
    if (I.consume('jobs')) this.toggleBoard();
    if (this.boardOpen) {
      for (let k = 1; k <= 4; k++) if (I.consume('menu' + k)) { this.accept(k - 1); break; }
      if (I.consume('menu0')) { this.abandon(); this.toggleBoard(false); }
    }
    // radio offers every few minutes when idle at the helm
    this.offerT -= dt;
    if (this.offerT <= 0) {
      this.offerT = 150;
      this.refreshOffers();
      if (!this.active && g.player.mode === 'helm') g.ui.toast('📻 New jobs on the radio — press J', 5);
    }
    const job = this.active;
    this.renderHud(job);
    if (!job) return;
    const b = g.boat;
    if (!b || g.player.mode !== 'helm') return;
    job.t += dt;
    const pos = b.phys.body.pos, kn = b.phys.t.speedKn;
    if (job.guestsAboard && Math.abs(b.phys.t.vertAccel || 0) > 11) job.comfort = Math.max(0, job.comfort - dt * 12);
    const near = (s, r = s.r) => Math.hypot(pos.x - s.x, pos.z - s.z) < r;

    if (job.type === 'charter') {
      if (job.step === 0 && near(job.from) && kn < 4) {
        if (!g.passengers.count) g.passengers.invite(b, pos.clone ? pos.clone() : null);
        job.guestsAboard = true; job.step = 1; job.target = job.to; job.t0 = job.t;
        job.stepText = `Take them to ${job.to.name}`;
        g.ui.toast('Guests aboard — keep it smooth', 4);
      } else if (job.step === 1 && near(job.to) && kn < 4) {
        const ride = job.t - job.t0, dist = Math.hypot(job.from.x - job.to.x, job.from.z - job.to.z);
        const par = dist / (20 * KNOT) + 30;
        const stars = clamp(Math.round(job.comfort / 20 - Math.max(0, ride - par) / 60), 1, 5);
        const tip = Math.round(job.pay * (stars - 1) * 0.12);
        g.passengers.dropOff(b);
        this.finish(job.pay + tip, `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}  fare $${job.pay} + tip $${tip}`, stars === 5);
      }
    } else if (job.type === 'delivery') {
      const left = job.limit - job.t;
      job.stepText = `Deliver ${job.food} to ${job.to.name} · ${Math.max(0, Math.ceil(left))} s`;
      if (left <= 0) { g.ui.toast('Too late — the kitchen found another supplier', 4); this.abandon(true); this.refreshOffers(); return; }
      if (near(job.to) && kn < 5) {
        const bonus = Math.round(job.pay * clamp(left / job.limit, 0, 0.6));
        this.finish(job.pay + bonus, `Delivered with ${Math.ceil(left)} s to spare — $${job.pay} + $${bonus}`, left > job.limit * 0.35);
      }
    } else if (job.type === 'sunset') {
      job.guestsAboard = g.passengers.count > 0;
      job.stepText = job.guestsAboard ? (near(job.to) ? 'Wait for the sun to touch the horizon…' : 'Head to Cape Light Key') : 'Invite guests at a dock first (P)';
      if (job.guestsAboard && near(job.to) && g.day.sunElevation < 1.0 && g.day.sunElevation > -1.5) this.finish(job.pay, 'Everyone got the shot. Perfect sunset.', true);
      if (g.day.sunElevation < -3) { g.ui.toast('The sun set without you', 4); this.abandon(true); }
    } else if (job.type === 'gates') {
      const gt = job.gates[job.next];
      // crossing test: did we pass the gate line between last frame and now?
      const fx = Math.sin(gt.h), fz = -Math.cos(gt.h);
      const along = (pos.x - gt.x) * fx + (pos.z - gt.z) * fz;
      const lat = (pos.x - gt.x) * Math.cos(gt.h) + (pos.z - gt.z) * Math.sin(gt.h);
      if (job.lastAlong !== undefined && job.lastAlong < 0 && along >= 0) {
        if (Math.abs(lat) < gt.w / 2) {
          if (job.next === 0) job.tStart = job.t;
          job.next++;
          g.audio.chime && g.audio.chime();
          if (job.next >= job.gates.length) {
            const tm = job.t - job.tStart;
            const medal = tm <= job.par ? 'gold' : tm <= job.par * 1.2 ? 'silver' : 'bronze';
            const pay = Math.round(job.pay * (medal === 'gold' ? 1 : medal === 'silver' ? 0.65 : 0.4));
            this.finish(pay, `${medal.toUpperCase()} — ${tm.toFixed(1)} s (par ${job.par} s)`, medal === 'gold');
            return;
          }
        } else if (Math.abs(lat) < gt.w * 2) g.ui.toast('Missed the gate — come around and go through it', 2.5);
      }
      job.lastAlong = Math.abs(lat) < gt.w * 3 ? along : (along < 0 ? along : -1);
      const tm = job.tStart !== undefined ? job.t - job.tStart : 0;
      job.stepText = `Gate ${job.next + 1}/10${job.tStart !== undefined ? ` · ${tm.toFixed(1)} s / par ${job.par}` : ''}`;
      this.drawGates(job, time);
    }
    // beacon
    if (job.target) {
      this.beaconGroup.visible = true;
      this.beaconGroup.position.set(job.target.x, 0, job.target.z);
      const r = job.target.r || 60;
      this.ring.scale.set(r, r, r);
      this.ring.position.y = 0.25;
      this.beacon.scale.set(1 + r / 120, 1, 1 + r / 120);
    } else this.beaconGroup.visible = false;
  }

  drawGates(job, time) {
    const waves = this.game.waves;
    let n = 0;
    for (let i = job.next; i < job.gates.length; i++) {
      const gt = job.gates[i];
      for (const s of [-1, 1]) {
        const x = gt.x + Math.cos(gt.h) * s * gt.w / 2, z = gt.z + Math.sin(gt.h) * s * gt.w / 2;
        const y = waves.heightFast(x, z, time, 1) - 0.25;
        this._q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.sin(time * 1.4 + i + s) * 0.08);
        this._p.set(x, y, z);
        this._m.compose(this._p, this._q, this._s);
        this.buoyBall.setMatrixAt(n, this._m); this.buoyPole.setMatrixAt(n, this._m); this.buoyLamp.setMatrixAt(n, this._m);
        const on = i === job.next ? (Math.sin(time * 8) > 0 ? 1 : 0.25) : 0.15;
        this.buoyLamp.setColorAt(n, this._c.setRGB(on, on * 0.9 + 0.1, on * 0.4 + 0.2));
        n++;
      }
    }
    for (const im of [this.buoyBall, this.buoyPole, this.buoyLamp]) { im.count = n; im.instanceMatrix.needsUpdate = true; }
    if (this.buoyLamp.instanceColor) this.buoyLamp.instanceColor.needsUpdate = true;
    const gt = job.gates[job.next];
    this.arch.visible = true;
    this.arch.position.set(gt.x, 0.2, gt.z);
    this.arch.rotation.set(0, -gt.h, 0);
    this.arch.scale.set(gt.w / 2, gt.w * 0.22, 1);
  }

  finish(cash, line, gold) {
    const g = this.game;
    this.data.cash += cash;
    this.data.jobStats.done++;
    if (gold) this.data.jobStats.gold++;
    g.ui.toast(`Job complete +$${cash} — ${line}`, 6);
    g.audio.whoop && g.audio.whoop();
    this.abandon(true);
    this.refreshOffers();
  }

  renderHud(job) {
    const el = $('objective');
    if (!el) return;
    if (!job) { if (!el.classList.contains('hidden')) el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    let dist = '';
    const b = this.game.boat;
    const tgt = job.type === 'gates' ? job.gates[job.next] : job.target;
    if (b && tgt) dist = ` · ${Math.round(Math.hypot(b.phys.body.pos.x - tgt.x, b.phys.body.pos.z - tgt.z))} m`;
    const html = `<b>${job.title}</b><span>${job.stepText || ''}${dist}</span>`;
    if (html !== this._hud) { el.innerHTML = html; this._hud = html; }
  }

  // chart / minimap markers
  markers() {
    const job = this.active;
    if (!job) return [];
    if (job.type === 'gates') return job.gates.slice(job.next).map((gt, i) => ({ x: gt.x, z: gt.z, c: i === 0 ? '#5fd0ff' : 'rgba(95,208,255,0.5)', label: `Gate ${job.next + i + 1}`, icon: '◆' }));
    return job.target ? [{ x: job.target.x, z: job.target.z, c: '#5fd0ff', label: job.stepText, icon: '◎' }] : [];
  }
}
