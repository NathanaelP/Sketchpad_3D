import * as THREE from 'three';
import { catmullRomCurve } from './curves.js';

// Project a 3D point to screen pixel coordinates.
// Returns { px, py } or null if the point is behind the camera.
function _toScreen(pt, camera, rect, cw, ch) {
  const v = new THREE.Vector3(pt.x, pt.y, pt.z).project(camera);
  if (v.z > 1) return null; // behind camera
  return {
    px: (v.x *  0.5 + 0.5) * cw + rect.left,
    py: (v.y * -0.5 + 0.5) * ch + rect.top,
  };
}

// Check only stroke endpoints (first and last control point).
// Used for snap-on-start and live preview ring while drawing.
// Returns { point: {x,y,z}, strokeId } or null.
export function findEndpointSnap(sx, sy, strokes, radiusPx, camera, renderer) {
  const rect = renderer.domElement.getBoundingClientRect();
  const cw   = renderer.domElement.clientWidth;
  const ch   = renderer.domElement.clientHeight;

  let closest = null, closestDist = radiusPx;

  for (const stroke of strokes) {
    const pts = stroke.points;
    if (!pts.length) continue;

    for (const pt of [pts[0], pts[pts.length - 1]]) {
      const s = _toScreen(pt, camera, rect, cw, ch);
      if (!s) continue;
      const d = Math.hypot(sx - s.px, sy - s.py);
      if (d < closestDist) {
        closestDist = d;
        closest = { point: { ...pt }, strokeId: stroke.id };
      }
    }
  }

  return closest;
}

// Check all points along each stroke's spline (coarse sampling).
// Used for snap-on-end so strokes can terminate anywhere along an existing line.
// Returns { point: {x,y,z}, strokeId } or null.
export function findLineSnap(sx, sy, strokes, radiusPx, camera, renderer) {
  const rect = renderer.domElement.getBoundingClientRect();
  const cw   = renderer.domElement.clientWidth;
  const ch   = renderer.domElement.clientHeight;

  let closest = null, closestDist = radiusPx;

  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    // 5 segments per span — enough precision for snap without per-frame overwork
    const splinePts = catmullRomCurve(stroke.points, 5);

    for (const pt of splinePts) {
      const s = _toScreen(pt, camera, rect, cw, ch);
      if (!s) continue;
      const d = Math.hypot(sx - s.px, sy - s.py);
      if (d < closestDist) {
        closestDist = d;
        closest = { point: { ...pt }, strokeId: stroke.id };
      }
    }
  }

  return closest;
}

// Snap a world-space point to the nearest grid intersection or cell center on
// the given plane. Uses getWorldPosition/getWorldQuaternion which force a fresh
// matrixWorld update — avoiding the stale-matrix issue that worldToLocal has on
// mobile when pointer events fire between render frames.
export function snapToGrid(worldPoint, plane) {
  const group = plane.threeObject;
  if (!group) return worldPoint;
  const res = plane.gridResolution ?? 0.5;

  // Force-fresh world transform (getWorldPosition/Quaternion call updateWorldMatrix)
  const origin = new THREE.Vector3();
  const quat   = new THREE.Quaternion();
  group.getWorldPosition(origin);
  group.getWorldQuaternion(quat);

  // Local X and Y axes expressed in world space
  const xAxis  = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  const yAxis  = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);

  // Project world point onto the plane's local axes
  const offset = new THREE.Vector3(
    worldPoint.x - origin.x,
    worldPoint.y - origin.y,
    worldPoint.z - origin.z
  );

  // Snap at res/2 to hit both intersections (n*res) and cell centers ((n+0.5)*res)
  const step = res / 2;
  const px = Math.round(offset.dot(xAxis) / step) * step;
  const py = Math.round(offset.dot(yAxis) / step) * step;

  return {
    x: origin.x + xAxis.x * px + yAxis.x * py,
    y: origin.y + xAxis.y * px + yAxis.y * py,
    z: origin.z + xAxis.z * px + yAxis.z * py,
  };
}
