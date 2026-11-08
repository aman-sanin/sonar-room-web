// The Sonar Room — multiplayer protocol (shared by both clients).
// The room service relays these events verbatim between the two devices.
// The survivor's client is authoritative: it owns the maze run, the keys,
// the door, and the kill. The hunter's client owns its own body.

export type Role = 'survivor' | 'monster'

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
  /** Survivor picked up a key (n of 3). */
  | { t: 'keys'; n: number }
  /** Survivor escaped through the door. */
  | { t: 'end'; outcome: 'escaped' | 'caught'; timeMs: number; keysFound: number; pings: number }
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
