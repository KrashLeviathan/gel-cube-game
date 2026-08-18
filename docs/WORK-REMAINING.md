# Work remaining — handoff brief

**Status: 5 of 8 workstreams complete. The repo builds clean and nothing is
half-finished.** Three workstreams were cancelled before they wrote any code;
their files are still the original stubs. Two more were never started.

Read in this order before doing anything: `docs/SPEC.md` (the contract),
`docs/INTEGRATION.md` (what the landed workstreams actually built and the
gotchas they found), then this file.

## Ground rules that made the parallel work safe — keep them

1. **Contract files are read-only**: `src/config.js`, `src/maze/grid.js`,
   `src/state/store.js`, `docs/SPEC.md`. Need a change? Say so; the integrator
   applies it. Tuning-value changes go through the integrator too.
2. **Never edit a file another workstream owns.** The file partition below is
   what lets several agents run at once without conflicts.
3. Vanilla ES modules + Three.js. No new dependencies. No external asset files —
   textures are procedural canvas, geometry is Three.js primitives. The only
   exception is the optional mp3s in `public/audio/`.
4. No per-frame allocation in `update()` paths; dispose everything you create.
   Target 60fps on a mid-range phone.
5. `npm run build` must pass when you finish. `npm run verify` lists which
   modules are still stubs and then builds.
6. Scratch/test harnesses go **outside the repo**, in a temp dir. Leave no stray
   files behind.

## Done ✅

| WS | Scope | Files |
|---|---|---|
| A | Maze generation + pathfinding | `src/maze/generator.js`, `src/maze/pathfinding.js`, `scripts/verify-maze.mjs` |
| B | Dungeon rendering, torches | `src/render/scene.js`, `dungeonMesh.js`, `torches.js` |
| C | Cube, slime trail, FX | `src/render/cube.js`, `slimeTrail.js`, `fx.js` |
| G | UI, HUD, leaderboard, storage | `src/ui/*`, `src/state/storage.js` |

## Remaining

| WS | Scope | Files it owns | Depends on | Can run parallel with |
|---|---|---|---|---|
| **D** | Player movement + touch input | `src/entities/player.js`, `src/game/input.js` | — | E1, E2 |
| **E1** | Adventurer AI | `src/entities/adventurer.js` | — | D, E2 |
| **E2** | Adventurer meshes + pickups | `src/render/adventurerMesh.js`, `src/entities/pickups.js` | — | D, E1 |
| **F** | Integration: referee, levels, loop | `src/game/rules.js`, `levels.js`, `loop.js`, `main.js` | D, E1, E2 | — |
| **H** | Audio + polish | `src/game/audio.js` | F | — |

D, E1 and E2 are mutually independent — run all three concurrently, then F alone,
then H. **F must be a single agent**; it is the only one that sees the whole
system, and splitting it would just create the integration problem it exists to
solve.

---

# WS-D — Player movement + touch input

Owns `src/entities/player.js` and `src/game/input.js`. Nothing else.

This is how the game *feels* in the hand. On a phone it is the whole experience —
mushy controls kill the game regardless of how good it looks.

### `createPlayer(maze, opts) -> Player`

`{ col, row, x, z, dir, update(dt, input, ctx), setDir(dir), reset(), teleportTo(col,row) }`

Pac-Man-grade grid movement, which is subtler than it looks:
- Speed comes from the **caller** via `ctx`, so `rules.js` can apply the dried
  and digesting multipliers. Document the exact `ctx` shape you accept.
- Current direction + queued direction. The queued turn fires at the next tile
  centre where it is legal.
- **Pre-turn buffering** — a turn requested slightly before the junction is
  remembered and applied on arrival. Without this, touch feels broken.
- **Instant reversal** — requesting the opposite direction applies immediately,
  mid-tile, no waiting for a junction.
- **Corner tolerance** with deliberate snapping of the off-axis coordinate to
  the corridor centreline. Accumulated float drift is the classic bug here.
- Walls: stop cleanly *at* the tile centre, keep facing, resume on the next legal
  request.
- **Wrap tunnels** via `wrapWorldX`. `col`/`row` always reflect the wrapped tile;
  `x`/`z` stay continuous. **Expose a way for the caller to know a wrap happened
  this frame** — the slime trail and the audio both need it.
- No allocation in `update`.

### `createInput(targetEl) -> Input`

`{ dir, consumeDir(), update(), destroy(), onPause(fn) }`

**Mobile is primary, keyboard is the fallback.**
- **Drag-anywhere floating joystick**: touch down anywhere sets an origin; drag
  past an ~18–24px deadzone resolves a 4-way direction; **the direction persists
  after release** (this is Pac-Man — the cube keeps crawling). Re-drag while held
  re-resolves live.
- **Flicks must work too** — track velocity, not just displacement, so a fast
  short flick isn't swallowed by the deadzone.
- Hysteresis biased toward the current axis so a sloppy diagonal doesn't chatter.
- A **visible joystick indicator** while touching (ring at origin, knob at
  offset). Create the element from inside `input.js` and clean it up in
  `destroy()` — do not edit files you don't own.
- **Pointer Events** throughout, so mouse/touch/stylus share one path. Handle
  `pointercancel`, ignore a second finger, handle the pointer leaving.
- Kill all default gestures: scroll, pull-to-refresh, pinch zoom, double-tap
  zoom, iOS rubber-banding, long-press menu.
- Keyboard: arrows + WASD, `Esc`/`P` pause. **Don't swallow keys when focus is
  in a form field** — the initials entry screen uses letter keys.
- Document whether the integrator reads `input.dir` or `consumeDir()`.
- Optional `navigator.vibrate` on direction change when
  `store.state.settings.haptics` is true.

### Testing
Build a 2D top-down canvas harness outside the repo importing the real
`generateMaze` — far better for verifying movement than the 3D view. Confirm:
no wall penetration at any speed, no centreline drift after hundreds of turns,
pre-turn buffering and instant reversal both work, wrapping works both
directions with `col`/`row` correct, and at a 375×812 viewport touch-drag drives
the cube while the page never scrolls or zooms.

### Report
The exact `ctx` shape and `input` value `player.update` expects; how the caller
learns a wrap occurred; whether to read `input.dir` or `consumeDir()`.

---

# WS-E1 — Adventurer AI

Owns `src/entities/adventurer.js`. Nothing else. WS-E2 owns `pickups.js` and
`adventurerMesh.js` — code against their SPEC §5 APIs.

The opposition. **They are the Pac-Men**, and their behaviour *is* the difficulty
curve, so this is the most gameplay-critical module in the project.
`docs/SPEC.md` §4 is the brief.

### `createAdventurer(maze, archetype, spawn, opts) -> Adventurer`

`{ col, row, x, z, dir, state, pack, alive, update(dt, ctx), kill(), reset() }`

Same grid-locked, wrap-aware, centreline-snapped movement discipline as the
player. **Always pass `'adventurer'` to `isWalkable`** — they may never enter the
lair or its door.

State machine: **COLLECT** (nearest coin) → **BANK** at `PACK_CAPACITY` (path to
nearest `TILE_EXIT`, stand `BANK_TIME`, hand over the pack) → back to COLLECT.
**FLEE** when a healthy cube is within `FLEE_RADIUS` path-tiles (use
`stepToward`'s `avoid` option with a cube distance field; a loot-laden fleer
should prefer fleeing *toward* a stairwell when compatible — banking under
pressure is a great moment). **SEEK_ITEM** when threatened near an un-taken magic
item — *this is the party's counterplay and it must actually happen*, or the game
has no danger. **HUNT** the cube while `ctx.dried`. **DEAD** on `kill()`.

Archetypes `fighter`/`rogue`/`wizard`/`cleric` differing in speed, greed, courage
and item interest — meaningful but not extreme, roughly ±15% per axis. Document
the table.

**Feel requirements:**
- **No jitter.** Oscillating between equidistant goals, or flip-flopping at the
  flee radius boundary, is the classic failure. Add transition hysteresis, a goal
  dwell time, and prefer going straight on ties.
- **Don't repath every frame.** 4–8Hz, staggered per adventurer so they don't all
  recompute on the same frame.
- **They should look like they're thinking, not solving.** Perfect pathing feels
  robotic and is unfairly hard — occasionally take the second-nearest coin,
  hesitate at junctions when threatened, take a wrong turn while panicking.
- Verify they use the wrap tunnels. Popping out the far side is a signature
  moment.

### Measure the pacing — this is important
With 4 adventurers at Veteran speed on a full maze and no cube interference, time
how long until they bank 60% of the gold. **The design target is a level lasting
roughly 60–90 seconds.** Report the real number. If it's wildly off, recommend a
`PACK_CAPACITY` / `LOOT_GOAL_FRACTION` change — **don't edit `config.js`
yourself**, the integrator applies tuning.

*Context: the loot-hauling mechanic exists because straight Pac-Man scoring
collapses when inverted — four adventurers eating coins where they stand clear a
200-coin maze in ~20 seconds. Forcing them to haul packs to stairwells triples
their travel and creates interception points. If the measured pacing is far off,
that's the lever to tune.*

### Report
The full `ctx` contract and full `Adventurer` surface verbatim (the integrator
builds `ctx`); the archetype table; the measured pacing number; recommended
tuning.

---

# WS-E2 — Adventurer meshes + pickups

Owns `src/render/adventurerMesh.js` and `src/entities/pickups.js`. Nothing else.

Everything is viewed from ~12° off vertical with the **whole 28×31 maze on
screen**, so entities are small. **Silhouette and colour do all the work; fine
detail is wasted.** Design for readability at that scale first.

### `buildAdventurerMesh(scene, archetype) -> AdventurerView`

`{ group, update(dt, opts), playDissolve(), reset(), dispose() }` — `opts`
includes at least `{ moving, state, dir, packFullness }`; document the exact
shape.

Four archetypes, instantly distinguishable **from above**: `fighter` (broad,
sword + round shield, steel/red), `rogue` (slim, hooded, twin daggers,
dark green), `wizard` (pointed hat — reads beautifully from overhead, glowing
staff, blue/purple), `cleric` (helm, mace, holy symbol, white/gold). Primitives
only, a few hundred triangles each, shared materials per archetype.

- Bobbing walk cycle when `moving`, faster when fleeing or hunting.
- **A loot sack that visibly swells** as `packFullness` goes 0→1. The player must
  see at a glance who's carrying a full pack — that's the juicy target. Make it
  unmistakable.
- **State tells**: panicked when fleeing, aggressive lean when hunting a dried
  cube.
- `playDissolve()` — sink, shrink, tilt, dissolve over ~0.6s; flesh first, bones
  lingering. `reset()` restores for pooled reuse across levels.

### `createPickups(scene, maze, itemCount) -> Pickups`

`{ coinsRemaining, hasCoinAt, takeCoinAt, items, takeItemAt, spill, update, reset, dispose }`

- **Coins**: one per `TILE_FLOOR` tile (not lair/tunnel/exit). **A single
  `InstancedMesh`** — hide taken coins by scaling the instance to zero, never
  rebuild. `Uint8Array` occupancy grid for O(1) `hasCoinAt`. `takeCoinAt` returns
  whether a coin was actually there.
- **`spill(col,row,count)`** — when the cube dissolves a loot-laden adventurer,
  its carried coins scatter back onto nearby walkable tiles (BFS outward) and
  become collectable again, with a scatter/settle animation. Signature moment —
  make it feel like a payout.
- **Magic items**: `itemCount` placed on `maze.itemSpots`, greedily spread for
  maximum separation. 3–5 distinct chunky props (wand, orb, tome, potion, horn)
  that bob, spin and pulse an emissive glow with a floor decal. **These must be
  the most eye-catching things on the board** — the player needs to see an
  adventurer closing on one. Document the exact `items` element shape (at least
  `{col,row,type,taken}`); WS-E1 and the integrator both read it.
- `reset()` restores a full board without rebuilding meshes.

### Report
Exact `opts` shape for `adventurerMesh.update` and exact `items` element shape,
verbatim. Triangle and draw-call budget.

---

# WS-F — Integration (single agent, after D/E1/E2)

Owns `src/game/rules.js`, `src/game/levels.js`, `src/game/loop.js`,
`src/main.js`. May apply tuning changes to `src/config.js` — the only workstream
permitted to.

**Read `docs/INTEGRATION.md` first.** Every landed workstream recorded its exact
API and its gotchas there, several of which are more specific than SPEC §5.

- `rules.js` is the referee: level setup/teardown, collision resolution, scoring
  and combo chain, lives, the dried timer, level clear/fail, and **all `store`
  mutations and event emissions**. No rendering logic. The UI is already built
  and listening — it needs every event in the list in `docs/INTEGRATION.md` to be
  emitted, or parts of the HUD stay dead.
- `levels.js` builds a level from `levelParams()`: generate maze, build views,
  spawn entities, wire rules.
- `loop.js`: fixed timestep at `FIXED_DT` with `MAX_FRAME_DT` clamping, render
  interpolation, visibility-change handling. **It must subscribe to
  `SCREEN_CHANGED` and start/stop the sim clock on `'playing'`/`'paused'`** — the
  HUD's pause button flips the screen flag directly and never touches the loop.
- `main.js`: currently only calls `createScreens(uiRoot)`. Must also call
  `createHud(uiRoot)` and pass the handlers object documented in
  `docs/INTEGRATION.md`.
- Per-frame wiring the landed modules need: set `torches.focus` to the cube's
  position; pass `driedSecondsLeft` to `cube.update` (not just `driedRatio` —
  the blink timing is wrong at non-default difficulties otherwise); pass the
  wrap-happened flag to the slime trail.
- Then **playtest and tune**. Whether this is fun is decided here. Expect to
  adjust speeds, `PACK_CAPACITY`, `LOOT_GOAL_FRACTION` and `driedDuration`.
  Verify at 375×812 and on desktop, and confirm a full run works end to end:
  home → play → lose 3 lives → initials → leaderboard → home.

# WS-H — Audio + polish (after F)

Owns `src/game/audio.js`. The filename contract is already written and given to
the user in `docs/AUDIO.md` — **implement against it exactly; don't rename
anything**. Every file is optional: a missing mp3 logs once at debug level and
becomes a no-op, so the game must run perfectly with an empty `public/audio/`.
Web Audio unlock on first touch. Listen for `SETTINGS_CHANGED` to react to the
music/sfx toggles. Music tracks crossfade; the dried-state track ducks the level
track.
