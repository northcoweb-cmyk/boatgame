// You. Walk with WASD (or the left stick) around your backyard, the docks, the
// beach club, villas and sandbars; step aboard, take the helm (E / A) and drive
// with keyboard, gamepad or the G920; leave the helm (G / Xbox button) to walk
// the deck or step off onto a dock. Inventory (Tab) holds the 9mm pistol
// (target practice — the safety engages whenever a person is in the sights),
// the phone (call TowBoatUS) and binoculars.
import * as THREE from 'three';
import { Character } from '../characters/rig.js';
import { clamp, damp, wrapAngle } from '../core/math.js';
import { heightAt } from '../world/geography.js';
import { bus } from '../core/events.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _ray = new THREE.Raycaster();

export class Player {
  constructor(game) {
    this.game = game;
    this.char = new Character(42);
    this.char.object.name = 'player';
    game.scene.add(this.char.object);
    this.mode = 'foot';           // 'foot' | 'helm'
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.speed = 0;
    this.onBoat = null;           // boat whose deck we stand on
    this.local = new THREE.Vector3(); // deck-local position when onBoat
    this.headPos = new THREE.Vector3();
    this.inventory = [
      { id: 'pistol', name: '9mm Pistol', desc: 'Target practice. Safety engages when a person is in the sights.', ammo: 15, mag: 15, reserve: 60 },
      { id: 'phone', name: 'Phone', desc: 'Call TowBoatUS for a tow to the nearest marina.' },
      { id: 'binoculars', name: 'Binoculars', desc: 'Hold aim to zoom on the skyline.' },
    ];
    this.equipped = null;
    this.reloadT = 0;
    this.fireCd = 0;
    this.flashT = 0;
    this.safety = false;
    // pistol model in the right hand
    this.pistol = game.assets.cloneModel('pistol', { cloneMaterials: false });
    this.pistol.visible = false;
    this.pistol.rotation.set(0, Math.PI / 2, 0);
    this.char.bones.rHand.add(this.pistol);
    this.pistol.position.set(-0.02, -0.08, 0.06);
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd28a }));
    this.flash.visible = false;
    this.pistol.add(this.flash);
    this.flash.position.set(0, 0.03, -0.14);
    // first-person forearms for the helm camera
    this.fpArms = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xc89878, roughness: 0.7 });
    this.armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.38, 4, 8), skin);
    this.armR = this.armL.clone();
    this.fpArms.add(this.armL, this.armR);
    this.fpArms.visible = false;
    game.scene.add(this.fpArms);
    this.targets = [];
  }

  spawnAt(x, z, yaw) {
    this.mode = 'foot';
    this.onBoat = null;
    this.pos.set(x, this.game.groundHeightAt(x, z), z);
    this.yaw = yaw;
    this.game.cams.footYaw = yaw + Math.PI;
  }

  // --------------------------------------------------------------- boarding
  deckHeightLocal(boat) { return boat.hull.keel + (boat.hull.gunwale - boat.hull.keel) * 0.42 - boat.com.y; }
  onDeck(boat, local) {
    const h = boat.hull;
    const z = local.z + boat.com.z;
    return z > h.bow + h.length * 0.12 && z < h.transom + 0.3 && Math.abs(local.x) < h.beam * 0.42;
  }

  takeHelm(boat) {
    if (this.game.boat !== boat) this.game.setActiveBoat(boat);
    this.mode = 'helm';
    this.onBoat = boat;
    this.equip(null);
    this.game.setActiveBoat(boat);
    bus.emit('helm', { on: true });
  }

  leaveHelm() {
    const boat = this.game.boat;
    if (!boat) return;
    this.mode = 'foot';
    this.onBoat = boat;
    this.local.copy(boat.helmPos).add(_v.set(boat.def.helm.v < 0 ? 0.7 : -0.7, 0, 0.6));
    this.local.y = this.deckHeightLocal(boat);
    bus.emit('helm', { on: false });
  }

  equip(id) {
    this.equipped = id;
    this.pistol.visible = id === 'pistol';
  }

  // --------------------------------------------------------------- per frame
  update(dt, input, game) {
    const ch = this.char;
    this.fireCd -= dt; this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    if (this.mode === 'helm') return this.updateHelm(dt, input, game);
    this.fpArms.visible = false;
    const s = input.state;
    const camYaw = game.cams.footYaw;
    let mx = s.moveX, my = s.moveY;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const run = s.run ? 1.85 : 1;
    const wantSpeed = Math.min(1, len) * 1.6 * run;
    this.speed = damp(this.speed, wantSpeed, 10, dt);
    const dirX = -Math.sin(camYaw) * my + Math.cos(camYaw) * mx;
    const dirZ = -Math.cos(camYaw) * my - Math.sin(camYaw) * mx;
    if (len > 0.05) this.yaw = Math.atan2(dirX, dirZ) ;
    const aiming = s.aim && this.equipped;
    if (aiming) this.yaw = camYaw + Math.PI;

    if (this.onBoat) {
      // move in the boat's frame (decks move with the boat)
      const boat = this.onBoat;
      boat.root.updateMatrixWorld();
      const bq = boat.root.quaternion;
      const bYaw = new THREE.Euler().setFromQuaternion(bq, 'YXZ').y;
      const ldx = Math.cos(-bYaw) * dirX - Math.sin(-bYaw) * dirZ, ldz = Math.sin(-bYaw) * dirX + Math.cos(-bYaw) * dirZ;
      const nx = this.local.x + ldx * this.speed * dt, nz = this.local.z + ldz * this.speed * dt;
      _v.set(nx, this.deckHeightLocal(boat), nz);
      if (this.onDeck(boat, _v)) this.local.copy(_v);
      else {
        // stepping off: is there a dock / land within reach?
        _v2.copy(_v).applyMatrix4(boat.root.matrixWorld);
        const g = game.walkSurface(_v2.x, _v2.z);
        if (g !== null && Math.abs(g - _v2.y) < 1.6 && boat.phys.t.speed < 1.2) {
          this.onBoat = null; this.pos.set(_v2.x, g, _v2.z);
        }
      }
      this.pos.copy(this.local).applyMatrix4(boat.root.matrixWorld);
      ch.object.position.copy(this.pos);
      ch.object.rotation.set(0, this.yaw, 0);
      // helm prompt
      const dh = this.local.distanceTo(_v.copy(boat.helmPos).setY(this.local.y));
      game.ui.prompt(dh < 1.8 ? { key: input.hint('interact'), text: 'Take the helm' } : null, 'helm');
      if (dh < 1.8 && input.consume('engine')) this.takeHelm(boat);
    } else {
      const nx = this.pos.x + dirX * this.speed * dt, nz = this.pos.z + dirZ * this.speed * dt;
      const g = game.walkSurface(nx, nz);
      let moved = false;
      if (g !== null && g - this.pos.y < 0.9 && !game.blockedOnFoot(nx, nz)) { this.pos.set(nx, g, nz); moved = true; }
      if (!moved) this.speed *= 0.5;
      // one-button boarding: E / A near any of your boats puts you at the helm
      let near = null, nd = 1e9;
      for (const b of game.boardableBoats()) {
        const d = Math.hypot(b.root.position.x - this.pos.x, b.root.position.z - this.pos.z) - b.def.length * 0.5;
        if (d < 7 && d < nd && b.phys.t.speed < 1.2) { nd = d; near = b; }
      }
      if (near) {
        game.ui.prompt({ key: input.hint('interact'), text: `Board ${near.def.name}` }, 'board');
        if (input.consume('engine')) { this.takeHelm(near); game.cams.setMode(game.lastBoatCam || 'chase'); bus.emit('board', { boat: near }); return; }
      }
      // or simply walk onto the deck
      for (const b of game.boardableBoats()) {
        b.root.updateMatrixWorld();
        _inv.copy(b.root.matrixWorld).invert();
        _v.set(nx, this.pos.y, nz).applyMatrix4(_inv);
        const near = this.onDeck(b, _v.clone().setY(0));
        if (near && b.phys.t.speed < 1.2) {
          this.onBoat = b;
          this.local.set(_v.x, this.deckHeightLocal(b), _v.z);
          if (b !== game.boat) game.setActiveBoat(b);
          bus.emit('board', { boat: b });
          break;
        }
      }
      const depth = -heightAt(this.pos.x, this.pos.z);
      this.wading = depth > 0.1;
      ch.object.position.copy(this.pos);
      ch.object.rotation.set(0, this.yaw, 0);
    }
    ch.pose = 'walk';
    ch.speed = this.speed * (this.wading ? 0.6 : 1);
    ch.update(dt, { wade: this.wading });
    // aiming pose for the pistol / binoculars
    if (this.equipped && s.aim) {
      ch.bones.rUpperArm.rotation.set(-1.45 - game.cams.footPitch * 0.9, 0.15, 0.1);
      ch.bones.rForeArm.rotation.set(0, 0, 0);
      if (this.equipped === 'binoculars') ch.bones.lUpperArm.rotation.set(-1.45, -0.2, -0.1);
    }
    this.headPos.copy(this.pos).add(_v.set(0, 1.66, 0));
    ch.object.visible = !(game.cams.mode === 'foot' && game.cams.firstPerson);
    this.updateWeapon(dt, input, game);
  }

  updateHelm(dt, input, game) {
    const boat = this.onBoat || game.boat;
    if (!boat) { this.mode = 'foot'; return; }
    const ch = this.char;
    // driver posed at the wheel, parented visually to the boat transform
    boat.root.updateMatrixWorld();
    const standing = boat.def.helm.pose === 'stand';
    this.local.copy(boat.helmPos);
    if (!standing) this.local.y -= 0.42;
    this.pos.copy(this.local).applyMatrix4(boat.root.matrixWorld);
    ch.object.position.copy(this.pos);
    ch.object.quaternion.copy(boat.root.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(_v.set(0, 1, 0), Math.PI));
    ch.pose = standing ? 'standDrive' : 'drive';
    ch.update(dt, { steer: -boat.phys.rudder / boat.def.rudder.maxAngle, lean: clamp(-boat.phys.t.latAccel / 9, -0.6, 0.6) });
    const helmCam = game.cams.mode === 'helm';
    ch.object.visible = !helmCam;
    // first-person forearms: from just below/beside the camera to grips on the wheel rim
    this.fpArms.visible = helmCam;
    if (helmCam) {
      boat.wheel.updateMatrixWorld();
      const cam = game.camera;
      const rimR = boat.def.model === 'yacht' ? 0.24 : 0.19;
      for (const [arm, side] of [[this.armL, -1], [this.armR, 1]]) {
        const grip = _v.set(side * rimR * 0.87, rimR * 0.5, 0).applyMatrix4(boat.wheel.matrixWorld);
        const sh = _v2.set(side * 0.2, -0.42, 0.05).applyMatrix4(cam.matrixWorld);
        const len = grip.distanceTo(sh);
        arm.scale.set(1, len / 0.46, 1);
        arm.position.copy(sh).lerp(grip, 0.5);
        arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), grip.clone().sub(sh).normalize());
      }
    }
    this.headPos.copy(this.pos).add(_v.set(0, 1.6, 0));
    if (input.consume('leaveHelm')) {
      if (boat.phys.t.speed > 1.5) game.ui.toast('Slow down before leaving the helm');
      else this.leaveHelm();
    }
  }

  // --------------------------------------------------------------- weapon
  updateWeapon(dt, input, game) {
    const s = input.state;
    const item = this.inventory.find((i) => i.id === 'pistol');
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) { const n = Math.min(item.mag - item.ammo, item.reserve); item.ammo += n; item.reserve -= n; }
    }
    if (input.consume('reload') && this.equipped === 'pistol' && item.ammo < item.mag && item.reserve > 0 && this.reloadT <= 0) { this.reloadT = 1.3; game.audio.reload(); }
    if (this.equipped !== 'pistol' || !s.aim) { this.safety = false; return; }
    // what's in the sights?
    const cam = game.camera;
    _ray.setFromCamera({ x: 0, y: 0 }, cam);
    _ray.far = 400;
    this.safety = game.personInSights(_ray.ray);
    if (s.firePressed && this.fireCd <= 0 && this.reloadT <= 0) {
      if (this.safety) { game.audio.dryFire(); game.ui.toast('Safety on — never point at people'); return; }
      if (item.ammo <= 0) { game.audio.dryFire(); if (item.reserve > 0) { this.reloadT = 1.3; game.audio.reload(); } return; }
      item.ammo--; this.fireCd = 0.18; this.flashT = 0.05;
      game.audio.gunshot();
      game.cams.footPitch += 0.03;
      game.cams.shake(0.25);
      game.shoot(_ray.ray);
    }
  }
}

export { wrapAngle };
