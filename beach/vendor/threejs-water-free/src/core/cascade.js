/**
 * A single FFT ocean "cascade": one frequency band of the wave spectrum,
 * tiled over a square patch of `patchSize` metres at `size`×`size` resolution.
 *
 * Each frame the cascade:
 *   1. evolves the initial spectrum h0 in time:  h(k,t) = h0·e^{iωt} + h0(-k)*·e^{-iωt}
 *   2. inverse-FFTs three packed spectra to obtain the height field, the
 *      horizontal (choppy) displacement, and the surface slope, and
 *   3. derives a foam mask from the Jacobian of the displacement (wave folding).
 *
 * The packing trick exploits FFT linearity: since each output field is real,
 * two real fields can be recovered from a single complex inverse transform —
 * e.g. IFFT(Dx_spec + i·Dz_spec) yields Dx in the real part and Dz in the
 * imaginary part. This halves the number of transforms per frame.
 *
 * Results are written into interleaved RGBA Float32Arrays ready to upload to a
 * GPU texture:
 *   displacement: [Dx, height, Dz, foam]
 *   slope:        [∂h/∂x, ∂h/∂z, 0, 1]
 */
import { FFT, fft2d } from './fft.js';
import { buildInitialSpectrum } from './spectrum.js';

export class OceanCascade {
  constructor(params) {
    const N = params.size;
    this.size = N;
    this.patchSize = params.patchSize;
    this.choppiness = params.choppiness ?? 1.0;
    this.foamThreshold = params.foamThreshold ?? 0.5;

    const spec = buildInitialSpectrum(params);
    this.h0 = spec.h0;
    this.h0mc = spec.h0mc;
    this.omega = spec.omega;

    // Precompute wave-number components and their normalised forms.
    const dk = (2 * Math.PI) / this.patchSize;
    this.kx = new Float32Array(N * N);
    this.kz = new Float32Array(N * N);
    this.kxn = new Float32Array(N * N);
    this.kzn = new Float32Array(N * N);
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = m * N + n;
        const kx = (m - N / 2) * dk;
        const kz = (n - N / 2) * dk;
        const k = Math.hypot(kx, kz);
        this.kx[i] = kx;
        this.kz[i] = kz;
        if (k > 1e-6) {
          this.kxn[i] = kx / k;
          this.kzn[i] = kz / k;
        }
      }
    }

    // Reusable complex working buffers.
    this.htR = new Float32Array(N * N); // height spectrum / field
    this.htI = new Float32Array(N * N);
    this.pR = new Float32Array(N * N); // packed displacement Dx + i·Dz
    this.pI = new Float32Array(N * N);
    this.qR = new Float32Array(N * N); // packed slope sx + i·sz
    this.qI = new Float32Array(N * N);

    // Output fields (RGBA, row-major).
    this.displacement = new Float32Array(N * N * 4);
    this.slope = new Float32Array(N * N * 4);

    this.fft = new FFT(N);

    // Normalise so the realised significant wave height matches the request,
    // independent of discrete-transform scaling conventions.
    this.norm = 1;
    this.update(0);
    let sumSq = 0;
    for (let i = 0; i < N * N; i++) {
      const h = this.displacement[i * 4 + 1];
      sumSq += h * h;
    }
    const rms = Math.sqrt(sumSq / (N * N));
    const targetRms = (params.waveHeight ?? 2) / 4;
    this.norm = rms > 1e-6 ? targetRms / rms : 1;
  }

  /** Evolve the spectrum to time `t` (seconds) and synthesise all fields. */
  update(t) {
    const N = this.size;
    const { h0, h0mc, omega, htR, htI, pR, pI, qR, qI, kx, kz, kxn, kzn } = this;

    // 1. Time evolution + build the three packed spectra.
    for (let i = 0; i < N * N; i++) {
      const w = omega[i] * t;
      const c = Math.cos(w);
      const s = Math.sin(w);

      const ar = h0[i * 2];
      const ai = h0[i * 2 + 1];
      const br = h0mc[i * 2];
      const bi = h0mc[i * 2 + 1];

      // h(k,t) = (ar+i·ai)(c+i·s) + (br+i·bi)(c−i·s)
      const htr = ar * c - ai * s + br * c + bi * s;
      const hti = ar * s + ai * c + bi * c - br * s;
      htR[i] = htr;
      htI[i] = hti;

      // Displacement spectrum −i·(k/|k|)·h, packed as Dx + i·Dz.
      const nx = kxn[i];
      const nz = kzn[i];
      pR[i] = nx * hti + nz * htr;
      pI[i] = -nx * htr + nz * hti;

      // Slope spectrum i·k·h, packed as ∂h/∂x + i·∂h/∂z.
      const sx = kx[i];
      const sz = kz[i];
      qR[i] = -sx * hti - sz * htr;
      qI[i] = sx * htr - sz * hti;
    }

    // 2. Inverse transforms.
    fft2d(htR, htI, N, true, this.fft); // height -> htR
    fft2d(pR, pI, N, true, this.fft); // Dx -> pR, Dz -> pI
    fft2d(qR, qI, N, true, this.fft); // slopeX -> qR, slopeZ -> qI

    const lambda = this.choppiness;
    const norm = this.norm;
    const disp = this.displacement;
    const slope = this.slope;

    // 3. Pack height + horizontal displacement + slope into output arrays.
    for (let i = 0; i < N * N; i++) {
      disp[i * 4] = pR[i] * lambda * norm; // Dx
      disp[i * 4 + 1] = htR[i] * norm; // height
      disp[i * 4 + 2] = pI[i] * lambda * norm; // Dz
      // alpha (foam) filled below
      slope[i * 4] = qR[i] * norm; // ∂h/∂x
      slope[i * 4 + 1] = qI[i] * norm; // ∂h/∂z
      slope[i * 4 + 2] = 0;
      slope[i * 4 + 3] = 1;
    }

    // 4. Foam from the Jacobian of the horizontal displacement map.
    const dx = this.patchSize / N;
    const inv2dx = 1 / (2 * dx);
    for (let m = 0; m < N; m++) {
      const mp = ((m + 1) % N) * N;
      const mm = ((m - 1 + N) % N) * N;
      const mc = m * N;
      for (let n = 0; n < N; n++) {
        const np = (n + 1) % N;
        const nn = (n - 1 + N) % N;

        const dDxdx = (disp[(mp + n) * 4] - disp[(mm + n) * 4]) * inv2dx;
        const dDzdz =
          (disp[(mc + np) * 4 + 2] - disp[(mc + nn) * 4 + 2]) * inv2dx;
        const dDxdz =
          (disp[(mc + np) * 4] - disp[(mc + nn) * 4]) * inv2dx;
        const dDzdx =
          (disp[(mp + n) * 4 + 2] - disp[(mm + n) * 4 + 2]) * inv2dx;

        const jxx = 1 + dDxdx;
        const jzz = 1 + dDzdz;
        const jacobian = jxx * jzz - dDxdz * dDzdx;

        // Folding (Jacobian < 1) accumulates foam.
        disp[(mc + n) * 4 + 3] = Math.max(0, this.foamThreshold - jacobian);
      }
    }
  }
}
