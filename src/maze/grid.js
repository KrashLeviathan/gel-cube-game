/**
 * Grid <-> world coordinate math and tile queries.
 *
 * CONTRACT FILE — owned by the architect. Do not change these signatures;
 * every other module depends on them.
 *
 * Coordinate system:
 *   - The floor lies on the XZ plane at y = 0. +Y is up.
 *   - Column increases with +X, row increases with +Z.
 *   - Tile (col,row) has its CENTER at world (worldX(col), y, worldZ(row)).
 *   - The maze is centered on the origin.
 *
 * A "maze" object is:
 *   {
 *     cols: number,
 *     rows: number,
 *     tiles: Uint8Array,        // length cols*rows, values are TILE_* from config
 *     lair: { col, row, cols, rows },   // bounding box of the lair interior
 *     spawn: { col, row },              // cube spawn (center of the lair)
 *     advSpawns: [{ col, row }, ...],   // adventurer spawn tiles (outside the lair)
 *     exits: [{ col, row }, ...],       // stairwell tiles for banking loot
 *     tunnelRows: number[],             // rows that wrap horizontally
 *     itemSpots: [{ col, row }, ...],   // candidate tiles for magic items
 *     seed: number,
 *   }
 */

import { COLS, ROWS, TILE_WALL, TILE_LAIR, TILE_LAIR_DOOR } from '../config.js';

/** World X of the center of a column. */
export function worldX(col) {
  return col - (COLS - 1) / 2;
}

/** World Z of the center of a row. */
export function worldZ(row) {
  return row - (ROWS - 1) / 2;
}

/** Nearest column to a world X. */
export function colAt(x) {
  return Math.round(x + (COLS - 1) / 2);
}

/** Nearest row to a world Z. */
export function rowAt(z) {
  return Math.round(z + (ROWS - 1) / 2);
}

/** Flat index into maze.tiles. Assumes col/row already wrapped. */
export function idx(col, row) {
  return row * COLS + col;
}

/** Wrap a column into [0, COLS). */
export function wrapCol(col) {
  return ((col % COLS) + COLS) % COLS;
}

/** Wrap a row into [0, ROWS). Vertical wrap is only used if the maze enables it. */
export function wrapRow(row) {
  return ((row % ROWS) + ROWS) % ROWS;
}

/** Wrap a continuous world X back inside the maze bounds. */
export function wrapWorldX(x) {
  const half = COLS / 2;
  let v = x;
  while (v < -half) v += COLS;
  while (v >= half) v -= COLS;
  return v;
}

/** Tile value at (col,row), wrapping horizontally. Out-of-range rows read as wall. */
export function tileAt(maze, col, row) {
  if (row < 0 || row >= ROWS) return TILE_WALL;
  return maze.tiles[idx(wrapCol(col), row)];
}

/**
 * Can the given actor stand on this tile?
 * @param {'cube'|'adventurer'} who
 */
export function isWalkable(maze, col, row, who) {
  const t = tileAt(maze, col, row);
  if (t === TILE_WALL) return false;
  if (who === 'adventurer' && (t === TILE_LAIR || t === TILE_LAIR_DOOR)) return false;
  return true;
}

/** Shortest signed column delta from a to b, accounting for horizontal wrap. */
export function deltaCol(a, b) {
  let d = b - a;
  if (d > COLS / 2) d -= COLS;
  if (d < -COLS / 2) d += COLS;
  return d;
}

/** Manhattan distance in tiles, wrap-aware on the column axis. */
export function tileDistance(aCol, aRow, bCol, bRow) {
  return Math.abs(deltaCol(aCol, bCol)) + Math.abs(bRow - aRow);
}

/** Iterate the four neighbours of a tile. Calls fn(col, row, dirIndex). */
export function forEachNeighbor(col, row, fn) {
  fn(wrapCol(col), row - 1, 0);
  fn(wrapCol(col + 1), row, 1);
  fn(wrapCol(col), row + 1, 2);
  fn(wrapCol(col - 1), row, 3);
}
