# 3D Sketch Pad — Project Blueprint

## What This App Is

A lightweight, touch-first 3D concept sketching tool that runs entirely in the browser.
It is designed to fill the gap between flat 2D paper sketching and full parametric CAD.
The goal is quick, intuitive ideation — letting a designer or maker place sketch planes
in 3D space and draw on them with their finger to visualize how a shape looks and feels
from all angles, without needing Onshape, Fusion 360, or any installed software.

Target users: makers, hobbyists, designers, and anyone who struggles to visualize
3D form from flat sketches.

Target devices: Android phones and tablets, iPhone and iPad, desktop browsers.
Primary test device: Samsung S25 Ultra (Chrome on Android).

---

## Tech Stack

- Vanilla HTML5, CSS3, JavaScript (ES6 modules)
- Three.js (loaded from CDN) — 3D viewport, scene, camera, rendering
- Three.js addons: `Line2`, `LineMaterial`, `LineGeometry` — thick line rendering
- Hammer.js (loaded from CDN) — unified touch and gesture handling
- No build tools, no frameworks, no npm required for runtime
- Hosted on GitHub Pages as a PWA (installable to home screen)
- Offline capable via service worker

---

## File Structure

```
/3d-sketch-pad
│
├── index.html              ← HTML shell, loads all scripts and styles
├── manifest.json           ← PWA manifest
├── site.webmanifest        ← PWA webmanifest (Apple/Android compatibility)
├── service-worker.js       ← Offline caching
├── styles.css              ← All application styles
├── CLAUDE.md               ← This file
│
├── js/
│   ├── main.js             ← App entry point, initialization, wires modules together
│   ├── viewport.js         ← Three.js scene, camera, renderer, orbit controls
│   ├── planes.js           ← Sketch plane creation, management, color assignment
│   ├── drawing.js          ← Line drawing modes (point-to-point, freehand, erase)
│   ├── curves.js           ← Bezier/Catmull-Rom spline math, control point logic
│   ├── snap.js             ← Snap detection (endpoint snap, line snap)
│   ├── ui.js               ← Side panel, plane list, toolbar, UI interactions
│   └── storage.js          ← Save/load sketches (localStorage + JSON export)
│
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

Each JS file has one clear job. Do not mix concerns between files.
When modifying behavior, identify the correct file first before editing.

---

## UI Layout

### Main Viewport
- Full screen Three.js canvas
- One finger drag = orbit camera
- Two finger pinch = zoom
- Three.js OrbitControls handles camera navigation

### Toolbar (top bar, always visible)
- App name / logo left side (hidden on mobile screens ≤599px CSS width)
- Active tool indicator — hidden on mobile to save space
- Tool toggle buttons: **Select**, **Line**, **Free**, **Erase**
- Snap toggle button (🧲) — toggles snapping on/off, glows blue when active
- Undo button (↩)
- Menu/hamburger button to open side panel

**Mobile responsive**: On screens ≤599px, non-essential elements are hidden and buttons
are compacted so all 4 tool buttons + 3 icon buttons fit without horizontal overflow.

### Side Panel (collapsible, slides in from left)
- Collapsed by default on mobile — a visible tab or arrow stays on screen
- Open by default on desktop (≥900px)
- Line width slider (1–12px) at top of panel
- Plane management list below:
  - Color swatch dot
  - Plane name (tap to rename inline)
  - Lines visibility toggle (✎ pencil icon)
  - Grid visibility toggle (👁 eye icon)
  - Delete button (🗑 trash icon) — shown only when >1 plane exists
  - Active plane highlighted
  - Tap row to make that plane active drawing surface
- Bottom of panel:
  - "+ Add Plane" button → reveals orientation picker
  - Orientation picker: Front, Top, Right
- Panel overlays the canvas on mobile, pushes canvas on desktop

### Color Theme
- Dark UI (deep gray/charcoal background) — reduces eye strain, makes colored
  sketch lines pop visually
- Toolbar and panel use semi-transparent dark surfaces
- Sketch lines are bright and saturated so they read clearly against the 3D grid

---

## Sketch Planes

Each plane is a flat 3D surface in the scene with a visible grid.
Planes are color coded — all lines drawn on a plane share its color.

Default plane colors (assign in order as planes are added):
1. Blue (#4FC3F7)
2. Red (#EF5350)
3. Green (#66BB6A)
4. Orange (#FFA726)
5. Purple (#AB47BC)
6. Teal (#26C6DA)

Orientation presets (implemented):
- **Front** — faces the camera on Z axis (XY plane, group rotation: none)
- **Top** — horizontal, XZ plane (group rotationX: -π/2)
- **Right** — faces right, YZ plane (group rotationY: π/2)
- Custom — user sets angle manually (future Phase)

Planes are stored as objects:
```javascript
{
  id: "plane_001",
  name: "Front",
  color: "#4FC3F7",
  visible: true,       // grid + mesh visibility
  linesVisible: true,  // strokes on this plane visibility
  active: false,
  orientation: "front",             // "front" | "top" | "right"
  normal: { x: 0, y: 0, z: 1 },    // derived from orientation preset
  position: { x: 0, y: 0, z: 0 },  // plane center in 3D space
  threeObject: null,   // THREE.Group (mesh + grid)
  meshRef: null        // THREE.Mesh inside the group (raycaster target)
}
```

### Plane Intersection — Infinite Plane Fallback
When the camera is nearly edge-on to a plane (e.g. Top or Right planes viewed from
certain angles), the finite 10×10 mesh may not be hit by raycasting.
`getPlaneIntersection()` in drawing.js first tries to hit the finite mesh; if that
misses, it falls back to `raycaster.ray.intersectPlane(THREE.Plane)` using the world
normal derived via `getWorldQuaternion`. This ensures you can always draw on any plane.

---

## Drawing System

### Tool Modes
- **Select** — tap/click strokes to select them, drag control points to reshape.
  Delete/Backspace key deletes the selected stroke.
- **Line** — tap to place start point, tap to place end point, draws straight line.
  Start point snaps at pointerdown (not pointerup) for mobile reliability.
- **Free** (Freehand) — drag finger continuously, captures path as raw points.
  Freehand loop closure: if end point is within snap radius of start, snaps closed.
- **Erase** — tap any stroke to delete it immediately. Not undoable. Drag to orbit
  (drag is not treated as erase — only taps shorter than TAP_MOVE_THRESHOLD delete).

### Line Rendering — Line2 / LineMaterial
WebGL ignores `LineBasicMaterial.linewidth` on all platforms except macOS.
All strokes are rendered using `Line2` + `LineMaterial` + `LineGeometry` from
`three/addons/lines/` which implement thick lines via a screen-space geometry technique.
Line width is adjustable per-session via the side panel slider (1–12px, default 3px).

### Freehand to Spline Conversion
When a freehand stroke ends:
1. Raw touch points are captured during the drag
2. Ramer-Douglas-Peucker algorithm simplifies them to key points (epsilon ~2-4px)
3. Simplified points become Catmull-Rom spline control points
4. Spline is rendered as a smooth curve through those points
5. Control point handles appear for editing

Use Catmull-Rom (not Bezier) as the default curve type because the curve passes
directly through each control point, which feels natural and intuitive.

### Stroke Data Structure
```javascript
{
  id: "stroke_001",
  planeId: "plane_001",
  type: "freehand",           // or "line"
  color: "#4FC3F7",           // inherited from plane
  points: [                   // Catmull-Rom control points (world space)
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 2, z: 0 },
    { x: 3, y: 1.5, z: 0 },
  ],
  snapConnections: []         // IDs of connected stroke endpoints
}
```

---

## Snap System

Snap radius: **36px** (increased from 24px for fingertip comfort on high-DPI mobile)

### Snap Toggle
A 🧲 button in the toolbar enables/disables snapping globally. State is reflected
visually (blue glow = on, dimmed = off). Default: on.

### Snap on Start
- At **pointerdown** (not pointerup), check proximity to existing endpoints and lines
- Capture the snap candidate in `pendingLineStartSnap`
- When the tap is confirmed at pointerup, use `pendingLineStartSnap` as the start point
- Capturing at pointerdown is critical on mobile: the finger may drift 8–15px between
  press and release, so lift position is unreliable for snap detection

### Snap on End
- At pointerup (stroke end), check proximity to existing endpoints and lines
- If within snap radius, snap end point to target
- Update snapConnections on both strokes

### Freehand Loop Closure
- At freehand pointerup, project `rawPoints3D[0]` (first raw point) to screen space
- If end pointer is within snap radius of that screen projection, snap end to start
- This closes the shape cleanly when the user draws a closed loop

### Visual Feedback
- Highlight nearest snappable point with a glowing ring while drawing
- Snap radius may need tuning — 36px is the current value (set `SNAP_RADIUS_PX` in drawing.js)

### Proximity Detection
- Snap functions in snap.js operate on world-space coordinates (all planes work)
- Project 3D points to screen space for pixel-distance snap radius check
- `Line2` raycasting uses the built-in `raycast()` method (no `raycaster.params.Line` override)

---

## Control Points

After any stroke is drawn, it has editable control points.

In Select mode:
- Tap a stroke to select it — control point handles appear
- Drag a handle to reshape the curve
- Drag a non-handle part of the stroke to move the whole stroke
- Selected stroke highlights in white or bright yellow
- Press Delete or Backspace to delete the selected stroke

Control point handles render as small circles on top of the stroke line.
Handle size: 12px radius (touch-friendly).

When dragging a handle on a stroke that belongs to a non-active plane, the intersection
is computed against that stroke's own plane (via `getPlaneById(stroke.planeId)`), not
the currently active plane.

---

## Undo System

Maintain an action history stack (max 50 actions).
Actions: add stroke, move control point.
Undo button in toolbar steps back one action at a time.
Keyboard shortcut: Ctrl+Z on desktop.

**Note:** Erase tool deletions are **not** undoable by design (simpler UX).
Plane deletion is also not in the undo stack.

---

## Save / Load

### Auto-save
Serialize all planes and strokes to localStorage on every change.
Key: `sketchpad_autosave`

Saved plane data includes the `orientation` field. Old saves without this field are
handled by `normalToOrientation(normal)` which infers it from the stored normal vector.

### Export
"Export JSON" button saves the full sketch as a .json file download (Phase 5).
"Export SVG" button (Phase 5) flattens visible strokes to a 2D SVG.

### Import
"Import JSON" loads a previously exported sketch file (Phase 5).

---

## Build Phases

Work through phases in order. Do not skip ahead.
Each phase should result in something testable on a real device before moving on.

---

### Phase 1 — Foundation ✅ COMPLETE
**Goal:** Working 3D viewport with one plane and basic straight line drawing.

- [x] Set up file structure (all files, empty/stubbed)
- [x] index.html loads Three.js and Hammer.js from CDN
- [x] viewport.js: Three.js scene, perspective camera, WebGL renderer, orbit controls
- [x] planes.js: Create one default Front plane with visible grid
- [x] drawing.js: Point-to-point line tool (tap start, tap end, draw line on plane)
- [x] ui.js: Minimal toolbar with tool toggle (Select / Line)
- [x] Collapsible side panel with one plane listed
- [x] Lines render in plane color
- [x] Camera orbit works with one finger drag
- [x] Pinch to zoom works
- [x] Runs correctly on mobile Chrome (test on S25 Ultra)

---

### Phase 2 — Freehand Drawing and Curves ✅ COMPLETE
**Goal:** Draw freehand strokes that convert to editable splines.

- [x] drawing.js: Freehand stroke capture (record touch points during drag)
- [x] curves.js: Ramer-Douglas-Peucker simplification
- [x] curves.js: Catmull-Rom spline rendering through simplified points
- [x] Control point handles visible after stroke is drawn
- [x] Select tool: tap stroke to select, drag control point to reshape
- [x] Undo for add stroke / move control point
- [x] Auto-save to localStorage

---

### Phase 3 — Snap System ✅ COMPLETE
**Goal:** Lines snap to existing endpoints and lines naturally.

- [x] snap.js: Endpoint proximity detection (36px radius — increased from 24px)
- [x] snap.js: Line proximity detection
- [x] Visual snap indicator (glowing ring) while drawing
- [x] Snap on stroke start (captured at pointerdown for mobile reliability)
- [x] Snap on stroke end
- [x] Freehand loop closure (snaps end to start when drawing a closed shape)
- [x] snapConnections tracked on strokes
- [x] Snap toggle button (🧲) in toolbar
- [x] Tested on mobile — snap radius tuned for finger input

---

### Phase 4 — Multiple Planes ✅ COMPLETE
**Goal:** Add, manage, and draw on multiple planes simultaneously.

- [x] planes.js: Add new plane with orientation presets (Front, Top, Right)
- [x] Infinite plane fallback in getPlaneIntersection() for edge-on camera angles
- [x] Side panel: full plane list with color, name, visibility toggles, active selector
- [x] Inline name editing (tap name → input field)
- [x] Color coding: each plane assigns next color from default list
- [x] Lines visibility toggle hides/shows all strokes on that plane (pencil icon)
- [x] Grid visibility toggle hides/shows plane grid (eye icon)
- [x] Switch active plane from side panel
- [x] Lines stay on their plane in 3D space correctly
- [x] Delete plane (trash icon) — also deletes all strokes on that plane
- [x] Cross-plane handle drag uses correct plane intersection
- [x] Line width slider (1–12px) in side panel — uses Line2/LineMaterial for true thick lines
- [x] Erase tool — tap any stroke to delete it; drag still orbits camera
- [x] Delete/Backspace key deletes selected stroke in Select mode
- [x] Mobile-responsive toolbar — all buttons fit on ~390px screens without overflow
- [x] Save/restore includes orientation field; backward-compatible with old saves

---

### Phase 5 — Polish and PWA
**Goal:** Installable, shareable, complete feeling app.

- [x] PWA setup: manifest.json, service-worker.js, icons
- [ ] Export sketch as JSON (download file)
- [ ] Import sketch from JSON file
- [ ] Export visible strokes as SVG (flattened 2D)
- [ ] Smooth UI animations (panel slide, tool transitions)
- [ ] Dark theme fully polished
- [ ] Test on iPhone/iPad Safari
- [ ] Test on desktop Chrome and Firefox
- [ ] README.md updated with usage instructions

---

## Development Notes

- Always test on a real touch device after any drawing or gesture change
- Snap radius is `SNAP_RADIUS_PX = 36` in drawing.js — tune if needed
- Keep Three.js loaded from CDN (unpkg or cdnjs) — no local copy needed
- Use `Line2` + `LineMaterial` + `LineGeometry` for all stroke rendering (not
  `THREE.Line` + `LineBasicMaterial`) — WebGL ignores linewidth on non-macOS
- service-worker.js should cache CDN scripts for offline use
- Avoid jQuery or any UI framework — vanilla JS only
- main.js initializes all modules and wires event flow between them
- When adding a feature, identify which file owns it before writing any code
- Infinite plane fallback must remain in `getPlaneIntersection()` — without it,
  Top and Right planes are unusable when viewed at shallow camera angles

---

## Current Status

**As of 2026-03-18: Phases 1–4 complete. Phase 5 in progress (PWA done; export/import pending).**

The app is fully functional for multi-plane 3D sketching on mobile and desktop:
- Draw straight lines and freehand curves on Front, Top, and Right planes
- Snap to endpoints and lines with visual indicator; toggle snapping on/off
- Select strokes, drag control points to reshape, delete with key or Erase tool
- Adjust line width per-session (1–12px) via side panel slider
- Add, rename, reorder, and delete planes; toggle grid and stroke visibility per plane
- All state auto-saved to localStorage; survives page reload
- Installable as a PWA (manifest + service worker in place)
