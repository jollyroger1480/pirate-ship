/**
 * Oceanographic wave spectra and the initial frequency-domain field (h0).
 *
 * We use the JONSWAP spectrum (Hasselmann et al., 1973) — the standard model
 * for wind-driven seas with limited fetch — combined with a cosine-squared
 * directional spreading function. The 1-D frequency spectrum S(ω) is mapped
 * into the 2-D wave-number domain via the deep-water dispersion relation, then
 * seeded with complex Gaussian noise following Tessendorf's "Simulating Ocean
 * Water" (2001) to produce the initial spectrum h0(k).
 */

export const GRAVITY = 9.81;

/** Deterministic PRNG (mulberry32) so a given seed reproduces the same ocean. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pair of independent N(0,1) samples via Box–Muller. */
function gaussianPair(rng) {
  const u1 = Math.max(rng(), 1e-7);
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

/**
 * JONSWAP energy density at angular frequency ω.
 * @param {number} omega   angular frequency (rad/s)
 * @param {number} omegaP  peak angular frequency
 * @param {number} alpha   Phillips/equilibrium constant
 * @param {number} gamma   peak enhancement factor (≈3.3 for North Sea)
 */
export function jonswap(omega, omegaP, alpha, gamma) {
  if (omega <= 1e-6) return 0;
  const sigma = omega <= omegaP ? 0.07 : 0.09;
  const peak = Math.exp(
    -((omega - omegaP) * (omega - omegaP)) /
      (2 * sigma * sigma * omegaP * omegaP)
  );
  const base =
    ((alpha * GRAVITY * GRAVITY) / Math.pow(omega, 5)) *
    Math.exp(-1.25 * Math.pow(omegaP / omega, 4));
  return base * Math.pow(gamma, peak);
}

/** Deep-water dispersion ω = sqrt(g·k), or finite-depth if `depth` is finite. */
export function dispersion(k, depth = Infinity) {
  if (!isFinite(depth)) return Math.sqrt(GRAVITY * k);
  return Math.sqrt(GRAVITY * k * Math.tanh(k * depth));
}

/**
 * Build the initial spectrum h0 and per-texel angular frequency ω(k).
 *
 * Returns Float32Arrays sized N*N*2 (interleaved complex) for h0 and the
 * mirrored conjugate h0(-k)*, plus omega[N*N]. The field is normalised so that
 * the significant wave height ≈ `waveHeight` metres regardless of the spectrum
 * scaling constants, giving physically meaningful, predictable wave sizes.
 *
 * @param {object} o
 * @param {number} o.size        grid resolution N (power of two)
 * @param {number} o.patchSize   spatial extent of the tile L (metres)
 * @param {number} o.windSpeed   wind speed at 10 m (m/s)
 * @param {number} o.windDir     wind direction (radians)
 * @param {number} o.fetch       fetch length (m) — distance wind has blown
 * @param {number} o.gamma       JONSWAP peak enhancement
 * @param {number} o.depth       water depth (m), Infinity for deep water
 * @param {number} o.waveHeight  target significant wave height Hs (m)
 * @param {number} o.shortWaves  suppression length for tiny capillary waves (m)
 * @param {number} o.seed        PRNG seed
 */
export function buildInitialSpectrum(o) {
  const {
    size: N,
    patchSize: L,
    windSpeed: U,
    windDir,
    fetch,
    gamma = 3.3,
    depth = Infinity,
    waveHeight = 2,
    shortWaves = 0,
    seed = 1,
  } = o;

  const h0 = new Float32Array(N * N * 2);
  const h0mc = new Float32Array(N * N * 2); // conj(h0(-k))
  const omega = new Float32Array(N * N);

  const rng = mulberry32(seed);
  const dk = (2 * Math.PI) / L;

  // JONSWAP peak frequency and alpha from wind speed & fetch.
  const omegaP = 22 * Math.pow((GRAVITY * GRAVITY) / (U * fetch), 1 / 3);
  const alpha = 0.076 * Math.pow((U * U) / (GRAVITY * fetch), 0.22);

  // First pass: amplitudes and Gaussian seeds, tracking total variance.
  const amp = new Float32Array(N * N);
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      const kx = (m - N / 2) * dk;
      const kz = (n - N / 2) * dk;
      const k = Math.hypot(kx, kz);

      if (k < 1e-6) {
        omega[i] = 0;
        amp[i] = 0;
        continue;
      }

      const w = dispersion(k, depth);
      omega[i] = w;

      // dω/dk for the ω→k spectral Jacobian (deep water: g/(2ω)).
      const dOmegaDk = GRAVITY / (2 * w);

      // Directional spreading: cos² lobe centred on the wind direction.
      const theta = Math.atan2(kz, kx);
      let dTheta = theta - windDir;
      dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta)); // wrap to (-π,π]
      let D = 0;
      if (Math.abs(dTheta) < Math.PI / 2) {
        const c = Math.cos(dTheta);
        D = (2 / Math.PI) * c * c;
      }

      const S = jonswap(w, omegaP, alpha, gamma);
      // 2-D wave-number spectrum: Ψ(k) = S(ω)·D(θ)·(dω/dk)/k.
      let psi = (S * D * dOmegaDk) / k;

      // Suppress sub-grid capillary waves to avoid aliasing.
      if (shortWaves > 0) psi *= Math.exp(-k * k * shortWaves * shortWaves);

      // Tessendorf h0 magnitude before the Gaussian draw.
      amp[i] = Math.sqrt(psi * dk * dk);
    }
  }

  // Compute the raw variance so we can normalise to the target Hs.
  let variance = 0;
  for (let i = 0; i < N * N; i++) variance += amp[i] * amp[i];
  // Significant wave height Hs = 4·sqrt(variance). Scale so Hs == waveHeight.
  const norm = variance > 0 ? waveHeight / 4 / Math.sqrt(variance) : 0;

  // Second pass: apply Gaussian seeds and normalisation.
  const SQRT1_2 = Math.SQRT1_2;
  for (let i = 0; i < N * N; i++) {
    const [gr, gi] = gaussianPair(rng);
    const a = amp[i] * norm * SQRT1_2;
    h0[i * 2] = gr * a;
    h0[i * 2 + 1] = gi * a;
  }

  // Precompute conj(h0(-k)) using the mirrored index (-k ↔ (N-m, N-n) mod N).
  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const i = m * N + n;
      const mm = (N - m) % N;
      const nn = (N - n) % N;
      const j = mm * N + nn;
      h0mc[i * 2] = h0[j * 2];
      h0mc[i * 2 + 1] = -h0[j * 2 + 1];
    }
  }

  return { h0, h0mc, omega, omegaP, alpha };
}

export { mulberry32 };
