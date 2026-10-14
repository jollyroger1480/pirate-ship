/**
 * Shared procedural noise for TSL shaders — a hash-based value noise and a
 * 4-octave FBM. Kept dependency-free (no MaterialX) so it behaves identically
 * on the WebGPU and WebGL backends.
 */
import { Fn, vec2, sin, dot, floor, fract, mix } from 'three/tsl';

export const hash21 = /*#__PURE__*/ Fn(([p]) =>
  fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453))
);

export const valueNoise = /*#__PURE__*/ Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0)); // smoothstep weights
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

export const fbm = /*#__PURE__*/ Fn(([p]) => {
  const o1 = valueNoise(p).mul(0.5);
  const o2 = valueNoise(p.mul(2.0)).mul(0.25);
  const o3 = valueNoise(p.mul(4.0)).mul(0.125);
  const o4 = valueNoise(p.mul(8.0)).mul(0.0625);
  return o1.add(o2).add(o3).add(o4);
});
