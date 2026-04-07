import * as THREE from 'three';
import { Line2 }        from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { simplifyPoints, catmullRomCurve } from './curves.js';
import { getControls } from './viewport.js';
import { findEndpointSnap, findLineSnap, snapToGrid } from './snap.js';
import { getPlaneById, getAllPlanes } from './planes.js';

// ─── State constants ──────────────────────────────────────────────────────────
const STATE_IDLE              = 'IDLE';
const STATE_AWAITING_SECOND   = 'AWAITING_SECOND_POINT';
const STATE_FREEHAND_DRAWING  = 'FREEHAND_DRAWING';
const SELECT_IDLE             = 'SELECT_IDLE';
const SELECT_HANDLE_DRAGGING  = 'SELECT_HANDLE_DRAGGING';
const PLANE_DRAG              = 'PLANE_DRAG';
const GROUP_DRAG              = 'GROUP_DRAG';

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
const selectedStrokeIds = new Set(); // all selected IDs (primary + multi-select)
let dragState         = null; // { stroke, pointIndex, handleMesh, oldPoint }
let selectEditOldPoints = null; // snapshot of stroke.points before coord bar edits (for undo)
let currentPivot      = 'start'; // 'start' | 'center' | 'end'
let planeDragState    = null; // { plane, axis, helperPlane, startHitPt, startPos }
let groupDragState    = null; // { plane, startHitPt, startPositions: Map<id, points[]> }
let lassoState        = null; // { startX, startY, additive, started }
let lassoRectEl       = null; // <div> overlay — lazy created

// Snap indicator
let snapIndicatorMesh = null; // THREE.Mesh — lazy-created, reused

const raycaster = new THREE.Raycaster();
const strokes   = [];
const history   = [];
const MAX_HISTORY = 50;

let snapEnabled = true;
let lineWidth   = 3; // px — applied to all new and existing strokes
let clipboard   = null; // { type, points, sourcePlaneId }
let strokeSelectCb = null;
let colorTargetId  = null; // persists after deselect so color picker can still apply

// Annotation (Dim) tool
const ANNOTATION_COLOR = '#FFD54F'; // warm gold
const annotations = [];
let annotState       = 'idle'; // 'idle' | 'awaiting_second'
let annotStartPoint  = null;   // THREE.Vector3
let annotStartMarker = null;   // THREE.Mesh sphere
let annotStartSnap   = null;   // snap candidate at first tap

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
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedStrokeIds.size > 0) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      deleteSelectedStrokes();
    }
  });

  initCoordBar();
  // Per-frame annotation label repositioning
  (function loop() { updateAnnotationLabels(); requestAnimationFrame(loop); })();
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

function fillCoordPolar(worldPt, plane) {
  const lEl = document.getElementById('coord-length');
  const aEl = document.getElementById('coord-polar-angle');
  if (!lEl || !aEl || !startPoint) return;
  const s  = worldToPlaneLocal(startPoint, plane);
  const e  = worldToPlaneLocal(worldPt, plane);
  const dx = e.x - s.x, dy = e.y - s.y;
  const L  = Math.sqrt(dx * dx + dy * dy);
  let ang  = Math.atan2(dy, dx) * 180 / Math.PI;
  if (ang < 0) ang += 360;
  if (document.activeElement !== lEl) lEl.value = L.toFixed(2);
  if (document.activeElement !== aEl) aEl.value = ang.toFixed(1);
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
  const polarRow = document.getElementById('coord-row-polar');
  const angleRow = document.getElementById('coord-row-angle');
  const goBtn    = document.getElementById('coord-go');
  if (!bar || !endRow) return;
  if (startRow)  startRow.style.display  = 'none';
  if (angleRow)  angleRow.style.display  = 'none';
  if (goBtn)     goBtn.style.display     = '';
  // Show and clear polar row
  if (polarRow) {
    polarRow.style.display = 'flex';
    const lEl = document.getElementById('coord-length');
    const aEl = document.getElementById('coord-polar-angle');
    if (lEl) lEl.value = '';
    if (aEl) aEl.value = '';
  }
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
  const polarRow = document.getElementById('coord-row-polar');
  const angleRow = document.getElementById('coord-row-angle');
  const goBtn    = document.getElementById('coord-go');
  if (!bar || !endRow || !angleRow) return;
  fillCoordStart(stroke.points[0], plane);
  fillCoordEnd(stroke.points[1], plane);
  fillCoordAngle(stroke, plane);
  endRow.style.display   = 'flex';
  angleRow.style.display = 'flex';
  if (polarRow) polarRow.style.display = 'none';
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
      fillCoordPolar(ep, plane);
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

  // ── Polar input handlers ────────────────────────────────────────────────────
  function onPolarCoordInput() {
    if (drawState !== STATE_AWAITING_SECOND || !startPoint) return;
    const plane = getActivePlaneFn();
    if (!plane) return;
    const lEl = document.getElementById('coord-length');
    const aEl = document.getElementById('coord-polar-angle');
    const L   = parseFloat(lEl?.value);
    const ang = parseFloat(aEl?.value);
    if (isNaN(L) || isNaN(ang)) return;
    const s   = worldToPlaneLocal(startPoint, plane);
    const rad = ang * Math.PI / 180;
    const ep  = planeLocalToWorld(s.x + L * Math.cos(rad), s.y + L * Math.sin(rad), plane);
    updateLinePreview(startPoint, ep, plane.color);
    // Sync X/Y fields
    const local = worldToPlaneLocal(ep, plane);
    if (document.activeElement !== ex) ex.value = local.x.toFixed(2);
    if (document.activeElement !== ey) ey.value = local.y.toFixed(2);
  }

  function commitFromPolarBar() {
    const plane = getActivePlaneFn();
    if (!plane || drawState !== STATE_AWAITING_SECOND || !startPoint) return;
    const lEl  = document.getElementById('coord-length');
    const paEl = document.getElementById('coord-polar-angle');
    const L    = parseFloat(lEl?.value);
    const ang  = parseFloat(paEl?.value);
    if (isNaN(L) || isNaN(ang)) return;
    const s   = worldToPlaneLocal(startPoint, plane);
    const rad = ang * Math.PI / 180;
    const ep  = planeLocalToWorld(s.x + L * Math.cos(rad), s.y + L * Math.sin(rad), plane);
    commitLine(startPoint, ep, plane, startSnapTarget, null);
    startSnapTarget = null;
    hideSnapIndicator();
    removeLinePreview();
    hideDimensionLabel();
    hideCoordBar();
    cancelCurrentStroke();
  }

  const lEl  = document.getElementById('coord-length');
  const paEl = document.getElementById('coord-polar-angle');
  if (lEl)  lEl.addEventListener('input',  onPolarCoordInput);
  if (paEl) paEl.addEventListener('input', onPolarCoordInput);
  const onPolarEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitFromPolarBar(); } };
  if (lEl)  lEl.addEventListener('keydown',  onPolarEnter);
  if (paEl) paEl.addEventListener('keydown', onPolarEnter);

  // Prevent canvas pointer events while interacting with the bar
  const bar = document.getElementById('coord-bar');
  if (bar) bar.addEventListener('pointerdown', (e) => e.stopPropagation());
}

// ─── Multi-select helpers ─────────────────────────────────────────────────────
function getLassoRectEl() {
  if (!lassoRectEl) {
    lassoRectEl = document.createElement('div');
    lassoRectEl.id = 'lasso-rect';
    document.body.appendChild(lassoRectEl);
  }
  return lassoRectEl;
}

function updateLassoDisplay(x1, y1, x2, y2) {
  const el  = getLassoRectEl();
  const l   = Math.min(x1, x2), t = Math.min(y1, y2);
  const w   = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  el.style.cssText = `display:block;position:fixed;left:${l}px;top:${t}px;width:${w}px;height:${h}px;` +
    `border:1px dashed rgba(255,255,255,0.55);background:rgba(255,255,255,0.07);pointer-events:none;z-index:5;`;
}

function hideLassoRectEl() {
  if (lassoRectEl) lassoRectEl.style.display = 'none';
}

function finalizeLasso(x1, y1, x2, y2, additive) {
  if (!additive) deselectAll();
  const canvas = renderer.domElement;
  const rect   = canvas.getBoundingClientRect();
  const w      = canvas.clientWidth;
  const h      = canvas.clientHeight;
  const minX   = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minY   = Math.min(y1, y2), maxY = Math.max(y1, y2);

  strokes.forEach(stroke => {
    if (!stroke.threeObject.visible) return;
    if (selectedStrokeIds.has(stroke.id)) return;
    const inside = stroke.points.some(pt => {
      const v  = new THREE.Vector3(pt.x, pt.y, pt.z).project(camera);
      if (v.z > 1) return false;
      const sx = (v.x + 1) / 2 * w + rect.left;
      const sy = (-v.y + 1) / 2 * h + rect.top;
      return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
    });
    if (!inside) return;
    if (selectedStrokeIds.size === 0 && !selectedStroke) {
      selectStroke(stroke);
    } else {
      addToSelection(stroke);
    }
  });
}

function deleteSelectedStrokes() {
  if (selectedStrokeIds.size === 0) return;
  const ids = [...selectedStrokeIds];
  deselectAll();
  const idSet = new Set(ids);
  const toDelete = strokes.filter(s => idSet.has(s.id));
  toDelete.forEach(stroke => {
    scene.remove(stroke.threeObject);
    stroke.lineRef.geometry.dispose();
    stroke.lineRef.material.dispose();
    stroke.handleGroupRef.children.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
    stroke.snapConnections.forEach(otherId => {
      const other = strokes.find(s => s.id === otherId && !idSet.has(s.id));
      if (other) other.snapConnections = other.snapConnections.filter(i => !idSet.has(i));
    });
  });
  strokes.splice(0, strokes.length, ...strokes.filter(s => !idSet.has(s.id)));
  history.splice(0, history.length, ...history.filter(e => !idSet.has(e.strokeId)));
  saveCb?.();
}

function startGroupDrag(e) {
  const plane = getActivePlaneFn();
  if (!plane || !plane.meshRef) return;
  const hitPt = getPlaneIntersection(e, plane.meshRef);
  if (!hitPt) return;

  const startPositions = new Map();
  selectedStrokeIds.forEach(id => {
    const s = strokes.find(st => st.id === id);
    if (s) startPositions.set(id, s.points.map(p => ({ ...p })));
  });

  groupDragState = {
    plane,
    startHitPt:    { x: hitPt.x, y: hitPt.y, z: hitPt.z },
    startPositions,
  };
  drawState = GROUP_DRAG;
  getControls().enabled = false;
  renderer.domElement.setPointerCapture(e.pointerId);
}

function handleGroupDrag(e) {
  if (!groupDragState) return;
  const { plane, startHitPt, startPositions } = groupDragState;
  const pt = getPlaneIntersection(e, plane.meshRef);
  if (!pt) return;

  const dx = pt.x - startHitPt.x;
  const dy = pt.y - startHitPt.y;
  const dz = pt.z - startHitPt.z;

  selectedStrokeIds.forEach(id => {
    const s      = strokes.find(st => st.id === id);
    const origPts = startPositions.get(id);
    if (!s || !origPts) return;
    origPts.forEach((op, i) => {
      s.points[i] = { x: op.x + dx, y: op.y + dy, z: op.z + dz };
      s.handleGroupRef?.children[i]?.position.set(s.points[i].x, s.points[i].y, s.points[i].z);
    });
    regenerateStrokeGeometry(s);
  });
}

// ─── Annotation helpers ───────────────────────────────────────────────────────
function updateAnnotationLabels() {
  if (!renderer) return;
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  annotations.forEach(ann => {
    if (!ann.labelEl) return;
    const mid = new THREE.Vector3(
      (ann.p1.x + ann.p2.x) / 2,
      (ann.p1.y + ann.p2.y) / 2,
      (ann.p1.z + ann.p2.z) / 2
    );
    const v = mid.clone().project(camera);
    ann.labelEl.style.left = `${(v.x + 1) / 2 * w + 8}px`;
    ann.labelEl.style.top  = `${(-v.y + 1) / 2 * h - 18}px`;
  });
}

function createAnnotation(p1, p2, planeId) {
  const id = 'annot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const group = new THREE.Group();

  // Line2 between the two points
  const lineGeo = new LineGeometry();
  lineGeo.setPositions([p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]);
  const lineMat = new LineMaterial({
    color:      new THREE.Color(ANNOTATION_COLOR),
    linewidth:  1,
    resolution: new THREE.Vector2(renderer.domElement.clientWidth, renderer.domElement.clientHeight),
  });
  const annLine = new Line2(lineGeo, lineMat);
  group.add(annLine);

  // Endpoint sphere markers
  const spGeo  = new THREE.SphereGeometry(0.05, 8, 8);
  const sp1    = new THREE.Mesh(spGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(ANNOTATION_COLOR) }));
  sp1.position.set(p1.x, p1.y, p1.z);
  group.add(sp1);

  const sp2    = new THREE.Mesh(spGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(ANNOTATION_COLOR) }));
  sp2.position.set(p2.x, p2.y, p2.z);
  group.add(sp2);

  scene.add(group);

  // Floating HTML label
  const overlay = document.getElementById('dimension-overlay');
  const labelEl = document.createElement('div');
  labelEl.className   = 'annotation-label';
  const dist = new THREE.Vector3(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z).length();
  labelEl.textContent = dist.toFixed(2);
  if (overlay) overlay.appendChild(labelEl);

  annotations.push({ id, planeId, p1: { ...p1 }, p2: { ...p2 }, threeObject: group, labelEl });
  saveCb?.();
}

function deleteAnnotation(id) {
  const idx = annotations.findIndex(a => a.id === id);
  if (idx === -1) return;
  const ann = annotations[idx];
  scene.remove(ann.threeObject);
  ann.threeObject.children.forEach(child => {
    child.geometry?.dispose();
    child.material?.dispose();
  });
  ann.labelEl?.remove();
  annotations.splice(idx, 1);
  saveCb?.();
}

// Uses already-set raycaster (call setNDC first)
function findAnnotationAt() {
  for (const ann of annotations) {
    const hits = raycaster.intersectObjects(ann.threeObject.children, false);
    if (hits.length > 0) return ann;
  }
  return null;
}

function makeAnnotStartMarker(position) {
  const geo  = new THREE.SphereGeometry(0.07, 8, 8);
  const mat  = new THREE.MeshBasicMaterial({ color: new THREE.Color(ANNOTATION_COLOR) });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(position);
  return mesh;
}

function handleAnnotatePointerUp(e) {
  const plane = getActivePlaneFn();
  if (!plane || !plane.meshRef) return;

  if (annotState === 'idle') {
    // Use pointerdown position for snap reliability on mobile
    const sx   = pendingStartScreenPos?.x ?? e.clientX;
    const sy   = pendingStartScreenPos?.y ?? e.clientY;
    const snap = pendingLineStartSnap ?? snapEndpoint(sx, sy) ?? snapLine(sx, sy);
    pendingLineStartSnap  = null;
    pendingStartScreenPos = null;
    const raw  = snap ? null : getPlaneIntersection({ clientX: sx, clientY: sy }, plane.meshRef);
    if (!snap && !raw) return;
    const startPt = snap ? snap.point : applyGridSnap({ x: raw.x, y: raw.y, z: raw.z }, plane);

    annotStartPoint  = new THREE.Vector3(startPt.x, startPt.y, startPt.z);
    annotStartSnap   = snap ?? null;
    if (annotStartMarker) scene.remove(annotStartMarker);
    annotStartMarker = makeAnnotStartMarker(annotStartPoint);
    scene.add(annotStartMarker);
    annotState = 'awaiting_second';
    hideSnapIndicator();
  } else {
    pendingLineStartSnap  = null;
    pendingStartScreenPos = null;
    const snap = snapEndpoint(e.clientX, e.clientY) ?? snapLine(e.clientX, e.clientY);
    const raw  = snap ? null : getPlaneIntersection(e, plane.meshRef);
    if (!snap && !raw) return;
    const endPt = snap ? snap.point : applyGridSnap({ x: raw.x, y: raw.y, z: raw.z }, plane);

    if (annotStartMarker) { scene.remove(annotStartMarker); annotStartMarker = null; }
    createAnnotation(annotStartPoint, endPt, plane.id);
    annotStartPoint = null;
    annotStartSnap  = null;
    annotState = 'idle';
    hideSnapIndicator();
  }
}

// ─── Pointer handlers ─────────────────────────────────────────────────────────
function onPointerDown(e) {
  if (activeTool === 'line' || activeTool === 'erase' || activeTool === 'annotate') {
    pointerDownPos       = { x: e.clientX, y: e.clientY };
    if (activeTool === 'line' || activeTool === 'annotate') {
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
    if (!handleGizmoPointerDown(e)) handleSelectPointerDown(e);
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
    fillCoordPolar(endPt, plane);

  } else if (drawState === PLANE_DRAG) {
    handleGizmoDrag(e);

  } else if (drawState === GROUP_DRAG) {
    handleGroupDrag(e);

  } else if (activeTool === 'select' && drawState === SELECT_HANDLE_DRAGGING) {
    handleSelectDrag(e);

  } else if (activeTool === 'select' && lassoState) {
    const dist = Math.hypot(e.clientX - lassoState.startX, e.clientY - lassoState.startY);
    if (dist >= 8) {
      lassoState.started = true;
      updateLassoDisplay(lassoState.startX, lassoState.startY, e.clientX, e.clientY);
    }

  } else if ((activeTool === 'line' || activeTool === 'freehand' || activeTool === 'annotate') && drawState === STATE_IDLE) {
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
    } else {
      const annHit = findAnnotationAt();
      if (annHit) deleteAnnotation(annHit.id);
    }

  } else if (activeTool === 'annotate') {
    if (!pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;
    pointerDownPos = null;
    if (Math.hypot(dx, dy) >= TAP_MOVE_THRESHOLD) return; // orbit gesture, not tap
    handleAnnotatePointerUp(e);

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
    strokeColor:      null,
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
    strokeColor:      null,
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

// ─── Move gizmo interaction ───────────────────────────────────────────────────
function handleGizmoPointerDown(e) {
  setNDC(e);
  const gizmoMeshes = getAllPlanes().flatMap(p => p.moveGizmoMeshes ?? []);
  if (!gizmoMeshes.length) return false;
  const hits = raycaster.intersectObjects(gizmoMeshes, false);
  if (!hits.length) return false;

  const hit     = hits[0];
  const axis    = hit.object.userData.gizmoAxis;    // THREE.Vector3
  const planeId = hit.object.userData.gizmoPlaneId;
  const plane   = getPlaneById(planeId);
  if (!plane || !axis) return false;

  // Helper plane: contains drag axis, best-facing the camera
  const camDir = camera.getWorldDirection(new THREE.Vector3());
  const perp   = new THREE.Vector3().crossVectors(axis, camDir);
  const hNorm  = new THREE.Vector3().crossVectors(perp, axis).normalize();
  if (hNorm.lengthSq() < 0.001) hNorm.copy(camDir); // axis parallel to camera → fallback
  const helperPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(hNorm, hit.point);

  deselectAll();
  planeDragState = {
    plane,
    axis:       axis.clone(),
    helperPlane,
    startHitPt: hit.point.clone(),
    startPos:   new THREE.Vector3(plane.position.x, plane.position.y, plane.position.z),
  };
  drawState = PLANE_DRAG;
  getControls().enabled = false;
  renderer.domElement.setPointerCapture(e.pointerId);
  return true;
}

function handleGizmoDrag(e) {
  if (!planeDragState) return;
  const { plane, axis, helperPlane, startHitPt, startPos } = planeDragState;
  setNDC(e);
  const hitPt = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(helperPlane, hitPt)) return;

  const delta  = hitPt.clone().sub(startHitPt).dot(axis);
  const newPos = startPos.clone().addScaledVector(axis, delta);
  const dp     = newPos.clone().sub(new THREE.Vector3(plane.position.x, plane.position.y, plane.position.z));

  plane.threeObject.position.copy(newPos);
  plane.position = { x: newPos.x, y: newPos.y, z: newPos.z };
  if (plane.moveGizmoGroup) plane.moveGizmoGroup.position.copy(newPos);

  // Live-update side panel position inputs (skip any field that is focused)
  const ppx = document.getElementById('plane-pos-x');
  const ppy = document.getElementById('plane-pos-y');
  const ppz = document.getElementById('plane-pos-z');
  if (ppx && document.activeElement !== ppx) ppx.value = newPos.x.toFixed(2);
  if (ppy && document.activeElement !== ppy) ppy.value = newPos.y.toFixed(2);
  if (ppz && document.activeElement !== ppz) ppz.value = newPos.z.toFixed(2);

  // Translate all strokes on this plane so they co-move
  strokes.filter(s => s.planeId === plane.id).forEach(stroke => {
    stroke.points.forEach(pt => { pt.x += dp.x; pt.y += dp.y; pt.z += dp.z; });
    stroke.handleGroupRef?.children.forEach(h => {
      h.position.x += dp.x; h.position.y += dp.y; h.position.z += dp.z;
    });
    regenerateStrokeGeometry(stroke);
  });

  // Translate all annotations on this plane
  annotations.filter(a => a.planeId === plane.id).forEach(ann => {
    ann.p1.x += dp.x; ann.p1.y += dp.y; ann.p1.z += dp.z;
    ann.p2.x += dp.x; ann.p2.y += dp.y; ann.p2.z += dp.z;
    ann.threeObject.children[0].geometry.setPositions([
      ann.p1.x, ann.p1.y, ann.p1.z,
      ann.p2.x, ann.p2.y, ann.p2.z,
    ]);
    ann.threeObject.children[1].position.set(ann.p1.x, ann.p1.y, ann.p1.z);
    ann.threeObject.children[2].position.set(ann.p2.x, ann.p2.y, ann.p2.z);
  });
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
    if (stroke) {
      if (e.ctrlKey || e.metaKey) {
        addToSelection(stroke);
      } else if (selectedStrokeIds.has(stroke.id) && selectedStrokeIds.size > 1) {
        // Start group drag — keeps current multi-selection
        startGroupDrag(e);
      } else {
        selectStroke(stroke);
      }
      return;
    }
  }

  // 3. Nothing hit — start lasso rect
  if (!(e.ctrlKey || e.metaKey)) deselectAll();
  lassoState = { startX: e.clientX, startY: e.clientY, additive: e.ctrlKey || e.metaKey, started: false };
  renderer.domElement.setPointerCapture(e.pointerId);
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
  if (drawState === PLANE_DRAG) {
    drawState      = SELECT_IDLE;
    planeDragState = null;
    getControls().enabled = (activeTool === 'orbit');
    saveCb?.();
    return;
  }

  if (drawState === GROUP_DRAG) {
    drawState = SELECT_IDLE;
    getControls().enabled = (activeTool === 'orbit');
    if (groupDragState) {
      const entries = [];
      selectedStrokeIds.forEach(id => {
        const s       = strokes.find(st => st.id === id);
        const origPts = groupDragState.startPositions.get(id);
        if (!s || !origPts) return;
        entries.push({ strokeId: id, oldPoints: origPts, newPoints: s.points.map(p => ({ ...p })) });
      });
      if (entries.some(en => JSON.stringify(en.oldPoints) !== JSON.stringify(en.newPoints))) {
        pushHistory({ action: 'move_group', entries });
        saveCb?.();
      }
      groupDragState = null;
    }
    return;
  }

  if (lassoState) {
    if (lassoState.started) finalizeLasso(lassoState.startX, lassoState.startY, e.clientX, e.clientY, lassoState.additive);
    hideLassoRectEl();
    lassoState = null;
    return;
  }

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
  selectedStrokeIds.add(stroke.id);
  if (stroke.type === 'line' && stroke.points.length === 2) {
    const plane = getPlaneById(stroke.planeId) || getActivePlaneFn();
    if (plane) showCoordBarForSelect(stroke, plane);
  }
  colorTargetId = stroke.id;
  strokeSelectCb?.(stroke.strokeColor || stroke.color, !!stroke.strokeColor);
}

function addToSelection(stroke) {
  if (selectedStrokeIds.has(stroke.id)) {
    // Toggle off
    selectedStrokeIds.delete(stroke.id);
    stroke.selected = false;
    stroke.lineRef.material.color.set(new THREE.Color(stroke.strokeColor || stroke.color));
    stroke.handleGroupRef.visible = false;
    if (selectedStroke?.id === stroke.id) {
      commitSelectEdit();
      selectedStroke = null;
      hideCoordBar();
      strokeSelectCb?.(null, false);
    }
    return;
  }
  // Downgrade primary to secondary (orange, no handles, no coord bar)
  if (selectedStroke) {
    selectedStroke.lineRef.material.color.set(0xff8c00);
    selectedStroke.handleGroupRef.visible = false;
    commitSelectEdit();
    hideCoordBar();
    strokeSelectCb?.(null, false);
    selectedStroke = null;
  }
  stroke.selected = true;
  stroke.lineRef.material.color.set(0xff8c00);
  selectedStrokeIds.add(stroke.id);
}

function deselectAll() {
  commitSelectEdit();
  selectedStrokeIds.forEach(id => {
    const s = strokes.find(st => st.id === id);
    if (s) {
      s.lineRef.material.color.set(new THREE.Color(s.strokeColor || s.color));
      s.handleGroupRef.visible = false;
      s.selected = false;
    }
  });
  selectedStrokeIds.clear();
  if (selectedStroke) {
    selectedStroke = null;
    strokeSelectCb?.(null, false);
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
export function moveStrokesToNewPlanePosition(planeId, dx, dy, dz) {
  strokes.filter(s => s.planeId === planeId).forEach(stroke => {
    stroke.points.forEach(pt => { pt.x += dx; pt.y += dy; pt.z += dz; });
    stroke.handleGroupRef?.children.forEach(h => {
      h.position.x += dx; h.position.y += dy; h.position.z += dz;
    });
    regenerateStrokeGeometry(stroke);
  });
}

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

  } else if (entry.action === 'move_group') {
    entry.entries.forEach(({ strokeId, oldPoints }) => {
      const stroke = strokes.find(s => s.id === strokeId);
      if (!stroke) return;
      oldPoints.forEach((pt, i) => {
        stroke.points[i] = { ...pt };
        stroke.handleGroupRef.children[i]?.position.set(pt.x, pt.y, pt.z);
      });
      regenerateStrokeGeometry(stroke);
    });
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
  if (activeTool === 'select' && toolName !== 'select') {
    deselectAll();
    hideLassoRectEl();
    lassoState = null;
  }
  if (activeTool === 'annotate' && toolName !== 'annotate' && annotState !== 'idle') {
    annotState = 'idle';
    if (annotStartMarker) { scene.remove(annotStartMarker); annotStartMarker = null; }
    annotStartPoint = null;
  }

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
  const effectiveColor = strokeData.strokeColor || strokeData.color;
  const lineObj     = buildLineObject(strokeData.points, effectiveColor);
  const handleGroup = buildHandleGroup(strokeData.points, effectiveColor);
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
    strokeColor:      strokeData.strokeColor ?? null,
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

export function copySelectedStroke() {
  if (!selectedStroke) return false;
  clipboard = {
    type:          selectedStroke.type,
    points:        selectedStroke.points.map(p => ({ x: p.x, y: p.y, z: p.z })),
    sourcePlaneId: selectedStroke.planeId,
    strokeColor:   selectedStroke.strokeColor ?? null,
  };
  return true;
}

export function pasteStroke() {
  if (!clipboard) return false;
  const targetPlane = getActivePlaneFn();
  if (!targetPlane) return false;

  const OFFSET = 0.25;
  const sourcePlane = getPlaneById(clipboard.sourcePlaneId);

  const newPoints = clipboard.points.map(wp => {
    const v = new THREE.Vector3(wp.x, wp.y, wp.z);
    if (sourcePlane) sourcePlane.threeObject.worldToLocal(v);
    v.x += OFFSET;
    v.y += OFFSET;
    v.z = 0;
    targetPlane.threeObject.localToWorld(v);
    return { x: v.x, y: v.y, z: v.z };
  });

  const strokeId = 'stroke_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const pasteColor = clipboard.strokeColor || targetPlane.color;
  const stroke = {
    id:              strokeId,
    planeId:         targetPlane.id,
    type:            clipboard.type,
    color:           targetPlane.color,
    strokeColor:     clipboard.strokeColor ?? null,
    selected:        false,
    points:          newPoints,
    snapConnections: [],
  };

  stroke.threeObject    = new THREE.Group();
  stroke.lineRef        = buildLineObject(stroke.points, pasteColor);
  stroke.handleGroupRef = buildHandleGroup(stroke.points, pasteColor);
  stroke.handleGroupRef.visible = false;
  stroke.handleGroupRef.children.forEach(m => { m.userData.strokeId = strokeId; });
  stroke.threeObject.add(stroke.lineRef);
  stroke.threeObject.add(stroke.handleGroupRef);
  scene.add(stroke.threeObject);
  strokes.push(stroke);
  pushHistory({ action: 'add_stroke', strokeId });

  if (activeTool === 'select') {
    deselectAll();
    selectStroke(stroke);
  }

  saveCb();
  return true;
}

// ─── Annotation public API ────────────────────────────────────────────────────
export function getAnnotations() { return annotations; }

export function restoreAnnotation(data) {
  const group = new THREE.Group();

  const lineGeo = new LineGeometry();
  lineGeo.setPositions([data.p1.x, data.p1.y, data.p1.z, data.p2.x, data.p2.y, data.p2.z]);
  const lineMat = new LineMaterial({
    color:      new THREE.Color(ANNOTATION_COLOR),
    linewidth:  1,
    resolution: new THREE.Vector2(renderer.domElement.clientWidth, renderer.domElement.clientHeight),
  });
  const annLine = new Line2(lineGeo, lineMat);
  group.add(annLine);

  const spGeo = new THREE.SphereGeometry(0.05, 8, 8);
  const sp1   = new THREE.Mesh(spGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(ANNOTATION_COLOR) }));
  sp1.position.set(data.p1.x, data.p1.y, data.p1.z);
  group.add(sp1);

  const sp2   = new THREE.Mesh(spGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(ANNOTATION_COLOR) }));
  sp2.position.set(data.p2.x, data.p2.y, data.p2.z);
  group.add(sp2);

  scene.add(group);

  const overlay = document.getElementById('dimension-overlay');
  const labelEl = document.createElement('div');
  labelEl.className = 'annotation-label';
  const dist = new THREE.Vector3(data.p2.x - data.p1.x, data.p2.y - data.p1.y, data.p2.z - data.p1.z).length();
  labelEl.textContent = dist.toFixed(2);
  if (overlay) overlay.appendChild(labelEl);

  annotations.push({
    id:          data.id,
    planeId:     data.planeId,
    p1:          { ...data.p1 },
    p2:          { ...data.p2 },
    threeObject: group,
    labelEl,
  });
}

export function selectAllStrokes() {
  deselectAll();
  strokes.filter(s => s.threeObject.visible).forEach(s => {
    s.selected = true;
    s.lineRef.material.color.set(0xff8c00);
    selectedStrokeIds.add(s.id);
  });
}

export { deleteSelectedStrokes };

export function deleteAnnotationsByPlane(planeId) {
  [...annotations.filter(a => a.planeId === planeId)].forEach(a => deleteAnnotation(a.id));
}

export function moveAnnotationsToNewPlanePosition(planeId, dx, dy, dz) {
  annotations.filter(a => a.planeId === planeId).forEach(ann => {
    ann.p1.x += dx; ann.p1.y += dy; ann.p1.z += dz;
    ann.p2.x += dx; ann.p2.y += dy; ann.p2.z += dz;
    ann.threeObject.children[0].geometry.setPositions([
      ann.p1.x, ann.p1.y, ann.p1.z,
      ann.p2.x, ann.p2.y, ann.p2.z,
    ]);
    ann.threeObject.children[1].position.set(ann.p1.x, ann.p1.y, ann.p1.z);
    ann.threeObject.children[2].position.set(ann.p2.x, ann.p2.y, ann.p2.z);
  });
}
export function setStrokeSelectCallback(fn) {
  strokeSelectCb = fn;
}

export function setSelectedStrokeColor(hex) {
  const target = selectedStroke ?? strokes.find(s => s.id === colorTargetId);
  if (!target) return;
  target.strokeColor = hex;
  target.lineRef.material.color.set(hex);
  const handleColor = new THREE.Color(hex).lerp(new THREE.Color(0xffffff), 0.5);
  target.handleGroupRef.children.forEach(m => m.material.color.copy(handleColor));
  saveCb();
}

export function clearSelectedStrokeColor() {
  const target = selectedStroke ?? strokes.find(s => s.id === colorTargetId);
  if (!target) return;
  target.strokeColor = null;
  colorTargetId = null;
  const plane = getPlaneById(target.planeId);
  const col = plane?.color || target.color;
  target.lineRef.material.color.set(col);
  const handleColor = new THREE.Color(col).lerp(new THREE.Color(0xffffff), 0.5);
  target.handleGroupRef.children.forEach(m => m.material.color.copy(handleColor));
  strokeSelectCb?.(col, false);
  saveCb();
}

export function mirrorSelectedStroke(axis) {
  // axis: 'H' = flip local X (left-right), 'V' = flip local Y (up-down)
  if (!selectedStroke) return false;
  const plane = getPlaneById(selectedStroke.planeId);
  if (!plane) return false;

  const newPoints = selectedStroke.points.map(wp => {
    const v = new THREE.Vector3(wp.x, wp.y, wp.z);
    plane.threeObject.worldToLocal(v);
    if (axis === 'H') v.x = -v.x;
    else              v.y = -v.y;
    v.z = 0;
    plane.threeObject.localToWorld(v);
    return { x: v.x, y: v.y, z: v.z };
  });

  const strokeId = 'stroke_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const mirrorColor = selectedStroke.strokeColor || plane.color;
  const stroke = {
    id:              strokeId,
    planeId:         plane.id,
    type:            selectedStroke.type,
    color:           plane.color,
    strokeColor:     selectedStroke.strokeColor ?? null,
    selected:        false,
    points:          newPoints,
    snapConnections: [],
  };

  stroke.threeObject    = new THREE.Group();
  stroke.lineRef        = buildLineObject(stroke.points, mirrorColor);
  stroke.handleGroupRef = buildHandleGroup(stroke.points, mirrorColor);
  stroke.handleGroupRef.visible = false;
  stroke.handleGroupRef.children.forEach(m => { m.userData.strokeId = strokeId; });
  stroke.threeObject.add(stroke.lineRef);
  stroke.threeObject.add(stroke.handleGroupRef);
  scene.add(stroke.threeObject);
  strokes.push(stroke);
  pushHistory({ action: 'add_stroke', strokeId });

  if (activeTool === 'select') {
    deselectAll();
    selectStroke(stroke);
  }

  saveCb();
  return true;
}
