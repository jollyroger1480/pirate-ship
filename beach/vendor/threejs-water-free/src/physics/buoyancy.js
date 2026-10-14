/**
 * Buoyancy — make objects float on the simulated ocean.
 *
 * Each registered body samples the water surface at one or more hull points
 * (taken from the object's bounding box by default, or supplied explicitly),
 * then is positioned at the averaged water height and tilted to match the
 * average surface normal. Because sampling reads the same CPU wave field the
 * GPU renders, objects bob on exactly the water you see — no separate physics
 * approximation of the waves.
 *
 * This is a lightweight kinematic floater (great for boats, buoys, debris). For
 * full rigid-body dynamics, feed `ocean.getWaterInfo()` into your physics
 * engine instead.
 */
import { Vector3, Quaternion, Box3 } from 'three/webgpu';

const _up = new Vector3(0, 1, 0);
const _p = new Vector3();
const _n = new Vector3();
const _q = new Quaternion();

export class Buoyancy {
  constructor(ocean) {
    this.ocean = ocean;
    this.bodies = [];
  }

  /**
   * Register an object to float.
   * @param {import('three').Object3D} object
   * @param {object} [opts]
   * @param {Vector3[]} [opts.points]  hull sample points in object-local space
   * @param {number} [opts.offset=0]   vertical offset from the water line
   * @param {number} [opts.damping=6]  position/orientation responsiveness
   * @param {number} [opts.alignment=1] 0 = stay upright, 1 = fully follow waves
   */
  add(object, opts = {}) {
    let points = opts.points;
    if (!points) {
      const box = new Box3().setFromObject(object);
      const min = box.min;
      const max = box.max;
      const cy = (min.y + max.y) / 2;
      // Four corners of the footprint, in local space.
      points = [
        new Vector3(min.x, cy, min.z),
        new Vector3(max.x, cy, min.z),
        new Vector3(min.x, cy, max.z),
        new Vector3(max.x, cy, max.z),
      ].map((pt) => object.worldToLocal(pt.clone()));
    }
    const body = {
      object,
      points,
      offset: opts.offset ?? 0,
      damping: opts.damping ?? 6,
      alignment: opts.alignment ?? 1,
    };
    this.bodies.push(body);
    return body;
  }

  remove(object) {
    this.bodies = this.bodies.filter((b) => b.object !== object);
  }

  /** Advance all floating bodies by `dt` seconds. */
  update(dt) {
    for (const body of this.bodies) {
      const obj = body.object;
      let sumH = 0;
      _n.set(0, 0, 0);

      for (const local of body.points) {
        _p.copy(local);
        // Place the sample point in world XZ using current position only
        // (ignoring tilt keeps sampling stable across frames).
        _p.add(obj.position);
        const info = this.ocean.getWaterInfo(_p.x, _p.z);
        sumH += info.height;
        _n.add(info.normal);
      }
      const count = body.points.length;
      const targetY = sumH / count + body.offset;
      _n.divideScalar(count).normalize();

      const t = Math.min(1, dt * body.damping);
      obj.position.y += (targetY - obj.position.y) * t;

      // Align the up axis to the averaged surface normal.
      const desiredUp = _n.lerp(_up, 1 - body.alignment).normalize();
      _q.setFromUnitVectors(_up, desiredUp);
      obj.quaternion.slerp(_q, t);
    }
  }
}
