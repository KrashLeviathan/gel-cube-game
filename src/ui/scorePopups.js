/**
 * Floating "+120" / "-40" score indicators: spawn at a world position, drift
 * up a little, fade out. A pooled set of plain DOM nodes projected from world
 * space each frame — text stays crisp (unlike a canvas-texture sprite) and the
 * pool (a handful of concurrent popups, tops) is cheap to project every RAF.
 */
import * as THREE from 'three';

const POOL_SIZE = 16;
const LIFETIME = 1.1; // seconds
const RISE = 0.9; // world units drifted upward over the popup's life
const SPAWN_Y = 1.0; // world Y the popup starts at, above the entity

const REDUCE_MOTION =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function createScorePopups(root, canvas) {
  const el = document.createElement('div');
  el.className = 'score-popups';
  root.appendChild(el);

  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const node = document.createElement('div');
    node.className = 'score-popup';
    node.style.display = 'none';
    el.appendChild(node);
    pool.push({ node, life: -1, x: 0, y: 0, z: 0 });
  }
  let cursor = 0;

  function spawn({ amount, x, z }) {
    if (!amount) return;
    const item = pool[cursor];
    cursor = (cursor + 1) % pool.length;
    item.life = LIFETIME;
    item.x = x;
    item.y = SPAWN_Y;
    item.z = z;
    const positive = amount > 0;
    item.node.textContent = `${positive ? '+' : '−'}${Math.abs(Math.round(amount)).toLocaleString()}`;
    item.node.classList.toggle('is-positive', positive);
    item.node.classList.toggle('is-negative', !positive);
  }

  // Reused every frame — no per-popup allocation.
  const proj = new THREE.Vector3();

  function update(dt, camera) {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    for (const item of pool) {
      if (item.life < 0) continue;
      item.life -= dt;
      if (item.life <= 0) {
        item.life = -1;
        item.node.style.display = 'none';
        continue;
      }
      const t = 1 - item.life / LIFETIME; // 0 (spawn) -> 1 (expired)
      proj.set(item.x, item.y + (REDUCE_MOTION ? 0 : t * RISE), item.z).project(camera);
      if (proj.z > 1) {
        item.node.style.display = 'none';
        continue;
      }
      const sx = (proj.x * 0.5 + 0.5) * w;
      const sy = (1 - (proj.y * 0.5 + 0.5)) * h;
      const fadeIn = Math.min(1, t * 8);
      const fadeOut = Math.min(1, item.life / 0.35);
      item.node.style.display = 'block';
      item.node.style.opacity = String(Math.min(fadeIn, fadeOut));
      item.node.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
    }
  }

  function reset() {
    for (const item of pool) {
      item.life = -1;
      item.node.style.display = 'none';
    }
  }

  function dispose() {
    el.remove();
  }

  return { spawn, update, reset, dispose };
}
