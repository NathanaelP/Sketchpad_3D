let onToolChangeCb            = null;
let onUndoCb                  = null;
let onLinesVisibilityToggleCb = null;
let onDeletePlaneCb           = null;
let planesAPI                 = null;

// Track desktop panel open state separately
let desktopPanelOpen = true;

// planes API shape:
//   { getAllPlanes, setPlaneVisibility, addPlane, setActivePlane, renamePlane, deletePlane }
export function initUI(planes, onToolChange, onUndo, onLinesVisibilityToggle, onDeletePlane) {
  planesAPI              = planes;
  onToolChangeCb         = onToolChange;
  onUndoCb               = onUndo;
  onLinesVisibilityToggleCb = onLinesVisibilityToggle || null;
  onDeletePlaneCb        = onDeletePlane || null;

  setupToolButtons();
  setupUndoButton();
  setupPanelToggle();
  setupAddPlane();
  setupKeyboard();

  updatePlaneList(planesAPI.getAllPlanes());

  if (isDesktop()) {
    document.getElementById('side-panel').classList.add('open');
    document.getElementById('panel-tab').classList.add('open');
  }
}

// ─── Tool buttons ─────────────────────────────────────────────────────────────

function setupToolButtons() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const label = document.getElementById('active-tool-label');
      if (label) label.textContent = tool.charAt(0).toUpperCase() + tool.slice(1);
      if (onToolChangeCb) onToolChangeCb(tool);
    });
  });
}

// ─── Undo button ──────────────────────────────────────────────────────────────

function setupUndoButton() {
  const btn = document.getElementById('undo-btn');
  if (btn) btn.addEventListener('click', () => { if (onUndoCb) onUndoCb(); });
}

// ─── Panel toggle ─────────────────────────────────────────────────────────────

function setupPanelToggle() {
  const menuBtn  = document.getElementById('menu-btn');
  const panelTab = document.getElementById('panel-tab');
  if (menuBtn)  menuBtn.addEventListener('click', togglePanel);
  if (panelTab) panelTab.addEventListener('click', togglePanel);
}

function togglePanel() {
  const panel = document.getElementById('side-panel');
  const tab   = document.getElementById('panel-tab');
  const app   = document.getElementById('app');
  const isOpen = panel.classList.contains('open');

  panel.classList.toggle('open', !isOpen);
  tab.classList.toggle('open', !isOpen);
  tab.innerHTML = isOpen ? '&#9654;' : '&#9664;'; // ▶ or ◀

  if (isDesktop()) {
    app.classList.toggle('panel-closed', isOpen);
  }
}

// ─── Add plane + orientation picker ──────────────────────────────────────────

function setupAddPlane() {
  const addBtn  = document.getElementById('add-plane-btn');
  const picker  = document.getElementById('orientation-picker');
  if (!addBtn || !picker) return;

  // Toggle picker visibility
  addBtn.addEventListener('click', () => {
    const showing = picker.classList.contains('visible');
    picker.classList.toggle('visible', !showing);
    addBtn.textContent = showing ? '+ Add Plane' : '✕ Cancel';
  });

  // Each orientation button creates a plane and hides the picker
  picker.querySelectorAll('.orient-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (planesAPI?.addPlane) {
        planesAPI.addPlane(btn.dataset.orient);
        updatePlaneList(planesAPI.getAllPlanes());
      }
      picker.classList.remove('visible');
      addBtn.textContent = '+ Add Plane';
    });
  });
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (onUndoCb) onUndoCb();
    }
  });
}

// ─── Plane list ───────────────────────────────────────────────────────────────

export function updatePlaneList(planes) {
  const list = document.getElementById('plane-list');
  if (!list) return;
  list.innerHTML = '';
  const canDelete = planes.length > 1;
  planes.forEach(plane => list.appendChild(renderPlaneRow(plane, canDelete)));
}

function renderPlaneRow(plane, canDelete) {
  const row = document.createElement('div');
  row.className = 'plane-row' + (plane.active ? ' active' : '');
  row.dataset.planeId = plane.id;

  // Color dot — clicking the dot or row background activates the plane
  const dot = document.createElement('span');
  dot.className   = 'color-dot';
  dot.style.background = plane.color;

  // Editable name — single tap opens inline input
  const name = document.createElement('span');
  name.className   = 'plane-name';
  name.textContent = plane.name;
  name.title       = 'Tap to rename';

  name.addEventListener('click', (e) => {
    e.stopPropagation(); // don't activate the plane
    startNameEdit(plane, name, row);
  });

  // Grid visibility toggle (eye icon)
  const visBtn = document.createElement('button');
  visBtn.className = 'vis-btn' + (plane.visible ? '' : ' hidden');
  visBtn.title     = 'Toggle grid visibility';
  visBtn.innerHTML = '&#128065;'; // 👁
  visBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (planesAPI?.setPlaneVisibility) {
      planesAPI.setPlaneVisibility(plane.id, !plane.visible);
      visBtn.classList.toggle('hidden', !plane.visible);
    }
  });

  // Lines visibility toggle (pencil icon)
  const linesBtn = document.createElement('button');
  linesBtn.className = 'vis-btn' + (plane.linesVisible ? '' : ' hidden');
  linesBtn.title     = 'Toggle lines visibility';
  linesBtn.innerHTML = '&#9998;'; // ✎
  linesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (onLinesVisibilityToggleCb) {
      onLinesVisibilityToggleCb(plane.id, !plane.linesVisible);
      linesBtn.classList.toggle('hidden', !plane.linesVisible);
    }
  });

  // Row click (not on buttons/name) → make this plane active
  row.addEventListener('click', () => {
    if (planesAPI?.setActivePlane) {
      planesAPI.setActivePlane(plane.id);
      updatePlaneList(planesAPI.getAllPlanes());
    }
  });

  row.appendChild(dot);
  row.appendChild(name);
  row.appendChild(linesBtn);
  row.appendChild(visBtn);

  // Delete button — only shown when more than one plane exists
  if (canDelete) {
    const delBtn = document.createElement('button');
    delBtn.className = 'vis-btn del-btn';
    delBtn.title     = 'Delete plane and its strokes';
    delBtn.innerHTML = '&#x1F5D1;'; // 🗑
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onDeletePlaneCb) onDeletePlaneCb(plane.id);
    });
    row.appendChild(delBtn);
  }

  return row;
}

// Inline name editing — replaces the name span with an input while editing.
function startNameEdit(plane, nameSpan, row) {
  const input = document.createElement('input');
  input.type      = 'text';
  input.value     = plane.name;
  input.className = 'plane-name-input';

  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const newName = input.value.trim() || plane.name;
    if (planesAPI?.renamePlane) planesAPI.renamePlane(plane.id, newName);
    // Replace input back with a fresh span reflecting the new name
    updatePlaneList(planesAPI.getAllPlanes());
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { input.blur(); }
    if (e.key === 'Escape') { input.value = plane.name; input.blur(); }
    e.stopPropagation(); // prevent global Ctrl+Z etc. during typing
  });

  void row; // row ref kept for future use
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isDesktop() {
  return window.matchMedia('(min-width: 900px)').matches;
}
