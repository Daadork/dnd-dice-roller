// main.js — module
import * as THREE from 'three';
import { GLTFLoader } from 'https://unpkg.com/three@0.152.2/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://unpkg.com/three@0.152.2/examples/jsm/controls/OrbitControls.js';
import * as CANNON from 'cannon-es';

// Minimal contract:
// - Inputs: user click/drag to throw a die.
// - Outputs: rendered scene with dice rolling on the stage, physics-driven.
// - Error modes: missing `scene.glb` or `dice.glb` logged to console.

// Globals
let scene, camera, renderer, controls;
let dirLight; // directional light reference so we can adjust shadow camera after stage load
const clock = new THREE.Clock();

// Physics world
const world = new CANNON.World();
world.gravity.set(0, -9.82, 0);
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 20; // more iterations for stability
world.solver.tolerance = 0.001;

// default material and contact settings
const defaultMaterial = new CANNON.Material('default');
const defaultContact = new CANNON.ContactMaterial(defaultMaterial, defaultMaterial, {
  friction: 0.4,
  restitution: 0.25,
  contactEquationStiffness: 1e8,
  contactEquationRelaxation: 3
});
world.defaultContactMaterial = defaultContact;
world.addContactMaterial(defaultContact);

// Keep arrays for multiple dice
const diceObjects = []; // { mesh, body }

// Stage info
let stageTopY = 0;
// Increase the stage scale so the scene.glb appears larger as requested
const STAGE_SCALE = 4.0; // multiply the loaded scene to make it bigger

const loader = new GLTFLoader();
let diceTemplate = null;

// UI
const resultEl = document.getElementById('result');
const hintEl = document.getElementById('hint');
let rollBtn = document.getElementById('roll');
// clear the default '?' shown in the result element
if (resultEl) resultEl.textContent = '';

// Init Three
function initThree() {
  scene = new THREE.Scene();
  // Use a transparent scene background so the CSS gradient shows through the canvas
  scene.background = null;

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 400);
  // Position camera to match the provided screenshot: close and looking down at the stage
  camera.position.set(0, 12, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Make sure the GL canvas is cleared with transparent background so CSS gradient is visible
  renderer.setClearColor(0x000000, 0);
  document.body.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 3;
  controls.maxDistance = 40;

  

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(10, 30, 10);
  dirLight.castShadow = true;
  // increase shadow map resolution for large stages
  dirLight.shadow.mapSize.set(4096, 4096);
  // small bias and a bit of normalBias to reduce shadow acne and artifacts
  dirLight.shadow.bias = -0.0005;
  dirLight.shadow.normalBias = 0.03;
  // soften shadow edges a little
  dirLight.shadow.radius = 4;
  // default orthographic camera extent (will be adjusted after stage loads)
  const d = 50;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  dirLight.shadow.camera.far = 300;
  scene.add(dirLight);

  window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Load scene.glb and create static physics bodies
function loadStage() {
  loader.load('./scene.glb', (gltf) => {
    const root = gltf.scene;
    // scale the stage up so it's larger in the scene
    try { root.scale.setScalar(STAGE_SCALE); } catch (e) { /* ignore */ }

    root.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    scene.add(root);

    // ensure transforms are applied before computing bbox / building collision
    root.updateMatrixWorld(true);

    // compute stage top Y to spawn dice above it
    try {
      const bb = new THREE.Box3().setFromObject(root);
      stageTopY = bb.max.y || 0;
    } catch (err) {
      stageTopY = 0;
    }

    console.log('Stage top Y:', stageTopY, ' (scale:', STAGE_SCALE, ')');

    // After computing stage bounds, adjust directional light shadow camera to cover the stage
    try {
      const bbox = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      bbox.getSize(size);
      bbox.getCenter(center);
      // make the shadow camera cover the whole stage (some margin)
      const margin = Math.max(size.x, size.z) * 1.5;
      if (dirLight && dirLight.shadow && dirLight.shadow.camera) {
        dirLight.shadow.camera.left = -margin;
        dirLight.shadow.camera.right = margin;
        dirLight.shadow.camera.top = margin;
        dirLight.shadow.camera.bottom = -margin;
        dirLight.shadow.camera.far = Math.max(300, size.y * 4 + 200);
        dirLight.shadow.camera.updateProjectionMatrix();
        // position the directional light to look at the center of the stage
        dirLight.target.position.copy(center);
        scene.add(dirLight.target);
      }
    } catch (e) {
      console.warn('Could not adjust shadow camera:', e);
    }

    // Fallback: add a static plane at stageTopY to guarantee collision (helps when Trimesh fails)
    try {
      const groundBody = new CANNON.Body({ mass: 0, material: defaultMaterial });
      const groundShape = new CANNON.Plane();
      groundBody.addShape(groundShape);
      // rotate plane so it's horizontal (normal +Y)
      groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      groundBody.position.set(0, stageTopY, 0);
      world.addBody(groundBody);
    } catch (e) {
      console.warn('Could not add fallback ground plane:', e);
    }

    // Create static bodies for meshes
    const bodies = [];
    root.updateMatrixWorld(true);
      root.traverse((mesh) => {
        if (!mesh.isMesh || !mesh.geometry) return;
        // Convert geometry to non-indexed buffer and extract positions
        let geom = mesh.geometry.clone();
        if (geom.index) geom = geom.toNonIndexed();
        const posAttr = geom.attributes.position;
        if (!posAttr) return;
        const vertices = Array.from(posAttr.array);

        // Indices are sequential for non-indexed geometry (each 3 vertices = 1 triangle)
        const indices = [];
        const vertexCount = vertices.length / 3;
        for (let i = 0; i < vertexCount; i += 3) {
          indices.push(i, i + 1, i + 2);
        }

        // Transform vertices by mesh world matrix
        const m = mesh.matrixWorld;
        const v = new THREE.Vector3();
        for (let i = 0; i < vertices.length; i += 3) {
          v.set(vertices[i], vertices[i + 1], vertices[i + 2]);
          v.applyMatrix4(m);
          vertices[i] = v.x; vertices[i + 1] = v.y; vertices[i + 2] = v.z;
        }

        try {
          const shape = new CANNON.Trimesh(vertices, indices);
          const body = new CANNON.Body({ mass: 0, material: defaultMaterial });
          body.addShape(shape);
          world.addBody(body);
          bodies.push(body);
        } catch (err) {
          console.warn('Could not create Trimesh for a mesh, skipping physics for that mesh.', err);
        }
      });
    console.log('Stage loaded and static bodies created');
  }, undefined, (err) => console.error('Failed to load scene.glb', err));
}

// Load dice template once
function loadDiceTemplate() {
  loader.load('./dice.glb', (gltf) => {
    diceTemplate = gltf.scene;
    diceTemplate.traverse((c) => {
      if (c.isMesh) {
      }
    });
    // For stability, we will use a simple box collider for dice (works reliably for cubic dice)
    diceTemplate.userData = diceTemplate.userData || {};
    diceTemplate.userData.useBoxCollider = true;
    // compute and store template size/halfHeight so we can spawn exactly above the stage
    try {
      const tmpBox = new THREE.Box3().setFromObject(diceTemplate);
      const tmpSize = new THREE.Vector3();
      tmpBox.getSize(tmpSize);
      diceTemplate.userData.size = tmpSize;
      diceTemplate.userData.halfHeight = tmpSize.y / 2;
      console.log('Dice template size:', tmpSize.toArray());
    } catch (e) {
      // fallback
      diceTemplate.userData.halfHeight = diceTemplate.userData.halfHeight || 0.5;
    }
    console.log('Dice template loaded');
  }, undefined, (err) => console.error('Failed to load dice.glb', err));
}

// Create a new die instance (mesh + body) and add to scene/world
function spawnDie(position, quaternion, velocity) {
  if (!diceTemplate) {
    console.warn('dice template not loaded yet');
    return null;
  }
  console.log('Spawning die at', position.toArray(), 'velocity', velocity ? velocity.toArray() : null, 'convexShape?', !!diceTemplate.userData?.convex);
  // Clone mesh
  const mesh = diceTemplate.clone(true);
  mesh.position.copy(position);
  mesh.quaternion.copy(quaternion);
  scene.add(mesh);

  // Approximate shape by box using bounding box of template
  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  box.getSize(size);
  const halfExtents = new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2);
  // Use a box collider for dice — stable and sufficient for cubic dice
  const body = new CANNON.Body({ mass: 0.3 });
  const shape = new CANNON.Box(halfExtents);
  body.addShape(shape);
  body.material = defaultMaterial;
  // Ensure body spawns above the stage to avoid initial intersection
  const halfHeight = halfExtents.y;

  // Find highest nearby die (within horizontal radius) so new die doesn't spawn intersecting or perfectly on top
  const horizRadius = Math.max(size.x, size.z) * 0.9;
  let highestTop = stageTopY; // baseline is the stage top
  for (const d of diceObjects) {
    try {
      const dx = d.mesh.position.x - position.x;
      const dz = d.mesh.position.z - position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const otherHalf = d.halfHeight || (d.mesh.geometry ? (new THREE.Box3().setFromObject(d.mesh).getSize(new THREE.Vector3()).y / 2) : 0.5);
      const otherTop = d.mesh.position.y + otherHalf;
      if (dist < horizRadius && otherTop > highestTop) highestTop = otherTop;
    } catch (e) {
      // ignore
    }
  }

  const minSafeY = highestTop + halfHeight + 0.02;
  if (position.y < minSafeY) position.y = minSafeY;
  body.position.set(position.x, position.y, position.z);
  body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  if (velocity) body.velocity.set(velocity.x, velocity.y, velocity.z);
  body.linearDamping = 0.08;
  body.angularDamping = 0.07;
  body.angularVelocity.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.2;
  body.sleepTimeLimit = 1;
  world.addBody(body);

  // Immediately run a few small physics sub-steps to settle contacts and avoid tunneling
  try {
    for (let i = 0; i < 6; i++) world.step(1 / 120, 1 / 120, 1);
  } catch (err) {
    // ignore if stepping fails during load
  }

  // Ensure body is not spawned intersecting the stage: if it's below stageTopY + halfHeight, lift it
  try {
    const minSafeY = stageTopY + Math.max(halfExtents.x, halfExtents.y, halfExtents.z) + 0.05;
    if (body.position.y < minSafeY) {
      body.position.y = minSafeY;
      mesh.position.y = minSafeY;
    }
  } catch (err) {
    // ignore
  }

  diceObjects.push({ mesh, body, born: performance.now(), halfHeight });
  // Cleanup after some time to avoid performance issues
  setTimeout(() => {
    // remove after 90s
    const idx = diceObjects.findIndex(d => d.body === body);
    if (idx >= 0) {
      world.removeBody(body);
      scene.remove(diceObjects[idx].mesh);
      diceObjects.splice(idx, 1);
    }
  }, 90_000);

  return { mesh, body };
}

// Convert screen coords to a point in world in front of camera
function screenToWorld(x, y, distance = 2.5) {
  const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  const vec = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(camera);
  const dir = vec.sub(camera.position).normalize();
  return { point: camera.position.clone().add(dir.multiplyScalar(distance)), dir };
}

// Project a screen point (or center) to the horizontal plane at given world Y.
function screenToWorldAtY(x, y, planeY) {
  const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  const vec = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(camera);
  const dir = vec.sub(camera.position).normalize();
  // if the ray is nearly parallel to the plane, fall back to a fixed distance
  if (Math.abs(dir.y) < 1e-4) {
    return { point: camera.position.clone().add(dir.multiplyScalar(3.0)), dir };
  }
  const t = (planeY - camera.position.y) / dir.y;
  // if intersection is behind the camera, fall back
  if (t <= 0) return { point: camera.position.clone().add(dir.multiplyScalar(3.0)), dir };
  const point = camera.position.clone().add(dir.multiplyScalar(t));
  return { point, dir };
}

// Helper: remove all existing dice (used when spawning a new single die)
function clearAllDice() {
  while (diceObjects.length) {
    const d = diceObjects.pop();
    try { world.removeBody(d.body); } catch (e) { /* ignore */ }
    try { scene.remove(d.mesh); } catch (e) { /* ignore */ }
  }
}

// NOTE: Mouse/pointer spawning disabled — dice are launched only via the on-screen button.

// Quick roll button: spawn 1 die in front of camera
rollBtn = rollBtn || document.getElementById('roll');
if (rollBtn) {
  rollBtn.addEventListener('click', () => {
    if (!diceTemplate) {
      console.warn('Dice template not loaded yet — click ignored');
      return;
    }
    console.log('Roll button clicked');
    // remove any existing dice so only one is present at a time
    clearAllDice();
    // Compute X/Z by intersecting camera ray with the stage horizontal plane so the die spawns over the stage
    const planeY = (stageTopY || 0);
    const { point, dir } = screenToWorldAtY(window.innerWidth / 2, window.innerHeight / 2, planeY);
    // place above stageTopY to avoid spawning inside geometry
  const dieHalf = (diceTemplate && diceTemplate.userData && diceTemplate.userData.halfHeight) ? diceTemplate.userData.halfHeight : 0.6;
  // Raise the spawn much higher: make the die hover well above the plane (3x half-height)
  const spawnMargin = Math.max(1.5, dieHalf * 2.0);
  const dropY = planeY + dieHalf + spawnMargin;
    const pos = new THREE.Vector3(point.x, dropY, point.z);
    // Give a small random horizontal jitter instead of a strong forward launch, so the die falls and rolls
    const jitter = 0.4;
    const vel = new THREE.Vector3((Math.random() - 0.5) * jitter, 0, (Math.random() - 0.5) * jitter);
    spawnDie(pos, new THREE.Quaternion(), vel);
  });
} else {
  console.warn('Roll button not found — cannot attach click handler');
}

// keyboard R to clear dice
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'r') {
    // remove all dice
    while (diceObjects.length) {
      const d = diceObjects.pop();
      world.removeBody(d.body);
      scene.remove(d.mesh);
    }
  }
});

// Sync meshes to bodies
function syncAll() {
  for (const d of diceObjects) {
    d.mesh.position.copy(d.body.position);
    d.mesh.quaternion.copy(d.body.quaternion);
  }
}

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.02, clock.getDelta());
  // allow more substeps for stability (helps prevent fast bodies tunneling)
  world.step(1 / 60, dt, 10);
  syncAll();
  controls.update();
  renderer.render(scene, camera);
}

// Boot
initThree();
loadStage();
loadDiceTemplate();
animate();
// ensure the roll button is visible and focusable
if (rollBtn) rollBtn.tabIndex = 0;
