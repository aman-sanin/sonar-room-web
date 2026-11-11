# The Sonar Room

> You are blind. Sound is sight.

The Sonar Room is a browser-based echolocation horror game. The screen is almost entirely black. You navigate a maze by emitting sonar pings, reading the wireframe walls revealed by the expanding wavefront, and listening to fully synthesized spatial audio. Find the keys, open a door, and escape before the thing in the dark finds you.

There are no game-art or audio assets. Walls, characters, and the monster are drawn as sound reveals them; every ping, thud, growl, heartbeat, and door tone is generated at runtime with the Web Audio API. (The only bundled image is the logo in `public/`.)

**Status:** playable prototype — solo vs AI and asymmetric two-player hunt. This repository is the reference implementation; the native Kotlin Android port lives in [`../sonar-room`](../sonar-room).

---

## Contents

- [Features](#features)
- [Gameplay](#gameplay)
- [Controls](#controls)
- [Quick start](#quick-start)
- [Production build](#production-build)
- [Architecture](#architecture)
- [Multiplayer protocol](#multiplayer-protocol)
- [Persistence and leaderboard](#persistence-and-leaderboard)
- [Scripts](#scripts)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Native Android port](#native-android-port)
- [Contributing](#contributing)

---

## Features

- **Audio as graphics.** A sonar ping expands as a wavefront; wall segments blink into existence only where the ring touches them, then fade over ~3 seconds.
- **100% procedural audio.** Sonar sweeps, proximity-scheduled wall thuds, cave convolution reverb from a generated impulse, monster screeches/growls/clicks, footsteps, heartbeats, door tones, and win/death stingers. Zero audio files.
- **Seeded mazes.** Every run is generated deterministically from a seed, so both multiplayer devices build the identical map without transmitting geometry.
- **Solo AI hunt.** The monster wakes after a grace period, wanders, investigates heard pings, and chases by sound and proximity.
- **Asymmetric two-player hunt.** One device is the survivor (the prey), the other is the hunter. Both are blind. Pings are shared physical events: the survivor's ping reveals the maze for both and betrays their position; the hunter's echoclick gives both a dim, jagged reveal.
- **Two colored exits and six keys.** The hunt map has crimson and jade doors at opposite ends of the maze, each sealed until its three matching keys are found. Unlocking requires a continuous 3-second channel at the door that resets if interrupted.
- **Desktop and touch controls.** A virtual joystick with pointer capture, deadzone, and gesture-safe handling, plus keyboard/mouse support.
- **Leaderboard and local best.** Fastest escapes are persisted to SQLite; the best solo time is also stored locally.
- **Room codes and rematches.** Four-character codes pair two devices through a tiny Socket.IO relay; both players must agree to a rematch.

---

## Gameplay

### Solo

1. You start somewhere in a 31×21 maze with three white keys and one white exit door.
2. Ping to reveal nearby walls, keys, the door, and the monster. Each ping costs time and makes noise.
3. Collect all three keys. The exit unlocks automatically.
4. Reach the door to escape.
5. The monster wakes after an 8-second grace period. It hears pings within 920 px, investigates the last heard position with a short reaction delay, and chases when it senses you within 150 px. Break line of pursuit for long enough at 310+ px and it loses you.

Death is permanent for the run. Results include escape time, keys found, and pings used.

### Two-player hunt

One player creates a room and chooses a side; the joining player gets the opposite side.

**The prey (survivor)**

- Find three crimson keys and three jade keys (six total) scattered across the maze.
- Each color opens its matching door. Keys of a color are placed farther from their own door than from the other one, forcing crossings.
- Stand within 58 px of a door with all three keys of its color and hold position for 3 continuous seconds. Leaving the radius, dying, or breaking the channel resets the progress.
- Once a door is open, reach it to escape. A ready door emits faint beacon pings so it can be found in the dark.

**The hunter (monster)**

- You are blind too. Your echoclick creates a dim, jagged reveal that also appears on the prey's screen.
- You hear the prey's pings, footsteps, and heartbeat-like proximity cues through stereo panning.
- Catch the prey within 20 px to win.
- Guard two doors at opposite ends of the maze and listen for the lock rattle when the prey starts a 3-second unlock.

Both clients generate the same maze from a seed chosen by the room creator. The survivor's client is authoritative for keys, door progress, the kill, and the final verdict. Both players must press rematch for a new run. If either device disconnects, the other sees **THE LINK IS SEVERED**.

### How sound becomes sight

| Sound | Meaning |
| --- | --- |
| Rising sonar sweep | Your ping wavefront expanding |
| Dull thud | The wavefront struck a nearby wall |
| Harsh screech | The monster is close / has found you |
| Low growl, clicks | The monster moving and echolocating |
| Heartbeat + danger drone | Proximity warning; intensity rises as it nears |
| Chime / jingle | Key picked up / all keys of a color collected |
| Door hum + beacon pings | An exit is ready or open |
| Lock blips and rattle | Someone is working a door's lock |

Stereo pan is derived from the sound source's world X position relative to your body. **Headphones are strongly recommended.**

---

## Controls

| Action | Desktop | Touch |
| --- | --- | --- |
| Move | `W` `A` `S` `D` or arrow keys | Left virtual joystick |
| Ping (prey/solo) / echoclick (hunter) | Left click or `Space` | Tap the canvas |
| Begin / confirm | `Space` or `Enter` on the menu | Tap **BEGIN** |
| Restart / rematch | `R` or `Space` on the end screen | Tap **TRY AGAIN** / **REMATCH** |
| Menu | — | Buttons on the overlay |

The joystick appears automatically on touch-capable devices. It uses pointer capture, `touch-action: none`, an 18% deadzone, and a full-speed remap so a firm push always means full speed.

---

## Quick start

### Prerequisites

- **Bun 1.3+** (recommended; the repo ships `bun.lock`)
- **Node.js 20+** if you prefer npm/pnpm, though Bun is what the scripts assume
- **Caddy 2** only if you want the local multiplayer gateway exactly as deployed
- No external database server — Prisma uses a local SQLite file

### Setup

```bash
bun install
```

Create `.env` in the project root if it does not already exist:

```dotenv
DATABASE_URL=file:../db/custom.db
```

Then create/sync the SQLite schema and generate the Prisma client:

```bash
bun run db:push
```

### Run the web app (solo)

```bash
bun run dev
```

Open <http://localhost:3000>. Solo play works here.

### Run multiplayer

The game connects to the room service through the same origin using the `XTransformPort` query convention:

```ts
io(`/?XTransformPort=3003`, ...)
```

That means the browser page must be served by the gateway, not directly by Next on port 3000. Start the room service and Caddy:

```bash
# terminal 2 — room service on :3003
cd mini-services/room-service
bun install
bun run dev
```

```bash
# terminal 3 — gateway on :81
caddy run --config Caddyfile
```

Open <http://localhost:81>, choose **HUNT · TWO PLAYERS**, and create/join a room.

> **Why the gateway?** `Caddyfile` inspects the `XTransformPort` query parameter and reverse-proxies that request to the named port. Opening `http://localhost:3000` directly sends the request to Next.js instead, so the Socket.IO connection will not reach the room service.
>
> If you do not want to use Caddy, change the Socket.IO URL in `src/components/sonar-room.tsx` to `io('http://localhost:3003', ...)` for local development.

### Run everything at once

```bash
bash scripts/dev.sh
```

This installs dependencies, runs `db:push`, starts Next on `:3000`, and launches the room service. It does **not** start Caddy, so use the gateway or the direct-Socket.IO tweak above for two-player mode.

---

## Production build

The repo is configured as a Next.js standalone deployment with a mini-service and a Caddy gateway.

### Manual

```bash
bun run build
bun run start        # Next standalone server on :3000
```

`bun run build` builds Next and copies `.next/static` and `public` into `.next/standalone`. `bun run start` runs the standalone server with Bun.

Then start the room service and Caddy as described above.

### Packaged artifact

```bash
BUILD_ID=local bash scripts/build.sh
```

`scripts/build.sh`:

1. installs dependencies,
2. builds Next in standalone mode,
3. builds the mini-services into `mini-services-dist`,
4. copies the preview database (or initializes one),
5. copies `Caddyfile` and `start.sh`,
6. packages everything into `/tmp/build_fullstack_${BUILD_ID}.tar.gz`.

The artifact's `start.sh` starts Next, the mini-services, and Caddy (port `:81`, foreground). The deployment harness sets `BUILD_ID`; set it yourself for local packaging.

### Ports

| Port | Service |
| --- | --- |
| `3000` | Next.js (page + `/api/runs`) |
| `3003` | Room service (Socket.IO relay) |
| `81` | Caddy gateway — `/` → Next, `?XTransformPort=N` → service `N` |

---

## Architecture

### High level

```text
┌──────────────────────────── Browser ────────────────────────────┐
│  Next.js App Router (React 19 client component)                │
│    ├─ SonarEngine   maze collision, reveal, AI, camera, render  │
│    ├─ SoundEngine   Web Audio synthesis + spatial panning       │
│    └─ socket.io-client                                          │
└───────────────┬─────────────────────────────────────────────────┘
                │  same origin, ?XTransformPort=3003
┌───────────────▼──────────────┐        ┌─────────────────────────┐
│ Caddy :81                    │        │ Next.js :3000           │
│  /?XTransformPort=* → :3003  │        │  page + /api/runs       │
│  /*                 → :3000  │        │  Prisma → db/custom.db  │
└───────────────┬──────────────┘        └─────────────────────────┘
                │
┌───────────────▼──────────────┐
│ room-service :3003           │
│ Socket.IO relay, rooms, code │
│ No game logic                │
└──────────────────────────────┘
```

The room service is deliberately dumb. It pairs two sockets and forwards `hunt:evt` messages verbatim. The survivor's client owns the run state.

### Source map

| Path | Responsibility |
| --- | --- |
| `src/app/page.tsx` | `/` route; renders the game |
| `src/app/layout.tsx` | Metadata, fonts, viewport (no zoom), toast root |
| `src/app/globals.css` | Tailwind v4 import, theme variables, game keyframes |
| `src/app/api/runs/route.ts` | `GET` fastest escapes, `POST` finished runs |
| `src/components/sonar-room.tsx` | Canvas host, input, HUD, menu/lobby/end screens, network glue |
| `src/lib/game/maze.ts` | Seeded maze generation, BFS, geometry, placements |
| `src/lib/game/engine.ts` | Simulation: movement, pings, reveal, keys, doors, monster AI, camera, rendering |
| `src/lib/game/audio.ts` | Procedural Web Audio engine |
| `src/lib/game/net.ts` | Shared multiplayer protocol types and event union |
| `src/lib/db.ts` | Prisma client singleton |
| `prisma/schema.prisma` | `Run` model (outcome, time, keys, pings) |
| `mini-services/room-service/index.ts` | Socket.IO room manager and relay |
| `scripts/` | Dev, build, packaging, database, and mini-service scripts |
| `tests/fake-survivor.ts` | Scripted peer for multiplayer verification |
| `tests/*.sh` | Deployment helper tests |
| `Caddyfile` | Gateway rules for Next and `XTransformPort` |
| `worklog.md` | Detailed development history and verification notes |

### Simulation constants

Tuning lives at the top of `src/lib/game/engine.ts`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `PING_MAX_R` | `640` | Maximum sonar reveal radius |
| `PING_SPEED` | `500` | Wavefront expansion (px/s) |
| `PING_COOLDOWN` | `1.05` | Seconds between pings |
| `PLAYER_SPEED` | `152` | Movement speed (px/s) |
| `PLAYER_R` | `9` | Player collision radius |
| `SENSE_R` | `150` | Monster proximity sense radius |
| `LOSE_R` | `310` | Distance at which the monster can lose you |
| `HEAR_R` | `920` | Monster hearing range for pings |
| `CATCH_R` | `20` | Catch radius |
| `GRACE` | `8` | Seconds before the monster wakes |
| `UNLOCK_TIME` | `3` | Hunt door channel duration |
| `UNLOCK_R` | `58` | Distance required to work a lock |
| `ESCAPE_R` | `56` | Distance required to exit through an open door |

### Maze generation

- Grid: 31 columns × 21 rows, 46 px cells.
- A recursive backtracker carves the maze, then extra walls are knocked out to create loops and small chambers so the map is not a pure tree.
- A seeded `mulberry32` PRNG makes generation deterministic.
- BFS distances choose fair placements: start, exit door(s), keys, and monster spawn.
- Solo: one white door at the farthest border cell, three white keys.
- Hunt: two doors on opposite ends (crimson/jade), three keys per color. A key of color C must be BFS-farther from door C than from the other door; progressive relax tiers guarantee placement.
- Map edges are cached as merged collinear segments so the reveal renderer can draw long wall lines rather than per-tile squares.

### Audio engine

`src/lib/game/audio.ts` builds the entire graph on the first user gesture (`BEGIN` calls `ensure()`):

- master gain → compressor → destination,
- generated stereo impulse response → convolver → reverb send,
- looping filtered noise for cave ambience,
- continuous danger drone and exit hum gains driven per frame,
- `StereoPannerNode` per event, panned by world X relative to the local body.

Every sound is oscillator/noise based: sonar sweeps, wall thuds, screeches with vibrato and waveshaping, growls, monster clicks, footsteps, chimes, door tones, unlock stingers, heartbeat, win/death stings.

### Rendering and mobile behavior

- Full-screen DPR-aware canvas; camera eases toward the local body; screen shake on danger/death.
- Reveals are stored as per-edge timestamps and strengths (`Float32Array`), not permanent geometry.
- The monster's presence corrupts the ping rings near it.
- Touch: joystick capture on `currentTarget`, `lostpointercapture` safety reset, deadzone, auto-detection on coarse pointers.
- A hydration gate renders a plain black shell during SSR and mounts the full game after hydration. This avoids React mismatches caused by browser extensions injecting nodes into the tree.

---

## Multiplayer protocol

Types live in `src/lib/game/net.ts`.

### Handshake

| Direction | Event | Payload |
| --- | --- | --- |
| client → service | `hunt:create` | `{ role: 'survivor' \| 'monster' }` |
| service → client | ack | `{ ok, code, role, error? }` |
| client → service | `hunt:join` | `{ code }` |
| service → client | ack | `{ ok, code, role, error? }` |
| service → both | `hunt:ready` | `{ myRole, peerRole }` |

Room codes are four characters from an unambiguous alphabet (no `0/O`, no `1/I`). The creator picks a role; the joiner receives the opposite role. The room creator auto-starts 1.5 s after both are linked, choosing the shared seed.

### Relayed game events (`hunt:evt`)

| Event | Direction | Meaning |
| --- | --- | --- |
| `start { seed }` | room creator → joiner | Build this exact hunt maze and begin |
| `pos { x, y, moving }` | both, ~15 Hz | Local body position and movement flag |
| `ping { x, y }` | survivor → hunter | Shared sonar ping; full reveal on both screens |
| `click { x, y }` | hunter → survivor | Monster echolocation; dim jagged reveal on both |
| `keys { i, crimson, jade }` | survivor → hunter | Key `i` taken; authoritative per-color tallies |
| `door { i, color, progress, unlocked }` | survivor → hunter | Door channel progress in 1/8 steps, unlock, or interrupt |
| `end { outcome, timeMs, keysFound, pings, door? }` | survivor → hunter | Final verdict |
| `rematch` | both | Rematch request; both must send it |
| `peer-lost` | service → remaining client | The other socket dropped |

A received `start` is authoritative: the guest rebuilds the world on that seed even if it was mid-run, which prevents the two devices from ending up on different layouts.

---

## Persistence and leaderboard

- SQLite file at `db/custom.db` (path from `DATABASE_URL`).
- `Run` model: `outcome` (`escaped`/`caught`), `timeMs`, `keysFound`, `pings`, `createdAt`.
- `GET /api/runs` returns the five fastest escapes.
- `POST /api/runs` records a finished run. Both endpoints are failure-tolerant; the game still works if the database is unavailable.
- Solo best time is also stored in `localStorage` under `sonar_best_ms`.
- Multiplayer runs do not touch the global leaderboard; the survivor's result screen is local to the session.

---

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Next dev server on `:3000` |
| `bun run build` | Next production build + copy static/public into standalone |
| `bun run start` | Run the standalone server with Bun |
| `bun run lint` | ESLint |
| `bun run db:push` | Sync Prisma schema and generate the client |
| `bun run db:generate` | Generate the Prisma client only |
| `bun run db:migrate` | Create/apply a Prisma migration |
| `bun run db:reset` | Reset the database |
| `bash scripts/dev.sh` | Install, sync DB, start Next + mini-services |
| `bash scripts/build.sh` | Build and package the full deployment artifact |
| `bash scripts/start.sh` | Run a packaged artifact (Next + services + Caddy) |
| `bash tests/database-runtime-build.sh` | Test database packaging behavior |
| `bash tests/python-runtime-build.sh` | Test Python runtime packaging behavior |

The mini-services scripts (`mini-services-install.sh`, `mini-services-build.sh`, `mini-services-start.sh`) are used by the deployment build and can be run directly.

---

## Testing

There is no gameplay unit-test suite yet; the game has been verified in a real browser and with scripted peers. Useful checks:

```bash
bun run lint
bunx tsc --noEmit   # after bun install + db:generate; Next generates next-env.d.ts on first dev/build
```

### Multiplayer harness

`tests/fake-survivor.ts` is a scripted survivor peer used to verify:

- shared-seed maze generation,
- key reveal/retirement behavior on the hunter's screen,
- mid-run re-seeding (both clients must follow the host's `start`),
- key and door event streams.

Run it against a live room service:

```bash
bun tests/fake-survivor.ts
```

It creates a room and logs the code. Join from a second browser as the hunter through the gateway. The script pre-searches seeds so keys land near the hunter's spawn, then pings, re-seeds mid-run, and pings again to exercise the bug fixes.

For manual verification, test at minimum:

1. solo begin, ping/reveal, key pickup, door, death and restart;
2. two devices through the gateway: create/join, both auto-start on the same layout, pings/clicks visible on both, key chips, door channel and interrupt, end screens, rematch, peer-lost;
3. a touch device: joystick visible immediately, capture not stolen by browser gestures, tap-to-ping, no stuck movement after death.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `NO SUCH ROOM IN THE DARK` | Room service not running, wrong gateway, expired code, or the other side disconnected. Restart the service and create a new room. |
| Multiplayer never connects on `localhost:3000` | Open through the Caddy gateway (`:81`) or point `socket.io-client` at `http://localhost:3003`. |
| No audio | Audio starts only after a user gesture. Click **BEGIN**. Check the tab is not muted and use headphones. |
| `DATABASE_URL` / Prisma error | Create `.env` with `DATABASE_URL=file:../db/custom.db`, then `bun run db:push`. |
| Leaderboard fails but the game runs | Expected: the API is failure-tolerant. Check the database and Next server logs. |
| Touch joystick sticks | Update the browser; the pad relies on Pointer Events, pointer capture, and `touch-action: none`. |
| Hydration mismatch with browser extensions | The game uses a client-only hydration gate; if a mismatch persists, disable extensions that rewrite the DOM and report it. |
| Two devices on different maps | Ensure both received the host's `start` seed. The guest rebuilds on every received `start`; do not start a local run from the lobby. |

---

## Native Android port

The shippable product is a native Kotlin APK in the sibling [`sonar-room`](../sonar-room) repository. This web build stays the reference implementation, protocol oracle, and golden-seed generator. The port removes Node, Next.js, Prisma, Socket.IO, and the WebView:

- **Game:** `SurfaceView` + Canvas at a fixed 60 Hz; Compose Foundation for menus and lobby.
- **Audio:** one low-latency `AudioTrack` fed by a software mixer. Every sound is synthesized, panned, distance-attenuated, and sent through a small reverb; ambience, danger, and exit hum are continuous beds.
- **Networking:** in-process TCP host with length-prefixed JSON, UDP discovery, system hotspot flow, and manual IP fallback.
- **Data:** local best time only; no hosted API.

See [`sonar-room/README.md`](../sonar-room/README.md) for build instructions and milestone status.

### Porting constraints

- Replace `[...DIRS].sort(() => rng() - 0.5)` in `maze.ts` with an explicit Fisher–Yates shuffle so Kotlin can reproduce identical maps.
- Keep map arithmetic in `Double`, mirroring JavaScript numbers.
- Keep `mulberry32` bit-for-bit (`Math.imul`, `>>> 0`).
- Generate golden fixtures from this implementation and assert them in Kotlin JVM tests.

### Expansion seams (planned)

The base mobile game stays **1v1**. These are being built into the plumbing so co-op and larger maps are an extension, not a rewrite:

- **`authorityId`** — the session names which client owns shared state. In 1v1 that is the survivor; later the room host becomes the authority.
- **Snapshot envelope** — world state syncs as `snapshot` messages (entities, keys, doors, phase) at ~15 Hz. Two entities today, N later.
- **N-peer room** — the TCP relay models peers as a map, not as `host`/`guest` fields.
- **`GameConfig`** — map dimensions, door/key counts, and player counts travel in the `start` message with current defaults.
- **`snapshot()` / `applySnapshot()`** — an engine boundary that lets the authority broadcast state without coupling the renderer to the network.

Later phases add:

1. Co-op survivors (4) + one monster, with downed/revive, shared objectives, spectator mode, and spatial emotes.
2. Larger maps (`~51×35` to `71×49`) with an edge spatial index, active-reveal culling, cached pathfinding, and audio voice caps.
3. Multiple monsters, difficulty mutators, and decoy/utility items.
4. Optional internet play (separate relay, NAT traversal, and likely UDP snapshots).

None of the native port is built yet beyond the project skeleton; the architecture is documented so new code does not paint the base game into a corner.

---

## Contributing

- Keep balance changes in the constants block at the top of `src/lib/game/engine.ts`.
- Keep the simulation deterministic from the seed; both clients must generate identical maps.
- Preserve the no-assets constraint: new visuals are canvas draws, new sounds are synthesized.
- Run `bun run lint` and `bunx tsc --noEmit` before submitting.
- Verify solo and two-player flows (the list in [Testing](#testing)) after changes to the engine, protocol, or UI.
- Avoid committing new secrets or generated build output. This snapshot currently tracks `.env` and `db/custom.db`; remove them from version control if you fork.

---

## License

No license file is included in this repository. Add one before distributing or accepting contributions.
