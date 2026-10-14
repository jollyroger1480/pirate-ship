/**
 * Ocean floor — a sandy seabed that slopes from deep water up to a beach, with
 * animated underwater caustics. Because the water surface is transparent and
 * refracts the scene behind it, the caustics rendered here are what you see
 * dancing on the bottom through clear shallow water (attenuated by depth via
 * the water's Beer–Lambert absorption).
 *
 * Caustics use the classic ridged-noise approximation: the difference of two
 * scrolling noise fields, sharpened with a power curve, produces the bright
 * interlocking network of focused light a wavy surface casts on the seabed.
 */
import {
  Mesh,
  PlaneGeometry,
  MeshStandardNodeMaterial,
  Color,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  vec2,
  vec3,
  float,
  uniform,
  positionWorld,
  mix,
  pow,
  abs,
  clamp,
  smoothstep,
} from 'three/tsl';
import { fbm, valueNoise } from './noise.js';

/**
 * @param {object} o
 * @param {number} [o.size=2400]        seabed extent (m)
 * @param {number} [o.segments=200]     subdivisions per axis
 * @param {number} [o.deepDepth=26]     depth of open water (m below y=0)
 * @param {number} [o.beachHeight=7]    how high the beach rises above y=0 (m)
 * @param {number} [o.shoreAxis='x']    axis the shore runs along ('x' or 'z')
 * @param {*}      o.timeNode           elapsed-time node (caustic animation)
 * @param {object} [o.preset]           look fields (sandColor, caustics…)
 */
export function createOceanFloor(o = {}) {
  const size = o.size ?? 2400;
  const segments = o.segments ?? 200;
  const deepDepth = o.deepDepth ?? 26;
  const beachHeight = o.beachHeight ?? 7;
  const preset = o.preset ?? {};

  const geo = new PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2); // lie flat in XZ

  // Sculpt the seabed: a smooth slope from deep water to a beach, plus dunes.
  const pos = geo.attributes.position;
  const half = size / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const along = (o.shoreAxis === 'z' ? z : x) / half; // -1 (deep) .. +1 (beach)
    const t = (along + 1) / 2; // 0..1
    // Smooth deep->beach profile (ease), shore around t≈0.62.
    const slope = -deepDepth + (deepDepth + beachHeight) * Math.pow(t, 1.7);
    // Low-frequency dunes + finer ripples in the sand.
    const dunes =
      Math.sin(x * 0.012) * Math.cos(z * 0.013) * 1.6 +
      Math.sin(x * 0.05 + z * 0.04) * 0.5;
    pos.setY(i, slope + dunes * (1 - Math.max(0, along))); // flatten near beach
  }
  geo.computeVertexNormals();

  const u = {
    sandShallow: uniform(new Color(preset.sandShallow ?? 0xddc89a)),
    sandDeep: uniform(new Color(preset.sandDeep ?? 0x8a7a55)),
    causticColor: uniform(new Color(preset.causticColor ?? 0xeafff6)),
    causticIntensity: uniform(preset.causticIntensity ?? 0.9),
    causticScale: uniform(preset.causticScale ?? 0.08),
    causticSpeed: uniform(preset.causticSpeed ?? 0.06),
  };
  const time = o.timeNode;

  const mat = new MeshStandardNodeMaterial();
  mat.roughness = 0.95;
  mat.metalness = 0.0;

  const p = positionWorld.xz;

  // Albedo: blotchy sand, lighter in shallows, with fine grain.
  mat.colorNode = Fn(() => {
    const blotch = fbm(p.mul(0.02));
    const grain = valueNoise(p.mul(1.5)).mul(0.12);
    const base = mix(u.sandDeep, u.sandShallow, blotch.mul(0.7).add(0.3));
    return base.mul(float(0.9).add(grain));
  })();

  // Caustics as additive emissive, gated to below the waterline.
  mat.emissiveNode = Fn(() => {
    const uv = p.mul(u.causticScale);
    const k = time.mul(u.causticSpeed);
    const n1 = fbm(uv.add(vec2(k, k.mul(0.4))));
    const n2 = fbm(uv.mul(1.27).add(vec2(k.mul(-0.6), k.mul(0.9))));
    // Ridged difference -> bright focused network.
    const c = pow(clamp(float(1.0).sub(abs(n1.sub(n2)).mul(2.4)), 0.0, 1.0), float(7.0));
    const c2 = pow(clamp(float(1.0).sub(abs(fbm(uv.mul(2.1).sub(k)).sub(n1)).mul(3.0)), 0.0, 1.0), float(9.0)).mul(0.5);
    const underwater = smoothstep(float(0.2), float(-1.0), positionWorld.y); // fade out on the beach
    return u.causticColor.mul(c.add(c2)).mul(u.causticIntensity).mul(underwater);
  })();

  const mesh = new Mesh(geo, mat);
  mesh.name = 'OceanFloor';
  mesh.receiveShadow = true;

  return { mesh, uniforms: u, geometry: geo, material: mat };
}
