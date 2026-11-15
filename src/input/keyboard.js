// Keyboard + mouse. Throttle and steering ramp like analog pedals (not on/off),
// steering auto-centres and is slower at speed.
export const KEY_ACTIONS = {
  KeyE: 'engine', Space: 'anchor', KeyH: 'horn', KeyF: 'dock', KeyC: 'camNext', KeyM: 'map', Escape: 'pause',
  KeyR: 'radioNext', Equal: 'mapZoomIn', NumpadAdd: 'mapZoomIn', Minus: 'mapZoomOut', NumpadSubtract: 'mapZoomOut',
  KeyG: 'leaveHelm', Tab: 'inventory', KeyI: 'details', F1: 'help', Digit1: 'menu1', Digit2: 'menu2', Digit3: 'menu3', Digit4: 'menu4', Digit5: 'menu5', Digit6: 'menu6',
  Enter: 'confirm', KeyQ: 'reload', KeyP: 'invite', KeyO: 'hangout', KeyT: 'tow', KeyV: 'camPrev', ArrowUp: 'menuUp', ArrowDown: 'menuDown',
};

export class Keyboard {
  constructor(target = window) {
    this.down = new Set();
    this.pressed = [];
    this.released = [];
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, wheel: 0 };
    this.active = false;
    this.throttle = 0; this.reverse = 0; this.steer = 0; this.thruster = 0;
    const onDown = (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (['Tab', 'F1', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.push({ code: e.code, shift: e.shiftKey });
      this.down.add(e.code);
      this.active = true;
    };
    const onUp = (e) => { this.down.delete(e.code); this.released.push(e.code); };
    target.addEventListener('keydown', onDown);
    target.addEventListener('keyup', onUp);
    window.addEventListener('blur', () => this.down.clear());
    window.addEventListener('mousemove', (e) => { if (document.pointerLockElement) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; } });
    window.addEventListener('mousedown', (e) => { if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; } if (e.button === 2) this.mouse.right = true; this.active = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.left = false; if (e.button === 2) this.mouse.right = false; });
    window.addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  has(...codes) { return codes.some((c) => this.down.has(c)); }

  // Analog-ish helm & throttle; speedK 0..1 slows steering at speed.
  updateAnalog(dt, speedK) {
    const fwd = this.has('KeyW', 'ArrowUp'), back = this.has('KeyS', 'ArrowDown');
    const left = this.has('KeyA', 'ArrowLeft'), right = this.has('KeyD', 'ArrowRight');
    const ramp = (v, on, up, down) => (on ? Math.min(1, v + up * dt) : Math.max(0, v - down * dt));
    this.throttle = ramp(this.throttle, fwd, 1.1, 1.8);
    this.reverse = ramp(this.reverse, back, 1.1, 2.2);
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    const rate = target !== 0 ? 2.4 - speedK * 1.3 : 2.8;
    if (target === 0) this.steer -= Math.sign(this.steer) * Math.min(Math.abs(this.steer), rate * dt);
    else this.steer += Math.max(-rate * dt, Math.min(rate * dt, target - this.steer));
    this.thruster = (this.has('KeyX') ? 1 : 0) - (this.has('KeyZ') ? 1 : 0);
  }

  endFrame() {
    this.pressed.length = 0; this.released.length = 0;
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.leftPressed = false; this.mouse.wheel = 0;
  }
}
