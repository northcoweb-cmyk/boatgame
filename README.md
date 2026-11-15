# Biscayne Drift

Open-world boating in Miami's Biscayne Bay (three.js, static site). Start in
the backyard of the modern villa, walk to the dock, take the helm.

Run locally: `python3 -m http.server` in this folder, open `http://localhost:8000`.
Optional `?preset=low|medium|high|ultra`.

## Controls (keyboard)
| Key | At the helm | On foot |
| --- | --- | --- |
| W / S | Throttle / reverse | Walk |
| A / D | Steer | Walk |
| E | Start engine (hold: stop) / cast off | Board / interact |
| PgUp / PgDn or ] / [ | Outboard power trim | |
| Z / X | Bow thruster (yacht) | |
| Space | Anchor | |
| F | Docking mode | |
| G | Leave helm | |
| C / V | Camera | First person |
| H | Horn | |
| P / O | Invite guests / hang out | |
| J | Jobs board (charters, gate runs, deliveries, sunset cruise) | Jobs board |
| M | Chart | Chart |
| T | Call TowBoatUS | |
| Tab | | Inventory |
| I / F1 | Details / controls | |

Logitech G920 (with calibration wizard + force feedback) and gamepads are supported.

## Jobs
- **Charter**: pick up a party, drop them off. Slamming waves costs stars and tips.
- **Gate run**: ten buoy gates across open water from where you are; beat par for gold.
- **Delivery**: timed run to a restaurant or marina.
- **Sunset cruise**: guests aboard at Cape Light Key when the sun touches the horizon.

## Trim
Tuck the engine (▼) for a faster hole shot, trim out (▲) once on plane for top
speed. Too much trim at speed makes the hull porpoise.
