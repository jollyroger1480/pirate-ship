/**
 * Eight ready-to-use ocean environments, from dead calm to violent storm.
 *
 * Each preset is a plain config object consumed by `Water`. They share a
 * schema (sun, sky, ocean cascades + Gerstner swell, water look, fog) so you
 * can clone and tweak any of them, or hand-write your own.
 */

const DEG = Math.PI / 180;

/**
 * Build the two FFT cascades (large waves + fine ripples) for a given sea state.
 */
function cascades({ size = 128, windSpeed, windDirDeg, hs, choppiness = 1, seed = 1 }) {
  const windDir = windDirDeg * DEG;
  return [
    {
      size,
      patchSize: 320,
      windSpeed,
      windDir,
      fetch: 100000,
      gamma: 3.3,
      waveHeight: hs * 0.86,
      choppiness,
      shortWaves: 0.4,
      foamThreshold: 0.92,
      seed,
    },
    {
      size,
      patchSize: 38,
      windSpeed: Math.max(4, windSpeed * 0.7),
      windDir: windDir + 0.35,
      fetch: 12000,
      gamma: 2.0,
      waveHeight: hs * 0.22,
      choppiness: choppiness * 1.3,
      shortWaves: 0.06,
      foamThreshold: 0.86,
      seed: seed + 17,
    },
  ];
}

function swell(dirDeg, wavelength, amplitude, steepness = 0.45, speed = 1) {
  const a = dirDeg * DEG;
  return { direction: [Math.cos(a), Math.sin(a)], wavelength, amplitude, steepness, speed };
}

export const PRESETS = {
  lagoon: {
    name: 'Lagoon',
    sun: { elevation: 62, azimuth: 145, color: 0xfff6e6, intensity: 1.25 },
    sky: {
      zenithColor: 0x1f93d6, horizonColor: 0xcdeef0, groundColor: 0x2f7d86,
      rayleigh: 1.0, cloudCoverage: 0.28, cloudColor: 0xffffff, cloudSpeed: 0.007, exposure: 1.08,
    },
    ocean: { size: 128, cascades: cascades({ windSpeed: 5.5, windDirDeg: 25, hs: 0.55, choppiness: 0.85, seed: 91 }),
      gerstner: [swell(25, 60, 0.26, 0.4), swell(50, 30, 0.12, 0.38)] },
    water: { waterColor: 0x078791, absorptionColor: [0.34, 0.07, 0.03], foamColor: 0xffffff, sssColor: 0x2fd6a8,
      fresnelF0: 0.02, refractionStrength: 1.1, shoreDepth: 1.7, shoreFoamStrength: 1.15, foamScale: 1.2, crestFoam: 0.25, sunShininess: 800, sssStrength: 0.6 },
    floor: { sandShallow: 0xeeddb0, sandDeep: 0xa18f62, causticColor: 0xf2fff8, causticIntensity: 1.8 },
    fog: { color: 0x078791, density: 0.006 },
  },

  calm: {
    name: 'Calm',
    sun: { elevation: 35, azimuth: 140, color: 0xfff1da, intensity: 1.0 },
    sky: {
      zenithColor: 0x2a6fc0, horizonColor: 0xcfe4f5, groundColor: 0x35506a,
      rayleigh: 1.0, cloudCoverage: 0.25, cloudColor: 0xffffff, cloudSpeed: 0.006, exposure: 1.0,
    },
    ocean: { size: 128, cascades: cascades({ windSpeed: 5, windDirDeg: 30, hs: 0.45, choppiness: 0.8, seed: 11 }),
      gerstner: [swell(30, 120, 0.16, 0.3), swell(55, 70, 0.07, 0.3)] },
    water: { waterColor: 0x0d5f72, absorptionColor: [0.28, 0.07, 0.04], foamColor: 0xffffff, sssColor: 0x1a9b7a,
      fresnelF0: 0.02, refractionStrength: 1.0, shoreDepth: 1.6, shoreFoamStrength: 0.9, foamScale: 1.3, crestFoam: 0.2, sunShininess: 820, sssStrength: 0.5 },
    floor: { sandShallow: 0xd8c596, sandDeep: 0x8c7a52, causticColor: 0xeafff6, causticIntensity: 0.85 },
    fog: { color: 0x0d5f72, density: 0.009 },
  },

  clear: {
    name: 'Clear Day',
    sun: { elevation: 55, azimuth: 120, color: 0xfff6e8, intensity: 1.15 },
    sky: {
      zenithColor: 0x1f63bf, horizonColor: 0xbcd9f2, groundColor: 0x33506b,
      rayleigh: 1.1, cloudCoverage: 0.4, cloudColor: 0xffffff, cloudSpeed: 0.01, exposure: 1.05,
    },
    ocean: { size: 128, cascades: cascades({ windSpeed: 8, windDirDeg: 40, hs: 0.95, choppiness: 1.0, seed: 3 }),
      gerstner: [swell(40, 140, 0.26, 0.35), swell(70, 80, 0.12, 0.35)] },
    water: { waterColor: 0x0a6378, absorptionColor: [0.26, 0.06, 0.035], foamColor: 0xffffff, sssColor: 0x1aa07f,
      fresnelF0: 0.02, refractionStrength: 1.0, shoreDepth: 1.7, shoreFoamStrength: 1.0, foamScale: 1.7, crestFoam: 0.4, sunShininess: 620, sssStrength: 0.6 },
    floor: { sandShallow: 0xd6c290, sandDeep: 0x85734d, causticColor: 0xe6fff4, causticIntensity: 0.8 },
    fog: { color: 0x0a6378, density: 0.01 },
  },

  windy: {
    name: 'Windy',
    sun: { elevation: 42, azimuth: 100, color: 0xfdf0e0, intensity: 1.0 },
    sky: {
      zenithColor: 0x3a6f9e, horizonColor: 0xc3cdd6, groundColor: 0x3a4753,
      rayleigh: 0.85, cloudCoverage: 0.62, cloudColor: 0xf0f2f5, cloudSpeed: 0.02, exposure: 0.98,
    },
    ocean: { size: 128, cascades: cascades({ windSpeed: 14, windDirDeg: 50, hs: 2.2, choppiness: 1.25, seed: 7 }),
      gerstner: [swell(50, 180, 0.55, 0.45), swell(80, 90, 0.22, 0.45)] },
    water: { waterColor: 0x0c5560, absorptionColor: [0.32, 0.11, 0.07], foamColor: 0xffffff, sssColor: 0x158a6a,
      fresnelF0: 0.02, refractionStrength: 0.9, shoreDepth: 1.9, shoreFoamStrength: 1.2, foamScale: 2.3, crestFoam: 0.6, sunShininess: 420, sssStrength: 0.55 },
    floor: { sandShallow: 0xc8b585, sandDeep: 0x6e5f40, causticColor: 0xdef7ee, causticIntensity: 0.6 },
    fog: { color: 0x0c5560, density: 0.013 },
  },

  storm: {
    name: 'Storm',
    sun: { elevation: 14, azimuth: 80, color: 0x9fb0c0, intensity: 0.55 },
    sky: {
      zenithColor: 0x2a3340, horizonColor: 0x586671, groundColor: 0x222a31,
      rayleigh: 0.5, cloudCoverage: 0.9, cloudColor: 0x9aa4ad, cloudSpeed: 0.05, exposure: 0.82,
    },
    ocean: { size: 128, cascades: cascades({ windSpeed: 22, windDirDeg: 60, hs: 4.8, choppiness: 1.5, seed: 23 }),
      gerstner: [swell(60, 240, 1.3, 0.55), swell(95, 120, 0.55, 0.55), swell(40, 70, 0.22, 0.5)] },
    water: { waterColor: 0x0b3540, absorptionColor: [0.42, 0.20, 0.14], foamColor: 0xeef2f4, sssColor: 0x14705a,
      fresnelF0: 0.02, refractionStrength: 0.7, shoreDepth: 2.4, shoreFoamStrength: 1.4, foamScale: 3.0, crestFoam: 0.9, sunShininess: 260, sssStrength: 0.4 },
    floor: { sandShallow: 0x9a8a64, sandDeep: 0x4e4530, causticColor: 0xcfe6dd, causticIntensity: 0.3 },
    fog: { color: 0x0b3540, density: 0.02 },
  },

  sunset: {
    name: 'Sunset',
    sun: { elevation: 6, azimuth: 95, color: 0xff8a3c, intensity: 1.3 },
    sky: {
      zenithColor: 0x2b3a76, horizonColor: 0xff9d5c, groundColor: 0x402b34,
      rayleigh: 1.4, cloudCoverage: 0.5, cloudColor: 0xffd9b0, cloudSpeed: 0.012, exposure: 1.1,
    },
    ocean: { size: 128, cascades: cascades({ windSpeed: 9, windDirDeg: 95, hs: 1.3, choppiness: 1.1, seed: 41 }),
      gerstner: [swell(95, 150, 0.36, 0.4), swell(120, 85, 0.16, 0.4)] },
    water: { waterColor: 0x244055, absorptionColor: [0.30, 0.16, 0.12], foamColor: 0xffe6cf, sssColor: 0xc26a3a,
      fresnelF0: 0.02, refractionStrength: 0.9, shoreDepth: 1.8, shoreFoamStrength: 1.0, foamScale: 1.7, crestFoam: 0.4, sunShininess: 520, sssStrength: 0.85 },
    floor: { sandShallow: 0xc7a484, sandDeep: 0x6f5340, causticColor: 0xffe7cf, causticIntensity: 0.45 },
    fog: { color: 0x244055, density: 0.011 },
  },

  tropical: {
    name: 'Tropical',
    sun: { elevation: 68, azimuth: 150, color: 0xfffaf0, intensity: 1.2 },
    sky: {
      zenithColor: 0x179fd6, horizonColor: 0xc9f3ef, groundColor: 0x2f7d86,
      rayleigh: 1.0, cloudCoverage: 0.3, cloudColor: 0xffffff, cloudSpeed: 0.008, exposure: 1.1,
    },
    ocean: { size: 128, cascades: cascades({ windSpeed: 7.5, windDirDeg: 20, hs: 1.0, choppiness: 1.1, seed: 55 }),
      gerstner: [swell(20, 72, 0.5, 0.5), swell(48, 34, 0.22, 0.48)] },
    water: { waterColor: 0x048296, absorptionColor: [0.36, 0.085, 0.045], foamColor: 0xffffff, sssColor: 0x2fd6a8,
      fresnelF0: 0.02, refractionStrength: 1.2, shoreDepth: 2.0, shoreFoamStrength: 1.1, foamScale: 1.5, crestFoam: 0.35, sunShininess: 740, sssStrength: 0.7 },
    floor: { sandShallow: 0xefdcab, sandDeep: 0xab9560, causticColor: 0xf2fff9, causticIntensity: 1.8 },
    fog: { color: 0x048296, density: 0.006 },
  },

  arctic: {
    name: 'Arctic',
    sun: { elevation: 18, azimuth: 70, color: 0xeaf2ff, intensity: 0.85 },
    sky: {
      zenithColor: 0x4a7bb0, horizonColor: 0xd6e6f2, groundColor: 0x6a7b8a,
      rayleigh: 0.9, cloudCoverage: 0.55, cloudColor: 0xf4f8fc, cloudSpeed: 0.015, exposure: 1.0,
    },
    ocean: { size: 128, cascades: cascades({ windSpeed: 12, windDirDeg: 45, hs: 1.6, choppiness: 1.1, seed: 67 }),
      gerstner: [swell(45, 160, 0.4, 0.4), swell(75, 85, 0.18, 0.4)] },
    water: { waterColor: 0x1a5566, absorptionColor: [0.30, 0.12, 0.10], foamColor: 0xf4fbff, sssColor: 0x2a8fa0,
      fresnelF0: 0.02, refractionStrength: 0.85, shoreDepth: 2.0, shoreFoamStrength: 1.1, foamScale: 2.1, crestFoam: 0.6, sunShininess: 470, sssStrength: 0.45 },
    floor: { sandShallow: 0xb9bcc0, sandDeep: 0x5e6a72, causticColor: 0xdcecf4, causticIntensity: 0.4 },
    fog: { color: 0x1a5566, density: 0.014 },
  },

  night: {
    name: 'Night',
    sun: { elevation: 22, azimuth: 200, color: 0xaecbff, intensity: 0.5 },
    sky: {
      zenithColor: 0x05080f, horizonColor: 0x16243a, groundColor: 0x05080d,
      rayleigh: 0.6, cloudCoverage: 0.4, cloudColor: 0x2a3550, cloudSpeed: 0.006, exposure: 0.9,
    },
    ocean: { size: 128, cascades: cascades({ windSpeed: 10, windDirDeg: 200, hs: 1.4, choppiness: 1.1, seed: 88 }),
      gerstner: [swell(200, 150, 0.38, 0.4), swell(230, 85, 0.16, 0.4)] },
    water: { waterColor: 0x06222e, absorptionColor: [0.38, 0.18, 0.12], foamColor: 0xc8d6e6, sssColor: 0x0e4a52,
      fresnelF0: 0.02, refractionStrength: 0.8, shoreDepth: 1.9, shoreFoamStrength: 1.0, foamScale: 1.9, crestFoam: 0.5, sunShininess: 900, sssStrength: 0.3 },
    floor: { sandShallow: 0x3a4350, sandDeep: 0x141c26, causticColor: 0x9fd0d8, causticIntensity: 0.35 },
    fog: { color: 0x06222e, density: 0.016 },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** Resolve a preset by name (or pass a config object through unchanged). */
export function resolvePreset(p) {
  if (typeof p === 'string') {
    const preset = PRESETS[p];
    if (!preset) throw new Error(`Unknown preset "${p}". Available: ${PRESET_NAMES.join(', ')}`);
    return preset;
  }
  return p;
}
