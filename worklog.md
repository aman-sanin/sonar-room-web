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
