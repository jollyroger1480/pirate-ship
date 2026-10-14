/**
 * Quality presets — one knob that scales the expensive parts of the renderer.
 * Each level both *sizes* the work and *compiles features in or out* of the
 * shader, so a low level isn't just zeroed effects — the expensive FBM/texture
 * sampling code is never generated, which is what keeps weak GPUs alive.
 *
 *   • simSize    — FFT grid resolution per cascade (CPU cost ∝ N²·logN / frame)
 *   • segments   — water surface mesh subdivisions
 *   • detail     — animated micro-normal strength (0 = code removed)
 *   • sparkle    — sun-glitter strength (0 = code removed)
 *   • refraction — full screen-space refraction (offset + validity) vs a single
 *                  straight transmission sample
 *   • foamDetail — turbulent multi-scale foam texture vs a cheap single-octave
 *   • clouds     — animated FBM clouds in the sky + reflections
 *
 * `low` targets integrated GPUs / the WebGL2 fallback; `ultra` is a showcase
 * (256² FFT is heavy on the CPU). Use `new Water({ quality })` or
 * `water.setQuality(...)`.
 */
export const QUALITY_LEVELS = {
  low: { simSize: 64, segments: 200, detail: 0, sparkle: 0, refraction: false, foamDetail: false, clouds: false },
  medium: { simSize: 128, segments: 320, detail: 0.4, sparkle: 1.6, refraction: true, foamDetail: false, clouds: true },
  high: { simSize: 128, segments: 440, detail: 0.6, sparkle: 2.6, refraction: true, foamDetail: true, clouds: true },
  ultra: { simSize: 256, segments: 600, detail: 0.75, sparkle: 3.2, refraction: true, foamDetail: true, clouds: true },
};

export const QUALITY_NAMES = Object.keys(QUALITY_LEVELS);

export function resolveQuality(q) {
  if (typeof q === 'object' && q) return q;
  const level = QUALITY_LEVELS[q];
  if (!level) {
    throw new Error(`Unknown quality "${q}". Available: ${QUALITY_NAMES.join(', ')}`);
  }
  return level;
}
