// Fake survivor peer (host) for verifying multiplayer fixes — fully
// event-driven, no stdin needed (bun's readline on a FIFO proved flaky).
//
// Timeline, driven by the guest's own `keys {i:-1}` reset events:
//   reset #1  (guest started seed A)
//     +0.7s → ping near key[1] of seed A            [PING_A]
//     +3.4s → RE-SEED the hunt mid-run to seed B    [START_B]
//   reset #2  (guest obeyed the mid-run start — THE FIX)
//     +0.7s → ping near key[1] of seed B            [PING_B1]
//     +2.1s → ping near key[4] of seed B            [PING_B4]
//
// Both seeds are pre-searched so that 2+ keys sit within 280px of the
// hunter's spawn (on-camera). Ping origins are offset ~35px from the key:
// the reveal band is an expanding annulus (d <= r && d > rPrev), so a ping
// exactly AT a key never crosses it.
import { io } from 'socket.io-client'
import { generateMap } from '../src/lib/game/maze'

const log = (...a: unknown[]) => console.log('[fake-survivor]', ...a)

interface SeedPick {
  seed: number
  keys: { x: number; y: number; d: number }[]
}

function pickSeeds(count: number): SeedPick[] {
  const out: SeedPick[] = []
  for (let seed = 1; seed < 30000 && out.length < count; seed++) {
    const m = generateMap(seed, true)
    const withD = m.keys.map((k) => ({
      x: k.x,
      y: k.y,
      d: Math.hypot(k.x - m.monsterStart.x, k.y - m.monsterStart.y),
    }))
    if (withD.filter((k) => k.d < 280).length >= 2) out.push({ seed, keys: withD })
  }
  if (out.length < count) throw new Error('not enough suitable seeds found')
  return out
}

const seeds = pickSeeds(2)
seeds.forEach((s, si) => {
  log(`SEED ${si === 0 ? 'A' : 'B'}`, s.seed)
  s.keys.forEach((k, i) =>
    log(`  key[${i}] d=${Math.round(k.d)} @ ${Math.round(k.x)},${Math.round(k.y)}`),
  )
})

const socket = io('http://localhost:3003', {
  transports: ['websocket', 'polling'],
  path: '/',
})

const emitTagged = (tag: string, data: unknown) => {
  socket.emit('hunt:evt', data)
  log(`→ [${tag}]`, JSON.stringify(data))
}

socket.on('connect', () => {
  log('connected', socket.id)
  socket.emit('hunt:create', { role: 'survivor' }, (ack: { ok: boolean; code?: string }) => {
    log('CREATE ACK', JSON.stringify(ack))
    if (ack?.ok && ack.code) log('ROOM CODE:', ack.code)
  })
})

socket.on('hunt:ready', (p: { myRole: string; peerRole: string }) => {
  log('READY', JSON.stringify(p), '— starting hunt (seed A) in 1.2s')
  setTimeout(() => emitTagged('START_A', { t: 'start', seed: seeds[0].seed }), 1200)
})

let resets = 0
socket.on('hunt:evt', (e: { t: string; i?: number }) => {
  log('←', JSON.stringify(e))
  if (e.t !== 'keys') return
  resets++
  log(`*** guest reset #${resets} ***`)
  if (resets === 1) {
    const a = seeds[0].keys[1]
    setTimeout(() => emitTagged('PING_A', { t: 'ping', x: a.x + 35, y: a.y + 10 }), 700)
    setTimeout(
      () => emitTagged('START_B', { t: 'start', seed: seeds[1].seed }),
      3400,
    )
  } else if (resets === 2) {
    const b1 = seeds[1].keys[1]
    const b4 = seeds[1].keys[4]
    setTimeout(() => emitTagged('PING_B1', { t: 'ping', x: b1.x + 35, y: b1.y + 10 }), 700)
    setTimeout(() => emitTagged('PING_B4', { t: 'ping', x: b4.x + 35, y: b4.y + 10 }), 2100)
  }
})

process.on('SIGTERM', () => {
  socket.close()
  process.exit(0)
})
