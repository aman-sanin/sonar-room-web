// The Sonar Room — multiplayer room service.
// A tiny relay: pairs two devices into a room with a 4-character code,
// then shuttles game events between them. It holds NO game logic —
// the survivor's client is the authority (keys, door, the kill).

import { createServer } from 'http'
import { Server, Socket } from 'socket.io'

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

type Role = 'survivor' | 'monster'

interface Room {
  code: string
  host: Socket
  hostRole: Role
  guest: Socket | null
  createdAt: number
}

const rooms = new Map<string, Room>()
const bySocket = new Map<string, Room>()

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, no 1/I
const makeCode = (): string =>
  Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('')

const normalize = (raw: string): string =>
  String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4)

function leaveRoom(socket: Socket): void {
  const room = bySocket.get(socket.id)
  if (!room) return
  bySocket.delete(socket.id)
  if (room.host.id === socket.id) {
    room.host = room.guest ?? socket // promote guest so the room can survive
    room.hostRole = room.hostRole === 'survivor' ? 'monster' : 'survivor'
    room.guest = null
  } else {
    room.guest = null
  }
  if (!room.guest && room.host.id === socket.id) {
    rooms.delete(room.code)
  }
}

function peerOf(room: Room, socket: Socket): Socket | null {
  if (room.host.id === socket.id) return room.guest
  if (room.guest?.id === socket.id) return room.host
  return null
}

io.on('connection', (socket) => {
  let cur: Room | null = null

  socket.on('hunt:create', (data: { role?: Role }, ack?: (r: unknown) => void) => {
    leaveRoom(socket)
    const role: Role = data?.role === 'monster' ? 'monster' : 'survivor'
    let c = makeCode()
    let guard = 0
    while (rooms.has(c) && guard++ < 60) c = makeCode()
    const room: Room = { code: c, host: socket, hostRole: role, guest: null, createdAt: Date.now() }
    rooms.set(c, room)
    bySocket.set(socket.id, room)
    cur = room
    ack?.({ ok: true, code: c, role })
  })

  socket.on('hunt:join', (data: { code?: string }, ack?: (r: unknown) => void) => {
    leaveRoom(socket)
    const c = normalize(data?.code ?? '')
    if (c.length !== 4) {
      ack?.({ ok: false, error: 'ENTER THE 4-LETTER CODE' })
      return
    }
    const room = rooms.get(c)
    if (!room) {
      ack?.({ ok: false, error: 'NO SUCH ROOM IN THE DARK' })
      return
    }
    if (room.host.id === socket.id) {
      ack?.({ ok: false, error: 'THAT IS YOUR OWN ROOM' })
      return
    }
    if (room.guest && room.guest.connected) {
      ack?.({ ok: false, error: 'THE ROOM IS FULL' })
      return
    }
    room.guest = socket
    bySocket.set(socket.id, room)
    cur = room
    const guestRole: Role = room.hostRole === 'survivor' ? 'monster' : 'survivor'
    ack?.({ ok: true, code: room.code, role: guestRole })
    room.host.emit('hunt:ready', { myRole: room.hostRole, peerRole: guestRole })
    socket.emit('hunt:ready', { myRole: guestRole, peerRole: room.hostRole })
    console.log(`room ${room.code} linked: host=${room.hostRole} guest=${guestRole}`)
  })

  // Generic relay — the survivor's client drives the game; we just forward.
  socket.on('hunt:evt', (data: unknown) => {
    if (!cur) return
    const peer = peerOf(cur, socket)
    peer?.emit('hunt:evt', data)
  })

  socket.on('hunt:leave', () => {
    const room = cur
    if (!room) return
    const peer = peerOf(room, socket)
    peer?.emit('hunt:evt', { t: 'peer-lost' })
    leaveRoom(socket)
    cur = null
  })

  socket.on('disconnect', () => {
    const room = bySocket.get(socket.id)
    if (room) {
      const peer = peerOf(room, socket)
      peer?.emit('hunt:evt', { t: 'peer-lost' })
      leaveRoom(socket)
    }
    if (cur && bySocket.get(socket.id) === cur) cur = null
  })

  socket.on('error', (error) => {
    console.error(`socket error (${socket.id}):`, error)
  })
})

// Sweep stale rooms (one side vanished for good).
setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) {
    const hostDead = !room.host.connected
    const guestDead = !room.guest || !room.guest.connected
    if ((hostDead && guestDead) || now - room.createdAt > 30 * 60 * 1000) {
      rooms.delete(code)
    }
  }
}, 60_000)

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`Sonar Room service listening on port ${PORT}`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
