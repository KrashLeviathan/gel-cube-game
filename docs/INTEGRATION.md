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

### How to Play is an overlay, not a screen

The Home screen's "How to Play" button opens `.howto`, a sibling overlay inside
`screens-root` at `z-index: 6` — deliberately **not** a sixth value of
`state.screen`, which stays the documented five. Consequences worth knowing:

- Nothing in the store observes it. `store.on(SCREEN_CHANGED)` never fires for
  it, so `audio.js` keeps the title track playing straight through, which is
  what you want.
- `render()` force-closes it on every screen change, so it can never outlive
  Home (e.g. if a tap lands on Start Game while it's open).
- It binds one `window` keydown for Esc, removed in `dispose()`. That's safe
  alongside `input.js`'s own Esc handler because `main.js` only pauses on Esc
  while `screen === 'playing'`.
- The content quotes real tuning values (pack size, combo scores, level-clear
  bonus, difficulty multipliers). **If you retune those in `config.js`, fix the
  copy in `screens.js` too** — nothing links the two.

---

## Offline shell + update prompt ✅ landed

Files: `src/sw.js` (template), `src/swClient.js`, `src/ui/updatePrompt.js`,
the `gelcube-service-worker` plugin in `vite.config.js`, `public/_headers`.

Post-build addition, not one of the original workstreams. Deploy-side detail
lives in [DEPLOYMENT-INSTRUCTIONS.md](DEPLOYMENT-INSTRUCTIONS.md) §3; this is
what matters if you are changing code.

### `src/sw.js` is a template, not a module

Nothing imports it and Vite never puts it through the module graph. The build
plugin stamps a build digest and the precache list into it and emits
`dist/sw.js`. Consequences:

- **No imports, no `import.meta`, no bundler syntax.** Plain ES2020 against the
  service worker globals.
- The plugin **throws** if either placeholder is missing. That is deliberate —
  an unstamped worker still deploys and then dies on an undefined identifier at
  install time, silently taking offline support with it. (This exact bug
  happened while writing it: `String.replace` stamped a mention of the token in
  a doc comment instead of the code.)
- The build digest covers the **contents** of every emitted file, not just
  filenames, so an `index.html`-only change still produces an update. Rebuilding
  unchanged sources produces an identical worker, so it does not nag players
  over a no-op deploy.

### The worker never activates itself

`install` precaches and stops; there is no `skipWaiting()` in it. The new worker
waits until `ui/updatePrompt.js` → `swClient.applyUpdate()` posts
`{type:'SKIP_WAITING'}`. **Don't "simplify" this by auto-activating** — it would
swap the bundle under a live run and reload the player out of their game.

### Gotchas

- `public/audio/` is **not** precached. `cache.addAll()` is atomic and the mp3s
  are optional, so one absent file would fail the whole install and leave the
  game with no offline support at all. They are runtime-cached instead, into an
  unversioned `gelcube-audio-v1` cache that survives deploys — re-downloading
  megabytes of audio on every release would be the worst trade in the project.
- Only same-origin `200`s are cached. A 404 for a missing optional mp3 must
  never be stored as if it were the file.
- The toast is **not** a screen (same reasoning as How to Play) and stays hidden
  while `screen` is `'playing'` or `'paused'` — `'paused'` still means a live
  run, and a mis-tap there would destroy it.
- In dev, `swClient.js` actively **unregisters** any worker it finds instead of
  registering one. `npm run preview` registers a real worker on localhost, and
  left alone it would serve a built bundle over the top of the dev server.
- `registerServiceWorker()` swallows every failure. Offline play is a bonus; a
  registration error must never stop the game booting.

### Not verifiable in the agent browser

Service worker registration is blocked in the in-app browser pane — even a
one-line worker fails with "An unknown error occurred when fetching the script".
`src/sw.js`'s handlers were verified by driving them in a stubbed
`ServiceWorkerGlobalScope` under Node, and `ui/updatePrompt.js` by importing the
real module over the dev server. **The browser-side lifecycle — `updatefound`,
`waiting`, `controllerchange`, and the reload — has not been exercised against a
real browser.** Check it by hand in Chrome or Safari before trusting a release:
build, serve `dist/`, load it, rebuild with a change, reload, and confirm the
toast appears and Refresh lands the new build.

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

---

## Round-score HUD + torch scoring — landed

Files: `src/game/rules.js`, `src/game/levels.js`, `src/render/torches.js`,
`src/ui/hud.js`, `src/ui/scorePopups.js` (new), `src/main.js`,
`src/state/store.js`, `src/config.js`.

### ⚠️ `hud.update()` was dead code — this is why Score/Loot Secured looked broken

Before this pass, `main.js` never called `hud.update()` anywhere in its render
loop. `hud.js` only writes the score number, loot-bar width/color, dried
countdown and combo badge to the DOM **inside** `update()` — the `on(...)`
listeners only ever set the `target*` variables, never touch the DOM. So the
whole dynamic HUD was frozen at its initial paint for the entire history of
this feature; the user-reported "Score and Loot Secured look like they don't
do anything" was a real, literal bug, not a perception issue. Fixed by adding
`hud.update();` alongside `fx.update(dt)` in `main.js`'s `render()`. If you
add another store-driven HUD widget, remember its DOM write has to happen
inside `update()`, and `update()` has to actually be called somewhere.

### Score model: `score = bankedScore + roundScore`

`state.bankedScore` is the locked-in total from rounds already finished.
`state.roundScore` is the round in progress: it opens at
`coinsTotal * SCORE_PER_UNBANKED_COIN` (see the comment on that constant in
`config.js` for why one constant drives both the opening bonus and the
per-coin bank penalty) and moves up/down in real time as the round plays out.
`rules.js`'s `awardScore()` is the only place either field changes — it keeps
`state.score` in sync every time, so `screens.js`/`leaderboard.js` (which
still just read `state.score`) needed **no changes** for game-over/leaderboard
to keep working.

`startLevel()` folds the previous round into the bank (`bankedScore =
state.score` at that point) before opening the new round — this runs
identically whether the level transition was clear-and-advance or
fail-and-retry-same-level, so a failed round's partial (or even negative, if
the party out-banked what the cube clawed back) contribution is preserved,
not discarded.

Verified directly (not just by reading the code): a standalone `rules`
instance built with `createRules({ scene: new THREE.Scene() })` and driven
with `rules.update(dt, DIR_NONE)` in a tight loop, run from the browser
console — this shares the same `state`/`listeners` singletons as the live
page (ES module caching), so it's a faithful exercise of the production path
without waiting on real wall-clock gameplay. Confirmed: opening bonus exactly
equals `coinsTotal * SCORE_PER_UNBANKED_COIN`; banking N coins decrements
`roundScore` by exactly `N * SCORE_PER_UNBANKED_COIN`; a level failure emits
`LEVEL_FAILED` with `score` equal to the round's ending value, then the
retry's `LEVEL_STARTED` shows that same value as the new `bankedScore` with
`roundScore` reset to 0.

### Torch snuffing: how rules.js gets torch positions without touching render/

`rules.js` still never reaches into `level.torches` (the render object) or
any other view — see the module header comment. Torch tile positions are
plain data instead: `torches.js` exports `pickTorchSpots()` (already existed,
just newly exported) and `getTorchSpots(maze)` (wraps the seed derivation),
plus a pure `torchMountPosition(spot)` for the world-space math. `levels.js`
calls `getTorchSpots(maze)` **once** and hands the identical array to both
`buildTorches(scene, maze, spots)` (the visual) and the level bundle's new
`torchPositions` field (`{col,row,x,z}[]`, plain data) — so index _i_ means
the same torch on both sides without either side recomputing the deterministic
spot-picking independently. `rules.js` reads `level.torchPositions` the same
way it already reads `level.maze`/`level.coinsTotal` (plain level-bundle data,
not a render call), does its own proximity check against the cube each frame,
and on a hit emits `TORCH_SNUFFED {index, col, row}` — `main.js` is what turns
that into `level.torches.snuff(index)` plus an `fx.sparkle()`, matching every
other render-side reaction in this file (`ADVENTURER_DISSOLVED`→
`fx.dissolveBurst`, etc).

`torches.js`'s light-pool assignment loop had a latent bug this exposed: if
the active torch count ever drops below the pool size, an unassigned
`PointLight` kept whatever `visible`/position it had from the previous frame
instead of being turned off. Not reachable before (torch count never dropped
below the pool size), but snuffing torches makes it reachable, so the
assignment loop now explicitly hides an unassigned light each frame.

### New store surface (additive)

- `state.bankedScore`, `state.roundScore` (state)
- `EVENTS.SCORE_POPUP` — `{ amount, x, z }`, one per scoring event (dissolve
  chain, banked-loot penalty, torch snuff, level-clear bonus); `amount`'s sign
  is what `scorePopups.js` uses to color it, no separate "kind" field
- `EVENTS.TORCH_SNUFFED` — `{ index, col, row }`

### `src/ui/scorePopups.js` — new, WS-G-shaped

Pooled DOM nodes (not a Three.js sprite/particle) projected from world space
via a single reused `THREE.Vector3.project(camera)` each frame — text stays
crisp and it's simpler than a canvas-texture sprite for a handful of
concurrent popups. Mounted into `uiRoot` alongside the HUD; `main.js` owns
`scorePopups.update(dt, sceneCtx.camera)` in `render()` and resets the pool on
`LEVEL_STARTED` the same way `fx.reset()`/`slimeTrail.reset()` already do.

## Adventurer legibility pass — difficulty-gated look, notice tell, close camera ✅ landed

Follow-up to the wall/floor contrast pass, driven by an art-direction study
(a Three.js-in-an-Artifact doc, not checked into the repo). Four pieces:

### ⚠️ `patch()`'s event payload is always the whole `state`, never `fields`

`store.patch(fields, evt)` does `emit(evt, state)` — the listener receives the
**entire store**, not the patch you passed in. Bit this pass directly: a first
draft of `on(EVENTS.SETTINGS_CHANGED, (settings) => sceneCtx.setCameraMode(...))`
silently no-opped because `settings.closeCamera` was actually
`state.closeCamera` (undefined) — `state.settings.closeCamera` is where it
actually lives. `audio.js`'s existing `SETTINGS_CHANGED` listener already gets
this right by taking no argument and reading `state.settings` directly inside
the callback; that's the pattern to copy, not the argument name.

### `adv.spotted` + `losDistance()` — a second, independent "notices you" signal

`grid.js` gained `losDistance(maze, aCol, aRow, bCol, bRow, who)`: straight
line-of-sight only (same row or column, wrap-aware on columns, every tile
between must be walkable), distinct from `pathfinding.js`'s `distanceField`
(which routes around corners). `adventurer.js`'s `replan()` sets the public
`adv.spotted` off it against `NOTICE_SIGHT_RADIUS` (config.js) every planning
tick — deliberately independent of `state`/`hunt`/`flee`: it fires the same
"oh!" beat whether or not a fresh `itemTaken`/hunt-flip happens to line up
with the moment sight is gained. `adventurerMesh.js` edge-triggers the
overhead "!" sprite off the rising edge of this flag inside `update()`, so
main.js just passes `spotted: adv.spotted` through each frame — no new store
event needed, no cooldown logic either (losing sight re-arms it for free).

### Difficulty now drives adventurer color + a ground halo, not just pacing

`config.js`'s `DIFFICULTIES` entries gained `advColorTier`
(`'baseline'|'bright'`) and `haloMode` (`'none'|'flash'|'persist'`),
threaded through `levelParams()` → `levels.js` → `buildAdventurerMesh(scene,
archetype, { colorTier, haloMode })`. `adventurerMesh.js`'s material cache is
now keyed `${archetype}:${colorTier}` (was just `archetype`) — easy to miss if
you're skimming for "the cache key" and only see `archetype` used elsewhere in
the file. The halo's flash-then-settle timing is armed at construction time,
not off a `LEVEL_STARTED` listener — safe only because `levels.js` always
builds a **fresh** `AdventurerView` per level (never pools/reuses one), so
"constructed" and "level started" are the same instant for this module. If
adventurer views ever do get pooled across levels, this halo arming needs to
move to an explicit re-arm call.

### Optional close-follow camera — `scene.js` gained a second camera mode

`createScene()` returns a new `setCameraMode('board'|'close')`, and
`update(dt, followX, followZ)` grew two (optional, default-0) trailing
params. `'close'` reuses the exact same `fitCameraDistance()` formula as
`'board'`, just solved for `CLOSE_CAMERA_HALF_TILES` (config.js) around the
follow target instead of the whole maze at `CAMERA_PITCH_DEG` — same formula,
different pitch/extent inputs, not a second camera system. No position
smoothing/lerp on the follow target on purpose: screen wrap teleports
`player.x` instantly, and a smoothed follow would visibly slide across the
map on every wrap instead of cutting with it. Toggled from `ui/hud.js` (a
button next to pause, not a Home-screen setting) via the same
direct-`patch()`-plus-`saveSettings()` pattern the pause button and Home's
`updateSetting()` both already use — see the gotcha above before wiring a new
listener to it.

### `src/render/archetypeShowcase.js` — new, self-contained

The How to Play overlay's "Meet the party" panel. Its own
`THREE.WebGLRenderer` on its own `<canvas>` (mounted on
`setHowtoOpen(true)`, disposed on close) — not the game's `sceneCtx`, since
this can open from Home before any run (and `sceneCtx.scene`) exists. Reuses
`buildAdventurerMesh()` directly (four calls, one per archetype) rather than
duplicating any geometry-building code.
