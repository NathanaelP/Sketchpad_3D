import { initViewport, getScene, getCamera, getRenderer, startRenderLoop } from './viewport.js';
import { createDefaultPlane, getActivePlane, getAllPlanes, setPlaneVisibility, setLinesVisible } from './planes.js';
import { initDrawing, setActiveTool, undoLast, setPlaneStrokesVisible, getStrokes, restoreStroke, setSnapEnabled, isSnapEnabled } from './drawing.js';
import { initUI, updatePlaneList } from './ui.js';
import { save, load } from './storage.js';

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('viewport-canvas');

  // 1. Viewport: scene, camera, renderer, orbit controls, resize handling
  initViewport(canvas);
  const scene = getScene();

  // 2. Default sketch plane
  createDefaultPlane(scene);

  // 3. Save callback — called after every mutation
  const saveCb = () => save(getAllPlanes(), getStrokes());

  // 4. Drawing system
  initDrawing(scene, getCamera(), getRenderer(), getActivePlane, saveCb);
  setActiveTool('line'); // start in line mode

  // 5. Restore previous session
  const saved = load();
  if (saved?.strokes?.length) {
    const plane = getActivePlane();
    if (plane) {
      saved.strokes.forEach(strokeData => restoreStroke(strokeData, plane));
    }
  }

  // 6. UI: toolbar, panel, plane list
  initUI(
    { getAllPlanes, setPlaneVisibility },
    (tool) => setActiveTool(tool),
    () => undoLast(),
    (planeId, visible) => {
      setPlaneStrokesVisible(planeId, visible);
      setLinesVisible(planeId, visible);
    }
  );

  // 7. Snap toggle button
  const snapBtn = document.getElementById('snap-btn');
  if (snapBtn) {
    snapBtn.addEventListener('click', () => {
      const nowEnabled = !isSnapEnabled();
      setSnapEnabled(nowEnabled);
      snapBtn.classList.toggle('active', nowEnabled);
      snapBtn.title = nowEnabled ? 'Snapping on — click to disable' : 'Snapping off — click to enable';
    });
  }

  // 8. Render loop — must start last
  startRenderLoop();

  // 9. Service worker registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {
        // SW registration failure is non-fatal
      });
    });
  }
});
