/**
 * WS-C — pooled particle bursts: engulf spray, splashes, pickup sparkle.
 * See docs/SPEC.md §5. All pools are preallocated InstancedMeshes with plain
 * typed arrays driving per-particle physics; update() never allocates.
 */
import * as THREE from 'three';

const GRAVITY = -2.6;

function fadeMaterial(opts) {
  // Deliberately no `vertexColors: true` here: these pools tint via
  // InstancedMesh.instanceColor, which three.js wires up automatically
  // (USE_INSTANCING_COLOR) without requiring a per-vertex `color` geometry
  // attribute. Forcing `vertexColors` on would make the shader read a
  // nonexistent `color` attribute and multiply everything to black.
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    ...opts,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `attribute float aAlpha;\nvarying float vAlpha;\n#include <common>`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvAlpha = aAlpha;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `varying float vAlpha;\n#include <common>`)
      .replace('#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.a *= vAlpha;`);
  };
  return material;
}

/** A pool of `count` instances of one geometry, with position/velocity/life physics. */
function makePool(scene, geometry, material, count) {
  const alphaArr = new Float32Array(count);
  const alphaAttr = new THREE.InstancedBufferAttribute(alphaArr, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aAlpha', alphaAttr);

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // instanceMatrix starts zero-filled, not identity — give every slot a
  // valid zero-scale transform up front so unused instances render nothing
  // instead of a degenerate zero matrix.
  const initDummy = new THREE.Object3D();
  initDummy.scale.setScalar(0);
  initDummy.updateMatrix();
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, initDummy.matrix);
  mesh.instanceMatrix.needsUpdate = true;

  return {
    mesh,
    alphaArr,
    alphaAttr,
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    z: new Float32Array(count),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    vz: new Float32Array(count),
    scale: new Float32Array(count),
    life: new Float32Array(count).fill(-1),
    maxLife: new Float32Array(count),
    gravity: new Float32Array(count),
    spin: new Float32Array(count),
    rot: new Float32Array(count),
    grow: new Float32Array(count), // per-second scale growth (used by rings)
    cursor: 0,
  };
}

function spawnInto(pool, { x, y, z, vx, vy, vz, life, scale, color, gravity = GRAVITY, spin = 0, grow = 0 }) {
  const i = pool.cursor;
  pool.cursor = (pool.cursor + 1) % pool.count;
  pool.x[i] = x;
  pool.y[i] = y;
  pool.z[i] = z;
  pool.vx[i] = vx;
  pool.vy[i] = vy;
  pool.vz[i] = vz;
  pool.life[i] = life;
  pool.maxLife[i] = life;
  pool.scale[i] = scale;
  pool.gravity[i] = gravity;
  pool.spin[i] = spin;
  pool.rot[i] = Math.random() * Math.PI * 2;
  pool.grow[i] = grow;
  if (color) {
    pool.mesh.setColorAt(i, color);
    pool.mesh.instanceColor.needsUpdate = true;
  }
}

const _dummy = new THREE.Object3D();

function stepPool(pool, dt) {
  for (let i = 0; i < pool.count; i++) {
    if (pool.life[i] <= 0) {
      if (pool.life[i] !== -1) {
        _dummy.position.set(0, -999, 0);
        _dummy.scale.setScalar(0);
        _dummy.updateMatrix();
        pool.mesh.setMatrixAt(i, _dummy.matrix);
        pool.alphaArr[i] = 0;
        pool.life[i] = -1;
      }
      continue;
    }
    pool.life[i] -= dt;
    pool.vy[i] += pool.gravity[i] * dt;
    pool.x[i] += pool.vx[i] * dt;
    pool.y[i] += pool.vy[i] * dt;
    pool.z[i] += pool.vz[i] * dt;
    if (pool.y[i] < 0) {
      pool.y[i] = 0;
      pool.vy[i] *= -0.25;
      pool.vx[i] *= 0.7;
      pool.vz[i] *= 0.7;
    }
    pool.rot[i] += pool.spin[i] * dt;
    const t = Math.max(0, pool.life[i] / pool.maxLife[i]);
    const s = pool.scale[i] * (1 + pool.grow[i] * (1 - t)) * Math.min(1, t * 4);
    _dummy.position.set(pool.x[i], pool.y[i], pool.z[i]);
    _dummy.rotation.set(pool.rot[i] * 0.6, pool.rot[i], pool.rot[i] * 0.4);
    _dummy.scale.setScalar(s);
    _dummy.updateMatrix();
    pool.mesh.setMatrixAt(i, _dummy.matrix);
    pool.alphaArr[i] = t;
  }
  pool.mesh.instanceMatrix.needsUpdate = true;
  pool.alphaAttr.needsUpdate = true;
}

function killPool(pool) {
  for (let i = 0; i < pool.count; i++) {
    pool.life[i] = 0;
  }
}

function disposePool(pool, scene) {
  scene.remove(pool.mesh);
  pool.mesh.geometry.dispose();
  pool.mesh.material.dispose();
}

export function createFx(scene) {
  const _color = new THREE.Color();

  const dropletGeo = new THREE.IcosahedronGeometry(0.05, 0);
  const dropletMat = fadeMaterial({ color: 0xffffff });
  const dropletPool = makePool(scene, dropletGeo, dropletMat, 90);

  const debrisGeo = new THREE.BoxGeometry(0.06, 0.06, 0.06);
  const debrisMat = fadeMaterial({ color: 0xffffff });
  const debrisPool = makePool(scene, debrisGeo, debrisMat, 40);

  const ringGeo = new THREE.RingGeometry(0.6, 0.85, 20);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = fadeMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const ringPool = makePool(scene, ringGeo, ringMat, 8);

  const moteGeo = new THREE.IcosahedronGeometry(0.045, 0);
  const moteMat = fadeMaterial({ color: 0xffffff });
  const motePool = makePool(scene, moteGeo, moteMat, 56);

  const pools = [dropletPool, debrisPool, ringPool, motePool];

  function dissolveBurst(x, z, color) {
    _color.set(color ?? 0xffffff);
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.8 + Math.random() * 1.6;
      spawnInto(dropletPool, {
        x,
        y: 0.15 + Math.random() * 0.1,
        z,
        vx: Math.cos(a) * speed,
        vy: 1.2 + Math.random() * 1.2,
        vz: Math.sin(a) * speed,
        life: 0.6 + Math.random() * 0.5,
        scale: 0.5 + Math.random() * 0.8,
        color: _color,
        spin: (Math.random() - 0.5) * 6,
      });
    }
    const boneColor = _color.clone().lerp(new THREE.Color(0xe9e3d2), 0.7);
    const goldColor = new THREE.Color(0xffcf4d);
    const nd = 8;
    for (let i = 0; i < nd; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.6 + Math.random() * 1.3;
      spawnInto(debrisPool, {
        x,
        y: 0.1,
        z,
        vx: Math.cos(a) * speed,
        vy: 0.9 + Math.random() * 1.0,
        vz: Math.sin(a) * speed,
        life: 0.9 + Math.random() * 0.6,
        scale: 0.4 + Math.random() * 0.5,
        color: i % 3 === 0 ? goldColor : boneColor,
        spin: (Math.random() - 0.5) * 10,
        gravity: GRAVITY * 1.1,
      });
    }
    spawnInto(ringPool, {
      x,
      y: 0.03,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0.45,
      scale: 0.18,
      color: _color,
      grow: 2.2,
      gravity: 0,
    });
  }

  function splash(x, z, color) {
    _color.set(color ?? 0xffffff);
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 1.0;
      spawnInto(dropletPool, {
        x,
        y: 0.1,
        z,
        vx: Math.cos(a) * speed,
        vy: 0.6 + Math.random() * 0.7,
        vz: Math.sin(a) * speed,
        life: 0.4 + Math.random() * 0.35,
        scale: 0.4 + Math.random() * 0.5,
        color: _color,
        spin: (Math.random() - 0.5) * 5,
      });
    }
    spawnInto(ringPool, {
      x,
      y: 0.03,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0.3,
      scale: 0.12,
      color: _color,
      grow: 1.4,
      gravity: 0,
    });
  }

  function sparkle(x, z, color) {
    _color.set(color ?? 0xfff2b0);
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.15;
      spawnInto(motePool, {
        x: x + Math.cos(a) * r,
        y: 0.1 + Math.random() * 0.1,
        z: z + Math.sin(a) * r,
        vx: (Math.random() - 0.5) * 0.3,
        vy: 0.7 + Math.random() * 0.9,
        vz: (Math.random() - 0.5) * 0.3,
        life: 0.7 + Math.random() * 0.6,
        scale: 0.4 + Math.random() * 0.6,
        color: _color,
        gravity: -0.3,
        spin: (Math.random() - 0.5) * 4,
      });
    }
  }

  function update(dt) {
    for (const p of pools) stepPool(p, dt);
  }

  function reset() {
    for (const p of pools) killPool(p);
    for (const p of pools) stepPool(p, 0);
  }

  function dispose() {
    for (const p of pools) disposePool(p, scene);
  }

  return { dissolveBurst, splash, sparkle, update, reset, dispose };
}
