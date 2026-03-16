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
│   ├── drawing.js          ← Line drawing modes (point-to-point, freehand)
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
- App name / logo left side
- Active tool indicator (Select, Line, Freehand)
- Tool toggle buttons
- Undo button
- Menu/hamburger button to open side panel on mobile

### Side Panel (collapsible, slides in from left)
- Collapsed by default on mobile — a visible tab or arrow stays on screen
- Expands to show plane management list
- Each plane row shows:
  - Color swatch dot
  - Plane name (editable on tap)
  - Visibility toggle (eye icon)
  - Active indicator (highlighted when selected)
  - Tap row to make that plane active drawing surface
- Bottom of panel:
  - "+ Add Plane" button
  - Orientation picker on add: Front, Top, Right, Custom
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

Default orientation presets:
- Front — faces the camera on Z axis (XY plane)
- Top — horizontal, XZ plane
- Right — faces right, YZ plane
- Custom — user sets angle manually (Phase 4)

Planes are stored as objects:
```javascript
{
  id: "plane_001",
  name: "Front",
  color: "#4FC3F7",
  visible: true,
  active: false,
  normal: { x: 0, y: 0, z: 1 },   // plane orientation
  position: { x: 0, y: 0, z: 0 }, // plane center in 3D space
  threeObject: null                 // reference to Three.js mesh
}
```

---

## Drawing System

### Tool Modes
- **Select** — tap/click strokes to select them, drag control points to reshape
- **Line** — tap to place start point, tap to place end point, draws straight line
- **Freehand** — drag finger continuously, captures path as raw points

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
  points: [                   // Catmull-Rom control points
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 2, z: 0 },
    { x: 3, y: 1.5, z: 0 },
  ],
  snapConnections: []         // IDs of connected stroke endpoints
}
```

---

## Snap System

Snap radius: 24px (touch-friendly, accounts for finger imprecision)

### Snap on Start
- As user begins a stroke (touches down), check proximity to existing endpoints
- If within snap radius, lock start point to that endpoint
- Show visual indicator (bright dot or ring) on the snap target

### Snap on End
- As user lifts finger to end a stroke, check proximity to existing endpoints and lines
- If within snap radius, snap end point to target
- Update snapConnections on both strokes

### Visual Feedback
- Highlight nearest snappable point with a glowing ring while drawing
- Snap lock confirmed with a subtle color flash

### Proximity Detection
- Use Three.js raycasting for 3D point proximity
- Project 3D points to screen space for pixel-distance snap radius check

---

## Control Points

After any stroke is drawn, it has editable control points.

In Select mode:
- Tap a stroke to select it — control point handles appear
- Drag a handle to reshape the curve
- Drag a non-handle part of the stroke to move the whole stroke
- Selected stroke highlights in white or bright yellow

Control point handles render as small circles on top of the stroke line.
Handle size: 12px radius (touch-friendly).

---

## Undo System

Maintain an action history stack (max 50 actions).
Actions: add stroke, delete stroke, move control point, add plane, delete plane.
Undo button in toolbar steps back one action at a time.
Keyboard shortcut: Ctrl+Z on desktop.

---

## Save / Load

### Auto-save
Serialize all planes and strokes to localStorage on every change.
Key: `sketchpad_autosave`

### Export
"Export JSON" button saves the full sketch as a .json file download.
"Export SVG" button (Phase 5) flattens visible strokes to a 2D SVG.

### Import
"Import JSON" loads a previously exported sketch file.

---

## Build Phases

Work through phases in order. Do not skip ahead.
Each phase should result in something testable on a real device before moving on.

---

### Phase 1 — Foundation (Start Here)
**Goal:** Working 3D viewport with one plane and basic straight line drawing.

- [ ] Set up file structure (all files, empty/stubbed)
- [ ] index.html loads Three.js and Hammer.js from CDN
- [ ] viewport.js: Three.js scene, perspective camera, WebGL renderer, orbit controls
- [ ] planes.js: Create one default Front plane with visible grid
- [ ] drawing.js: Point-to-point line tool (tap start, tap end, draw line on plane)
- [ ] ui.js: Minimal toolbar with tool toggle (Select / Line)
- [ ] Collapsible side panel with one plane listed
- [ ] Lines render in plane color
- [ ] Camera orbit works with one finger drag
- [ ] Pinch to zoom works
- [ ] Runs correctly on mobile Chrome (test on S25 Ultra)

---

### Phase 2 — Freehand Drawing and Curves
**Goal:** Draw freehand strokes that convert to editable splines.

- [ ] drawing.js: Freehand stroke capture (record touch points during drag)
- [ ] curves.js: Ramer-Douglas-Peucker simplification
- [ ] curves.js: Catmull-Rom spline rendering through simplified points
- [ ] Control point handles visible after stroke is drawn
- [ ] Select tool: tap stroke to select, drag control point to reshape
- [ ] Undo for add/delete stroke
- [ ] Auto-save to localStorage

---

### Phase 3 — Snap System
**Goal:** Lines snap to existing endpoints and lines naturally.

- [ ] snap.js: Endpoint proximity detection (24px radius)
- [ ] snap.js: Line proximity detection
- [ ] Visual snap indicator (glowing ring) while drawing
- [ ] Snap on stroke start
- [ ] Snap on stroke end
- [ ] snapConnections tracked on strokes
- [ ] Test on mobile — snap radius feels right for finger input

---

### Phase 4 — Multiple Planes
**Goal:** Add, manage, and draw on multiple planes simultaneously.

- [ ] planes.js: Add new plane with orientation presets (Front, Top, Right)
- [ ] Side panel: full plane list with color, name, visibility toggle, active selector
- [ ] Color coding: each plane assigns next color from default list
- [ ] Visibility toggle hides/shows all strokes on that plane
- [ ] Switch active plane from side panel
- [ ] Lines stay on their plane in 3D space correctly
- [ ] Plane grids toggleable individually

---

### Phase 5 — Polish and PWA
**Goal:** Installable, shareable, complete feeling app.

- [ ] PWA setup: manifest.json, service-worker.js, icons
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
- Snap radius may need tuning based on real finger feel — start at 24px
- Keep Three.js loaded from CDN (unpkg or cdnjs) — no local copy needed
- service-worker.js should cache CDN scripts for offline use
- Avoid jQuery or any UI framework — vanilla JS only
- main.js initializes all modules and wires event flow between them
- When adding a feature, identify which file owns it before writing any code

---

## Current Status

Project not yet started. Phase 1 is the starting point.
Repository is empty. Begin by setting up the full file structure,
then implement Phase 1 top to bottom before touching Phase 2.
