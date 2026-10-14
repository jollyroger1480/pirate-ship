/**
 * Ocean surface geometry: a radial-LOD grid that lies flat in the XZ plane and
 * is meant to be re-centred on the camera every frame.
 *
 * Vertices are laid out on a unit [-1,1]² grid and then warped outward with a
 * power curve, concentrating triangles near the viewer and stretching the
 * remaining geometry out to `extent` so the ocean reaches the horizon without a
 * uniform-grid's vertex cost. This is the clipmap idea in its simplest honest
 * form — detail where you look, coverage everywhere else.
 */
import { BufferGeometry, BufferAttribute } from 'three/webgpu';

/**
 * @param {object} [o]
 * @param {number} [o.resolution=320] grid subdivisions per axis
 * @param {number} [o.extent=6000]    half-size the grid reaches in world units
 * @param {number} [o.lodPower=3.0]   warp exponent (>1 = denser near centre)
 */
export function createOceanGeometry({ resolution = 320, extent = 6000, lodPower = 3.0 } = {}) {
  const n = resolution;
  const verts = (n + 1) * (n + 1);
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);

  let p = 0;
  for (let j = 0; j <= n; j++) {
    const v = (j / n) * 2 - 1; // [-1, 1]
    for (let i = 0; i <= n; i++) {
      const u = (i / n) * 2 - 1; // [-1, 1]
      // Power warp keeps the sign, pushes detail toward the centre.
      const x = Math.sign(u) * Math.pow(Math.abs(u), lodPower) * extent;
      const z = Math.sign(v) * Math.pow(Math.abs(v), lodPower) * extent;
      positions[p * 3] = x;
      positions[p * 3 + 1] = 0;
      positions[p * 3 + 2] = z;
      normals[p * 3] = 0;
      normals[p * 3 + 1] = 1;
      normals[p * 3 + 2] = 0;
      p++;
    }
  }

  const quads = n * n;
  const indices = new (verts > 65535 ? Uint32Array : Uint16Array)(quads * 6);
  let t = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  geo.setIndex(new BufferAttribute(indices, 1));
  // The shader displaces vertices arbitrarily; skip CPU frustum culling.
  geo.boundingSphere = null;
  return geo;
}
