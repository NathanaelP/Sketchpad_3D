const STORAGE_KEY = 'sketchpad_autosave';

export function save(planes, strokes) {
  const data = {
    version: 1,
    planes: planes.map(p => ({
      id:           p.id,
      name:         p.name,
      color:        p.color,
      visible:      p.visible,
      linesVisible: p.linesVisible,
      active:       p.active,
      normal:       { ...p.normal },
      position:     { ...p.position },
    })),
    strokes: strokes.map(s => ({
      id:               s.id,
      planeId:          s.planeId,
      type:             s.type,
      color:            s.color,
      points:           s.points.map(pt => ({ x: pt.x, y: pt.y, z: pt.z })),
      snapConnections:  [...s.snapConnections],
    })),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage quota exceeded or unavailable — non-fatal
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function exportJSON(planes, strokes) {
  // Stub until Phase 5
}

export function importJSON(data) {
  // Stub until Phase 5
}
