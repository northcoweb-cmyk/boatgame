// Guests aboard: the attached seated women scans and rigged men take the boat's
// measured seat transforms (scaled to the real boat). They add mass, look
// around, lean into turns, grip on hard manoeuvres, raise an arm when you hit
// a wake, pump a fist when the dinghy jumps, and wade beside the boat at
// sandbar hangouts.
import * as THREE from 'three';
import { Character } from '../characters/rig.js';
import { clamp } from '../core/math.js';
import { bus } from '../core/events.js';

const GUEST_MASS = 72;

export class Passengers {
  constructor(game) {
    this.game = game;
    this.guests = [];
    this.wading = false;
    bus.on('slam', (e) => this.react('shield', e));
    bus.on('landing', (e) => { if (e.air > 0.35) this.react('fist', e); });
  }

  get count() { return this.guests.length; }

  invite(boat, fromPoint) {
    const free = boat.seats.filter((s) => !s.taken);
    const n = Math.min(free.length, 4);
    if (!n) { this.game.ui.toast('No free seats'); return; }
    for (let i = 0; i < n; i++) {
      const seat = free[i];
      const k = this.guests.length + i;
      let g;
      const useWoman = k % 2 === 0;
      if (useWoman) {
        const name = k % 4 === 0 ? 'womanSeatedA' : 'womanSeatedB';
        const obj = this.game.assets.cloneModel(name, { cloneMaterials: false });
        g = { kind: 'woman', obj, seat, lean: 0 };
      } else {
        const ch = new Character(100 + k * 13);
        ch.pose = seat.pose === 'sit' ? 'sit' : 'sitFloor';
        g = { kind: 'man', ch, obj: ch.object, seat, lean: 0 };
      }
      seat.taken = g;
      g.hop = 1.1 + i * 0.35;
      g.from = (fromPoint || boat.root.position).clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2));
      boat.root.add(g.obj);
      this.guests.push(g);
    }
    boat.phys.setPassengerMass(this.guests.length * GUEST_MASS);
    this.game.logbook.guests(n);
    this.game.audio.whoop();
    this.game.ui.toast(`${n} friend${n > 1 ? 's' : ''} aboard — handling is a touch heavier`);
  }

  dropOff(boat) {
    for (const g of this.guests) { boat.root.remove(g.obj); g.seat.taken = null; }
    this.guests = [];
    boat.phys.setPassengerMass(0);
    this.game.ui.toast('Guests dropped off');
  }

  // move guests when switching boats (they don't follow)
  clear(boat) { if (this.guests.length) this.dropOff(boat); }

  react(action, e) {
    for (const g of this.guests) {
      if (g.kind === 'man') g.ch.setAction(action, action === 'fist' ? 1.2 : 0.9);
      else g.bounce = 0.4;
    }
    if ((action === 'fist' || (action === 'shield' && e && e.v > 3)) && this.guests.length) this.game.audio.whoop();
  }

  update(dt, boat, hangout) {
    if (!boat || !this.guests.length) return;
    const t = boat.phys.t;
    const lat = clamp(-t.latAccel / 16, -0.25, 0.25);
    const hard = Math.abs(t.latAccel) > 3.2;
    const wantWade = hangout && t.waterDepth < 1.3;
    for (const [i, g] of this.guests.entries()) {
      const seat = g.seat;
      let pos = seat.pos, face = seat.face;
      if (wantWade) {
        // stand in the water beside the boat
        const side = i % 2 ? 1 : -1;
        pos = new THREE.Vector3(side * (boat.def.beam * 0.5 + 1.3 + (i >> 1) * 0.9), -boat.com.y + boat.hull.keel - 0.1, seat.pos.z);
        face = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      }
      g.lean += (lat - g.lean) * Math.min(1, dt * 1.5);
      if (g.hop > 0) {
        // hop-on animation from the dock into the seat
        g.hop -= dt;
        const k = clamp(1 - g.hop / 1.1, 0, 1);
        const inv = new THREE.Matrix4().copy(boat.root.matrixWorld).invert();
        const from = g.from.clone().applyMatrix4(inv);
        g.obj.position.lerpVectors(from, pos, k);
        g.obj.position.y += Math.sin(k * Math.PI) * 0.6;
        if (g.kind === 'man') g.ch.setAction('hop', 0.4);
      } else {
        g.obj.position.copy(pos);
      }
      if (g.kind === 'man' && !wantWade && seat.pose === 'sit' && g.hop <= 0) g.obj.position.y -= 0.86;
      g.obj.rotation.set(0, face + Math.PI + Math.sin(this.game.time * 0.3 + i) * 0.06, g.kind === 'woman' ? g.lean * 0.12 : 0);
      if (g.bounce) { g.bounce = Math.max(0, g.bounce - dt); g.obj.position.y += Math.sin(g.bounce * 20) * g.bounce * 0.06; }
      if (g.kind === 'man') {
        g.ch.pose = wantWade ? 'stand' : (seat.pose === 'sit' ? 'sit' : 'sitFloor');
        g.ch.speed = 0;
        if (hard && !g.ch.action) g.ch.setAction('grip', 0.8);
        g.ch.lookYaw = Math.sin(this.game.time * 0.2 + i * 2) * 0.8;
        g.ch.update(dt, { lean: g.lean, wade: wantWade });
      }
    }
  }
}
