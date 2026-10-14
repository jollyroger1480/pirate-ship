/**
 * Three.js Water Free — real-time, physically-based ocean rendering for
 * Three.js WebGPU.
 *
 * @example
 *   import { Water } from 'threejs-water-free';
 *   const water = new Water({ preset: 'storm' });
 *   scene.add(water.object);
 *   // in your loop:
 *   water.update(clock.getElapsedTime(), camera);
 *
 * @see https://github.com/baditaflorin/threejs-water-free
 */
import { Group, Mesh, Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';

import { Ocean } from './core/ocean.js';
import { createSkyUniforms, createSky, skyColor } from './material/sky.js';
import { createWaterMaterial } from './material/waterMaterial.js';
import { createOceanGeometry } from './geometry/oceanPlane.js';
import { Buoyancy } from './physics/buoyancy.js';
import { PRESETS, PRESET_NAMES, resolvePreset } from './presets.js';
import { resolveQuality } from './quality.js';

const DEG = Math.PI / 180;

export class Water {
  /**
   * @param {object} [options]
   * @param {string|object} [options.preset='clear'] preset name or config object
   * @param {string} [options.quality='high']  'low' | 'medium' | 'high' | 'ultra'
   * @param {number} [options.resolution]      surface grid subdivisions (overrides quality)
   * @param {number} [options.extent=6000]     how far the surface reaches (m)
   * @param {number} [options.lodPower=3.0]    radial LOD warp strength
   */
  constructor(options = {}) {
    this.options = options;
    this.quality = options.quality ?? 'high';
    // Deep copy so callers can mutate `this.config` without touching presets.
    this.config = JSON.parse(JSON.stringify(resolvePreset(options.preset ?? 'clear')));

    this._time = uniform(0);
    this.object = new Group();
    this.object.name = 'Water';
    this._build();
  }

  _build() {
    const cfg = this.config;
    const q = resolveQuality(this.quality);

    // The quality level sets the FFT grid resolution per cascade.
    this.ocean = new Ocean({
      cascades: cfg.ocean.cascades.map((c) => ({ ...c, size: q.simSize })),
      gerstner: cfg.ocean.gerstner,
    });

    this.skyUniforms = createSkyUniforms({
      ...cfg.sky,
      sunColor: cfg.sun.color,
      sunIntensity: cfg.sun.intensity,
    });
    this.setSun(cfg.sun.elevation, cfg.sun.azimuth);

    this.sky = createSky(this.skyUniforms, this._time, q.clouds !== false);

    const { material, uniforms } = createWaterMaterial({
      ocean: this.ocean,
      skyUniforms: this.skyUniforms,
      timeNode: this._time,
      preset: cfg.water,
      features: q,
    });
    this.material = material;
    this.waterUniforms = uniforms;

    this.geometry = createOceanGeometry({
      resolution: this.options.resolution ?? q.segments,
      extent: this.options.extent ?? 6000,
      lodPower: this.options.lodPower ?? 3.0,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'WaterSurface';

    this.object.add(this.sky);
    this.object.add(this.mesh);
  }

  _teardown() {
    this.object.remove(this.sky);
    this.object.remove(this.mesh);
    this.ocean.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
  }

  /** Set the sun position from elevation & azimuth (degrees). */
  setSun(elevationDeg, azimuthDeg) {
    const el = elevationDeg * DEG;
    const az = azimuthDeg * DEG;
    const r = Math.cos(el);
    const dir = new Vector3(r * Math.cos(az), Math.sin(el), r * Math.sin(az)).normalize();
    this.skyUniforms.sunDirection.value.copy(dir);
    if (this.config) {
      this.config.sun.elevation = elevationDeg;
      this.config.sun.azimuth = azimuthDeg;
    }
    return this;
  }

  /**
   * Advance the simulation and sync to the camera.
   * @param {number} elapsed  absolute time in seconds (a monotonic clock)
   * @param {import('three').Camera} [camera]
   */
  update(elapsed, camera) {
    this._time.value = elapsed;
    this.ocean.update(elapsed);

    if (camera) {
      const { x, z } = camera.position;
      this.mesh.position.set(x, 0, z);
      this.waterUniforms.origin.value.set(x, z);
      this.sky.position.copy(camera.position);

      const waterY = this.ocean.getHeight(x, z);
      this.submerged = camera.position.y < waterY;
      const target = this.submerged ? 1 : 0;
      const cur = this.waterUniforms.submerged.value;
      this.waterUniforms.submerged.value = cur + (target - cur) * 0.25;
    }
    return this;
  }

  /** Water surface height (world Y) at world (x, z). */
  getHeight(x, z) {
    return this.ocean.getHeight(x, z);
  }

  /** Surface height + normal at world (x, z). */
  getWaterInfo(x, z) {
    return this.ocean.getWaterInfo(x, z);
  }

  /** Create a buoyancy controller bound to this ocean. */
  createBuoyancy() {
    return new Buoyancy(this.ocean);
  }

  /** Underwater fog descriptor for the active preset ({ color, density }). */
  get fog() {
    return this.config.fog;
  }

  /** The shared elapsed-time uniform node — pass to a matching ocean floor. */
  get timeNode() {
    return this._time;
  }

  /** Swap to a different preset (or config object), rebuilding the simulation. */
  setPreset(preset) {
    this.config = JSON.parse(JSON.stringify(resolvePreset(preset)));
    this._teardown();
    this._build();
    return this;
  }

  /** Change the quality level ('low' | 'medium' | 'high' | 'ultra'), rebuilding. */
  setQuality(quality) {
    this.quality = quality;
    this._teardown();
    this._build();
    return this;
  }

  dispose() {
    this._teardown();
  }
}

// Public building blocks for advanced users.
export { Ocean } from './core/ocean.js';
export { OceanCascade } from './core/cascade.js';
export { FFT, fft2d } from './core/fft.js';
export {
  buildInitialSpectrum,
  jonswap,
  dispersion,
  GRAVITY,
} from './core/spectrum.js';
export { createSkyUniforms, createSky, skyColor } from './material/sky.js';
export { createWaterMaterial } from './material/waterMaterial.js';
export { createOceanFloor } from './material/oceanFloor.js';
export { createOceanGeometry } from './geometry/oceanPlane.js';
export { Buoyancy } from './physics/buoyancy.js';
export { PRESETS, PRESET_NAMES, resolvePreset } from './presets.js';
export { QUALITY_LEVELS, QUALITY_NAMES, resolveQuality } from './quality.js';

export default Water;
