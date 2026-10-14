/**
 * Iterative radix-2 Cooley–Tukey FFT (in-place, decimation-in-time).
 *
 * Operates on separate real / imaginary `Float32Array`s for cache friendliness
 * and to avoid per-element object allocation. The same instance can be reused
 * across frames; twiddle factors and the bit-reversal table are precomputed.
 *
 * This is the numerical heart of the ocean simulation and is fully unit-tested
 * (round-trip, linearity, Parseval, and agreement with a naive DFT) in
 * `test/fft.test.mjs` — it has no dependency on Three.js or the GPU.
 */
export class FFT {
  constructor(n) {
    if (n < 2 || (n & (n - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two >= 2, got ${n}`);
    }
    this.n = n;

    // Bit-reversal permutation table.
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r >>> 0;
    }

    // Twiddle factors for the forward transform: W_n^i = exp(-2πi · i/n).
    const half = n >> 1;
    this.cos = new Float32Array(half);
    this.sin = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / n;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
  }

  /**
   * In-place 1-D transform.
   * @param {Float32Array} re real components (length n)
   * @param {Float32Array} im imaginary components (length n)
   * @param {boolean} inverse run the inverse transform (includes 1/n scaling)
   */
  transform(re, im, inverse = false) {
    const n = this.n;
    const rev = this.rev;
    const cos = this.cos;
    const sin = this.sin;

    // Reorder into bit-reversed positions.
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len; // index stride into the twiddle table
      for (let i = 0; i < n; i += len) {
        for (let k = 0, idx = 0; k < half; k++, idx += step) {
          const wr = cos[idx];
          // Inverse transform uses the conjugate twiddle (positive exponent).
          const wi = inverse ? -sin[idx] : sin[idx];
          const a = i + k;
          const b = a + half;
          const xr = re[b];
          const xi = im[b];
          const tr = wr * xr - wi * xi;
          const ti = wr * xi + wi * xr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] = re[a] + tr;
          im[a] = im[a] + ti;
        }
      }
    }

    if (inverse) {
      const inv = 1 / n;
      for (let i = 0; i < n; i++) {
        re[i] *= inv;
        im[i] *= inv;
      }
    }
  }
}

/**
 * In-place 2-D transform of an n×n complex field stored row-major in `re`/`im`
 * (each length n*n). Performs the transform along rows then columns. For the
 * inverse, the per-axis 1/n scaling composes to the correct 1/n² overall.
 *
 * @param {Float32Array} re
 * @param {Float32Array} im
 * @param {number} n
 * @param {boolean} inverse
 * @param {FFT} [fft] reusable 1-D engine (created if omitted)
 */
export function fft2d(re, im, n, inverse = false, fft = new FFT(n)) {
  const lineR = new Float32Array(n);
  const lineI = new Float32Array(n);

  // Rows.
  for (let y = 0; y < n; y++) {
    const off = y * n;
    for (let x = 0; x < n; x++) {
      lineR[x] = re[off + x];
      lineI[x] = im[off + x];
    }
    fft.transform(lineR, lineI, inverse);
    for (let x = 0; x < n; x++) {
      re[off + x] = lineR[x];
      im[off + x] = lineI[x];
    }
  }

  // Columns.
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      lineR[y] = re[y * n + x];
      lineI[y] = im[y * n + x];
    }
    fft.transform(lineR, lineI, inverse);
    for (let y = 0; y < n; y++) {
      re[y * n + x] = lineR[y];
      im[y * n + x] = lineI[y];
    }
  }
}
