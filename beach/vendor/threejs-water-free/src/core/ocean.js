/**
 * Ocean — orchestrates the FFT cascades and the analytical Gerstner swell,
 * owns the GPU data textures the water material samples, and exposes CPU-side
 * water sampling for buoyancy and gameplay queries.
 *
 * The simulation runs on the CPU (a fully verifiable, deterministic FFT) and
 * uploads displacement/slope textures to the GPU each frame. This keeps the
 * exact same wave field available to both the renderer and physics — buoyant
 * objects float on precisely the water you see.
 */
import {
  DataTexture,
  RGBAFormat,
  FloatType,
  LinearFilter,
  RepeatWrapping,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { OceanCascade } from './cascade.js';
import { GRAVITY } from './spectrum.js';

function makeFieldTexture(data, size) {
  const tex = new DataTexture(data, size, size, RGBAFormat, FloatType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// Bilinear lookup of one channel from an RGBA Float32 field with wrap-around.
function sampleField(field, size, u, v, channel) {
  let fx = u * size - 0.5;
  let fy = v * size - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const ix0 = ((x0 % size) + size) % size;
  const iy0 = ((y0 % size) + size) % size;
  const ix1 = (ix0 + 1) % size;
  const iy1 = (iy0 + 1) % size;
  const c = channel;
  const a = field[(iy0 * size + ix0) * 4 + c];
  const b = field[(iy0 * size + ix1) * 4 + c];
  const d = field[(iy1 * size + ix0) * 4 + c];
  const e = field[(iy1 * size + ix1) * 4 + c];
  const top = a + (b - a) * tx;
  const bot = d + (e - d) * tx;
  return top + (bot - top) * ty;
}

export class Ocean {
  /**
   * @param {object} config
   * @param {Array<object>} config.cascades  cascade parameter objects
   * @param {Array<object>} [config.gerstner] analytical swell waves
   */
  constructor(config) {
    this.cascades = config.cascades.map((c) => new OceanCascade(c));

    this.displacementTextures = this.cascades.map((c) =>
      makeFieldTexture(c.displacement, c.size)
    );
    this.slopeTextures = this.cascades.map((c) =>
      makeFieldTexture(c.slope, c.size)
    );

    // Analytical Gerstner swell — large-scale, long-period motion that an FFT
    // tile cannot represent without an impractically large patch.
    this.gerstner = (config.gerstner ?? []).map((g) => {
      const dir = new Vector2(g.direction[0], g.direction[1]).normalize();
      const k = (2 * Math.PI) / g.wavelength;
      return {
        dirX: dir.x,
        dirY: dir.y,
        k,
        amplitude: g.amplitude,
        omega: Math.sqrt(GRAVITY * k) * (g.speed ?? 1),
        steepness: g.steepness ?? 0.5,
      };
    });

    this.time = 0;
    this._n = new Vector3();
  }

  /** Advance and resynthesise the ocean to absolute time `t` (seconds). */
  update(t) {
    this.time = t;
    for (let i = 0; i < this.cascades.length; i++) {
      this.cascades[i].update(t);
      this.displacementTextures[i].needsUpdate = true;
      this.slopeTextures[i].needsUpdate = true;
    }
  }

  /**
   * Water surface height (world Y) at world (x, z). Sums the FFT cascades and
   * the Gerstner swell. Horizontal choppy displacement is intentionally ignored
   * for the lookup, which is the standard, stable approximation for buoyancy.
   */
  getHeight(x, z) {
    let h = 0;
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      const u = x / c.patchSize;
      const v = z / c.patchSize;
      h += sampleField(c.displacement, c.size, u, v, 1);
    }
    for (const g of this.gerstner) {
      const phase = g.k * (g.dirX * x + g.dirY * z) - g.omega * this.time;
      h += g.amplitude * Math.sin(phase);
    }
    return h;
  }

  /**
   * Full surface sample at world (x, z): height plus an analytic normal built
   * from the FFT slope fields and the Gerstner derivatives.
   * @returns {{height:number, normal:Vector3}}
   */
  getWaterInfo(x, z) {
    let h = 0;
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      const u = x / c.patchSize;
      const v = z / c.patchSize;
      h += sampleField(c.displacement, c.size, u, v, 1);
      sx += sampleField(c.slope, c.size, u, v, 0);
      sz += sampleField(c.slope, c.size, u, v, 1);
    }
    for (const g of this.gerstner) {
      const phase = g.k * (g.dirX * x + g.dirY * z) - g.omega * this.time;
      h += g.amplitude * Math.sin(phase);
      const dcos = g.amplitude * g.k * Math.cos(phase);
      sx += g.dirX * dcos;
      sz += g.dirY * dcos;
    }
    this._n.set(-sx, 1, -sz).normalize();
    return { height: h, normal: this._n.clone() };
  }

  dispose() {
    for (const t of this.displacementTextures) t.dispose();
    for (const t of this.slopeTextures) t.dispose();
  }
}
