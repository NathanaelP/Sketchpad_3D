import * as THREE from 'three';

// Ramer-Douglas-Peucker simplification in 3D world-space.
// points: array of {x, y, z} plain objects
// epsilon: max perpendicular deviation in world units (default 0.05)
export function simplifyPoints(points, epsilon = 0.05) {
  if (points.length <= 2) return points;

  const last = points.length - 1;
  const a = new THREE.Vector3(points[0].x, points[0].y, points[0].z);
  const b = new THREE.Vector3(points[last].x, points[last].y, points[last].z);

  let maxDist = 0;
  let maxIdx  = 0;

  for (let i = 1; i < last; i++) {
    const d = _perpDist3D(points[i], a, b);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left  = simplifyPoints(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyPoints(points.slice(maxIdx), epsilon);
    return [...left, ...right.slice(1)];
  }

  return [points[0], points[last]];
}

function _perpDist3D(pt, a, b) {
  const p = new THREE.Vector3(pt.x, pt.y, pt.z);
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  if (lenSq === 0) return p.distanceTo(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / lenSq));
  const closest = a.clone().addScaledVector(ab, t);
  return p.distanceTo(closest);
}

// Catmull-Rom spline through all control points.
// points: array of {x, y, z} plain objects
// segmentsPerSpan: curve subdivisions between each pair of control points
// Returns array of {x, y, z} plain objects.
export function catmullRomCurve(points, segmentsPerSpan = 20) {
  if (points.length < 2) return points;

  const vectors = points.map(p => new THREE.Vector3(p.x, p.y, p.z));
  const curve   = new THREE.CatmullRomCurve3(vectors, false, 'catmullrom', 0.5);
  const total   = (points.length - 1) * segmentsPerSpan + 1;

  return curve.getPoints(total).map(v => ({ x: v.x, y: v.y, z: v.z }));
}
