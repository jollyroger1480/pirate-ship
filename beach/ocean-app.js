import * as THREE from "three/webgpu";
import {
  pass, screenUV, saturation, mix, smoothstep, vec2, vec3, vec4,
  float, sin, fract, dot, length, time,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { Water, createOceanFloor, PRESETS } from "threejs-water-free";
import { flattenColliders, resolveCoast } from "./world-collision.mjs";
import { mergeInputs, readGamepadInput } from "./gamepad-input.mjs";
import { createMaritimeWildlife } from "./maritime-wildlife.js";
import { createMaritimeFireflies } from "./maritime-fireflies.js";
import { createMaritimeAudio } from "./maritime-audio.js";

const CACHE_VERSION = "punk23";
const FLOOR = { size: 9000, segments: 288, deepDepth: 52, beachHeight: 6 };
const COVE = { x: 0, z: 520, radius: 150 };
const ISLAND = { x: 349, z: 501, radius: 90 };
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
  p.name = "Cove";
  p.sun = { elevation: 16, azimuth: 210, color: 0xffb070, intensity: 0.7 };
  p.sky = {
    zenithColor: 0x1a1240,
    horizonColor: 0x6a3a4a,
    groundColor: 0x0c0814,
    rayleigh: 1.05,
    cloudCoverage: 0.62,
    cloudColor: 0x7a4068,
    cloudSpeed: 0.015,
    exposure: 1.2,
  };
  p.ocean = JSON.parse(JSON.stringify(PRESETS.clear.ocean));
  // Water Pro ideas (docs.threejswaterpro.com): a coarse ~1 km swell cascade pushes
  // tiling past the horizon, choppiness ~1.2 stays natural, and a layered swell
  // train reads larger than any single wave height.
  p.ocean.cascades[0].patchSize = 760;
  p.ocean.cascades[0].waveHeight *= 1.5;
  p.ocean.cascades[0].choppiness = 1.18;
  p.ocean.cascades[0].windSpeed = Math.max(9, p.ocean.cascades[0].windSpeed);
  p.ocean.cascades[1].waveHeight *= 1.3;
  p.ocean.cascades[1].choppiness *= 1.12;
  const swell = (deg, wavelength, amplitude, steepness = 0.42, speed = 1) => {
    const a = (deg * Math.PI) / 180;
    return { direction: [Math.cos(a), Math.sin(a)], wavelength, amplitude, steepness, speed };
  };
  p.ocean.gerstner = [
    swell(38, 240, 0.62, 0.42, 0.9),
    swell(52, 130, 0.3, 0.38),
    swell(24, 64, 0.16, 0.34),
  ];
  p.water = JSON.parse(JSON.stringify(PRESETS.tropical.water));
  p.water.crestFoam = 0.32;
  p.water.foamScale = 2.2;
  p.water.shoreFoamStrength = 1.05;
  p.water.shoreDepth = 2.6;
  p.water.waterColor = 0x0a3a48;
  p.water.absorptionColor = [1.4, 1.55, 1.25];
  p.water.foamColor = 0xd8e6ec;
  p.water.sunShininess = 380;
  p.water.refractionStrength = 0.55;
  p.water.sssStrength = 0.38;
  p.water.sssColor = 0x0a6a62;
  p.floor = JSON.parse(JSON.stringify(PRESETS.lagoon.floor));
  p.floor.sandShallow = 0x2a4a52;
  p.floor.sandDeep = 0x061018;
  p.floor.causticIntensity = 0.35;
  p.sky.zenithColor = 0x1a1240;
  p.sky.horizonColor = 0x6a3a4a;
  p.sky.cloudCoverage = 0.62;
  p.sky.cloudColor = 0x7a4068;
  p.sky.exposure = 1.2;
  p.fog = { color: 0x120c1c, density: 0.0011 };
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
  for (const island of worldData?.islands || []) {
    const shelfX = island.landOffset ? island.x + island.landOffset[0] : island.x;
    const shelfZ = island.landOffset ? island.z + island.landOffset[1] : island.z;
    if (Math.abs(fieldX - shelfX) > island.shelfRadius + 80 ||
        Math.abs(fieldZ - shelfZ) > island.shelfRadius + 80) continue;
    const ir = Math.hypot(fieldX - shelfX, fieldZ - shelfZ);
    const t = Math.max(0, Math.min(1, (ir / island.shelfRadius - 0.55) / 0.45));
    const shelfWeight = 1 - t * t * (3 - 2 * t);
    y = Math.max(y, -14 + 9 * shelfWeight);
    for (const shoalBand of island.shoals || []) {
      const sx = fieldX - island.x - shoalBand.x;
      const sz = fieldZ - island.z - shoalBand.z;
      const q = (sx / shoalBand.rx) ** 2 + (sz / shoalBand.rz) ** 2;
      if (q < 1) y = Math.max(y, -4.8 + (1 - q) * 1.7);
    }
    if (island.id === "skull-island") {
      if (ir > 60 && ir < 250) {
        const ring = 1 - Math.abs(ir - 120) / 80;
        y = Math.max(y, -3.2 + ring * 2.4);
      }
    }
  }
  return y;
}

function sculptCove(geometry) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, floorHeightWorld(pos.getX(i), pos.getZ(i), { x: 0, z: 0 }));
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

async function loadEnv(scene, renderer) {
  const hdr = await new HDRLoader().loadAsync("beach/env.hdr");
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(hdr);
  scene.environment = env.texture || env;
  hdr.dispose();
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
          const device = await adapter.requestDevice();
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
  renderer.toneMappingExposure = 1.15;
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
  worldColliders = flattenColliders(worldData.islands);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0618);
  scene.fog = new THREE.FogExp2(0x49313a, 0.00022);
  scene.environmentIntensity = 0.16;

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 12000);
  const water = new Water({
    preset: bayPreset(),
    quality: {
      simSize: hasGpu ? 256 : 128,
      segments: hasGpu ? 720 : 360,
      detail: hasGpu ? 0.8 : 0.35,
      sparkle: 2.6,
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
  const sun = new THREE.DirectionalLight(0xffc090, 1.4);
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
  scene.add(new THREE.HemisphereLight(0x4a1860, 0x061018, 0.12));
  scene.add(new THREE.AmbientLight(0x201018, 0.05));
  const neonMag = new THREE.PointLight(0xff2bd6, 400, 320, 2);
  neonMag.position.set(ISLAND.x - 175, 40, ISLAND.z + 42);
  const neonCyan = new THREE.PointLight(0x22f6ff, 280, 280, 2);
  neonCyan.position.set(ISLAND.x + 162, 22, ISLAND.z - 35);
  scene.add(neonMag);
  scene.add(neonCyan);
  const calderaLight = new THREE.PointLight(0xff5518, 800, 260, 2);
  calderaLight.position.set(ISLAND.x + 24.3, 26, ISLAND.z + 4.7);
  scene.add(calderaLight);
  const beacons = [];
  for (const island of worldData.islands) {
    if (!island.beacon) continue;
    const beaconLight = new THREE.PointLight(island.id === "skull-island" ? 0xff5518 : 0xff9a62, 135, 720, 2);
    beaconLight.position.set(island.x + island.beacon[0], island.beacon[2], island.z + island.beacon[1]);
    scene.add(beaconLight);
    beacons.push({
      id: island.id,
      light: beaconLight,
      base: beaconLight.intensity,
      offset: [...island.id].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) % 97, 7) / 97,
    });
  }
  const faceKey = new THREE.DirectionalLight(0xffa060, 2.2);
  faceKey.position.set(ISLAND.x - 190, 98, ISLAND.z - 46);
  faceKey.target.position.set(ISLAND.x, 24, ISLAND.z);
  scene.add(faceKey);
  scene.add(faceKey.target);

  try {
    await loadEnv(scene, renderer);
  } catch (err) {
    console.warn("env.hdr", err);
  }

  const loader = new GLTFLoader();
  const chest = makeChest();
  const chestXZ = { x: 10, z: 528 };
  chest.position.set(chestXZ.x, floorHeightWorld(chestXZ.x, chestXZ.z, floor.mesh.position), chestXZ.z);
  chest.rotation.y = 0.4;
  scene.add(chest);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 });
  const leafMat = new THREE.MeshStandardMaterial({
    color: 0x1c6a2c, roughness: 0.78, side: THREE.DoubleSide, envMapIntensity: 0.45,
  });
  function spitPalm(x, z, scale, yaw) {
    const g = new THREE.Group();
    const y = floorHeightWorld(x, z, floor.mesh.position);
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16 * scale, 0.32 * scale, 6.8 * scale, 6),
      trunkMat
    );
    trunk.position.y = 3.3 * scale;
    trunk.rotation.z = 0.07;
    trunk.castShadow = true;
    g.add(trunk);
    const half = 2.6 * scale;
    for (let i = 0; i < 9; i++) {
      const a = yaw + (i / 9) * Math.PI * 2;
      const geo = new THREE.PlaneGeometry(1.35 * scale, 5.2 * scale, 1, 7);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const t = (pos.getZ(v) + half) / (half * 2);
        pos.setX(v, pos.getX(v) * (1 - t * 0.8));
        pos.setY(v, Math.sin(t * Math.PI) * 0.7 * scale - t * t * 3.3 * scale);
      }
      geo.computeVertexNormals();
      const fr = new THREE.Mesh(geo, leafMat);
      fr.position.y = 6.45 * scale;
      fr.rotation.y = a;
      fr.castShadow = true;
      g.add(fr);
    }
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
      if (/^(core|eye|flow)/i.test(obj.name || "")) {
        obj.visible = false;
        return;
      }
      const tag = `${obj.name || ""} ${obj.material.name || ""}`;
      if (/^caldera/i.test(obj.name || "")) {
        const src = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        const hot = src.clone();
        hot.color = new THREE.Color(0.55, 0.06, 0.0);
        hot.emissive = new THREE.Color(1.0, 0.32, 0.04);
        hot.emissiveIntensity = 2.2;
        hot.roughness = 0.4;
        hot.toneMapped = true;
        obj.material = hot;
        return;
      }
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => {
        const nm = (tag + (m.name || "")).toLowerCase();
        // double-sided: carved recess floors tilt away from high cameras
        // and FrontSide culling turned them into see-through holes
        m.side = THREE.DoubleSide;
        if (/socket/.test(nm)) {
          // voids: unlit near-black so the skull's shadow shapes never pick up
          // env or specular tint
          obj.material = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
          return;
        }
        if (/lava|eye|flow|caldera/.test(nm)) {
          m.color = new THREE.Color(0.05, 0.035, 0.03);
          m.emissive = new THREE.Color(0, 0, 0);
          m.emissiveIntensity = 0;
        } else if (m.roughness !== undefined) {
          m.roughness = Math.max(m.roughness || 0.8, 0.92);
          // island is lit by sun/faceKey/caldera/neons; env adds a teal haze
          m.envMapIntensity = 0;
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
    archipelagoLoaded = true;
    window.__archipelagoRoot = archipelago;
  } catch (err) {
    console.warn("archipelago", err);
  }
  if (!skullLoaded || !archipelagoLoaded) {
    throw new Error(`world assets missing: skull=${skullLoaded}, archipelago=${archipelagoLoaded}`);
  }

  let shipRoot = null;
  let shipState = { x: -20, z: 445, yaw: 1.42, speed: 0, yawRate: 0 };
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
  let wildlife = null;
  let fireflies = null;
  let audio = null;
  let gamepadAudioAttempted = false;
  const gamepadState = { connected: false, id: "" };

  let pipeline = null;
  try {
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode("output");
    const tight = bloom(color, 0.65, 0.22, 0.92);
    const wide = bloom(color, 0.28, 0.55, 0.8);
    let graded = color.rgb.mul(vec3(1.02, 0.98, 1.06));
    graded = saturation(graded, 1.12);
    graded = graded.sub(0.5).mul(1.1).add(0.5);
    const vig = smoothstep(float(0.95), float(0.4), length(screenUV.sub(0.5)));
    graded = graded.mul(mix(float(0.72), float(1.0), vig));
    const grain = fract(sin(dot(screenUV, vec2(190.0, 260.0)).add(time)).mul(43758.5453));
    graded = graded.add(grain.sub(0.5).mul(0.008));
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
    orbit.yaw -= dx * 0.005;
    orbit.pitch = Math.max(0.06, Math.min(1.15, orbit.pitch + dy * 0.004));
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      orbit.dist = Math.max(18, Math.min(220, orbit.dist + e.deltaY * 0.05));
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
    if (window.__beachLook === "island") {
      camera.position.set(ISLAND.x - 280, 190, ISLAND.z + 24);
      camera.lookAt(ISLAND.x + 34, 18, ISLAND.z - 8);
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
    }
    // Occulting flash, one blink per four seconds per beacon, de-synced per island.
    for (const beacon of beacons) {
      const t = (elapsed * 0.25 + beacon.offset) % 1;
      beacon.light.intensity = beacon.base * (t < 0.1 ? 1.5 : 0.22);
    }
    if (wildlife) wildlife.update(elapsed, shipState);
    if (fireflies) fireflies.update(elapsed);
    if (audio) audio.update(elapsed, { ...shipState, yaw: shipState.yaw }, wildlife?.audioEntities || []);
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
