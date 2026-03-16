let onToolChangeCb = null;
let onUndoCb = null;
let planesAPI = null;

// Track desktop panel open state separately
let desktopPanelOpen = true;

export function initUI(planes, onToolChange, onUndo) {
  planesAPI    = planes;
  onToolChangeCb = onToolChange;
  onUndoCb       = onUndo;

  setupToolButtons();
  setupUndoButton();
  setupPanelToggle();
  setupKeyboard();

  // Initial plane list render
  updatePlaneList(planesAPI.getAllPlanes());

  // Desktop: start with panel open
  if (isDesktop()) {
    document.getElementById('side-panel').classList.add('open');
    document.getElementById('panel-tab').classList.add('open');
  }
}

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

function setupUndoButton() {
  const btn = document.getElementById('undo-btn');
  if (btn) btn.addEventListener('click', () => { if (onUndoCb) onUndoCb(); });
}

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

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (onUndoCb) onUndoCb();
    }
  });
}

export function updatePlaneList(planes) {
  const list = document.getElementById('plane-list');
  if (!list) return;
  list.innerHTML = '';
  planes.forEach(plane => {
    list.appendChild(renderPlaneRow(plane));
  });
}

function renderPlaneRow(plane) {
  const row = document.createElement('div');
  row.className = 'plane-row' + (plane.active ? ' active' : '');
  row.dataset.planeId = plane.id;

  const dot = document.createElement('span');
  dot.className = 'color-dot';
  dot.style.background = plane.color;

  const name = document.createElement('span');
  name.className = 'plane-name';
  name.textContent = plane.name;

  const visBtn = document.createElement('button');
  visBtn.className = 'vis-btn' + (plane.visible ? '' : ' hidden');
  visBtn.title = 'Toggle visibility';
  visBtn.innerHTML = '&#128065;'; // 👁
  visBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (planesAPI && planesAPI.setPlaneVisibility) {
      planesAPI.setPlaneVisibility(plane.id, !plane.visible);
      plane.visible = !plane.visible;
      visBtn.classList.toggle('hidden', !plane.visible);
    }
  });

  row.appendChild(dot);
  row.appendChild(name);
  row.appendChild(visBtn);

  return row;
}

function isDesktop() {
  return window.matchMedia('(min-width: 900px)').matches;
}
