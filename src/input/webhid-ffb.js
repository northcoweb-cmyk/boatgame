// Layer 1 force feedback: talk to the wheel base directly over WebHID.
//  * Logitech G920 / G923 (Xbox) use HID++ 2.0 feature 0x8123 (Force Feedback):
//    we discover the feature index, reset the built-in autocentre and stream a
//    single constant-force effect that carries every force we compute.
//  * Other wheels: generic USB HID PID (usage page 0x0F) — Set Effect /
//    Set Constant Force / Effect Operation reports packed from the device's own
//    report descriptor items.
// Every call is wrapped; on any failure the manager falls back to Layer 2/3.
const LOGITECH = 0x046d;

export class WebHidFFB {
  constructor() {
    this.device = null;
    this.mode = null;          // 'hidpp' | 'pid'
    this.ready = false;
    this.ffIndex = -1;
    this.slot = -1;
    this.pending = new Map();
    this.lastSend = 0;
    this.error = null;
  }

  static supported() { return typeof navigator !== 'undefined' && 'hid' in navigator; }

  async request() {
    if (!WebHidFFB.supported()) throw new Error('WebHID not available in this browser');
    const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: LOGITECH }, { usagePage: 0x0f }] });
    if (!devices.length) throw new Error('No device selected');
    await this.open(devices[0]);
    return this.device.productName;
  }

  async tryReconnect() {
    if (!WebHidFFB.supported()) return false;
    try {
      const devs = await navigator.hid.getDevices();
      const d = devs.find((x) => x.vendorId === LOGITECH || x.collections.some((c) => c.usagePage === 0x0f));
      if (d) { await this.open(d); return true; }
    } catch (e) { this.error = e; }
    return false;
  }

  async open(dev) {
    if (!dev.opened) await dev.open();
    this.device = dev;
    dev.addEventListener('inputreport', (e) => this.onInput(e));
    const hasHidpp = dev.collections.some((c) => (c.outputReports || []).some((r) => r.reportId === 0x11)) || dev.vendorId === LOGITECH;
    if (hasHidpp) {
      try {
        this.ffIndex = await this.getFeatureIndex(0x8123);
        if (this.ffIndex > 0) {
          await this.hidpp(this.ffIndex, 0x11, []);            // reset all (kills built-in autocentre spring)
          this.slot = await this.download(0, 0, true);        // constant force, autostart
          this.mode = 'hidpp';
          this.ready = true;
          return;
        }
      } catch (e) { this.error = e; }
    }
    this.setupPid();
  }

  onInput(e) {
    if (e.reportId !== 0x11 && e.reportId !== 0x10) return;
    const d = new Uint8Array(e.data.buffer);
    const key = d[1] + ':' + (d[2] & 0xf0);
    const p = this.pending.get(key);
    if (p) { this.pending.delete(key); p(d); }
  }

  hidpp(featureIndex, fn, params, wait = true) {
    const data = new Uint8Array(19);
    data[0] = 0xff; data[1] = featureIndex; data[2] = fn;
    for (let i = 0; i < params.length && i < 16; i++) data[3 + i] = params[i];
    const p = wait ? new Promise((res, rej) => {
      this.pending.set(featureIndex + ':' + (fn & 0xf0), res);
      setTimeout(() => { if (this.pending.has(featureIndex + ':' + (fn & 0xf0))) { this.pending.delete(featureIndex + ':' + (fn & 0xf0)); rej(new Error('HID++ timeout')); } }, 400);
    }) : Promise.resolve(null);
    return this.device.sendReport(0x11, data).then(() => p);
  }

  async getFeatureIndex(featureId) {
    const r = await this.hidpp(0x00, 0x01, [featureId >> 8, featureId & 0xff]);
    return r ? r[3] : -1;
  }

  // download (create/update) a constant-force effect; force int16
  async download(slot, force, wait) {
    const f = Math.max(-32767, Math.min(32767, Math.round(force))) & 0xffff;
    const params = [slot, 0x00 | 0x80, 0xff, 0xff, 0, 0, (f >> 8) & 0xff, f & 0xff, 0, 0, 0, 0, 0, 0];
    const r = await this.hidpp(this.ffIndex, 0x21, params, wait);
    return r ? r[3] : slot;
  }

  // ---------------------------------------------------------------- generic PID
  setupPid() {
    const dev = this.device;
    const find = (usage) => {
      for (const col of dev.collections) {
        const stack = [col];
        while (stack.length) {
          const c = stack.pop();
          if (c.usagePage === 0x0f && c.usage === usage) {
            const rep = (c.outputReports || [])[0];
            if (rep) return rep;
          }
          for (const ch of c.children || []) stack.push(ch);
          for (const rep of c.outputReports || []) if (rep.items.some((it) => it.usages && it.usages.some((u) => (u & 0xffff) === usage && (u >>> 16) === 0x0f))) return rep;
        }
      }
      return null;
    };
    this.pid = { setEffect: find(0x21), constant: find(0x73), op: find(0x77), control: find(0x96) };
    if (this.pid.setEffect && this.pid.constant && this.pid.op) {
      this.mode = 'pid';
      this.ready = true;
      this.sendPid(this.pid.control, { 0x97: 1 }).catch(() => {}); // enable actuators
      this.sendPid(this.pid.setEffect, { 0x22: 1, 0x25: 0x26, 0x50: 0xffff, 0x52: 0xff }).catch(() => {});
      this.sendPid(this.pid.op, { 0x22: 1, 0x78: 1, 0x7c: 0 }).catch(() => {});
    } else {
      this.error = new Error('Device has no usable force-feedback interface');
      this.ready = false;
    }
  }

  // Pack values into a report following its item layout (LSB first).
  sendPid(report, values) {
    if (!report) return Promise.resolve();
    let bits = 0;
    for (const it of report.items) bits += it.reportSize * it.reportCount;
    const buf = new Uint8Array(Math.ceil(bits / 8));
    let off = 0;
    for (const it of report.items) {
      for (let k = 0; k < it.reportCount; k++) {
        const usage = it.usages ? (it.usages[Math.min(k, it.usages.length - 1)] & 0xffff) : 0;
        let v = values[usage] ?? 0;
        if (it.logicalMinimum < 0 && v < 0) v = (1 << it.reportSize) + v;
        for (let b = 0; b < it.reportSize; b++) {
          if ((v >> b) & 1) buf[(off + b) >> 3] |= 1 << ((off + b) & 7);
        }
        off += it.reportSize;
      }
    }
    return this.device.sendReport(report.reportId, buf);
  }

  // force: -1..1 (positive = turn the wheel to the right)
  setForce(force) {
    if (!this.ready || !this.device) return;
    const now = performance.now();
    if (now - this.lastSend < 33) return; // ~30 Hz
    this.lastSend = now;
    try {
      if (this.mode === 'hidpp') {
        this.download(this.slot, -force * 32767, false).catch((e) => { this.error = e; this.ready = false; });
      } else if (this.mode === 'pid') {
        this.sendPid(this.pid.constant, { 0x22: 1, 0x70: Math.round(force * 10000) }).catch((e) => { this.error = e; this.ready = false; });
      }
    } catch (e) { this.error = e; this.ready = false; }
  }

  async stop() {
    try { if (this.ready) this.setForce(0); } catch (e) { this.error = e; }
  }
}
