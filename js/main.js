import { initViewport, getScene, getCamera, getRenderer, startRenderLoop } from './viewport.js';
import {
  initPlanes, createDefaultPlane, addPlane,
  getActivePlane, getAllPlanes,
  setPlaneVisibility, setLinesVisible,
  setActivePlane, renamePlane,
  restorePlane,
} from './planes.js';
import {
  initDrawing, setActiveTool, undoLast,
  setPlaneStrokesVisible, getStrokes, restoreStroke,
  setSnapEnabled, isSnapEnabled,
} from './drawing.js';
import { initUI, updatePlaneList } from './ui.js';
import { save, load } from './storage.js';

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('viewport-canvas');

  // 1. Viewport: scene, camera, renderer, orbit controls, resize handling
  initViewport(canvas);
  const scene = getScene();

  // 2. Init plane system (must come before any plane creation)
  initPlanes(scene);

  // 3. Restore saved session or create defaults
  const saved = load();

  if (saved?.planes?.length) {
    saved.planes.forEach(p => restorePlane(p));
    // Ensure at least one plane is marked active
    if (!getAllPlanes().some(p => p.active)) {
      const first = getAllPlanes()[0];
      if (first) first.active = true;
    }
  } else {
    createDefaultPlane();
  }

  // 4. Save callback — called after every mutation
  const saveCb = () => save(getAllPlanes(), getStrokes());

  // 5. Drawing system
  initDrawing(scene, getCamera(), getRenderer(), getActivePlane, saveCb);
  setActiveTool('line');

  // 6. Restore saved strokes (each stroke knows its planeId via strokeData)
  if (saved?.strokes?.length) {
    saved.strokes.forEach(strokeData => restoreStroke(strokeData));
    // Re-apply lines visibility from saved plane state
    getAllPlanes().forEach(plane => {
      if (!plane.linesVisible) setPlaneStrokesVisible(plane.id, false);
    });
  }

  // 7. UI: toolbar, panel, plane list
  initUI(
    {
      getAllPlanes,
      setPlaneVisibility,
      addPlane: (orientation) => {
        addPlane(orientation);
        saveCb();
      },
      setActivePlane: (id) => {
        setActivePlane(id);
        saveCb();
      },
      renamePlane: (id, name) => {
        renamePlane(id, name);
        saveCb();
      },
    },
    (tool) => setActiveTool(tool),
    () => undoLast(),
    (planeId, visible) => {
      setPlaneStrokesVisible(planeId, visible);
      setLinesVisible(planeId, visible);
      saveCb();
    }
  );

  // 8. Snap toggle button
  const snapBtn = document.getElementById('snap-btn');
  if (snapBtn) {
    snapBtn.addEventListener('click', () => {
      const nowEnabled = !isSnapEnabled();
      setSnapEnabled(nowEnabled);
      snapBtn.classList.toggle('active', nowEnabled);
      snapBtn.title = nowEnabled ? 'Snapping on — click to disable' : 'Snapping off — click to enable';
    });
  }

  // 9. Render loop — must start last
  startRenderLoop();

  // 10. Service worker registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {
        // SW registration failure is non-fatal
      });
    });
  }
});
