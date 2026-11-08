// The Sonar Room — procedural audio engine (Web Audio API, zero assets).
// Everything is synthesized: sonar pings, echoing wall thuds, the monster's
// screech/growls/clicks, heartbeat, cave ambience and a convolution reverb
// built from a generated impulse response. Stereo panning maps the world:
// pan = (sourceX - playerX) / range.

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

function makeDistortionCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 257
  const curve = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x)
  }
  return curve
}

export class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private wet: GainNode | null = null
  private dangerGain: GainNode | null = null
  private exitGain: GainNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private distCurve: Float32Array<ArrayBuffer> = makeDistortionCurve(2.4)

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running'
  }

  /** Must be called from a user gesture. Idempotent. */
  ensure(): void {
    if (typeof window === 'undefined') return
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    this.ctx = ctx

    const master = ctx.createGain()
    master.gain.value = 0
    master.gain.setTargetAtTime(0.9, ctx.currentTime + 0.05, 0.3)
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -20
    comp.knee.value = 18
    comp.ratio.value = 8
    comp.attack.value = 0.004
    comp.release.value = 0.24
    master.connect(comp)
    comp.connect(ctx.destination)
    this.master = master

    // Shared noise buffer.
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const nd = nb.getChannelData(0)
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1
    this.noiseBuf = nb

    // Cave reverb (generated impulse).
    const conv = ctx.createConvolver()
    conv.buffer = this.makeImpulse(2.3, 3.1)
    const convGain = ctx.createGain()
    convGain.gain.value = 0.5
    conv.connect(convGain)
    convGain.connect(master)
    const wet = ctx.createGain()
    wet.connect(conv)
    this.wet = wet

    // Constant low ambience — breathing cave.
    const amb = ctx.createBufferSource()
    amb.buffer = nb
    amb.loop = true
    const ambLp = ctx.createBiquadFilter()
    ambLp.type = 'lowpass'
    ambLp.frequency.value = 130
    const ambLfo = ctx.createOscillator()
    ambLfo.frequency.value = 0.07
    const ambLfoG = ctx.createGain()
    ambLfoG.gain.value = 45
    ambLfo.connect(ambLfoG)
    ambLfoG.connect(ambLp.frequency)
    const ambG = ctx.createGain()
    ambG.gain.value = 0.028
    amb.connect(ambLp)
    ambLp.connect(ambG)
    ambG.connect(master)
    amb.start()
    ambLfo.start()

    // Dissonant danger drone (gain driven by monster proximity).
    const dg = ctx.createGain()
    dg.gain.value = 0
    const dLp = ctx.createBiquadFilter()
    dLp.type = 'lowpass'
    dLp.frequency.value = 210
    const d1 = ctx.createOscillator()
    d1.type = 'sawtooth'
    d1.frequency.value = 52
    const d2 = ctx.createOscillator()
    d2.type = 'sawtooth'
    d2.frequency.value = 55.7
    d1.connect(dLp)
    d2.connect(dLp)
    dLp.connect(dg)
    dg.connect(master)
    d1.start()
    d2.start()
    this.dangerGain = dg

    // Exit-door hum (active once the door is unlocked).
    const eg = ctx.createGain()
    eg.gain.value = 0
    const e1 = ctx.createOscillator()
    e1.type = 'sine'
    e1.frequency.value = 98
    const e2 = ctx.createOscillator()
    e2.type = 'sine'
    e2.frequency.value = 197.2
    const e2g = ctx.createGain()
    e2g.gain.value = 0.35
    e1.connect(eg)
    e2.connect(e2g)
    e2g.connect(eg)
    const esend = ctx.createGain()
    esend.gain.value = 0.5
    eg.connect(master)
    eg.connect(esend)
    esend.connect(wet)
    e1.start()
    e2.start()
    this.exitGain = eg
  }

  private makeImpulse(dur: number, decay: number): AudioBuffer | null {
    if (!this.ctx) return null
    const sr = this.ctx.sampleRate
    const len = Math.floor(sr * dur)
    const buf = this.ctx.createBuffer(2, len, sr)
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch)
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
      }
    }
    return buf
  }

  /** Build a panned output node wired dry + wet. Returns null when audio is off. */
  private out(pan: number, dry = 1, wetAmt = 0.3): StereoPannerNode | null {
    if (!this.ctx || !this.master || !this.wet) return null
    const p = this.ctx.createStereoPanner()
    p.pan.value = clamp(pan, -1, 1)
    if (dry > 0) {
      const g = this.ctx.createGain()
      g.gain.value = dry
      p.connect(g)
      g.connect(this.master)
    }
    if (wetAmt > 0) {
      const g = this.ctx.createGain()
      g.gain.value = wetAmt
      p.connect(g)
      g.connect(this.wet)
    }
    return p
  }

  private noiseSource(): AudioBufferSourceNode | null {
    if (!this.ctx || !this.noiseBuf) return null
    const src = this.ctx.createBufferSource()
    src.buffer = this.noiseBuf
    src.loop = true
    return src
  }

  // ------------------------------------------------------------------ SFX

  /** The sonar "bwoop". */
  ping(): void {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const p = this.out(0, 1, 0.55)
    if (!p) return
    const o = this.ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(760, t)
    o.frequency.exponentialRampToValueAtTime(175, t + 0.34)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.4, t + 0.014)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.42)
    o.connect(g)
    g.connect(p)
    o.start(t)
    o.stop(t + 0.46)

    const o2 = this.ctx.createOscillator()
    o2.type = 'sine'
    o2.frequency.setValueAtTime(1520, t)
    o2.frequency.exponentialRampToValueAtTime(350, t + 0.3)
    const g2 = this.ctx.createGain()
    g2.gain.setValueAtTime(0, t)
    g2.gain.linearRampToValueAtTime(0.09, t + 0.01)
    g2.gain.exponentialRampToValueAtTime(0.0006, t + 0.34)
    o2.connect(g2)
    g2.connect(p)
    o2.start(t)
    o2.stop(t + 0.38)

    const src = this.noiseSource()
    if (src) {
      const hp = this.ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 2200
      const ng = this.ctx.createGain()
      ng.gain.setValueAtTime(0.12, t)
      ng.gain.exponentialRampToValueAtTime(0.0005, t + 0.03)
      src.connect(hp)
      hp.connect(ng)
      ng.connect(p)
      src.start(t)
      src.stop(t + 0.05)
    }
  }

  /** The prey's sonar ping, as heard by the hunter — loud, panned, distant. */
  pingHeard(pan: number, vol: number): void {
    if (!this.ctx || vol <= 0.004) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.85)
    if (!p) return
    const o = this.ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(700, t)
    o.frequency.exponentialRampToValueAtTime(160, t + 0.38)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(clamp(vol * 0.62, 0, 0.6), t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.5)
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1400
    o.connect(g)
    g.connect(lp)
    lp.connect(p)
    o.start(t)
    o.stop(t + 0.55)
  }

  /** Dull wall thud when a ping wavefront strikes masonry. */
  thud(pan: number, vol: number): void {
    if (!this.ctx || vol <= 0.004) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.35)
    if (!p) return
    const o = this.ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(120 + Math.random() * 40, t)
    o.frequency.exponentialRampToValueAtTime(44, t + 0.13)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(clamp(vol, 0, 0.85), t + 0.006)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.17)
    o.connect(g)
    g.connect(p)
    o.start(t)
    o.stop(t + 0.2)

    const src = this.noiseSource()
    if (src) {
      const lp = this.ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 300
      const ng = this.ctx.createGain()
      ng.gain.setValueAtTime(vol * 0.3, t)
      ng.gain.exponentialRampToValueAtTime(0.0005, t + 0.07)
      src.connect(lp)
      lp.connect(ng)
      ng.connect(p)
      src.start(t)
      src.stop(t + 0.09)
    }
  }

  /** Sharp monster screech — triggered when a ping touches it, or it charges. */
  screech(pan: number, vol = 0.5): void {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.45)
    if (!p) return
    const o = this.ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.setValueAtTime(950, t)
    o.frequency.exponentialRampToValueAtTime(2400, t + 0.14)
    o.frequency.exponentialRampToValueAtTime(620, t + 0.56)
    const lfo = this.ctx.createOscillator()
    lfo.frequency.value = 27
    const lg = this.ctx.createGain()
    lg.gain.value = 190
    lfo.connect(lg)
    lg.connect(o.frequency)
    const bp = this.ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1500
    bp.Q.value = 0.8
    const ws = this.ctx.createWaveShaper()
    ws.curve = this.distCurve
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(clamp(vol, 0, 0.85), t + 0.02)
    g.gain.setValueAtTime(clamp(vol, 0, 0.85) * 0.8, t + 0.34)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.62)
    o.connect(bp)
    bp.connect(ws)
    ws.connect(g)
    g.connect(p)
    o.start(t)
    lfo.start(t)
    o.stop(t + 0.66)
    lfo.stop(t + 0.66)

    const src = this.noiseSource()
    if (src) {
      const nb = this.ctx.createBiquadFilter()
      nb.type = 'bandpass'
      nb.frequency.value = 3100
      nb.Q.value = 2
      const ng = this.ctx.createGain()
      ng.gain.setValueAtTime(vol * 0.35, t)
      ng.gain.exponentialRampToValueAtTime(0.0006, t + 0.45)
      src.connect(nb)
      nb.connect(ng)
      ng.connect(p)
      src.start(t)
      src.stop(t + 0.5)
    }
  }

  /** Low unsettling growl — the monster idling somewhere in the dark. */
  growl(pan: number, vol: number): void {
    if (!this.ctx || vol <= 0.004) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.5)
    if (!p) return
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 160
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(clamp(vol, 0, 0.6), t + 0.14)
    g.gain.setValueAtTime(clamp(vol, 0, 0.6), t + 0.5)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.95)
    const am = this.ctx.createOscillator()
    am.frequency.value = 5.3
    const amg = this.ctx.createGain()
    amg.gain.value = clamp(vol, 0, 0.6) * 0.4
    am.connect(amg)
    amg.connect(g.gain)
    for (const f of [46, 69.5]) {
      const o = this.ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.connect(lp)
      o.start(t)
      o.stop(t + 1)
    }
    lp.connect(g)
    g.connect(p)
    am.start(t)
    am.stop(t + 1)
  }

  /** The monster's own echolocation click — you hear where it is. */
  monsterClick(pan: number, vol: number): void {
    if (!this.ctx || vol <= 0.004) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.85)
    if (!p) return
    const src = this.noiseSource()
    if (src) {
      const bp = this.ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 1850
      bp.Q.value = 9
      const g = this.ctx.createGain()
      g.gain.setValueAtTime(clamp(vol, 0, 0.5), t)
      g.gain.exponentialRampToValueAtTime(0.0006, t + 0.06)
      src.connect(bp)
      bp.connect(g)
      g.connect(p)
      src.start(t)
      src.stop(t + 0.08)
    }
    const o = this.ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(1150, t)
    o.frequency.exponentialRampToValueAtTime(480, t + 0.07)
    const g2 = this.ctx.createGain()
    g2.gain.setValueAtTime(vol * 0.4, t)
    g2.gain.exponentialRampToValueAtTime(0.0006, t + 0.09)
    o.connect(g2)
    g2.connect(p)
    o.start(t)
    o.stop(t + 0.11)
  }

  /** Heavy monster footstep while it hunts you. */
  monsterStep(pan: number, vol: number): void {
    if (!this.ctx || vol <= 0.004) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.3)
    if (!p) return
    const o = this.ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(72, t)
    o.frequency.exponentialRampToValueAtTime(36, t + 0.09)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(clamp(vol, 0, 0.5), t)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.12)
    o.connect(g)
    g.connect(p)
    o.start(t)
    o.stop(t + 0.14)
  }

  /** Bright chime — a key is found. */
  chime(pan: number, vol: number): void {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.5)
    if (!p) return
    const notes: [number, number][] = [
      [1318.5, 0],
      [1975.5, 0.09],
      [2637, 0.16],
    ]
    for (const [f, d] of notes) {
      const o = this.ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f
      const g = this.ctx.createGain()
      const t0 = t + d
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(vol * (d === 0 ? 0.5 : 0.32), t0 + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.42)
      o.connect(g)
      g.connect(p)
      o.start(t0)
      o.stop(t0 + 0.46)
    }
  }

  /** Faint jingle — a hidden key answers your presence. */
  jingle(pan: number, vol: number): void {
    if (!this.ctx || vol <= 0.004) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.6)
    if (!p) return
    for (const [f, d] of [
      [2340, 0],
      [2340, 0.1],
    ] as [number, number][]) {
      const o = this.ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f
      const g = this.ctx.createGain()
      const t0 = t + d
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(vol, t0 + 0.008)
      g.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.1)
      o.connect(g)
      g.connect(p)
      o.start(t0)
      o.stop(t0 + 0.12)
    }
  }

  /** Heartbeat — the monster is near. */
  heartbeat(vol: number): void {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const p = this.out(0, 1, 0.12)
    if (!p) return
    for (const [d, v] of [
      [0, vol],
      [0.19, vol * 0.65],
    ] as [number, number][]) {
      const o = this.ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(58, t + d)
      o.frequency.exponentialRampToValueAtTime(40, t + d + 0.1)
      const g = this.ctx.createGain()
      g.gain.setValueAtTime(0, t + d)
      g.gain.linearRampToValueAtTime(clamp(v, 0, 0.7), t + d + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0008, t + d + 0.13)
      o.connect(g)
      g.connect(p)
      o.start(t + d)
      o.stop(t + d + 0.16)
    }
  }

  /** Soft footstep (pan optional — the hunter hears prey footsteps). */
  step(vol: number, pan = 0): void {
    if (!this.ctx || vol <= 0.004) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.15)
    if (!p) return
    const src = this.noiseSource()
    if (!src) return
    const bp = this.ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 850 + Math.random() * 250
    bp.Q.value = 1.1
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.045)
    src.connect(bp)
    bp.connect(g)
    g.connect(p)
    src.start(t)
    src.stop(t + 0.06)
  }

  /** Deep tone when the ping reveals the exit door. */
  doorTone(pan: number, vol: number): void {
    if (!this.ctx || vol <= 0.004) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.7)
    if (!p) return
    for (const [f, v] of [
      [98, 1],
      [147, 0.4],
    ] as [number, number][]) {
      const o = this.ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f
      const g = this.ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(vol * v, t + 0.03)
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.7)
      o.connect(g)
      g.connect(p)
      o.start(t)
      o.stop(t + 0.75)
    }
  }

  /** Soft repeating beacon once the door is unlocked. */
  doorBlip(pan: number, vol: number): void {
    if (!this.ctx || vol <= 0.004) return
    const t = this.ctx.currentTime
    const p = this.out(pan, 1, 0.8)
    if (!p) return
    const o = this.ctx.createOscillator()
    o.type = 'triangle'
    o.frequency.setValueAtTime(196, t)
    o.frequency.linearRampToValueAtTime(185, t + 0.24)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.3)
    o.connect(g)
    g.connect(p)
    o.start(t)
    o.stop(t + 0.33)
  }

  /** All three keys collected — the door unlocks. */
  unlock(): void {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const p = this.out(0, 1, 0.6)
    if (!p) return
    const src = this.noiseSource()
    if (src) {
      const lp = this.ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.setValueAtTime(180, t)
      lp.frequency.exponentialRampToValueAtTime(1400, t + 0.9)
      const ng = this.ctx.createGain()
      ng.gain.setValueAtTime(0.09, t)
      ng.gain.exponentialRampToValueAtTime(0.0006, t + 1.0)
      src.connect(lp)
      lp.connect(ng)
      ng.connect(p)
      src.start(t)
      src.stop(t + 1.05)
    }
    for (const [f, d, v] of [
      [65.4, 0, 0.4],
      [130.8, 0.12, 0.26],
      [1046.5, 0.55, 0.2],
      [1568, 0.63, 0.14],
    ] as [number, number, number][]) {
      const o = this.ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f
      const g = this.ctx.createGain()
      const t0 = t + d
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(v, t0 + 0.03)
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 1.1)
      o.connect(g)
      g.connect(p)
      o.start(t0)
      o.stop(t0 + 1.15)
    }
  }

  /** Victory — daylight (well, white). */
  win(): void {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const p = this.out(0, 1, 0.8)
    if (!p) return
    const padO = this.ctx.createOscillator()
    padO.type = 'sine'
    padO.frequency.value = 65.4
    const padG = this.ctx.createGain()
    padG.gain.setValueAtTime(0, t)
    padG.gain.linearRampToValueAtTime(0.18, t + 0.4)
    padG.gain.exponentialRampToValueAtTime(0.0008, t + 2.4)
    padO.connect(padG)
    padG.connect(p)
    padO.start(t)
    padO.stop(t + 2.5)
    const notes = [261.6, 392, 523.3, 784]
    notes.forEach((f, i) => {
      const t0 = t + 0.15 + i * 0.17
      const o = this.ctx!.createOscillator()
      o.type = i % 2 === 0 ? 'sine' : 'triangle'
      o.frequency.value = f
      const g = this.ctx!.createGain()
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(0.22, t0 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.8)
      o.connect(g)
      g.connect(p)
      o.start(t0)
      o.stop(t0 + 0.85)
    })
  }

  /** Death — a shriek and the floor falling out of the world. */
  death(): void {
    if (!this.ctx) return
    this.screech(0, 0.8)
    const t = this.ctx.currentTime
    const p = this.out(0, 1, 0.5)
    if (!p) return
    const o = this.ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(48, t)
    o.frequency.exponentialRampToValueAtTime(26, t + 1.4)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.7, t + 0.03)
    g.gain.exponentialRampToValueAtTime(0.0008, t + 1.6)
    o.connect(g)
    g.connect(p)
    o.start(t)
    o.stop(t + 1.65)
    const src = this.noiseSource()
    if (src) {
      const bp = this.ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.setValueAtTime(900, t)
      bp.frequency.exponentialRampToValueAtTime(80, t + 1.3)
      const ng = this.ctx.createGain()
      ng.gain.setValueAtTime(0.4, t)
      ng.gain.exponentialRampToValueAtTime(0.0006, t + 1.4)
      src.connect(bp)
      bp.connect(ng)
      ng.connect(p)
      src.start(t)
      src.stop(t + 1.45)
    }
  }

  /** Continuous danger drone level 0..1 (monster proximity). */
  setDanger(level: number): void {
    if (!this.ctx || !this.dangerGain) return
    this.dangerGain.gain.setTargetAtTime(clamp(level, 0, 1) * 0.15, this.ctx.currentTime, 0.18)
  }

  /** Continuous exit hum level 0..1. */
  setExitHum(level: number): void {
    if (!this.ctx || !this.exitGain) return
    this.exitGain.gain.setTargetAtTime(clamp(level, 0, 1) * 0.1, this.ctx.currentTime, 0.25)
  }

  dispose(): void {
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
      this.master = null
      this.wet = null
      this.dangerGain = null
      this.exitGain = null
    }
  }
}
