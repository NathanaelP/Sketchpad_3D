import * as THREE from 'three';
import { getCamera, getControls } from './viewport.js';

const SIZE  = 80;  // canvas px
const RADIUS = 28; // axis arm length in px
const DOT_R  = { pos: 7, neg: 5 };

const AXES = [
  { dir: new THREE.Vector3( 1,  0,  0), label: 'X', color: '#ff4444', neg: false },
  { dir: new THREE.Vector3(-1,  0,  0), label: '',   color: '#7a1a1a', neg: true  },
  { dir: new THREE.Vector3( 0,  1,  0), label: 'Y', color: '#44cc44', neg: false },
  { dir: new THREE.Vector3( 0, -1,  0), label: '',   color: '#1a5c1a', neg: true  },
  { dir: new THREE.Vector3( 0,  0,  1), label: 'Z', color: '#4488ff', neg: false },
  { dir: new THREE.Vector3( 0,  0, -1), label: '',   color: '#1a2e6e', neg: true  },
];

let canvas, ctx, camera, controls;
let animating = false;

export function initViewGizmo() {
  canvas   = document.getElementById('view-gizmo');
  if (!canvas) return;
  ctx      = canvas.getContext('2d');
  camera   = getCamera();
  controls = getControls();

  canvas.addEventListener('click', onGizmoClick);
  canvas.addEventListener('pointerdown', e => e.stopPropagation());

  (function loop() { draw(); requestAnimationFrame(loop); })();
}

// ─── Drawing ──────────────────────────────────────────────────────────────────

function project(axisDir) {
  // Transform world axis direction into camera-local space (camera looks along -Z).
  // v.x / v.y give the screen-space projection; v.z is depth.
  const v = axisDir.clone().applyQuaternion(camera.quaternion.clone().invert());
  return {
    px:    SIZE / 2 + v.x * RADIUS,
    py:    SIZE / 2 - v.y * RADIUS, // screen Y is inverted
    depth: v.z,                      // higher = closer to camera → draw on top
  };
}

function draw() {
  ctx.clearRect(0, 0, SIZE, SIZE);

  // Circular dark background
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle   = 'rgba(18, 18, 32, 0.72)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth   = 1;
  ctx.stroke();

  // Project + sort back-to-front (lowest depth drawn first)
  const pts = AXES.map(a => ({ ...a, ...project(a.dir) }));
  pts.sort((a, b) => a.depth - b.depth);

  // Arms
  pts.forEach(p => {
    ctx.beginPath();
    ctx.moveTo(SIZE / 2, SIZE / 2);
    ctx.lineTo(p.px, p.py);
    ctx.strokeStyle = p.color;
    ctx.lineWidth   = p.neg ? 1 : 1.5;
    ctx.globalAlpha = p.neg ? 0.45 : 0.85;
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // Dots + labels
  pts.forEach(p => {
    const r = p.neg ? DOT_R.neg : DOT_R.pos;
    ctx.beginPath();
    ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
    ctx.fillStyle   = p.color;
    ctx.globalAlpha = p.neg ? 0.55 : 1;
    ctx.fill();

    if (p.label) {
      ctx.fillStyle    = '#ffffff';
      ctx.globalAlpha  = 1;
      ctx.font         = 'bold 9px sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.label, p.px, p.py);
    }
  });
  ctx.globalAlpha = 1;
}

// ─── Click / snap ─────────────────────────────────────────────────────────────

function onGizmoClick(e) {
  if (animating) return;
  const rect = canvas.getBoundingClientRect();
  const mx   = e.clientX - rect.left;
  const my   = e.clientY - rect.top;

  let nearest = null, nearestDist = 14; // px hit radius
  AXES.forEach(a => {
    const { px, py } = project(a.dir);
    const d = Math.hypot(mx - px, my - py);
    if (d < nearestDist) { nearestDist = d; nearest = a; }
  });

  if (nearest) snapToAxis(nearest.dir);
}

function snapToAxis(dir) {
  const target = controls.target.clone();
  const dist   = camera.position.distanceTo(target);
  const toPos  = target.clone().addScaledVector(dir, dist);

  // Top/bottom views need a different up vector to avoid gimbal flip
  const up = (Math.abs(dir.y) > 0.9)
    ? new THREE.Vector3(0, 0, dir.y > 0 ? -1 : 1)
    : new THREE.Vector3(0, 1, 0);

  animateTo(toPos, target, up);
}

function animateTo(toPos, lookAt, upVec) {
  animating = true;
  controls.enabled = false;

  const fromPos = camera.position.clone();
  const fromUp  = camera.up.clone();
  const dur     = 380; // ms
  const t0      = performance.now();

  (function step(now) {
    const raw  = Math.min((now - t0) / dur, 1);
    const ease = 1 - Math.pow(1 - raw, 3); // cubic ease-out

    camera.position.lerpVectors(fromPos, toPos, ease);
    camera.up.lerpVectors(fromUp, upVec, ease).normalize();
    camera.lookAt(lookAt);
    controls.update();

    if (raw < 1) {
      requestAnimationFrame(step);
    } else {
      camera.position.copy(toPos);
      camera.up.copy(upVec);
      camera.lookAt(lookAt);
      controls.update();
      controls.enabled = true;
      animating = false;
    }
  })(t0);
}
