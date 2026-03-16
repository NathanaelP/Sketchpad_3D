import * as THREE from 'three';
import { simplifyPoints, catmullRomCurve } from './curves.js';
import { getControls } from './viewport.js';

// ─── State constants ──────────────────────────────────────────────────────────
const STATE_IDLE              = 'IDLE';
const STATE_AWAITING_SECOND   = 'AWAITING_SECOND_POINT';
const STATE_FREEHAND_DRAWING  = 'FREEHAND_DRAWING';
const SELECT_IDLE             = 'SELECT_IDLE';
const SELECT_HANDLE_DRAGGING  = 'SELECT_HANDLE_DRAGGING';

const TAP_MOVE_THRESHOLD = 12; // px — travel beyond this = orbit, not tap
const LINE_RAYCAST_THRESHOLD = 0.15; // world units

// ─── Module state ─────────────────────────────────────────────────────────────
let scene, camera, renderer, getActivePlaneFn;
let saveCb = null;
let activeTool = 'line';
let drawState  = STATE_IDLE;

// Line tool
let startPoint    = null; // THREE.Vector3
let startMarker   = null; // THREE.Mesh sphere shown at first tap
let pointerDownPos = null;

// Freehand tool
let rawPoints3D        = [];
let freehandPreviewLine = null;
let activePointerId    = null;

// Select tool
let selectedStroke = null;
let dragState      = null; // { stroke, pointIndex, handleMesh, oldPoint }

const raycaster = new THREE.Raycaster();
const strokes   = [];
const history   = [];
const MAX_HISTORY = 50;

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initDrawing(sceneRef, cameraRef, rendererRef, getActivePlane, saveCallback) {
  scene            = sceneRef;
  camera           = cameraRef;
  renderer         = rendererRef;
  getActivePlaneFn = getActivePlane;
  saveCb           = saveCallback ?? null;

  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup',   onPointerUp);
  canvas.addEventListener('pointermove', onPointerMove);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancelCurrentStroke();
      cancelFreehand();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') undoLast();
  });
}

// ─── Pointer handlers ─────────────────────────────────────────────────────────
function onPointerDown(e) {
  if (activeTool === 'line') {
    pointerDownPos = { x: e.clientX, y: e.clientY };
    renderer.domElement.setPointerCapture(e.pointerId);

  } else if (activeTool === 'freehand') {
    if (drawState === STATE_FREEHAND_DRAWING) cancelFreehand();

    const plane = getActivePlaneFn();
    if (!plane || !plane.meshRef) return;

    const pt = getPlaneIntersection(e, plane.meshRef);
    if (!pt) return;

    activePointerId = e.pointerId;
    renderer.domElement.setPointerCapture(e.pointerId);
    rawPoints3D = [{ x: pt.x, y: pt.y, z: pt.z }];
    drawState   = STATE_FREEHAND_DRAWING;

    freehandPreviewLine = createPreviewLine([pt], plane.color);
    scene.add(freehandPreviewLine);

  } else if (activeTool === 'select') {
    handleSelectPointerDown(e);
  }
}

function onPointerMove(e) {
  if (activeTool === 'freehand'
      && drawState === STATE_FREEHAND_DRAWING
      && e.pointerId === activePointerId) {

    const plane = getActivePlaneFn();
    if (!plane || !plane.meshRef) return;
    const pt = getPlaneIntersection(e, plane.meshRef);
    if (!pt) return;

    rawPoints3D.push({ x: pt.x, y: pt.y, z: pt.z });
    updatePreviewLine(freehandPreviewLine, rawPoints3D);

  } else if (activeTool === 'select' && drawState === SELECT_HANDLE_DRAGGING) {
    handleSelectDrag(e);
  }
}

function onPointerUp(e) {
  if (activeTool === 'line') {
    if (!pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;
    const didMove = Math.sqrt(dx * dx + dy * dy) >= TAP_MOVE_THRESHOLD;
    pointerDownPos = null;
    if (didMove) return;
    handleLineTap(e);

  } else if (activeTool === 'freehand') {
    if (drawState !== STATE_FREEHAND_DRAWING) return;
    if (e.pointerId !== activePointerId) return;

    if (rawPoints3D.length < 3) {
      cancelFreehand();
      return;
    }

    const plane = getActivePlaneFn();
    if (plane) commitFreehand(rawPoints3D, plane);
    cancelFreehand();

  } else if (activeTool === 'select') {
    handleSelectPointerUp(e);
  }
}

// ─── Line tool ────────────────────────────────────────────────────────────────
function handleLineTap(e) {
  const plane = getActivePlaneFn();
  if (!plane || !plane.meshRef) return;

  const point = getPlaneIntersection(e, plane.meshRef);
  if (!point) return;

  if (drawState === STATE_IDLE) {
    startPoint = point.clone();
    placeStartMarker(startPoint, plane.color);
    drawState = STATE_AWAITING_SECOND;
  } else if (drawState === STATE_AWAITING_SECOND) {
    commitLine(startPoint, point, plane);
    cancelCurrentStroke();
  }
}

function commitLine(p1, p2, plane) {
  const controlPoints = [
    { x: p1.x, y: p1.y, z: p1.z },
    { x: p2.x, y: p2.y, z: p2.z },
  ];

  const lineObj     = buildLineObject(controlPoints, plane.color);
  const handleGroup = buildHandleGroup(controlPoints, plane.color);
  handleGroup.visible = false;

  const strokeGroup = new THREE.Group();
  strokeGroup.add(lineObj);
  strokeGroup.add(handleGroup);
  scene.add(strokeGroup);

  const stroke = {
    id:               `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    planeId:          plane.id,
    type:             'line',
    color:            plane.color,
    selected:         false,
    points:           controlPoints,
    snapConnections:  [],
    threeObject:      strokeGroup,
    lineRef:          lineObj,
    handleGroupRef:   handleGroup,
  };

  handleGroup.children.forEach(mesh => { mesh.userData.strokeId = stroke.id; });

  strokes.push(stroke);
  pushHistory({ action: 'add_stroke', strokeId: stroke.id });
  saveCb?.();
}

function cancelCurrentStroke() {
  removeStartMarker();
  startPoint = null;
  drawState  = STATE_IDLE;
}

// ─── Freehand tool ────────────────────────────────────────────────────────────
function commitFreehand(rawPoints, plane) {
  const controlPoints = simplifyPoints(rawPoints, 0.05);
  if (controlPoints.length < 2) return;

  const lineObj     = buildLineObject(controlPoints, plane.color);
  const handleGroup = buildHandleGroup(controlPoints, plane.color);
  handleGroup.visible = false;

  const strokeGroup = new THREE.Group();
  strokeGroup.add(lineObj);
  strokeGroup.add(handleGroup);
  scene.add(strokeGroup);

  const stroke = {
    id:               `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    planeId:          plane.id,
    type:             'freehand',
    color:            plane.color,
    selected:         false,
    points:           controlPoints,
    snapConnections:  [],
    threeObject:      strokeGroup,
    lineRef:          lineObj,
    handleGroupRef:   handleGroup,
  };

  handleGroup.children.forEach(mesh => { mesh.userData.strokeId = stroke.id; });

  strokes.push(stroke);
  pushHistory({ action: 'add_stroke', strokeId: stroke.id });
  saveCb?.();
}

function cancelFreehand() {
  if (freehandPreviewLine) {
    scene.remove(freehandPreviewLine);
    freehandPreviewLine.geometry.dispose();
    freehandPreviewLine.material.dispose();
    freehandPreviewLine = null;
  }
  rawPoints3D     = [];
  activePointerId = null;
  if (drawState === STATE_FREEHAND_DRAWING) drawState = STATE_IDLE;
}

// ─── Select tool ──────────────────────────────────────────────────────────────
function handleSelectPointerDown(e) {
  setNDC(e);

  // 1. Try handle spheres on already-selected strokes
  const allHandleMeshes = strokes.flatMap(s =>
    (s.handleGroupRef?.visible) ? s.handleGroupRef.children : []
  );

  const handleHits = raycaster.intersectObjects(allHandleMeshes);
  if (handleHits.length > 0) {
    const hitMesh    = handleHits[0].object;
    const strokeId   = hitMesh.userData.strokeId;
    const pointIndex = hitMesh.userData.pointIndex;
    const stroke     = strokes.find(s => s.id === strokeId);
    if (stroke) {
      dragState = {
        stroke,
        pointIndex,
        handleMesh: hitMesh,
        oldPoint: { ...stroke.points[pointIndex] },
      };
      drawState = SELECT_HANDLE_DRAGGING;
      renderer.domElement.setPointerCapture(e.pointerId);
      return;
    }
  }

  // 2. Try line geometries
  raycaster.params.Line = { threshold: LINE_RAYCAST_THRESHOLD };
  const allLineRefs = strokes.map(s => s.lineRef).filter(Boolean);
  const lineHits    = raycaster.intersectObjects(allLineRefs);
  if (lineHits.length > 0) {
    const stroke = strokes.find(s => s.lineRef === lineHits[0].object);
    if (stroke) { selectStroke(stroke); return; }
  }

  // 3. Nothing hit
  deselectAll();
}

function handleSelectDrag(e) {
  if (!dragState) return;
  const plane = getActivePlaneFn();
  if (!plane || !plane.meshRef) return;

  const pt = getPlaneIntersection(e, plane.meshRef);
  if (!pt) return;

  const { stroke, pointIndex, handleMesh } = dragState;
  stroke.points[pointIndex] = { x: pt.x, y: pt.y, z: pt.z };
  handleMesh.position.set(pt.x, pt.y, pt.z);
  regenerateStrokeGeometry(stroke);
}

function handleSelectPointerUp(e) {
  if (drawState !== SELECT_HANDLE_DRAGGING || !dragState) return;

  const { stroke, pointIndex, oldPoint } = dragState;
  const newPoint = { ...stroke.points[pointIndex] };

  if (oldPoint.x !== newPoint.x || oldPoint.y !== newPoint.y || oldPoint.z !== newPoint.z) {
    pushHistory({ action: 'reshape_stroke', strokeId: stroke.id, pointIndex, oldPoint, newPoint });
    saveCb?.();
  }

  dragState = null;
  drawState = SELECT_IDLE;

  void e;
}

function selectStroke(stroke) {
  deselectAll();
  stroke.selected = true;
  stroke.lineRef.material.color.set(0xffff00);
  stroke.handleGroupRef.visible = true;
  selectedStroke = stroke;
}

function deselectAll() {
  if (selectedStroke) {
    selectedStroke.lineRef.material.color.set(new THREE.Color(selectedStroke.color));
    selectedStroke.handleGroupRef.visible = false;
    selectedStroke.selected = false;
    selectedStroke = null;
  }
  dragState = null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildLineObject(controlPoints, color) {
  const splinePoints = catmullRomCurve(controlPoints, 20);
  const vectors      = splinePoints.map(p => new THREE.Vector3(p.x, p.y, p.z));
  const geo          = new THREE.BufferGeometry().setFromPoints(vectors);
  const mat          = new THREE.LineBasicMaterial({ color: new THREE.Color(color) });
  return new THREE.Line(geo, mat);
}

function buildHandleGroup(controlPoints, color) {
  const group       = new THREE.Group();
  const handleColor = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.5);

  controlPoints.forEach((pt, index) => {
    const geo  = new THREE.SphereGeometry(0.08, 8, 8);
    const mat  = new THREE.MeshBasicMaterial({ color: handleColor });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pt.x, pt.y, pt.z);
    mesh.userData.pointIndex = index;
    // userData.strokeId is set by the caller after stroke creation
    group.add(mesh);
  });

  return group;
}

function regenerateStrokeGeometry(stroke) {
  const splinePoints = catmullRomCurve(stroke.points, 20);
  const vectors      = splinePoints.map(p => new THREE.Vector3(p.x, p.y, p.z));
  stroke.lineRef.geometry.setFromPoints(vectors);
  stroke.lineRef.geometry.attributes.position.needsUpdate = true;
}

function createPreviewLine(points, color) {
  const vectors = points.map(p => new THREE.Vector3(p.x, p.y, p.z));
  const geo     = new THREE.BufferGeometry().setFromPoints(vectors);
  const mat     = new THREE.LineBasicMaterial({ color: new THREE.Color(color), opacity: 0.5, transparent: true });
  return new THREE.Line(geo, mat);
}

function updatePreviewLine(line, points) {
  const vectors = points.map(p => new THREE.Vector3(p.x, p.y, p.z));
  line.geometry.setFromPoints(vectors);
  line.geometry.attributes.position.needsUpdate = true;
}

function placeStartMarker(position, color) {
  if (startMarker) removeStartMarker();
  const geo  = new THREE.SphereGeometry(0.07, 8, 8);
  const mat  = new THREE.MeshBasicMaterial({ color: new THREE.Color(color) });
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

function getPlaneIntersection(event, planeMesh) {
  const canvas = renderer.domElement;
  const rect   = canvas.getBoundingClientRect();
  const ndcX   =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
  const ndcY   = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const hits = raycaster.intersectObject(planeMesh);
  return hits.length > 0 ? hits[0].point : null;
}

function setNDC(event) {
  const canvas = renderer.domElement;
  const rect   = canvas.getBoundingClientRect();
  const ndcX   =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
  const ndcY   = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
}

function pushHistory(entry) {
  history.push(entry);
  if (history.length > MAX_HISTORY) history.shift();
}

// ─── Public API ───────────────────────────────────────────────────────────────
export function undoLast() {
  cancelCurrentStroke();
  if (drawState === STATE_FREEHAND_DRAWING) cancelFreehand();

  if (history.length === 0) return;
  const entry = history.pop();

  if (entry.action === 'add_stroke') {
    const idx = strokes.findIndex(s => s.id === entry.strokeId);
    if (idx === -1) return;
    const stroke = strokes[idx];

    if (stroke.selected) deselectAll();

    scene.remove(stroke.threeObject);
    stroke.lineRef.geometry.dispose();
    stroke.lineRef.material.dispose();
    stroke.handleGroupRef.children.forEach(mesh => {
      mesh.geometry.dispose();
      mesh.material.dispose();
    });

    strokes.splice(idx, 1);
    saveCb?.();

  } else if (entry.action === 'reshape_stroke') {
    const stroke = strokes.find(s => s.id === entry.strokeId);
    if (!stroke) return;

    stroke.points[entry.pointIndex] = { ...entry.oldPoint };

    const handleMesh = stroke.handleGroupRef.children[entry.pointIndex];
    if (handleMesh) {
      handleMesh.position.set(entry.oldPoint.x, entry.oldPoint.y, entry.oldPoint.z);
    }

    regenerateStrokeGeometry(stroke);
    saveCb?.();
  }
}

export function setActiveTool(toolName) {
  if (drawState === STATE_FREEHAND_DRAWING) cancelFreehand();
  if (activeTool === 'select' && toolName !== 'select') deselectAll();

  activeTool = toolName;

  if (toolName !== 'line') cancelCurrentStroke();

  if (toolName === 'select') {
    drawState = SELECT_IDLE;
  } else {
    drawState = STATE_IDLE;
  }

  // Disable orbit controls while freehand is active so drags draw, not orbit
  const controls = getControls();
  if (controls) controls.enabled = (toolName !== 'freehand');

  // CSS cursor hint
  if (renderer) {
    renderer.domElement.classList.remove('tool-line', 'tool-freehand', 'tool-select');
    renderer.domElement.classList.add(`tool-${toolName}`);
  }
}

export function setPlaneStrokesVisible(planeId, visible) {
  strokes
    .filter(s => s.planeId === planeId)
    .forEach(s => { if (s.threeObject) s.threeObject.visible = visible; });
}

export function getStrokes() {
  return strokes;
}

// Reconstruct Three.js objects from saved plain data (called on load, no history/saveCb).
export function restoreStroke(strokeData, plane) {
  const lineObj     = buildLineObject(strokeData.points, strokeData.color);
  const handleGroup = buildHandleGroup(strokeData.points, strokeData.color);
  handleGroup.visible = false;

  const strokeGroup = new THREE.Group();
  strokeGroup.add(lineObj);
  strokeGroup.add(handleGroup);
  scene.add(strokeGroup);

  const stroke = {
    id:               strokeData.id,
    planeId:          strokeData.planeId,
    type:             strokeData.type,
    color:            strokeData.color,
    selected:         false,
    points:           strokeData.points.map(p => ({ ...p })),
    snapConnections:  [...(strokeData.snapConnections || [])],
    threeObject:      strokeGroup,
    lineRef:          lineObj,
    handleGroupRef:   handleGroup,
  };

  handleGroup.children.forEach(mesh => { mesh.userData.strokeId = stroke.id; });

  strokes.push(stroke);
}
