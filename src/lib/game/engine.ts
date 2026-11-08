// The Sonar Room — core game engine.
// You are blind: the world only exists for the ~1.5s a ping takes to fade.
// Pings expand as wavefronts; where they touch wall segments the wireframe
// blinks into existence. Sound is spatialized. The thing in the dark hears
// every ping you make.

import {
  GameMap,
  Vec,
  Cell,
  DoorColor,
  DoorSpec,
  generateMap,
  bfsPath,
  cellCenter,
  isSolid,
  nearestOpenCell,
  segDist,
  worldToCell,
} from './maze'
import type { HuntDoorColor, KeyCounts } from './net'
import { SoundEngine } from './audio'

export type EnginePhase = 'idle' | 'playing' | 'dead' | 'win'

export interface RunResult {
  outcome: 'escaped' | 'caught'
  timeMs: number
  keysFound: number
  pings: number
  /** Hunt mode: which door the survivor slipped through. */
  door?: DoorColor
}

export interface EngineHooks {
  /** `takenIndex` is the grabbed key's index in the shared key list (-1 none). */
  onKeys?: (c: KeyCounts, takenIndex?: number) => void
  onToast?: (msg: string) => void
  onEnd?: (r: RunResult) => void
  /** Multiplayer: events the engine asks the component to relay to the peer. */
  onEmit?: (e: HuntEmit) => void
}

/** solo = vs AI · host = survivor, monster is remote · hunter = you are the monster. */
export type EngineMode = 'solo' | 'host' | 'hunter'

export type HuntEmit =
  | { t: 'ping'; x: number; y: number }
  | { t: 'click'; x: number; y: number }
  | { t: 'door'; i: 0 | 1; color: HuntDoorColor; progress: number; unlocked: boolean }

interface Ping {
  ox: number
  oy: number
  r: number
  maxR: number
  speed: number
  owner: 0 | 1 // 0 = player, 1 = monster/door (dimmer, silent reveal)
  hits: Uint8Array
  doorHit: boolean
  jag: number[]
  dead: boolean
}

type MonsterState = 'dormant' | 'wander' | 'investigate' | 'chase'

interface Monster {
  x: number
  y: number
  state: MonsterState
  path: Vec[]
  pathI: number
  target: Cell | null
  repath: number
  lost: number
  growlT: number
  clickT: number
  stepT: number
  pendingAt: number
  pendingX: number
  pendingY: number
  revealT: number
  lastPX: number
  lastPY: number
  /** Multiplayer: latest peer-reported position to ease toward. */
  netX: number
  netY: number
  netMoving: boolean
}

interface KeyItem {
  x: number
  y: number
  color: DoorColor
  found: boolean
  revealT: number
  jT: number
}

interface DoorState {
  spec: DoorSpec
  unlocked: boolean
  /** 0..1 — the survivor's lock-picking channel (3 s of continuous work). */
  progress: number
  revealT: number
  channeling: boolean
  tickT: number
  lastStep: number
  beaconT: number
}

const PING_MAX_R = 640
const PING_SPEED = 500
const PING_COOLDOWN = 1.05
const PLAYER_SPEED = 152
const PLAYER_R = 9
const SENSE_R = 150 // monster senses you this close, ping or not
const LOSE_R = 310 // break this far for long enough and it loses you
const HEAR_R = 920 // it hears any ping made within this range
const CATCH_R = 20
const GRACE = 8 // seconds before the thing wakes up
const UNLOCK_TIME = 3 // seconds of continuous work to open a hunt door
const UNLOCK_R = 58 // stand this close to work a lock
const ESCAPE_R = 56 // slip out through an open hunt door

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const expFade = (age: number, tau: number): number => Math.exp(-age / tau)

export class SonarEngine {
  map: GameMap | null = null
  phase: EnginePhase = 'idle'
  time = 0
  cooldown = 0
  pingsUsed = 0
  keysFound = 0
  danger = 0
  input = { x: 0, y: 0 }
  mode: EngineMode = 'solo'

  private player = { x: 0, y: 0 }
  private cam = { x: 0, y: 0 }
  private monster: Monster | null = null
  private keys: KeyItem[] = []
  private doorState: DoorState[] = []
  private pings: Ping[] = []
  private revealT: Float32Array = new Float32Array(0)
  private revealS: Float32Array = new Float32Array(0)
  private shake = 0
  private hbT = 0
  private stepT = 0
  private thudGate = 0
  private screechGate = 0
  private beaconT = 0
  private graceAnnounced = false
  private chaseAnnounced = false
  private deathAt = 0
  private winAt = 0
  private seed = 1

  constructor(
    private audio: SoundEngine,
    private hooks: EngineHooks = {},
  ) {}

  private panOf(x: number): number {
    return clamp((x - this.player.x) / 300, -1, 1)
  }

  private volByDist(d: number, range: number): number {
    return clamp(1 - d / range, 0, 1)
  }

  start(seed = Math.floor(Math.random() * 1e9)): void {
    this.seed = seed
    // Hunt mode (2-player) builds the two-door variant of the maze.
    this.map = generateMap(seed, this.mode !== 'solo')
    const n = this.map.edges.length
    this.revealT = new Float32Array(n).fill(-99)
    this.revealS = new Float32Array(n)
    // In hunter mode the LOCAL body is the monster; the "monster" slot
    // holds the remote survivor ghost. Audio panning stays relative to
    // the local body either way.
    this.player = this.mode === 'hunter' ? { ...this.map.monsterStart } : { ...this.map.start }
    this.cam = { ...this.player }
    this.keys = this.map.keys.map((k) => ({
      x: k.x,
      y: k.y,
      color: k.color,
      found: false,
      revealT: -99,
      jT: 1 + Math.random() * 2,
    }))
    this.doorState = this.map.doors.map((spec) => ({
      spec,
      unlocked: false,
      progress: 0,
      revealT: -99,
      channeling: false,
      tickT: 0,
      lastStep: -1,
      beaconT: 0,
    }))
    const m: Monster = {
      x: this.mode === 'hunter' ? this.map.start.x : this.map.monsterStart.x,
      y: this.mode === 'hunter' ? this.map.start.y : this.map.monsterStart.y,
      state: 'dormant',
      path: [],
      pathI: 0,
      target: null,
      repath: 0,
      lost: 0,
      growlT: 2 + Math.random() * 3,
      clickT: 3 + Math.random() * 3,
      stepT: 0,
      pendingAt: 0,
      pendingX: 0,
      pendingY: 0,
      revealT: -99,
      lastPX: 0,
      lastPY: 0,
      netX: 0,
      netY: 0,
      netMoving: false,
    }
    m.netX = m.x
    m.netY = m.y
    this.monster = m
    this.pings = []
    this.time = 0
    this.cooldown = 0
    this.pingsUsed = 0
    this.keysFound = 0
    this.danger = 0
    this.shake = 0
    this.thudGate = 0
    this.screechGate = 0
    this.beaconT = 0
    this.graceAnnounced = false
    this.chaseAnnounced = false
    this.phase = 'playing'
    this.audio.setDanger(0)
    this.audio.setExitHum(0)
    this.hooks.onKeys?.({ total: 0, crimson: 0, jade: 0 })
    this.hooks.onToast?.(
      this.mode === 'hunter'
        ? 'SOMETHING FLESH IS IN THE DARK — LISTEN'
        : this.mode === 'host'
          ? 'FIND THE COLORED KEYS — QUIETLY'
          : 'FIND THE KEYS — QUIETLY',
    )
  }

  /** Emit a sonar ping — or, as the hunter, an echolocation click. Costs noise. */
  ping(): boolean {
    if (this.phase !== 'playing' || this.cooldown > 0 || !this.map) return false
    this.cooldown = PING_COOLDOWN
    this.pingsUsed++
    if (this.mode === 'hunter') {
      this.pings.push(this.makePing(this.player.x, this.player.y, 1, 430, 440))
      this.audio.monsterClick(0, 0.32)
      this.hooks.onEmit?.({ t: 'click', x: this.player.x, y: this.player.y })
      return true
    }
    this.pings.push(this.makePing(this.player.x, this.player.y, 0, PING_MAX_R, PING_SPEED))
    this.audio.ping()
    if (this.mode === 'host') {
      this.hooks.onEmit?.({ t: 'ping', x: this.player.x, y: this.player.y })
    }
    const m = this.monster
    if (this.mode === 'solo' && m && m.state !== 'chase' && this.time > GRACE) {
      const d = Math.hypot(this.player.x - m.x, this.player.y - m.y)
      if (d < HEAR_R) {
        m.pendingAt = this.time + 0.35
        m.pendingX = this.player.x
        m.pendingY = this.player.y
      }
    }
    return true
  }

  private makePing(ox: number, oy: number, owner: 0 | 1, maxR: number, speed: number): Ping {
    const jag: number[] = []
    for (let i = 0; i < 48; i++) jag.push((Math.random() - 0.5) * 2)
    return {
      ox,
      oy,
      r: 2,
      maxR,
      speed,
      owner,
      hits: new Uint8Array(this.map ? this.map.edges.length : 0),
      doorHit: false,
      jag,
      dead: false,
    }
  }

  // ------------------------------------------------------------- collision

  private hitsWall(x: number, y: number): boolean {
    const map = this.map
    if (!map) return false
    const c0 = Math.floor((x - PLAYER_R) / map.cell)
    const c1 = Math.floor((x + PLAYER_R) / map.cell)
    const r0 = Math.floor((y - PLAYER_R) / map.cell)
    const r1 = Math.floor((y + PLAYER_R) / map.cell)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!isSolid(map, c, r)) continue
        const rx = c * map.cell
        const ry = r * map.cell
        const nx = clamp(x, rx, rx + map.cell)
        const ny = clamp(y, ry, ry + map.cell)
        if (Math.hypot(x - nx, y - ny) < PLAYER_R) return true
      }
    }
    return false
  }

  // ---------------------------------------------------------------- update

  update(dt: number): void {
    this.time += dt
    this.cooldown = Math.max(0, this.cooldown - dt)
    this.thudGate -= dt
    this.screechGate -= dt
    this.shake = Math.max(0, this.shake - dt * 1.6)

    this.updatePings(dt)

    if (this.phase === 'playing') {
      this.updatePlayer(dt)
      if (this.mode === 'hunter') {
        this.updateGhost(dt)
        this.updateDanger(dt)
      } else if (this.mode === 'host') {
        this.updateRemoteMonster(dt)
        this.updateKeys(dt)
        this.updateDoors(dt)
        this.updateDanger(dt)
      } else {
        this.updateMonster(dt)
        this.updateKeys(dt)
        this.updateDoors(dt)
        this.updateDanger(dt)
      }
    } else {
      this.danger = Math.max(0, this.danger - dt * 0.8)
      this.audio.setDanger(this.danger)
    }

    // Camera follows.
    const k = Math.min(1, dt * 4.5)
    this.cam.x += (this.player.x - this.cam.x) * k
    this.cam.y += (this.player.y - this.cam.y) * k
  }

  private updatePings(dt: number): void {
    const map = this.map
    if (!map) return
    for (const p of this.pings) {
      const rPrev = p.r
      p.r = Math.min(p.maxR, p.r + p.speed * dt)
      if (p.owner === 0 || p.owner === 1) {
        // Edge crossings.
        let soundBudget = 2
        for (let i = 0; i < map.edges.length; i++) {
          if (p.hits[i]) continue
          const e = map.edges[i]
          const mx = (e.x1 + e.x2) / 2
          const my = (e.y1 + e.y2) / 2
          // Cheap reject by bounding box.
          const bx = Math.min(e.x1, e.x2) - p.r
          if (p.ox < bx || p.ox > Math.max(e.x1, e.x2) + p.r) {
            if (Math.abs(p.ox - mx) > p.r) continue
          }
          const d = segDist(p.ox, p.oy, e.x1, e.y1, e.x2, e.y2)
          if (d <= p.r && d > rPrev - 0.5) {
            p.hits[i] = 1
            const strength = clamp(1.08 - d / 720, 0.28, 1) * (p.owner === 1 ? 0.5 : 1)
            if (strength > this.revealS[i] * expFade(this.time - this.revealT[i], 0.55)) {
              this.revealS[i] = strength
              this.revealT[i] = this.time
            }
            if (p.owner === 0 && this.phase === 'playing' && soundBudget > 0 && this.thudGate <= 0) {
              const vol = strength * clamp(1.2 - d / 620, 0.2, 1) * 0.85
              this.audio.thud(this.panOf(mx), vol)
              soundBudget--
              this.thudGate = 0.045
            }
          }
        }
        // Door reveals.
        for (const ds of this.doorState) {
          const dd = Math.hypot(ds.spec.midX - p.ox, ds.spec.midY - p.oy)
          if (dd <= p.r && dd > rPrev - 0.5) {
            ds.revealT = this.time
            if (p.owner === 0 && !p.doorHit && this.phase === 'playing') {
              p.doorHit = true
              this.audio.doorTone(this.panOf(ds.spec.midX), this.volByDist(dd, 640) * 0.5 + 0.05)
            }
          }
        }
        // Key reveals.
        for (const k of this.keys) {
          if (k.found) continue
          const kd = Math.hypot(k.x - p.ox, k.y - p.oy)
          if (kd <= p.r && kd > rPrev - 0.5) {
            k.revealT = this.time
            if (p.owner === 0 && this.phase === 'playing') {
              this.audio.jingle(this.panOf(k.x), 0.16)
            }
          }
        }
        // Monster / survivor-ghost reveal (only survivor pings screech).
        const m = this.monster
        if (m && p.owner === 0) {
          const md = Math.hypot(m.x - p.ox, m.y - p.oy)
          if (md <= p.r && md > rPrev - 0.5) {
            m.revealT = this.time
            if (this.phase === 'playing' && this.mode !== 'hunter' && this.screechGate <= 0) {
              this.audio.screech(this.panOf(m.x), clamp(0.6 - md / 1400, 0.22, 0.6))
              this.screechGate = 1.5
              if (this.mode === 'solo' && m.state !== 'chase' && this.time > GRACE) {
                m.pendingAt = this.time + 0.3
                m.pendingX = this.player.x
                m.pendingY = this.player.y
              }
            }
          }
        }
      }
      if (p.r >= p.maxR) p.dead = true
    }
    this.pings = this.pings.filter((p) => !p.dead)
  }

  private updatePlayer(dt: number): void {
    let { x, y } = this.input
    const l = Math.hypot(x, y)
    if (l > 1) {
      x /= l
      y /= l
    }
    const moving = l > 0.08
    const sp = PLAYER_SPEED
    const nx = this.player.x + x * sp * dt
    if (!this.hitsWall(nx, this.player.y)) this.player.x = nx
    const ny = this.player.y + y * sp * dt
    if (!this.hitsWall(this.player.x, ny)) this.player.y = ny

    if (moving) {
      this.stepT -= dt
      if (this.stepT <= 0) {
        this.stepT = this.mode === 'hunter' ? 0.3 : 0.34
        if (this.mode === 'hunter') this.audio.monsterStep(0, 0.05)
        else this.audio.step(0.045)
      }
    }
  }

  private updateKeys(dt: number): void {
    for (let ki = 0; ki < this.keys.length; ki++) {
      const k = this.keys[ki]
      if (k.found) continue
      const d = Math.hypot(this.player.x - k.x, this.player.y - k.y)
      // Faint jingle hints when a key is close by.
      k.jT -= dt
      if (d < 300 && k.jT <= 0) {
        k.jT = 3.1 + Math.random() * 1.6
        this.audio.jingle(this.panOf(k.x), 0.05 + 0.1 * this.volByDist(d, 300))
      }
      if (d < 24) {
        k.found = true
        this.keysFound++
        this.audio.chime(this.panOf(k.x), 0.5)
        const counts = this.counts()
        this.hooks.onKeys?.(counts, ki)
        if (this.mode === 'solo') {
          if (this.keysFound >= 3) {
            const d0 = this.doorState[0]
            if (d0) d0.unlocked = true
            this.audio.unlock()
            this.hooks.onToast?.('THE DOOR IS OPEN')
            const m = this.monster
            if (m && m.state === 'dormant') m.state = 'wander'
          }
        } else if (k.color !== 'white' && counts[k.color] >= 3) {
          this.hooks.onToast?.(`ALL ${k.color.toUpperCase()} KEYS — THAT DOOR CAN BE UNLOCKED`)
        }
      }
    }
  }

  private counts(): KeyCounts {
    let crimson = 0
    let jade = 0
    for (const k of this.keys) {
      if (!k.found) continue
      if (k.color === 'crimson') crimson++
      else if (k.color === 'jade') jade++
    }
    return { total: this.keysFound, crimson, jade }
  }

  private keysOf(color: DoorColor): number {
    let n = 0
    for (const k of this.keys) if (k.found && k.color === color) n++
    return n
  }

  private updateDoors(dt: number): void {
    const map = this.map
    if (!map) return
    let hum = 0
    for (let i = 0; i < this.doorState.length; i++) {
      const ds = this.doorState[i]
      const d = Math.hypot(this.player.x - ds.spec.midX, this.player.y - ds.spec.midY)

      if (ds.unlocked) {
        // Open door: hum + beacon pings, and the way out.
        hum = Math.max(hum, this.volByDist(d, 300))
        ds.beaconT -= dt
        if (ds.beaconT <= 0) {
          ds.beaconT = 2.4
          this.pings.push(this.makePing(ds.spec.midX, ds.spec.midY, 1, 170, 320))
          if (d < 620)
            this.audio.doorBlip(this.panOf(ds.spec.midX), 0.05 + 0.14 * this.volByDist(d, 620))
        }
        if (this.phase === 'playing' && d < (this.mode === 'solo' ? 42 : ESCAPE_R)) {
          this.finishEscape(i)
        }
        continue
      }

      if (this.mode !== 'host') continue

      // --- Hunt lock channel: all 3 keys of this door's color, then hold
      //     still beside it for three full seconds. Step away and the lock
      //     slams back shut. ---
      const ready = this.keysOf(ds.spec.color) >= 3
      if (ready && d < UNLOCK_R) {
        if (!ds.channeling) {
          ds.channeling = true
          ds.tickT = 0
          this.hooks.onToast?.('UNLOCKING — HOLD STILL')
        }
        ds.progress += dt / UNLOCK_TIME
        ds.tickT -= dt
        if (ds.tickT <= 0) {
          ds.tickT = 0.75
          this.audio.doorBlip(0, 0.1 + 0.22 * ds.progress)
        }
        const step = Math.floor(ds.progress * 8)
        if (step !== ds.lastStep) {
          ds.lastStep = step
          this.emitDoor(i, ds)
        }
        if (ds.progress >= 1) {
          ds.progress = 1
          ds.unlocked = true
          ds.channeling = false
          this.audio.unlock(this.panOf(ds.spec.midX))
          this.hooks.onToast?.(`THE ${ds.spec.color.toUpperCase()} DOOR IS OPEN — GO`)
          this.emitDoor(i, ds)
        }
      } else {
        if (ds.channeling && ds.progress > 0.08) {
          this.hooks.onToast?.('UNLOCK INTERRUPTED')
          this.audio.thud(this.panOf(ds.spec.midX), 0.3)
        }
        if (ds.channeling && ds.progress > 0) {
          ds.progress = 0
          ds.lastStep = -1
          this.emitDoor(i, ds)
        }
        ds.channeling = false
      }

      // A lock you can work calls to you — a faint beacon marks the door.
      if (ready) {
        ds.beaconT -= dt
        if (ds.beaconT <= 0) {
          ds.beaconT = 3.4
          this.pings.push(this.makePing(ds.spec.midX, ds.spec.midY, 1, 190, 300))
          if (d < 520)
            this.audio.doorBlip(this.panOf(ds.spec.midX), 0.03 + 0.09 * this.volByDist(d, 520))
        }
      }
    }
    this.audio.setExitHum(hum)
  }

  private finishEscape(doorIndex: number): void {
    if (this.phase !== 'playing') return
    this.winAt = this.time
    this.phase = 'win'
    this.audio.setDanger(0)
    this.audio.setExitHum(0)
    this.audio.win()
    this.hooks.onEnd?.({
      outcome: 'escaped',
      timeMs: Math.round(this.time * 1000),
      keysFound: this.keysFound,
      pings: this.pingsUsed,
      door: this.doorState[doorIndex]?.spec.color,
    })
  }

  private emitDoor(i: number, ds: DoorState): void {
    if (ds.spec.color === 'white') return // solo doors never go over the wire
    const progress = Math.min(1, Math.round(ds.progress * 100) / 100)
    this.hooks.onEmit?.({
      t: 'door',
      i: i as 0 | 1,
      color: ds.spec.color,
      progress,
      unlocked: ds.unlocked,
    })
  }

  private updateDanger(dt: number): void {
    const m = this.monster
    if (!m) return
    if (this.time > GRACE) {
      if (!this.graceAnnounced) {
        this.graceAnnounced = true
        this.hooks.onToast?.(
          this.mode === 'solo'
            ? 'SOMETHING IS AWAKE'
            : this.mode === 'hunter'
              ? 'THE PREY IS SOMEWHERE — IT PINGS'
              : 'IT IS SOMEWHERE — LISTENING',
        )
        this.audio.growl(this.panOf(m.x), 0.5)
      }
      const d = Math.hypot(this.player.x - m.x, this.player.y - m.y)
      let target = clamp(1 - d / 340, 0, 1)
      if (m.state !== 'chase') target *= 0.6
      this.danger += (target - this.danger) * Math.min(1, dt * 4)
      if (this.danger > 0.04) {
        this.hbT -= dt
        if (this.hbT <= 0) {
          this.hbT = 1.15 - 0.68 * this.danger
          this.audio.heartbeat(0.1 + 0.45 * this.danger)
        }
      }
      if (m.state === 'chase') this.shake = Math.max(this.shake, this.danger * 0.55)
    }
    this.audio.setDanger(this.danger)
  }

  // -------------------------------------------------------------- monster

  private updateMonster(dt: number): void {
    const map = this.map
    const m = this.monster
    if (!map || !m) return
    if (m.state === 'dormant') {
      if (this.time > GRACE) m.state = 'wander'
      return
    }

    const d = Math.hypot(this.player.x - m.x, this.player.y - m.y)
    const mc = worldToCell(map, m.x, m.y)

    // Sense the player up close — no ping needed.
    if (d < SENSE_R && m.state !== 'chase') {
      m.state = 'chase'
      m.path = []
      m.repath = 0
      m.lost = 0
      if (this.screechGate <= 0) {
        this.audio.screech(this.panOf(m.x), 0.65)
        this.screechGate = 1.2
      }
      if (!this.chaseAnnounced) {
        this.chaseAnnounced = true
        this.hooks.onToast?.('RUN')
      }
    }

    // A ping it heard (delayed reaction).
    if (m.pendingAt > 0 && this.time >= m.pendingAt) {
      m.pendingAt = 0
      if (m.state !== 'chase') {
        const cell = nearestOpenCell(map, ...this.cellOfPoint(m.pendingX, m.pendingY))
        m.state = 'investigate'
        m.target = cell
        m.path = bfsPath(map, mc.c, mc.r, cell.c, cell.r)
        m.pathI = 0
      }
    }

    let speed = 60
    if (m.state === 'chase') {
      speed = 148 + this.keysFound * 8
      m.lastPX = this.player.x
      m.lastPY = this.player.y
      if (d > LOSE_R) {
        m.lost += dt
        if (m.lost > 2.2) {
          m.state = 'investigate'
          m.target = nearestOpenCell(map, ...this.cellOfPoint(m.lastPX, m.lastPY))
          m.path = bfsPath(map, mc.c, mc.r, m.target.c, m.target.r)
          m.pathI = 0
        }
      } else {
        m.lost = 0
      }
      m.repath -= dt
      const pc = worldToCell(map, this.player.x, this.player.y)
      if (m.repath <= 0) {
        m.repath = 0.32
        m.path = bfsPath(map, mc.c, mc.r, pc.c, pc.r)
        m.pathI = 0
      }
      m.clickT -= dt
      if (m.clickT <= 0) {
        m.clickT = 2.6
        this.monsterClick(m)
      }
      m.stepT -= dt
      if (m.stepT <= 0 && d < 460) {
        m.stepT = 0.27
        this.audio.monsterStep(this.panOf(m.x), 0.1 + 0.3 * this.volByDist(d, 460))
      }
    } else if (m.state === 'investigate') {
      speed = 98
      if (!m.target || m.pathI >= m.path.length) {
        m.state = 'wander'
        m.target = null
        m.path = []
      }
      m.clickT -= dt
      if (m.clickT <= 0) {
        m.clickT = 4.5 + Math.random() * 2.5
        this.monsterClick(m)
      }
    } else {
      // wander — it drifts through the dark, but its instinct pulls it
      // toward your region of the maze (biased random walk).
      speed = 60
      if (m.pathI >= m.path.length) {
        const cands: Cell[] = []
        for (let i = 0; i < 8; i++) {
          const c = clamp(mc.c + Math.floor((Math.random() - 0.5) * 22), 1, map.cols - 2)
          const r = clamp(mc.r + Math.floor((Math.random() - 0.5) * 16), 1, map.rows - 2)
          const cell = nearestOpenCell(map, c, r)
          if (Math.hypot(cell.c - mc.c, cell.r - mc.r) >= 3) cands.push(cell)
        }
        if (cands.length > 0) {
          let pick = cands[Math.floor(Math.random() * cands.length)]
          if (Math.random() < 0.6) {
            const pc = worldToCell(map, this.player.x, this.player.y)
            for (const c of cands) {
              if (
                Math.hypot(c.c - pc.c, c.r - pc.r) <
                Math.hypot(pick.c - pc.c, pick.r - pc.r)
              ) {
                pick = c
              }
            }
          }
          m.path = bfsPath(map, mc.c, mc.r, pick.c, pick.r)
          m.pathI = 0
        }
      }
      m.growlT -= dt
      if (m.growlT <= 0) {
        m.growlT = 3.5 + Math.random() * 4.5
        this.audio.growl(this.panOf(m.x), 0.06 + 0.4 * this.volByDist(d, 560))
      }
      m.clickT -= dt
      if (m.clickT <= 0) {
        m.clickT = 6 + Math.random() * 3
        this.monsterClick(m)
      }
    }

    // Follow path.
    if (m.pathI < m.path.length) {
      const wp = m.path[m.pathI]
      const dx = wp.x - m.x
      const dy = wp.y - m.y
      const dl = Math.hypot(dx, dy)
      if (dl < 6) {
        m.pathI++
      } else {
        m.x += (dx / dl) * speed * dt
        m.y += (dy / dl) * speed * dt
      }
    }

    // Catch.
    this.checkCatch(d)
  }

  private checkCatch(d: number): void {
    if (d >= CATCH_R || this.phase !== 'playing') return
    const m = this.monster
    this.deathAt = this.time
    this.phase = 'dead'
    this.shake = 1.4
    this.audio.setDanger(0)
    this.audio.setExitHum(0)
    this.audio.death()
    if (m) m.revealT = this.time
    this.hooks.onEnd?.({
      outcome: 'caught',
      timeMs: Math.round(this.time * 1000),
      keysFound: this.keysFound,
      pings: this.pingsUsed,
    })
  }

  // ------------------------------------------------------------ multiplayer

  /** Host side: ease the monster toward the hunter's reported position. */
  private updateRemoteMonster(dt: number): void {
    const m = this.monster
    if (!m) return
    const k = Math.min(1, dt * 14)
    m.x += (m.netX - m.x) * k
    m.y += (m.netY - m.y) * k
    if (m.netMoving) {
      m.stepT -= dt
      if (m.stepT <= 0) {
        m.stepT = 0.3
        const d = Math.hypot(this.player.x - m.x, this.player.y - m.y)
        if (d < 560) this.audio.monsterStep(this.panOf(m.x), 0.06 + 0.3 * this.volByDist(d, 560))
      }
    }
    this.checkCatch(Math.hypot(this.player.x - m.x, this.player.y - m.y))
  }

  /** Hunter side: the survivor ghost eases toward reported positions. */
  private updateGhost(dt: number): void {
    const m = this.monster
    if (!m) return
    const k = Math.min(1, dt * 14)
    m.x += (m.netX - m.x) * k
    m.y += (m.netY - m.y) * k
    if (m.netMoving) {
      m.stepT -= dt
      if (m.stepT <= 0) {
        m.stepT = 0.34
        const d = Math.hypot(this.player.x - m.x, this.player.y - m.y)
        if (d < 700) this.audio.step(0.03 + 0.3 * this.volByDist(d, 700), this.panOf(m.x))
      }
    }
  }

  setRemoteMonster(x: number, y: number, moving: boolean): void {
    const m = this.monster
    if (!m) return
    m.netX = x
    m.netY = y
    m.netMoving = moving
  }

  setRemoteSurvivor(x: number, y: number, moving: boolean): void {
    this.setRemoteMonster(x, y, moving)
  }

  /** Host side: the hunter's echolocation click, arriving over the wire. */
  netMonsterClick(x: number, y: number): void {
    if (this.phase !== 'playing' || !this.map) return
    const d = Math.hypot(this.player.x - x, this.player.y - y)
    this.audio.monsterClick(this.panOf(x), 0.05 + 0.3 * this.volByDist(d, 700))
    this.pings.push(this.makePing(x, y, 1, 430, 440))
  }

  /** Hunter side: the survivor's sonar ping, arriving over the wire. */
  netSurvivorPing(x: number, y: number): void {
    if (this.phase !== 'playing' || !this.map) return
    const d = Math.hypot(this.player.x - x, this.player.y - y)
    this.audio.pingHeard(this.panOf(x), 0.3 + 0.7 * this.volByDist(d, 900))
    this.pings.push(this.makePing(x, y, 0, PING_MAX_R, PING_SPEED))
  }

  /**
   * Hunter side: the prey grabbed a key — retire that exact key from our
   * world too, or our pings keep re-revealing a key that is already gone.
   * The tally arrives authoritative from the survivor's client.
   */
  netKeyTaken(i: number, crimson: number, jade: number): void {
    if (this.phase !== 'playing') return
    const k = i >= 0 ? this.keys[i] : undefined
    if (k && !k.found) {
      k.found = true
      // Everything in this room is sound: the pickup itself rings out from
      // where it happened, so the hunter can guess where the prey just stood.
      const d = Math.hypot(this.player.x - k.x, this.player.y - k.y)
      this.audio.chime(this.panOf(k.x), 0.05 + 0.22 * this.volByDist(d, 720))
    }
    this.keysFound = crimson + jade
  }

  /** Hunter side: the prey is working a lock — hear it, and the door burns. */
  netDoorProgress(i: number, progress: number, unlocked: boolean): void {
    const ds = this.doorState[i]
    if (!ds || this.phase !== 'playing') return
    ds.progress = progress
    ds.unlocked = unlocked
    if (unlocked) {
      ds.revealT = this.time
      this.audio.unlock(this.panOf(ds.spec.midX))
    } else if (progress > 0) {
      ds.revealT = this.time
      this.audio.doorBlip(this.panOf(ds.spec.midX), 0.08 + 0.24 * progress)
    }
  }

  get doorColors(): DoorColor[] {
    return this.doorState.map((d) => d.spec.color)
  }

  get playerPos(): { x: number; y: number } {
    return { x: this.player.x, y: this.player.y }
  }

  get otherPos(): { x: number; y: number } {
    const m = this.monster
    return m ? { x: m.x, y: m.y } : { x: -9999, y: -9999 }
  }

  private cellOfPoint(x: number, y: number): [number, number] {
    const map = this.map
    if (!map) return [1, 1]
    const c = worldToCell(map, x, y)
    return [c.c, c.r]
  }

  /** The monster emits its own echolocation — you see the world flash through ITS senses. */
  private monsterClick(m: Monster): void {
    const d = Math.hypot(this.player.x - m.x, this.player.y - m.y)
    this.audio.monsterClick(this.panOf(m.x), 0.05 + 0.3 * this.volByDist(d, 700))
    this.pings.push(this.makePing(m.x, m.y, 1, 430, 440))
  }

  // ---------------------------------------------------------------- render

  render(ctx: CanvasRenderingContext2D, cw: number, ch: number, dpr: number): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, cw, ch)
    const map = this.map
    if (!map) return
    const t = this.time

    const zoom = clamp(Math.min(cw, ch) / 660, 0.9, 1.5)
    const sh = this.shake
    const sx = (Math.random() - 0.5) * 12 * sh
    const sy = (Math.random() - 0.5) * 12 * sh

    ctx.save()
    ctx.translate(cw / 2 + sx, ch / 2 + sy)
    ctx.scale(zoom, zoom)
    ctx.translate(-this.cam.x, -this.cam.y)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // --- Revealed wall wireframes ---
    for (let i = 0; i < map.edges.length; i++) {
      const age = t - this.revealT[i]
      if (age > 3 || age < 0) continue
      const a = this.revealS[i] * expFade(age, 0.55)
      if (a < 0.015) continue
      const e = map.edges[i]
      ctx.strokeStyle = `rgba(255,255,255,${(a * 0.22).toFixed(3)})`
      ctx.lineWidth = 5
      ctx.beginPath()
      ctx.moveTo(e.x1, e.y1)
      ctx.lineTo(e.x2, e.y2)
      ctx.stroke()
      ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.moveTo(e.x1, e.y1)
      ctx.lineTo(e.x2, e.y2)
      ctx.stroke()
    }

    // --- Exit doors (solo: one white · hunt: crimson + jade) ---
    const doorRgb = (c: DoorColor): [number, number, number] =>
      c === 'crimson' ? [255, 70, 86] : c === 'jade' ? [86, 255, 168] : [255, 255, 255]

    for (const ds of this.doorState) {
      const dAge = t - ds.revealT
      const dA = dAge >= 0 ? expFade(dAge, 0.6) : 0
      // A lock being worked burns through the dark on both sides of the wire.
      const chanA = ds.progress > 0 && !ds.unlocked ? 0.42 : 0
      const baseA = Math.max(dA, chanA)
      if (baseA <= 0.02) continue
      const [cr, cg, cb] = doorRgb(ds.spec.color)
      const door = ds.spec
      const depth = 16
      const half = map.cell / 2 - 6
      ctx.save()
      ctx.translate(door.midX, door.midY)
      if (door.vertical) {
        const dir = door.midX < map.w / 2 ? 1 : -1
        const pulse = ds.unlocked ? 0.65 + 0.35 * Math.sin(t * 5) : 1
        const a = baseA * pulse
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(a * 0.9).toFixed(3)})`
        ctx.lineWidth = 2
        ctx.strokeRect(dir > 0 ? -depth : 0, -half, depth, half * 2)
        if (!ds.unlocked) {
          // Sealed: cross bars.
          ctx.beginPath()
          ctx.moveTo(dir > 0 ? -depth : 0, -half)
          ctx.lineTo(dir > 0 ? 0 : depth, half)
          ctx.moveTo(dir > 0 ? -depth : 0, half)
          ctx.lineTo(dir > 0 ? 0 : depth, -half)
          ctx.stroke()
        } else {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(a * 0.5).toFixed(3)})`
          ctx.strokeRect(dir > 0 ? -depth + 4 : 4, -half + 5, depth - 8, half * 2 - 10)
        }
      } else {
        const dir = door.midY < map.h / 2 ? 1 : -1
        const pulse = ds.unlocked ? 0.65 + 0.35 * Math.sin(t * 5) : 1
        const a = baseA * pulse
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(a * 0.9).toFixed(3)})`
        ctx.lineWidth = 2
        ctx.strokeRect(-half, dir > 0 ? -depth : 0, half * 2, depth)
        if (!ds.unlocked) {
          ctx.beginPath()
          ctx.moveTo(-half, dir > 0 ? -depth : 0)
          ctx.lineTo(half, dir > 0 ? 0 : depth)
          ctx.moveTo(-half, dir > 0 ? 0 : depth)
          ctx.lineTo(half, dir > 0 ? -depth : 0)
          ctx.stroke()
        } else {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(a * 0.5).toFixed(3)})`
          ctx.strokeRect(-half + 5, dir > 0 ? -depth + 4 : 4, half * 2 - 10, depth - 8)
        }
      }
      // Lock-picking progress ring.
      if (ds.progress > 0 && !ds.unlocked) {
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.95)`
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.arc(0, 0, 30, -Math.PI / 2, -Math.PI / 2 + ds.progress * Math.PI * 2)
        ctx.stroke()
      }
      ctx.restore()
    }

    // --- Keys (colored to match their door) ---
    for (const k of this.keys) {
      if (k.found) continue
      const age = t - k.revealT
      if (age < 0 || age > 2.4) continue
      const a = expFade(age, 0.6)
      if (a < 0.02) continue
      const [kr, kg, kb] = doorRgb(k.color)
      const rot = t * 1.2 + k.x * 0.01
      ctx.save()
      ctx.translate(k.x, k.y)
      ctx.rotate(rot)
      ctx.strokeStyle = `rgba(${kr},${kg},${kb},${(a * 0.95).toFixed(3)})`
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.moveTo(0, -10)
      ctx.lineTo(7, 0)
      ctx.lineTo(0, 10)
      ctx.lineTo(-7, 0)
      ctx.closePath()
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, -3.5)
      ctx.lineTo(2.6, 0)
      ctx.lineTo(0, 3.5)
      ctx.lineTo(-2.6, 0)
      ctx.closePath()
      ctx.stroke()
      ctx.restore()
    }

    // --- Ping rings ---
    for (const p of this.pings) {
      const base = 1 - p.r / p.maxR
      if (p.owner === 0) {
        const a = base * 0.9
        ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(p.ox, p.oy, p.r, 0, Math.PI * 2)
        ctx.stroke()
        const r2 = p.r - 18
        if (r2 > 4) {
          ctx.strokeStyle = `rgba(255,255,255,${(base * 0.22).toFixed(3)})`
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(p.ox, p.oy, r2, 0, Math.PI * 2)
          ctx.stroke()
        }
        // Corruption: the ring bends around the monster.
        const m = this.monster
        if (m) {
          const md = Math.hypot(m.x - p.ox, m.y - p.oy)
          if (Math.abs(md - p.r) < 50 && md > 30) {
            const ang = Math.atan2(m.y - p.oy, m.x - p.ox)
            ctx.strokeStyle = `rgba(255,255,255,${(base * 1.1).toFixed(3)})`
            ctx.lineWidth = 2
            ctx.beginPath()
            const segs = 12
            const width = 0.38
            for (let i = 0; i <= segs; i++) {
              const th = ang - width / 2 + (width * i) / segs
              const jr = p.r + p.jag[i % p.jag.length] * 9
              const px = p.ox + Math.cos(th) * jr
              const py = p.oy + Math.sin(th) * jr
              if (i === 0) ctx.moveTo(px, py)
              else ctx.lineTo(px, py)
            }
            ctx.stroke()
          }
        }
      } else {
        // Monster/door ping: jagged, dim, wrong.
        const a = base * 0.32
        ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`
        ctx.lineWidth = 1.2
        ctx.beginPath()
        const segs = 44
        for (let i = 0; i <= segs; i++) {
          const th = (i / segs) * Math.PI * 2
          const jr = p.r + p.jag[i % p.jag.length] * 4
          const px = p.ox + Math.cos(th) * jr
          const py = p.oy + Math.sin(th) * jr
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()
        ctx.stroke()
      }
    }

    // --- Monster body (revealed by a survivor ping) / survivor ghost (hunter) ---
    const m = this.monster
    if (m) {
      const mage = t - m.revealT
      if (mage >= 0 && mage < 0.5 && this.mode !== 'hunter') {
        const a = (1 - mage / 0.5) * 0.95
        const s = Math.floor(t * 12)
        ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`
        ctx.lineWidth = 2
        ctx.beginPath()
        const pts = 16
        for (let i = 0; i <= pts; i++) {
          const th = (i / pts) * Math.PI * 2
          const n = Math.sin(s * 3.7 + i * 2.4) * 0.5 + Math.sin(s * 9.1 + i * 5.3) * 0.5
          const rr = 13 + n * 10
          const px = m.x + Math.cos(th) * rr
          const py = m.y + Math.sin(th) * rr
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()
        ctx.stroke()
      } else if (mage >= 0 && mage < 0.7 && this.mode === 'hunter') {
        // The survivor, caught in the light of their own ping.
        const a = (1 - mage / 0.7) * 0.95
        ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(m.x, m.y, PLAYER_R, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`
        ctx.beginPath()
        ctx.arc(m.x, m.y, 2.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // --- Danger static ---
    if (this.danger > 0.05 && this.phase === 'playing') {
      const n = Math.floor(this.danger * 18)
      for (let i = 0; i < n; i++) {
        const a = (0.03 + Math.random() * 0.09) * this.danger
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`
        const px = this.player.x + (Math.random() - 0.5) * 520
        const py = this.player.y + (Math.random() - 0.5) * 520
        ctx.fillRect(px, py, 1.6, 1.6)
      }
    }

    // --- Local body: survivor ring, or the hunter's own jagged shape ---
    const px = this.player.x
    const py = this.player.y
    if (this.mode === 'hunter') {
      const s = Math.floor(t * 12)
      ctx.strokeStyle = 'rgba(255,255,255,0.72)'
      ctx.lineWidth = 1.8
      ctx.beginPath()
      const pts = 16
      for (let i = 0; i <= pts; i++) {
        const th = (i / pts) * Math.PI * 2
        const n = Math.sin(s * 3.7 + i * 2.4) * 0.5 + Math.sin(s * 9.1 + i * 5.3) * 0.5
        const rr = 11 + n * 5
        const qx = px + Math.cos(th) * rr
        const qy = py + Math.sin(th) * rr
        if (i === 0) ctx.moveTo(qx, qy)
        else ctx.lineTo(qx, qy)
      }
      ctx.closePath()
      ctx.stroke()
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(px, py, PLAYER_R, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.beginPath()
      ctx.arc(px, py, 2.4, 0, Math.PI * 2)
      ctx.fill()
    }
    // Ping cooldown ring.
    if (this.cooldown > 0) {
      const frac = 1 - this.cooldown / PING_COOLDOWN
      ctx.strokeStyle = 'rgba(255,255,255,0.3)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(px, py, 15, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2)
      ctx.stroke()
    } else {
      ctx.strokeStyle = `rgba(255,255,255,${(0.26 + 0.12 * Math.sin(t * 5)).toFixed(3)})`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(px, py, 15, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.restore()

    // --- Death flash (screen space) ---
    if (this.phase === 'dead' && t - this.deathAt < 0.07) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.fillRect(0, 0, cw, ch)
    }
  }

  get elapsedMs(): number {
    return Math.round(this.time * 1000)
  }

  get currentSeed(): number {
    return this.seed
  }
}
