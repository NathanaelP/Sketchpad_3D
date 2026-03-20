import * as THREE from 'three';
import { Line2 }        from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { simplifyPoints, catmullRomCurve } from './curves.js';
import { getControls } from './viewport.js';
import { findEndpointSnap, findLineSnap, snapToGrid } from './snap.js';
import { getPlaneById } from './planes.js';

// ─── State constants ──────────────────────────────────────────────────────────
const STATE_IDLE              = 'IDLE';
const STATE_AWAITING_SECOND   = 'AWAITING_SECOND_POINT';
const STATE_FREEHAND_DRAWING  = 'FREEHAND_DRAWING';
const SELECT_IDLE             = 'SELECT_IDLE';
const SELECT_HANDLE_DRAGGING  = 'SELECT_HANDLE_DRAGGING';

const TAP_MOVE_THRESHOLD     = 12;   // px — travel beyond this = orbit, not tap
const LINE_RAYCAST_THRESHOLD = 0.15; // world units
const SNAP_RADIUS_PX         = 36;   // touch-friendly snap radius (was 24)

// ─── Module state ─────────────────────────────────────────────────────────────
let scene, camera, renderer, getActivePlaneFn;
let saveCb = null;
let activeTool = 'line';
let drawState  = STATE_IDLE;

// Line tool
let startPoint           = null; // THREE.Vector3
let startMarker          = null; // THREE.Mesh sphere shown at first tap
let startSnapTarget      = null; // {point, strokeId} | null — snap recorded at first tap
let pointerDownPos       = null;
let pendingLineStartSnap  = null; // snap candidate captured at pointerdown (more reliable than pointerup on mobile)
let pendingStartScreenPos = null; // {x,y} screen coords at pointerdown — used as fallback for start placement

// Line preview + dimension label
let linePreviewLine = null; // THREE.Line — ghost line while awaiting second point
let dimensionLabel  = null; // HTMLElement — lazy-created inside #dimension-overlay

// Freehand tool
let rawPoints3D       = [];
let freehandPreviewLine = null;
let activePointerId   = null;
let freehandStartSnap = null; // {point, strokeId} | null — snap at freehand start

// Select tool
let selectedStroke    = null;
let dragState         = null; // { stroke, pointIndex, handleMesh, oldPoint }
let selectEditOldPoints = null; // snapshot of stroke.points before coord bar edits (for undo)
let currentPivot      = 'start'; // 'start' | 'center' | 'end'

// Snap indicator
let snapIndicatorMesh = null; // THREE.Mesh — lazy-created, reused

const raycaster = new THREE.Raycaster();
const strokes   = [];
const history   = [];
const MAX_HISTORY = 50;

let snapEnabled = true;
let lineWidth   = 3; // px — applied to all new and existing strokes

// Snap helpers — return null when snapping is disabled
function snapEndpoint(sx, sy) {
  return snapEnabled ? findEndpointSnap(sx, sy, strokes, SNAP_RADIUS_PX, camera, renderer) : null;
}
function snapLine(sx, sy) {
  return snapEnabled ? findLineSnap(sx, sy, strokes, SNAP_RADIUS_PX, camera, renderer) : null;
}
// Grid snap — applied only when endpoint/line snap didn't fire; respects per-plane toggle
function applyGridSnap(pt, plane) {
  if (!snapEnabled || plane.gridSnap === false) return pt;
  return snapToGrid(pt, plane);
}

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
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedStroke) {
      e.preventDefault();
      deleteStroke(selectedStroke.id);
    }
  });

  initCoordBar();
}

// ─── Line preview helpers ─────────────────────────────────────────────────────
function updateLinePreview(p1, p2, color) {
  const pts = [new THREE.Vector3(p1.x, p1.y, p1.z), new THREE.Vector3(p2.x, p2.y, p2.z)];
  if (!linePreviewLine) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(color), opacity: 0.45, transparent: true });
    linePreviewLine = new THREE.Line(geo, mat);
    scene.add(linePreviewLine);
  } else {
    linePreviewLine.geometry.setFromPoints(pts);
    linePreviewLine.geometry.attributes.position.needsUpdate = true;
  }
}

function removeLinePreview() {
  if (!linePreviewLine) return;
  scene.remove(linePreviewLine);
  linePreviewLine.geometry.dispose();
  linePreviewLine.material.dispose();
  linePreviewLine = null;
}

function showDimensionLabel(clientX, clientY, p1, p2, plane) {
  if (!dimensionLabel) {
    const overlay = document.getElementById('dimension-overlay');
    if (!overlay) return;
    dimensionLabel = document.createElement('div');
    dimensionLabel.className = 'dimension-label';
    overlay.appendChild(dimensionLabel);
  }
  const offset = new THREE.Vector3(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
  const length = offset.length();

  const quat  = new THREE.Quaternion();
  plane.threeObject.getWorldQuaternion(quat);
  const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  let angleDeg = Math.atan2(offset.dot(yAxis), offset.dot(xAxis)) * 180 / Math.PI;
  if (angleDeg < 0) angleDeg += 360;

  dimensionLabel.textContent   = `${length.toFixed(2)}  ${angleDeg.toFixed(1)}\u00b0`;
  dimensionLabel.style.left    = `${clientX + 16}px`;
  dimensionLabel.style.top     = `${clientY - 38}px`;
  dimensionLabel.style.display = 'block';
}

function hideDimensionLabel() {
  if (dimensionLabel) dimensionLabel.style.display = 'none';
}

// ─── Coordinate bar helpers ───────────────────────────────────────────────────
function worldToPlaneLocal(worldPt, plane) {
  const quat = new THREE.Quaternion();
  plane.threeObject.getWorldQuaternion(quat);
  const xAxis  = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  const yAxis  = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const origin = new THREE.Vector3();
  plane.threeObject.getWorldPosition(origin);
  const offset = new THREE.Vector3(worldPt.x - origin.x, worldPt.y - origin.y, worldPt.z - origin.z);
  return { x: offset.dot(xAxis), y: offset.dot(yAxis) };
}

function planeLocalToWorld(lx, ly, plane) {
  const quat = new THREE.Quaternion();
  plane.threeObject.getWorldQuaternion(quat);
  const xAxis  = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
  const yAxis  = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const origin = new THREE.Vector3();
  plane.threeObject.getWorldPosition(origin);
  return new THREE.Vector3(
    origin.x + xAxis.x * lx + yAxis.x * ly,
    origin.y + xAxis.y * lx + yAxis.y * ly,
    origin.z + xAxis.z * lx + yAxis.z * ly
  );
}

// Fill helpers — skip overwrite while the field is focused
function fillCoordStart(worldPt, plane) {
  const sx = document.getElementById('coord-start-x');
  const sy = document.getElementById('coord-start-y');
  if (!sx || !sy) return;
  const local = worldToPlaneLocal(worldPt, plane);
  if (document.activeElement !== sx) sx.value = local.x.toFixed(2);
  if (document.activeElement !== sy) sy.value = local.y.toFixed(2);
}

function fillCoordEnd(worldPt, plane) {
  const ex = document.getElementById('coord-end-x');
  const ey = document.getElementById('coord-end-y');
  if (!ex || !ey) return;
  const local = worldToPlaneLocal(worldPt, plane);
  if (document.activeElement !== ex) ex.value = local.x.toFixed(2);
  if (document.activeElement !== ey) ey.value = local.y.toFixed(2);
}

// Show bar with only the Start row (STATE_IDLE)
function showCoordBarForIdle() {
  hideCoordBar();
}

// Show bar with End row only (STATE_AWAITING_SECOND) — Start row is for Select mode only
function showCoordBarForSecond(_startWorldPt, _plane) {
  const bar      = document.getElementById('coord-bar');
  const startRow = document.getElementById('coord-row-start');
  const endRow   = document.getElementById('coord-row-end');
  const angleRow = document.getElementById('coord-row-angle');
  const goBtn    = document.getElementById('coord-go');
  if (!bar || !endRow) return;
  if (startRow)  startRow.style.display  = 'none';
  if (angleRow)  angleRow.style.display  = 'none';
  if (goBtn)     goBtn.style.display     = '';
  endRow.style.display = 'flex';
  bar.style.display    = 'flex';
}

function hideCoordBar() {
  const bar = document.getElementById('coord-bar');
  if (bar) bar.style.display = 'none';
}

// ── Select-mode coord bar helpers ──────────────────────────────────────────────

// Compute angle of a 2-point line in plane-local degrees (0–360)
function getAngleDeg(stroke, plane) {
  const p0 = worldToPlaneLocal(stroke.points[0], plane);
  const p1 = worldToPlaneLocal(stroke.points[1], plane);
  let deg = Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

// Populate the angle input (skip if it is currently focused)
function fillCoordAngle(stroke, plane) {
  const el = document.getElementById('coord-angle');
  if (!el || document.activeElement === el) return;
  el.value = getAngleDeg(stroke, plane).toFixed(1);
}

// Rotate line endpoints to achieve newAngleDeg around the chosen pivot
function applyAngleToStroke(newAngleDeg, pivot, stroke, plane) {
  const p0 = worldToPlaneLocal(stroke.points[0], plane);
  const p1 = worldToPlaneLocal(stroke.points[1], plane);
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const L  = Math.sqrt(dx * dx + dy * dy);
  if (L < 1e-6) return;
  const θ  = newAngleDeg * Math.PI / 180;
  const cx = Math.cos(θ), cy = Math.sin(θ);

  let np0, np1;
  if (pivot === 'start') {
    np0 = p0;
    np1 = { x: p0.x + L * cx, y: p0.y + L * cy };
  } else if (pivot === 'end') {
    np1 = p1;
    np0 = { x: p1.x - L * cx, y: p1.y - L * cy };
  } else {                              // center
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    np0 = { x: mx - (L / 2) * cx, y: my - (L / 2) * cy };
    np1 = { x: mx + (L / 2) * cx, y: my + (L / 2) * cy };
  }

  const wp0 = planeLocalToWorld(np0.x, np0.y, plane);
  const wp1 = planeLocalToWorld(np1.x, np1.y, plane);
  stroke.points[0] = { x: wp0.x, y: wp0.y, z: wp0.z };
  stroke.points[1] = { x: wp1.x, y: wp1.y, z: wp1.z };
  stroke.handleGroupRef.children[0]?.position.set(wp0.x, wp0.y, wp0.z);
  stroke.handleGroupRef.children[1]?.position.set(wp1.x, wp1.y, wp1.z);
  regenerateStrokeGeometry(stroke);
}

// Show coord bar populated from an already-selected 2-point line stroke
function showCoordBarForSelect(stroke, plane) {
  const bar      = document.getElementById('coord-bar');
  const endRow   = document.getElementById('coord-row-end');
  const angleRow = document.getElementById('coord-row-angle');
  const goBtn    = document.getElementById('coord-go');
  if (!bar || !endRow || !angleRow) return;
  fillCoordStart(stroke.points[0], plane);
  fillCoordEnd(stroke.points[1], plane);
  fillCoordAngle(stroke, plane);
  endRow.style.display   = 'flex';
  angleRow.style.display = 'flex';
  if (goBtn) goBtn.style.display = 'none';
  bar.style.display = 'flex';
  selectEditOldPoints = null;
}

// Push undo entry for coord-bar edits on a selected stroke (call on Enter / deselect)
function commitSelectEdit() {
  if (!selectedStroke || !selectEditOldPoints) return;
  const newPoints = selectedStroke.points.map(p => ({ ...p }));
  if (JSON.stringify(selectEditOldPoints) !== JSON.stringify(newPoints)) {
    pushHistory({
      action: 'edit_line_endpoints',
      strokeId: selectedStroke.id,
      oldPoints: selectEditOldPoints,
      newPoints,
    });
    saveCb?.();
  }
  selectEditOldPoints = null;
}

// Commit line using the typed End coords; Start is always the already-placed startPoint
function commitFromCoordBar() {
  const plane = getActivePlaneFn();
  if (!plane || drawState !== STATE_AWAITING_SECOND) return;
  const ex = document.getElementById('coord-end-x');
  const ey = document.getElementById('coord-end-y');
  if (!ex || !ey) return;
  const elx = parseFloat(ex.value);
  const ely = parseFloat(ey.value);
  if (isNaN(elx) || isNaN(ely)) return;
  const p2 = planeLocalToWorld(elx, ely, plane);
  commitLine(startPoint, p2, plane, startSnapTarget, null);
  startSnapTarget = null;
  hideSnapIndicator();
  removeLinePreview();
  hideDimensionLabel();
  hideCoordBar();
  cancelCurrentStroke();
}

// Place the start point programmatically from the Start row fields (STATE_IDLE)
function commitStartFromCoordBar() {
  const plane = getActivePlaneFn();
  if (!plane || drawState !== STATE_IDLE) return;
  const sx = document.getElementById('coord-start-x');
  const sy = document.getElementById('coord-start-y');
  if (!sx || !sy) return;
  const lx = parseFloat(sx.value);
  const ly = parseFloat(sy.value);
  if (isNaN(lx) || isNaN(ly)) return;

  const worldPt = planeLocalToWorld(lx, ly, plane);
  startPoint      = new THREE.Vector3(worldPt.x, worldPt.y, worldPt.z);
  startSnapTarget = null;
  drawState       = STATE_AWAITING_SECOND;
  placeStartMarker(startPoint, plane.color);
  hideSnapIndicator();
  showCoordBarForSecond(startPoint, plane);
  document.getElementById('coord-end-x')?.focus();
}

function initCoordBar() {
  const sx    = document.getElementById('coord-start-x');
  const sy    = document.getElementById('coord-start-y');
  const ex    = document.getElementById('coord-end-x');
  const ey    = document.getElementById('coord-end-y');
  const goBtn = document.getElementById('coord-go');
  if (!sx || !sy || !ex || !ey || !goBtn) return;

  // ── Select-mode handler: edit selected stroke's endpoints live ──────────────
  function onSelectCoordInput() {
    if (!selectedStroke || selectedStroke.type !== 'line') return;
    const plane = getPlaneById(selectedStroke.planeId) || getActivePlaneFn();
    if (!plane) return;
    if (!selectEditOldPoints)
      selectEditOldPoints = selectedStroke.points.map(p => ({ ...p }));
    const slx = parseFloat(sx.value), sly = parseFloat(sy.value);
    const elx = parseFloat(ex.value), ely = parseFloat(ey.value);
    if (!isNaN(slx) && !isNaN(sly)) {
      const sp = planeLocalToWorld(slx, sly, plane);
      selectedStroke.points[0] = { x: sp.x, y: sp.y, z: sp.z };
      selectedStroke.handleGroupRef.children[0]?.position.set(sp.x, sp.y, sp.z);
    }
    if (!isNaN(elx) && !isNaN(ely)) {
      const ep = planeLocalToWorld(elx, ely, plane);
      selectedStroke.points[1] = { x: ep.x, y: ep.y, z: ep.z };
      selectedStroke.handleGroupRef.children[1]?.position.set(ep.x, ep.y, ep.z);
    }
    regenerateStrokeGeometry(selectedStroke);
    fillCoordAngle(selectedStroke, plane);
  }

  // ── Line-drawing handler: update ghost preview ──────────────────────────────
  function onLineCoordInput() {
    if (drawState !== STATE_AWAITING_SECOND || !startPoint) return;
    const plane = getActivePlaneFn();
    if (!plane) return;
    const elx = parseFloat(ex.value), ely = parseFloat(ey.value);
    if (!isNaN(elx) && !isNaN(ely)) {
      const ep = planeLocalToWorld(elx, ely, plane);
      updateLinePreview(startPoint, ep, plane.color);
    }
  }

  function onCoordInput() {
    if (activeTool === 'select') onSelectCoordInput();
    else onLineCoordInput();
  }
  [sx, sy, ex, ey].forEach(el => el.addEventListener('input', onCoordInput));

  // ── Enter key routing ───────────────────────────────────────────────────────
  sx.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (activeTool === 'select') commitSelectEdit();
  });
  sy.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (activeTool === 'select') {
      commitSelectEdit();
    }
  });
  const onEndEnter = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (activeTool === 'select') commitSelectEdit();
    else commitFromCoordBar();
  };
  ex.addEventListener('keydown', onEndEnter);
  ey.addEventListener('keydown', onEndEnter);

  goBtn.addEventListener('click', commitFromCoordBar);

  // ── Pivot buttons ───────────────────────────────────────────────────────────
  document.querySelectorAll('.pivot-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.pivot-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPivot = btn.dataset.pivot;
    });
  });

  // ── Angle input ─────────────────────────────────────────────────────────────
  const angleInput = document.getElementById('coord-angle');
  if (angleInput) {
    angleInput.addEventListener('input', () => {
      if (activeTool !== 'select' || !selectedStroke) return;
      const plane = getPlaneById(selectedStroke.planeId) || getActivePlaneFn();
      if (!plane) return;
      const deg = parseFloat(angleInput.value);
      if (isNaN(deg)) return;
      if (!selectEditOldPoints)
        selectEditOldPoints = selectedStroke.points.map(p => ({ ...p }));
      applyAngleToStroke(deg, currentPivot, selectedStroke, plane);
      fillCoordStart(selectedStroke.points[0], plane);
      fillCoordEnd(selectedStroke.points[1], plane);
    });
    angleInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitSelectEdit(); }
    });
  }

  // Prevent canvas pointer events while interacting with the bar
  const bar = document.getElementById('coord-bar');
  if (bar) bar.addEventListener('pointerdown', (e) => e.stopPropagation());
}

// ─── Pointer handlers ─────────────────────────────────────────────────────────
function onPointerDown(e) {
  if (activeTool === 'line' || activeTool === 'erase') {
    pointerDownPos       = { x: e.clientX, y: e.clientY };
    if (activeTool === 'line') {
      // Capture snap and screen position at exact touch-down — lift position can be 8-15 px off on mobile
      pendingLineStartSnap  = snapEndpoint(e.clientX, e.clientY) ?? snapLine(e.clientX, e.clientY);
      pendingStartScreenPos = { x: e.clientX, y: e.clientY };
    }
    renderer.domElement.setPointerCapture(e.pointerId);

  } else if (activeTool === 'freehand') {
    if (drawState === STATE_FREEHAND_DRAWING) cancelFreehand();

    const plane = getActivePlaneFn();
    if (!plane || !plane.meshRef) return;

    // Snap start point — endpoint priority, line snap fallback, grid snap last
    const snap = snapEndpoint(e.clientX, e.clientY) ?? snapLine(e.clientX, e.clientY);
    const pt   = snap ? snap.point : (() => {
      const p = getPlaneIntersection(e, plane.meshRef);
      return p ? applyGridSnap({ x: p.x, y: p.y, z: p.z }, plane) : null;
    })();
    if (!pt) return;

    freehandStartSnap = snap;
    activePointerId   = e.pointerId;
    renderer.domElement.setPointerCapture(e.pointerId);
    rawPoints3D = [{ ...pt }];
    drawState   = STATE_FREEHAND_DRAWING;

    freehandPreviewLine = createPreviewLine([pt], plane.color);
    scene.add(freehandPreviewLine);
    hideSnapIndicator();

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

    // Show snap ring when approaching an endpoint or line
    const snap = snapEndpoint(e.clientX, e.clientY) ?? snapLine(e.clientX, e.clientY);
    if (snap) showSnapIndicator(snap.point, plane.normal);
    else      hideSnapIndicator();

  } else if (activeTool === 'line' && drawState === STATE_AWAITING_SECOND) {
    const plane = getActivePlaneFn();
    if (!plane || !plane.meshRef || !startPoint) return;
    const snap = snapEndpoint(e.clientX, e.clientY) ?? snapLine(e.clientX, e.clientY);
    let endPt;
    if (snap) {
      showSnapIndicator(snap.point, plane.normal);
      endPt = snap.point;
    } else {
      hideSnapIndicator();
      const raw = getPlaneIntersection(e, plane.meshRef);
      if (!raw) { hideDimensionLabel(); return; }
      endPt = applyGridSnap({ x: raw.x, y: raw.y, z: raw.z }, plane);
    }
    updateLinePreview(startPoint, endPt, plane.color);
    showDimensionLabel(e.clientX, e.clientY, startPoint, endPt, plane);
    fillCoordEnd(endPt, plane);

  } else if (activeTool === 'select' && drawState === SELECT_HANDLE_DRAGGING) {
    handleSelectDrag(e);

  } else if ((activeTool === 'line' || activeTool === 'freehand') && drawState === STATE_IDLE) {
    // Show snap ring while hovering before the first point is placed
    const plane = getActivePlaneFn();
    if (!plane) return;
    const snap = snapEndpoint(e.clientX, e.clientY) ?? snapLine(e.clientX, e.clientY);
    if (snap) showSnapIndicator(snap.point, plane.normal);
    else      hideSnapIndicator();
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
      freehandStartSnap = null;
      cancelFreehand();
      return;
    }

    // Snap end point (endpoint priority, line snap fallback)
    let endSnap = snapEndpoint(e.clientX, e.clientY) ?? snapLine(e.clientX, e.clientY);
    if (endSnap) {
      rawPoints3D[rawPoints3D.length - 1] = { ...endSnap.point };
    } else if (rawPoints3D.length > 3) {
      // Allow snapping end to the start of this same stroke to close a loop.
      // The current stroke isn't in strokes[] yet, so we project its start point manually.
      const sp     = rawPoints3D[0];
      const canvas = renderer.domElement;
      const rect   = canvas.getBoundingClientRect();
      const v      = new THREE.Vector3(sp.x, sp.y, sp.z).project(camera);
      if (v.z <= 1) {
        const px = (v.x *  0.5 + 0.5) * canvas.clientWidth  + rect.left;
        const py = (v.y * -0.5 + 0.5) * canvas.clientHeight + rect.top;
        if (Math.hypot(e.clientX - px, e.clientY - py) < SNAP_RADIUS_PX) {
          rawPoints3D[rawPoints3D.length - 1] = { ...sp };
        }
      }
    }

    const plane = getActivePlaneFn();
    if (plane) commitFreehand(rawPoints3D, plane, freehandStartSnap, endSnap);
    freehandStartSnap = null;
    hideSnapIndicator();
    cancelFreehand();

  } else if (activeTool === 'erase') {
    if (!pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;
    pointerDownPos = null;
    if (Math.hypot(dx, dy) >= TAP_MOVE_THRESHOLD) return; // orbit gesture, not tap
    setNDC(e);
    const hits = raycaster.intersectObjects(strokes.map(s => s.lineRef).filter(Boolean));
    if (hits.length > 0) {
      const stroke = strokes.find(s => s.lineRef === hits[0].object);
      if (stroke) deleteStroke(stroke.id);
    }

  } else if (activeTool === 'select') {
    handleSelectPointerUp(e);
  }
}

// ─── Line tool ────────────────────────────────────────────────────────────────
function handleLineTap(e) {
  const plane = getActivePlaneFn();
  if (!plane || !plane.meshRef) return;

  if (drawState === STATE_IDLE) {
    // Use pointerdown screen position (not drifted pointerup position) for start placement
    const pdx = pendingStartScreenPos?.x ?? e.clientX;
    const pdy = pendingStartScreenPos?.y ?? e.clientY;
    pendingStartScreenPos = null;

    const snap = pendingLineStartSnap ?? snapEndpoint(pdx, pdy) ?? snapLine(pdx, pdy);
    pendingLineStartSnap = null;
    const point = snap
      ? new THREE.Vector3(snap.point.x, snap.point.y, snap.point.z)
      : (() => {
          const raw = getPlaneIntersection({ clientX: pdx, clientY: pdy }, plane.meshRef);
          if (!raw) return null;
          const g = applyGridSnap({ x: raw.x, y: raw.y, z: raw.z }, plane);
          return new THREE.Vector3(g.x, g.y, g.z);
        })();
    if (!point) return;

    startPoint      = point instanceof THREE.Vector3 ? point : point.clone();
    startSnapTarget = snap;
    placeStartMarker(startPoint, plane.color);
    hideSnapIndicator();
    drawState = STATE_AWAITING_SECOND;
    showCoordBarForSecond(startPoint, plane);

  } else if (drawState === STATE_AWAITING_SECOND) {
    // Endpoint snap first, line snap fallback, grid snap last
    const snap = snapEndpoint(e.clientX, e.clientY) ?? snapLine(e.clientX, e.clientY);
    const point = snap
      ? new THREE.Vector3(snap.point.x, snap.point.y, snap.point.z)
      : (() => {
          const raw = getPlaneIntersection(e, plane.meshRef);
          if (!raw) return null;
          const g = applyGridSnap({ x: raw.x, y: raw.y, z: raw.z }, plane);
          return new THREE.Vector3(g.x, g.y, g.z);
        })();
    if (!point) return;

    commitLine(startPoint, point, plane, startSnapTarget, snap);
    startSnapTarget = null;
    hideSnapIndicator();
    removeLinePreview();
    hideDimensionLabel();
    cancelCurrentStroke();
  }
}

function commitLine(p1, p2, plane, startSnap, endSnap) {
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
  _applySnapConnections(stroke, startSnap, endSnap);

  strokes.push(stroke);
  pushHistory({ action: 'add_stroke', strokeId: stroke.id });
  saveCb?.();
}

function cancelCurrentStroke() {
  removeStartMarker();
  removeLinePreview();
  hideDimensionLabel();
  hideCoordBar();
  startPoint            = null;
  pendingLineStartSnap  = null;
  pendingStartScreenPos = null;
  drawState             = STATE_IDLE;
}

// ─── Freehand tool ────────────────────────────────────────────────────────────
function commitFreehand(rawPoints, plane, startSnap, endSnap) {
  let controlPoints = simplifyPoints(rawPoints, 0.05);
  if (controlPoints.length < 2) return;

  // Grid-snap simplified control points; skip endpoints that already locked to a stroke
  controlPoints = controlPoints.map((pt, i) => {
    if (i === 0 && startSnap) return pt;
    if (i === controlPoints.length - 1 && endSnap) return pt;
    return applyGridSnap(pt, plane);
  });

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
  _applySnapConnections(stroke, startSnap, endSnap);

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

// ─── Delete stroke ────────────────────────────────────────────────────────────
function deleteStroke(strokeId) {
  const idx = strokes.findIndex(s => s.id === strokeId);
  if (idx === -1) return;
  const stroke = strokes[idx];

  if (stroke.selected) deselectAll();
  scene.remove(stroke.threeObject);
  stroke.lineRef.geometry.dispose();
  stroke.lineRef.material.dispose();
  stroke.handleGroupRef.children.forEach(m => { m.geometry.dispose(); m.material.dispose(); });

  stroke.snapConnections.forEach(otherId => {
    const other = strokes.find(s => s.id === otherId);
    if (other) other.snapConnections = other.snapConnections.filter(id => id !== stroke.id);
  });

  strokes.splice(idx, 1);
  // Remove this stroke's history entries (erase is not undoable)
  history.splice(0, history.length, ...history.filter(e => e.strokeId !== strokeId));
  saveCb?.();
}

// ─── Snap connections ─────────────────────────────────────────────────────────
function _applySnapConnections(newStroke, startSnap, endSnap) {
  for (const snap of [startSnap, endSnap]) {
    if (!snap) continue;
    const target = strokes.find(s => s.id === snap.strokeId);
    if (!target) continue;
    if (!newStroke.snapConnections.includes(snap.strokeId))
      newStroke.snapConnections.push(snap.strokeId);
    if (!target.snapConnections.includes(newStroke.id))
      target.snapConnections.push(newStroke.id);
  }
}

// ─── Snap indicator ───────────────────────────────────────────────────────────
function showSnapIndicator(point, planeNormal) {
  if (!snapIndicatorMesh) {
    const geo = new THREE.RingGeometry(0.15, 0.22, 24);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
    });
    snapIndicatorMesh = new THREE.Mesh(geo, mat);
    scene.add(snapIndicatorMesh);
  }
  const normal = new THREE.Vector3(planeNormal.x, planeNormal.y, planeNormal.z).normalize();
  snapIndicatorMesh.position.set(point.x, point.y, point.z);
  snapIndicatorMesh.position.addScaledVector(normal, 0.02); // prevent z-fighting
  snapIndicatorMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  snapIndicatorMesh.visible = true;
}

function hideSnapIndicator() {
  if (snapIndicatorMesh) snapIndicatorMesh.visible = false;
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

  // 2. Try line geometries (Line2 uses pixel-space threshold based on linewidth)
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
  // Use the stroke's own plane for intersection so handles move along the correct surface
  const plane = getPlaneById(dragState.stroke.planeId) || getActivePlaneFn();
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
  if (stroke.type === 'line' && stroke.points.length === 2) {
    const plane = getPlaneById(stroke.planeId) || getActivePlaneFn();
    if (plane) showCoordBarForSelect(stroke, plane);
  }
}

function deselectAll() {
  if (selectedStroke) {
    commitSelectEdit();
    selectedStroke.lineRef.material.color.set(new THREE.Color(selectedStroke.color));
    selectedStroke.handleGroupRef.visible = false;
    selectedStroke.selected = false;
    selectedStroke = null;
  }
  dragState = null;
  selectEditOldPoints = null;
  hideCoordBar();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildLineObject(controlPoints, color) {
  const splinePoints = catmullRomCurve(controlPoints, 20);
  const positions    = splinePoints.flatMap(p => [p.x, p.y, p.z]);
  const geo          = new LineGeometry();
  geo.setPositions(positions);
  const mat = new LineMaterial({
    color:      new THREE.Color(color),
    linewidth:  lineWidth,
    linecap:    'butt',  // ends flush at control points — prevents cap overshoot past snap targets
    resolution: new THREE.Vector2(renderer.domElement.clientWidth, renderer.domElement.clientHeight),
  });
  return new Line2(geo, mat);
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
  const positions    = splinePoints.flatMap(p => [p.x, p.y, p.z]);
  stroke.lineRef.geometry.setPositions(positions);
  stroke.lineRef.computeLineDistances();
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

  // Try finite mesh first (respects plane bounds)
  const hits = raycaster.intersectObject(planeMesh);
  if (hits.length > 0) return hits[0].point;

  // Fallback: infinite plane so drawing works at any camera angle.
  // Derive world-space normal and position from the mesh's current transform.
  const worldNormal   = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(planeMesh.getWorldQuaternion(new THREE.Quaternion()));
  const worldPos      = planeMesh.getWorldPosition(new THREE.Vector3());
  const infinitePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(worldNormal, worldPos);
  const target        = new THREE.Vector3();
  return raycaster.ray.intersectPlane(infinitePlane, target);
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

    // Remove this stroke from others' snapConnections
    stroke.snapConnections.forEach(otherId => {
      const other = strokes.find(s => s.id === otherId);
      if (other) other.snapConnections = other.snapConnections.filter(id => id !== stroke.id);
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

  } else if (entry.action === 'edit_line_endpoints') {
    const stroke = strokes.find(s => s.id === entry.strokeId);
    if (!stroke) return;
    entry.oldPoints.forEach((pt, i) => {
      stroke.points[i] = { ...pt };
      stroke.handleGroupRef.children[i]?.position.set(pt.x, pt.y, pt.z);
    });
    regenerateStrokeGeometry(stroke);
    if (selectedStroke?.id === stroke.id) {
      const plane = getPlaneById(stroke.planeId) || getActivePlaneFn();
      if (plane) {
        fillCoordStart(stroke.points[0], plane);
        fillCoordEnd(stroke.points[1], plane);
        fillCoordAngle(stroke, plane);
      }
    }
    saveCb?.();
  }
}

export function setSnapEnabled(enabled) {
  snapEnabled = enabled;
  if (!enabled) hideSnapIndicator();
}

export function isSnapEnabled() {
  return snapEnabled;
}

export function setLineWidth(w) {
  lineWidth = Math.max(1, Math.min(20, w));
  // Update all existing stroke materials
  strokes.forEach(s => {
    if (s.lineRef?.material) {
      s.lineRef.material.linewidth = lineWidth;
      s.lineRef.material.needsUpdate = true;
    }
  });
}

export function getLineWidth() {
  return lineWidth;
}

export function deleteStrokesByPlane(planeId) {
  const toDelete = strokes.filter(s => s.planeId === planeId);
  toDelete.forEach(stroke => {
    if (stroke.selected) deselectAll();
    scene.remove(stroke.threeObject);
    stroke.lineRef.geometry.dispose();
    stroke.lineRef.material.dispose();
    stroke.handleGroupRef.children.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
    // Remove from other strokes' snapConnections
    stroke.snapConnections.forEach(otherId => {
      const other = strokes.find(s => s.id === otherId);
      if (other) other.snapConnections = other.snapConnections.filter(id => id !== stroke.id);
    });
  });
  // Remove from strokes array
  const deleteIds = new Set(toDelete.map(s => s.id));
  strokes.splice(0, strokes.length, ...strokes.filter(s => !deleteIds.has(s.id)));
  // Remove history entries that reference deleted strokes
  history.splice(0, history.length, ...history.filter(e => !deleteIds.has(e.strokeId)));
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

  // Always hide snap indicator when switching tools
  hideSnapIndicator();

  // Orbit controls only active when the Orbit tool is selected
  const controls = getControls();
  if (controls) controls.enabled = (toolName === 'orbit');

  // CSS cursor hint
  if (renderer) {
    renderer.domElement.classList.remove('tool-line', 'tool-freehand', 'tool-select', 'tool-erase', 'tool-orbit');
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
export function restoreStroke(strokeData) {
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
