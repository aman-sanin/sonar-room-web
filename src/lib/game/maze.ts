// The Sonar Room — maze generation & geometry helpers.
// Pure logic, no DOM. A grid maze is carved with a recursive backtracker,
// extra walls are knocked out to create loops, small chambers are opened,
// then gameplay positions (start / keys / door / monster) are chosen by
// BFS distance so every run is fair and solvable.

export interface Edge {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type DoorColor = 'white' | 'crimson' | 'jade'

export interface DoorSpec {
  midX: number
  midY: number
  vertical: boolean
  color: DoorColor
}

export interface KeySpec {
  x: number
  y: number
  color: DoorColor
}

export interface Vec {
  x: number
  y: number
}

export interface Cell {
  c: number
  r: number
}

export interface GameMap {
  cols: number
  rows: number
  cell: number
  w: number
  h: number
  solid: Uint8Array
  edges: Edge[]
  open: number[] // flat indices of reachable open cells
  start: Vec
  monsterStart: Vec
  keys: KeySpec[]
  /** Solo: one white door. Hunt: two colored doors on opposite ends. */
  doors: DoorSpec[]
}

export const MAP_COLS = 31
export const MAP_ROWS = 21
export const MAP_CELL = 46

/** Deterministic tiny PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * In-place Fisher–Yates shuffle.
 *
 * Not the C `sort(() => rng() - 0.5)` trick: that is order-dependent and
 * cannot be reproduced outside JS. This version consumes exactly N-1 random
 * values in a fixed order, so the Kotlin port can match it bit for bit.
 */
export function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = items[i]
    items[i] = items[j]
    items[j] = tmp
  }
  return items
}

const idx = (c: number, r: number): number => r * MAP_COLS + c

function inBounds(c: number, r: number): boolean {
  return c >= 0 && c < MAP_COLS && r >= 0 && r < MAP_ROWS
}

export function isSolid(map: GameMap, c: number, r: number): boolean {
  if (!inBounds(c, r)) return true
  return map.solid[idx(c, r)] === 1
}

export function cellCenter(map: GameMap, c: number, r: number): Vec {
  return { x: c * map.cell + map.cell / 2, y: r * map.cell + map.cell / 2 }
}

export function worldToCell(map: GameMap, x: number, y: number): Cell {
  return {
    c: Math.max(0, Math.min(map.cols - 1, Math.floor(x / map.cell))),
    r: Math.max(0, Math.min(map.rows - 1, Math.floor(y / map.cell))),
  }
}

/** BFS distances (in cells) from a start cell across open cells. Unreachable => -1. */
export function bfsDistances(map: GameMap, sc: number, sr: number): Int32Array {
  const { cols, rows, solid } = map
  const dist = new Int32Array(cols * rows).fill(-1)
  if (solid[idx(sc, sr)] === 1) return dist
  const q = new Int32Array(cols * rows)
  let head = 0
  let tail = 0
  q[tail++] = idx(sc, sr)
  dist[idx(sc, sr)] = 0
  const D: Cell[] = [
    { c: 1, r: 0 },
    { c: -1, r: 0 },
    { c: 0, r: 1 },
    { c: 0, r: -1 },
  ]
  while (head < tail) {
    const cur = q[head++]
    const cc = cur % cols
    const cr = Math.floor(cur / cols)
    const nd = dist[cur] + 1
    for (const d of D) {
      const nc = cc + d.c
      const nr = cr + d.r
      if (!inBounds(nc, nr)) continue
      const ni = idx(nc, nr)
      if (solid[ni] === 1 || dist[ni] !== -1) continue
      dist[ni] = nd
      q[tail++] = ni
    }
  }
  return dist
}

/** BFS path from cell to cell across open cells. Returns world waypoints, excluding the start cell. */
export function bfsPath(map: GameMap, sc: number, sr: number, tc: number, tr: number): Vec[] {
  const { cols, rows, solid } = map
  const si = idx(sc, sr)
  const ti = idx(tc, tr)
  if (solid[si] === 1 || solid[ti] === 1) return []
  const prev = new Int32Array(cols * rows).fill(-2)
  const q = new Int32Array(cols * rows)
  let head = 0
  let tail = 0
  q[tail++] = si
  prev[si] = -1
  const D: Cell[] = [
    { c: 1, r: 0 },
    { c: -1, r: 0 },
    { c: 0, r: 1 },
    { c: 0, r: -1 },
  ]
  let found = si === ti
  while (head < tail && !found) {
    const cur = q[head++]
    const cc = cur % cols
    const cr = Math.floor(cur / cols)
    for (const d of D) {
      const nc = cc + d.c
      const nr = cr + d.r
      if (!inBounds(nc, nr)) continue
      const ni = idx(nc, nr)
      if (solid[ni] === 1 || prev[ni] !== -2) continue
      prev[ni] = cur
      if (ni === ti) {
        found = true
        break
      }
      q[tail++] = ni
    }
  }
  if (!found) return []
  const path: Vec[] = []
  let cur = ti
  while (cur !== si && cur >= 0) {
    const c = cur % cols
    const r = Math.floor(cur / cols)
    path.push(cellCenter(map, c, r))
    cur = prev[cur]
  }
  path.reverse()
  return path
}

/** Nearest open cell to (c,r) by ring scan — used to sanitize targets. */
export function nearestOpenCell(map: GameMap, c: number, r: number): Cell {
  if (!isSolid(map, c, r)) return { c, r }
  for (let rad = 1; rad < Math.max(map.cols, map.rows); rad++) {
    for (let dc = -rad; dc <= rad; dc++) {
      for (let dr = -rad; dr <= rad; dr++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue
        const nc = c + dc
        const nr = r + dr
        if (inBounds(nc, nr) && !isSolid(map, nc, nr)) return { c: nc, r: nr }
      }
    }
  }
  return { c: 1, r: 1 }
}

/** Distance from point to segment. */
export function segDist(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const l2 = dx * dx + dy * dy
  let t = 0
  if (l2 > 0) t = ((px - x1) * dx + (py - y1) * dy) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

interface RawSeg {
  fixed: number
  a: number
  b: number
}

/** Merge collinear consecutive wall segments so outlines render as clean long lines. */
function mergeSegs(raw: RawSeg[], vertical: boolean): Edge[] {
  raw.sort((p, q) => p.fixed - q.fixed || p.a - q.a)
  const out: Edge[] = []
  for (const s of raw) {
    const last = out[out.length - 1]
    if (last) {
      if (vertical) {
        if (last.x1 === s.fixed && s.a <= last.y2 + 0.5) {
          last.y2 = Math.max(last.y2, s.b)
          continue
        }
      } else if (last.y1 === s.fixed && s.a <= last.x2 + 0.5) {
        last.x2 = Math.max(last.x2, s.b)
        continue
      }
    }
    out.push(
      vertical
        ? { x1: s.fixed, y1: s.a, x2: s.fixed, y2: s.b }
        : { x1: s.a, y1: s.fixed, x2: s.b, y2: s.fixed },
    )
  }
  return out
}

/**
 * @param seed deterministic map
 * @param hunt two-player variant: two colored doors + six colored keys
 */
export function generateMap(seed: number, hunt = false): GameMap {
  const rng = mulberry32(seed)
  const cols = MAP_COLS
  const rows = MAP_ROWS
  const cell = MAP_CELL
  const solid = new Uint8Array(cols * rows).fill(1)

  // --- Recursive backtracker carve on odd cells ---
  const stack: Cell[] = [{ c: 1, r: 1 }]
  solid[idx(1, 1)] = 0
  const DIRS: Cell[] = [
    { c: 2, r: 0 },
    { c: -2, r: 0 },
    { c: 0, r: 2 },
    { c: 0, r: -2 },
  ]
  while (stack.length > 0) {
    const cur = stack[stack.length - 1]
    const order = shuffle([...DIRS], rng)
    let carved = false
    for (const d of order) {
      const nc = cur.c + d.c
      const nr = cur.r + d.r
      if (nc < 1 || nc > cols - 2 || nr < 1 || nr > rows - 2) continue
      if (solid[idx(nc, nr)] === 0) continue
      solid[idx(cur.c + d.c / 2, cur.r + d.r / 2)] = 0
      solid[idx(nc, nr)] = 0
      stack.push({ c: nc, r: nr })
      carved = true
      break
    }
    if (!carved) stack.pop()
  }

  // --- Knock out extra walls to create loops (escape routes) ---
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (solid[idx(c, r)] !== 1) continue
      const h = solid[idx(c - 1, r)] === 0 && solid[idx(c + 1, r)] === 0
      const v = solid[idx(c, r - 1)] === 0 && solid[idx(c, r + 1)] === 0
      if ((h || v) && rng() < 0.13) solid[idx(c, r)] = 0
    }
  }

  // --- Carve two small chambers ---
  for (let i = 0; i < 2; i++) {
    const rc = 3 + 2 * Math.floor(rng() * ((cols - 9) / 2))
    const rr = 3 + 2 * Math.floor(rng() * ((rows - 9) / 2))
    for (let r = rr; r < rr + 3; r++) {
      for (let c = rc; c < rc + 3; c++) {
        if (c > 0 && c < cols - 1 && r > 0 && r < rows - 1) solid[idx(c, r)] = 0
      }
    }
  }

  const map: GameMap = {
    cols,
    rows,
    cell,
    w: cols * cell,
    h: rows * cell,
    solid,
    edges: [],
    open: [],
    start: { x: 0, y: 0 },
    monsterStart: { x: 0, y: 0 },
    keys: [],
    doors: [],
  }

  // --- Reachability from start; wall off unreachable pockets ---
  const dist = bfsDistances(map, 1, 1)
  for (let i = 0; i < solid.length; i++) {
    if (solid[i] === 0 && dist[i] === -1) solid[i] = 1
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (solid[idx(c, r)] === 0) map.open.push(idx(c, r))
    }
  }

  // --- Wall boundary edges (merged into clean strokes) ---
  const rawV: RawSeg[] = []
  const rawH: RawSeg[] = []
  const isOpen = (c: number, r: number): boolean => inBounds(c, r) && solid[idx(c, r)] === 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (solid[idx(c, r)] !== 1) continue
      const x = c * cell
      const y = r * cell
      if (isOpen(c - 1, r)) rawV.push({ fixed: x, a: y, b: y + cell })
      if (isOpen(c + 1, r)) rawV.push({ fixed: x + cell, a: y, b: y + cell })
      if (isOpen(c, r - 1)) rawH.push({ fixed: y, a: x, b: x + cell })
      if (isOpen(c, r + 1)) rawH.push({ fixed: y + cell, a: x, b: x + cell })
    }
  }
  map.edges = [...mergeSegs(rawV, true), ...mergeSegs(rawH, false)]

  // --- Player start ---
  map.start = cellCenter(map, 1, 1)

  // --- Border ring open cells (door candidates) ---
  const borderOpen: Cell[] = []
  for (const i of map.open) {
    const c = i % cols
    const r = Math.floor(i / cols)
    if (c === 1 || c === cols - 2 || r === 1 || r === rows - 2) borderOpen.push({ c, r })
  }

  const openCells: { c: number; r: number; d: number }[] = []
  for (const i of map.open) {
    const c = i % cols
    const r = Math.floor(i / cols)
    openCells.push({ c, r, d: dist[i] })
  }

  /** Build a door spec on the outer wall next to a border open cell. */
  const doorSpecFor = (cellPos: Cell, color: DoorColor): DoorSpec => {
    const dc = cellPos.c
    const dr = cellPos.r
    if (dc === 1) return { midX: cell, midY: dr * cell + cell / 2, vertical: true, color }
    if (dc === cols - 2)
      return { midX: (cols - 1) * cell, midY: dr * cell + cell / 2, vertical: true, color }
    if (dr === 1) return { midX: dc * cell + cell / 2, midY: cell, vertical: false, color }
    return { midX: dc * cell + cell / 2, midY: (rows - 1) * cell, vertical: false, color }
  }

  if (!hunt) {
    // --- Solo: one white exit door, farthest from start; three white keys ---
    let bestDoor = borderOpen[0] ?? { c: cols - 2, r: rows - 2 }
    let bestD = -1
    for (const cellPos of borderOpen) {
      const d = dist[idx(cellPos.c, cellPos.r)]
      if (d > bestD) {
        bestD = d
        bestDoor = cellPos
      }
    }
    map.doors = [doorSpecFor(bestDoor, 'white')]

    const doorCell = worldToCell(map, map.doors[0].midX, map.doors[0].midY)
    const keys: Cell[] = []
    let guard = 0
    while (keys.length < 3 && guard++ < 4000) {
      const cand = openCells[Math.floor(rng() * openCells.length)]
      if (cand.d < 10) continue
      if (Math.abs(cand.c - doorCell.c) + Math.abs(cand.r - doorCell.r) < 4) continue
      let ok = true
      for (const k of keys) {
        if (Math.hypot(k.c - cand.c, k.r - cand.r) < 8) {
          ok = false
          break
        }
      }
      if (ok) keys.push({ c: cand.c, r: cand.r })
    }
    while (keys.length < 3) {
      const cand = openCells[Math.floor(rng() * openCells.length)]
      keys.push({ c: cand.c, r: cand.r })
    }
    map.keys = keys.map((k) => ({ ...cellCenter(map, k.c, k.r), color: 'white' as DoorColor }))
  } else {
    // --- Hunt: two far-apart colored doors; each door's three keys spawn on
    //     the FAR side of the maze from that door, so the prey must cross. ---
    let doorA = borderOpen[0] ?? { c: cols - 2, r: rows - 2 }
    let bestA = -1
    for (const cellPos of borderOpen) {
      const d = dist[idx(cellPos.c, cellPos.r)]
      if (d > bestA) {
        bestA = d
        doorA = cellPos
      }
    }
    let doorB = borderOpen[0] ?? { c: 1, r: rows - 2 }
    let bestB = -1
    for (const cellPos of borderOpen) {
      const d = Math.hypot(cellPos.c * cell - doorA.c * cell, cellPos.r * cell - doorA.r * cell)
      if (d > bestB) {
        bestB = d
        doorB = cellPos
      }
    }
    const flip = rng() < 0.5
    const colorA: DoorColor = flip ? 'jade' : 'crimson'
    const colorB: DoorColor = flip ? 'crimson' : 'jade'
    map.doors = [doorSpecFor(doorA, colorA), doorSpecFor(doorB, colorB)]

    // BFS distances from each door's adjacent open cell.
    const cellA = worldToCell(map, map.doors[0].midX, map.doors[0].midY)
    const cellB = worldToCell(map, map.doors[1].midX, map.doors[1].midY)
    const nearA = nearestOpenCell(map, cellA.c, cellA.r)
    const nearB = nearestOpenCell(map, cellB.c, cellB.r)
    const dA = bfsDistances(map, nearA.c, nearA.r)
    const dB = bfsDistances(map, nearB.c, nearB.r)

    const keys: { c: number; r: number; color: DoorColor }[] = []
    const colorTasks: [DoorColor, Int32Array, Int32Array][] = [
      [colorA, dA, dB],
      [colorB, dB, dA],
    ]
    for (const [color, own, other] of colorTasks) {
      let placed = 0
      let relax = 0 // progressively loosen constraints if the maze is tight
      let guard = 0
      while (placed < 3 && relax <= 3) {
        guard++
        if (guard > 6000) {
          relax++
          guard = 0
          continue
        }
        const cand = openCells[Math.floor(rng() * openCells.length)]
        const od = own[idx(cand.c, cand.r)]
        const td = other[idx(cand.c, cand.r)]
        if (od < 0 || td < 0) continue
        // Keys of a color live closer to the OTHER door (cross the maze).
        if (relax === 0 && od <= td) continue
        if (relax === 1 && od < td) continue
        if (cand.d < (relax >= 2 ? 4 : 7)) continue
        let ok = true
        for (const k of keys) {
          const lim = relax >= 3 ? 3 : k.color === color ? 6 : 4
          if (Math.hypot(k.c - cand.c, k.r - cand.r) < lim) {
            ok = false
            break
          }
        }
        if (ok && relax < 3) {
          if (Math.abs(cand.c - nearA.c) + Math.abs(cand.r - nearA.r) < 3) ok = false
          if (Math.abs(cand.c - nearB.c) + Math.abs(cand.r - nearB.r) < 3) ok = false
        }
        if (ok) {
          keys.push({ c: cand.c, r: cand.r, color })
          placed++
        }
      }
      while (placed < 3) {
        const cand = openCells[Math.floor(rng() * openCells.length)]
        keys.push({ c: cand.c, r: cand.r, color })
        placed++
      }
    }
    map.keys = keys.map((k) => ({ ...cellCenter(map, k.c, k.r), color: k.color }))
  }

  // --- Monster spawn: farthest reachable cell from the player ---
  let mBest = openCells[0]
  let mD = -1
  for (const oc of openCells) {
    if (oc.d > mD) {
      mD = oc.d
      mBest = oc
    }
  }
  map.monsterStart = cellCenter(map, mBest.c, mBest.r)

  return map
}
