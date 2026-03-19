# Sketch3D

A lightweight, touch-first 3D concept sketching tool that runs entirely in the browser. Draw on multiple planes in 3D space with your finger to visualize how a shape looks from all angles — no install required.

---

## Install as a PWA

Open the app in Chrome (Android or desktop) and tap **Add to Home Screen** from the browser menu. On iOS Safari, tap the Share icon → **Add to Home Screen**. The app works fully offline after the first load.

---

## Drawing Tools

| Tool | How to use |
|------|-----------|
| **Select** | Tap a stroke to select it (turns yellow). Drag the handle dots to reshape. Press Delete/Backspace to remove. |
| **Line** | Tap to place the start point, tap again to place the end point. |
| **Free** | Press and drag to draw freehand. Strokes are converted to smooth splines automatically. End near the start to close a loop. |
| **Erase** | Tap any stroke to delete it immediately. Drag to orbit — drag does not erase. |

---

## Camera Navigation

- **One finger drag** — orbit
- **Two finger pinch** — zoom

Works in all tool modes.

---

## Snap (🧲)

The magnet button in the toolbar toggles snapping on/off (glows blue when active). When on, line start and end points snap to the nearest existing endpoint or point along a line within 36px. Freehand end snaps back to the start if you close the loop.

---

## Stroke Width

Use the **Stroke** slider at the top of the side panel to set line width (1–12px). Changes apply to all strokes immediately.

---

## Planes

Each sketch plane is a flat 3D surface with a colored grid. All strokes on a plane share its color.

**Adding a plane:** open the side panel → tap **+ Add Plane** → choose **Front**, **Top**, or **Right**.

**Managing planes:**

| Control | Action |
|---------|--------|
| Tap row | Make active drawing surface |
| Tap name | Rename inline |
| ✎ | Toggle stroke visibility |
| 👁 | Toggle grid visibility |
| 🗑 | Delete plane and all its strokes |

Default colors cycle through: Blue, Red, Green, Orange, Purple, Teal.

---

## Export / Import

Buttons at the bottom of the side panel:

- **Export** — downloads the sketch as `sketch.json` (all planes and strokes)
- **Import** — loads a `.json` file, replacing the current sketch
- **SVG** — exports all visible strokes as a flat `sketch.svg` matching the current camera view

---

## Keyboard Shortcuts (desktop)

| Shortcut | Action |
|----------|--------|
| Ctrl+Z | Undo last stroke |
| Delete / Backspace | Delete selected stroke (Select tool) |
| Escape | Cancel current line or freehand stroke |

---

## Tech Stack

- Vanilla HTML5 / CSS3 / JavaScript (ES6 modules) — no build tools, no npm
- [Three.js](https://threejs.org/) r160 — 3D scene, camera, WebGL rendering
- Three.js `Line2` / `LineMaterial` — cross-platform thick line rendering
- [Hammer.js](https://hammerjs.github.io/) — unified touch and gesture handling
- Service worker + Web App Manifest — offline-capable PWA
