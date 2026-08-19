/**
 * WS-B — renderer, camera and lighting.
 *
 * The camera fit is the load-bearing piece here: screen wrap only reads if the
 * whole 28x31 board is always inside the frustum, on any phone/desktop aspect
 * ratio, with the board pitched CAMERA_PITCH_DEG off straight-down.
 *
 * See the derivation in fitCameraDistance() below — it solves the exact
 * distance (not a fudge factor) at which a pitched perspective camera's
 * frustum covers the maze rectangle plus margin.
 */
import * as THREE from 'three';
import { COLS, ROWS, CAMERA_PITCH_DEG, CAMERA_MARGIN_TILES, PALETTE } from '../config.js';

const FOV_DEG = 50;
const SHAKE_DURATION = 0.3;

/**
 * Solve camera distance R from the maze-center target such that a
 * PerspectiveCamera with vertical half-fov `halfFovV`, pitched `theta`
 * radians off straight-down and positioned at
 * (0, R*cos(theta), R*sin(theta)), sees the whole [-halfW,halfW] x
 * [-halfH,halfH] ground rectangle.
 *
 * Derivation: a camera ray at angle `alpha` from straight-down hits the
 * ground plane y=0 at world Z = R*sin(theta) - R*cos(theta)*tan(alpha).
 * Substituting the frustum's top/bottom rays (alpha = theta +/- halfFovV)
 * and simplifying with the angle-difference identity gives clean closed
 * forms for the near/far edges of the visible ground strip:
 *
 *   Z_near(R) =  R * sin(halfFovV) / cos(theta - halfFovV)
 *   Z_far(R)  = -R * sin(halfFovV) / cos(theta + halfFovV)
 *
 * Requiring Z_near >= halfH and -Z_far >= halfH gives the two Z-fit
 * distances below. The X-fit uses the frustum's narrowest point, which
 * (for theta < halfFovV, true for our small pitch) is the ray straight
 * below the camera, where the horizontal half-width is
 * R*cos(theta)*tan(halfFovV)*aspect.
 */
function fitCameraDistance(halfW, halfH, theta, halfFovV, aspect) {
  const rZNear = (halfH * Math.cos(theta - halfFovV)) / Math.sin(halfFovV);
  const rZFar = (halfH * Math.cos(theta + halfFovV)) / Math.sin(halfFovV);
  const rX = halfW / (Math.cos(theta) * Math.tan(halfFovV) * aspect);
  return Math.max(rZNear, rZFar, rX);
}

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.fog);
  scene.fog = new THREE.Fog(PALETTE.fog, 10, 60);

  const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.5, 200);
  const basePos = new THREE.Vector3();
  const theta = THREE.MathUtils.degToRad(CAMERA_PITCH_DEG);
  const halfFovV = THREE.MathUtils.degToRad(FOV_DEG / 2);

  // Cheap moody lighting: a dim sky/ground fill plus one directional light
  // for wall-side definition. Torches own the real point lights.
  const hemi = new THREE.HemisphereLight(0x9fb4ff, 0x3a2e46, 2.3);
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
  sun.position.set(-6, 14, 8);
  scene.add(hemi, sun);

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const aspect = w / Math.max(1, h);
    camera.aspect = aspect;

    const halfW = COLS / 2 + CAMERA_MARGIN_TILES;
    const halfH = ROWS / 2 + CAMERA_MARGIN_TILES;
    // Tiny safety epsilon: keeps the fit from clipping the board edge to
    // floating-point rounding at extreme aspect ratios.
    const R = fitCameraDistance(halfW, halfH, theta, halfFovV, aspect) * 1.01;

    basePos.set(0, R * Math.cos(theta), R * Math.sin(theta));
    camera.position.copy(basePos);
    camera.lookAt(0, 0, 0);
    camera.near = Math.max(0.5, R * 0.05);
    camera.far = R * 3 + 40;
    camera.updateProjectionMatrix();

    scene.fog.near = R * 0.9;
    scene.fog.far = R * 2.4;

    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
  }
  resize();

  // Shake state: decaying jitter applied on top of basePos, no per-frame
  // allocation (reuses a single scratch vector).
  let shakeTime = 0;
  let shakeMag = 0;
  const jitter = new THREE.Vector3();

  function shake(amount) {
    shakeMag = Math.max(shakeMag, amount);
    shakeTime = SHAKE_DURATION;
  }

  function update(dt) {
    if (shakeTime <= 0) return;
    shakeTime = Math.max(0, shakeTime - dt);
    const falloff = shakeTime / SHAKE_DURATION;
    const s = shakeMag * falloff;
    jitter.set(
      (Math.random() - 0.5) * s,
      (Math.random() - 0.5) * s * 0.6,
      (Math.random() - 0.5) * s,
    );
    camera.position.copy(basePos).add(jitter);
    camera.lookAt(0, 0, 0);
    if (shakeTime <= 0) {
      shakeMag = 0;
      camera.position.copy(basePos);
      camera.lookAt(0, 0, 0);
    }
  }

  function render() {
    renderer.render(scene, camera);
  }

  function dispose() {
    renderer.dispose();
  }

  return { renderer, scene, camera, resize, render, shake, update, dispose };
}
