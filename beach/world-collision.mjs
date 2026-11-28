export function pointInPolygon(x, z, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i];
    const [xj, zj] = points[j];
    const crosses = (zi > z) !== (zj > z) &&
      x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const next = points[(i + 1) % points.length];
    area += p[0] * next[1] - next[0] * p[1];
  }
  return area;
}

function nearestEdge(x, z, points, orientation) {
  let best = null;
  let bestDistance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[(i + 1) % points.length];
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const distanceSq = (x - px) ** 2 + (z - pz) ** 2;
    if (distanceSq < bestDistance) {
      bestDistance = distanceSq;
      const edgeLength = Math.sqrt(lengthSq);
      best = {
        x: px,
        z: pz,
        nx: (orientation * dz) / edgeLength,
        nz: (-orientation * dx) / edgeLength,
        distance: Math.sqrt(distanceSq),
      };
    }
  }
  return best;
}

export function resolveCoast(x, z, colliders, margin = 5) {
  let moved = false;
  let nx = 0;
  let nz = 0;
  // Push radially from the nearest point on the boundary, not along the edge
  // normal: the old `projection + normal * push` reconstruction discarded the
  // tangential offset, so a point near a vertex at d ~= margin snapped onto
  // the boundary itself (a ship parked 7 m out could be slid onto the sand).
  // Two passes handle the leftover case where one push lands within the
  // margin of a neighbouring edge at a concave corner.
  for (let pass = 0; pass < 2; pass++) {
    let pushed = false;
    for (const collider of colliders) {
      const orientation = signedArea(collider.points) >= 0 ? 1 : -1;
      const edge = nearestEdge(x, z, collider.points, orientation);
      if (!edge) continue;
      const inside = pointInPolygon(x, z, collider.points);
      if (inside || edge.distance < margin) {
        const target = margin + (inside ? edge.distance : -edge.distance);
        if (target > 0) {
          if (inside) {
            // exit through the nearest edge along its outward normal: a radial
            // exit from an interior point can re-enter a concave polygon
            x = edge.x + edge.nx * target;
            z = edge.z + edge.nz * target;
          } else {
            // push away from the nearest boundary point, keeping the
            // tangential offset. The old `projection + normal * push`
            // reconstruction discarded it, so a point near a vertex at
            // d ~= margin snapped onto the boundary itself.
            let dx = x - edge.x;
            let dz = z - edge.z;
            const len = Math.hypot(dx, dz);
            if (len < 1e-6) {
              dx = edge.nx;
              dz = edge.nz;
            }
            const s = margin / Math.max(len, 1e-6);
            x = edge.x + dx * s;
            z = edge.z + dz * s;
          }
          pushed = true;
          nx = edge.nx;
          nz = edge.nz;
        }
      }
    }
    if (!pushed) break;
    moved = true;
  }
  return { x, z, collided: moved, nx, nz };
}

export function flattenColliders(islands) {
  return islands.flatMap((island) => (island.colliders || []).map((collider) => ({
    id: collider.id,
    islandId: island.id,
    points: collider.points.map(([x, z]) => [x + island.x, z + island.z]),
  })));
}
