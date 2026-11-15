// Seamanship: docking (assist mode, berth highlight, scoring, lines, cast-off),
// anchoring (chain, rode, raise), beaching + hangout, impacts and real damage,
// flooding and sinking, fuel, repairs, and the TowBoatUS rescue.
import * as THREE from 'three';
import { clamp, wrapAngle } from '../core/math.js';
import { impactDamage, groundingDamage } from '../physics/damage.js';
import { heightAt } from '../world/geography.js';
import { bus } from '../core/events.js';
import { LAYER_NO_REFLECT } from '../render/reflection.js';

const _v = new THREE.Vector3();

export class Seamanship {
  constructor(game) {
    this.game = game;
    this.dockMode = false;
    this.target = null;
    this.docked = null;         // berth
    this.dockTimer = 0;
    this.approachImpact = 0;
    this.dockStart = 0;
    this.anchor = null;         // { x, z, depth, rode, raising }
    this.beached = false;
    this.hangout = false;
    this.sinking = 0;
    this.leakWarned = false;
    this.lines = [];
    // berth highlight (glowing rectangle)
    const hl = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0x5ff2ff }));
    hl.rotation.x = -Math.PI / 2;
    this.highlight = new THREE.Group();
    this.highlight.add(hl);
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x5ff2ff, transparent: true, opacity: 0.12, depthWrite: false }));
    fill.rotation.x = -Math.PI / 2;
    this.highlight.add(fill);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.6, 3), new THREE.MeshBasicMaterial({ color: 0x5ff2ff }));
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, 0.2, -0.45);
    this.arrow = arrow;
    this.highlight.add(arrow);
    this.highlight.visible = false;
    this.highlight.layers.set(LAYER_NO_REFLECT);
    hl.layers.set(LAYER_NO_REFLECT); fill.layers.set(LAYER_NO_REFLECT); arrow.layers.set(LAYER_NO_REFLECT);
    game.scene.add(this.highlight);
    // anchor chain
    this.chain = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x555555 }));
    this.chain.visible = false;
    this.chain.frustumCulled = false;
    game.scene.add(this.chain);
    this.ropeMat = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.9 });
    bus.on('helm', () => { this.hangout = false; });
  }

  get boat() { return this.game.boat; }

  nearestBerth(maxDist = 160) {
    const b = this.boat;
    let best = null, bd = maxDist;
    for (const berth of this.game.allBerths()) {
      if (berth.occupied && berth.occupied !== b) continue;
      const d = Math.hypot(berth.x - b.pos.x, berth.z - b.pos.z);
      // big boats need big berths
      if (berth.len < b.def.length * 0.85 || berth.width < b.def.beam * 0.9) continue;
      if (d < bd) { bd = d; best = berth; }
    }
    return best;
  }

  toggleDockMode() {
    if (this.docked) return;
    if (!this.dockMode) {
      const t = this.nearestBerth();
      if (!t) { this.game.ui.toast('No free berth within 160 m'); return; }
      this.target = t;
      this.dockMode = true;
      this.dockStart = this.game.time;
      this.approachImpact = 0;
      this.game.cams.setMode('dock');
      this.game.ui.toast(`Docking: ${this.berthLabel(t)}`);
    } else {
      this.dockMode = false;
      this.highlight.visible = false;
      this.game.cams.setMode(this.game.lastBoatCam || 'chase');
    }
  }

  berthLabel(b) {
    const kind = b.fuel ? 'fuel dock (side-tie)' : b.type === 'bow' ? 'finger slip (bow-in)' : b.type === 'stern' ? 'quay (stern-to)' : 'side-tie';
    const where = b.home ? 'your dock' : (b.marina || '').replace(/^\w/, (c) => c.toUpperCase());
    return `${where} — ${kind}`;
  }

  // local frame of a berth: u across, v along the boat
  berthLocal(berth, x, z) {
    const fx = Math.sin(berth.heading), fz = -Math.cos(berth.heading);
    const dx = x - berth.x, dz = z - berth.z;
    return { v: dx * fx + dz * fz, u: dx * -fz + dz * fx };
  }

  dock(berth, score) {
    const b = this.boat;
    this.docked = berth;
    berth.occupied = b;
    this.dockMode = false;
    this.highlight.visible = false;
    b.phys.engineOn = false;
    b.phys.input.throttle = b.phys.input.reverse = 0;
    // dock lines: bow + stern cleats to the dock
    const fx = Math.sin(berth.heading), fz = -Math.cos(berth.heading);
    const L = b.def.length;
    const side = Math.sign((berth.cleatX - berth.x) * -fz + (berth.cleatZ - berth.z) * fx) || 1;
    const anchors = [];
    for (const k of [-0.38, 0.38]) {
      const along = berth.type === 'bow' || berth.type === 'stern' ? 0 : k * L;
      const ax = berth.cleatX + fx * along, az = berth.cleatZ + fz * along;
      anchors.push({ local: new THREE.Vector3(side * b.def.beam * 0.45, b.def.deckAboveCom * 0.5, -k * L * 0.8), anchor: new THREE.Vector3(berth.type === 'bow' ? berth.x + fx * (-L * 0.45) - fz * side * 2.5 * Math.sign(k) : ax, berth.deckY, berth.type === 'bow' ? berth.z + fz * (-L * 0.45) + fx * side * 2.5 * Math.sign(k) : az), rest: 0.6 });
    }
    b.phys.lines = anchors;
    this.makeRopes(anchors);
    this.game.audio.creak();
    this.game.audio.chime();
    const sc = Math.round(score);
    this.game.logbook.docked(sc, berth);
    this.game.ui.toast(`Docked — score ${sc}/100`);
    bus.emit('docked', { berth, score: sc });
    this.game.cams.setMode(this.game.lastBoatCam || 'chase');
  }

  // tie up silently (boat already in its berth, e.g. at load or after switching)
  attachLines(berth) {
    const b = this.boat;
    this.docked = berth;
    berth.occupied = b;
    const fx = Math.sin(berth.heading), fz = -Math.cos(berth.heading);
    const L = b.def.length;
    const side = Math.sign((berth.cleatX - berth.x) * -fz + (berth.cleatZ - berth.z) * fx) || 1;
    const lines = [-0.38, 0.38].map((k) => ({
      local: new THREE.Vector3(side * b.def.beam * 0.45, b.def.deckAboveCom * 0.5, -k * L * 0.8),
      anchor: new THREE.Vector3(berth.x + fx * k * L * 0.8 + -fz * side * (b.def.beam * 0.5 + 0.8), berth.deckY, berth.z + fz * k * L * 0.8 + fx * side * (b.def.beam * 0.5 + 0.8)),
      rest: 0.6,
    }));
    b.phys.lines = lines;
    b.phys.engineOn = false;
    this.makeRopes(lines);
    for (const r of this.lines) r.t = 1;
  }

  makeRopes(lines) {
    for (const r of this.lines) this.game.scene.remove(r.mesh);
    this.lines = lines.map((ln) => {
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(), new THREE.Vector3(0, 0, 1)), 4, 0.025, 5), this.ropeMat);
      mesh.frustumCulled = false;
      this.game.scene.add(mesh);
      return { ln, mesh, t: 0 };
    });
  }

  updateRopes(dt) {
    const b = this.boat;
    this._ropeT = (this._ropeT || 0) + dt;
    const settled = this.lines.every((r) => r.t >= 1);
    if (settled && this._ropeT < 0.1) return;
    this._ropeT = 0;
    for (const r of this.lines) {
      r.t = Math.min(1, r.t + dt * 1.5 + (settled ? 0 : 0.05));
      const a = _v.copy(r.ln.local).applyMatrix4(b.root.matrixWorld);
      const end = a.clone().lerp(r.ln.anchor, r.t);
      const mid = a.clone().lerp(end, 0.5); mid.y -= 0.35 * (1 - r.t * 0.6);
      r.mesh.geometry.dispose();
      r.mesh.geometry = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a.clone(), mid, end), 8, 0.025, 5);
    }
  }

  castOff() {
    const b = this.boat;
    if (!this.docked) return;
    this.docked.occupied = null;
    const berth = this.docked;
    this.docked = null;
    b.phys.lines = null;
    for (const r of this.lines) this.game.scene.remove(r.mesh);
    this.lines = [];
    // automatic shove-off away from the dock
    const fx = Math.sin(berth.heading), fz = -Math.cos(berth.heading);
    const side = Math.sign((berth.cleatX - berth.x) * -fz + (berth.cleatZ - berth.z) * fx) || 1;
    _v.set(fz * side, 0, -fx * side).multiplyScalar(b.phys.body.mass * 0.6);
    b.phys.body.vel.addScaledVector(_v, b.phys.body.invMass);
    if (berth.type === 'bow') b.phys.body.vel.add(_v.set(fx, 0, fz).multiplyScalar(-0.4));
    if (!b.phys.engineOn) this.startEngine();
    this.game.audio.creak();
    this.game.ui.toast('Lines off — easy does it');
  }

  startEngine() {
    const b = this.boat;
    if (b.phys.fuel <= 0) { this.game.ui.toast('Out of fuel — press T to call TowBoatUS'); }
    b.phys.engineOn = true;
    this.game.audio.starter();
  }

  toggleAnchor() {
    const b = this.boat;
    if (this.docked) return;
    if (this.anchor) {
      if (this.anchor.raising) return;
      this.anchor.raising = 4;
      this.game.audio.anchorRaise();
      this.game.ui.toast('Raising anchor…');
      return;
    }
    if (b.phys.t.speedKn > 1) { this.game.ui.toast('Slow below 1 knot to drop anchor'); return; }
    b.root.updateMatrixWorld();
    const bow = _v.copy(b.phys.bowLocal).applyMatrix4(b.root.matrixWorld);
    const fx = Math.sin(b.phys.heading), fz = -Math.cos(b.phys.heading);
    const x = bow.x + fx * 3, z = bow.z + fz * 3;
    const depth = Math.max(0.5, -heightAt(x, z));
    this.anchor = { x, z, depth, rode: depth * 5 + 8, raising: 0 };
    b.phys.anchor = this.anchor;
    this.chain.visible = true;
    this.game.audio.anchorDrop();
    this.game.wake.splash(x, 0, z, 0.6);
    this.game.ui.toast(`Anchor down in ${depth.toFixed(1)} m — ${Math.round(this.anchor.rode)} m of rode`);
    bus.emit('anchored', {});
  }

  // ------------------------------------------------------------------ per physics step
  onImpact(imp, phys) {
    if (imp.speed < 0.35) return;
    const kind = imp.collider.kind;
    const dmg = impactDamage(imp.speed, phys.body.mass, imp.collider.damage);
    if (this.dockMode) this.approachImpact = Math.max(this.approachImpact, imp.speed);
    if (imp.speed > 0.8) {
      this.game.events.push({ type: 'impact', speed: imp.speed, x: imp.x, y: imp.y, z: imp.z, nx: imp.nx, nz: imp.nz, dmg, kind });
    }
    if (dmg > 0) this.applyDamage(dmg, imp);
  }

  applyDamage(dmg, imp) {
    const b = this.boat;
    b.phys.integrity = Math.max(0, b.phys.integrity - dmg);
    if (imp) b.damage.add(new THREE.Vector3(imp.x, imp.y, imp.z), new THREE.Vector3(imp.nx, 0, imp.nz), clamp(dmg * 3, 0.1, 1));
    this.game.logbook.collision();
    const st = this.game.save.boatState(b.id);
    st.integrity = b.phys.integrity;
  }

  // ------------------------------------------------------------------ per frame
  update(dt, input) {
    const b = this.boat;
    if (!b) return;
    const p = b.phys, t = p.t;
    // anchor raising + chain visual
    if (this.anchor) {
      const a = this.anchor;
      if (a.raising > 0) {
        a.raising -= dt;
        a.rode = Math.max(0.5, a.rode - dt * a.rode / 2);
        if (a.raising <= 0) { this.anchor = null; p.anchor = null; this.chain.visible = false; this.game.ui.toast('Anchor up'); }
      }
      if (this.anchor) {
        b.root.updateMatrixWorld();
        const bow = _v.copy(p.bowLocal).applyMatrix4(b.root.matrixWorld);
        const pos = this.chain.geometry.attributes.position;
        pos.setXYZ(0, bow.x, bow.y, bow.z);
        pos.setXYZ(1, a.x, -a.depth, a.z);
        pos.needsUpdate = true;
        if (Math.max(p.input.throttle, p.input.reverse) > 0.6 && Math.random() < dt * 0.5) this.game.ui.toast('Anchor is down — raise it first');
      }
    }
    // docking assist
    if (this.dockMode && this.target) {
      const br = this.target;
      this.highlight.visible = true;
      this.highlight.position.set(br.x, 0.25 + this.game.waves.heightFast(br.x, br.z, this.game.time, 0.5), br.z);
      this.highlight.rotation.y = -br.heading;
      this.highlight.children[0].scale.set(br.width, br.len, 1);
      this.highlight.children[1].scale.set(br.width, br.len, 1);
      this.arrow.position.set(0, 0.2, -br.len * 0.45);
      const l = this.berthLocal(br, b.pos.x, b.pos.z);
      const hErr = Math.abs(wrapAngle(p.heading - br.heading));
      const align = br.type === 'side' ? Math.min(hErr, Math.PI - hErr) : hErr;
      const inside = Math.abs(l.u) < br.width / 2 - b.def.beam * 0.25 && Math.abs(l.v) < br.len / 2 - b.def.length * 0.3 + 1.5;
      const slow = t.speedKn < 1;
      this.dockInfo = { inside, align: align * 57.3, slow, dist: Math.hypot(l.u, l.v), impact: this.approachImpact };
      if (inside && slow && align < 0.45 && this.approachImpact < 1.6) {
        this.dockTimer += dt;
        if (this.dockTimer > 1.5) {
          const time = this.game.time - this.dockStart;
          const score = 100 - this.approachImpact * 28 - Math.max(0, time - 45) * 0.3 - align * 40 - Math.abs(l.u) * 3;
          this.dock(br, clamp(score, 5, 100));
        }
      } else this.dockTimer = 0;
    }
    if (this.docked) this.updateRopes(dt);
    // beaching: hull on the sand at crawl speed
    this.beached = t.grounded >= 2 && t.speed < 1.2;
    // grounding damage on arrival
    for (const e of p.events) {
      if (e.type === 'ground') {
        const dmg = groundingDamage(e.a);
        if (dmg > 0) { this.applyDamage(dmg, { x: e.x, y: e.y, z: e.z, nx: 0, nz: 0 }); this.game.events.push({ type: 'impact', speed: e.a, x: e.x, y: e.y, z: e.z, nx: 0, nz: 0, dmg, kind: 'ground' }); }
      }
    }
    // flooding: a holed hull takes on water; at zero integrity she sinks
    if (p.integrity < 0.3 && !this.sinking) {
      const leak = (0.3 - p.integrity) * 0.004;
      p.integrity = Math.max(0, p.integrity - leak * dt);
      p.buoyancyScale = 0.75 + p.integrity * 0.8;
      if (!this.leakWarned) { this.leakWarned = true; this.game.ui.toast('Taking on water! Get to a fuel dock for repairs (T for a tow)', 6); }
    }
    if (p.integrity <= 0 && !this.sinking) {
      this.sinking = 0.001;
      p.engineOn = false;
      this.game.audio.sinking();
      this.game.ui.toast(`${b.def.name} is sinking!`, 6);
      bus.emit('sinking', {});
    }
    if (this.sinking) {
      this.sinking += dt;
      p.buoyancyScale = Math.max(0.05, 0.75 - this.sinking * 0.05);
      if (this.sinking > 16) this.rescue('sank');
    }
    // fuel
    if (p.fuel < 0.12 && !this.fuelWarned) { this.fuelWarned = true; this.game.ui.toast('Fuel low — refuel at any marina fuel dock'); }
    if (p.fuel > 0.2) this.fuelWarned = false;
    void input;
  }

  repairAndRefuel() {
    const b = this.boat;
    b.phys.integrity = 1;
    b.phys.fuel = 1;
    b.phys.buoyancyScale = 1;
    b.damage.clear();
    this.leakWarned = false;
    const st = this.game.save.boatState(b.id);
    st.integrity = 1; st.fuel = 1;
    this.game.audio.chime();
    this.game.ui.toast('Repaired and refuelled — good as new');
  }

  // TowBoatUS: fade out, tow to the nearest marina fuel dock, repair (insurance)
  rescue(reason) {
    if (this.rescuing) return;
    this.rescuing = true;
    this.game.ui.fade(1.2, () => {
      const b = this.boat;
      const fuel = this.game.nearestFuelDock(b.pos.x, b.pos.z);
      this.sinking = 0;
      b.phys.buoyancyScale = 1;
      b.phys.integrity = reason === 'sank' ? 0.6 : Math.max(b.phys.integrity, 0.5);
      b.phys.fuel = Math.max(b.phys.fuel, 0.4);
      b.damage.clear();
      if (this.anchor) { this.anchor = null; b.phys.anchor = null; this.chain.visible = false; }
      b.place(fuel.x, fuel.z, fuel.heading);
      this.dock(fuel, 50);
      this.game.player.takeHelm(b);
      this.game.logbook.rescue();
      this.game.ui.toast(reason === 'sank' ? 'TowBoatUS raised and towed her in. Repairs are covered — chill.' : 'TowBoatUS towed you to the fuel dock', 6);
      this.rescuing = false;
    });
  }

  // contextual actions shown in the HUD menu
  menuOptions() {
    const b = this.boat;
    const opts = [];
    if (!b) return opts;
    if (this.docked) {
      opts.push({ id: 'disembark', label: 'Disembark (walk)' });
      if (this.docked.marina && this.game.canSwitchBoatsAt(this.docked)) opts.push({ id: 'switch', label: 'Switch boats' });
      if (this.docked.fuel || this.docked.home) opts.push({ id: 'repair', label: 'Repair & refuel' });
      opts.push({ id: 'invite', label: this.game.passengers.count ? 'Drop off guests' : 'Pick up passengers' });
      opts.push({ id: 'castoff', label: 'Cast off' });
    } else if (this.anchor || this.beached) {
      opts.push({ id: 'hangout', label: this.hangout ? 'End hangout' : 'Hang out (orbit camera)' });
      if (this.game.nearSocialSpot()) opts.push({ id: 'invite', label: this.game.passengers.count ? 'Drop off guests' : 'Invite friends aboard' });
      if (this.anchor) opts.push({ id: 'anchor', label: 'Raise anchor' });
    }
    return opts;
  }
}

