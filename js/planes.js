import * as THREE from 'three';

const PLANE_SIZE      = 10;
const GRID_DIVISIONS  = 20;

export const PLANE_COLORS = [
  '#4FC3F7', // Blue
  '#EF5350', // Red
  '#66BB6A', // Green
  '#FFA726', // Orange
  '#AB47BC', // Purple
  '#26C6DA', // Teal
];

// Rotation applied to the plane GROUP to orient it in world space.
// Inside the group, the mesh and grid always lie in the XY plane.
const ORIENTATION_PRESETS = {
  front: { rotX:  0,             rotY: 0,            normal: { x: 0, y: 0, z: 1 }, label: 'Front' },
  top:   { rotX: -Math.PI / 2,   rotY: 0,            normal: { x: 0, y: 1, z: 0 }, label: 'Top'   },
  right: { rotX:  0,             rotY: Math.PI / 2,  normal: { x: 1, y: 0, z: 0 }, label: 'Right' },
};

const planes = [];
let   sceneRef = null;

export function initPlanes(scene) {
  sceneRef = scene;
}

function normalToOrientation(normal) {
  if (Math.abs(normal.x) > 0.5) return 'right';
  if (Math.abs(normal.y) > 0.5) return 'top';
  return 'front';
}

function createPlaneGroup(planeData) {
  const group = new THREE.Group();
  group.position.set(planeData.position.x, planeData.position.y, planeData.position.z);

  const orient = ORIENTATION_PRESETS[planeData.orientation] || ORIENTATION_PRESETS.front;
  group.rotation.set(orient.rotX, orient.rotY, 0);

  // Near-transparent mesh used as raycaster target (XY in group-local space)
  const geo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
  const mat = new THREE.MeshBasicMaterial({
    color:      new THREE.Color(planeData.color),
    side:       THREE.DoubleSide,
    transparent: true,
    opacity:    0.04,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.planeId      = planeData.id;
  mesh.userData.isSketchPlane = true;
  group.add(mesh);

  // GridHelper is XZ by default; rotate to XY to match the mesh
  const colorMain = new THREE.Color(planeData.color).multiplyScalar(0.7);
  const colorSub  = new THREE.Color(planeData.color).multiplyScalar(0.35);
  const grid      = new THREE.GridHelper(PLANE_SIZE, GRID_DIVISIONS, colorMain, colorSub);
  grid.rotation.x = Math.PI / 2;
  group.add(grid);

  sceneRef.add(group);
  planeData.threeObject = group;
  planeData.meshRef     = mesh;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createDefaultPlane() {
  const planeData = {
    id:          'plane_001',
    name:        'Front',
    color:       PLANE_COLORS[0],
    visible:     true,
    linesVisible: true,
    active:      true,
    orientation: 'front',
    normal:      { x: 0, y: 0, z: 1 },
    position:    { x: 0, y: 0, z: 0 },
    threeObject: null,
    meshRef:     null,
  };
  createPlaneGroup(planeData);
  planes.push(planeData);
  return planeData;
}

export function addPlane(orientationName = 'front') {
  const orient     = ORIENTATION_PRESETS[orientationName] || ORIENTATION_PRESETS.front;
  const colorIndex = planes.length % PLANE_COLORS.length;

  const planeData = {
    id:          `plane_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name:        orient.label,
    color:       PLANE_COLORS[colorIndex],
    visible:     true,
    linesVisible: true,
    active:      false,
    orientation: orientationName,
    normal:      { ...orient.normal },
    position:    { x: 0, y: 0, z: 0 },
    threeObject: null,
    meshRef:     null,
  };

  createPlaneGroup(planeData);
  planes.push(planeData);
  setActivePlane(planeData.id);
  return planeData;
}

// Recreate a plane from plain saved data (no auto-color / auto-activate).
export function restorePlane(savedData) {
  const orientation = savedData.orientation || normalToOrientation(savedData.normal || { x: 0, y: 0, z: 1 });
  const orient      = ORIENTATION_PRESETS[orientation] || ORIENTATION_PRESETS.front;

  const planeData = {
    id:          savedData.id,
    name:        savedData.name,
    color:       savedData.color,
    visible:     savedData.visible  ?? true,
    linesVisible: savedData.linesVisible ?? true,
    active:      savedData.active   ?? false,
    orientation,
    normal:      { ...orient.normal },
    position:    { ...(savedData.position || { x: 0, y: 0, z: 0 }) },
    threeObject: null,
    meshRef:     null,
  };

  createPlaneGroup(planeData);
  if (!planeData.visible && planeData.threeObject) planeData.threeObject.visible = false;
  planes.push(planeData);
  return planeData;
}

export function setActivePlane(planeId) {
  planes.forEach(p => { p.active = (p.id === planeId); });
}

export function getActivePlane() {
  return planes.find(p => p.active) || null;
}

export function getAllPlanes() {
  return planes;
}

export function getPlaneById(id) {
  return planes.find(p => p.id === id) || null;
}

export function setPlaneVisibility(planeId, visible) {
  const plane = planes.find(p => p.id === planeId);
  if (!plane) return;
  plane.visible = visible;
  if (plane.threeObject) plane.threeObject.visible = visible;
}

export function setLinesVisible(planeId, visible) {
  const plane = planes.find(p => p.id === planeId);
  if (plane) plane.linesVisible = visible;
}

export function renamePlane(planeId, newName) {
  const plane = planes.find(p => p.id === planeId);
  if (plane) plane.name = newName;
}

// Remove every plane from the scene and empty the planes array.
// Called before restoring an imported sketch.
export function clearAllPlanes() {
  planes.forEach(plane => {
    if (plane.threeObject) {
      sceneRef.remove(plane.threeObject);
      plane.threeObject.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }
  });
  planes.splice(0, planes.length);
}

export function deletePlane(planeId) {
  if (planes.length <= 1) return; // never delete the last plane
  const idx = planes.findIndex(p => p.id === planeId);
  if (idx === -1) return;
  const plane = planes[idx];

  // Remove Three.js objects and dispose
  if (plane.threeObject) {
    sceneRef.remove(plane.threeObject);
    plane.threeObject.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  planes.splice(idx, 1);

  // If we removed the active plane, activate the first remaining one
  if (plane.active && planes.length > 0) planes[0].active = true;
}
