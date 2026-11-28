import * as THREE from "three/webgpu";
import {
  pass, screenUV, saturation, mix, smoothstep, vec2, vec3, vec4,
  float, sin, fract, dot, length, time,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Water, createOceanFloor, PRESETS } from "threejs-water-free";
import { flattenColliders, resolveCoast } from "./world-collision.mjs";
import { mergeInputs, readGamepadInput } from "./gamepad-input.mjs";
import { createMaritimeWildlife } from "./maritime-wildlife.js";
import { createMaritimeFireflies } from "./maritime-fireflies.js";
import { createMaritimeAudio } from "./maritime-audio.js";
import { createStormFX } from "./storm-fx.js";

const CACHE_VERSION = "banner12";
const FLOOR = { size: 9000, segments: 288, deepDepth: 52, beachHeight: 6 };
// One grid covers the whole seabed. Warp it so cells are about a metre wide
// over the cove and skull island shelves, where clear water shows the bottom,
// and grow toward the edges where the deep is opaque anyway.
const FLOOR_FOCUS = { x: 170, z: 500, power: 2.4 };
const COVE = { x: 0, z: 520, radius: 150 };
const ISLAND = { x: 349, z: 501, radius: 90 };
// Fixed framing that matches the README banner (?look=banner). The ship starts
// in front-left of the island and cruises toward it under way, so bow foam,
// wake and the dolphin pod are live; the camera sits off its starboard quarter,
// low over the water, a little wider than the play camera.
const BANNER_SHOT = {
  ship: { x: 56, z: 425, yaw: 1.222 },
  cruise: 12,
  // the ship sails 65 m during the 5 s warm-up, so the camera sits ahead of
  // the start (negative back) to meet it there, between camera and island
  back: -23, side: 34, height: 12, fov: 55,
  aim: { x: 299, y: 10.5, z: -28 },
};
let worldData = null;
let worldColliders = [];

function bowDir(yaw) {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

function helmStep(state, input, dt) {
  let yawRate = state.yawRate || 0;
  let speed = state.speed || 0;
  const steer = Number.isFinite(input.steer)
    ? input.steer
    : (input.left ? 1 : 0) - (input.right ? 1 : 0);
  const throttle = Number.isFinite(input.throttle)
    ? input.throttle
    : (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  const thrust = Math.max(0, throttle) * 64 + Math.min(0, throttle) * 26;
  let blend = dt * 2.4;
  if (blend > 1) blend = 1;
  yawRate += (steer * 0.85 - yawRate) * blend;
  let sblend = dt * 1.15;
  if (sblend > 1) sblend = 1;
  speed += (thrust - speed) * sblend;
  const yaw = (state.yaw || 0) + yawRate * dt;
  const bow = bowDir(yaw);
  let x = (state.x || 0) + bow.x * speed * dt;
  let z = (state.z || 0) + bow.z * speed * dt;
  const coast = resolveCoast(x, z, worldColliders, 7);
  if (coast.collided) {
    x = coast.x;
    z = coast.z;
    // Head-on contact stops the hull; a glancing slide along the shore keeps
    // way on, so sailing around a big island never turns into an invisible wall.
    const tangent = Math.abs(bow.x * coast.nz - bow.z * coast.nx);
    speed *= 0.55 + 0.45 * tangent;
  }
  return { x, z, yaw, speed, yawRate, bow };
}

function bayPreset() {
  const p = JSON.parse(JSON.stringify(PRESETS.tropical));
  p.name = "Late Afternoon";
  // Sun low on the right of the banner framing. Library azimuth runs from +x
  // toward +z; the banner camera looks along about -9 deg with its right edge
  // at 31 deg, so 40 deg keeps the disc just outside the frame and pulls the
  // glitter path into the right third.
  p.sun = { elevation: 13, azimuth: 40, color: 0xffe8c4, intensity: 1.8 };
  p.sky = {
    zenithColor: 0x1a58b0,
    horizonColor: 0xd6e2ea,
    groundColor: 0x8fb0c4,
    rayleigh: 1.3,
    cloudCoverage: 0.42,
    cloudColor: 0xfff3e0,
    cloudSpeed: 0.012,
    exposure: 1.0,
  };
  // Ocean: tropical FFT base with one long, low swell and half the fine
  // ripples, which wove a visible grid at distance. The wide patch stops the
  // swell tiling across the 11 km water extent.
  p.ocean.cascades[0].patchSize = 760;
  p.ocean.cascades[1].waveHeight *= 0.5;
  const swell = (deg, wavelength, amplitude, steepness = 0.42, speed = 1) => {
    const a = (deg * Math.PI) / 180;
    return { direction: [Math.cos(a), Math.sin(a)], wavelength, amplitude, steepness, speed };
  };
  p.ocean.gerstner = [swell(38, 240, 0.35, 0.42, 0.9)];
  // Deep blue over a pale sand floor: turquoise where it is shallow.
  p.water = JSON.parse(JSON.stringify(PRESETS.tropical.water));
  p.water.crestFoam = 0.1;
  p.water.foamScale = 1.4;
  p.water.shoreFoamStrength = 1.0;
  p.water.shoreDepth = 2.2;
  p.water.waterColor = 0x0a3a6e;
  p.water.sssColor = 0x1fb8a6;
  p.water.sunShininess = 480;
  p.water.sssStrength = 0.5;
  p.floor = JSON.parse(JSON.stringify(PRESETS.lagoon.floor));
  // library default is 0.08: 12.5 m caustic cells read as a checkerboard
  // through clear water
  p.floor.causticScale = 0.7;
  p.floor.causticIntensity = 0.6;
  p.floor.causticColor = 0xeafff4;
  p.fog = { color: 0xbfd3e2, density: 0.00045 };
  return p;
}

function ellipse(x, z, cx, cz, rx, rz) {
  const u = (x - cx) / rx;
  const v = (z - cz) / rz;
  return Math.max(0, 1 - (u * u + v * v));
}

function floorHeightWorld(wx, wz, floorPos) {
  const x = wx - floorPos.x;
  const z = wz - floorPos.z;
  const fieldX = x + floorPos.x;
  const fieldZ = z + floorPos.z;
  const bar = ellipse(fieldX, fieldZ, COVE.x + 6, COVE.z + 20, 150, 42);
  const toe = ellipse(fieldX, fieldZ, COVE.x - 6, COVE.z - 22, 110, 40);
  const shoal = Math.max(toe * 0.9, bar);
  const dry = Math.pow(bar, 1.15);
  let y = -FLOOR.deepDepth + (FLOOR.deepDepth - 1.2) * Math.min(1, shoal * 1.05);
  y += dry * 3.1;
  const fieldFade = Math.max(0, 1 - Math.hypot(fieldX, fieldZ - 220) / (FLOOR.size * 0.55));
  y += Math.sin(fieldX * 0.0018 + fieldZ * 0.0011) * 2.2 * fieldFade;
  y += Math.sin(fieldZ * 0.006 - fieldX * 0.002) * 0.45 * fieldFade;
  for (const island of [...(worldData?.islands || []), ...(worldData?.backdrop || [])]) {
    const shelfX = island.landOffset ? island.x + island.landOffset[0] : island.x;
    const shelfZ = island.landOffset ? island.z + island.landOffset[1] : island.z;
    if (Math.abs(fieldX - shelfX) > island.shelfRadius + 80 ||
        Math.abs(fieldZ - shelfZ) > island.shelfRadius + 80) continue;
    const ir = Math.hypot(fieldX - shelfX, fieldZ - shelfZ);
    const t = Math.max(0, Math.min(1, (ir / island.shelfRadius - 0.55) / 0.45));
    const shelfWeight = 1 - t * t * (3 - 2 * t);
    // [seabed away from the shelf, rise over the shelf]. The skull island
    // drops to deep water sooner so the banner's foreground stays blue.
    const shelf = island.id === "skull-island" ? [-40, 35] : [-14, 9];
    y = Math.max(y, shelf[0] + shelf[1] * shelfWeight);
    for (const shoalBand of island.shoals || []) {
      const sx = fieldX - island.x - shoalBand.x;
      const sz = fieldZ - island.z - shoalBand.z;
      const q = (sx / shoalBand.rx) ** 2 + (sz / shoalBand.rz) ** 2;
      if (q < 1) y = Math.max(y, -4.8 + (1 - q) * 1.7);
    }
    if (island.id === "skull-island") {
      // turquoise bar hugging the coast: crest 118 m out, 20 m down by 180 m
      const ring = 1 - Math.abs(ir - 118) / 62;
      if (ring > 0) y = Math.max(y, -20 + ring * 16.2);
    }
  }
  return y;
}

function sculptCove(geometry) {
  const pos = geometry.attributes.position;
  const half = FLOOR.size / 2;
  const warp = (d) => Math.sign(d) * (Math.abs(d) / half) ** FLOOR_FOCUS.power * half;
  for (let i = 0; i < pos.count; i++) {
    const wx = warp(pos.getX(i) - FLOOR_FOCUS.x) + FLOOR_FOCUS.x;
    const wz = warp(pos.getZ(i) - FLOOR_FOCUS.z) + FLOOR_FOCUS.z;
    pos.setX(i, wx);
    pos.setZ(i, wz);
    pos.setY(i, floorHeightWorld(wx, wz, { x: 0, z: 0 }));
  }
  geometry.computeVertexNormals();
}

function failOver(err) {
  const msg = String((err && err.message) || err);
  window.__beach = { ready: false, error: msg, stack: err && err.stack };
  console.error(err);
  const spin = document.getElementById("loadingIndicator");
  if (spin) {
    spin.style.pointerEvents = "none";
    spin.innerHTML = `<p style="color:#c44;font:16px sans-serif;max-width:40em">${msg}</p>`;
  }
}

function loadEnv(scene, renderer, skyMesh) {
  // Bake the live procedural sky: the bundled dusk HDR tinted every daylight
  // surface teal, and the sky already matches the sun and clouds the water
  // reflects.
  const stage = new THREE.Scene();
  stage.add(skyMesh.clone());
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(stage, 0.04, 1, 10000);
  scene.environment = env.texture || env;
}

function makeChest() {
  const wood = new THREE.MeshStandardMaterial({
    color: 0x5a3a22, roughness: 0.72, metalness: 0.08, envMapIntensity: 0.55,
  });
  const band = new THREE.MeshStandardMaterial({
    color: 0x8a7420, roughness: 0.45, metalness: 0.65, envMapIntensity: 0.9,
  });
  const chest = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.85, 1.05), wood);
  box.castShadow = true;
  box.receiveShadow = true;
  box.position.y = 0.43;
  chest.add(box);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.22, 1.08), wood);
  lid.position.y = 0.95;
  lid.castShadow = true;
  chest.add(lid);
  [[-0.55, 0.43, 0], [0.55, 0.43, 0]].forEach((p) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 1.12), band);
    b.position.set(p[0], p[1], p[2]);
    b.castShadow = true;
    chest.add(b);
  });
  return chest;
}

function prepMesh(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    const mats = obj.material;
    if (!mats) return;
    (Array.isArray(mats) ? mats : [mats]).forEach((m) => {
      m.envMapIntensity = 1.2;
      m.side = THREE.DoubleSide;
    });
  });
}

const TRUNK_MAT = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 });
const LEAF_MAT = new THREE.MeshStandardMaterial({
  color: 0x1c6a2c, roughness: 0.78, side: THREE.DoubleSide, envMapIntensity: 0.45,
});

function palmTrunk() {
  const geo = new THREE.CylinderGeometry(0.16, 0.32, 6.8, 6);
  geo.translate(0, 3.3, 0);
  return geo;
}

// one drooping frond: flat at the root, tapering and falling away
function palmFrond(angle) {
  const geo = new THREE.PlaneGeometry(1.35, 5.2, 1, 7);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let v = 0; v < pos.count; v++) {
    const t = (pos.getZ(v) + 2.6) / 5.2;
    pos.setX(v, pos.getX(v) * (1 - t * 0.8));
    pos.setY(v, Math.sin(t * Math.PI) * 0.7 - t * t * 3.3);
  }
  geo.computeVertexNormals();
  geo.rotateY(angle);
  geo.translate(0, 6.45, 0);
  return geo;
}

function palmCrown() {
  return mergeGeometries(
    Array.from({ length: 9 }, (_, i) => palmFrond((i / 9) * Math.PI * 2))
  );
}

// Jungle for the skull island. The Blender pack script exports where the
// jungle material is (skull-plants.json); lumpy canopy clumps and palms are
// instanced from that table, so the scatter matches the terrain exactly and
// the whole jungle is three draw calls.
async function plantJungle(island) {
  const response = await fetch(`beach/skull-plants.json?v=${CACHE_VERSION}`);
  if (!response.ok) throw new Error("plant table HTTP " + response.status);
  const table = await response.json();
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();

  const clump = new THREE.IcosahedronGeometry(1, 2);
  const p = clump.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.78 + 0.44 * Math.abs(Math.sin(p.getX(i) * 7.1 + p.getY(i) * 5.3 + p.getZ(i) * 9.7));
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  clump.computeVertexNormals();
  const canopy = new THREE.InstancedMesh(
    clump,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, flatShading: true }),
    table.canopy.length
  );
  table.canopy.forEach(([x, y, z, s, spin], i) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, spin, 0);
    dummy.scale.set(s, s * 0.62, s);
    dummy.updateMatrix();
    canopy.setMatrixAt(i, dummy.matrix);
    canopy.setColorAt(i, tint.setHSL(0.29 + 0.03 * Math.sin(i * 12.99), 0.55, 0.045 + 0.05 * Math.abs(Math.sin(i * 78.23))));
  });
  island.add(canopy);

  const trunks = new THREE.InstancedMesh(palmTrunk(), TRUNK_MAT, table.palm.length);
  const crowns = new THREE.InstancedMesh(palmCrown(), LEAF_MAT, table.palm.length);
  table.palm.forEach(([x, y, z, s, spin], i) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, spin, 0);
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    crowns.setMatrixAt(i, dummy.matrix);
    crowns.setColorAt(i, tint.setScalar(0.8 + 0.4 * Math.abs(Math.sin(i * 39.3))));
  });
  island.add(trunks, crowns);
}

// Steep little rock islands (manifest kind "rock-islet"): the banner's hazy
// backdrop. One lumpy cone each, jungle green at the base and bare rock above
// through vertex colours on flat-shaded faces.
function makeRockIslet(islet) {
  const height = islet.radius * 1.3;
  const geo = new THREE.ConeGeometry(islet.radius * 0.55, height, 28, 8).toNonIndexed();
  geo.translate(0, height / 2 - 4, 0);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const jungle = new THREE.Color(0x2a5518);
  const rock = new THREE.Color(0x7a7066);
  const haze = new THREE.Color(0xbfd3e2);
  const tint = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const up = Math.min(0.98, Math.max(0, (y + 4) / height));   // 0 waterline, 1 summit
    // broad foot and a blunt spire instead of a pyramid, then crags
    const flare = (1 - 0.75 * up ** 0.8) / (0.55 * (1 - up));
    const k = flare * (1 + 0.3 * Math.sin(a * 3 + 1.3 + y * 0.03) + 0.18 * Math.sin(a * 7 + 0.4 - y * 0.05));
    pos.setXYZ(i, x * k, y, z * k);
    const t = Math.min(1, Math.max(0, (up - 0.2) / 0.22));
    // pre-hazed toward the fog colour so they sit back like the banner's
    tint.copy(jungle).lerp(rock, t).lerp(haze, 0.38);
    col[i * 3] = tint.r;
    col[i * 3 + 1] = tint.g;
    col[i * 3 + 2] = tint.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true })
  );
  mesh.position.set(islet.x, 0, islet.z);
  mesh.name = islet.id;
  return mesh;
}

async function boot() {
  const canvas = document.getElementById("view");
  canvas.tabIndex = 0;
  const hasGpu = !!navigator.gpu;
  let renderer;
  let backend = "webgl2";
  try {
    // Own the adapter/device request: three's internal fallback swallows the
    // real failure, and the GPU process can lose the first request on a cold
    // load. Retry here where the error is visible, then hand the device over.
    const makeGpu = (device) => new THREE.WebGPURenderer({ canvas, antialias: true, device });
    const makeGl = () => new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: true });
    let lastErr = null;
    if (hasGpu) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          if (!adapter) throw new Error("WebGPU adapter unavailable (attempt " + attempt + ")");
          // The wave slope textures are 32-bit float. Without this optional
          // feature WebGPU samples them nearest-neighbour, and every 3 m texel
          // becomes one flat facet: a checkerboard of sky reflections.
          const floatFilter = adapter.features.has("float32-filterable");
          const device = await adapter.requestDevice(
            floatFilter ? { requiredFeatures: ["float32-filterable"] } : undefined
          );
          renderer = makeGpu(device);
          await renderer.init();
          backend = renderer.backend?.isWebGPUBackend === true ? "webgpu" : "webgl2";
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          console.warn("webgpu init retry", attempt, err && err.message);
          try {
            if (renderer) renderer.dispose();
          } catch {}
          renderer = null;
          await new Promise((r) => setTimeout(r, 1600));
        }
      }
      if (lastErr) {
        console.warn("webgpu unavailable, falling back to webgl2", lastErr && lastErr.message);
      }
    }
    if (!renderer) {
      renderer = makeGl();
      await renderer.init();
      backend = renderer.backend?.isWebGPUBackend === true ? "webgpu" : "webgl2";
    }
  } catch (err) {
    failOver(err);
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;

  let worldResponse;
  try {
    worldResponse = await fetch(`beach/world.json?v=${CACHE_VERSION}`);
  } catch (err) {
    failOver(err);
    return;
  }
  if (!worldResponse.ok) throw new Error("world manifest HTTP " + worldResponse.status);
  worldData = await worldResponse.json();
  if (worldData.version !== 1 || !Array.isArray(worldData.islands) || worldData.islands.length < 7) {
    throw new Error("invalid archipelago manifest");
  }
    const skullData = worldData.islands.find((island) => island.id === "skull-island");
    if (!skullData) throw new Error("skull island missing from manifest");
    ISLAND.x = skullData.x;
    ISLAND.z = skullData.z;
    ISLAND.landX = skullData.x + (skullData.landOffset?.[0] || 0);
    ISLAND.landZ = skullData.z + (skullData.landOffset?.[1] || 0);
  // backdrop islets are scenery with collision and a seabed shelf, not
  // destinations
  worldColliders = flattenColliders([...worldData.islands, ...(worldData.backdrop || [])]);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd2e0ea);
  scene.fog = new THREE.FogExp2(0xbfd3e2, 0.00045);
  scene.environmentIntensity = 0.6;

  const lookQ = new URLSearchParams(window.location.search).get("look");
  if (lookQ) {
    window.__beachLook = /^(island|banner)$/.test(lookQ) ? lookQ : "destination:" + lookQ;
  }
  const camera = new THREE.PerspectiveCamera(
    window.__beachLook === "banner" ? BANNER_SHOT.fov : 50,
    window.innerWidth / window.innerHeight, 0.5, 12000
  );
  const water = new Water({
    preset: bayPreset(),
    quality: {
      simSize: hasGpu ? 256 : 128,
      segments: hasGpu ? 720 : 360,
      detail: hasGpu ? 0.3 : 0.2,
      sparkle: 0.35,
      refraction: true,
      foamDetail: true,
      clouds: true,
    },
    extent: 11000,
    lodPower: 2.2,
  });
  scene.add(water.object);

  const floor = createOceanFloor({
    ...FLOOR,
    shoreAxis: "z",
    timeNode: water.timeNode,
    preset: water.config.floor,
  });
  sculptCove(floor.mesh.geometry);
  scene.add(floor.mesh);

  const sunDir = water.skyUniforms.sunDirection.value.clone();
  const sun = new THREE.DirectionalLight(0xffe6c4, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 4;
  sun.shadow.camera.far = 260;
  sun.shadow.camera.left = -70;
  sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70;
  sun.shadow.camera.bottom = -70;
  sun.shadow.bias = -0.0003;
  sun.target = new THREE.Object3D();
  scene.add(sun);
  scene.add(sun.target);
  scene.add(new THREE.HemisphereLight(0xbcd6f0, 0x9a8a70, 0.45));
  // The banner lights the skull from the camera's upper-left while its sun
  // sits low on the right: the sun rims the rock, this key keeps the face
  // readable instead of a silhouette. No shadows, so the sun still owns them.
  const faceKey = new THREE.DirectionalLight(0xfff1dc, 0.9);
  faceKey.position.set(ISLAND.x - 260, 240, ISLAND.z - 60);
  faceKey.target.position.set(ISLAND.x, 70, ISLAND.z);
  scene.add(faceKey);
  scene.add(faceKey.target);

  try {
    loadEnv(scene, renderer, water.sky);
  } catch (err) {
    console.warn("environment", err);
  }

  const loader = new GLTFLoader();
  const chest = makeChest();
  const chestXZ = { x: 10, z: 528 };
  chest.position.set(chestXZ.x, floorHeightWorld(chestXZ.x, chestXZ.z, floor.mesh.position), chestXZ.z);
  chest.rotation.y = 0.4;
  scene.add(chest);

  function spitPalm(x, z, scale, yaw) {
    const g = new THREE.Group();
    const y = floorHeightWorld(x, z, floor.mesh.position);
    const trunk = new THREE.Mesh(palmTrunk(), TRUNK_MAT);
    trunk.rotation.z = 0.07;
    trunk.castShadow = true;
    g.add(trunk);
    const crown = new THREE.Mesh(palmCrown(), LEAF_MAT);
    crown.rotation.y = yaw;
    crown.castShadow = true;
    g.add(crown);
    g.scale.setScalar(scale);
    g.position.set(x, y - 0.15, z);
    scene.add(g);
  }
  spitPalm(-36, 552, 1.15, 0.5);
  spitPalm(-8, 558, 1.05, 1.4);
  spitPalm(28, 546, 0.95, 2.1);
  spitPalm(62, 540, 0.8, 0.8);

  let skullLoaded = false;
  let archipelagoLoaded = false;
  try {
      const islandGltf = await loader.loadAsync(`beach/skull-island.glb?v=${CACHE_VERSION}`);
    const island = islandGltf.scene;
    skullLoaded = true;
    prepMesh(island);
    island.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => {
        // double-sided: carved recess floors tilt away from high cameras
        // and FrontSide culling turned them into see-through holes
        m.side = THREE.DoubleSide;
        if (m.roughness !== undefined) {
          m.roughness = Math.max(0.72, Math.min(m.roughness || 0.8, 0.95));
          m.envMapIntensity = 0.25;
        }
      });
    });
    island.scale.setScalar(1);
    island.rotation.y = Math.PI / 2 + 0.22;
    island.position.set(0, 0, 0);
    island.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(island);
    const cx = (box.min.x + box.max.x) * 0.5;
    const cz = (box.min.z + box.max.z) * 0.5;
    const marker = island.getObjectByName("BEACH");
    const beachY = marker ? marker.getWorldPosition(new THREE.Vector3()).y : box.min.y + 6;
    island.position.set(ISLAND.x - cx, 0.45 - beachY, ISLAND.z - cz);
    ISLAND.radius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.46;
    window.__islandRoot = island;
    scene.add(island);
    await plantJungle(island);
  } catch (err) {
    console.warn("skull-island", err);
  }
  try {
      const archGltf = await loader.loadAsync(`beach/archipelago.glb?v=${CACHE_VERSION}`);
    const archipelago = archGltf.scene;
    prepMesh(archipelago);
    archipelago.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        mat.envMapIntensity = 0.18;
        mat.roughness = Math.max(mat.roughness || 0.8, 0.88);
      }
    });
    scene.add(archipelago);
    for (const islet of worldData.backdrop || []) scene.add(makeRockIslet(islet));
    archipelagoLoaded = true;
    window.__archipelagoRoot = archipelago;
  } catch (err) {
    console.warn("archipelago", err);
  }
  if (!skullLoaded || !archipelagoLoaded) {
    throw new Error(`world assets missing: skull=${skullLoaded}, archipelago=${archipelagoLoaded}`);
  }

  let shipRoot = null;
  let shipState = window.__beachLook === "banner"
    ? { x: BANNER_SHOT.ship.x, z: BANNER_SHOT.ship.z, yaw: BANNER_SHOT.ship.yaw, speed: BANNER_SHOT.cruise, yawRate: 0 }
    : { x: -20, z: 445, yaw: 1.42, speed: 0, yawRate: 0 };
  const keys = { forward: false, back: false, left: false, right: false };
  const orbit = { yaw: Math.PI * 0.96, pitch: 0.16, dist: 54, dragging: false, lx: 0, ly: 0 };
  const wakeGeometry = new THREE.RingGeometry(0.82, 1, 18);
  wakeGeometry.rotateX(-Math.PI / 2);
  const wakeMaterials = [];
  const wakeGroup = new THREE.Group();
  const wakeRings = [];
  for (let i = 0; i < 9; i++) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xd8e2df, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(wakeGeometry, material);
    wakeMaterials.push(material);
    ring.renderOrder = 2;
    wakeGroup.add(ring);
    wakeRings.push(ring);
  }
  scene.add(wakeGroup);
  const timer = new THREE.Timer();
  timer.connect(document);
  const freecam = { on: false, yaw: 0, pitch: 0.32, pos: new THREE.Vector3(), speed: 26 };
  let wildlife = null;
  let fireflies = null;
  let audio = null;
  let gamepadAudioAttempted = false;
  const gamepadState = { connected: false, id: "" };

  let pipeline = null;
  try {
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode("output");
    // Daylight: only the disc and glitter sit above 1.2, so bloom is a
    // highlight halo instead of a wash over the whole sky.
    const tight = bloom(color, 0.32, 0.2, 1.25);
    const wide = bloom(color, 0.1, 0.5, 1.7);
    let graded = color.rgb;
    graded = saturation(graded, 1.12);
    graded = graded.sub(0.5).mul(1.1).add(0.5);
    const vig = smoothstep(float(0.98), float(0.45), length(screenUV.sub(0.5)));
    graded = graded.mul(mix(float(0.86), float(1.0), vig));
    const grain = fract(sin(dot(screenUV, vec2(190.0, 260.0)).add(time)).mul(43758.5453));
    graded = graded.add(grain.sub(0.5).mul(0.004));
    pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = vec4(graded, 1.0).add(tight).add(wide);
  } catch (err) {
    console.warn("bloom", err);
    pipeline = null;
  }

  function fit() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", fit);

  function unlockAudio() {
    if (audio) void audio.unlock();
  }
  function setKey(e, down) {
    if (down) unlockAudio();
    const code = e.code || "";
    const key = (e.key || "").toLowerCase();
    if (code === "KeyW" || code === "ArrowUp" || key === "w") keys.forward = down;
    else if (code === "KeyS" || code === "ArrowDown" || key === "s") keys.back = down;
    else if (code === "KeyA" || code === "ArrowLeft" || key === "a") keys.left = down;
    else if (code === "KeyD" || code === "ArrowRight" || key === "d") keys.right = down;
    else if (code === "KeyC" && down) {
      freecam.on = !freecam.on;
      if (freecam.on) {
        freecam.pos.copy(camera.position);
        freecam.yaw = orbit.yaw + shipState.yaw + Math.PI;
        freecam.pitch = orbit.pitch;
      }
      return;
    }
    else return;
    if (down) e.preventDefault();
  }
  window.addEventListener("keydown", (e) => setKey(e, true), true);
  window.addEventListener("keyup", (e) => setKey(e, false), true);
  canvas.addEventListener("pointerdown", (e) => {
    unlockAudio();
    canvas.focus();
    orbit.dragging = true;
    orbit.lx = e.clientX;
    orbit.ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointerup", () => {
    orbit.dragging = false;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!orbit.dragging) return;
    const dx = e.clientX - orbit.lx;
    const dy = e.clientY - orbit.ly;
    orbit.lx = e.clientX;
    orbit.ly = e.clientY;
    if (freecam.on) {
      freecam.yaw -= dx * 0.005;
      freecam.pitch = Math.max(-1.2, Math.min(1.35, freecam.pitch + dy * 0.004));
    } else {
      orbit.yaw -= dx * 0.005;
      orbit.pitch = Math.max(0.06, Math.min(1.15, orbit.pitch + dy * 0.004));
    }
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (freecam.on) {
        freecam.speed = Math.max(4, Math.min(120, freecam.speed + e.deltaY * -0.06));
      } else {
        orbit.dist = Math.max(18, Math.min(220, orbit.dist + e.deltaY * 0.05));
      }
    },
    { passive: false }
  );

  function pollGamepad() {
    let pad = null;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      if (pads) {
        for (let i = 0; i < pads.length; i++) {
          if (pads[i]?.connected) { pad = pads[i]; break; }
        }
      }
    } catch {}
    const input = readGamepadInput(pad);
    gamepadState.connected = input.connected;
    gamepadState.id = input.id;
    const padActive = Math.abs(input.steer) > 0.06 || Math.abs(input.throttle) > 0.06 ||
      Math.abs(input.cameraX) > 0.06 || Math.abs(input.cameraY) > 0.06 || Math.abs(input.zoom) > 0.06;
    if (pad?.connected && padActive && !gamepadAudioAttempted && audio) {
      gamepadAudioAttempted = true;
      void audio.unlock();
    }
    return input;
  }
  window.addEventListener("gamepadconnected", (event) => {
    gamepadState.connected = true;
    gamepadState.id = event.gamepad?.id || "";
  });
  window.addEventListener("gamepaddisconnected", (event) => {
    if (!event.gamepad || event.gamepad.id === gamepadState.id) {
      gamepadState.connected = false;
      gamepadState.id = "";
    }
  });

  function placeCamera() {
    if (window.__beachLook === "banner") {
      const h = bowDir(BANNER_SHOT.ship.yaw);
      const px = BANNER_SHOT.ship.x - BANNER_SHOT.back * h.x - BANNER_SHOT.side * h.z;
      const pz = BANNER_SHOT.ship.z - BANNER_SHOT.back * h.z + BANNER_SHOT.side * h.x;
      camera.position.set(px, BANNER_SHOT.height, pz);
      camera.lookAt(
        px + BANNER_SHOT.aim.x,
        BANNER_SHOT.height + BANNER_SHOT.aim.y,
        pz + BANNER_SHOT.aim.z
      );
      return;
    }
    if (window.__beachLook === "island") {
      // sea-level 3/4 of the skull face: whole peak, beach and jungle line
      camera.position.set(ISLAND.x - 320, 75, ISLAND.z - 30);
      camera.lookAt(ISLAND.x, 68, ISLAND.z);
      return;
    }
    if (typeof window.__beachLook === "string" && window.__beachLook.startsWith("destination:")) {
      const destination = worldData.islands.find((item) => item.id === window.__beachLook.slice(12));
      if (destination) {
        // Islands range from ~120 m stacks to ~560 m headlands; pull the proof
        // camera back far enough to frame whichever one was asked for.
        const reach = Math.max(destination.shelfRadius || 0, destination.radius || 150) * 0.92;
        camera.position.set(destination.x - reach * 1.02, 30 + reach * 0.2, destination.z + reach * 0.95);
        camera.lookAt(destination.x, reach * 0.14, destination.z);
        return;
      }
    }
    if (freecam.on) {
      const look = new THREE.Vector3(
        Math.sin(freecam.yaw) * Math.cos(freecam.pitch),
        Math.sin(freecam.pitch),
        Math.cos(freecam.yaw) * Math.cos(freecam.pitch)
      );
      camera.position.copy(freecam.pos);
      camera.lookAt(freecam.pos.clone().add(look));
      return;
    }
    const y = shipRoot ? shipRoot.position.y : 0;
    const focus = new THREE.Vector3(shipState.x, y + 4.2, shipState.z);
    const cy = Math.sin(orbit.pitch) * orbit.dist + 3.2;
    const cr = Math.cos(orbit.pitch) * orbit.dist;
    camera.position.set(
      focus.x + Math.sin(orbit.yaw + shipState.yaw) * cr,
      cy + y,
      focus.z + Math.cos(orbit.yaw + shipState.yaw) * cr
    );
    camera.lookAt(focus);
  }

  function frame(timestamp) {
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.05);
    const elapsed = timer.getElapsed();
    const padInput = pollGamepad();
    const input = mergeInputs(keys, padInput);
    // banner shot: the ship holds cruising speed toward the island (the helm
    // reads the numeric throttle before the forward flag)
    if (window.__beachLook === "banner" && shipState.speed < BANNER_SHOT.cruise) input.throttle = 1;
    const cameraSpeed = dt * 1.45;
    orbit.yaw -= input.cameraX * cameraSpeed;
    orbit.pitch = Math.max(0.06, Math.min(1.15, orbit.pitch + input.cameraY * cameraSpeed));
    orbit.dist = Math.max(18, Math.min(220, orbit.dist + input.zoom * dt * 52));
    if (shipRoot) {
      shipState = helmStep(shipState, input, dt);
      const y = water.getHeight(shipState.x, shipState.z);
      const bow = bowDir(shipState.yaw);
      const yb = water.getHeight(shipState.x + bow.x * 8, shipState.z + bow.z * 8);
      const ys = water.getHeight(shipState.x - bow.x * 8, shipState.z - bow.z * 8);
      shipRoot.position.set(shipState.x, y, shipState.z);
      shipRoot.rotation.order = "YXZ";
      shipRoot.rotation.y = shipState.yaw;
      shipRoot.rotation.x = Math.atan2(yb - ys, 16) * 0.4;
      shipRoot.rotation.z = Math.sin(elapsed * 0.55) * 0.016;
      const sternX = shipState.x - bow.x * 13;
      const sternZ = shipState.z - bow.z * 13;
      const wakeY = water.getHeight(sternX, sternZ) + 0.14;
      wakeGroup.position.set(sternX, wakeY, sternZ);
      wakeGroup.rotation.y = shipState.yaw;
      const wakeStrength = Math.min(1, Math.abs(shipState.speed) / 32);
      wakeGroup.visible = wakeStrength > 0.04;
      for (let i = 0; i < wakeRings.length; i++) {
        const ring = wakeRings[i];
        const phase = (elapsed * 0.38 + i / wakeRings.length) % 1;
        const scale = 0.9 + phase * (4.8 + wakeStrength * 3.2);
        ring.position.set(Math.sin(i * 5.1) * 1.4, 0, -phase * (9 + wakeStrength * 12));
        ring.scale.set(scale, 1, scale);
        wakeMaterials[i].opacity = (1 - phase) * wakeStrength * 0.11;
      }
      sun.position.copy(shipRoot.position).addScaledVector(sunDir, 90);
      sun.target.position.copy(shipRoot.position);
      shipRoot.userData.speed = shipState.speed;
      shipRoot.userData.bow = bow;
    }
    if (freecam.on) {
      const look = new THREE.Vector3(
        Math.sin(freecam.yaw) * Math.cos(freecam.pitch),
        Math.sin(freecam.pitch),
        Math.cos(freecam.yaw) * Math.cos(freecam.pitch)
      );
      const right = new THREE.Vector3(-look.z, 0, look.x).normalize();
      const mv = new THREE.Vector3();
      if (input.forward) mv.add(look);
      if (input.back) mv.sub(look);
      if (input.left) mv.add(right);
      if (input.right) mv.sub(right);
      if (mv.lengthSq() > 0) {
        mv.normalize().multiplyScalar(freecam.speed * dt);
        freecam.pos.add(mv);
      }
      freecam.pos.y = Math.max(2.5, freecam.pos.y);
    }
    if (wildlife) wildlife.update(elapsed, shipState);
    if (fireflies) fireflies.update(elapsed);
    if (audio) audio.update(elapsed, { ...shipState, yaw: shipState.yaw }, wildlife?.audioEntities || []);
    if (stormFx) stormFx.update(elapsed, dt, camera, shipRoot);
    water.update(elapsed, camera);
    placeCamera();
    if (pipeline) pipeline.render();
    else renderer.render(scene, camera);
    const shipCameraDist = camera.position.distanceTo(new THREE.Vector3(shipState.x, shipRoot ? shipRoot.position.y : 0, shipState.z));
    window.__beach = {
      ready: !!shipRoot && skullLoaded && archipelagoLoaded && worldColliders.length >= 9,
      backend,
      worldLoaded: !!(skullLoaded && archipelagoLoaded && worldData),
      islandCount: worldData?.islands.length || 0,
      islands: worldData?.islands.map(({ id, name, x, z, kind }) => ({ id, name, x, z, kind })) || [],
      colliders: worldColliders.length,
      frameMs: dt * 1000,
      cameraDistance: shipCameraDist,
      version: CACHE_VERSION,
      wildlifeReady: !!wildlife,
      audioSupported: audio?.diagnostics.supported ?? false,
      x: shipState.x,
      z: shipState.z,
      yaw: shipState.yaw,
      speed: shipState.speed,
      keys: { ...keys },
      gamepad: { ...gamepadState, steer: input.steer, throttle: input.throttle },
      wildlife: wildlife?.stats || { total: 0 },
      fireflies: fireflies?.stats.total || 0,
      audio: audio?.diagnostics || { supported: false, unlocked: false },
      y: shipRoot ? shipRoot.position.y : 0,
      island: ISLAND,
      dw: renderer.domElement.width,
      dh: renderer.domElement.height,
    };
  }

  try {
    wildlife = createMaritimeWildlife(THREE, scene, worldData, (x, z) => water.getHeight(x, z));
  } catch (err) {
    console.warn("wildlife", err);
  }
  try {
    // Swarms live where dusk insects actually gather: the cove palms at spawn,
    // the Pine Crescent grove, and Crescent Key's sheltered lagoon.
    fireflies = createMaritimeFireflies(
      THREE, scene,
      [
        { x: 12, z: 548, radius: 80, count: 150, heightMin: 2, heightMax: 15 },
        { x: 1450, z: 1700, radius: 640, count: 260, heightMin: 8, heightMax: 64 },
        { x: 1750, z: -1250, radius: 280, count: 90, heightMin: 3, heightMax: 22 },
      ],
      (x, z) => water.getHeight(x, z)
    );
  } catch (err) {
    console.warn("fireflies", err);
  }
  try {
    audio = createMaritimeAudio();
  } catch (err) {
    console.warn("audio", err);
  }
  let stormFx = null;
  try {
    stormFx = createStormFX(THREE, scene, {
      heightAt: (x, z) => floorHeightWorld(x, z, floor.mesh.position),
      islands: worldData.islands,
      anchors: [{ x: 12, z: 548 }, { x: -30, z: 540 }],
      // daylight: the night layers stay off, bow spray and beach props stay on
      rain: false, mist: false, glows: false, torches: false, lanternLights: false,
    });
  } catch (err) {
    console.warn("storm-fx", err);
  }
  try {
    const gltf = await loader.loadAsync("beach/dutch-ship.glb");
    const root = gltf.scene.getObjectByName("SHIP") || gltf.scene;
    prepMesh(root);
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => {
        const tag = obj.name + (m.name || "");
        if (m.roughness !== undefined && /sail/i.test(tag)) {
          m.roughness = Math.min(0.92, (m.roughness || 0.7) + 0.08);
          m.metalness = 0;
        }
        if (/hull/i.test(tag) && m.roughness !== undefined) {
          m.roughness = Math.max(0.62, m.roughness);
        }
      });
    });
    scene.add(root);
    shipRoot = root;
    if (stormFx) stormFx.attachShip(root);
    const spin = document.getElementById("loadingIndicator");
    if (spin) spin.style.display = "none";
    canvas.focus();
  } catch (err) {
    failOver(err);
    return;
  }

  fit();
  renderer.setAnimationLoop(frame);
}

boot().catch(failOver);
