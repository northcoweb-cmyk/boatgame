// Data-driven boat specs. A new boat = a new entry here + a model in
// assets/assets.js MODEL_SPECS. Hull length / beam / keel / deck heights are
// measured from the actual mesh at load time (boats/hull-fit.js) and override
// the fallback numbers below; physics probes, collision circles, seats and nav
// lights are all fitted to that measured hull.
// Body frame: forward = -Z, starboard = +X, up = +Y, origin = centre of mass.
import { KNOT, DEG } from '../core/math.js';

export const PAINTS = [
  { id: 'white', name: 'Bay White', hull: 0xf4f6f7, unlock: null },
  { id: 'aqua', name: 'Biscayne Aqua', hull: 0x6fd2d0, unlock: 'aqua' },
  { id: 'coral', name: 'Coral Pink', hull: 0xff8f7a, unlock: 'coral' },
  { id: 'sunset', name: 'Sunset Orange', hull: 0xff9a3c, unlock: 'sunset' },
  { id: 'midnight', name: 'Midnight', hull: 0x1c2740, unlock: 'midnight' },
];
export const TRIMS = [
  { id: 'none', name: 'Factory trim', unlock: null },
  { id: 'rainbow', name: 'Rainbow hull stripe', unlock: 'rainbow' },
  { id: 'gold', name: 'Gold cleats & rails', unlock: 'gold' },
];

export const BOATS = {
  coral: {
    id: 'coral', name: 'Coral', kind: '21 ft center console', model: 'runabout',
    blurb: 'The daily driver. Planes in five seconds, forgiving in chop, shallow draft for beaching.',
    stats: { top: '38 kn', handling: 'Balanced', seats: 5 },
    length: 6.4, beam: 2.45, keelBelowCom: 0.62, deckAboveCom: 0.62,
    mass: 1400, draft: 0.42, deadrise: 21 * DEG, comFromStern: 0.42,
    engine: { type: 'outboard', idleRpm: 700, maxRpm: 4400, spoolUp: 1.7, spoolDown: 1.0, maxThrust: 5600, revFactor: 0.65, shiftDelay: 0.35, sound: 'outboard', hp: 150 },
    hull: { vTop: 38 * KNOT, vHump: 8 * KNOT, planeMargin: 0.34, swayCd: 1.15, yawDamp: 1.0, liftFrac: 0.62, humpTrim: 0.06, planeTrim: 0.015, stability: 1.0 },
    rudder: { maxAngle: 35 * DEG, minAngleAtSpeed: 17 * DEG, washGain: 0.42, speedGain: 0.16, falloff: 7.5, rate: 150 * DEG, rateAtSpeed: 80 * DEG },
    windage: { side: 6.5, front: 3.0, height: 0.9, lead: 0.15 },
    propWalk: 0.06, thruster: 0, propDepth: 0.55, beachable: true, hornType: 'coral',
    paintMaterials: ['white'],
    helm: { u: 0.665, v: 0.0, pose: 'stand', wheelHeight: 1.0, eyeHeight: 1.62, back: 0.3 },
    seats: [
      { u: 0.14, v: -0.3, pose: 'sitFloor', face: 0 }, { u: 0.14, v: 0.3, pose: 'sitFloor', face: 0 },
      { u: 0.8, v: -0.38, pose: 'sit', face: 0 }, { u: 0.8, v: 0.38, pose: 'sit', face: 0 },
    ],
    chase: { dist: 10.5, height: 3.0 },
  },
  isabel: {
    id: 'isabel', name: 'Isabel', kind: '38 ft sport yacht', model: 'yacht',
    blurb: 'The flagship. Heavy, deliberate and expensive-feeling. Mind the prop walk in reverse; the clutch runs the bow thruster.',
    stats: { top: '28 kn', handling: 'Smooth', seats: 7 },
    length: 11.6, beam: 3.9, keelBelowCom: 1.15, deckAboveCom: 0.9,
    mass: 14000, draft: 0.95, deadrise: 19 * DEG, comFromStern: 0.43,
    engine: { type: 'inboard', idleRpm: 600, maxRpm: 2400, spoolUp: 2.0, spoolDown: 1.1, maxThrust: 41000, revFactor: 0.62, shiftDelay: 0.6, sound: 'diesel', hp: 880 },
    hull: { vTop: 28 * KNOT, vHump: 10 * KNOT, planeMargin: 0.22, swayCd: 1.25, yawDamp: 1.15, liftFrac: 0.5, humpTrim: 0.075, planeTrim: 0.02, stability: 1.0 },
    rudder: { maxAngle: 35 * DEG, minAngleAtSpeed: 20 * DEG, washGain: 0.5, speedGain: 0.14, falloff: 6.5, rate: 110 * DEG, rateAtSpeed: 60 * DEG },
    windage: { side: 26, front: 11, height: 2.1, lead: 0.2 },
    propWalk: 0.13, thruster: 6200, propDepth: 1.05, beachable: false, hornType: 'yacht',
    paintMaterials: ['02___Default'],
    helm: { u: 0.63, v: 0.56, pose: 'sit', wheelHeight: 1.2, eyeHeight: 1.22, back: 0.45, eyeAbove: 0.62 },
    seats: [
      { u: 0.52, v: 0.32, pose: 'sit', face: 0 }, { u: 0.72, v: -0.45, pose: 'sit', face: -Math.PI / 2 },
      { u: 0.72, v: 0.45, pose: 'sit', face: Math.PI / 2 }, { u: 0.86, v: 0.0, pose: 'sit', face: Math.PI },
      { u: 0.22, v: -0.2, pose: 'sitFloor', face: 0 }, { u: 0.22, v: 0.2, pose: 'sitFloor', face: 0 },
    ],
    chase: { dist: 12.5, height: 3.7 },
  },
  marsh: {
    id: 'marsh', name: 'Marsh', kind: '13 ft inflatable RIB', model: 'rib',
    blurb: 'Featherweight fun. Spins in its own length, bounces over chop, jumps wakes.',
    stats: { top: '12 kn', handling: 'Twitchy fun', seats: 3 },
    length: 4.1, beam: 1.9, keelBelowCom: 0.3, deckAboveCom: 0.45,
    mass: 260, draft: 0.16, deadrise: 15 * DEG, comFromStern: 0.4,
    engine: { type: 'outboard', idleRpm: 1000, maxRpm: 5500, spoolUp: 0.55, spoolDown: 0.45, maxThrust: 900, revFactor: 0.7, shiftDelay: 0.15, sound: 'putt', hp: 15 },
    hull: { vTop: 12.5 * KNOT, vHump: 6.5 * KNOT, planeMargin: 0.5, swayCd: 1.1, yawDamp: 1.1, liftFrac: 0.3, humpTrim: 0.05, planeTrim: 0.02, stability: 0.9 },
    rudder: { maxAngle: 34 * DEG, minAngleAtSpeed: 24 * DEG, washGain: 0.9, speedGain: 0.16, falloff: 5, rate: 200 * DEG, rateAtSpeed: 150 * DEG },
    windage: { side: 1.6, front: 1.0, height: 0.4, lead: 0.1 },
    propWalk: 0.04, thruster: 0, propDepth: 0.3, beachable: true, hornType: 'dinghy',
    paintMaterials: ['Zodiac_couleur_boudin.', 'Zodiac_Rouge_Clair', 'Zodiac_Rouge_Fonc'],
    defaultTube: 0xa7adb3,
    helm: { u: 0.76, v: 0.0, pose: 'stand', wheelHeight: 0.95, eyeHeight: 1.55, back: 0.5 },
    seats: [{ u: 0.2, v: 0.0, pose: 'sitFloor', face: 0 }, { u: 0.74, v: -0.2, pose: 'sit', face: 0 }],
    chase: { dist: 7.6, height: 2.3 },
  },
  glades: {
    id: 'glades', name: 'Glades', kind: '20 ft bass boat', model: 'bass',
    blurb: 'Low, sleek and fast. Pad hull that flies flat — light on the helm at speed.',
    stats: { top: '55 kn', handling: 'Responsive', seats: 3 },
    length: 6.3, beam: 2.3, keelBelowCom: 0.45, deckAboveCom: 0.35,
    mass: 1150, draft: 0.33, deadrise: 16 * DEG, comFromStern: 0.38,
    engine: { type: 'outboard', idleRpm: 750, maxRpm: 5800, spoolUp: 1.4, spoolDown: 0.8, maxThrust: 6000, revFactor: 0.6, shiftDelay: 0.3, sound: 'outboard', hp: 250 },
    hull: { vTop: 55 * KNOT, vHump: 9 * KNOT, planeMargin: 0.45, swayCd: 1.0, yawDamp: 0.85, liftFrac: 0.66, humpTrim: 0.05, planeTrim: 0.01, stability: 0.95 },
    rudder: { maxAngle: 33 * DEG, minAngleAtSpeed: 15 * DEG, washGain: 0.4, speedGain: 0.11, falloff: 9, rate: 170 * DEG, rateAtSpeed: 85 * DEG },
    windage: { side: 4.0, front: 2.0, height: 0.6, lead: 0.1 },
    propWalk: 0.05, thruster: 0, propDepth: 0.45, beachable: true, hornType: 'coral',
    paintMaterials: ['Base.001'],
    hideMeshes: ['Passanger'],
    helm: { u: 0.62, v: 0.3, pose: 'sit', wheelHeight: 0.8, eyeHeight: 1.1, back: 0.4 },
    seats: [{ u: 0.5, v: -0.3, pose: 'sit', face: 0 }, { u: 0.16, v: 0.0, pose: 'sitFloor', face: Math.PI }],
    chase: { dist: 10, height: 2.6 },
  },
};

export const BOAT_ORDER = ['coral', 'isabel', 'marsh', 'glades'];
