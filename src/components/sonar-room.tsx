'use client'

// THE SONAR ROOM — you are blind. Click to ping, WASD to move.
// The screen is 90% black; the world only exists where sound has touched it.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SonarEngine, RunResult } from '@/lib/game/engine'
import { SoundEngine } from '@/lib/game/audio'

type Phase = 'menu' | 'playing' | 'dead' | 'win'

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

  const [phase, setPhaseState] = useState<Phase>('menu')
  const [keysFound, setKeysFound] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)
  const [best, setBest] = useState<number | null>(null)
  const [escapes, setEscapes] = useState<Escape[]>([])
  const [touchMode, setTouchMode] = useState(false)
  const [menuVisible, setMenuVisible] = useState(true)

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
    (r: RunResult) => {
      setResult(r)
      // Let the death flash / win tone breathe before the overlay lands.
      window.clearTimeout(endDelayRef.current)
      endDelayRef.current = window.setTimeout(() => {
        setPhase(r.outcome === 'escaped' ? 'win' : 'dead')
        setMenuVisible(true)
      }, r.outcome === 'escaped' ? 700 : 1100)
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

  const startGame = useCallback(() => {
    const audio = audioRef.current
    const engine = engineRef.current
    if (!audio || !engine) return
    // Touch-capable devices get the joystick from the very first frame —
    // never make a blind player tap first just to unlock their controls.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
    const touchable = (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window
    if (coarse || touchable) setTouchMode(true)
    audio.ensure()
    window.clearTimeout(endDelayRef.current)
    resetJoy()
    setResult(null)
    setKeysFound(0)
    setToast(null)
    setMenuVisible(false)
    engine.start()
    setPhase('playing')
  }, [resetJoy, setPhase])

  // ------------------------------------------------------------ bootstrap
  useEffect(() => {
    const audio = new SoundEngine()
    audioRef.current = audio
    const engine = new SonarEngine(audio, {
      onKeys: setKeysFound,
      onToast: showToast,
      onEnd: handleEnd,
    })
    engineRef.current = engine

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
        if (phaseRef.current === 'menu') startGame()
        else if (phaseRef.current === 'playing') engine.ping()
        else startGame()
      }
      if (k === 'r' && (phaseRef.current === 'dead' || phaseRef.current === 'win')) {
        startGame()
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
      audio.dispose()
    }
  }, [handleEnd, loadEscapes, resetJoy, showToast, startGame])

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
          {/* Keys */}
          <div className="absolute left-4 top-4 flex items-center gap-3 sm:left-6 sm:top-6">
            <span className="sr-only">Keys collected: {keysFound} of 3</span>
            <div className="flex items-center gap-2" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={`h-2.5 w-2.5 rotate-45 border transition-all duration-300 ${
                    i < keysFound ? 'border-white bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]' : 'border-white/40'
                  }`}
                />
              ))}
            </div>
            <span className="text-[10px] tracking-[0.35em] text-white/40">KEYS</span>
          </div>
          {/* Timer */}
          <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
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
                TAP — PING
                <br />
                STICK — MOVE
              </>
            ) : (
              <>
                CLICK / SPACE — PING&nbsp;&nbsp;·&nbsp;&nbsp;W A S D — MOVE
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
            <div className="mt-3 border-t border-white/10 pt-3 text-center text-[10px] leading-relaxed text-white/40">
              THE RINGS REVEAL THE WALLS FOR A MOMENT.
              <br />
              SOMETHING ELSE HEARS EVERY PING YOU MAKE.
            </div>
          </div>

          <button
            onClick={startGame}
            className="border border-white/50 px-12 py-3.5 text-sm tracking-[0.5em] transition-colors duration-200 hover:bg-white hover:text-black focus:outline-none focus:ring-1 focus:ring-white"
          >
            BEGIN
          </button>

          <div className="mt-8 flex flex-col items-center gap-1.5 text-[10px] tracking-[0.25em] text-white/30">
            {best !== null && <span>BEST ESCAPE — {fmt(best)}</span>}
            <span>HEADPHONES STRONGLY RECOMMENDED</span>
          </div>
        </div>
      )}

      {/* ---------------- DEATH ---------------- */}
      {phase === 'dead' && result && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/90 px-6">
          <h2 className="mb-6 text-3xl font-light tracking-[0.5em] sm:text-4xl">
            IT FOUND YOU
          </h2>
          <div className="mb-10 space-y-1.5 text-center text-[11px] tracking-[0.3em] text-white/50">
            <p>ENDURED {fmt(result.timeMs)}</p>
            <p>
              KEYS {result.keysFound}/3 · PINGS {result.pings}
            </p>
          </div>
          <button
            onClick={startGame}
            className="border border-white/50 px-10 py-3 text-sm tracking-[0.45em] transition-colors duration-200 hover:bg-white hover:text-black focus:outline-none focus:ring-1 focus:ring-white"
          >
            TRY AGAIN
          </button>
          <p className="mt-5 text-[10px] tracking-[0.3em] text-white/25">PRESS R</p>
        </div>
      )}

      {/* ---------------- WIN ---------------- */}
      {phase === 'win' && result && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-y-auto bg-black/92 px-6 py-10">
          <h2 className="mb-2 text-3xl font-light tracking-[0.5em] sm:text-4xl">
            YOU ESCAPED
          </h2>
          <p className="mb-8 text-xs tracking-[0.4em] text-white/50">
            {fmt(result.timeMs)} · {result.pings} PINGS
          </p>

          {best !== null && (
            <p className="mb-8 text-[11px] tracking-[0.35em] text-white/70">
              BEST ESCAPE — {fmt(best)}
            </p>
          )}

          {escapes.length > 0 && (
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

          <button
            onClick={startGame}
            className="border border-white/50 px-10 py-3 text-sm tracking-[0.45em] transition-colors duration-200 hover:bg-white hover:text-black focus:outline-none focus:ring-1 focus:ring-white"
          >
            DESCEND AGAIN
          </button>
          <p className="mt-5 text-[10px] tracking-[0.3em] text-white/25">PRESS R</p>
        </div>
      )}
    </div>
  )
}
