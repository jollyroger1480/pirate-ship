/**
 * Procedural sky — an analytic atmosphere with a Rayleigh phase function,
 * height-based extinction, a sun disc + glow, and animated FBM clouds.
 *
 * The same `skyColor(direction)` node is reused by the water material so that
 * reflections and the visible sky stay perfectly consistent. All look
 * parameters live in shared uniforms so a preset (or live UI) can retune the
 * whole scene by mutating `.value`.
 */
import { Mesh, SphereGeometry, BackSide, Vector3, Color } from 'three/webgpu';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  vec2,
  vec3,
  float,
  uniform,
  positionWorld,
  cameraPosition,
  normalize,
  dot,
  max,
  pow,
  mix,
  clamp,
  smoothstep,
  exp,
} from 'three/tsl';
import { fbm } from './noise.js';

/** Create the shared uniform set that drives both sky and water. */
export function createSkyUniforms(preset = {}) {
  return {
    sunDirection: uniform(new Vector3(0.3, 0.5, -0.6).normalize()),
    sunColor: uniform(new Color(preset.sunColor ?? 0xfff4e0)),
    sunIntensity: uniform(preset.sunIntensity ?? 1.0),
    zenithColor: uniform(new Color(preset.zenithColor ?? 0x1a4d8f)),
    horizonColor: uniform(new Color(preset.horizonColor ?? 0xbcd6f0)),
    groundColor: uniform(new Color(preset.groundColor ?? 0x4a5560)),
    rayleigh: uniform(preset.rayleigh ?? 1.0),
    cloudCoverage: uniform(preset.cloudCoverage ?? 0.4),
    cloudColor: uniform(new Color(preset.cloudColor ?? 0xffffff)),
    cloudSpeed: uniform(preset.cloudSpeed ?? 0.01),
    exposure: uniform(preset.exposure ?? 1.0),
  };
}

/**
 * Sky radiance along a unit `direction`. Returns a vec3 colour node.
 *
 * This is a plain node-graph builder (not a cached TSL `Fn`) so the cloud layer
 * can be *compiled out* at low quality — when `clouds` is false the FBM cloud
 * sampling is never generated, which matters because reflections evaluate the
 * sky once per water fragment.
 *
 * @param {*} direction   normalized vec3 node (view ray)
 * @param {object} u       uniforms from createSkyUniforms
 * @param {*} timeNode     elapsed-time node (for cloud animation)
 * @param {boolean} clouds include the animated cloud layer (default true)
 */
export function skyColor(direction, u, timeNode, clouds = true) {
  const dir = normalize(direction);
  const up = clamp(dir.y, 0.0, 1.0);

  // Base atmospheric gradient: horizon -> zenith with a soft transition.
  const grad = pow(up, float(0.42));
  const sky = mix(u.horizonColor, u.zenithColor, grad);

  // Below the horizon fades toward the ground/sea colour.
  const ground = mix(u.groundColor, u.horizonColor, smoothstep(-0.15, 0.0, dir.y));
  const base = mix(ground, sky, smoothstep(-0.02, 0.06, dir.y));

  // Sun geometry.
  const cosT = max(dot(dir, u.sunDirection), 0.0);
  // Rayleigh phase function ~ (1 + cos^2θ) tints the sky around the sun.
  const rayleighPhase = float(0.75).mul(cosT.mul(cosT).add(1.0));
  const scatter = pow(cosT, float(8.0)).mul(u.rayleigh).mul(0.6);
  const halo = u.sunColor.mul(scatter).mul(rayleighPhase);

  // Sun glow + sharp disc.
  const glow = pow(cosT, float(256.0)).mul(0.5);
  const disc = smoothstep(0.9996, 0.9998, cosT);
  const sun = u.sunColor.mul(glow.add(disc.mul(8.0))).mul(u.sunIntensity);

  // Atmospheric extinction toward the horizon brightens it (haze).
  const haze = exp(up.mul(-3.0)).mul(0.15);
  const hazeColor = u.horizonColor.mul(haze);

  let color = base.add(halo).add(sun).add(hazeColor);

  if (clouds) {
    // Animated clouds projected onto the upper hemisphere.
    const cloudMask = smoothstep(0.04, 0.35, dir.y);
    const proj = dir.xz.div(max(dir.y, 0.08));
    const motion = vec2(timeNode.mul(u.cloudSpeed), timeNode.mul(u.cloudSpeed).mul(0.6));
    const n = fbm(proj.mul(1.6).add(motion));
    const cloud = smoothstep(
      float(1.0).sub(u.cloudCoverage),
      float(1.0).sub(u.cloudCoverage).add(0.25),
      n
    ).mul(cloudMask);
    // Shade clouds by sun proximity for a lit/underside look.
    const cloudLit = mix(u.cloudColor.mul(0.55), u.cloudColor, smoothstep(0.0, 0.6, cosT));
    color = mix(color, cloudLit, cloud.mul(0.9));
  }

  return color.mul(u.exposure);
}

/** Build a sky dome mesh that follows the camera (radius is irrelevant). */
export function createSky(uniforms, timeNode, clouds = true) {
  const geo = new SphereGeometry(4000, 32, 16);
  const mat = new MeshBasicNodeMaterial();
  mat.side = BackSide;
  mat.depthWrite = false;
  mat.fog = false; // the sky is at "infinity" — distance fog must not tint it
  const dir = normalize(positionWorld.sub(cameraPosition));
  mat.colorNode = skyColor(dir, uniforms, timeNode, clouds);
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
