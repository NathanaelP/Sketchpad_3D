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
      orientation:    p.orientation || 'front',
      normal:         { ...p.normal },
      position:       { ...p.position },
      rotation:       p.rotation ? { ...p.rotation } : { x: 0, y: 0, z: 0 },
      gridResolution: p.gridResolution ?? 0.5,
      gridSnap:       p.gridSnap ?? true,
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
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    planes: planes.map(p => ({
      id:           p.id,
      name:         p.name,
      color:        p.color,
      visible:      p.visible,
      linesVisible: p.linesVisible ?? true,
      active:       p.active,
      orientation:    p.orientation || 'front',
      normal:         { ...p.normal },
      position:       { ...p.position },
      rotation:       p.rotation ? { ...p.rotation } : { x: 0, y: 0, z: 0 },
      gridResolution: p.gridResolution ?? 0.5,
      gridSnap:       p.gridSnap ?? true,
    })),
    strokes: strokes.map(s => ({
      id:              s.id,
      planeId:         s.planeId,
      type:            s.type,
      color:           s.color,
      points:          s.points.map(pt => ({ x: pt.x, y: pt.y, z: pt.z })),
      snapConnections: [...s.snapConnections],
    })),
  }, null, 2);
}

export function importJSON(jsonString) {
  const data = JSON.parse(jsonString);
  if (!Array.isArray(data.planes) || !Array.isArray(data.strokes)) {
    throw new Error('Invalid sketch file');
  }
  return data;
}
