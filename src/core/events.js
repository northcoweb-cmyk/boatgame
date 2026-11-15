// Tiny synchronous event bus used to decouple gameplay from audio/FFB/camera/UI.
export class Events {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, []);
    this.map.get(name).push(fn);
    return () => this.off(name, fn);
  }
  off(name, fn) {
    const list = this.map.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  emit(name, payload) {
    const list = this.map.get(name);
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](payload);
  }
}
export const bus = new Events();
