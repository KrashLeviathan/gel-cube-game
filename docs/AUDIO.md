# Audio drop-in guide

**Put your mp3 files in `public/audio/` using the exact filenames below.**
Every file is optional — anything missing is silently skipped, and the game
plays fine with an empty folder. Add files as you get them; no code changes
needed.

Vite serves `public/` at the site root, so `public/audio/theme.mp3` is fetched
as `/audio/theme.mp3` in both dev and the production build.

## Music (looping)

| File                 | When it plays                                                               |
| -------------------- | --------------------------------------------------------------------------- |
| `music-title.mp3`    | Home / leaderboard screens                                                  |
| `music-level.mp3`    | Normal play — the hunt                                                      |
| `music-dried.mp3`    | While the cube is dried out and being hunted. Tense. Ducks the level track. |
| `music-gameover.mp3` | Game over screen                                                            |

Loop points aren't supported — author the files so they loop cleanly end to end.

## Sound effects (one-shot)

| File                    | Trigger                                                |
| ----------------------- | ------------------------------------------------------ |
| `sfx-ui-tap.mp3`        | Any button press                                       |
| `sfx-level-start.mp3`   | Level begins                                           |
| `sfx-level-clear.mp3`   | All adventurers dissolved                              |
| `sfx-level-fail.mp3`    | Party banked the loot goal                             |
| `sfx-engulf.mp3`        | Cube engulfs an adventurer — wet, meaty                |
| `sfx-digest.mp3`        | Follow-up gulp after engulfing                         |
| `sfx-combo.mp3`         | Chained dissolve (pitch rises with combo)              |
| `sfx-coin.mp3`          | Adventurer picks up a coin                             |
| `sfx-bank.mp3`          | Adventurer banks a pack at a stairwell                 |
| `sfx-spill.mp3`         | Dissolved adventurer's coins spill back onto the floor |
| `sfx-item.mp3`          | Adventurer grabs a magic item                          |
| `sfx-dried.mp3`         | Cube dries out — the danger stinger                    |
| `sfx-dried-warning.mp3` | Dried state about to end                               |
| `sfx-rehydrate.mp3`     | Cube recovers                                          |
| `sfx-life-lost.mp3`     | An adventurer lands a hit on the dried cube            |
| `sfx-tunnel.mp3`        | Cube passes through a wrap tunnel                      |
| `sfx-slime-step.mp3`    | Low looping ooze crawl while moving                    |
| `sfx-highscore.mp3`     | Score qualifies for the leaderboard                    |

## Notes

- Keep files small — mobile browsers over a phone connection. 128kbps mono is
  plenty for sfx; music can be 128–160kbps stereo. Aim to stay under ~4MB total.
- Browsers block audio until the user interacts, so the audio system unlocks on
  the first tap. Nothing plays on the home screen until you touch it once.
- Music and SFX are independently toggleable in the home-screen settings, and
  the choice persists in `localStorage`.
- If you'd rather use a different filename, the mapping lives in one table at
  the top of `src/game/audio.js`.
