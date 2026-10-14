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
  for (const collider of colliders) {
    const orientation = signedArea(collider.points) >= 0 ? 1 : -1;
    const edge = nearestEdge(x, z, collider.points, orientation);
    if (!edge) continue;
    const inside = pointInPolygon(x, z, collider.points);
    if (inside || edge.distance < margin) {
      const push = margin + (inside ? edge.distance : -edge.distance);
      if (push > 0) {
        x = edge.x + edge.nx * push;
        z = edge.z + edge.nz * push;
        moved = true;
        nx = edge.nx;
        nz = edge.nz;
      }
    }
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
