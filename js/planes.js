import * as THREE from 'three';

const PLANE_SIZE = 10;
const GRID_DIVISIONS = 20;

export const PLANE_COLORS = [
  '#4FC3F7', // Blue
  '#EF5350', // Red
  '#66BB6A', // Green
  '#FFA726', // Orange
  '#AB47BC', // Purple
  '#26C6DA', // Teal
];

const planes = [];

function createPlaneGroup(planeData, scene) {
  const group = new THREE.Group();
  group.position.set(planeData.position.x, planeData.position.y, planeData.position.z);

  // Near-transparent mesh used as raycaster target
  const geometry = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(planeData.color),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.04,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.planeId = planeData.id;
  mesh.userData.isSketchPlane = true;
  group.add(mesh);

  // GridHelper for visual grid
  // GridHelper lies flat (XZ) by default; rotate to XY for a Front plane
  const colorMain = new THREE.Color(planeData.color).multiplyScalar(0.7);
  const colorSub  = new THREE.Color(planeData.color).multiplyScalar(0.35);
  const grid = new THREE.GridHelper(PLANE_SIZE, GRID_DIVISIONS, colorMain, colorSub);
  grid.rotation.x = Math.PI / 2;
  group.add(grid);

  scene.add(group);
  planeData.threeObject = group;
  planeData.meshRef = mesh;
}

export function createDefaultPlane(scene) {
  const planeData = {
    id: 'plane_001',
    name: 'Front',
    color: PLANE_COLORS[0],
    visible: true,
    linesVisible: true,
    active: true,
    normal: { x: 0, y: 0, z: 1 },
    position: { x: 0, y: 0, z: 0 },
    threeObject: null,
    meshRef: null,
  };
  createPlaneGroup(planeData, scene);
  planes.push(planeData);
  return planeData;
}

export function getActivePlane() {
  return planes.find(p => p.active) || null;
}

export function getAllPlanes() {
  return planes;
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
