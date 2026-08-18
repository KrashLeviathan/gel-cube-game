# Work breakdown

Eight workstreams. Files are partitioned so parallel streams never touch the
same file. **Read `docs/SPEC.md` first** — it holds the API contracts.

| WS | Scope | Owns | Depends on | Phase |
|---|---|---|---|---|
| **A** | Maze generation + pathfinding | `src/maze/generator.js`, `src/maze/pathfinding.js`, `scripts/verify-maze.mjs` | contracts | 1 |
| **B** | Dungeon rendering & atmosphere | `src/render/scene.js`, `src/render/dungeonMesh.js`, `src/render/torches.js` | contracts | 1 |
| **C** | The cube, slime trail, FX | `src/render/cube.js`, `src/render/slimeTrail.js`, `src/render/fx.js` | contracts | 1 |
| **D** | Player movement + touch input | `src/entities/player.js`, `src/game/input.js` | A (grid semantics) | 2 |
| **E** | Adventurers + pickups | `src/entities/adventurer.js`, `src/render/adventurerMesh.js`, `src/entities/pickups.js` | A | 2 |
| **G** | UI shell, HUD, leaderboard, storage | `src/ui/*`, `src/state/storage.js` | contracts | 1 |
| **F** | Integration: rules, levels, loop, main | `src/game/rules.js`, `src/game/levels.js`, `src/game/loop.js`, `src/main.js` | A–E, G | 3 |
| **H** | Audio + polish pass | `src/game/audio.js`, `docs/AUDIO.md` | F | 4 |

Phase 1 streams run concurrently. Phase 2 starts once A lands (D and E need a
real maze to move through). Phase 3 is a single integrator. Phase 4 is polish +
a QA pass on a mobile viewport.

## Definition of done, every workstream

- Public API matches `docs/SPEC.md` §5 exactly.
- `npm run build` passes.
- No new dependencies; no external asset files.
- No per-frame allocations in `update()`; everything created is disposed.
- Report deviations rather than silently changing the contract.

## Shared files — read-only for all workstreams

`src/config.js`, `src/maze/grid.js`, `src/state/store.js`, `docs/SPEC.md`.
Need a change there? Say so in your report; the integrator applies it.
