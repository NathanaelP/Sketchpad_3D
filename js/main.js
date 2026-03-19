import { initViewport, getScene, getCamera, getRenderer, startRenderLoop } from './viewport.js';
import {
  initPlanes, createDefaultPlane, addPlane,
  getActivePlane, getAllPlanes,
  setPlaneVisibility, setLinesVisible,
  setActivePlane, renamePlane,
  restorePlane, deletePlane, clearAllPlanes,
} from './planes.js';
import {
  initDrawing, setActiveTool, undoLast,
  setPlaneStrokesVisible, getStrokes, restoreStroke,
  setSnapEnabled, isSnapEnabled,
  setLineWidth, getLineWidth,
  deleteStrokesByPlane,
} from './drawing.js';
import { initUI, updatePlaneList } from './ui.js';
import { save, load, exportJSON, importJSON } from './storage.js';
import { exportSVG } from './svg-export.js';

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
    },
    (planeId) => {
      deleteStrokesByPlane(planeId);
      deletePlane(planeId);
      updatePlaneList(getAllPlanes());
      saveCb();
    }
  );

  // 7b. Line width slider
  const lwSlider = document.getElementById('line-width-slider');
  const lwValue  = document.getElementById('line-width-value');
  if (lwSlider) {
    lwSlider.value = getLineWidth();
    lwSlider.addEventListener('input', () => {
      const w = parseInt(lwSlider.value, 10);
      setLineWidth(w);
      if (lwValue) lwValue.textContent = `${w}px`;
    });
  }

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

  // 9. File I/O — export JSON, import JSON, export SVG
  function downloadFile(content, filename, mime) {
    const a = document.createElement('a');
    a.href     = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  document.getElementById('export-json-btn')?.addEventListener('click', () => {
    downloadFile(exportJSON(getAllPlanes(), getStrokes()), 'sketch.json', 'application/json');
  });

  document.getElementById('export-svg-btn')?.addEventListener('click', () => {
    downloadFile(
      exportSVG(getAllPlanes(), getStrokes(), getCamera(), getRenderer(), getLineWidth()),
      'sketch.svg', 'image/svg+xml'
    );
  });

  document.getElementById('import-json-btn')?.addEventListener('click', () => {
    document.getElementById('import-file-input')?.click();
  });

  document.getElementById('import-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = ''; // allow re-importing the same file
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = importJSON(ev.target.result);
        // Clear existing state
        getAllPlanes().forEach(p => deleteStrokesByPlane(p.id));
        clearAllPlanes();
        // Restore from imported data
        data.planes.forEach(p => restorePlane(p));
        data.strokes.forEach(s => restoreStroke(s));
        // Activate the plane that was active at export time
        const active = data.planes.find(p => p.active);
        if (active) setActivePlane(active.id);
        else if (getAllPlanes().length) getAllPlanes()[0].active = true;
        // Re-apply lines visibility
        getAllPlanes().forEach(plane => {
          if (!plane.linesVisible) setPlaneStrokesVisible(plane.id, false);
        });
        updatePlaneList(getAllPlanes());
        saveCb();
      } catch (err) {
        alert('Could not load sketch: ' + err.message);
      }
    };
    reader.readAsText(file);
  });

  // 10. Render loop — must start last
  startRenderLoop();

  // 11. Service worker registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {
        // SW registration failure is non-fatal
      });
    });
  }
});
