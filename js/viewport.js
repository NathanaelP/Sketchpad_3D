import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let scene, camera, renderer, controls;

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

export function startRenderLoop() {
  function loop() {
    requestAnimationFrame(loop);
    controls.update(); // required when enableDamping is true
    renderer.render(scene, camera);
  }
  loop();
}
