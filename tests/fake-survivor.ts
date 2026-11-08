// Fake survivor peer for verifying the monster-view key sync fix.
// Creates a room as SURVIVOR, waits for the real browser (hunter) to join,
// starts a shared-seed hunt, then takes stdin commands:
//   ping <keyIdx>            — survivor sonar ping at that key's position
//   take <keyIdx> <cr> <jd>  — survivor grabbed that key (authoritative tally)
//   info                     — dump key list with distances to hunter spawn
//   quit
import { io } from 'socket.io-client'
import { generateMap } from '$(cd "$(dirname "$0")/.." && pwd)/src/lib/game/maze.ts'

const log = (...a: unknown[]) => console.log('[fake-survivor]', ...a)

// --- Find a seed where two keys sit near the HUNTER's spawn (on-camera) ---
function pickSeed(): { seed: number; near: number[]; keys: { x: number; y: number; d: number }[] } {
  for (let seed = 1; seed < 20000; seed++) {
    const m = generateMap(seed, true)
    const withD = m.keys.map((k, i) => ({
      x: k.x,
      y: k.y,
      i,
      d: Math.hypot(k.x - m.monsterStart.x, k.y - m.monsterStart.y),
    }))
    const near = withD.filter((k) => k.d < 280).map((k) => k.i)
    if (near.length >= 2) {
      return {
        seed,
        near,
        keys: withD.map(({ x, y, d }) => ({ x, y, d })),
      }
    }
  }
  throw new Error('no suitable seed found')
}

const chosen = pickSeed()
log('SEED', chosen.seed, 'keys near hunter spawn:', chosen.near.join(','))
chosen.keys.forEach((k, i) => log(`  key[${i}] d=${Math.round(k.d)} @ ${Math.round(k.x)},${Math.round(k.y)}`))

const socket = io('http://localhost:3003', {
  transports: ['websocket', 'polling'],
  path: '/',
})

const emit = (ch: string, data: unknown) => {
  socket.emit(ch, data)
  log('→', ch, JSON.stringify(data))
}

socket.on('connect', () => {
  log('connected', socket.id)
  socket.emit('hunt:create', { role: 'survivor' }, (ack: { ok: boolean; code?: string }) => {
    log('CREATE ACK', JSON.stringify(ack))
    if (ack?.ok && ack.code) log('ROOM CODE:', ack.code)
  })
})

socket.on('hunt:ready', (p: { myRole: string; peerRole: string }) => {
  log('READY', JSON.stringify(p), '— starting hunt in 1.2s')
  setTimeout(() => emit('hunt:evt', { t: 'start', seed: chosen.seed }), 1200)
})

socket.on('hunt:evt', (e: { t: string }) => log('← hunt:evt', JSON.stringify(e)))

const keyAt = (i: number) => {
  const m = generateMap(chosen.seed, true)
  return m.keys[i]
}

const linebuf: string[] = []
const handleLine = (raw: string) => {
  const line = raw.trim()
  if (!line) return
  const [cmd, ...args] = line.split(/\s+/)
  if (cmd === 'ping') {
    const k = keyAt(Number(args[0]))
    // Offset the origin slightly: the reveal band is an expanding annulus
    // (d <= r && d > rPrev), so a ping exactly AT a key never crosses it.
    emit('hunt:evt', { t: 'ping', x: k.x + 35, y: k.y + 10 })
  } else if (cmd === 'take') {
    emit('hunt:evt', { t: 'keys', i: Number(args[0]), crimson: Number(args[1]), jade: Number(args[2]) })
  } else if (cmd === 'info') {
    log('seed', chosen.seed, 'keys', JSON.stringify(chosen.keys))
  } else if (cmd === 'quit') {
    log('bye')
    socket.close()
    process.exit(0)
  }
}

// Read stdin lines (works when stdin is a FIFO or pipe).
import { createInterface } from 'readline'
createInterface({ input: process.stdin }).on('line', (l) => {
  linebuf.push(l)
  handleLine(l)
})

process.on('SIGTERM', () => {
  socket.close()
  process.exit(0)
})
