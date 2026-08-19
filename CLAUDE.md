# CLAUDE.md

Guidance for AI agents working in this repo.

## The project

**Gelatinous Cube** — Pac-Man inverted, in a D&D dungeon. You are the ooze in the
lair (the ghost house); the *adventurers* are the Pac-Men, scooping coins and
hauling them to stairwells to bank. Dissolve them all to clear a level; if they
bank the loot goal first you lose a life. A magic item taken by an adventurer
**dries out** the cube — slow, shrivelled, vulnerable — and the party turns and
hunts you. Three lives, then initials on a local leaderboard.

Vanilla ES modules + Three.js, built by Vite, deployed as static assets on a
Cloudflare Worker. No backend, no framework, no test runner. `three` is the only
runtime dependency and it must stay that way.

**All eight original workstreams have landed.** The game is complete and playable
end to end; work now is maintenance, tuning and features on a finished system.

## Commands

```bash
npm run dev          # Vite dev server on :5173, exposed on the LAN for phone testing
npm run build        # production build into dist/
npm run verify       # lists any stubbed modules, then runs the production build
npm run verify:maze  # generates hundreds of mazes and asserts every invariant
npm run preview      # serve the built dist/ locally
npm run format       # Prettier over the whole repo
npm run format:check # Prettier in check-only mode (what CI runs)
```

`npm run format:check`, `npm run verify` and `npm run verify:maze` are what CI
runs — they are the whole test suite. Run all three before declaring work done;
run `verify:maze` in particular after touching anything under `src/maze/`.

Formatting is Prettier's job, not yours: config lives in `.prettierrc.json` and
`.githooks/pre-commit` formats staged files on the way into every commit. The
hook is installed by the `prepare` script, so `npm install` is all it takes; it
is skipped by `git commit -n`. Don't hand-align code against the formatter, and
don't reformat lines you aren't otherwise touching.

To see the game running, use the browser preview tools with the `dev`
configuration in `.claude/launch.json` — never start the dev server through Bash.
Verify changes yourself in the preview rather than asking the user to look.

## Read the docs in this order

| Doc | What it is |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | The design contract: rules of play, coordinate system, and every module's public API. Start here. |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | What each module *actually* built, plus the gotchas found while building. **Where it is more specific than SPEC.md, it wins.** Also the definitive table of every store event and exactly when it fires. |
| [docs/AUDIO.md](docs/AUDIO.md) | The mp3 filename contract given to the user. Don't rename anything in it. |
| [docs/DEPLOYMENT-INSTRUCTIONS.md](docs/DEPLOYMENT-INSTRUCTIONS.md) | Cloudflare setup, cutting a release, rollback. |

The `WS-x` labels throughout the source and docs refer to the original parallel
workstreams that built the game. Their file-ownership rules ("never edit a file
you don't own") were a concurrency safeguard for parallel agents and no longer
apply — but the module boundaries they produced are good, so keep changes inside
the module that owns the concern. The two work-breakdown docs those labels came
from (`TASKS.md`, `WORK-REMAINING.md`) were deleted once the build finished;
their durable design intent now lives in `SPEC.md`, and git history has the rest.

## Architecture

```
main.js          bootstrap; the ONLY place store events turn into Three.js calls
  ├─ game/loop.js      fixed timestep (FIXED_DT), clamps at MAX_FRAME_DT,
  │                    subscribes to SCREEN_CHANGED to start/stop the sim clock
  ├─ game/rules.js     the referee — collisions, scoring, lives, dried timer,
  │                    level clear/fail. Owns ALL store mutations and events.
  ├─ game/levels.js    builds a level from levelParams(): maze, views, entities
  ├─ state/store.js    dumb observable state + event bus
  ├─ ui/*, game/audio.js   listen to the store only; never drive simulation
  └─ maze/, render/, entities/   pure modules, no store access
```

The data flow is one-directional and worth protecting: **`rules.js` mutates the
store and emits; `ui/` and `audio.js` only listen.** Nothing in `render/`,
`entities/` or `maze/` imports the store. The UI's pause button flips
`store.setScreen('paused')` directly and never touches the loop — `loop.js`
reacts to the screen change.

### Contract files — change with care

`src/config.js`, `src/maze/grid.js`, `src/state/store.js`.

Everything depends on these. Adding a constant, a state field or an event name is
fine (additive only). Renaming or removing an export, or changing a signature, is
a cross-cutting change — say so explicitly in your report. Changing a *tuning
value* in `config.js` changes how the game plays: only do it when asked or when
you have actually playtested the result, and record the reasoning in a comment
next to the value (see `PACK_CAPACITY` for the house style).

### Coordinates

Floor is the XZ plane at y=0, +Y up. Column → +X, row → +Z. Grid is 28×31,
centred on the origin, one tile per world unit. **Always use the helpers in
`src/maze/grid.js`** — never re-derive the maths inline. The maze wraps
horizontally on `maze.tunnelRows`; there is no vertical wrap.

## Hard constraints

1. **No new dependencies.** Vanilla ES modules and Three.js only. No TypeScript,
   no React, no utility libraries. This is about what ships: `three` stays the
   lone runtime dependency, and build/dev tooling stays minimal too — Vite and
   Prettier, nothing more, unless the user asks for it.
2. **No external asset files.** Textures are drawn procedurally into a `<canvas>`;
   geometry is built from Three.js primitives. The sole exception is the optional
   mp3s the user drops into `public/audio/` — and the game must run identically
   when that folder is empty.
3. **Mobile performance is a requirement, not a goal.** Target 60fps on a
   mid-range phone. No per-frame allocation in any `update()` path, no
   per-entity materials, `InstancedMesh` for anything repeated, and every
   geometry/material/texture created must be freed in a `dispose()`.
4. **The whole board must stay on screen** in both portrait and landscape. Screen
   wrap only reads if you can see both edges — that constraint outranks filling
   the frame, which is why extreme portrait aspects letterbox.
5. **Touch is the primary input**, keyboard is the fallback. Never make a feature
   keyboard-only. Minimum 44px touch targets, no page scroll or zoom.
6. **All persistence is `localStorage`,** via `src/state/storage.js`, which must
   never throw (private browsing, quota errors) — it falls back to an in-memory
   Map.
7. **Don't invent screens.** Home, playing, paused, gameover, leaderboard. That's
   the set.

## Gotchas that have already bitten someone

- `maze.lair` is 8 tiles wide, not the 7 the spec suggests — COLS is even, so a
  mirror-symmetric block must have even width. Read `maze.lair.cols`, never
  hardcode. The single `TILE_LAIR_DOOR` is the one legitimately asymmetric tile.
- Pathfinding reuses module-level scratch buffers stamped by a generation
  counter. Safe for the synchronous call pattern the game uses; **never call
  those functions reentrantly from inside their own callbacks.**
- Per-frame wiring in `main.js` that is easy to break: `torches.focus` must track
  the cube, `cube.update()` needs `driedSecondsLeft` (not just `driedRatio` — the
  blink timing drifts at other difficulties without it), and the slime trail
  needs the dried flag so it stops dropping splats.
- Adventurers must always pass `'adventurer'` to walkability checks; they may
  never enter `TILE_LAIR` or `TILE_LAIR_DOOR`.
- Three.js physical lighting needs much larger intensity numbers than the legacy
  scale. The scene budget is 2 base + 6 pooled torch lights + 1 inside the cube.

## Verifying gameplay changes

There is no automated coverage of gameplay — `verify` only proves it builds.
Anything touching rules, movement, AI or feel has to be **playtested**, and the
findings written down. Useful technique on record: attach a temporary
`store.on(...)` listener from the browser console to watch events and score
deltas live, with no source changes. Check at a 375×812 viewport as well as
desktop. A level should last roughly 60–90 seconds.

Scratch harnesses and test files go in a temp directory outside the repo. Leave
no stray files behind.

## Releasing

CI runs on every push to `main` and every PR. **Nothing deploys on a push to
`main`** — deploys fire only on a `release-*` tag:

```bash
npm version patch && git push --follow-tags
```

`tag-version-prefix` in `.npmrc` produces `release-1.0.0`, and the version badge
in-game is read from `package.json` at build time, so the badge can never drift
from the deployed tag. Full detail, including rollback, is in
[docs/DEPLOYMENT-INSTRUCTIONS.md](docs/DEPLOYMENT-INSTRUCTIONS.md).

Cutting a release publishes to the live site. Don't tag, push tags, or deploy
unless the user asks for it.

## Style

- Comments are sparse and explain *why*, not *what*. Follow the tone already in
  the source: a module header saying what the file is responsible for, and
  comments reserved for decisions a reader would otherwise second-guess.
- When you change a documented contract or discover a gotcha the next agent would
  trip over, **add it to `docs/INTEGRATION.md`.** That file is the project's
  accumulated institutional memory and is why the build went as smoothly as it
  did.
