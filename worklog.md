# Worklog

---
Task ID: 1
Agent: AI Assistant (main)
Task: Build "The Sonar Room" — an echolocation horror game (audio as graphics) as the / route of the Next.js project.

Work Log:
- Inspected project scaffold (Next.js 16 App Router, Tailwind 4, Prisma/SQLite on port 3000, dev server already running).
- Created `src/lib/game/maze.ts`: seeded maze generation (recursive backtracker on a 31×21 grid, extra wall knockouts for loops, two chambers), BFS distances/paths, collinear edge merging, point-segment distance, and placement of start / 3 keys / exit door (farthest border cell) / monster spawn (farthest reachable cell).
- Created `src/lib/game/audio.ts`: fully procedural Web Audio engine — no assets. Sonar "bwoop" (freq sweep + click), dull wall thuds (proximity-scheduled when the ping wavefront strikes an edge), harsh screech (sawtooth + vibrato + waveshaper), growls, monster echolocation clicks, chimes, jingles, heartbeat, footsteps, door tone/blip, unlock/win/death stingers, cave convolution reverb from a generated impulse, low ambience, dissonant danger drone and exit hum (continuous gains driven per frame), stereo panning mapped from world X relative to the player.
- Created `src/lib/game/engine.ts`: core simulation. Expanding ping wavefronts reveal wall edges (alpha decays, exp fade τ=0.55s), keys, door and the monster; rings visually "corrupt" near the monster; monster-click pings re-reveal the world dimly/jagged through ITS senses. Monster AI: dormant (8s grace) → wander (biased drift toward the player) → investigate (heard pings, delayed reaction) → chase (sense radius 150px; loses you beyond 310px for 2.2s); catch radius 20px. Keys auto-pickup, unlock at 3, door beacon pings + hum, danger/heartbeat scheduling, camera follow, screen shake, danger static specks, death flash. Grid circle-vs-cell collision for the player.
- Added `Run` model to `prisma/schema.prisma`, pushed with `bun run db:push`; created `src/lib/db.ts` and `src/app/api/runs/route.ts` (GET fastest 5 escapes, POST finished runs, both failure-tolerant).
- Created `src/components/sonar-room.tsx` ('use client'): full-screen canvas, RAF loop, DPR-aware resize, keyboard (WASD/arrows/Space/Enter/R — accepts both e.code and e.key), click/space to ping, touch mode with virtual joystick (left) and tap-to-ping, HUD (3 key diamonds, timer via ref, fading hint, toasts), menu / death / win overlays with stats, local best time (localStorage) and global "FASTEST ESCAPES" leaderboard from the API. Replaced `src/app/page.tsx`; updated layout metadata.
- Fixed ESLint issues (refs during render in joystick knob → imperative DOM updates; setState-in-effect → queueMicrotask) and a TS Float32Array<ArrayBuffer> typing issue in audio.ts.
- Browser-verified with agent-browser: menu render, BEGIN, ping ring + wall reveal visuals, WASD movement (fixed input handling after discovering synthetic events carry empty e.code), monster convergence after buffing hearing to 920px and adding biased wander (it investigated, chased, and killed → "IT FOUND YOU" screen + POST), restart via TRY AGAIN, win path via key pickups + door → "YOU ESCAPED" with stats/best/leaderboard (GET /api/runs returned the recorded escape), mobile 390×844 layout, zero console errors. Removed the temporary debug handle afterwards; final lint + tsc + dev.log all clean.

Stage Summary:
- Deliverable: complete, playable echolocation horror game at `/` — 90% black screen, white expanding wireframe ping rings that briefly reveal the maze, fully synthesized spatial audio, monster with hearing/investigate/chase AI, 3 keys + locked exit door, win/death screens, run persistence via Prisma + /api/runs leaderboard, local best time, touch support.
- Key files: src/lib/game/{maze,audio,engine}.ts, src/components/sonar-room.tsx, src/app/api/runs/route.ts, src/lib/db.ts, prisma/schema.prisma, src/app/page.tsx.
- Balance constants live at the top of engine.ts (PING_*, PLAYER_SPEED, SENSE_R, LOSE_R, HEAR_R, CATCH_R, GRACE) for easy tuning.

---
Task ID: 2
Agent: AI Assistant (main)
Task: Fix "for mobiles, the joystick does not work properly" — diagnose and repair touch controls in The Sonar Room.

Work Log:
- Diagnosed four root causes in src/components/sonar-room.tsx:
  (1) joystick only rendered after touchMode flipped true, which required a blind canvas tap first (also wasting a ping and alerting the monster);
  (2) the pad lacked touch-action: none, so iOS/Android hijacked drags as pan/pull-to-refresh gestures and fired pointercancel — knob froze after a few px (the classic mobile joystick killer);
  (3) pointer capture was taken on e.target instead of e.currentTarget, with no lostpointercapture recovery, so a stolen pointer left the stick stuck on;
  (4) no deadzone — finger jitter crept the player around.
- Rewrote joystick handlers: resetJoy() helper, capture on currentTarget with try/catch, onLostPointerCapture safety net, deadzone (0.18) with remap-to-full-speed curve, knob now tracks raw clamped offset; enlarged touch zone to 176px (h-44 w-44) with the 128px visual ring centered inside; pad gets touch-none select-none.
- Auto-show joystick on touch-capable devices: detection (pointer: coarse / maxTouchPoints / ontouchstart) runs inside startGame (event handler, lint-safe) so the stick is visible from the first frame; touch-aware hint (TAP — PING / STICK — MOVE, positioned above the pad) and touch-aware menu control rows.
- Reset held controls on run end/start (loop guard + startGame) so the player never slides after death.
- Page hardening: wrapper overscroll-none; global button touch-action: manipulation + tap-highlight transparent; added Next.js Viewport export in layout.tsx (maximumScale 1, userScalable false, viewportFit cover) to stop pinch/double-tap zoom fighting the controls.
- Lint fixes along the way: react-hooks/immutability (moved resetJoy above first use), react-hooks/set-state-in-effect (deferred loadEscapes + touch detection out of the effect body; removed the queueMicrotask touch-detection block in favor of startGame), plus repaired an intermediate bad edit that had duplicated onCanvasPointerDown.
- Browser-verified under iPhone 14 emulation (agent-browser set device + in-page maxTouchPoints stub since set device alone didn't apply touch): pad exists immediately after BEGIN with computed touch-action none; touch pointer drag (pointerId-scoped, pointerType touch) moved the player 69→357.8px at full speed with input (1,0); pointerup zeroed input, stopped the player, recentered the knob; lostpointercapture mid-hold released the stuck stick (0,-1 → 0,0); tap-to-ping on canvas incremented pingsUsed; keyboard regression clean (KeyD moved 106px); death by monster re-confirmed ("IT FOUND YOU" overlay); zero console/page errors; dev.log clean.

Stage Summary:
- Mobile joystick fully functional: visible from game start on touch devices, immune to browser gesture theft (touch-action none + capture + lost-capture reset), deadzone + full-speed curve, auto-reset on death/win/blur.
- Desktop/keyboard paths unchanged and re-verified; lint clean; temp debug handle removed.
- Files touched: src/components/sonar-room.tsx, src/app/layout.tsx (Viewport export only).

---
Task ID: 3
Agent: AI Assistant (main)
Task: Fix "Hydration failed because the server rendered HTML didn't match the client" (darkreader darkreader--sync style node found where <canvas> was expected).

Work Log:
- Root cause: the game SSR'd its full interactive tree and rendered an inline <style> element; extensions like Dark Reader patch that <style> and inject their own <style class="darkreader darkreader--sync"> siblings before React hydrates, so React met an unexpected node where it expected <canvas>.
- Fix 1 (src/app/globals.css): moved all game keyframes (sonar-ring, hint-fade, toast-in, flicker) and the button touch-action/tap-highlight rules out of the component's inline <style> into globals.css — the component tree no longer contains any <style> element.
- Fix 2 (src/components/sonar-room.tsx): split the component. New default export SonarRoom is a hydration gate using useSyncExternalStore(emptySubscribe, () => true, () => false): SSR + first client render emit a trivial <div class="fixed inset-0 bg-black" suppressHydrationWarning> shell; the full game (SonarRoomGame, unchanged internals) mounts only after hydration. Extension noise therefore cannot desync the hydrated tree, and the bootstrap effect still runs with the canvas present. Hoisted emptySubscribe above first use for the react-hooks/immutability rule.
- Verified: lint clean; SSR HTML for / now contains only the bare black shell (no canvas/menu/inline style); browser reload shows zero console/page errors, menu renders post-hydration, computed animationName confirms globals.css keyframes load; simulated a darkreader--sync injection + attribute noise → BEGIN → canvas ping reveals maze walls normally; iPhone emulation regression: joystick appears immediately with touch-action none and touch hint.
- Cost/tradeoff: pre-hydration first paint is now a pure black screen (thematically consistent — the room is dark until you arrive); SEO/crawlers see the shell, acceptable for a canvas game.

Stage Summary:
- Hydration mismatch from browser extensions eliminated structurally (minimal SSR shell + hydration gate + zero inline <style> in the tree).
- Files touched: src/components/sonar-room.tsx, src/app/globals.css. Mobile joystick behavior from Task 2 re-verified intact.

---
Task ID: 4
Agent: AI Assistant (main)
Task: Add asymmetric multiplayer — one device plays the survivor, the other the monster, paired by a 4-character room code.

Work Log:
- New mini-service `mini-services/room-service/` (socket.io, port 3003, `bun --hot`): room manager + dumb relay. hunt:create {role} → 4-char code (unambiguous alphabet) · hunt:join {code} → role auto-assigned (opposite of host) · hunt:ready emitted to both · hunt:evt relayed verbatim between the pair · peer-lost on disconnect (room kept briefly for reconnect), stale-room sweep, hunt:leave. No game logic server-side.
- Shared protocol `src/lib/game/net.ts`: HuntEvt = start{seed} | pos{x,y,moving} | ping{x,y} | click{x,y} | keys{n} | end{outcome,timeMs,keysFound,pings} | rematch | peer-lost; Role/CreateAck/JoinAck/ReadyPayload.
- Engine (`src/lib/game/engine.ts`) gained EngineMode = solo | host | hunter. Key insight: `player` is always the LOCAL body (survivor in solo/host, monster in hunter) and `monster` the OTHER entity, so audio panning, camera, collision and the danger/heartbeat system work unchanged for both roles. host: AI disabled, remote monster eased toward 15Hz net positions (lerp dt*14), catch check local (authoritative). hunter: WASD/joystick drives the monster; survivor ghost eased from net positions; ping() becomes an echolocation click (owner-1 jagged wavefront). Pings are SHARED PHYSICAL EVENTS: survivor ping → full white reveal on BOTH screens (and betrays the survivor's position to the hunter — the ghost flashes in the ring's own light); hunter click → jagged dim reveal on BOTH screens. New audio: pingHeard(pan,vol) (prey's ping as heard by the hunter, lowpassed+reverby) and step(vol,pan) pan param so the hunter literally tracks prey footsteps; hunter sends moving flag so the survivor hears monsterStep panned. Monster body render split: hunter sees survivor ghost glyph, survivor sees the jagged monster. Keys/door revealed by clicks too (hunter can camp the door). Solo untouched (AI path, catch, leaderboard).
- Component (`src/components/sonar-room.tsx`): socket created at mount through gateway (`/?XTransformPort=3003`). Menu flow: HUNT · TWO PLAYERS → CREATE (role pick: THE PREY / THE HUNTER) → lobby with big code + COPY CODE + waiting status, or JOIN (code input, inline errors). hunt:ready → host auto-starts after 1.5s with shared seed (both generate the identical maze). HUD: link dot, role-aware labels (KEYS vs PREY) and hint text (ECHOCLICK). End verdicts: host authoritative — handleEnd(mp) relays end and skips leaderboard/best in MP; hunter receives end → role-mapped win/dead screens (PREY SLAIN / THE PREY ESCAPED). Rematch handshake (both must press; host emits new seed; both restart). Peer-lost overlay mid-game ("THE LINK IS SEVERED") + BACK TO THE MENU. Space/R behavior role-aware.
- Debugging note: sockets only connect via the gateway origin (port 81); opening localhost:3000 directly makes `/?XTransformPort=3003` hit Next itself (by design — the sandbox exposes one port).
- E2E verified with two agent-browser sessions over the gateway: create D6V7 as PREY → join → server "room D6V7 linked: host=survivor guest=monster" → both auto-start on mirrored spawns of the same seed (69,69)/(1357,851) → hunter moved → survivor's remote monster followed (1357→1370) → survivor ping appeared on hunter screen (owner 0 @ survivor pos) → hunter click appeared on survivor screen (owner 1 @ monster pos) → host verdict → survivor "IT FOUND YOU" + hunter "PREY SLAIN · THE HUNT LASTED 00:42" → rematch handshake → both restarted on identical new seed 9124101 → closed peer → "THE LINK IS SEVERED" → back to menu. Zero console errors; lint + tsc clean; solo regression verified; TEMP-DEBUG handles removed.

Stage Summary:
- Two-device asymmetric hunt: the survivor plays the existing blind sonar game while a human hunter — blind too — tracks them through panned pings, footsteps and heartbeat dread; both share the same seeded maze and see the same sound events from their own perspective.
- Key files: mini-services/room-service/index.ts (+package.json), src/lib/game/net.ts, src/lib/game/engine.ts (mode branches + net methods), src/lib/game/audio.ts (pingHeard, step pan), src/components/sonar-room.tsx (menu/lobby/HUD/end/rematch). Room service started in background (room-service.log).
