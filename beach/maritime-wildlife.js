// Procedural, deterministic marine wildlife for the beach scene.
// Local +Z is the animal's forward direction; all geometry is created here
// and shared across the population.
//
// Visibility rules learned the hard way: at dusk, anything smaller than a few
// metres or farther than ~200 m from the ship reads as nothing. So the whales
// are humpback-scaled and stay surfaced longer, a dolphin pod rides the bow
// wave whenever the ship has way on, and gulls trail the ship in a lazy orbit.

export function createWildlifeRandom(seed = 1) {
  let state;
  if (typeof seed === "number" && Number.isFinite(seed)) {
    state = seed >>> 0;
  } else {
    const text = String(seed);
    state = 2166136261;
    for (let i = 0; i < text.length; i++) {
      state = Math.imul(state ^ text.charCodeAt(i), 16777619) >>> 0;
    }
  }
  if (state === 0) state = 0x6d2b79f5;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

function makeTriangleGeometry(THREE, triangles) {
  const vertices = [];
  for (const triangle of triangles) {
    for (const point of triangle) vertices.push(point[0], point[1], point[2]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function makeBodyGeometry(THREE) {
  // Radius, then position along the body. LatheGeometry's low radial segment
  // count gives a tapered but distinctly faceted silhouette.
  const profile = [
    [0.008, -0.54], [0.045, -0.46], [0.078, -0.30], [0.105, -0.08],
    [0.12, 0.11], [0.105, 0.28], [0.072, 0.41], [0.035, 0.49], [0.004, 0.53],
  ].map(([radius, along]) => new THREE.Vector2(radius, along));
  const geometry = new THREE.LatheGeometry(profile, 9);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function makeWingGeometry(THREE) {
  // A gull's outstretched wing, built from broad, feather-like facets.
  return makeTriangleGeometry(THREE, [
    [[0, 0, 0], [0.42, 0.035, -0.25], [1.2, 0.055, -0.10]],
    [[0.42, 0.035, -0.25], [1.2, 0.055, -0.10], [2.12, 0.025, -0.34]],
    [[1.2, 0.055, -0.10], [2.12, 0.025, -0.34], [2.75, -0.04, -0.76]],
    [[1.2, 0.055, -0.10], [2.75, -0.04, -0.76], [2.08, -0.015, -0.70]],
    [[1.2, 0.055, -0.10], [2.08, -0.015, -0.70], [0.52, -0.015, -0.43]],
    [[0, 0, 0], [1.2, 0.055, -0.10], [0.52, -0.015, -0.43]],
  ]);
}

function addMesh(THREE, parent, geometry, material, position, scale) {
  const mesh = new THREE.Mesh(geometry, material);
  if (position) mesh.position.set(position[0], position[1], position[2]);
  if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

function islandInfo(island) {
  const offset = Array.isArray(island.landOffset) ? island.landOffset : null;
  let radius = Number.isFinite(island.shelfRadius) ? island.shelfRadius : 110;
  for (const shoal of island.shoals || []) {
    radius = Math.max(radius, Number(shoal.rx) || 0, Number(shoal.rz) || 0);
  }
  return {
    x: (Number(island.x) || 0) + (offset ? Number(offset[0]) || 0 : 0),
    z: (Number(island.z) || 0) + (offset ? Number(offset[1]) || 0 : 0),
    radius: Math.max(75, radius),
  };
}

/**
 * Add a deterministic population of cetaceans and coastal gulls. A dolphin
 * pod rides the ship's bow whenever it has way on, and a few gulls trail it,
 * so wildlife is always near the player — not only at far shores.
 */
export function createMaritimeWildlife(THREE, scene, worldData, getSeaHeight) {
  const random = createWildlifeRandom(worldData?.seed ?? 12012);
  const islands = (Array.isArray(worldData?.islands) ? worldData.islands : [])
    .filter((island) => Number.isFinite(island.x) && Number.isFinite(island.z))
    .map(islandInfo);
  if (islands.length === 0) islands.push({ x: 0, z: 0, radius: 120 });

  const geometries = [];
  const materials = [];
  const rememberGeometry = (geometry) => (geometries.push(geometry), geometry);
  const rememberMaterial = (material) => (materials.push(material), material);
  const bodyGeometry = rememberGeometry(makeBodyGeometry(THREE));
  const flipperGeometry = rememberGeometry(makeTriangleGeometry(THREE, [
    [[0, 0, 0], [1, 0, -0.18], [0.34, 0, -0.92]],
  ]));
  const tailGeometry = rememberGeometry(makeTriangleGeometry(THREE, [
    [[0, 0, 0], [0.98, 0, -0.32], [0.78, 0, -0.58]],
    [[0, 0, 0], [-0.98, 0, -0.32], [-0.78, 0, -0.58]],
  ]));
  const dorsalGeometry = rememberGeometry(makeTriangleGeometry(THREE, [
    [[-0.12, 0, 0], [0, 1, -0.04], [0.12, 0, -0.30]],
  ]));
  const birdBodyGeometry = rememberGeometry(new THREE.SphereGeometry(1, 8, 6));
  const birdHeadGeometry = rememberGeometry(new THREE.SphereGeometry(1, 7, 5));
  const beakGeometry = rememberGeometry(new THREE.ConeGeometry(0.07, 0.34, 5));
  const wingGeometry = rememberGeometry(makeWingGeometry(THREE));

  // Faint self-sheen keeps animals from collapsing into pure dusk silhouettes.
  const whaleMaterial = rememberMaterial(new THREE.MeshStandardMaterial({
    color: 0x465962, roughness: 0.82, metalness: 0.02, flatShading: true,
    emissive: 0x0a1014, emissiveIntensity: 1,
  }));
  const dolphinMaterial = rememberMaterial(new THREE.MeshStandardMaterial({
    color: 0x7d9398, roughness: 0.76, metalness: 0.025, flatShading: true,
    emissive: 0x0c161a, emissiveIntensity: 1,
  }));
  const gullBodyMaterial = rememberMaterial(new THREE.MeshStandardMaterial({
    color: 0xe2e0d4, roughness: 0.9, flatShading: true,
    emissive: 0x14130f, emissiveIntensity: 1,
  }));
  const gullWingMaterial = rememberMaterial(new THREE.MeshStandardMaterial({
    color: 0x848a86, roughness: 0.88, side: THREE.DoubleSide, flatShading: true,
  }));
  const beakMaterial = rememberMaterial(new THREE.MeshStandardMaterial({
    color: 0xb78b57, roughness: 0.82, flatShading: true,
  }));
  // Flat fins and wings are intentionally double-sided for WebGL/WebGPU parity.
  whaleMaterial.side = THREE.DoubleSide;
  dolphinMaterial.side = THREE.DoubleSide;
  gullBodyMaterial.side = THREE.DoubleSide;

  const root = new THREE.Group();
  root.name = "procedural-maritime-wildlife";
  scene.add(root);

  function makeCetacean(isWhale) {
    const animal = new THREE.Group();
    animal.rotation.order = "YXZ";
    const length = isWhale ? 15.5 : 5.6;
    const radiusX = isWhale ? 1.65 : 0.62;
    const radiusY = isWhale ? 1.18 : 0.46;
    const material = isWhale ? whaleMaterial : dolphinMaterial;
    addMesh(THREE, animal, bodyGeometry, material, [0, 0, 0], [radiusX / 0.12, length, radiusY / 0.12]);

    const dorsal = addMesh(
      THREE, animal, dorsalGeometry, material,
      [0, radiusY * 0.48, -length * 0.12],
      [isWhale ? 0.95 : 0.5, isWhale ? 0.85 : 0.48, isWhale ? 1.5 : 0.85]
    );
    dorsal.rotation.x = -0.08;

    const tail = new THREE.Group();
    tail.position.set(0, 0, -length * 0.47);
    animal.add(tail);
    addMesh(THREE, tail, tailGeometry, material, null,
      [isWhale ? 1.5 : 0.72, 1, isWhale ? 1.5 : 0.78]);

    const span = isWhale ? 1.45 : 0.7;
    const chord = isWhale ? 1.1 : 0.55;
    const leftFlipper = addMesh(THREE, animal, flipperGeometry, material,
      [-radiusX * 0.70, -radiusY * 0.38, -length * 0.05], [-span, 1, chord]);
    const rightFlipper = addMesh(THREE, animal, flipperGeometry, material,
      [radiusX * 0.70, -radiusY * 0.38, -length * 0.05], [span, 1, chord]);

    return { node: animal, tail, leftFlipper, rightFlipper, length, isWhale };
  }

  function makeGull() {
    const bird = new THREE.Group();
    bird.rotation.order = "YXZ";
    addMesh(THREE, bird, birdBodyGeometry, gullBodyMaterial, [0, 0, -0.02], [0.26, 0.19, 0.68]);
    addMesh(THREE, bird, birdHeadGeometry, gullBodyMaterial, [0, 0.06, 0.46], [0.18, 0.17, 0.19]);
    const beak = addMesh(THREE, bird, beakGeometry, beakMaterial, [0, 0.025, 0.68], [0.85, 0.85, 1]);
    beak.rotation.x = Math.PI / 2;
    const leftWing = addMesh(THREE, bird, wingGeometry, gullWingMaterial, [-0.1, 0.03, 0.02], [-1, 1, 1]);
    const rightWing = addMesh(THREE, bird, wingGeometry, gullWingMaterial, [0.1, 0.03, 0.02], [1, 1, 1]);
    return { node: bird, leftWing, rightWing };
  }

  const whales = [];
  const dolphins = [];
  const gulls = [];
  const bounds = islands.reduce((box, island) => ({
    minX: Math.min(box.minX, island.x - island.radius - 320),
    maxX: Math.max(box.maxX, island.x + island.radius + 320),
    minZ: Math.min(box.minZ, island.z - island.radius - 320),
    maxZ: Math.max(box.maxZ, island.z + island.radius + 320),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });

  // Whales cruise the inter-island lanes; one lane always passes near spawn.
  for (let i = 0; i < 8; i++) {
    const from = islands[i % islands.length];
    const to = islands[(i + 1) % islands.length];
    const laneT = 0.3 + random() * 0.4;
    const animal = makeCetacean(true);
    animal.centerX = from.x + (to.x - from.x) * laneT;
    animal.centerZ = from.z + (to.z - from.z) * laneT;
    animal.rx = 70 + random() * 60;
    animal.rz = 55 + random() * 50;
    animal.phase = random();
    animal.period = 33 + random() * 11;
    animal.node.position.set(animal.centerX, 0, animal.centerZ);
    whales.push(animal);
    root.add(animal.node);
  }

  // Free dolphins mill around island shores.
  for (let i = 0; i < 11; i++) {
    const shore = islands[i % islands.length];
    const angle = random() * TAU;
    const distance = shore.radius + 35 + random() * 30;
    const animal = makeCetacean(false);
    animal.centerX = shore.x + Math.cos(angle) * distance;
    animal.centerZ = shore.z + Math.sin(angle) * distance;
    animal.rx = 30 + random() * 28;
    animal.rz = 26 + random() * 24;
    animal.phase = random();
    animal.period = 10.5 + random() * 4.5;
    animal.node.position.set(animal.centerX, 0, animal.centerZ);
    dolphins.push(animal);
    root.add(animal.node);
  }

  // Bow-riding pod: five dolphins in a wedge off the bow when the ship has way
  // on, falling back to a lazy circle around it when it slows.
  const bowOffsets = [
    [15, 0], [10, -7.5], [10, 7.5], [21, -4.5], [21, 4.5],
  ];
  for (let i = 0; i < bowOffsets.length; i++) {
    const animal = makeCetacean(false);
    animal.fore = bowOffsets[i][0];
    animal.side = bowOffsets[i][1];
    animal.bowPhase = i / bowOffsets.length;
    animal.curX = -20 + bowOffsets[i][0];
    animal.curZ = 445 + bowOffsets[i][1];
    animal.node.position.set(animal.curX, 0, animal.curZ);
    dolphins.push(animal);
    root.add(animal.node);
  }
  const bowPod = dolphins.slice(-bowOffsets.length);

  // Gulls: most circle home shores, a few trail the ship.
  for (let i = 0; i < 20; i++) {
    const trailsShip = i >= 16;
    const shore = islands[i % islands.length];
    const angle = random() * TAU;
    const radius = trailsShip ? 13 + random() * 7 : shore.radius + 16 + random() * 20;
    const bird = makeGull();
    if (trailsShip) {
      bird.shipOrbit = radius;
      bird.height = 9 + random() * 6;
    } else {
      bird.centerX = shore.x + Math.cos(angle) * radius;
      bird.centerZ = shore.z + Math.sin(angle) * radius;
      bird.rx = 30 + random() * 32;
      bird.rz = 26 + random() * 28;
      bird.height = 13 + random() * 9;
    }
    bird.phase = random();
    bird.period = 15 + random() * 13;
    gulls.push(bird);
    root.add(bird.node);
  }

  function surfaceAt(x, z) {
    if (typeof getSeaHeight !== "function") return 0;
    try {
      const height = getSeaHeight(x, z);
      return Number.isFinite(height) ? height : 0;
    } catch (_) {
      return 0;
    }
  }

  function confineCenter(entity) {
    entity.centerX = clamp(entity.centerX, bounds.minX + entity.rx, bounds.maxX - entity.rx);
    entity.centerZ = clamp(entity.centerZ, bounds.minZ + entity.rz, bounds.maxZ - entity.rz);
  }
  for (const animal of whales) confineCenter(animal);
  for (const animal of dolphins) if (!animal.fore) confineCenter(animal);

  let disposed = false;
  function update(elapsed, shipPosition) {
    if (disposed) return;
    const time = Number.isFinite(elapsed) ? elapsed : 0;
    const shipX = Number.isFinite(shipPosition?.x) ? shipPosition.x : NaN;
    const shipZ = Number.isFinite(shipPosition?.z) ? shipPosition.z : NaN;
    const shipYaw = Number.isFinite(shipPosition?.yaw) ? shipPosition.yaw : 0;
    const shipSpeed = Number.isFinite(shipPosition?.speed) ? Math.abs(shipPosition.speed) : 0;
    const hasShip = Number.isFinite(shipX) && Number.isFinite(shipZ);

    for (const animal of whales) {
      const angle = time * TAU / animal.period + animal.phase * TAU;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const x = animal.centerX + cosine * animal.rx;
      const z = animal.centerZ + sine * animal.rz;
      const dx = -sine * animal.rx;
      const dz = cosine * animal.rz;
      const cycle = (time / animal.period + animal.phase) % 1;
      const nearShip = hasShip &&
        (x - shipX) * (x - shipX) + (z - shipZ) * (z - shipZ) < 220 * 220;
      // Humpbacks keep their back out of the water between dives.
      let yOffset = -0.55;
      let pitch = Math.sin(angle * 1.7) * 0.03;
      if (cycle >= 0.52 && cycle < 0.70) {
        const rise = smooth((cycle - 0.52) / 0.18);
        yOffset += rise * 1.05;
        pitch -= rise * 0.09;
      } else if (cycle >= 0.70 && cycle < 0.80) {
        const dive = smooth((cycle - 0.70) / 0.10);
        yOffset += 1.05 - dive * 1.35;
        pitch += dive * 0.22;
      } else if (cycle >= 0.80 && cycle < 0.88) {
        yOffset = -1.1;
        pitch = 0.18;
      } else if (cycle >= 0.88 && cycle < 0.975) {
        const leap = (cycle - 0.88) / 0.095;
        yOffset = -0.3 + Math.sin(Math.PI * leap) * (nearShip ? 5.2 : 4.0);
        pitch = -Math.sin(Math.PI * leap) * 0.45;
      } else if (cycle >= 0.975) {
        yOffset = -0.4 - smooth((cycle - 0.975) / 0.025) * 1.0;
        pitch = 0.24;
      }
      animal.node.position.set(x, surfaceAt(x, z) + yOffset, z);
      animal.node.rotation.set(pitch, Math.atan2(dx, dz), Math.sin(angle * 0.8) * 0.04, "YXZ");
      animal.tail.rotation.x = Math.sin(time * 3.0 + animal.phase * TAU) * 0.2;
      animal.tail.rotation.z = Math.sin(time * 1.5 + animal.phase) * 0.05;
      const finBeat = Math.sin(time * 1.4 + animal.phase * TAU) * 0.1;
      animal.leftFlipper.rotation.z = -finBeat;
      animal.rightFlipper.rotation.z = finBeat;
    }

    for (const animal of dolphins) {
      if (animal.fore !== undefined) {
        // Bow rider: wedge ahead of the hull with a weaving surf line, leaping
        // on a stagger; slow ship means a lazy orbit instead.
        const moving = shipSpeed > 6 && hasShip;
        const weave = Math.sin(time * 1.3 + animal.bowPhase * TAU);
        let targetX;
        let targetZ;
        let heading;
        if (moving) {
          const bowX = Math.sin(shipYaw);
          const bowZ = Math.cos(shipYaw);
          targetX = shipX + bowX * (animal.fore + weave * 3.5) - bowZ * (animal.side + weave * 2);
          targetZ = shipZ + bowZ * (animal.fore + weave * 3.5) + bowX * (animal.side + weave * 2);
          heading = Math.atan2(bowX, bowZ);
        } else if (hasShip) {
          const orbit = time * TAU / 26 + animal.bowPhase * TAU;
          const orbitR = 30 + animal.side * 1.4;
          targetX = shipX + Math.cos(orbit) * orbitR;
          targetZ = shipZ + Math.sin(orbit) * orbitR;
          heading = orbit + Math.PI / 2;
        } else {
          targetX = animal.curX;
          targetZ = animal.curZ;
          heading = 0;
        }
        const blend = 1 - Math.exp(-3.2 * (1 / 60));
        const nx = animal.curX + (targetX - animal.curX) * blend;
        const nz = animal.curZ + (targetZ - animal.curZ) * blend;
        heading = Math.atan2(nx - animal.curX, nz - animal.curZ) || heading;
        animal.curX = nx;
        animal.curZ = nz;
        const leapCycle = (time / 6.5 + animal.bowPhase) % 1;
        const leapT = leapCycle < 0.16 ? leapCycle / 0.16 : -1;
        let yOffset = -0.28 + Math.sin(time * 2.4 + animal.bowPhase * TAU) * 0.12;
        let pitch = 0;
        if (leapT >= 0) {
          yOffset += Math.sin(Math.PI * leapT) * 2.9;
          pitch = -Math.sin(Math.PI * leapT) * 0.55;
        }
        animal.node.position.set(nx, surfaceAt(nx, nz) + yOffset, nz);
        animal.node.rotation.set(pitch, heading, Math.sin(time * 2 + animal.bowPhase * TAU) * 0.05, "YXZ");
        animal.tail.rotation.x = Math.sin(time * 5.6 + animal.bowPhase * TAU) * 0.32;
        animal.leftFlipper.rotation.z = -0.1;
        animal.rightFlipper.rotation.z = 0.1;
        continue;
      }
      const angle = time * TAU / animal.period + animal.phase * TAU;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const x = animal.centerX + cosine * animal.rx;
      const z = animal.centerZ + sine * animal.rz;
      const dx = -sine * animal.rx;
      const dz = cosine * animal.rz;
      const cycle = (time / animal.period + animal.phase) % 1;
      const leapStart = 0.48;
      const leapEnd = 0.74;
      const leaping = cycle >= leapStart && cycle < leapEnd;
      const leapT = leaping ? (cycle - leapStart) / (leapEnd - leapStart) : 0;
      const nearShip = hasShip &&
        (x - shipX) * (x - shipX) + (z - shipZ) * (z - shipZ) < 180 * 180;
      let yOffset = -0.3 + Math.sin(angle * 2.1) * 0.1;
      let pitch = Math.sin(angle * 1.2) * 0.035;
      if (leaping) {
        yOffset += Math.sin(Math.PI * leapT) * (nearShip ? 4.2 : 3.4);
        pitch = -Math.sin(Math.PI * leapT) * 0.58 + (leapT > 0.68 ? (leapT - 0.68) * 1.5 : 0);
      }
      animal.node.position.set(x, surfaceAt(x, z) + yOffset, z);
      animal.node.rotation.set(pitch, Math.atan2(dx, dz), Math.sin(angle) * 0.035, "YXZ");
      animal.tail.rotation.x = Math.sin(time * 5.2 + animal.phase * TAU) * 0.3;
      animal.tail.rotation.z = Math.sin(time * 2.1 + animal.phase) * 0.07;
      const finBeat = Math.sin(time * 2.6 + animal.phase * TAU) * 0.14;
      animal.leftFlipper.rotation.z = -finBeat;
      animal.rightFlipper.rotation.z = finBeat;
    }

    for (const bird of gulls) {
      const angle = time * TAU / bird.period + bird.phase * TAU;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      let x;
      let z;
      let dx;
      let dz;
      if (bird.shipOrbit !== undefined && hasShip) {
        const sway = Math.sin(time * 0.5 + bird.phase * TAU) * 6;
        x = shipX + cosine * (bird.shipOrbit + sway);
        z = shipZ + sine * (bird.shipOrbit + sway);
        dx = -sine * (bird.shipOrbit + sway);
        dz = cosine * (bird.shipOrbit + sway);
      } else if (bird.shipOrbit !== undefined) {
        x = shipX;
        z = shipZ;
        dx = 1;
        dz = 0;
      } else {
        x = bird.centerX + cosine * bird.rx;
        z = bird.centerZ + sine * bird.rz;
        dx = -sine * bird.rx;
        dz = cosine * bird.rz;
      }
      const glide = Math.sin(time * 1.05 + bird.phase * TAU);
      const flap = Math.sin(time * 2.8 + bird.phase * TAU) * 0.13 + glide * 0.05;
      bird.node.position.set(x, surfaceAt(x, z) + bird.height + Math.sin(angle * 2) * 0.7, z);
      bird.node.rotation.set(glide * 0.04, Math.atan2(dx, dz), Math.sin(angle) * 0.08, "YXZ");
      bird.leftWing.rotation.z = -flap;
      bird.rightWing.rotation.z = flap;
    }
  }

  const stats = Object.freeze({
    whales: whales.length,
    dolphins: dolphins.length,
    gulls: gulls.length,
    bowPod: bowPod.length,
    total: whales.length + dolphins.length + gulls.length,
  });
  const audioEntities = [
    ...whales.map((animal) => ({ species: "whale", position: animal.node.position })),
    ...dolphins.map((animal) => ({ species: "dolphin", position: animal.node.position })),
    ...gulls.map((bird) => ({ species: "gull", position: bird.node.position })),
  ];

  function dispose() {
    if (disposed) return;
    disposed = true;
    scene.remove(root);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  return { update, stats, audioEntities, dispose };
}
