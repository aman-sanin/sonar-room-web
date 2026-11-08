// The Sonar Room — multiplayer protocol (shared by both clients).
// The room service relays these events verbatim between the two devices.
// The survivor's client is authoritative: it owns the maze run, the keys,
// the doors, the unlock channels, and the kill. The hunter's client owns
// its own body.

export type Role = 'survivor' | 'monster'

export type HuntDoorColor = 'crimson' | 'jade'

/** Per-color key tally, reported whenever the survivor grabs a key. */
export interface KeyCounts {
  total: number
  crimson: number
  jade: number
}

/** Events relayed through the room service (hunt:evt). */
export type HuntEvt =
  /** Host → guest: begin a run on this shared maze seed. */
  | { t: 'start'; seed: number }
  /** Movement sample, sent ~15 Hz by whichever side owns the body. */
  | { t: 'pos'; x: number; y: number; moving: boolean }
  /** The survivor's sonar ping — a shared physical event. Full reveal for both. */
  | { t: 'ping'; x: number; y: number }
  /** The hunter's echolocation click — jagged, dim reveal for both. */
  | { t: 'click'; x: number; y: number }
  /**
   * Survivor grabbed a key. `i` is the taken key's index in the shared
   * map's key list (identical on both clients — placement is seeded), so
   * the hunter can retire the exact key. Counts are the authoritative tally.
   */
  | { t: 'keys'; i: number; crimson: number; jade: number }
  /**
   * The survivor is working a door's lock (3-second channel). Emitted when
   * progress moves in 1/8th steps, on unlock, and on interrupt. Both sides
   * hear the lock rattle; the hunter learns where the prey is pressing.
   */
  | { t: 'door'; i: 0 | 1; color: HuntDoorColor; progress: number; unlocked: boolean }
  /** Survivor escaped through a door, or was caught. */
  | {
      t: 'end'
      outcome: 'escaped' | 'caught'
      timeMs: number
      keysFound: number
      pings: number
      door?: HuntDoorColor
    }
  /** Either side asks for a rematch. */
  | { t: 'rematch' }
  /** The other device dropped. */
  | { t: 'peer-lost' }

export interface ReadyPayload {
  myRole: Role
  peerRole: Role
}

export interface CreateAck {
  ok: boolean
  code?: string
  role?: Role
  error?: string
}

export interface JoinAck {
  ok: boolean
  code?: string
  role?: Role
  error?: string
}
