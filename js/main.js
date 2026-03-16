import { initViewport, getScene, getCamera, getRenderer, startRenderLoop } from './viewport.js';
import { createDefaultPlane, getActivePlane, getAllPlanes, setPlaneVisibility, setLinesVisible } from './planes.js';
import { initDrawing, setActiveTool, undoLast, setPlaneStrokesVisible } from './drawing.js';
import { initUI, updatePlaneList } from './ui.js';

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('viewport-canvas');

  // 1. Viewport: scene, camera, renderer, orbit controls, resize handling
  initViewport(canvas);
  const scene = getScene();

  // 2. Default sketch plane
  createDefaultPlane(scene);

  // 3. Drawing system
  initDrawing(scene, getCamera(), getRenderer(), getActivePlane);
  setActiveTool('line'); // start in line mode

  // 4. UI: toolbar, panel, plane list
  initUI(
    { getAllPlanes, setPlaneVisibility },
    (tool) => setActiveTool(tool),
    () => undoLast(),
    (planeId, visible) => {
      setPlaneStrokesVisible(planeId, visible);
      setLinesVisible(planeId, visible);
    }
  );

  // 5. Render loop — must start last
  startRenderLoop();

  // 6. Service worker registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {
        // SW registration failure is non-fatal
      });
    });
  }
});
