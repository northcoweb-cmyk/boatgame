// Biscayne Drift — bootstrap + game loop. Wires the asset pipeline, renderer,
// water, world, boats, people, gameplay, input/FFB, audio, cameras and UI.
import * as THREE from 'three';
import { Assets } from './assets/assets.js';
import { Save } from './save/save.js';
import { detectPreset, resolveQuality, PRESETS } from './render/quality.js';
import { PostFX } from './render/post.js';
import { PlanarReflection, LAYER_NO_REFLECT } from './render/reflection.js';
import { DayCycle } from './sky/daycycle.js';
import { Sky } from './sky/sky.js';
import { WaveSpectrum, SEA_STATES, seaStateForTime } from './water/spectrum.js';
import { Ocean, makeDetailNormalTexture } from './water/ocean.js';
import { WakeSystem } from './water/wake.js';
import { loadMapData, heightAt, currentAt, DESTINATIONS, MARINAS } from './world/geography.js';
import { Terrain } from './world/terrain.js';
import { buildCity, cityUniforms } from './world/city.js';
import { Roads, extractCars } from './world/bridges.js';
import { Villas } from './world/villas.js';
import { Docks } from './world/marinas.js';
import { Destinations } from './world/destinations.js';
import { Vegetation } from './world/vegetation.js';
import { Props } from './world/props.js';
import { Wildlife } from './world/wildlife.js';
import { BoatTraffic } from './world/boat-traffic.js';
import { People } from './characters/people.js';
import { CollisionWorld, resolveBoatCollisions } from './physics/collision.js';
import { Boat } from './boats/boat.js';
import { BOAT_ORDER } from './boats/boat-defs.js';
import { Player } from './gameplay/player.js';
import { Seamanship } from './gameplay/seamanship.js';
import { Passengers } from './gameplay/passengers.js';
import { Logbook } from './gameplay/logbook.js';
import { InputManager } from './input/input-manager.js';
import { FFB } from './input/ffb.js';
import { AudioSystem } from './audio/audio.js';
import { CameraRig, BOAT_CAMS } from './camera/cameras.js';
import { HUD } from './ui/hud.js';
import { ChartMap } from './ui/map.js';
import { Menus } from './ui/menus.js';
import { bus } from './core/events.js';
import { clamp, smoothstep } from './core/math.js';
import { bakeToVertexColor } from './assets/assets.js';

const PHYS_DT = 1 / 240;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _imp = {};

class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.time = 0;
    this.paused = false;
    this.started = false;
    this.mixers = [];
    this.events = [];
    this.showFps = false;
    this.boat = null;
    this.ownedBoats = {};
    this.lastBoatCam = 'chase';
    this.data = {};
  }

  setLoad(f, text) {
    document.getElementById('load-fill').style.width = `${Math.round(f * 100)}%`;
    if (text) document.getElementById('load-text').textContent = text;
  }

  async init() {
    // ------------------------------------------------ renderer + quality
    this.save = new Save();
    const S = this.save.data.settings;
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.autoClear = true;
    const det = detectPreset(renderer);
    const params = new URLSearchParams(location.search);
    if (params.has('preset') && PRESETS[params.get('preset')]) S.preset = null, det.preset = params.get('preset');
    if (!S.preset) {
      S.preset = det.preset;
      const p = PRESETS[det.preset];
      Object.assign(S, { renderScale: p.renderScale, reflections: p.reflections, shadows: p.shadows, foliage: p.foliage, drawDistance: p.drawDistance, waterQuality: det.preset === 'ultra' ? 'ultra' : det.preset });
    }
    this.quality = resolveQuality(S, det.preset);
    this.quality.gpu = det.gpu;
    // ------------------------------------------------ scene
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(S.fov, innerWidth / innerHeight, 0.15, 22000);
    this.camera.layers.enable(LAYER_NO_REFLECT);
    this.scene.add(this.camera);
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = S.shadows;
    this.sun.shadow.mapSize.set(this.quality.shadowSize, this.quality.shadowSize);
    const sc = this.sun.shadow.camera;
    sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 900;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6a6050, 1.2);
    this.scene.add(this.hemi);
    this.scene.fog = new THREE.FogExp2(0xbcd2e6, 0.00012);
    this.day = new DayCycle();
    this.day.dayMinutes = S.dayMinutes;
    this.day.setHours(this.save.data.timeOfDay ?? 18.9);
    this.sky = new Sky(this.scene);
    this.waves = new WaveSpectrum(this.quality.waves);
    this.applySeaState(true);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = this.sky.mesh.clone();
    this.envScene.add(this.envSky);
    this.envT = 99;

    // ------------------------------------------------ assets
    this.setLoad(0.02, 'Loading your models…');
    this.assets = new Assets(renderer);
    const names = ['runabout', 'rib', 'bass', 'yacht', 'superyacht', 'towboat', 'man', 'woman', 'womanSeatedA', 'womanSeatedB', 'palm', 'dock', 'beachPack', 'ferris', 'vizcayne', 'skyscrapers', 'miami', 'villaSea', 'villaSmall', 'villaModern', 'shack', 'plane', 'pistol', 'cars', 'road', 'bridge', 'carFerrari', 'carF22', 'carM4', 'lighthouse'];
    const [sand, detailImg, lots, hero] = await Promise.all([
      this.assets.loadTexture('sand', 'assets/textures/sand.jpg'),
      new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'assets/textures/water-detail.jpg'; }),
      fetch('assets/map/lots.json').then((r) => r.json()),
      fetch('assets/map/hero-towers.json').then((r) => r.json()),
      loadMapData('assets/map/miami-sdf.png'),
      this.assets.loadAll(names, (f, n) => this.setLoad(0.02 + f * 0.48, `Loading models… ${n}`)),
    ]);
    this.data.lots = lots;
    this.data.heroTowers = hero;
    sand.repeat.set(1, 1);
    const detail = makeDetailNormalTexture(detailImg);

    // ------------------------------------------------ terrain + water
    this.terrain = new Terrain();
    await this.terrain.bake(this.quality.terrainRes, (f) => this.setLoad(0.5 + f * 0.12, 'Charting the bay from the Miami model…'));
    const tmesh = await this.terrain.buildMesh(this.quality.terrain, sand, (f) => this.setLoad(0.62 + f * 0.12, 'Shaping islands and sandbars…'));
    this.scene.add(tmesh);
    this.ocean = new Ocean({ spectrum: this.waves, terrainTex: this.terrain.texture, sandTex: sand, detailTex: detail, gridN: this.quality.grid });
    this.scene.add(this.ocean.mesh);
    this.reflection = new PlanarReflection(renderer);
    this.reflection.scale = this.quality.reflScale;
    this.reflection.enabled = S.reflections;
    this.post = new PostFX(renderer);
    this.post.setSamples(S.aa === 'msaa' ? this.quality.msaa : 0);
    this.post.bloomEnabled = S.bloom;
    this.wake = new WakeSystem(renderer, this.quality.preset);
    this.scene.add(this.wake.spray);
    this.ocean.uniforms.uWake.value = this.wake.texture;
    this.ocean.uniforms.uWakeRect.value = this.wake.rect;
    this.collisions = new CollisionWorld();

    // ------------------------------------------------ world
    this.setLoad(0.76, 'Raising the skyline…');
    await nextFrame();
    this.carTypes = extractCars(this.assets.models.cars);
    this.sportsCarTypes = ['carFerrari', 'carF22', 'carM4'].map((n) => { return bakeToVertexColor(this.assets.models[n]); });
    buildCity(this);
    this.roads = new Roads(this);
    this.villas = new Villas(this);
    this.setLoad(0.82, 'Building marinas and destinations…');
    await nextFrame();
    this.docks = new Docks(this);
    this.destinations = new Destinations(this, this.docks);
    this.docks.finalize();
    this.vegetation = new Vegetation(this, this.villas.palmSpots);
    this.props = new Props(this);
    this.wildlife = new Wildlife(this);
    this.setLoad(0.88, 'Launching boats…');
    await nextFrame();
    this.traffic = new BoatTraffic(this, this.quality.traffic);
    this.placeSuperyacht();
    this.makeTargets();

    // ------------------------------------------------ your boats
    for (const id of BOAT_ORDER) {
      const st = this.save.boatState(id);
      const b = new Boat(this, id, { player: true, paint: st.paint, trim: st.trim });
      b.phys.integrity = st.integrity ?? 1;
      b.phys.fuel = st.fuel ?? 1;
      this.scene.add(b.root);
      this.ownedBoats[id] = b;
    }
    // mooring: active boat at the home dock, the rest at Bayside
    const bay = this.docks.berths.filter((b) => b.marina === 'bayside' && !b.fuel);
    const side = bay.find((b) => b.type === 'side');
    const bows = bay.filter((b) => b.type === 'bow');
    const reserve = [side, bows[1], bows[3], bows[5]].filter(Boolean);
    this.mooring = {};
    let k = 0;
    for (const id of BOAT_ORDER) {
      if (id === 'isabel') this.mooring[id] = side;
      else this.mooring[id] = reserve.filter((r) => r !== side)[k++];
    }
    this.homeBerth = this.villas.home.dock.berth;
    this.homeBerth.home = true; this.homeBerth.marina = 'home';
    const villaBerths = this.villas.docks.filter((d) => !d.home).map((d) => Object.assign(d.berth, { villa: true }));
    this.docks.populateMoored([this.assets.models.runabout, this.assets.models.rib, this.assets.models.yacht], new Set(reserve), villaBerths);
    // people
    this.people = new People(this);
    const spots = this.destinations.npc;
    for (const s of this.docks.npcSpots) spots.stand.push({ x: s.x, y: s.y, z: s.z, face: s.face });
    // promenade walkers along the Bayside waterfront + marina piers + home street
    spots.walkers.push({ path: [[-2250, -1180], [-2250, -380]], phase: 0.1 }, { path: [[-2252, -1100], [-2252, -300]], phase: 0.6 }, { path: [[-2262, -980], [-2262, -420]], phase: 0.3 });
    for (const m of MARINAS) spots.walkers.push({ path: [[m.x + m.out[0] * 4.7 - m.along[0] * 80, m.z + m.out[1] * 4.7 - m.along[1] * 80], [m.x + m.out[0] * 4.7 + m.along[0] * 80, m.z + m.out[1] * 4.7 + m.along[1] * 80]], phase: 0.5 });
    this.people.populate(spots);

    // ------------------------------------------------ gameplay + io
    this.input = new InputManager(this.save);
    this.ffb = new FFB(S);
    this.audio = new AudioSystem(this.save);
    this.cams = new CameraRig(this.camera, this);
    this.player = new Player(this);
    this.sea = new Seamanship(this);
    this.passengers = new Passengers(this);
    this.ui = new HUD(this);
    this.ui.fade = (t, mid) => this.menus.fade(t, mid);
    this.logbook = new Logbook(this);
    this.map = new ChartMap(this);
    this.menus = new Menus(this);
    this.input.onWheelConnected = (gp, needs) => {
      this.ui.toast(`Wheel connected: ${gp.id.split('(')[0].trim()}`);
      if (needs && this.started) { this.pauseGame(true); this.menus.show('calibration'); }
      else if (needs) this.pendingCalib = true;
    };
    this.bindEvents();
    this.setActiveBoat(this.ownedBoats[this.save.data.boat] || this.ownedBoats.isabel, true);
    this.layoutBoats();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.pauseGame(true); this.audio.suspend(); this.save.persist(); } });
    window.addEventListener('beforeunload', () => this.persistState());
    this.canvas.addEventListener('click', () => { if (this.started && !this.paused && !this.chartOpen) this.canvas.requestPointerLock?.(); });
    this.setLoad(1, 'Ready');
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('title').classList.remove('hidden');
    document.getElementById('start-label').textContent = this.save.data.started ? 'Continue' : 'Click to start';
    this.cams.setMode('title');
    this.cams.blendT = 1;
    this.last = performance.now();
    this.frameCount = 0; this.fpsT = 0;
    requestAnimationFrame((t) => this.frame(t));
    window.__game = this;
    window.__THREE = THREE;
  }

  // ------------------------------------------------------------------ setup helpers
  placeSuperyacht() {
    let best = null;
    for (let r = 0; r < 600 && !best; r += 20) for (let a = 0; a < 6.28; a += 0.4) {
      const x = 1450 + Math.cos(a) * r, z = 650 + Math.sin(a) * r;
      if (heightAt(x, z) < -3.5 && heightAt(x + 40, z) < -3 && heightAt(x - 40, z) < -3) { best = { x, z }; break; }
    }
    if (!best) return;
    const sy = this.assets.cloneModel('superyacht', { cloneMaterials: false });
    sy.position.set(best.x, -2.2, best.z);
    sy.rotation.y = 0.9;
    this.scene.add(sy);
    this.superyacht = sy;
    this.collisions.addBox(best.x, best.z, 5.5, 31, 0.9, { kind: 'boat', damage: 1.3 });
    this.titleTarget = new THREE.Vector3(best.x, 4, best.z);
  }

  makeTargets() {
    const home = this.villas.home;
    this.targets = [];
    const geo = new THREE.CylinderGeometry(0.45, 0.45, 0.08, 20);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff5a3c, roughness: 0.5, emissive: 0x220500 });
    for (let i = 0; i < 5; i++) {
      const d = home.dock;
      const x = d.x + d.ox * (25 + i * 6) - d.oz * (i - 2) * 5, z = d.z + d.oz * (25 + i * 6) + d.ox * (i - 2) * 5;
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, 0.6, z);
      this.scene.add(m);
      this.targets.push({ mesh: m, x, z, down: 0 });
    }
  }

  layoutBoats() {
    for (const id of BOAT_ORDER) {
      const b = this.ownedBoats[id];
      if (b === this.boat) continue;
      const berth = this.mooring[id];
      if (!berth) continue;
      b.berth = berth; berth.occupied = b;
      b.place(berth.x, berth.z, berth.heading);
    }
  }

  setActiveBoat(boat, initial = false) {
    if (this.boat === boat) return;
    const prev = this.boat;
    if (prev && this.passengers) this.passengers.clear(prev);
    if (prev && this.sea && this.sea.docked) {
      // the boat we leave stays tied where it is
      prev.berth = this.sea.docked;
      this.sea.lines.forEach((r) => this.scene.remove(r.mesh));
      this.sea.lines = [];
      this.sea.docked = null;
      prev.phys.lines = null;
    }
    this.boat = boat;
    this.save.data.boat = boat.id;
    if (initial) {
      const p = this.save.data.player;
      if (p && p.boatPos && p.boat === boat.id && !p.docked) {
        boat.place(p.boatPos.x, p.boatPos.z, p.boatPos.h);
      } else {
        boat.place(this.homeBerth.x, this.homeBerth.z, this.homeBerth.heading);
        boat.berth = this.homeBerth;
      }
    } else boat.phys.reset(boat.pos.x, boat.pos.z, boat.phys.heading);
    if (boat.berth && this.sea) {
      this.sea.docked = boat.berth;
      boat.berth.occupied = boat;
      this.sea.attachLines(boat.berth);
      boat.berth = null;
    }
  }

  // ------------------------------------------------------------------ world queries
  allBerths() { return [...this.docks.berths, ...this.villas.docks.map((d) => Object.assign(d.berth, { home: d.home, marina: d.home ? 'home' : 'villa' }))]; }
  nearestFuelDock(x, z) { return this.docks.fuelDocks.reduce((a, b) => (Math.hypot(b.x - x, b.z - z) < Math.hypot(a.x - x, a.z - z) ? b : a)); }
  canSwitchBoatsAt(berth) { return berth.marina === 'bayside' || berth.home; }
  nearSocialSpot() {
    const p = this.boat ? this.boat.pos : this.player.pos;
    return DESTINATIONS.some((d) => ['sandbar', 'beachclub', 'tiki', 'restaurant'].includes(d.kind) && Math.hypot(p.x - d.x, p.z - d.z) < d.r + 120);
  }
  walkSurface(x, z) {
    for (const list of [this.docks.walkRects, this.villas.walkRects]) {
      for (const r of list) {
        const c = Math.cos(r.angle), s = Math.sin(r.angle);
        const lx = (x - r.x) * c + (z - r.z) * s, lz = -(x - r.x) * s + (z - r.z) * c;
        if (Math.abs(lx) <= r.hx && Math.abs(lz) <= r.hz) return r.y;
      }
    }
    const h = heightAt(x, z);
    if (h > -1.05) return h;
    return null;
  }
  groundHeightAt(x, z) { const w = this.walkSurface(x, z); return w === null ? heightAt(x, z) : w; }
  blockedOnFoot(x, z) {
    for (const r of this.villas.blockers) {
      const c = Math.cos(r.angle), s = Math.sin(r.angle);
      const lx = (x - r.x) * c + (z - r.z) * s, lz = -(x - r.x) * s + (z - r.z) * c;
      if (Math.abs(lx) <= r.hx && Math.abs(lz) <= r.hz) return true;
    }
    return false;
  }
  boardableBoats() {
    const p = this.player.pos;
    return Object.values(this.ownedBoats).filter((b) => Math.hypot(b.pos.x - p.x, b.pos.z - p.z) < 30);
  }
  personInSights(ray) {
    const test = (x, y, z) => { _v.set(x, y + 1.0, z); return ray.distanceSqToPoint(_v) < 0.55 * 0.55 && _v.sub(ray.origin).dot(ray.direction) > 0 && _v.length() < 160; };
    for (const st of this.people.statics) for (const s of st.list) if (test(s.x, s.y ?? 0, s.z)) return true;
    for (const w of this.people.walkers) if (w.ch.object.visible && test(w.ch.object.position.x, w.ch.object.position.y, w.ch.object.position.z)) return true;
    if (this.boat) for (const g of this.passengers.guests) { g.obj.getWorldPosition(_v2); if (test(_v2.x, _v2.y - 0.6, _v2.z)) return true; }
    return false;
  }
  shoot(ray) {
    // targets first
    for (const t of this.targets) {
      if (t.down > 0) continue;
      _v.set(t.x, t.mesh.position.y, t.z);
      if (ray.distanceSqToPoint(_v) < 0.5 * 0.5) { t.down = 4; this.ui.toast('Nice shot 🎯'); this.wake.splash(t.x, 0, t.z, 0.4); this.audio.splash(0.3); return; }
    }
    // water: march the ray to the wave surface
    const o = ray.origin, d = ray.direction;
    for (let s = 1; s < 400; s += 1.5) {
      const x = o.x + d.x * s, y = o.y + d.y * s, z = o.z + d.z * s;
      const g = heightAt(x, z);
      const w = this.waves.heightFast(x, z, this.time);
      if (y < Math.max(w, g)) {
        if (w > g) { this.wake.splash(x, w, z, 0.18); this.audio.splash(0.12); }
        return;
      }
    }
  }

  // ------------------------------------------------------------------ game flow
  startGame() {
    this.audio.start();
    this.audio.applyVolumes();
    document.getElementById('title').classList.add('hidden');
    this.ui.show(true);
    this.started = true;
    this.paused = false;
    const p = this.save.data.player;
    if (!this.save.data.started || !p) {
      // new game: start on foot in the back yard of the home villa
      const y = this.villas.home.yard;
      this.player.spawnAt(y.x, y.z, Math.atan2(this.villas.home.lot.ox, this.villas.home.lot.oz));
      this.cams.setMode('foot');
      this.ui.toast('Welcome home — walk down to your dock and step aboard', 6);
      this.ui.toggleControls(true);
      setTimeout(() => this.ui.toggleControls(false), 12000);
    } else if (p.mode === 'helm') {
      this.player.takeHelm(this.boat);
      this.cams.setMode(p.cam && BOAT_CAMS.includes(p.cam) ? p.cam : 'chase');
    } else {
      this.player.spawnAt(p.x, p.z, p.yaw || 0);
      this.cams.setMode('foot');
    }
    this.save.data.started = true;
    if (this.pendingCalib) { this.pendingCalib = false; this.pauseGame(true); this.menus.show('calibration'); }
    this.canvas.focus();
  }

  toTitle() {
    this.persistState();
    this.started = false;
    this.ui.show(false);
    document.getElementById('title').classList.remove('hidden');
    document.getElementById('start-label').textContent = 'Continue';
    this.cams.setMode('title');
    this.paused = false;
    document.exitPointerLock?.();
  }

  goHome() {
    this.menus.fade(1.2, () => {
      const b = this.boat;
      if (this.sea.anchor) { this.sea.anchor = null; b.phys.anchor = null; this.sea.chain.visible = false; }
      if (this.sea.docked) this.sea.castOff();
      this.homeBerth.occupied = null;
      b.place(this.homeBerth.x, this.homeBerth.z, this.homeBerth.heading);
      this.sea.docked = this.homeBerth; this.homeBerth.occupied = b; this.sea.attachLines(this.homeBerth);
      b.phys.engineOn = false;
      const y = this.villas.home.yard;
      this.player.spawnAt(y.x, y.z, 0);
      this.cams.setMode('foot');
    });
  }

  pauseGame(on) {
    if (!this.started) return;
    this.paused = on;
    if (on) { document.exitPointerLock?.(); if (!this.menus.open) this.menus.show('pause'); }
  }
  onMenuClosed() { if (this.started) { this.paused = false; this.audio.resume(); } }

  toggleChart(on = !this.chartOpen) {
    this.chartOpen = on;
    document.getElementById('chart').classList.toggle('hidden', !on);
    if (on) { const p = this.player.pos; this.map.center = { x: p.x, z: p.z }; document.exitPointerLock?.(); }
  }

  selectBoat(id) {
    const target = this.ownedBoats[id];
    if (!this.started) { this.save.data.boat = id; this.swapToBoat(target, this.homeBerth); return; }
    if (target === this.boat) return;
    const where = this.sea.docked;
    if (!where || !this.canSwitchBoatsAt(where)) { this.ui.toast('Switch boats while docked at Bayside Marina or your home dock'); return; }
    this.menus.fade(1.0, () => this.swapToBoat(target, where));
  }

  swapToBoat(target, berth) {
    const cur = this.boat;
    if (cur === target) return;
    const targetBerth = this.mooring[target.id];
    // current boat goes to the new boat's mooring
    if (this.sea.docked) { this.sea.lines.forEach((r) => this.scene.remove(r.mesh)); this.sea.lines = []; this.sea.docked.occupied = null; this.sea.docked = null; cur.phys.lines = null; }
    if (this.passengers) this.passengers.clear(cur);
    if (targetBerth) { cur.place(targetBerth.x, targetBerth.z, targetBerth.heading); cur.berth = targetBerth; targetBerth.occupied = cur; }
    this.mooring[cur.id] = targetBerth;
    this.mooring[target.id] = berth.home ? null : berth;
    target.place(berth.x, berth.z, berth.heading);
    target.berth = berth;
    this.boat = null;
    this.setActiveBoat(target);
    this.save.data.boat = target.id;
    if (this.player.mode === 'helm') this.player.takeHelm(target);
    else if (this.player.onBoat === cur) this.player.onBoat = null;
  }

  repaint(id) {
    const b = this.ownedBoats[id], st = this.save.boatState(id);
    b.applyPaint(st.paint, st.trim);
  }

  menuAction(id) {
    const b = this.boat;
    this.audio.click();
    if (id === 'disembark') { this.player.leaveHelm(); this.cams.setMode('foot'); }
    else if (id === 'switch') { this.pauseGame(true); this.menus.show('boats'); }
    else if (id === 'repair') this.sea.repairAndRefuel();
    else if (id === 'invite') {
      if (this.passengers.count) this.passengers.dropOff(b);
      else this.passengers.invite(b, new THREE.Vector3(this.sea.docked ? this.sea.docked.cleatX : b.pos.x, 1, this.sea.docked ? this.sea.docked.cleatZ : b.pos.z));
    } else if (id === 'castoff') this.sea.castOff();
    else if (id === 'hangout') {
      this.sea.hangout = !this.sea.hangout;
      this.cams.setMode(this.sea.hangout ? 'hangout' : this.lastBoatCam);
      if (this.sea.hangout) this.ui.toast('Hanging out — music up. Any helm input to leave.');
    } else if (id === 'anchor') this.sea.toggleAnchor();
  }

  applySeaState(snap = false) {
    const s = this.save.data.settings.seaState;
    this.waves.setTarget(s === 'auto' ? seaStateForTime(this.day.hours) : SEA_STATES[s]);
    if (snap) this.waves.snap();
  }

  applySettings(key) {
    const S = this.save.data.settings;
    if (key === 'preset') {
      const p = PRESETS[S.preset];
      Object.assign(S, { renderScale: p.renderScale, reflections: p.reflections, shadows: p.shadows, foliage: p.foliage, drawDistance: p.drawDistance });
      this.quality = resolveQuality(S, this.quality.detected);
      this.ui.toast('Preset applied — water grid & foliage changes apply after a reload');
      this.menus.show('settings', 'graphics');
    }
    this.camera.fov = S.fov; this.camera.updateProjectionMatrix();
    this.reflection.enabled = S.reflections;
    this.sun.castShadow = S.shadows;
    this.post.bloomEnabled = S.bloom;
    this.post.setSamples(S.aa === 'msaa' ? this.quality.msaa || 4 : 0);
    this.post.composite.uniforms.uFxaa.value = S.aa === 'fxaa' ? 1 : 0;
    this.vegetation.farDist = S.drawDistance;
    this.vegetation._last.set(1e9, 0, 0);
    this.day.dayMinutes = S.dayMinutes;
    if (key === 'seaState') this.applySeaState();
    if (key === 'radioStation') this.audio.setStation(S.radioStation);
    this.audio.applyVolumes();
    this.resize();
  }

  persistState() {
    const sd = this.save.data;
    sd.timeOfDay = this.day.hours;
    const b = this.boat;
    if (b) {
      const st = this.save.boatState(b.id);
      st.integrity = b.phys.integrity; st.fuel = b.phys.fuel;
    }
    if (this.started && this.player) {
      sd.player = { mode: this.player.mode, x: this.player.pos.x, z: this.player.pos.z, yaw: this.player.yaw, boat: b ? b.id : 'coral', cam: this.cams.mode, docked: !!(this.sea && this.sea.docked), boatPos: b ? { x: b.pos.x, z: b.pos.z, h: b.phys.heading } : null };
    }
    this.save.persist();
  }

  resize() {
    const S = this.save.data.settings;
    const dpr = Math.min(window.devicePixelRatio || 1, 2, this.quality.dpr || 1.25);
    const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    const scale = clamp(S.renderScale * dpr, 0.4, 2);
    const rw = Math.round(w * scale), rh = Math.round(h * scale);
    this.post.setSize(rw, rh);
    this.reflection.setSize(rw, rh);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderW = rw; this.renderH = rh;
  }

  bindEvents() {
    bus.on('aiHorn', (e) => this.audio.aiHorn(e.b, e.blasts, this.camera));
    bus.on('aiSinking', () => this.ui.toast('You sank another boat! The crew is being rescued — TowBoatUS is on the way.', 6));
    bus.on('gull', () => { if (this.started) this.audio.gull(); });
    bus.on('dolphins', (e) => { if (e.start) this.ui.toast('Dolphins off the bow! 🐬'); });
  }

  // Stage a shot (used by the screenshot verification script and the title backdrop)
  stage(o) {
    if (o.hours !== undefined) this.day.setHours(o.hours);
    if (o.boat) {
      const b = this.ownedBoats[o.boat.id || this.boat.id];
      if (b !== this.boat) this.swapToBoat(b, this.homeBerth);
      if (this.sea.docked && !o.boat.docked) { this.sea.lines.forEach((r) => this.scene.remove(r.mesh)); this.sea.lines = []; this.sea.docked.occupied = null; this.sea.docked = null; b.phys.lines = null; }
      b.place(o.boat.x, o.boat.z, o.boat.h);
      if (o.boat.speed) { b.phys.body.vel.set(Math.sin(o.boat.h) * o.boat.speed, 0, -Math.cos(o.boat.h) * o.boat.speed); b.phys.input.throttle = o.boat.throttle ?? 0.8; b.phys.engineOn = true; b.phys.gear = 1; b.phys.spool = o.boat.throttle ?? 0.8; }
      this.player.takeHelm(b);
    }
    if (o.guests) this.passengers.invite(this.boat);
    this.photo = o.pos ? { pos: o.pos, look: o.look, fov: o.fov } : null;
    if (o.cam) { this.photo = null; this.cams.setMode(o.cam); this.cams.blendT = 1; this.cams.snap = true; }
    if (o.input) Object.assign(this.boat.phys.input, o.input);
    if (o.simulate) {
      // fast-forward the real simulation (physics, wakes, AI) without rendering
      const steps = Math.round(o.simulate * 30);
      for (let i = 0; i < steps; i++) {
        if (o.input) { Object.assign(this.boat.phys.input, o.input); this.input.state.throttle = o.input.throttle || 0; this.input.state.reverse = o.input.reverse || 0; this.input.state.steer = o.input.steer || 0; }
        this.handleActions(1 / 30);
        this.simulateWorld(1 / 30, false);
      }
      if (o.cam) { this.cams.snap = true; this.cams.blendT = 1; }
    }
    if (o.engineOff) { this.boat.phys.engineOn = false; }
  }

  // ------------------------------------------------------------------ main loop
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    let dt = (now - this.last) / 1000;
    this.last = now;
    dt = Math.min(dt, 0.05);
    this.fpsT += dt; this.frameCount++;
    if (this.fpsT > 0.5) { if (this.showFps) document.getElementById('fps').textContent = `${Math.round(this.frameCount / this.fpsT)} fps · ${this.renderer.info.render.calls} calls · ${(this.renderer.info.render.triangles / 1e6).toFixed(2)}M tris`; this.fpsT = 0; this.frameCount = 0; }
    const S = this.save.data.settings;
    const b = this.boat;
    this.input.update(dt, { speedK: b ? clamp(b.phys.t.speed / 15, 0, 1) : 0, calibrating: this.menus.open === 'calibration' });
    if (this.awaitRemap) {
      const btn = this.input.wheel.pressed.find((a) => a.startsWith('btn'));
      if (btn) { S.wheelButtons = { ...(S.wheelButtons || {}), [this.awaitRemap]: parseInt(btn.slice(3), 10) }; this.awaitRemap = null; this.save.persist(); this.menus.show('settings', 'wheel'); }
    }
    this.menus.updateCalibration(dt);
    this.menus.renderPreview(dt);

    // pause / menus
    if (this.input.consume('pause')) {
      if (this.chartOpen) this.toggleChart(false);
      else if (this.menus.open) this.menus.close();
      else if (this.started) this.pauseGame(true);
    }
    if (this.paused || !this.started) {
      // title backdrop keeps the world alive; pause freezes the sim entirely
      if (!this.started) this.simulateWorld(dt, true);
      this.renderFrame(this.paused ? 0 : dt);
      return;
    }
    if (this.input.consume('map')) this.toggleChart();
    if (this.chartOpen) {
      if (this.input.has('mapZoomIn')) this.map.zoom = Math.min(8, this.map.zoom * 1.25);
      if (this.input.has('mapZoomOut')) this.map.zoom = Math.max(0.6, this.map.zoom / 1.25);
      if (this.input.kb.down.has('KeyR')) { const p = this.player.pos; this.map.center = { x: p.x, z: p.z }; }
      this.map.drawChart();
    }
    this.handleActions(dt);
    this.simulateWorld(dt, false);
    this.renderFrame(dt);
    this.save.tick(dt);
    if (this.save._t === 0) this.persistState();
  }

  handleActions(dt) {
    const I = this.input, b = this.boat, pl = this.player, sea = this.sea;
    // radio
    if (I.consume('radioNext')) this.audio.setStation(((this.audio.stationIndex + 2) % 4) - 1);
    if (I.consume('radioPrev')) this.audio.setStation(((this.audio.stationIndex + 4) % 4) - 1);
    if (I.has('mapZoomIn') && !this.ui.menuOpts.length) this.map.miniZoom = Math.min(4, this.map.miniZoom * 1.4);
    if (I.has('mapZoomOut') && !this.ui.menuOpts.length) this.map.miniZoom = Math.max(0.35, this.map.miniZoom / 1.4);
    if (I.consume('details')) this.ui.toggleDetails();
    if (I.consume('help')) this.ui.toggleControls();
    if (I.consume('inventory') && pl.mode === 'foot') { this.pauseGame(true); this.menus.show('inventory'); return; }
    if (I.consume('tow') && b && pl.mode === 'helm' && (b.phys.fuel <= 0.02 || b.phys.integrity < 0.3 || sea.beached)) sea.rescue('tow');
    // cameras
    const next = I.consume('camNext'), prev = I.consume('camPrev');
    if ((next || prev) && pl.mode === 'helm') {
      const i = BOAT_CAMS.indexOf(this.cams.mode);
      const n = BOAT_CAMS[((i < 0 ? 0 : i) + (next ? 1 : BOAT_CAMS.length - 1)) % BOAT_CAMS.length];
      this.cams.setMode(n);
      this.lastBoatCam = n;
      if (sea.dockMode) sea.toggleDockMode();
    } else if ((next || prev) && pl.mode === 'foot') this.cams.firstPerson = !this.cams.firstPerson;

    // context menu (docked / anchored / beached)
    const opts = pl.mode === 'helm' && b ? sea.menuOptions() : [];
    const title = sea.docked ? `Docked — ${sea.berthLabel(sea.docked)}` : sea.anchor ? 'At anchor' : sea.beached ? 'Beached on the sand' : '';
    this.ui.setMenu(title, opts);
    if (opts.length) {
      for (let k = 1; k <= 6; k++) if (I.consume('menu' + k) && opts[k - 1]) { this.menuAction(opts[k - 1].id); return; }
      if (I.consume('hat_up') || I.consume('menuUp')) this.ui.menuSel = (this.ui.menuSel + opts.length - 1) % opts.length;
      if (I.consume('hat_down') || I.consume('menuDown')) this.ui.menuSel = (this.ui.menuSel + 1) % opts.length;
      const confirm = I.consume('confirm') || (sea.docked && I.device !== 'keyboard' && I.consume('engine'));
      if (confirm) { this.menuAction(opts[this.ui.menuSel].id); return; }
      if (I.consume('invite')) { this.menuAction('invite'); }
      if (I.consume('hangout') && (sea.anchor || sea.beached)) this.menuAction('hangout');
    }

    if (pl.mode === 'helm' && b) {
      if (I.consume('engineHold')) { if (b.phys.engineOn) { b.phys.engineOn = false; this.ui.toast('Engine off'); } }
      else if (I.consume('engine')) {
        if (!b.phys.engineOn) { if (sea.docked) sea.castOff(); else sea.startEngine(); }
      }
      if (I.consume('anchor')) { if (sea.docked) this.ui.toast('Tied up — cast off first'); else sea.toggleAnchor(); }
      if (I.consume('horn')) this.audio.horn(b.def.hornType);
      if (I.consume('dock')) sea.toggleDockMode();
      // helm & throttle
      const s = I.state;
      const drone = this.cams.mode === 'drone' && I.device === 'keyboard' && I.kb.has('ShiftLeft', 'ShiftRight') === false && this.droneFly;
      const tied = !!sea.docked;
      const inp = b.phys.input;
      inp.steer = drone ? 0 : s.steer;
      inp.throttle = drone || tied ? 0 : s.throttle;
      inp.reverse = drone || tied ? 0 : s.reverse;
      inp.thruster = s.thruster;
      if (tied && (s.throttle > 0.3 || s.reverse > 0.3) && Math.random() < dt) this.ui.toast(`Tied up — choose "Cast off" (${I.device === 'keyboard' ? 'number key' : 'D-pad + A'})`);
      if (sea.hangout && (s.throttle > 0.2 || s.reverse > 0.2 || Math.abs(s.steer) > 0.5)) this.menuAction('hangout');
      this.steerRate = (s.steer - (this._lastSteer || 0)) / Math.max(dt, 1e-3);
      this._lastSteer = s.steer;
      if (this.cams.mode === 'foot') this.cams.setMode(this.lastBoatCam);
    } else if (b) {
      b.phys.input.throttle = b.phys.input.reverse = 0; b.phys.input.steer = 0; b.phys.input.thruster = 0;
      this.steerRate = 0;
      if (this.cams.mode !== 'foot' && this.cams.mode !== 'drone') this.cams.setMode('foot');
    }
    this.droneFly = this.cams.mode === 'drone' && I.kb.has('ShiftLeft') === false && pl.mode === 'helm' ? this.droneFly : false;
  }

  simulateWorld(dt, idle) {
    const S = this.save.data.settings;
    this.time += dt;
    const day = this.day;
    day.update(dt);
    if (S.seaState === 'auto') this.applySeaState();
    this.waves.update(dt);
    const b = this.boat;
    // physics at 240 Hz with an accumulator; input is sampled once per frame
    const env = this.physEnv || (this.physEnv = {
      time: 0, waves: this.waves, terrainHeight: heightAt,
      wakeHeight: (x, z) => this.wake.heightAt(x, z), current: (x, z, o) => currentAt(x, z, o), wind: (o) => this.waves.windVector(o),
    });
    env.time = this.time;
    if (b && !idle) {
      b.phys.events.length = 0;
      b.phys.body.savePrev();
      this.acc = (this.acc || 0) + dt;
      let steps = 0;
      while (this.acc >= PHYS_DT && steps < 24) {
        b.phys.step(PHYS_DT, env);
        env.time += PHYS_DT;
        const imp = resolveBoatCollisions(b.phys, b.circles, this.collisions, _imp);
        if (imp) this.sea.onImpact(imp, b.phys);
        this.acc -= PHYS_DT;
        steps++;
      }
      this.alpha = this.acc / PHYS_DT;
      // physics events -> feel
      for (const e of b.phys.events) {
        if (e.type === 'slam') { this.ffb.slamHit(e.a); this.audio.slap(e.a); this.cams.shake(e.a * 0.12); bus.emit('slam', { v: e.a }); if (e.a > 3) this.wake.splash(e.x, e.y, e.z, e.a * 0.2); }
        if (e.type === 'landing') { this.ffb.landing(e.a * 4); this.cams.shake(Math.min(1, e.a)); this.audio.splash(Math.min(0.6, e.a)); this.wake.splash(b.pos.x, b.pos.y, b.pos.z, Math.min(1.5, e.a * 2)); bus.emit('landing', { air: e.a, dist: e.b }); }
        if (e.type === 'ground' && e.a > 0.6) { this.audio.burst(0.4, clamp(e.a / 6, 0.05, 0.4), 'lowpass', 300); }
        if (e.type === 'ventilate') this.audio.burst(0.3, 0.1, 'highpass', 3000);
      }
    } else this.alpha = 1;
    for (const e of this.events) {
      if (e.type === 'impact') {
        const side = Math.sign(e.nx * Math.cos(b.phys.heading) + e.nz * Math.sin(b.phys.heading)) || 1;
        this.ffb.collision(e.speed, side);
        this.audio.impact(e.speed);
        this.cams.shake(clamp(e.speed / 4, 0.2, 1.4));
        this.wake.splash(e.x, 0, e.z, clamp(e.speed / 4, 0.2, 1));
        if (e.dmg > 0.01) this.ui.toast(`Hull damage −${Math.round(e.dmg * 100)}%${e.kind === 'ground' ? ' (ran aground)' : ''}`);
      }
    }
    this.events.length = 0;
    // visuals of boats
    for (const ob of Object.values(this.ownedBoats)) {
      if (ob === b && !idle) ob.updateVisual(this.alpha, day.night);
      else {
        // moored boats bob on the real waves
        const h = this.waves.heightFast(ob.pos.x, ob.pos.z, this.time, 0.6);
        ob.root.position.set(ob.pos.x, h - ob.phys.restWaterlineY - 0.02, ob.pos.z);
        ob.root.quaternion.copy(ob.phys.body.quat);
        ob.updateVisual(1, day.night);
        ob.root.position.y = h - ob.phys.restWaterlineY;
        ob.root.rotation.z += Math.sin(this.time * 1.1 + ob.def.length) * 0.015;
      }
    }
    // gameplay
    if (!idle) {
      this.player.update(dt, this.input, this);
      this.sea.update(dt, this.input);
      this.passengers.update(dt, b, this.sea.hangout);
      this.logbook.update(dt);
      this.map.addTrail(this.player.pos.x, this.player.pos.z);
    }
    // world
    this.wake.update(dt, this.camera.position, currentAt(this.camera.position.x, this.camera.position.z, _cur));
    if (b && !idle) this.wake.emitBoat(b.wakeState(), dt);
    this.traffic.update(dt, this.time, this.waves, idle ? null : b);
    this.docks.update(dt, this.time, this.waves, day.night);
    this.destinations.update(dt, this.time, this.waves, day.night);
    this.props.update(dt, this.time, this.waves, day.night, this.camera.position, _cur);
    this.wildlife.update(dt, this.time, this.waves, idle ? null : b, this.camera.position);
    this.people.update(dt, this.time);
    this.roads.update(dt, day.night, this.camera.position);
    this.villas.update(day.night);
    this.vegetation.update(this.time, this.camera.position, this.waves.windVector(_wind));
    cityUniforms.uNight.value = smoothstep(0.15, 0.85, day.night);
    cityUniforms.uTime.value = this.time;
    if (this.aviationLights) { this.aviationLights.visible = day.night > 0.3; this.aviationLights.material.color.setRGB(1, 0.1, 0.05).multiplyScalar((Math.sin(this.time * 3) > 0 ? 6 : 0.5) * day.night); }
    for (const m of this.mixers) m.update(dt);
    for (const t of this.targets) {
      if (t.down > 0) { t.down -= dt; t.mesh.position.y = -1.5; continue; }
      t.mesh.position.y = this.waves.heightFast(t.x, t.z, this.time) + 0.55;
      t.mesh.rotation.y = Math.atan2(this.camera.position.x - t.x, this.camera.position.z - t.z);
    }
    if (this.superyacht) this.superyacht.position.y = this.waves.heightFast(this.superyacht.position.x, this.superyacht.position.z, this.time, 0.4) - 2.2;
    // cameras + feedback
    const pl = this.player;
    if (!this.photo) this.cams.update(dt, this.input, { player: pl, aiming: this.input.state.aim && !!pl.equipped, hangout: this.sea && this.sea.hangout, droneFly: this.droneFly, ffbShake: this.ffb ? this.ffb.shake * 0.4 : 0, titleTarget: this.titleTarget });
    if (this.photo) { this.camera.position.fromArray(this.photo.pos); this.camera.lookAt(...this.photo.look); this.camera.fov = this.photo.fov || 60; this.camera.updateProjectionMatrix(); }
    if (!idle && b) {
      const atHelm = pl.mode === 'helm';
      const wheelPos = this.input.device === 'wheel' ? this.input.wheel.rawSteer : 0;
      this.ffb.update(dt, { atHelm, speed: b.phys.t.speed, rudderLoad: b.phys.rudder / b.def.rudder.maxAngle * clamp(b.phys.t.speed / 10, 0, 1), wheelPos, wheelVel: (wheelPos - (this._lwp || 0)) / Math.max(dt, 1e-3), grind: b.phys.t.grind, rpmFrac: b.phys.t.rpmFrac, engineOn: b.phys.engineOn, time: this.time });
      this._lwp = wheelPos;
    }
    // audio
    if (this.audio && this.audio.started) {
      this.audio.listener(this.camera);
      this.audio.updateEngine(b, { dockMode: this.sea.dockMode, steerRate: this.player.mode === 'helm' ? this.steerRate || 0 : 0 });
      const p = this.camera.position;
      let venue = null, vd = 1e9;
      for (const v of this.destinations.music) { const d = Math.hypot(p.x - v.x, p.z - v.z); if (d < v.r * 1.3 && d < vd) { vd = d; venue = v; } }
      const nearMarina = Math.min(...MARINAS.map((m) => Math.hypot(p.x - m.x, p.z - m.z)));
      const sd = -heightAt(p.x, p.z);
      this.audio.updateAmbience(dt, {
        speed: b && pl.mode === 'helm' ? b.phys.t.speed : 0, wet: b ? b.phys.t.wet : 1, chop: this.waves.current.chop, onWater: pl.mode === 'helm' || !!pl.onBoat,
        ventilating: b && b.phys.t.ventilating, grind: b ? b.phys.t.grind : 0, wind: this.waves.current.wind,
        cityK: clamp(1 - Math.abs(p.x + 2400) / 900, 0, 1) * 0.8 + clamp(1 - Math.abs(p.x - 3000) / 900, 0, 1) * 0.4,
        marinaK: clamp(1 - nearMarina / 250, 0, 1), landK: clamp(1 - sd / 3, 0, 1), night: day.night,
        engineLoud: b && b.phys.engineOn ? b.phys.t.rpmFrac : 0, hangout: this.sea && this.sea.hangout, venue,
      });
      this.audio.updateAi(this.traffic.nearest(this.camera.position, 2), this.camera, this.cams.velocity);
    }
    if (!idle && this.ui) { this.ui.update(dt); this.map.drawMini(dt); }
  }

  updateLighting() {
    const day = this.day, p = day.p, S = this.save.data.settings;
    const sunUp = day.sunElevation > -3;
    day.lightDir(_v);
    const focus = this.boat && this.player.mode === 'helm' ? this.boat.root.position : this.player.pos;
    this.sun.position.copy(focus).addScaledVector(_v, 400);
    this.sun.target.position.copy(focus);
    this.sun.color.copy(sunUp ? p.sun : new THREE.Color(0.55, 0.65, 0.9));
    this.sun.intensity = sunUp ? p.sunI * 0.85 : 0.18;
    this.sun.castShadow = S.shadows && (sunUp ? p.sunI > 0.3 : false);
    this.hemi.color.copy(p.sky);
    this.hemi.groundColor.copy(p.ground);
    this.hemi.intensity = 0.32 + 0.38 * (1 - day.night);
    this.scene.fog.color.copy(p.fog);
    const dd = S.drawDistance;
    this.scene.fog.density = 0.55 / dd * (this.underwater ? 90 : 1);
    if (this.underwater) this.scene.fog.color.setRGB(0.02, 0.16, 0.2);
    this.sky.update(day, this.time, this.camera.position);
    this.envSky.position.set(0, 0, 0);
    // refresh the environment map as the light changes
    this.envT += 1;
    if (this.envT > 240 || Math.abs(day.sunElevation - (this._envEl ?? 999)) > 2) {
      this.envT = 0; this._envEl = day.sunElevation;
      if (this.envRT) this.envRT.dispose();
      this.envRT = this.pmrem.fromScene(this.envScene, 0, 1, 30000);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = 0.3 + 0.45 * (1 - day.night);
    }
  }

  renderFrame(dt) {
    const S = this.save.data.settings;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const camWave = this.waves.heightFast(cam.position.x, cam.position.z, this.time);
    this.underwater = cam.position.y < camWave - 0.05 && heightAt(cam.position.x, cam.position.z) < camWave;
    this.updateLighting();
    this.terrain.update(this.time);
    const fogDensity = this.scene.fog.density;
    this.ocean.update(cam, this.day, this.time, fogDensity, this.underwater);
    // wake splat target
    this.wake.render(cam.position);
    // planar reflection
    const refl = !this.underwater && this.reflection.render(this.scene, cam, [this.ocean.mesh, this.wake.spray, this.player.fpArms]);
    this.ocean.setReflection(this.reflection.target.texture, refl);
    this.ocean.uniforms.uTextureMatrix.value.copy(this.reflection.textureMatrix);
    // main pass into the HDR target
    this.renderer.setRenderTarget(this.post.main);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    // composite
    const c = this.post.composite.uniforms;
    c.uExposure.value = this.day.p.exposure;
    c.uUnderwater.value = this.underwater ? 1 : 0;
    c.uDroplets.value = this.cams.mode === 'helm' ? this.cams.droplets : 0;
    c.uVignette.value = this.cams.mode === 'title' ? 0.5 : 0.3;
    c.uUnderColor.value.copy(this.day.p.water).multiplyScalar(2.5);
    this.post.render(dt, this.time);
  }
}

function nextFrame() { return new Promise((r) => setTimeout(r, 0)); }

const game = new Game();
game.init().catch((e) => {
  console.error(e);
  document.getElementById('load-text').textContent = 'Something went wrong while loading: ' + (e && e.message ? e.message : e);
});
