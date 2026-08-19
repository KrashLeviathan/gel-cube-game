/**
 * WS-F — the referee. Owns level setup/teardown, collision resolution,
 * scoring + combo chain, lives, the dried timer, level clear/fail, and every
 * `store` mutation/event this game needs. No Three.js/rendering here at all —
 * it only ever touches entity *logic* objects (player/adventurer .update()/
 * .kill()/.teleportTo()) and the store. main.js reads the accessors below to
 * drive the render-side objects (cube view, adventurer meshes, torches, fx,
 * slime trail) every frame; rules.js never reaches into any of those.
 *
 * ---------------------------------------------------------------------------
 * ctx contract this module builds and hands to the entities, every frame:
 *
 *   player.update(dt, inputDir, { speed })
 *     `speed` = params.cubeSpeed, x DRIED_SPEED_MULT while dried, x
 *     DIGEST_SPEED_MULT while digesting (see computeCubeSpeed()). Frozen at
 *     speed 0 during the post-respawn grace window (input ignored too).
 *
 *   adventurer.update(dt, ctx) where
 *     ctx = {
 *       cube: { col, row, dried },              // player's tile + dried flag
 *       hasCoinAt, takeCoinAt, items, takeItemAt // passed straight through
 *                                                // from the level's live
 *                                                // pickups instance, except
 *                                                // takeCoinAt is wrapped one
 *                                                // level deep purely to emit
 *                                                // COIN_TAKEN + keep
 *                                                // state.coinsOnFloor honest
 *                                                // — the pickups call itself
 *                                                // is untouched.
 *     }
 * ---------------------------------------------------------------------------
 *
 * Interpretation call (SPEC §4 "Cube" doesn't say explicitly): does losing a
 * life end the dried state? This module says NO — the dried timer keeps
 * counting through the respawn freeze. Reasoning: adventurers can never enter
 * the lair, so RESPAWN_GRACE plus the lair itself already fully protects the
 * player; not clearing dried on top of that avoids a "walk into a hunter on
 * purpose to instantly cure dried" exploit, and keeps the moment tense (walk
 * out of the lair still dried, into adventurers that were left waiting at the
 * door) rather than granting a free reset. "Adventurers scatter" per SPEC is
 * satisfied for free: once dried genuinely ends, the next AI planning tick
 * (~0.2s) re-evaluates against the cube's new, far-away lair position, so
 * FLEE naturally stands down and they drift back to COLLECT without any
 * special-cased scatter logic.
 */
import {
  DIR_NONE,
  COLS,
  CONTACT_DIST,
  DIGEST_TIME,
  DIGEST_SPEED_MULT,
  DRIED_SPEED_MULT,
  DRIED_WARNING_TIME,
  RESPAWN_GRACE,
  COMBO_WINDOW,
  DISSOLVE_SCORES,
  SCORE_PER_RECOVERED_COIN,
  LEVEL_CLEAR_BONUS,
  SCORE_PER_UNBANKED_COIN,
  SCORE_PER_TORCH_SNUFFED,
  TORCH_SNUFF_DIST,
} from '../config.js';
import { state, patch, emit, on, setScreen, resetRun, EVENTS } from '../state/store.js';
import { qualifies } from '../state/storage.js';
import { buildLevel } from './levels.js';
import { worldX, worldZ } from '../maze/grid.js';

// Seconds the "LEVEL CLEARED"/"LEVEL FAILED" banner gets to sit on screen,
// with the dissolve/spill animations still playing out on the old level,
// before the next maze is built and swapped in.
const TRANSITION_DELAY = 2.0;

export function createRules({ scene }) {
  let level = null; // current buildLevel() bundle, or null between runs
  let player = null; // level.player, hoisted for convenience
  let currentParams = null; // level.params
  let runDifficulty = 'normal';

  let comboCount = 0;
  let comboTimer = 0;
  let digestTimer = 0;
  let recoveredCoins = 0; // cumulative coins recovered via kills THIS level
  let respawnGrace = 0;
  let driedWarningFired = false;
  let lastCubeSpeed = 0;
  let transition = null; // { type: 'cleared'|'failed', timer, levelNumber }
  const snuffedTorches = new Set(); // indices into level.torchPositions, this level only

  // -------------------------------------------------------------------------
  // wrap-aware contact distance (world units; COLS === maze width in tiles)
  // -------------------------------------------------------------------------
  function wrappedDeltaX(dx) {
    const half = COLS / 2;
    if (dx > half) return dx - COLS;
    if (dx < -half) return dx + COLS;
    return dx;
  }
  function contactDistance(ax, az, bx, bz) {
    return Math.hypot(wrappedDeltaX(ax - bx), az - bz);
  }

  // `state.score` is always `bankedScore + roundScore` — bankedScore is the
  // locked-in total from rounds already finished, roundScore is this round's
  // live, fluctuating contribution (see startLevel()). Every scoring event
  // routes through here so the two stay in sync and the HUD can show both.
  function awardScore(rawAmount) {
    if (!currentParams || !rawAmount) return 0;
    const delta = Math.round(rawAmount * currentParams.scoreMult);
    if (!delta) return 0;
    const roundScore = state.roundScore + delta;
    patch({ roundScore, score: state.bankedScore + roundScore }, EVENTS.SCORE_CHANGED);
    return delta;
  }

  /** Fire a floating "+120"/"-40" indicator at a world position. No-op for a
   *  zero delta (e.g. a scoreMult of 0 rounding an award away). */
  function popupScore(amount, x, z) {
    if (!amount) return;
    emit(EVENTS.SCORE_POPUP, { amount, x, z });
  }

  // -------------------------------------------------------------------------
  // level lifecycle
  // -------------------------------------------------------------------------
  function startLevel(levelNumber) {
    const built = buildLevel(scene, runDifficulty, levelNumber);
    level = built;
    player = built.player;
    currentParams = built.params;

    comboCount = 0;
    comboTimer = 0;
    digestTimer = 0;
    recoveredCoins = 0;
    respawnGrace = 0;
    driedWarningFired = false;
    snuffedTorches.clear();

    // Fold whatever the previous round's roundScore ended at (clear bonus
    // included, or a partial/negative round on a failed retry) into the
    // locked-in bank, then open the new round at its starting bonus — see
    // the SCORE_PER_UNBANKED_COIN comment in config.js for why that bonus
    // exactly matches "coinsTotal * SCORE_PER_UNBANKED_COIN".
    const bankedScore = state.score;
    patch(
      {
        level: levelNumber,
        coinsTotal: built.coinsTotal,
        coinsOnFloor: built.coinsTotal,
        coinsBanked: 0,
        lootGoal: built.lootGoal,
        adventurersAlive: built.adventurers.length,
        adventurersTotal: built.adventurers.length,
        dried: false,
        driedRemaining: 0,
        combo: 0,
        cubeMoving: false,
        bankedScore,
        roundScore: 0,
        score: bankedScore,
      },
      EVENTS.LEVEL_STARTED,
    );
    awardScore(built.coinsTotal * SCORE_PER_UNBANKED_COIN);
  }

  function disposeLevel() {
    if (!level) return;
    level.dispose();
    level = null;
    player = null;
    currentParams = null;
    transition = null;
  }

  function completeTransition() {
    const t = transition;
    transition = null;
    disposeLevel();
    startLevel(t.levelNumber);
  }

  function startRun(difficulty) {
    disposeLevel();
    runDifficulty = difficulty || state.settings.difficulty || 'normal';
    resetRun();
    emit(EVENTS.RUN_STARTED, state);
    startLevel(1);
    setScreen('playing');
  }

  function endRun() {
    disposeLevel();
    state.running = false;
  }

  function dispose() {
    disposeLevel();
    unsubHome();
  }

  // Safety net: however 'home' is reached (Quit, or Back-to-Home after
  // game over), make sure the level's Three.js resources get freed. Guarded
  // by disposeLevel()'s own `if (!level) return`, so calling this twice
  // (once explicitly from onQuit, once here) is harmless.
  const unsubHome = on(EVENTS.SCREEN_CHANGED, (screen) => {
    if (screen === 'home') endRun();
  });

  // -------------------------------------------------------------------------
  // level end conditions
  // -------------------------------------------------------------------------
  function triggerLevelFailed() {
    if (transition) return;
    const newLives = Math.max(0, state.lives - 1);
    if (newLives <= 0) {
      patch({ lives: 0 }, EVENTS.LEVEL_FAILED);
      triggerRunOver();
      return;
    }
    patch({ lives: newLives }, EVENTS.LEVEL_FAILED);
    // SPEC §4: failed levels retry the SAME level number, fresh maze.
    transition = { type: 'failed', timer: TRANSITION_DELAY, levelNumber: state.level };
  }

  function triggerLevelCleared() {
    if (transition) return;
    // The unbanked-coin bonus isn't awarded here — it's already fully priced
    // into roundScore, paid out in real time as the inverse of every banked
    // coin's penalty (see the SCORE_PER_UNBANKED_COIN comment in config.js).
    const delta = awardScore(LEVEL_CLEAR_BONUS);
    if (player) popupScore(delta, player.x, player.z);
    patch({}, EVENTS.LEVEL_CLEARED);
    transition = { type: 'cleared', timer: TRANSITION_DELAY, levelNumber: state.level + 1 };
  }

  function triggerRunOver() {
    disposeLevel();
    state.running = false;
    const finalScore = state.score;
    emit(EVENTS.RUN_OVER, {
      score: finalScore,
      level: state.level,
      qualifies: qualifies(finalScore),
    });
    setScreen('gameover');
  }

  // -------------------------------------------------------------------------
  // per-frame ticks
  // -------------------------------------------------------------------------
  function computeCubeSpeed() {
    let speed = currentParams.cubeSpeed;
    if (state.dried) speed *= DRIED_SPEED_MULT;
    if (digestTimer > 0) speed *= DIGEST_SPEED_MULT;
    return speed;
  }

  function tickDigest(dt) {
    if (digestTimer > 0) digestTimer = Math.max(0, digestTimer - dt);
  }

  function tickDried(dt) {
    if (!state.dried) return;
    state.driedRemaining = Math.max(0, state.driedRemaining - dt);
    if (!driedWarningFired && state.driedRemaining <= DRIED_WARNING_TIME) {
      driedWarningFired = true;
      emit(EVENTS.DRIED_WARNING, { remaining: state.driedRemaining });
    }
    if (state.driedRemaining <= 0) {
      state.dried = false;
      driedWarningFired = false;
      emit(EVENTS.DRIED_ENDED, {});
    }
  }

  function tickCombo(dt) {
    if (comboCount <= 0) return;
    comboTimer += dt;
    if (comboTimer >= COMBO_WINDOW) {
      comboCount = 0;
      state.combo = 0;
    }
  }

  // Walking the cube near a torch snuffs it for a small bonus, once per
  // torch per level. `level.torchPositions` is plain data (col/row/x/z)
  // built alongside the render torches in levels.js from the identical spot
  // list, so index i here is index i in torches.js's own array — this
  // module still never calls into the render object itself; main.js does
  // that off the TORCH_SNUFFED event, same as every other fx trigger.
  function tickTorches() {
    const positions = level.torchPositions;
    for (let i = 0; i < positions.length; i++) {
      if (snuffedTorches.has(i)) continue;
      const t = positions[i];
      if (contactDistance(player.x, player.z, t.x, t.z) > TORCH_SNUFF_DIST) continue;
      snuffedTorches.add(i);
      const delta = awardScore(SCORE_PER_TORCH_SNUFFED);
      popupScore(delta, t.x, t.z);
      emit(EVENTS.TORCH_SNUFFED, { index: i, col: t.col, row: t.row });
    }
  }

  function buildAdventurerCtx() {
    return {
      cube: { col: player.col, row: player.row, dried: state.dried },
      hasCoinAt: level.pickups.hasCoinAt,
      takeCoinAt(col, row) {
        const got = level.pickups.takeCoinAt(col, row);
        if (got) {
          state.coinsOnFloor = Math.max(0, state.coinsOnFloor - 1);
          emit(EVENTS.COIN_TAKEN, { col, row });
        }
        return got;
      },
      items: level.pickups.items,
      takeItemAt: level.pickups.takeItemAt,
    };
  }

  function handleAdventurerEvent(result) {
    if (result.type === 'banked') {
      state.coinsBanked += result.count;
      emit(EVENTS.ADVENTURER_BANKED, {
        count: result.count,
        col: result.col,
        row: result.row,
        coinsBanked: state.coinsBanked,
        lootGoal: state.lootGoal,
      });
      patch({ coinsBanked: state.coinsBanked }, EVENTS.LOOT_CHANGED);
      const delta = awardScore(-SCORE_PER_UNBANKED_COIN * result.count);
      popupScore(delta, worldX(result.col), worldZ(result.row));
      if (state.coinsBanked >= state.lootGoal) triggerLevelFailed();
    } else if (result.type === 'itemTaken') {
      state.driedRemaining = currentParams.driedDuration;
      driedWarningFired = false;
      emit(EVENTS.ITEM_TAKEN, { col: result.col, row: result.row, itemType: result.item?.type });
      patch({ dried: true, driedRemaining: state.driedRemaining }, EVENTS.DRIED_STARTED);
    }
  }

  function handleKill(adv) {
    const spillResult = adv.kill();
    state.adventurersAlive = Math.max(0, state.adventurersAlive - 1);

    comboTimer = 0;
    comboCount = Math.min(comboCount + 1, DISSOLVE_SCORES.length);
    state.combo = comboCount;
    digestTimer = DIGEST_TIME;

    let raw = DISSOLVE_SCORES[comboCount - 1];
    let spillCount = 0;
    if (spillResult) {
      level.pickups.spill(spillResult.col, spillResult.row, spillResult.count);
      state.coinsOnFloor += spillResult.count;
      recoveredCoins += spillResult.count;
      spillCount = spillResult.count;
      raw += SCORE_PER_RECOVERED_COIN * spillResult.count;
    }
    const delta = awardScore(raw);
    popupScore(delta, player.x, player.z);

    emit(EVENTS.DIGEST_STARTED, { col: adv.col, row: adv.row });
    emit(EVENTS.ADVENTURER_DISSOLVED, {
      col: adv.col,
      row: adv.row,
      archetype: adv.archetype,
      combo: comboCount,
      spillCount,
    });

    if (state.adventurersAlive <= 0) triggerLevelCleared();
  }

  function handleDriedContact() {
    respawnGrace = RESPAWN_GRACE;
    player.teleportTo(level.maze.spawn.col, level.maze.spawn.row);

    const newLives = Math.max(0, state.lives - 1);
    if (newLives <= 0) {
      patch({ lives: 0 }, EVENTS.LIFE_LOST);
      triggerRunOver();
      return;
    }
    patch({ lives: newLives }, EVENTS.LIFE_LOST);
  }

  function resolveContacts() {
    for (const pair of level.adventurers) {
      const adv = pair.adv;
      if (!adv.alive) continue;
      const dist = contactDistance(player.x, player.z, adv.x, adv.z);
      if (dist > CONTACT_DIST) continue;
      if (state.dried) {
        handleDriedContact();
        return; // one contact = one respawn; player has already teleported away
      }
      handleKill(adv);
      if (!level) return; // handleKill -> triggerLevelCleared can't null level, but be defensive
    }
  }

  // -------------------------------------------------------------------------
  // public: called every fixed sim step by loop.js, only while 'playing'
  // -------------------------------------------------------------------------
  function update(dt, inputDir) {
    if (state.screen !== 'playing' || !level || !player) return;

    if (transition) {
      transition.timer -= dt;
      if (transition.timer <= 0) completeTransition();
      return;
    }

    if (respawnGrace > 0) {
      respawnGrace = Math.max(0, respawnGrace - dt);
    } else {
      const speed = computeCubeSpeed();
      lastCubeSpeed = speed;
      player.update(dt, inputDir, { speed });
      if (player.wrapped) emit(EVENTS.TUNNEL_WRAPPED, { x: player.x, z: player.z });
    }
    state.cubeMoving = respawnGrace <= 0 && player.dir !== DIR_NONE;

    tickDigest(dt);
    tickDried(dt);
    tickCombo(dt);

    const ctx = buildAdventurerCtx();
    for (const pair of level.adventurers) {
      const adv = pair.adv;
      if (!adv.alive) continue;
      const result = adv.update(dt, ctx);
      if (result) handleAdventurerEvent(result);
      if (!level) return; // a bank-triggered failure can end the run mid-loop
    }
    if (!level) return;

    if (respawnGrace <= 0) {
      tickTorches();
      resolveContacts();
    }
  }

  // -------------------------------------------------------------------------
  // accessors main.js's render step reads from (read-only; no Three.js here)
  // -------------------------------------------------------------------------
  return {
    startRun,
    update,
    endRun,
    dispose,
    getLevel: () => level,
    getPlayer: () => player,
    getParams: () => currentParams,
    getCubeSpeed: () => lastCubeSpeed,
    isDigesting: () => digestTimer > 0,
    isRespawnGrace: () => respawnGrace > 0,
    getRecoveredCoinCount: () => recoveredCoins,
  };
}
