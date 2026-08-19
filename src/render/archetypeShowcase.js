/**
 * "Meet the party" — a small, self-contained live diorama of the four
 * adventurer archetypes for the How to Play overlay. Built off the same
 * survey that led to the difficulty-gated colors/halo in adventurerMesh.js:
 * putting all four side by side made it obvious a player never otherwise
 * sees "fighter / rogue / wizard / cleric" spelled out as four distinct
 * things.
 *
 * Deliberately its own tiny renderer/scene/camera rather than reusing the
 * game's `sceneCtx` — this mounts and unmounts with the overlay (see
 * screens.js's setHowtoOpen), on a plain <canvas> that isn't part of the
 * gameplay canvas at all, and has no reason to share GL state with a scene
 * that may not even exist yet (Home screen, before any run has started).
 *
 * Camera is a closer, more tilted "presentation" angle than the real
 * CAMERA_PITCH_DEG=12 gameplay pitch, for the same reason the adventurer
 * legibility study used one: at this range 12° shows mostly hat-tops.
 */
import * as THREE from 'three';
import { PALETTE } from '../config.js';
import { buildAdventurerMesh } from './adventurerMesh.js';

const ARCHETYPE_ORDER = ['fighter', 'rogue', 'wizard', 'cleric'];
const SPACING = [-1.4, -0.47, 0.47, 1.4];
const PRESENTATION_PITCH_DEG = 35;
const PRESENTATION_DIST = 3.2;
const FOV_DEG = 50;

export function mountArchetypeShowcase(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.fog);
  scene.fog = new THREE.Fog(PALETTE.fog, 4, 14);

  const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.05, 50);
  const theta = THREE.MathUtils.degToRad(PRESENTATION_PITCH_DEG);
  camera.position.set(0, PRESENTATION_DIST * Math.cos(theta), PRESENTATION_DIST * Math.sin(theta));
  camera.lookAt(0, 0.5, 0);

  const hemi = new THREE.HemisphereLight(0x9fb4ff, 0x3a2e46, 2.3);
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
  sun.position.set(-6, 14, 8);
  scene.add(hemi, sun);

  const floorGeo = new THREE.PlaneGeometry(6, 3);
  floorGeo.rotateX(-Math.PI / 2);
  const floorMat = new THREE.MeshStandardMaterial({
    color: PALETTE.floor,
    roughness: 0.96,
    metalness: 0,
  });
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  scene.add(floorMesh);

  const views = ARCHETYPE_ORDER.map((archetype, i) => {
    const view = buildAdventurerMesh(scene, archetype, { colorTier: 'baseline', haloMode: 'none' });
    view.group.position.set(SPACING[i], 0, 0.1);
    return view;
  });

  function resize() {
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 150;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
  }
  resize();
  window.addEventListener('resize', resize);

  let rafId = 0;
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const view of views) {
      view.update(dt, { moving: false, state: 'collect', packFullness: 0 });
    }
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  function dispose() {
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', resize);
    for (const view of views) view.dispose();
    floorGeo.dispose();
    floorMat.dispose();
    renderer.dispose();
  }

  return { dispose };
}
