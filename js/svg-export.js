import * as THREE from 'three';
import { catmullRomCurve } from './curves.js';

// Project a world-space point to SVG pixel coordinates using the camera.
function project(pt, camera, w, h) {
  const v = new THREE.Vector3(pt.x, pt.y, pt.z).project(camera);
  return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h };
}

// Flatten all visible strokes to a 2D SVG matching the current viewport.
// planes:    array of plane objects (from getAllPlanes)
// strokes:   array of stroke objects (from getStrokes)
// camera:    THREE.Camera
// renderer:  THREE.WebGLRenderer
// lineWidth: current stroke width in px
export function exportSVG(planes, strokes, camera, renderer, lineWidth) {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;

  // A stroke is exported if its Three.js object is currently visible in the scene.
  // This exactly mirrors what the user sees — independent of plane grid visibility.
  const paths = strokes
    .filter(s => s.threeObject && s.threeObject.visible !== false && s.points?.length >= 2)
    .map(s => {
      const pts = catmullRomCurve(s.points, 20).map(pt => project(pt, camera, w, h));
      const d   = pts
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
        .join(' ');
      return `  <path d="${d}" stroke="${s.color}" stroke-width="${lineWidth}" `
           + `fill="none" stroke-linecap="butt" stroke-linejoin="round"/>`;
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `  <rect width="100%" height="100%" fill="#1a1a2e"/>`,
    ...paths,
    '</svg>',
  ].join('\n');
}
