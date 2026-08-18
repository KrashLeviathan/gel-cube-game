/**
 * WS-F — level builder. Glue that turns `levelParams()` into a fully built,
 * playable level: a fresh random maze, the per-level render views, and the
 * adventurer/pickup entities, wired to nothing yet — rules.js drives them.
 *
 * Build model: EVERYTHING here is rebuilt fresh per level (cleared OR
 * failed both regenerate the maze per SPEC §4), including the player logic
 * entity — `createPlayer(maze, opts)` closes over `maze` at construction
 * time, so a new maze needs a new player object even though the cube's
 * *visual* (buildCube/slimeTrail, owned by main.js) persists across the
 * whole run untouched. Only the logic-side player is rebuilt here.
 */
import { levelParams } from '../config.js';
import { generateMaze } from '../maze/generator.js';
import { buildDungeon } from '../render/dungeonMesh.js';
import { buildTorches } from '../render/torches.js';
import { createPickups } from '../entities/pickups.js';
import { createPlayer } from '../entities/player.js';
import { createAdventurer, ARCHETYPES } from '../entities/adventurer.js';
import { buildAdventurerMesh } from '../render/adventurerMesh.js';

const ARCHETYPE_CYCLE = Object.keys(ARCHETYPES);

/**
 * @param {import('three').Scene} scene
 * @param {import('../config.js').DifficultyId} difficulty
 * @param {number} levelNumber 1-based
 * @returns {{
 *   maze: object, params: object, player: object,
 *   adventurers: {adv: object, view: object}[],
 *   pickups: object, dungeonView: object, torches: object,
 *   coinsTotal: number, lootGoal: number, dispose(): void,
 * }}
 */
export function buildLevel(scene, difficulty, levelNumber) {
  // No seed passed — SPEC requires a freshly RANDOM maze every level (both on
  // clear-and-advance and on fail-and-retry-same-level).
  const maze = generateMaze();
  const params = levelParams(difficulty, levelNumber);

  const dungeonView = buildDungeon(scene, maze);
  const torches = buildTorches(scene, maze);
  const pickups = createPickups(scene, maze, params.magicItems);

  const player = createPlayer(maze, {});

  const spawns = maze.advSpawns && maze.advSpawns.length ? maze.advSpawns : [maze.spawn];
  const adventurers = [];
  for (let i = 0; i < params.advCount; i++) {
    const archetype = ARCHETYPE_CYCLE[i % ARCHETYPE_CYCLE.length];
    const spawn = spawns[i % spawns.length];
    const adv = createAdventurer(maze, archetype, spawn, { speed: params.advSpeed });
    const view = buildAdventurerMesh(scene, archetype);
    adventurers.push({ adv, view });
  }

  // Captured right after pickups are armed, before anything is taken —
  // exactly "coins placed on every eligible floor tile" per SPEC §4.
  const coinsTotal = pickups.coinsRemaining;
  const lootGoal = Math.floor(coinsTotal * params.lootGoalFraction);

  function dispose() {
    dungeonView.dispose();
    torches.dispose();
    pickups.dispose();
    for (const { view } of adventurers) view.dispose();
  }

  return { maze, params, player, adventurers, pickups, dungeonView, torches, coinsTotal, lootGoal, dispose };
}
