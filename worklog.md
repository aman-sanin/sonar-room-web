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
