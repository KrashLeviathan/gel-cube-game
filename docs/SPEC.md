# Gelatinous Cube — Design & Module Spec

> **Read this whole file before writing code.** It is the contract between
> parallel workstreams. If your task conflicts with this document, follow this
> document and flag the conflict in your report instead of improvising.

---

## 1. The game in one paragraph

Pac-Man, inverted, in a D&D dungeon. The player is a **gelatinous cube** with a
half-digested skeleton (skull, ribs, a sword and a shield) tumbling inside it.
The cube starts in a central **lair** — the ghost house — and crawls the maze
hunting **adventurers**. The adventurers are the Pac-Men: they scurry around
scooping up **coins** and hauling them back to **stairwells** to bank their
loot. The player wins a level by dissolving every adventurer. The player loses
the level if the party banks enough gold to hit the **loot goal**. Scattered
through the maze are a few **magic items**; if an adventurer grabs one, the cube
**dries out** — shrivelled, slow, vulnerable — and the party turns and hunts
*it*. Touch a hunter while dried and you lose a life. Three lives, then initials
on the leaderboard.

---

## 2. Non-negotiable requirements (from the user)

1. Three.js, top-down, Pac-Man-looking dungeon, **randomly generated** maze.
2. **Screen wrap** — leaving one edge re-enters the opposite edge.
3. Cube starts in the centre, ghost-house style.
4. Adventurers gather coins (the Pac-Man role).
5. Magic items dry out the cube → cube becomes vulnerable, player must flee.
6. A skeleton (or parts) floats inside the cube, with a shield and a sword.
7. A **slime trail** follows the cube.
8. **All persistence is `localStorage`.** No network, no backend.
9. Minimal screens: Home (**Start Game**, **Top Scores**), plus in-game,
   game-over/initials, and leaderboard. Do not invent extra screens.
10. Lose 3 lives → enter initials → leaderboard if the score ranks.
11. **Mobile/tablet first**, desktop as backup. Touch controls are the primary
    input; keyboard is a fallback, never the only path.
12. Nice-to-haves, in priority order: stone-wall dungeon styling, flickering
    torches, dungeon debris; three difficulty levels; per-level difficulty ramp;
    player-chosen slime colour; soundtrack via drop-in mp3s.

---

## 3. Coordinates, units, and the tile grid

- Floor is the **XZ plane at y = 0**; **+Y is up**.
- **Column → +X, row → +Z.** One tile = one world unit (`TILE`).
- Grid is `COLS = 28` by `ROWS = 31`, centred on the origin.
- Conversions live in `src/maze/grid.js` — **always use those helpers**, never
  re-derive the maths.
- Tile values are the `TILE_*` constants in `src/config.js`.
- The maze wraps **horizontally** on designated `tunnelRows`. Entities crossing
  `x < -COLS/2` or `x >= COLS/2` teleport to the other side. Vertical wrap is
  **not** implemented.

### The `maze` object

Produced by `generateMaze()`, consumed by everything else. Shape is documented
at the top of `src/maze/grid.js`. Treat it as immutable after generation.

---

## 4. Rules of play

### Level setup

`levelParams(difficulty, level)` in `config.js` yields `advCount`, `advSpeed`,
`cubeSpeed`, `driedDuration`, `magicItems`, `lootGoalFraction`, `scoreMult`.

- Coins are placed on every `TILE_FLOOR` tile (not lair, tunnel, or exit tiles).
- `lootGoal = floor(coinsTotal * lootGoalFraction)`.
- `magicItems` items are placed on `maze.itemSpots`, spread apart.
- The cube spawns at `maze.spawn`; adventurers at `maze.advSpawns`.

### Adventurer loop (this is the heart of the pacing)

1. **COLLECT** — path to the nearest coin, eating coins it walks over.
2. When the pack hits `PACK_CAPACITY` (8), switch to **BANK**: path to the
   nearest `TILE_EXIT` stairwell, stand on it for `BANK_TIME`, then the carried
   coins are added to `state.coinsBanked` and the pack empties. Back to COLLECT.
3. **FLEE** — if the healthy cube is within `FLEE_RADIUS` path-tiles, run away
   (maximise path distance from the cube) until it is clear again.
4. **SEEK_ITEM** — if a magic item is un-taken and within
   `ITEM_INTEREST_RADIUS`, and the adventurer is threatened (or by personality
   roll), path to the item instead. Taking it triggers the dried state.
5. **HUNT** — while the cube is dried, path *toward* the cube at
   `HUNT_SPEED_MULT` speed. Contact costs the player a life.
6. **DEAD** — dissolved adventurers do **not** respawn. Their carried coins
   spill back onto nearby floor tiles and are re-collectable.

Adventurers may never enter `TILE_LAIR` or `TILE_LAIR_DOOR`.

### Cube

- Grid-locked continuous movement, Pac-Man style: a current direction and a
  queued direction; the queued turn is taken at the next tile centre where it
  is legal (with a small pre-turn tolerance so input feels forgiving).
- Contact with a **non-dried** cube and a living adventurer → the adventurer is
  engulfed and dissolved. Combo chain increments (`DISSOLVE_SCORES`), decaying
  after `COMBO_WINDOW` seconds without a kill.
- Contact while **dried** → life lost. Cube respawns at the lair with
  `RESPAWN_GRACE` seconds of frozen invulnerability; adventurers scatter.

### Level end

- **Cleared** — every adventurer dissolved. Award `LEVEL_CLEAR_BONUS` plus
  `SCORE_PER_UNBANKED_COIN` per coin never banked. Advance the level, regenerate
  the maze.
- **Failed** — `coinsBanked >= lootGoal`. Lose a life; retry the *same* level
  number with a **freshly generated** maze.
- **Run over** — lives reach 0. Show game over → initials entry if the score
  ranks in the top `MAX_LEADERBOARD_ENTRIES`.

All score additions are multiplied by `scoreMult` and rounded.

---

## 5. Module map and public API

Each module below is owned by exactly one workstream. **Do not edit files you
do not own** — if you need a change in someone else's file, note it in your
report instead.

### Contract files (architect-owned — read-only for subagents)

| File | Purpose |
|---|---|
| `src/config.js` | All tunables and enums |
| `src/maze/grid.js` | Coordinate maths, tile queries, wrapping |
| `src/state/store.js` | Observable state + event bus |

### `src/maze/generator.js` — **WS-A**

```js
/** @returns {Maze} see grid.js for the shape */
export function generateMaze(seed?: number): Maze
```

Requirements:
- Left/right **mirror symmetric**, Pac-Man style.
- Corridors exactly **1 tile wide**; wall blocks at least 2 tiles thick where
  possible so walls read as masonry, not lines.
- **No dead ends** in the main maze (every floor tile has ≥2 floor neighbours),
  except that lair-adjacent and item alcoves may have one.
- Plenty of **loops** — it must not be a perfect maze.
- A central **lair**: a rectangular room roughly 7×4 of `TILE_LAIR` with one
  `TILE_LAIR_DOOR` tile on its top edge, sitting near the vertical middle.
- One or two **tunnel rows** at the vertical middle, fully open to both the left
  and right edges, marked `TILE_TUNNEL`, connected to the maze interior.
- **2–4 `TILE_EXIT` stairwells**, one per quadrant, in dead-end-ish alcoves.
- `advSpawns` — 4+ floor tiles spread across the corners, none inside the lair.
- `itemSpots` — 8+ well-separated floor tiles, biased toward maze extremities.
- **Every walkable tile must be reachable from the spawn** (flood fill). If a
  generation attempt fails validation, retry (cap the attempts, then fall back
  to a hand-authored template baked into the module).
- Deterministic for a given seed — use a small seeded PRNG in the module.

### `src/maze/pathfinding.js` — **WS-A**

```js
/** BFS over the grid. Returns the first STEP direction (DIR_*) from start toward
 *  the nearest tile satisfying `isGoal`, or DIR_NONE if unreachable. */
export function stepToward(maze, startCol, startRow, isGoal, opts?): number

/** Full path as an array of {col,row}, start-exclusive. */
export function findPath(maze, startCol, startRow, isGoal, opts?): {col,row}[]

/** Path-distance field from a source, as an Int16Array (COLS*ROWS, -1 = unreachable). */
export function distanceField(maze, col, row, opts?): Int16Array
```

`opts`: `{ who: 'cube'|'adventurer', avoid?: Int16Array, avoidRadius?: number, avoidCost?: number }`.
Wrap-aware. Must be fast enough to run several times per second for up to 8
adventurers on a 28×31 grid — cache distance fields per frame where sensible.

### `src/render/scene.js` — **WS-B**

```js
export function createScene(canvas): SceneCtx
// SceneCtx = { renderer, scene, camera, resize(), render(), shake(amount), update(dt), dispose() }
```

- `PerspectiveCamera` looking down at the maze from above, pitched
  `CAMERA_PITCH_DEG` off vertical, framed so the **entire maze plus
  `CAMERA_MARGIN_TILES` is visible in both portrait and landscape**. Recompute
  on resize. This is essential — screen wrap only reads if the whole board is
  on screen.
- Cap `devicePixelRatio` at 2. Enable shadows only if cheap; prefer baked/faked
  lighting for mobile framerate. Target 60fps on a mid-range phone.
- `shake(amount)` for impact feedback; decays over ~0.3s.

### `src/render/dungeonMesh.js` — **WS-B**

```js
export function buildDungeon(scene, maze): DungeonView
// DungeonView = { group, dispose() }
```

- One **merged/instanced** mesh for walls (do not create 400 separate meshes).
- Stone-block look: subtle per-tile colour variation, visible mortar lines,
  darker sides than tops. Floor is a large plane with a flagstone texture
  generated procedurally into a canvas (no external image files — everything
  must work offline from `localStorage` alone).
- Scatter static debris on a few floor tiles: bones, skulls, broken barrels,
  rubble — cheap instanced low-poly geometry. Never on a coin tile in a way that
  hides a coin.
- Stairwell tiles (`TILE_EXIT`) get a distinct, readable look (glowing descending
  stairs in `PALETTE.exit`).

### `src/render/torches.js` — **WS-B**

```js
export function buildTorches(scene, maze): TorchView  // { group, update(dt, elapsed), dispose() }
```

- Sconces on wall tiles adjacent to corridors, spaced out (aim for 8–14 total).
- **Flicker**: animated emissive + a small pooled set of real `PointLight`s
  (max ~6, assigned to the torches nearest the cube) so the cost stays bounded.
- Additive glow sprite per torch, flickering in brightness/scale.

### `src/render/cube.js` — **WS-C**

```js
export function buildCube(scene, colorId): CubeView
// { group, update(dt, {dried, driedRatio, moveDir, speed, digesting}), setColor(id), dispose() }
```

- Rounded translucent cube, `MeshPhysicalMaterial` with transmission /
  roughness so it reads as jelly. Gentle **wobble** — squash-and-stretch along
  the movement axis plus a sine ripple (vertex displacement via
  `onBeforeCompile` is fine).
- **Inside the cube**: a skull, a partial ribcage, a femur or two, a **sword**
  and a **shield**, slowly tumbling in the goo at different rates. Build from
  primitives (spheres, boxes, capsules, lathes) — no external models.
- Also inside: a few undigested coins that accumulate visually as you eat.
- **Dried state**: shrink ~15%, desaturate, roughen, crack lines, contents sag.
  When `driedRatio` is in the last `DRIED_WARNING_TIME`, blink.

### `src/render/slimeTrail.js` — **WS-C**

```js
export function createSlimeTrail(scene, colorId): TrailView
// { update(dt, x, z, moving), setColor(id), reset(), dispose() }
```

- Pooled translucent decals on the floor just above y=0 that fade and shrink
  over ~2.5s. Must not allocate per frame. Pool size ≤ 64.
- Suppressed while the cube is dried (it has no slime to give).

### `src/render/fx.js` — **WS-C**

```js
export function createFx(scene): Fx
// { dissolveBurst(x,z,color), splash(x,z,color), sparkle(x,z,color), update(dt), reset(), dispose() }
```

Pooled particle bursts. Used for engulfing an adventurer, magic item pickup,
banking loot, and life loss.

### `src/entities/player.js` — **WS-D**

```js
export function createPlayer(maze, opts): Player
// Player = { col, row, x, z, dir, update(dt, input, ctx), setDir(dir), reset(), teleportTo(col,row) }
```

Grid-locked movement with a queued turn, wrap handling via
`wrapWorldX`, and speed supplied by the caller (so rules.js can apply dried /
digesting multipliers). Exposes continuous world position **and** the tile it
currently occupies.

### `src/game/input.js` — **WS-D**

```js
export function createInput(targetEl): Input
// Input = { dir, consumeDir(), update(), destroy(), onPause(fn) }
```

Mobile first:
- **Drag-anywhere floating joystick**: touch down anywhere on the play area sets
  an origin; dragging past a small deadzone sets a 4-way direction; the
  direction persists after release (Pac-Man style continuous movement).
- **Swipe flicks** must also work — a short quick drag registers a direction.
- Keyboard arrows + WASD as the desktop fallback. `Esc`/`P` pause.
- Must not scroll or zoom the page: `touch-action: none`, prevent default on
  the canvas, handle multi-touch sanely.

### `src/entities/adventurer.js` — **WS-E**

```js
export function createAdventurer(maze, archetype, spawn, opts): Adventurer
// { col,row,x,z,dir,state,pack,alive, update(dt, ctx), kill(), reset() }
```

`ctx` gives the adventurer the cube's position, dried flag, coin lookup, item
list, and the pathfinding helpers. Implements the state machine in §4.
Archetypes: `fighter`, `rogue`, `wizard`, `cleric` — differing in speed
multiplier, greed (pack capacity tolerance), courage (flee radius), and item
interest.

### `src/render/adventurerMesh.js` — **WS-E**

```js
export function buildAdventurerMesh(scene, archetype): AdventurerView
// { group, update(dt, {moving, state, dir}), playDissolve(), reset(), dispose() }
```

Chunky readable low-poly figures seen from above: distinct silhouette and colour
per archetype (fighter = sword+shield, rogue = daggers+hood, wizard = staff+hat,
cleric = mace+holy symbol), a bobbing walk cycle, a little loot-sack that swells
as the pack fills, and a **dissolve** animation (sink + shrink + fade).

### `src/entities/pickups.js` — **WS-E**

```js
export function createPickups(scene, maze, itemCount): Pickups
// { coinsRemaining, hasCoinAt(col,row), takeCoinAt(col,row), items,
//   takeItemAt(col,row), spill(col,row,count), update(dt), reset(), dispose() }
```

Instanced coins (one `InstancedMesh`, hide by scaling to zero — never rebuild
the mesh). Magic items are 3–5 distinct chunky props (wand, orb, tome, potion,
horn) that bob and glow.

### `src/game/rules.js` — **WS-F (integration)**

The referee. Owns level setup/teardown, collisions, scoring, lives, the dried
timer, level clear/fail, and all `store` mutations + events. No rendering logic.

### `src/game/loop.js` — **WS-F**

Fixed-timestep accumulator at `FIXED_DT` with `MAX_FRAME_DT` clamping, render
interpolation, pause/resume, and visibility-change handling.

### `src/game/levels.js` — **WS-F**

Glue that builds a level from `levelParams()`: generate maze, build views, spawn
entities, wire `rules`.

### `src/ui/*` — **WS-G**

- `screens.js` — Home / Leaderboard / Game Over routing, driven by
  `store.EVENTS.SCREEN_CHANGED`. DOM overlay above the canvas.
- `hud.js` — score, lives (little cube icons), level, loot-goal progress bar,
  dried countdown, pause button.
- `leaderboard.js` — top scores table + 3-letter initials entry (arcade style,
  tappable letter wheels — **not** a bare text input; it must be pleasant on a
  phone, though a physical keyboard should also work).
- `styles.css` — dark dungeon theme, safe-area insets, no page scroll/zoom,
  works portrait and landscape, minimum 44px touch targets.

### `src/state/storage.js` — **WS-G**

```js
export function loadSettings(): Settings
export function saveSettings(s): void
export function loadScores(): ScoreEntry[]   // sorted desc, capped
export function saveScore(entry): number     // returns rank (1-based) or -1
export function qualifies(score): boolean
```

`ScoreEntry = { initials, score, level, difficulty, date }`. Must tolerate
corrupt/absent localStorage without throwing (private browsing, quota errors).

### `src/game/audio.js` — **WS-H**

```js
export function createAudio(): AudioSys
// { init(), play(name), music(track), setMusicEnabled(b), setSfxEnabled(b) }
```

Loads mp3s from `public/audio/`. **Every file is optional** — a missing file
logs once at debug level and the call becomes a no-op. Web Audio unlock on first
touch. Expected filenames are listed in `docs/AUDIO.md` (WS-H writes it).

---

## 6. Rules for every workstream

1. **Vanilla ES modules + Three.js.** No TypeScript, no React, no extra runtime
   dependencies. `three` is the only dependency.
2. **No external asset files.** Textures are generated procedurally into a
   `<canvas>`; geometry is built from Three.js primitives. The only exception is
   the optional mp3s the user will drop into `public/audio/`.
3. **Mobile performance is a hard requirement.** No per-frame allocation in
   update paths, no per-entity materials, use `InstancedMesh` for repeated
   geometry, and dispose geometries/materials in every `dispose()`.
4. **Never edit a file you do not own.** Contract files are read-only.
5. `npm run build` must pass when you finish. Run it.
6. Keep comments sparse and useful — explain *why*, not *what*.
7. Write your module so it works standalone: no reaching into globals, no
   implicit ordering assumptions beyond the documented API.
8. When you finish, report: files written, anything you had to deviate on, and
   anything another workstream must know.
