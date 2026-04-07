import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let scene, camera, renderer, controls;
let cameraAnimation = null; // { targetPos, targetLookAt } — lerp animation state

export function initViewport(canvasElement) {
  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.FogExp2(0x1a1a2e, 0.025);

  // Camera
  const w = canvasElement.clientWidth;
  const h = canvasElement.clientHeight;
  camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);
  camera.position.set(0, 3, 8);

  // Renderer — pass the existing canvas element
  renderer = new THREE.WebGLRenderer({
    canvas: canvasElement,
    antialias: true,
    alpha: false
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false); // false = do not set CSS pixel size via inline style

  // OrbitControls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1;
  controls.maxDistance = 50;
  controls.enablePan = true;
  controls.panSpeed = 0.8;
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
  controls.enabled = false; // disabled until user selects the Orbit tool

  // Resize handler — ResizeObserver catches mobile address-bar changes too
  const resizeObserver = new ResizeObserver(() => {
    const cw = canvasElement.clientWidth;
    const ch = canvasElement.clientHeight;
    if (cw === 0 || ch === 0) return;
    renderer.setSize(cw, ch, false);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(canvasElement);
}

export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getRenderer() { return renderer; }
export function getControls() { return controls; }

export function getCameraState() {
  return {
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    target:   { x: controls.target.x, y: controls.target.y, z: controls.target.z },
  };
}

export function animateCameraTo(position, target) {
  cameraAnimation = {
    targetPos:    new THREE.Vector3(position.x, position.y, position.z),
    targetLookAt: new THREE.Vector3(target.x, target.y, target.z),
  };
}

function tickCameraAnimation() {
  if (!cameraAnimation) return;
  const { targetPos, targetLookAt } = cameraAnimation;
  camera.position.lerp(targetPos, 0.12);
  controls.target.lerp(targetLookAt, 0.12);
  if (camera.position.distanceTo(targetPos) < 0.005 && controls.target.distanceTo(targetLookAt) < 0.005) {
    camera.position.copy(targetPos);
    controls.target.copy(targetLookAt);
    cameraAnimation = null;
  }
}

export function startRenderLoop() {
  function loop() {
    requestAnimationFrame(loop);
    tickCameraAnimation();
    controls.update(); // required when enableDamping is true
    renderer.render(scene, camera);
  }
  loop();
}
