'use client'

// THE SONAR ROOM — you are blind. Click to ping, WASD to move.
// The screen is 90% black; the world only exists where sound has touched it.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { io, type Socket } from 'socket.io-client'
import { SonarEngine, RunResult } from '@/lib/game/engine'
import { SoundEngine } from '@/lib/game/audio'
import type {
  Role,
  ReadyPayload,
  HuntEvt,
  CreateAck,
  JoinAck,
  KeyCounts,
  HuntDoorColor,
} from '@/lib/game/net'

const ROOM_SERVICE_PORT = 3003

type Phase = 'menu' | 'playing' | 'dead' | 'win'
type MpStage = 'off' | 'choose' | 'pick' | 'join' | 'lobby'

interface Escape {
  timeMs: number
  pings: number
  keysFound: number
  createdAt: string
}

const BEST_KEY = 'sonar_best_ms'

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const emptySubscribe = () => () => {}

export default function SonarRoom() {
  // Browser extensions (Dark Reader, Grammarly, translators…) inject <style>
  // and attribute mutations into the DOM before React hydrates, which breaks
  // structural hydration matching. The game is a pure client-side canvas +
  // WebAudio experience, so the server only needs to paint the black room.
  // Hydrate a minimal, trivially-matchable shell first, then mount the real
  // game once we know we are on the client.
  const hydrated = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  )
  if (!hydrated) {
    return <div className="fixed inset-0 bg-black" suppressHydrationWarning />
  }
  return <SonarRoomGame />
}

function SonarRoomGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const engineRef = useRef<SonarEngine | null>(null)
  const audioRef = useRef<SoundEngine | null>(null)
  const phaseRef = useRef<Phase>('menu')
  const keysStateRef = useRef<Set<string>>(new Set())
  const joyRef = useRef({ x: 0, y: 0, active: false })
  const joyIdRef = useRef<number | null>(null)
  const joyCenterRef = useRef({ x: 0, y: 0 })
  const timerRef = useRef<HTMLSpanElement | null>(null)
  const knobRef = useRef<HTMLDivElement | null>(null)
  const toastTimeoutRef = useRef<number>(0)
  const endDelayRef = useRef<number>(0)
  const netRef = useRef<Socket | null>(null)
  const roleRef = useRef<Role | null>(null)
  const isHostRef = useRef(false)
  const mpStageRef = useRef<MpStage>('off')
  const mpActiveRef = useRef(false)
  const iWantRef = useRef(false)
  const peerWantsRef = useRef(false)
  const peerLinkedRef = useRef(false)
  const startTimerRef = useRef<number>(0)

  const [phase, setPhaseState] = useState<Phase>('menu')
  const [keyCounts, setKeyCounts] = useState<KeyCounts>({ total: 0, crimson: 0, jade: 0 })
  const [doorStatus, setDoorStatus] = useState<
    { color: HuntDoorColor; progress: number; unlocked: boolean }[]
  >([])
  const [toast, setToast] = useState<string | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)
  const [best, setBest] = useState<number | null>(null)
  const [escapes, setEscapes] = useState<Escape[]>([])
  const [touchMode, setTouchMode] = useState(false)
  const [menuVisible, setMenuVisible] = useState(true)
  const [mpStage, setMpStage] = useState<MpStage>('off')
  const [role, setRole] = useState<Role | null>(null)
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [mpStatus, setMpStatus] = useState('')
  const [mpError, setMpError] = useState('')
  const [joinInput, setJoinInput] = useState('')
  const [peerLinked, setPeerLinked] = useState(false)
  const [peerLost, setPeerLost] = useState(false)
  const [iWant, setIWant] = useState(false)
  const [peerWants, setPeerWants] = useState(false)
  const [copied, setCopied] = useState(false)

  const setMpStageBoth = useCallback((s: MpStage) => {
    mpStageRef.current = s
    setMpStage(s)
  }, [])

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimeoutRef.current)
    toastTimeoutRef.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  // ------------------------------------------------------------- joystick
  const resetJoy = useCallback(() => {
    joyIdRef.current = null
    joyRef.current = { x: 0, y: 0, active: false }
    if (knobRef.current) knobRef.current.style.transform = 'translate(-50%, -50%)'
  }, [])

  const loadEscapes = useCallback(async () => {
    try {
      const res = await fetch('/api/runs', { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as { escapes?: Escape[] }
      setEscapes(data.escapes ?? [])
    } catch {
      /* offline is fine */
    }
  }, [])

  const handleEnd = useCallback(
    (r: RunResult, mp = false) => {
      setResult(r)
      // Let the death flash / win tone breathe before the overlay lands.
      window.clearTimeout(endDelayRef.current)
      endDelayRef.current = window.setTimeout(() => {
        setPhase(r.outcome === 'escaped' ? 'win' : 'dead')
        setMenuVisible(true)
      }, r.outcome === 'escaped' ? 700 : 1100)
      if (mp) {
        // Multiplayer runs are not comparable with solo times — share the
        // verdict with the hunter instead of the leaderboard.
        netRef.current?.emit('hunt:evt', {
          t: 'end',
          outcome: r.outcome,
          timeMs: r.timeMs,
          keysFound: r.keysFound,
          pings: r.pings,
          door: r.door === 'crimson' || r.door === 'jade' ? r.door : undefined,
        } satisfies HuntEvt)
        return
      }
      // Persist.
      try {
        if (r.outcome === 'escaped') {
          const prev = window.localStorage.getItem(BEST_KEY)
          const prevN = prev ? Number(prev) : Infinity
          if (r.timeMs < prevN) {
            window.localStorage.setItem(BEST_KEY, String(r.timeMs))
            setBest(r.timeMs)
          }
        }
      } catch {
        /* storage may be unavailable */
      }
      void fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r),
      })
        .then(() => (r.outcome === 'escaped' ? loadEscapes() : undefined))
        .catch(() => undefined)
    },
    [loadEscapes, setPhase],
  )

  const startGame = useCallback((seed?: number) => {
    const audio = audioRef.current
    const engine = engineRef.current
    if (!audio || !engine) return
    // Touch-capable devices get the joystick from the very first frame —
    // never make a blind player tap first just to unlock their controls.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
    const touchable = (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window
    if (coarse || touchable) setTouchMode(true)
    // Multiplayer: role decides who simulates what. Solo: vs the AI thing.
    const mp = mpActiveRef.current || (mpStageRef.current === 'lobby' && roleRef.current !== null)
    mpActiveRef.current = mp
    engine.mode = mp ? (roleRef.current === 'monster' ? 'hunter' : 'host') : 'solo'
    iWantRef.current = false
    peerWantsRef.current = false
    setIWant(false)
    setPeerWants(false)
    setPeerLost(false)
    setMpStageBoth('off')
    audio.ensure()
    window.clearTimeout(endDelayRef.current)
    resetJoy()
    setResult(null)
    setKeyCounts({ total: 0, crimson: 0, jade: 0 })
    setToast(null)
    setMenuVisible(false)
    engine.start(seed ?? Math.floor(Math.random() * 1e9))
    setDoorStatus(
      engine.doorColors
        .filter((c): c is HuntDoorColor => c !== 'white')
        .map((color) => ({ color, progress: 0, unlocked: false })),
    )
    setPhase('playing')
  }, [resetJoy, setPhase, setMpStageBoth])

  // --------------------------------------------------------- multiplayer
  const exitMp = useCallback(() => {
    netRef.current?.emit('hunt:leave')
    roleRef.current = null
    isHostRef.current = false
    mpActiveRef.current = false
    iWantRef.current = false
    peerWantsRef.current = false
    setRole(null)
    setRoomCode(null)
    setMpStatus('')
    setMpError('')
    setPeerLinked(false)
    setPeerLost(false)
    setIWant(false)
    setPeerWants(false)
    setJoinInput('')
    setMpStageBoth('off')
    setPhase('menu')
    setMenuVisible(true)
  }, [setPhase, setMpStageBoth])

  const beginCreate = useCallback(
    (r: Role) => {
      setMpError('')
      roleRef.current = r
      setRole(r)
      isHostRef.current = true
      const socket = netRef.current
      if (!socket) return
      socket.emit('hunt:create', { role: r }, (ack: CreateAck) => {
        if (ack?.ok && ack.code) {
          setRoomCode(ack.code)
          setMpStatus('WAITING IN THE DARK — SHARE THE CODE')
          setMpStageBoth('lobby')
        } else {
          setMpError(ack?.error ?? 'THE DEEP IS SILENT — TRY AGAIN')
        }
      })
    },
    [],
  )

  const doJoin = useCallback(() => {
    setMpError('')
    const socket = netRef.current
    if (!socket) return
    socket.emit('hunt:join', { code: joinInput }, (ack: JoinAck) => {
      if (ack?.ok && ack.code && ack.role) {
        roleRef.current = ack.role
        setRole(ack.role)
        isHostRef.current = false
        setRoomCode(ack.code)
        setMpStatus('FOUND THEM — LINKING…')
        setMpStageBoth('lobby')
      } else {
        setMpError(ack?.error ?? 'NO ANSWER — TRY AGAIN')
      }
    })
  }, [joinInput])

  const requestRematch = useCallback(() => {
    if (!mpActiveRef.current) {
      startGame()
      return
    }
    iWantRef.current = true
    setIWant(true)
    netRef.current?.emit('hunt:evt', { t: 'rematch' } satisfies HuntEvt)
    if (peerWantsRef.current && isHostRef.current) {
      const seed = Math.floor(Math.random() * 1e9)
      netRef.current?.emit('hunt:evt', { t: 'start', seed } satisfies HuntEvt)
      startGame(seed)
    }
  }, [startGame])

  // ------------------------------------------------------------ bootstrap
  useEffect(() => {
    const audio = new SoundEngine()
    audioRef.current = audio
    const engine = new SonarEngine(audio, {
      onKeys: (c, takenIndex) => {
        setKeyCounts(c)
        if (mpActiveRef.current) {
          netRef.current?.emit('hunt:evt', {
            t: 'keys',
            i: takenIndex ?? -1,
            crimson: c.crimson,
            jade: c.jade,
          } satisfies HuntEvt)
        }
      },
      onToast: showToast,
      onEnd: (r) => handleEnd(r, mpActiveRef.current),
      onEmit: (e) => {
        netRef.current?.emit('hunt:evt', e as HuntEvt)
        // Keep the local door chips in sync with what we just announced.
        if (e.t === 'door') {
          setDoorStatus((ds) =>
            ds.map((d) =>
              d.color === e.color ? { ...d, progress: e.progress, unlocked: e.unlocked } : d,
            ),
          )
        }
      },
    })
    engineRef.current = engine

    // Room service — pairs the two devices and relays game events.
    const socket = io(`/?XTransformPort=${ROOM_SERVICE_PORT}`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      timeout: 10000,
    })
    netRef.current = socket

    socket.on('connect', () => {
      if (mpStageRef.current === 'lobby' && !peerLinkedRef.current) {
        setMpStatus((s) => (s.startsWith('SIGNAL') ? 'CONTACTING THE DEEP…' : s))
      }
    })
    socket.on('hunt:ready', (p: ReadyPayload) => {
      roleRef.current = p.myRole
      setRole(p.myRole)
      setPeerLinked(true)
      peerLinkedRef.current = true
      setMpStatus('LINKED — DESCENDING…')
      showToast(p.myRole === 'monster' ? 'THE PREY HAS DESCENDED' : 'THE HUNTER IS LISTENING')
      if (isHostRef.current) {
        // The creator's client chooses the shared seed and starts the run.
        window.clearTimeout(startTimerRef.current)
        startTimerRef.current = window.setTimeout(() => {
          const seed = Math.floor(Math.random() * 1e9)
          socket.emit('hunt:evt', { t: 'start', seed } satisfies HuntEvt)
          startGame(seed)
        }, 1500)
      }
    })
    socket.on('hunt:evt', (e: HuntEvt) => {
      if (!e || typeof e !== 'object') return
      switch (e.t) {
        case 'start': {
          if (phaseRef.current !== 'playing') startGame(e.seed)
          break
        }
        case 'pos': {
          if (roleRef.current === 'monster') engine.setRemoteSurvivor(e.x, e.y, e.moving)
          else engine.setRemoteMonster(e.x, e.y, e.moving)
          break
        }
        case 'ping': {
          if (roleRef.current === 'monster') engine.netSurvivorPing(e.x, e.y)
          break
        }
        case 'click': {
          if (roleRef.current === 'survivor') engine.netMonsterClick(e.x, e.y)
          break
        }
        case 'keys': {
          // Retire the exact key from this side's world too — otherwise the
          // hunter keeps re-revealing keys that are already in the prey's
          // pocket. Index matches because both maps come from the same seed.
          engine.netKeyTaken(e.i, e.crimson, e.jade)
          setKeyCounts({ total: e.crimson + e.jade, crimson: e.crimson, jade: e.jade })
          if (e.crimson === 3 || e.jade === 3) {
            showToast(`THE PREY CAN OPEN THE ${e.crimson === 3 ? 'CRIMSON' : 'JADE'} DOOR`)
          } else {
            showToast(`PREY FOUND A KEY — CRIMSON ${e.crimson}/3 · JADE ${e.jade}/3`)
          }
          break
        }
        case 'door': {
          engine.netDoorProgress(e.i, e.progress, e.unlocked)
          setDoorStatus((ds) =>
            ds.map((d) =>
              d.color === e.color ? { ...d, progress: e.progress, unlocked: e.unlocked } : d,
            ),
          )
          if (e.unlocked) showToast('A DOOR JUST OPENED — STOP THEM')
          break
        }
        case 'end': {
          // The survivor's client is authoritative — this verdict is final.
          const iAmHunter = roleRef.current === 'monster'
          const won = iAmHunter ? e.outcome === 'caught' : e.outcome === 'escaped'
          audio.setDanger(0)
          audio.setExitHum(0)
          if (e.outcome === 'caught') audio.win()
          else audio.death()
          window.clearTimeout(endDelayRef.current)
          setResult({
            outcome: e.outcome,
            timeMs: e.timeMs,
            keysFound: e.keysFound,
            pings: e.pings,
            door: e.door,
          })
          endDelayRef.current = window.setTimeout(() => {
            setPhase(won ? 'win' : 'dead')
            setMenuVisible(true)
          }, 1100)
          break
        }
        case 'rematch': {
          peerWantsRef.current = true
          setPeerWants(true)
          showToast('THE OTHER SIDE WANTS A REMATCH')
          if (iWantRef.current && isHostRef.current) {
            const seed = Math.floor(Math.random() * 1e9)
            socket.emit('hunt:evt', { t: 'start', seed } satisfies HuntEvt)
            startGame(seed)
          }
          break
        }
        case 'peer-lost': {
          peerLinkedRef.current = false
          setPeerLinked(false)
          if (phaseRef.current === 'playing') {
            setPeerLost(true)
          } else {
            setMpStatus('YOUR PARTNER VANISHED INTO THE DARK')
          }
          break
        }
      }
    })

    try {
      const b = window.localStorage.getItem(BEST_KEY)
      if (b) queueMicrotask(() => setBest(Number(b)))
    } catch {
      /* ignore */
    }
    queueMicrotask(() => void loadEscapes())

    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')

    const resize = () => {
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth || window.innerWidth
      const h = canvas.clientHeight || window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    let raf = 0
    let last = performance.now()
    let netFrame = 0
    const loop = (ts: number) => {
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      // Merge keyboard + joystick into the engine input.
      const ks = keysStateRef.current
      let kx = 0
      let ky = 0
      if (ks.has('KeyD') || ks.has('d') || ks.has('ArrowRight')) kx += 1
      if (ks.has('KeyA') || ks.has('a') || ks.has('ArrowLeft')) kx -= 1
      if (ks.has('KeyS') || ks.has('s') || ks.has('ArrowDown')) ky += 1
      if (ks.has('KeyW') || ks.has('w') || ks.has('ArrowUp')) ky -= 1
      let ix = kx + joyRef.current.x
      let iy = ky + joyRef.current.y
      const il = Math.hypot(ix, iy)
      if (il > 1) {
        ix /= il
        iy /= il
      }
      engine.input.x = ix
      engine.input.y = iy

      if (ctx) {
        if (phaseRef.current !== 'menu') engine.update(dt)
        const dpr = window.devicePixelRatio || 1
        const cw = canvas ? canvas.width / dpr : 0
        const ch = canvas ? canvas.height / dpr : 0
        engine.render(ctx, cw, ch, dpr)
      }
      if (timerRef.current && phaseRef.current === 'playing') {
        timerRef.current.textContent = fmt(engine.elapsedMs)
      }
      // Stream the local body to the partner at ~15 Hz.
      netFrame++
      if (
        mpActiveRef.current &&
        phaseRef.current === 'playing' &&
        netFrame % 4 === 0 &&
        netRef.current?.connected
      ) {
        const p = engine.playerPos
        const moving = Math.hypot(engine.input.x, engine.input.y) > 0.08
        netRef.current.emit('hunt:evt', {
          t: 'pos',
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
          moving,
        } satisfies HuntEvt)
      }
      // Drop any held controls when the run ends so the player
      // never keeps sliding into the dark after death.
      if (phaseRef.current !== 'playing') resetJoy()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) ||
        [' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())
      ) {
        e.preventDefault()
      }
      if (e.repeat) return
      keysStateRef.current.add(e.code)
      keysStateRef.current.add(e.key === ' ' ? 'space' : e.key.toLowerCase())
      const k = e.key.toLowerCase()
      if (e.code === 'Space' || e.key === ' ' || k === 'enter') {
        if (phaseRef.current === 'menu') {
          if (mpStageRef.current === 'off') startGame()
        } else if (phaseRef.current === 'playing') engine.ping()
        else {
          if (mpActiveRef.current) requestRematch()
          else startGame()
        }
      }
      if (k === 'r' && (phaseRef.current === 'dead' || phaseRef.current === 'win')) {
        if (mpActiveRef.current) requestRematch()
        else startGame()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      keysStateRef.current.delete(e.code)
      keysStateRef.current.delete(e.key === ' ' ? 'space' : e.key.toLowerCase())
    }
    const onBlur = () => {
      keysStateRef.current.clear()
      joyRef.current = { x: 0, y: 0, active: false }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.clearTimeout(toastTimeoutRef.current)
      window.clearTimeout(endDelayRef.current)
      window.clearTimeout(startTimerRef.current)
      socket.disconnect()
      audio.dispose()
    }
  }, [handleEnd, loadEscapes, requestRematch, resetJoy, showToast, startGame])

  // ------------------------------------------------------------- pointer
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') setTouchMode(true)
    if (phaseRef.current === 'playing') {
      e.preventDefault()
      engineRef.current?.ping()
    }
  }

  // ------------------------------------------------------------- joystick
  const onJoyDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setTouchMode(true)
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    joyCenterRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    joyIdRef.current = e.pointerId
    // Capture on the pad itself so the drag keeps tracking even when the
    // finger slides off it, and the browser cannot steal the gesture.
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* very old browsers */
    }
    updateJoy(e)
  }
  const onJoyMove = (e: React.PointerEvent) => {
    if (joyIdRef.current !== e.pointerId) return
    e.stopPropagation()
    updateJoy(e)
  }
  const onJoyUp = (e: React.PointerEvent) => {
    if (joyIdRef.current !== e.pointerId) return
    e.stopPropagation()
    resetJoy()
  }
  // Safety net: if the browser steals the pointer mid-drag (gesture,
  // notification, palm rejection) the stick must not stay stuck.
  const onJoyLostCapture = (e: React.PointerEvent) => {
    if (joyIdRef.current !== e.pointerId) return
    resetJoy()
  }
  const updateJoy = (e: React.PointerEvent) => {
    const dx = e.clientX - joyCenterRef.current.x
    const dy = e.clientY - joyCenterRef.current.y
    const max = 44
    const d = Math.hypot(dx, dy)
    const k = d > max ? max / d : 1
    // Deadzone: ignore finger jitter near the center, then remap the
    // remaining travel so a firm push always means full speed.
    const DEAD = 0.18
    const v = Math.min(1, d / max)
    const mag = v < DEAD ? 0 : Math.min(1, (v - DEAD) / (1 - DEAD))
    const n = d || 1
    joyRef.current = { x: (dx / n) * mag, y: (dy / n) * mag, active: mag > 0 }
    if (knobRef.current) {
      const kx = dx * k
      const ky = dy * k
      knobRef.current.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`
    }
  }

  const playing = phase === 'playing'

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 select-none overflow-hidden overscroll-none bg-black font-mono text-white"
    >
      <canvas
        ref={canvasRef}
        aria-label="The Sonar Room — echolocation game canvas"
        className="absolute inset-0 block h-full w-full cursor-crosshair touch-none bg-black"
        onPointerDown={onCanvasPointerDown}
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* ---------------- HUD (in-game) ---------------- */}
      {playing && (
        <div className="pointer-events-none absolute inset-0 z-10">
          {/* Keys — solo: white diamonds · hunt: one chip per colored door */}
          <div className="absolute left-4 top-4 sm:left-6 sm:top-6">
            {mpActiveRef.current && role !== null ? (
              <div className="flex flex-col gap-1.5">
                <span className="sr-only">
                  Crimson keys {keyCounts.crimson} of 3, jade keys {keyCounts.jade} of 3
                </span>
                {(['crimson', 'jade'] as HuntDoorColor[]).map((color) => {
                  const ds = doorStatus.find((d) => d.color === color)
                  const n = keyCounts[color]
                  const ready = n >= 3
                  return (
                    <div key={color} className="flex items-center gap-2" aria-hidden>
                      <span
                        className={`h-2.5 w-2.5 rotate-45 border transition-all duration-300 ${
                          color === 'crimson'
                            ? `border-red-400 shadow-[0_0_8px_rgba(255,70,86,0.8)] ${
                                ready ? 'bg-red-400' : 'bg-transparent'
                              }`
                            : `border-emerald-400 shadow-[0_0_8px_rgba(86,255,168,0.8)] ${
                                ready ? 'bg-emerald-400' : 'bg-transparent'
                              }`
                        }`}
                      />
                      <span
                        className={`text-[10px] tracking-[0.3em] ${
                          color === 'crimson' ? 'text-red-300/85' : 'text-emerald-300/85'
                        }`}
                      >
                        {color.toUpperCase()} {n}/3
                      </span>
                      {ds?.unlocked ? (
                        <span className="text-[9px] tracking-[0.2em] text-white">OPEN</span>
                      ) : ds && ds.progress > 0 ? (
                        <span className="text-[9px] tracking-[0.2em] text-white/70">
                          UNLOCKING {Math.round(ds.progress * 100)}%
                        </span>
                      ) : ready && role !== 'monster' ? (
                        <span className="animate-pulse text-[9px] tracking-[0.2em] text-white/60">
                          GO UNLOCK
                        </span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="sr-only">Keys collected: {keyCounts.total} of 3</span>
                <div className="flex items-center gap-2" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className={`h-2.5 w-2.5 rotate-45 border transition-all duration-300 ${
                        i < keyCounts.total
                          ? 'border-white bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]'
                          : 'border-white/40'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-[10px] tracking-[0.35em] text-white/40">KEYS</span>
              </div>
            )}
          </div>
          {/* Timer + link status */}
          <div className="absolute right-4 top-4 flex items-center gap-3 sm:right-6 sm:top-6">
            {mpActiveRef.current && (
              <span
                aria-label={peerLinked ? 'Partner connected' : 'Partner disconnected'}
                className={`h-1.5 w-1.5 rounded-full ${peerLinked ? 'bg-white/80' : 'animate-pulse bg-white/30'}`}
              />
            )}
            <span ref={timerRef} className="text-xs tracking-[0.3em] text-white/45">
              00:00
            </span>
          </div>
          {/* Hint */}
          <div
            className={`absolute left-1/2 -translate-x-1/2 text-center text-[10px] text-white/50 sm:text-xs ${
              touchMode ? 'bottom-48 tracking-[0.2em]' : 'bottom-8 tracking-[0.3em] sm:tracking-[0.3em]'
            }`}
            style={{ animation: 'hint-fade 9s ease-out forwards' }}
          >
            {touchMode ? (
              <>
                TAP — {role === 'monster' && mpActiveRef.current ? 'CLICK' : 'PING'}
                <br />
                STICK — MOVE
              </>
            ) : (
              <>
                CLICK / SPACE — {role === 'monster' && mpActiveRef.current ? 'ECHOCLICK' : 'PING'}
              </>
            )}
            <br />
            <span className="text-white/30">EVERY SOUND ECHOES. IT LISTENS.</span>
          </div>
          {/* Toast */}
          {toast && (
            <div
              className="absolute left-1/2 top-[22%] -translate-x-1/2 whitespace-nowrap text-center text-xs tracking-[0.5em] text-white sm:text-sm"
              style={{ animation: 'toast-in 2.6s ease-out forwards' }}
            >
              {toast}
            </div>
          )}
        </div>
      )}

      {/* ---------------- Touch joystick ---------------- */}
      {playing && touchMode && (
        <div
          className="absolute bottom-3 left-2 z-20 flex h-44 w-44 touch-none select-none items-center justify-center rounded-full sm:bottom-6 sm:left-5"
          onPointerDown={onJoyDown}
          onPointerMove={onJoyMove}
          onPointerUp={onJoyUp}
          onPointerCancel={onJoyUp}
          onLostPointerCapture={onJoyLostCapture}
          aria-label="Movement joystick"
          role="application"
        >
          <div className="pointer-events-none h-32 w-32 rounded-full border border-white/20 bg-white/[0.02]" />
          <div
            ref={knobRef}
            className="pointer-events-none absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40 bg-white/10 transition-transform duration-75"
          />
        </div>
      )}

      {/* ---------------- MENU ---------------- */}
      {phase === 'menu' && menuVisible && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-y-auto bg-black/95 px-6 py-10">
          {/* ambient ping rings */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" aria-hidden>
            <div
              className="absolute left-1/2 top-1/2 h-64 w-64 rounded-full border border-white/15"
              style={{ animation: 'sonar-ring 3.2s ease-out infinite' }}
            />
            <div
              className="absolute left-1/2 top-1/2 h-64 w-64 rounded-full border border-white/10"
              style={{ animation: 'sonar-ring 3.2s ease-out 1.6s infinite' }}
            />
          </div>

          <p className="mb-4 text-[10px] tracking-[0.6em] text-white/35">
            A GAME OF ECHOLOCATION
          </p>
          <h1
            className="mb-3 text-center text-3xl font-light tracking-[0.45em] sm:text-5xl"
            style={{ animation: 'flicker 5s linear infinite' }}
          >
            THE SONAR ROOM
          </h1>
          <p className="mb-10 text-center text-xs tracking-[0.3em] text-white/50">
            YOU ARE BLIND. SOUND IS SIGHT.
          </p>

          <div className="mb-10 w-full max-w-sm space-y-2.5 border border-white/10 p-5 text-[11px] tracking-[0.2em] text-white/60">
            <div className="flex items-center justify-between gap-4">
              <span className="text-white/85">{touchMode ? 'TAP SCREEN' : 'CLICK / SPACE'}</span>
              <span>EMIT SONAR PING</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-white/85">{touchMode ? 'LEFT STICK' : 'W A S D'}</span>
              <span>MOVE</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="tracking-[0.5em] text-white/85">◆ ◆ ◆</span>
              <span>FIND 3 KEYS</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-white/85">THE DOOR</span>
              <span>ESCAPE</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-white/85">TWO PLAYERS</span>
              <span>2 DOORS · 6 KEYS · 3s UNLOCK</span>
            </div>
            <div className="mt-3 border-t border-white/10 pt-3 text-center text-[10px] leading-relaxed text-white/40">
              THE RINGS REVEAL THE WALLS FOR A MOMENT.
              <br />
              SOMETHING ELSE HEARS EVERY PING YOU MAKE.
            </div>
          </div>

          <button
            onClick={() => startGame()}
            className="border border-white/50 px-12 py-3.5 text-sm tracking-[0.5em] transition-colors duration-200 hover:bg-white hover:text-black focus:outline-none focus:ring-1 focus:ring-white"
          >
            BEGIN
          </button>

          {mpStage === 'off' && (
            <button
              onClick={() => setMpStageBoth('choose')}
              className="mt-4 border border-white/20 px-10 py-2.5 text-[11px] tracking-[0.45em] text-white/55 transition-colors duration-200 hover:border-white/60 hover:text-white focus:outline-none focus:ring-1 focus:ring-white/40"
            >
              HUNT · TWO PLAYERS
            </button>
          )}

          {mpStage !== 'off' && (
            <div className="mt-6 w-full max-w-sm border border-white/10 p-5 text-[11px] tracking-[0.25em]">
              {mpStage === 'choose' && (
                <>
                  <p className="mb-4 text-center text-[10px] tracking-[0.4em] text-white/40">
                    TWO DEVICES · ONE CODE · ONE SURVIVOR
                  </p>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => setMpStageBoth('pick')}
                      className="border border-white/25 px-6 py-3 tracking-[0.35em] transition-colors duration-200 hover:border-white hover:bg-white hover:text-black"
                    >
                      CREATE A ROOM
                    </button>
                    <button
                      onClick={() => setMpStageBoth('join')}
                      className="border border-white/25 px-6 py-3 tracking-[0.35em] transition-colors duration-200 hover:border-white hover:bg-white hover:text-black"
                    >
                      JOIN A ROOM
                    </button>
                  </div>
                  <button
                    onClick={() => setMpStageBoth('off')}
                    className="mt-4 w-full text-center text-[10px] tracking-[0.4em] text-white/30 hover:text-white/70"
                  >
                    BACK
                  </button>
                </>
              )}

              {mpStage === 'pick' && (
                <>
                  <p className="mb-4 text-center text-[10px] tracking-[0.4em] text-white/40">
                    CHOOSE YOUR SIDE
                  </p>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => beginCreate('survivor')}
                      className="border border-white/25 px-6 py-3 text-left transition-colors duration-200 hover:border-white hover:bg-white hover:text-black"
                    >
                      <span className="tracking-[0.35em]">THE PREY</span>
                      <span className="block pt-1 text-[9px] tracking-[0.2em] opacity-60">
                        FIND 6 COLORED KEYS · HOLD A DOOR 3s · ESCAPE
                      </span>
                    </button>
                    <button
                      onClick={() => beginCreate('monster')}
                      className="border border-white/25 px-6 py-3 text-left transition-colors duration-200 hover:border-white hover:bg-white hover:text-black"
                    >
                      <span className="tracking-[0.35em]">THE HUNTER</span>
                      <span className="block pt-1 text-[9px] tracking-[0.2em] opacity-60">
                        BLIND TOO · GUARD TWO DOORS · KILL
                      </span>
                    </button>
                  </div>
                  <button
                    onClick={() => setMpStageBoth('choose')}
                    className="mt-4 w-full text-center text-[10px] tracking-[0.4em] text-white/30 hover:text-white/70"
                  >
                    BACK
                  </button>
                </>
              )}

              {mpStage === 'join' && (
                <>
                  <p className="mb-4 text-center text-[10px] tracking-[0.4em] text-white/40">
                    ENTER THE ROOM CODE
                  </p>
                  <input
                    value={joinInput}
                    onChange={(e) =>
                      setJoinInput(
                        e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4),
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') doJoin()
                    }}
                    placeholder="· · · ·"
                    aria-label="Room code"
                    className="w-full border border-white/25 bg-transparent px-4 py-3 text-center text-2xl tracking-[0.6em] text-white placeholder:text-white/20 focus:border-white focus:outline-none"
                  />
                  {mpError && (
                    <p className="mt-3 text-center text-[10px] tracking-[0.3em] text-white/70">
                      {mpError}
                    </p>
                  )}
                  <button
                    onClick={doJoin}
                    disabled={joinInput.length !== 4}
                    className="mt-3 w-full border border-white/25 px-6 py-3 tracking-[0.35em] transition-colors duration-200 hover:border-white hover:bg-white hover:text-black disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white"
                  >
                    DESCEND TOGETHER
                  </button>
                  <button
                    onClick={() => setMpStageBoth('choose')}
                    className="mt-4 w-full text-center text-[10px] tracking-[0.4em] text-white/30 hover:text-white/70"
                  >
                    BACK
                  </button>
                </>
              )}

              {mpStage === 'lobby' && (
                <>
                  <p className="text-center text-[10px] tracking-[0.4em] text-white/40">
                    ROOM CODE
                  </p>
                  <p className="my-4 text-center text-4xl font-light tracking-[0.55em] text-white">
                    {roomCode}
                  </p>
                  <button
                    onClick={() => {
                      if (!roomCode) return
                      try {
                        void navigator.clipboard?.writeText(roomCode)
                        setCopied(true)
                        window.setTimeout(() => setCopied(false), 1600)
                      } catch {
                        /* clipboard unavailable */
                      }
                    }}
                    className="mx-auto block border border-white/20 px-6 py-2 text-[10px] tracking-[0.4em] text-white/60 transition-colors duration-200 hover:border-white/60 hover:text-white"
                  >
                    {copied ? 'COPIED' : 'COPY CODE'}
                  </button>
                  <p
                    aria-live="polite"
                    className={`mt-5 text-center text-[10px] leading-relaxed tracking-[0.3em] ${
                      peerLinked ? 'text-white' : 'animate-pulse text-white/45'
                    }`}
                  >
                    {mpStatus}
                  </p>
                  <p className="mt-3 text-center text-[9px] leading-relaxed tracking-[0.25em] text-white/30">
                    {role === 'monster'
                      ? 'YOU ARE THE HUNTER. YOU ARE BLIND TOO — TRACK THEIR PINGS.'
                      : role === 'survivor'
                        ? 'YOU ARE THE PREY. EVERY PING YOU MAKE BETRAYS YOU.'
                        : ''}
                  </p>
                  {!peerLinked && (
                    <button
                      onClick={exitMp}
                      className="mt-4 w-full text-center text-[10px] tracking-[0.4em] text-white/30 hover:text-white/70"
                    >
                      CANCEL
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          <div className="mt-8 flex flex-col items-center gap-1.5 text-[10px] tracking-[0.25em] text-white/30">
            {best !== null && <span>BEST ESCAPE — {fmt(best)}</span>}
            <span>HEADPHONES STRONGLY RECOMMENDED</span>
          </div>
        </div>
      )}

      {/* ---------------- PEER LOST (multiplayer) ---------------- */}
      {peerLost && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/95 px-6">
          <h2 className="mb-4 text-2xl font-light tracking-[0.5em] sm:text-3xl">
            THE LINK IS SEVERED
          </h2>
          <p className="mb-10 text-center text-[11px] tracking-[0.3em] leading-relaxed text-white/50">
            YOUR PARTNER VANISHED INTO THE DARK.
          </p>
          <button
            onClick={exitMp}
            className="border border-white/50 px-10 py-3 text-sm tracking-[0.45em] transition-colors duration-200 hover:bg-white hover:text-black focus:outline-none focus:ring-1 focus:ring-white"
          >
            BACK TO THE MENU
          </button>
        </div>
      )}

      {/* ---------------- DEATH ---------------- */}
      {phase === 'dead' && result && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/90 px-6">
          <h2 className="mb-6 text-3xl font-light tracking-[0.5em] sm:text-4xl">
            {mpActiveRef.current && role === 'monster' ? 'THE PREY ESCAPED' : 'IT FOUND YOU'}
          </h2>
          <div className="mb-10 space-y-1.5 text-center text-[11px] tracking-[0.3em] text-white/50">
            {mpActiveRef.current && role === 'monster' ? (
              <p>THE HUNT LASTED {fmt(result.timeMs)}</p>
            ) : (
              <p>ENDURED {fmt(result.timeMs)}</p>
            )}
            <p>
              KEYS {result.keysFound}/{mpActiveRef.current ? 6 : 3} · PINGS {result.pings}
            </p>
            {mpActiveRef.current && role === 'monster' && result.door && (
              <p>ESCAPED THROUGH THE {result.door.toUpperCase()} DOOR</p>
            )}
          </div>
          {mpActiveRef.current ? (
            <>
              <button
                onClick={requestRematch}
                className="border border-white/50 px-10 py-3 text-sm tracking-[0.45em] transition-colors duration-200 hover:bg-white hover:text-black focus:outline-none focus:ring-1 focus:ring-white"
              >
                {iWant && peerWants ? 'RESTARTING…' : iWant ? 'WAITING FOR YOUR PARTNER…' : 'REMATCH'}
              </button>
              <button
                onClick={exitMp}
                className="mt-4 text-[10px] tracking-[0.4em] text-white/30 transition-colors hover:text-white/70"
              >
                BACK TO THE MENU
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => startGame()}
                className="border border-white/50 px-10 py-3 text-sm tracking-[0.45em] transition-colors duration-200 hover:bg-white hover:text-black focus:outline-none focus:ring-1 focus:ring-white"
              >
                TRY AGAIN
              </button>
              <p className="mt-5 text-[10px] tracking-[0.3em] text-white/25">PRESS R</p>
            </>
          )}
        </div>
      )}

      {/* ---------------- WIN ---------------- */}
      {phase === 'win' && result && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-y-auto bg-black/92 px-6 py-10">
          <h2 className="mb-2 text-3xl font-light tracking-[0.5em] sm:text-4xl">
            {mpActiveRef.current && role === 'monster' ? 'PREY SLAIN' : 'YOU ESCAPED'}
          </h2>
          <p className="mb-8 text-xs tracking-[0.4em] text-white/50">
            {mpActiveRef.current && role === 'monster'
              ? `THE HUNT LASTED ${fmt(result.timeMs)}`
              : `${fmt(result.timeMs)} · ${result.pings} PINGS`}
          </p>

          {mpActiveRef.current && role !== 'monster' && result.door && (
            <p className="-mt-5 mb-8 text-[10px] tracking-[0.4em] text-white/70">
              THROUGH THE {result.door.toUpperCase()} DOOR
            </p>
          )}

          {!mpActiveRef.current && best !== null && (
            <p className="mb-8 text-[11px] tracking-[0.35em] text-white/70">
              BEST ESCAPE — {fmt(best)}
            </p>
          )}

          {!mpActiveRef.current && escapes.length > 0 && (
            <div className="mb-10 w-full max-w-xs border border-white/10 p-4">
              <p className="mb-3 text-center text-[10px] tracking-[0.4em] text-white/40">
                FASTEST ESCAPES
              </p>
              <div className="space-y-1.5 text-[11px] tracking-[0.15em] text-white/60">
                {escapes.map((e, i) => (
                  <div key={i} className="flex items-center justify-between gap-3">
                    <span className="text-white/35">{String(i + 1).padStart(2, '0')}</span>
                    <span className="text-white/85">{fmt(e.timeMs)}</span>
                    <span className="text-white/30">{e.pings} P</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {mpActiveRef.current ? (
            <>
              <button
                onClick={requestRematch}
                className="border border-white/50 px-10 py-3 text-sm tracking-[0.45em] transition-colors duration-200 hover:bg-white hover:text-black focus:outline-none focus:ring-1 focus:ring-white"
              >
                {iWant && peerWants ? 'RESTARTING…' : iWant ? 'WAITING FOR YOUR PARTNER…' : 'REMATCH'}
              </button>
              <button
                onClick={exitMp}
                className="mt-4 text-[10px] tracking-[0.4em] text-white/30 transition-colors hover:text-white/70"
              >
                BACK TO THE MENU
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => startGame()}
                className="border border-white/50 px-10 py-3 text-sm tracking-[0.45em] transition-colors duration-200 hover:bg-white hover:text-black focus:outline-none focus:ring-1 focus:ring-white"
              >
                DESCEND AGAIN
              </button>
              <p className="mt-5 text-[10px] tracking-[0.3em] text-white/25">PRESS R</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
