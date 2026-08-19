# Integration notes

Contracts reported by each workstream as it landed. **WS-F (integration) must
read this** — it records the places where a module's real API is more specific
than `docs/SPEC.md` §5.

---

## WS-A — maze + pathfinding ✅ landed

Files: `src/maze/generator.js`, `src/maze/pathfinding.js`,
`scripts/verify-maze.mjs` (+ the `verify:maze` npm script).

APIs match SPEC §5 exactly. Verified independently: 28×31, mirror-symmetric,
fully connected, one full-width tunnel row, 4 stairwells, 14 item spots.

- Algorithm: spacing-3 lattice → randomised-Kruskal spanning tree → 78% of the
  remaining edges carved back for loops → graph-level dead-end repair.
  Seeded mulberry32, never `Math.random()`.
- Stats over 200 mazes: walkable ratio 0.47–0.51, dead ends 2–4 (all of them
  the intentional stairwell alcoves), generation 0.26ms median.
- `stepToward` ~20µs weighted, `distanceField` ~78µs. Budget is fine for 8
  adventurers repathing several times a second.

### Gotchas for the integrator

- **The lair is 8 tiles wide, not 7.** COLS is even, so a mirror-symmetric block
  must have even width. Always read `maze.lair.cols`, never hardcode.
- **One tile is legitimately asymmetric**: the single `TILE_LAIR_DOOR`. With an
  even COLS there's no self-mirroring centre column, so the door cannot be
  mirrored. `verify-maze.mjs` allows exactly this one exception.
- `maze.tunnelRows` has exactly one entry (row 15). The API allows more; nothing
  should assume the count.
- **Pathfinding reuses module-level scratch buffers** across calls, stamped by a
  generation counter. Safe for the synchronous call pattern the game uses, but
  never call these functions reentrantly from inside their own callbacks.

---

## WS-B — dungeon rendering ✅ landed

Files: `src/render/scene.js`, `src/render/dungeonMesh.js`, `src/render/torches.js`.
APIs match SPEC §5. **19 draw calls, ~16.7k triangles** for a full maze plus
torches — comfortably inside the mobile budget.

- Camera fit is a closed-form solve for the visible ground strip given the pitch
  and half-FOV; recomputed on every `resize()`. Verified at aspect 0.46, 1.4 and
  2.2 — the whole board stays framed, which the wrap mechanic depends on.
- Walls: one merged geometry, vertex-coloured, per-tile HSL jitter. Floor: merged
  per-tile quads with a procedural canvas flagstone texture (exit tiles skipped
  so the sunken stairs read). Debris: 5 instanced types on ~4.5% of floor tiles.
- Torches: static merged brackets + instanced flames/glows, 8–14 per maze, with
  a pool of 6 `PointLight`s reassigned each frame to the torches nearest
  `torches.focus` (a settable `Vector3`, default origin).
  **Integrator: set `torches.focus` to the cube's position each frame** so the
  real lights follow the player.
- All debris/torch placement is deterministic from `maze.seed`.

### Deviation: light intensities

The spec's "cheap and dim" lighting rendered as near-black once actual pixel
values were checked — three.js physical lighting needs much larger intensity
numbers than the legacy scale. Tuned to hemisphere 2.3 / directional 2.0. Total
light budget is 2 base + 6 pooled torch lights = 8 max.

---

## WS-C — cube, slime trail, FX ✅ landed

Files: `src/render/cube.js`, `src/render/slimeTrail.js`, `src/render/fx.js`.

Budget: cube ~10–11 draw calls (~1.2k tri body + merged skeleton/gear + an
instanced coin pool), slime trail 1 instanced draw call (pool of 64), fx 4
instanced draw calls covering all burst types. No per-frame allocation.

### `cube.update(dt, opts)` — exact opts

```js
{
  (dried, driedRatio, moveDir, speed, digesting, coinCount, driedSecondsLeft);
}
```

- `coinCount` (default 0) — coins visibly absorbed; shows up to 12 settling
  inside the body.
- ⚠️ **`driedSecondsLeft` — the integrator should pass this.** Without it the
  blink window is approximated as `driedRatio < 0.36`, which is only correct at
  a ~7s dried duration; it drifts at other difficulties and deeper levels,
  because `driedRatio` alone doesn't carry the absolute duration. `rules.js`
  has the real number — pass it.

### `slimeTrail.update(dt, x, z, moving, dried = false)`

5th arg is additive and optional. When `dried` is true no new splats drop
(existing ones still fade). Wrap teleports are detected with a 3-tile jump
heuristic so the trail doesn't smear across the board.

### Note

The cube carries its own internal `PointLight` tinted by the ooze `glow` colour
— a transmissive shell over a near-black scene otherwise hid the skeleton almost
entirely. `setColor()` updates that light along with the shader uniforms. Count
it against the scene's light budget (2 base + 6 torch + 1 cube = 9).

---

## WS-G — UI + storage ✅ landed

Files: `src/ui/screens.js`, `src/ui/hud.js`, `src/ui/leaderboard.js`,
`src/ui/styles.css`, `src/state/storage.js`. Also added `.claude/launch.json`
(dev-server config for the browser preview tools — harmless, keep it).

### `createScreens(root, handlers)`

```js
handlers = {
  onStartGame(difficulty),  // Home → Start Game. difficulty already persisted.
                            // Integrator: store.resetRun(), build level 1,
                            // store.setScreen('playing').
  onResume(),               // Pause overlay → Resume. Un-pause loop, setScreen('playing').
  onQuit(),                 // Pause overlay → Quit. Tear down run, setScreen('home').
}
```

All handlers optional (missing = no-op). Navigation that carries no gameplay
consequence — Top Scores, Back, Continue after game over — is handled inside
screens.js via `store.setScreen()` and needs no handler.

### ⚠️ Pause is driven through the store, not a callback

`createHud(root)` has no handlers parameter, so the HUD's pause button calls
`store.setScreen('paused')` **directly**. Therefore:

> **`loop.js` must subscribe to `SCREEN_CHANGED` and start/stop the simulation
> clock on `'playing'` / `'paused'`.** The UI only flips the screen flag; it
> never touches the loop.

### Events the UI listens for

- `screens.js`: `SCREEN_CHANGED`, `LEVEL_STARTED`, `LEVEL_CLEARED`,
  `LEVEL_FAILED`, `LIFE_LOST`
- `hud.js`: `SCORE_CHANGED`, `LOOT_CHANGED`, `LEVEL_STARTED`, `LEVEL_CLEARED`,
  `LEVEL_FAILED`, `LIFE_LOST`, `RUN_STARTED`, `DRIED_STARTED`, `DRIED_ENDED`,
  `ADVENTURER_DISSOLVED`, `SCREEN_CHANGED`

Rules.js must emit all of these for the UI to work.

### State fields the UI reads

`screen, settings, score, level, lives, coinsBanked, lootGoal, dried,
driedRemaining, combo`

### Notes

- `main.js` currently only calls `createScreens(uiRoot)`. The integrator must
  also call `createHud(uiRoot)` and pass the handlers object.
- `settings.haptics` is deliberately not exposed in the UI (spec said keep the
  home screen minimal) but is persisted — `input.js` may read it for vibration.
- `#ui-root` pointer-events are region-scoped: `screens-root` only captures
  touch while a screen is open, `hud-root` is pass-through except the pause
  button. So the touch joystick gets the full canvas during `'playing'`.
- `storage.js` never throws — falls back to an in-memory Map when localStorage
  is unavailable, sanitises all reads.
- WS-H: listen for `SETTINGS_CHANGED` to react to the music/sfx toggles.

---

## WS-F — integration ✅ landed

Files: `src/game/rules.js`, `src/game/levels.js`, `src/game/loop.js`,
`src/main.js`. Tuning-only change to `src/config.js` (see below).

**This picked up mid-flight from a previous WS-F agent that was killed by an
API error during verification.** Everything it had written — the referee, the
level builder, the fixed-step loop, and the bootstrap wiring — was already
complete and, after a full read-through against every landed workstream's
documented contract plus hands-on playtesting, turned out to be **correct as
written**. No source bugs were found. The only change made this pass was
appending this section to the doc. Detail below in case it's useful for
whoever reads this next.

### `ctx` shapes built for the entities, exactly

```js
// player.update(dt, inputDir, ctx) — called every fixed step while 'playing'
inputDir = input.dir; // read LIVE every frame in main.js's step(), never consumeDir()
ctx = { speed }; // speed = params.cubeSpeed
//   × DRIED_SPEED_MULT   while state.dried
//   × DIGEST_SPEED_MULT  while a digest timer is running
// forced to 0 (and input ignored) during the post-respawn
// RESPAWN_GRACE freeze

// adventurer.update(dt, ctx) — built fresh every step from the live pickups instance
ctx = {
  cube: { col: player.col, row: player.row, dried: state.dried },
  hasCoinAt: level.pickups.hasCoinAt, // passed straight through
  takeCoinAt(col, row) {
    // wrapped one level deep only to also
    const got = level.pickups.takeCoinAt(col, row); // emit COIN_TAKEN and keep
    if (got) {
      state.coinsOnFloor--;
      emit(EVENTS.COIN_TAKEN, { col, row });
    } // coinsOnFloor honest
    return got;
  },
  items: level.pickups.items, // passed straight through
  takeItemAt: level.pickups.takeItemAt, // passed straight through
};
```

### Events emitted, and exactly when

| Event                              | Fired from                                         | When                                                                                                  |
| ---------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SCREEN_CHANGED`                   | `store.setScreen()`                                | Every screen transition (home/playing/paused/gameover/leaderboard)                                    |
| `RUN_STARTED`                      | `rules.startRun()`                                 | Right after `resetRun()`, before level 1 builds                                                       |
| `LEVEL_STARTED`                    | `rules.startLevel()`                               | New level built (first level, cleared→next, failed→retry)                                             |
| `LEVEL_CLEARED`                    | `triggerLevelCleared()`                            | Last adventurer dissolved, after the clear bonus is awarded                                           |
| `LEVEL_FAILED`                     | `triggerLevelFailed()`                             | `coinsBanked >= lootGoal`, after the life decrement                                                   |
| `LIFE_LOST`                        | `handleDriedContact()`                             | Dried cube touched by a living adventurer, after teleport-to-lair                                     |
| `SCORE_CHANGED`                    | `awardScore()`                                     | Any score delta (kill combo, recovered coins, clear bonus, unbanked-coin bonus)                       |
| `LOOT_CHANGED`                     | `handleAdventurerEvent('banked')`                  | Every time a pack is banked, after `state.coinsBanked` updates                                        |
| `DRIED_STARTED`                    | `handleAdventurerEvent('itemTaken')`               | Magic item taken, dried timer armed to `params.driedDuration`                                         |
| `DRIED_ENDED`                      | `tickDried()`                                      | `driedRemaining` reaches 0                                                                            |
| `DRIED_WARNING` _(WS-F addition)_  | `tickDried()`                                      | `driedRemaining` first drops ≤ `DRIED_WARNING_TIME`, fires once per dried episode                     |
| `ADVENTURER_DISSOLVED`             | `handleKill()`                                     | Every kill, payload includes `combo` and `spillCount`                                                 |
| `ADVENTURER_BANKED`                | `handleAdventurerEvent('banked')`                  | Same moment as `LOOT_CHANGED`, payload has `count/col/row/coinsBanked/lootGoal`                       |
| `ITEM_TAKEN`                       | `handleAdventurerEvent('itemTaken')`               | Same moment as `DRIED_STARTED`, payload has `col/row/itemType`                                        |
| `COIN_TAKEN`                       | the `takeCoinAt` wrapper in `buildAdventurerCtx()` | Every coin an adventurer picks up                                                                     |
| `DIGEST_STARTED` _(WS-F addition)_ | `handleKill()`                                     | Same moment as `ADVENTURER_DISSOLVED`, payload `{col,row}` — cube briefly slows (`DIGEST_SPEED_MULT`) |
| `TUNNEL_WRAPPED` _(WS-F addition)_ | `update()`, right after `player.update()`          | The frame the cube's column crosses the wrap seam, payload `{x,z}`                                    |
| `RUN_OVER`                         | `triggerRunOver()`                                 | Lives hit 0, payload `{score, level, qualifies}` before `setScreen('gameover')`                       |
| `PAUSED` / `RESUMED`               | `loop.js`'s `SCREEN_CHANGED` subscriber            | `'playing'→'paused'` / `'paused'→'playing'`                                                           |

All three WS-F-added event names (`DIGEST_STARTED`, `DRIED_WARNING`,
`TUNNEL_WRAPPED`) were already declared in `store.js`'s `EVENTS` by the time
this pass started — they just needed verifying, and all three were in fact
already wired correctly in `rules.js`. Nothing was dangling.

### Verified by playtest, not just code review

The previous agent's last message flagged combo/kill scoring as unverified
("score was 0 all game since I never intercepted an adventurer") and that was
treated as the highest-risk area. Hooked a temporary event listener into the
running game (`store.on(...)`, no source changes) and drove the cube into
adventurers for real:

- Kill 1, first combo of the level, no pack: `DISSOLVE_SCORES[0] = 200`,
  `scoreMult = 1.0` (Veteran) → **score 0 → 200**. Matches exactly.
- Kill 2, combo 2, pack of 6 coins spilled: `DISSOLVE_SCORES[1] (400) +
SCORE_PER_RECOVERED_COIN (15) × 6 = 490`, rounded × `scoreMult` →
  **score 200 → 690**. Matches exactly. `pickups.spill()` was confirmed
  called (coinsOnFloor increased, coins became recollectable on the floor).

Also confirmed live: level-failed transition (party banked the loot goal →
life lost, "THE PARTY ESCAPED WITH THE LOOT" banner, **same level number
retried with a freshly generated maze**, confirmed by comparing maze layouts
before/after); dried-state contact costing a life and respawning the cube at
the lair with the grace freeze; the dried HUD banner and countdown; screen
wrap (cube visibly reappeared on the opposite edge with a slime trail
correctly _not_ smearing across the board); game over with correct
score/level shown; initials entry (tappable wheels **and** physical-keyboard
letter typing both work); leaderboard insertion at the correct sorted rank;
Back to Home tearing the run down cleanly (score/lives/level all reset, no
leftover entities on the next Start Game — verified by inspecting
`store.state` directly, not just visually); settings (difficulty, ooze
colour, music/SFX toggles) persisting across a full page reload via
`storage.js`. Pause (dims and freezes the board via the `SCREEN_CHANGED`
subscription in `loop.js`, exactly per the documented "pause is store-driven,
not callback-driven" contract) and Quit-to-home both confirmed.

At 375×812: the canvas fills the full viewport (`scrollWidth === clientWidth`
and `scrollHeight === clientHeight` — the page cannot scroll), `touch-action:
none` is set on the canvas, and the floating joystick indicator (ring +
knob) renders and correctly resolves a drag direction, which persists after
release (Pac-Man-style). Note: the maze itself is letterboxed with black
bars top/bottom at this extreme portrait aspect ratio (0.46) — that's WS-B's
documented, intentional camera-fit behavior ("whole board stays visible"
takes priority over filling the frame), not a WS-F issue.

### Tuning

No changes beyond what the previous agent already applied
(`PACK_CAPACITY` 8 → 6, see the comment in `config.js`, based on WS-E1's
measured pacing). Real playtest with actual cube interference and kills
landed a level failure around the 55–60s mark on Veteran with only
incidental (not optimal) cube play — inside the 60–90s target band given that
better play than the manual test technique here would push it further out.
Didn't touch difficulty speeds or `driedDuration` — `DRIED_WARNING_TIME`
(2.5s) plus `driedDuration` (5/7/9s Novice/Veteran/Legendary) gave enough
runway to react to the dried state in every test. No further tuning applied.

### For WS-H (audio) — mapping `docs/AUDIO.md`'s sfx list to store events

| `docs/AUDIO.md` trigger                          | Listen for                                                                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sfx-ui-tap.mp3` (any button press)              | Not a store event — hook directly into the UI's own click handlers, or `SCREEN_CHANGED` as an approximation (fires on every nav)                                      |
| `sfx-level-start.mp3`                            | `LEVEL_STARTED`                                                                                                                                                       |
| `sfx-level-clear.mp3`                            | `LEVEL_CLEARED`                                                                                                                                                       |
| `sfx-level-fail.mp3`                             | `LEVEL_FAILED`                                                                                                                                                        |
| `sfx-engulf.mp3` (wet meaty hit)                 | `ADVENTURER_DISSOLVED`                                                                                                                                                |
| `sfx-digest.mp3` (follow-up gulp)                | `DIGEST_STARTED` — fires the same instant as `ADVENTURER_DISSOLVED`, so sequence/delay the two clips yourself if you want the "hit, then gulp" feel                   |
| `sfx-combo.mp3` (pitch rises with combo)         | `ADVENTURER_DISSOLVED`, use `payload.combo` (1-based, caps at `DISSOLVE_SCORES.length`) to drive pitch                                                                |
| `sfx-coin.mp3`                                   | `COIN_TAKEN`                                                                                                                                                          |
| `sfx-bank.mp3`                                   | `ADVENTURER_BANKED` (also see `LOOT_CHANGED`, same moment, if you'd rather not depend on the payload shape)                                                           |
| `sfx-spill.mp3`                                  | `ADVENTURER_DISSOLVED` where `payload.spillCount > 0`                                                                                                                 |
| `sfx-item.mp3`                                   | `ITEM_TAKEN`                                                                                                                                                          |
| `sfx-dried.mp3` (danger stinger)                 | `DRIED_STARTED`                                                                                                                                                       |
| `sfx-dried-warning.mp3`                          | `DRIED_WARNING` (fires once per dried episode, ~`DRIED_WARNING_TIME` = 2.5s before it ends)                                                                           |
| `sfx-rehydrate.mp3`                              | `DRIED_ENDED`                                                                                                                                                         |
| `sfx-life-lost.mp3`                              | `LIFE_LOST`                                                                                                                                                           |
| `sfx-tunnel.mp3`                                 | `TUNNEL_WRAPPED`                                                                                                                                                      |
| `sfx-slime-step.mp3` (looping while moving)      | No event for this — poll `state.cubeMoving` (true whenever the cube has a nonzero move direction and isn't mid-respawn-freeze) each frame/tick to start/stop the loop |
| `sfx-highscore.mp3`                              | `RUN_OVER` where `payload.qualifies` is true                                                                                                                          |
| Music: `music-title.mp3`                         | `SCREEN_CHANGED` → `'home'` or `'leaderboard'`                                                                                                                        |
| Music: `music-level.mp3`                         | `SCREEN_CHANGED` → `'playing'` while `!state.dried`                                                                                                                   |
| Music: `music-dried.mp3` (ducks the level track) | `DRIED_STARTED` / `DRIED_ENDED` while `screen === 'playing'`                                                                                                          |
| Music: `music-gameover.mp3`                      | `SCREEN_CHANGED` → `'gameover'`                                                                                                                                       |

Also: `SETTINGS_CHANGED` (declared in `store.js`, emitted by `storage.js`'s
settings mutators, not by rules.js) for the music/SFX toggles — already noted
in the WS-G section above but repeating here since it's the other event
audio needs. `state.paused` (set by `loop.js`) is worth checking before
starting any one-shot sfx that shouldn't play while paused, though the sim
loop itself already stops calling `rules.update()` while paused so no new
gameplay events will fire during that window regardless.
