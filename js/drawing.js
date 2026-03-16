import * as THREE from 'three';

const STATE_IDLE = 'IDLE';
const STATE_AWAITING_SECOND = 'AWAITING_SECOND_POINT';
const TAP_MOVE_THRESHOLD = 12; // px — travel beyond this = orbit, not tap

let scene, camera, renderer, getActivePlaneFn;
let activeTool = 'line';
let drawState = STATE_IDLE;

let startPoint = null;        // THREE.Vector3
let startMarker = null;       // THREE.Mesh sphere shown at first tap
let pointerDownPos = null;

const raycaster = new THREE.Raycaster();
const strokes = [];
const history = [];
const MAX_HISTORY = 50;

export function initDrawing(sceneRef, cameraRef, rendererRef, getActivePlane) {
  scene    = sceneRef;
  camera   = cameraRef;
  renderer = rendererRef;
  getActivePlaneFn = getActivePlane;

  const canvas = renderer.domElement;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup',   onPointerUp);
  canvas.addEventListener('pointermove', onPointerMove);

  // Keyboard: Escape cancels in-progress line
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelCurrentStroke();
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') undoLast();
  });
}

function onPointerDown(e) {
  if (activeTool === 'select') return;
  pointerDownPos = { x: e.clientX, y: e.clientY };
  // Capture pointer so pointerup fires on canvas even if finger drifts to UI
  renderer.domElement.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  // Nothing needed in Phase 1 (no hover snap yet)
  void e;
}

function onPointerUp(e) {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  const didMove = Math.sqrt(dx * dx + dy * dy) >= TAP_MOVE_THRESHOLD;
  pointerDownPos = null;

  if (didMove) return; // was an orbit drag, not a tap
  if (activeTool !== 'line') return;

  handleLineTap(e);
}

function handleLineTap(e) {
  const plane = getActivePlaneFn();
  if (!plane || !plane.meshRef) return;

  const point = getPlaneIntersection(e, plane.meshRef);
  if (!point) return;

  if (drawState === STATE_IDLE) {
    // Place first point
    startPoint = point.clone();
    placeStartMarker(startPoint, plane.color);
    drawState = STATE_AWAITING_SECOND;
  } else if (drawState === STATE_AWAITING_SECOND) {
    // Complete the line
    const endPoint = point.clone();
    commitLine(startPoint, endPoint, plane);
    cancelCurrentStroke(); // cleans up marker, resets state
  }
}

function getPlaneIntersection(event, planeMesh) {
  const canvas = renderer.domElement;
  const rect   = canvas.getBoundingClientRect();
  const ndcX   =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
  const ndcY   = -((event.clientY - rect.top)  / rect.height) * 2 + 1;

  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const hits = raycaster.intersectObject(planeMesh);
  return hits.length > 0 ? hits[0].point : null;
}

function placeStartMarker(position, color) {
  if (startMarker) removeStartMarker();
  const geo = new THREE.SphereGeometry(0.07, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color) });
  startMarker = new THREE.Mesh(geo, mat);
  startMarker.position.copy(position);
  scene.add(startMarker);
}

function removeStartMarker() {
  if (!startMarker) return;
  scene.remove(startMarker);
  startMarker.geometry.dispose();
  startMarker.material.dispose();
  startMarker = null;
}

function commitLine(p1, p2, plane) {
  const points = [
    new THREE.Vector3(p1.x, p1.y, p1.z),
    new THREE.Vector3(p2.x, p2.y, p2.z),
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(plane.color),
  });
  const lineObj = new THREE.Line(geometry, material);
  scene.add(lineObj);

  const stroke = {
    id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    planeId: plane.id,
    type: 'line',
    color: plane.color,
    points: [
      { x: p1.x, y: p1.y, z: p1.z },
      { x: p2.x, y: p2.y, z: p2.z },
    ],
    threeObject: lineObj,
    snapConnections: [],
  };

  strokes.push(stroke);
  pushHistory({ action: 'add_stroke', strokeId: stroke.id });
}

function cancelCurrentStroke() {
  removeStartMarker();
  startPoint = null;
  drawState  = STATE_IDLE;
}

function pushHistory(entry) {
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
}

export function undoLast() {
  if (history.length === 0) return;
  const entry = history.pop();
  if (entry.action === 'add_stroke') {
    const idx = strokes.findIndex(s => s.id === entry.strokeId);
    if (idx === -1) return;
    const stroke = strokes[idx];
    scene.remove(stroke.threeObject);
    stroke.threeObject.geometry.dispose();
    stroke.threeObject.material.dispose();
    strokes.splice(idx, 1);
  }
  // Also cancel any in-progress stroke
  cancelCurrentStroke();
}

export function setActiveTool(toolName) {
  activeTool = toolName;
  if (toolName !== 'line') cancelCurrentStroke();
}

export function setPlaneStrokesVisible(planeId, visible) {
  strokes
    .filter(s => s.planeId === planeId)
    .forEach(s => { if (s.threeObject) s.threeObject.visible = visible; });
}

export function getStrokes() {
  return strokes;
}
