// The Sonar Room — core game engine.
// You are blind: the world only exists for the ~1.5s a ping takes to fade.
// Pings expand as wavefronts; where they touch wall segments the wireframe
// blinks into existence. Sound is spatialized. The thing in the dark hears
// every ping you make.

import {
  GameMap,
  Vec,
  Cell,
  generateMap,
  bfsPath,
  cellCenter,
  isSolid,
  nearestOpenCell,
  segDist,
  worldToCell,
} from './maze'
import { SoundEngine } from './audio'

export type EnginePhase = 'idle' | 'playing' | 'dead' | 'win'

export interface RunResult {
  outcome: 'escaped' | 'caught'
  timeMs: number
  keysFound: number
  pings: number
}

export interface EngineHooks {
  onKeys?: (n: number) => void
  onToast?: (msg: string) => void
  onEnd?: (r: RunResult) => void
}

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
}

interface KeyItem {
  x: number
  y: number
  found: boolean
  revealT: number
  jT: number
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

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const expFade = (age: number, tau: number): number => Math.exp(-age / tau)

export class SonarEngine {
  map: GameMap | null = null
  phase: EnginePhase = 'idle'
  time = 0
  cooldown = 0
  pingsUsed = 0
  keysFound = 0
  unlocked = false
  danger = 0
  input = { x: 0, y: 0 }

  private player = { x: 0, y: 0 }
  private cam = { x: 0, y: 0 }
  private monster: Monster | null = null
  private keys: KeyItem[] = []
  private pings: Ping[] = []
  private revealT: Float32Array = new Float32Array(0)
  private revealS: Float32Array = new Float32Array(0)
  private doorRevealT = -99
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
    this.map = generateMap(seed)
    const n = this.map.edges.length
    this.revealT = new Float32Array(n).fill(-99)
    this.revealS = new Float32Array(n)
    this.player = { ...this.map.start }
    this.cam = { ...this.map.start }
    this.keys = this.map.keys.map((k) => ({ x: k.x, y: k.y, found: false, revealT: -99, jT: 1 + Math.random() * 2 }))
    this.monster = {
      x: this.map.monsterStart.x,
      y: this.map.monsterStart.y,
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
    }
    this.pings = []
    this.time = 0
    this.cooldown = 0
    this.pingsUsed = 0
    this.keysFound = 0
    this.unlocked = false
    this.danger = 0
    this.shake = 0
    this.doorRevealT = -99
    this.thudGate = 0
    this.screechGate = 0
    this.beaconT = 0
    this.graceAnnounced = false
    this.chaseAnnounced = false
    this.phase = 'playing'
    this.audio.setDanger(0)
    this.audio.setExitHum(0)
    this.hooks.onKeys?.(0)
    this.hooks.onToast?.('FIND THE KEYS — QUIETLY')
  }

  /** Emit a sonar ping from the player. Costs noise. */
  ping(): boolean {
    if (this.phase !== 'playing' || this.cooldown > 0 || !this.map) return false
    this.cooldown = PING_COOLDOWN
    this.pingsUsed++
    this.pings.push(this.makePing(this.player.x, this.player.y, 0, PING_MAX_R, PING_SPEED))
    this.audio.ping()
    const m = this.monster
    if (m && m.state !== 'chase' && this.time > GRACE) {
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
      this.updateMonster(dt)
      this.updateKeys(dt)
      this.updateExit(dt)
      this.updateDanger(dt)
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
        // Door reveal.
        const dd = Math.hypot(map.door.midX - p.ox, map.door.midY - p.oy)
        if (dd <= p.r && dd > rPrev - 0.5) {
          this.doorRevealT = this.time
          if (p.owner === 0 && !p.doorHit && this.phase === 'playing') {
            p.doorHit = true
            this.audio.doorTone(this.panOf(map.door.midX), this.volByDist(dd, 640) * 0.5 + 0.05)
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
        // Monster reveal (only player pings screech).
        const m = this.monster
        if (m && p.owner === 0) {
          const md = Math.hypot(m.x - p.ox, m.y - p.oy)
          if (md <= p.r && md > rPrev - 0.5) {
            m.revealT = this.time
            if (this.phase === 'playing' && this.screechGate <= 0) {
              this.audio.screech(this.panOf(m.x), clamp(0.6 - md / 1400, 0.22, 0.6))
              this.screechGate = 1.5
              if (m.state !== 'chase' && this.time > GRACE) {
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
        this.stepT = 0.34
        this.audio.step(0.045)
      }
    }
  }

  private updateKeys(dt: number): void {
    for (const k of this.keys) {
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
        this.hooks.onKeys?.(this.keysFound)
        if (this.keysFound >= 3) {
          this.unlocked = true
          this.audio.unlock()
          this.hooks.onToast?.('THE DOOR IS OPEN')
          const m = this.monster
          if (m && m.state === 'dormant') m.state = 'wander'
        }
      }
    }
  }

  private updateExit(dt: number): void {
    const map = this.map
    if (!map) return
    const d = Math.hypot(this.player.x - map.door.midX, this.player.y - map.door.midY)
    if (this.unlocked) {
      this.audio.setExitHum(this.volByDist(d, 280))
      this.beaconT -= dt
      if (this.beaconT <= 0) {
        this.beaconT = 2.4
        this.pings.push(this.makePing(map.door.midX, map.door.midY, 1, 170, 320))
        if (d < 620) this.audio.doorBlip(this.panOf(map.door.midX), 0.05 + 0.14 * this.volByDist(d, 620))
      }
      if (d < 42) {
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
        })
      }
    } else {
      this.audio.setExitHum(0)
    }
  }

  private updateDanger(dt: number): void {
    const m = this.monster
    if (!m) return
    if (this.time > GRACE) {
      if (!this.graceAnnounced) {
        this.graceAnnounced = true
        this.hooks.onToast?.('SOMETHING IS AWAKE')
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
    if (d < CATCH_R) {
      this.deathAt = this.time
      this.phase = 'dead'
      this.shake = 1.4
      this.audio.setDanger(0)
      this.audio.setExitHum(0)
      this.audio.death()
      this.hooks.onEnd?.({
        outcome: 'caught',
        timeMs: Math.round(this.time * 1000),
        keysFound: this.keysFound,
        pings: this.pingsUsed,
      })
    }
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

    // --- Exit door ---
    const dAge = t - this.doorRevealT
    const dA = dAge >= 0 ? expFade(dAge, 0.6) : 0
    if (dA > 0.02) {
      const door = map.door
      const depth = 16
      const half = map.cell / 2 - 6
      ctx.save()
      ctx.translate(door.midX, door.midY)
      if (door.vertical) {
        const dir = door.midX < map.w / 2 ? 1 : -1
        const pulse = this.unlocked ? 0.65 + 0.35 * Math.sin(t * 5) : 1
        const a = dA * pulse
        ctx.strokeStyle = `rgba(255,255,255,${(a * 0.9).toFixed(3)})`
        ctx.lineWidth = 2
        ctx.strokeRect(dir > 0 ? -depth : 0, -half, depth, half * 2)
        if (!this.unlocked) {
          // Sealed: cross bars.
          ctx.beginPath()
          ctx.moveTo(dir > 0 ? -depth : 0, -half)
          ctx.lineTo(dir > 0 ? 0 : depth, half)
          ctx.moveTo(dir > 0 ? -depth : 0, half)
          ctx.lineTo(dir > 0 ? 0 : depth, -half)
          ctx.stroke()
        } else {
          ctx.strokeStyle = `rgba(255,255,255,${(a * 0.5).toFixed(3)})`
          ctx.strokeRect(dir > 0 ? -depth + 4 : 4, -half + 5, depth - 8, half * 2 - 10)
        }
      } else {
        const dir = door.midY < map.h / 2 ? 1 : -1
        const pulse = this.unlocked ? 0.65 + 0.35 * Math.sin(t * 5) : 1
        const a = dA * pulse
        ctx.strokeStyle = `rgba(255,255,255,${(a * 0.9).toFixed(3)})`
        ctx.lineWidth = 2
        ctx.strokeRect(-half, dir > 0 ? -depth : 0, half * 2, depth)
        if (!this.unlocked) {
          ctx.beginPath()
          ctx.moveTo(-half, dir > 0 ? -depth : 0)
          ctx.lineTo(half, dir > 0 ? 0 : depth)
          ctx.moveTo(-half, dir > 0 ? 0 : depth)
          ctx.lineTo(half, dir > 0 ? -depth : 0)
          ctx.stroke()
        } else {
          ctx.strokeStyle = `rgba(255,255,255,${(a * 0.5).toFixed(3)})`
          ctx.strokeRect(-half + 5, dir > 0 ? -depth + 4 : 4, half * 2 - 10, depth - 8)
        }
      }
      ctx.restore()
    }

    // --- Keys ---
    for (const k of this.keys) {
      if (k.found) continue
      const age = t - k.revealT
      if (age < 0 || age > 2.4) continue
      const a = expFade(age, 0.6)
      if (a < 0.02) continue
      const rot = t * 1.2 + k.x * 0.01
      ctx.save()
      ctx.translate(k.x, k.y)
      ctx.rotate(rot)
      ctx.strokeStyle = `rgba(255,255,255,${(a * 0.95).toFixed(3)})`
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

    // --- Monster body (only when a ping just touched it) ---
    const m = this.monster
    if (m) {
      const mage = t - m.revealT
      if (mage >= 0 && mage < 0.5) {
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

    // --- Player ---
    const px = this.player.x
    const py = this.player.y
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(px, py, PLAYER_R, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.95)'
    ctx.beginPath()
    ctx.arc(px, py, 2.4, 0, Math.PI * 2)
    ctx.fill()
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
