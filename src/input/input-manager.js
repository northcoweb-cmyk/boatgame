// Unifies keyboard/mouse, standard gamepads (Xbox / PlayStation) and steering
// wheels. All three live simultaneously; the most recently used one drives the
// UI hints. Gamepad state is polled every frame (navigator.getGamepads()).
import { Keyboard, KEY_ACTIONS } from './keyboard.js';
import { WheelInput, isWheel } from './wheel.js';

const PAD_ACTIONS = { 0: 'engine', 1: 'anchor', 2: 'horn', 3: 'dock', 4: 'camPrev', 5: 'camNext', 8: 'pause', 9: 'map', 10: 'leaveHelm', 11: 'inventory', 12: 'hat_up', 13: 'hat_down', 14: 'hat_left', 15: 'hat_right' };

export class InputManager {
  constructor(save) {
    this.save = save;
    this.kb = new Keyboard();
    this.wheel = new WheelInput(save);
    this.device = 'keyboard';
    this.padIndex = -1;
    this.wheelIndex = -1;
    this.prevPad = [];
    this.actions = new Set();   // actions pressed this frame
    this.held = new Set();
    this.holdTimers = {};
    this.state = { steer: 0, throttle: 0, reverse: 0, thruster: 0, moveX: 0, moveY: 0, lookX: 0, lookY: 0, run: false, fire: false, aim: false, firePressed: false };
    this.onWheelConnected = null;
    window.addEventListener('gamepadconnected', (e) => this.onConnect(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.wheelIndex) this.wheelIndex = -1;
      if (e.gamepad.index === this.padIndex) this.padIndex = -1;
    });
  }

  onConnect(gp) {
    if (isWheel(gp)) {
      this.wheelIndex = gp.index;
      this.wheel.attach(gp);
      if (this.onWheelConnected) this.onWheelConnected(gp, this.wheel.needsCalibration);
    } else if (gp.mapping === 'standard' || gp.buttons.length >= 10) {
      this.padIndex = gp.index;
      this.prevPad = gp.buttons.map((b) => b.pressed);
    }
  }

  getPads() {
    try { return navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { return []; }
  }

  update(dt, ctx) {
    const s = this.state;
    this.actions.clear();
    const settings = this.save.data.settings;
    const pads = this.getPads();
    // detect devices that connected before the page listened
    for (const gp of pads) if (gp && gp.index !== this.wheelIndex && gp.index !== this.padIndex) this.onConnect(gp);

    // ---------------- keyboard
    const kb = this.kb;
    kb.updateAnalog(dt, ctx.speedK || 0);
    for (const p of kb.pressed) {
      let a = KEY_ACTIONS[p.code];
      if (!a) continue;
      if (p.shift && a === 'camNext') a = 'camPrev';
      if (p.shift && a === 'radioNext') a = 'radioPrev';
      this.actions.add(a);
      this.device = 'keyboard';
    }
    if (kb.down.has('KeyE')) this.held.add('engine'); else this.held.delete('engine');
    const kbMoveX = (kb.has('KeyD', 'ArrowRight') ? 1 : 0) - (kb.has('KeyA', 'ArrowLeft') ? 1 : 0);
    const kbMoveY = (kb.has('KeyW', 'ArrowUp') ? 1 : 0) - (kb.has('KeyS', 'ArrowDown') ? 1 : 0);
    let steer = kb.steer, throttle = kb.throttle, reverse = kb.reverse, thruster = kb.thruster;
    let moveX = kbMoveX, moveY = kbMoveY, lookX = kb.mouse.dx * 0.0025, lookY = kb.mouse.dy * 0.0025;
    let run = kb.has('ShiftLeft', 'ShiftRight');
    let fire = kb.mouse.left, aim = kb.mouse.right, firePressed = kb.mouse.leftPressed;
    if (kb.mouse.wheel) this.actions.add(kb.mouse.wheel > 0 ? 'mapZoomOut' : 'mapZoomIn');
    if (kb.active) { kb.active = false; this.device = 'keyboard'; }

    // ---------------- standard gamepad
    const gp = this.padIndex >= 0 ? pads[this.padIndex] : null;
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0), rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
      const rt = gp.buttons[7] ? gp.buttons[7].value : 0, lt = gp.buttons[6] ? gp.buttons[6].value : 0;
      let used = Math.abs(lx) + Math.abs(ly) + Math.abs(rx) + rt + lt > 0.1;
      for (let i = 0; i < gp.buttons.length; i++) {
        const p = gp.buttons[i].pressed;
        if (p && !this.prevPad[i]) { used = true; const a = PAD_ACTIONS[i]; if (a) this.actions.add(a); this.actions.add('pad' + i); }
        this.prevPad[i] = p;
      }
      if (gp.buttons[0] && gp.buttons[0].pressed) this.held.add('engine');
      if (used) this.device = 'gamepad';
      if (this.device === 'gamepad') {
        steer = lx; throttle = rt; reverse = lt; thruster = rx;
        moveX = lx; moveY = -ly; lookX = rx * dt * 2.6; lookY = ry * dt * 2.0;
        run = gp.buttons[10] ? gp.buttons[10].pressed : false;
        fire = rt > 0.5; aim = lt > 0.5; firePressed = rt > 0.5 && !this.prevRT;
        this.prevRT = rt > 0.5;
      }
    }

    // ---------------- wheel
    const wgp = this.wheelIndex >= 0 ? pads[this.wheelIndex] : null;
    if (wgp && !ctx.calibrating) {
      this.wheel.poll(wgp, settings, dt);
      for (const a of this.wheel.pressed) this.actions.add(a);
      if (this.wheel.active) { this.wheel.active = false; this.device = 'wheel'; }
      if (this.wheel.buttonsHeld && this.wheel.buttonsHeld[this.wheel.buttonMap.engine]) this.held.add('engine');
      if (this.device === 'wheel') {
        steer = this.wheel.steer; throttle = this.wheel.throttle; reverse = this.wheel.brake;
        // clutch = bow thruster power; steering direction chooses the side
        thruster = this.wheel.clutch > 0.05 ? this.wheel.clutch * Math.sign(this.wheel.rawSteer || 1) : 0;
      }
    }
    // d-pad actions (hat) are shared between pad and wheel
    if (this.actions.has('hat_up')) this.actions.add('mapZoomIn');
    if (this.actions.has('hat_down')) this.actions.add('mapZoomOut');
    if (this.actions.has('hat_left')) this.actions.add('radioPrev');
    if (this.actions.has('hat_right')) this.actions.add('radioNext');

    // hold-to-stop engine (1 s)
    if (this.held.has('engine')) {
      this.holdTimers.engine = (this.holdTimers.engine || 0) + dt;
      if (this.holdTimers.engine > 1 && !this.holdTimers.engineFired) { this.actions.add('engineHold'); this.holdTimers.engineFired = true; }
    } else { this.holdTimers.engine = 0; this.holdTimers.engineFired = false; }

    s.steer = steer; s.throttle = throttle; s.reverse = reverse; s.thruster = thruster;
    s.moveX = moveX; s.moveY = moveY; s.lookX = lookX; s.lookY = lookY; s.run = run;
    s.fire = fire; s.aim = aim; s.firePressed = firePressed;
    kb.endFrame();
  }

  has(a) { return this.actions.has(a); }
  consume(a) { const h = this.actions.has(a); this.actions.delete(a); return h; }

  // Human-readable binding for the current device (UI hints).
  hint(action) {
    const d = this.device;
    const K = { engine: 'E', anchor: 'Space', horn: 'H', dock: 'F', camNext: 'C', map: 'M', pause: 'Esc', interact: 'E', leaveHelm: 'G', inventory: 'Tab', confirm: 'Enter', invite: 'P', hangout: 'O', tow: 'T', fire: 'LMB', aim: 'RMB', reload: 'Q', throttle: 'W', reverse: 'S', steer: 'A/D', thruster: 'Z/X', menu: '1-6' };
    const P = { engine: 'A', anchor: 'B', horn: 'X', dock: 'Y', camNext: 'RB', map: 'Menu', pause: 'View', interact: 'A', leaveHelm: 'LS', inventory: 'RS', confirm: 'A', invite: 'D-pad ↑', hangout: 'D-pad ↓', tow: 'Y', fire: 'RT', aim: 'LT', reload: 'X', throttle: 'RT', reverse: 'LT', steer: 'L-stick', thruster: 'R-stick', menu: 'D-pad + A' };
    const W = { engine: 'A', anchor: 'B', horn: 'X', dock: 'Y', camNext: 'Paddle', map: 'Menu', pause: 'View', interact: 'A', leaveHelm: 'Xbox', inventory: 'Menu', confirm: 'A', invite: 'D-pad ↑', hangout: 'D-pad ↓', tow: 'Y', fire: '—', aim: '—', reload: 'X', throttle: 'Gas pedal', reverse: 'Brake pedal', steer: 'Wheel', thruster: 'Clutch', menu: 'D-pad + A' };
    return (d === 'wheel' ? W : d === 'gamepad' ? P : K)[action] || action;
  }
}
