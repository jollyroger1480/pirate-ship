// Ambient dusk fireflies: one additive Points cloud per habitat, vertex-color
// flicker (additive black = invisible), immune to fog so shore swarms glow at
// distance. Technique adapted from boring-forest.vercel.app's firefly system.

export function createFireflyRandom(seed = 4242) {
  let state = (typeof seed === "number" && Number.isFinite(seed)) ? seed >>> 0 : 4242;
  if (state === 0) state = 0x9e3779b9;
  return function random() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function createMaritimeFireflies(THREE, scene, habitats, getSeaHeight, { seed = 4242, size = 1.5 } = {}) {
  const zones = (Array.isArray(habitats) && habitats.length ? habitats : []).filter(
    (zone) => Number.isFinite(zone.x) && Number.isFinite(zone.z) && (zone.count || 0) > 0
  );
  const count = zones.reduce((sum, zone) => sum + Math.floor(zone.count), 0);

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const base = new Float32Array(count * 3);
  const meta = new Float32Array(count * 4); // phase, speed, driftRadius, heightBob
  const random = createFireflyRandom(seed);
  let written = 0;
  for (const zone of zones) {
    const n = Math.floor(zone.count);
    const radius = Math.max(10, Number(zone.radius) || 60);
    const hMin = Number.isFinite(zone.heightMin) ? zone.heightMin : 2;
    const hMax = Number.isFinite(zone.heightMax) ? Math.max(hMin + 1, zone.heightMax) : hMin + 10;
    for (let i = 0; i < n && written < count; i++, written++) {
      const angle = random() * TAU;
      const r = Math.sqrt(random()) * radius;
      const x = zone.x + Math.cos(angle) * r;
      const z = zone.z + Math.sin(angle) * r;
      let y = 0;
      if (typeof getSeaHeight === "function") {
        try {
          const height = getSeaHeight(x, z);
          y = Number.isFinite(height) ? height : 0;
        } catch {}
      }
      y += hMin + random() * (hMax - hMin);
      base[written * 3] = x;
      base[written * 3 + 1] = y;
      base[written * 3 + 2] = z;
      meta[written * 4] = random() * TAU;
      meta[written * 4 + 1] = 0.35 + random() * 0.9;
      meta[written * 4 + 2] = 0.8 + random() * 2.4;
      meta[written * 4 + 3] = 0.4 + random() * 1.2;
    }
  }
  positions.set(base);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size,
    color: 0xffffff,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
    fog: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 4;
  points.name = "maritime-fireflies";
  scene.add(points);

  // Warm dusk lantern tone; flicker drives each point toward black (invisible).
  const warmR = 1.0;
  const warmG = 0.83;
  const warmB = 0.45;
  let disposed = false;

  function update(elapsed) {
    if (disposed) return;
    const t = Number.isFinite(elapsed) ? elapsed : 0;
    for (let i = 0; i < count; i++) {
      const phase = meta[i * 4];
      const speed = meta[i * 4 + 1];
      const drift = meta[i * 4 + 2];
      const heightBob = meta[i * 4 + 3];
      const w = t * speed + phase;
      positions[i * 3] = base[i * 3] + Math.sin(w * 0.9) * drift;
      positions[i * 3 + 1] = base[i * 3 + 1] + Math.sin(w * 0.6 + 1.7) * heightBob;
      positions[i * 3 + 2] = base[i * 3 + 2] + Math.cos(w * 0.7 + 0.4) * drift;
      const pulse = Math.sin(w * 1.6);
      const flicker = clamp(0.25 + 0.75 * pulse * pulse, 0, 1);
      colors[i * 3] = warmR * flicker;
      colors[i * 3 + 1] = warmG * flicker;
      colors[i * 3 + 2] = warmB * flicker;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
  }

  const stats = Object.freeze({ total: count });
  function dispose() {
    if (disposed) return;
    disposed = true;
    scene.remove(points);
    geometry.dispose();
    material.dispose();
  }

  return { update, stats, dispose };
}
