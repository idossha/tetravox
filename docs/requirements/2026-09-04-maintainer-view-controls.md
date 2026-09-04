# View controls and screenshot dialog — 2026-09-04

These requirements gate the view-controls update. Electron tests assert the real scene cursor and
DOM layout; reducer tests assert legacy migration. They refine §7.5 and §8 of ARCHITECTURE.md.
This user request takes precedence over the older always-visible-3D catalogue rule.

## R1 — Remove 3D+1 from the UI

> remove the "3D+1" button and view option.

Remove it from toolbar and keyboard cycling. Old 3D+1 scenes migrate to 1+3, preserving slice
settings. Retain engine compatibility for scripts.

* Gate test: no 3D+1 button, exact three-entry combined-layout cycle, migration to 1+3.

## R2 — Fit screenshot options without scrolling

> make sure the screenshot menu has a properly organized UI that does not require scrolling.

Group capture options in compact columns beside the preview and figure settings.

* Gate test: at 960×600 (existing app minimum) and 1400×900, every target with a preview has no
scroll extent beyond its client size, allowing one CSS pixel for rounding; footer is fully visible.

## R3 — Select anatomical views directly

> like freeview, have select buttons for the specific views

Sagittal, Coronal and Axial buttons display one retained slice each. Combined layouts remain available.
The supplied Freeview reference shows these three view selectors.

* Gate test: each button produces exactly its named pane, marks itself selected, and leaves the
cursor and slice settings exactly unchanged.

## R4 — Verify Reset reaches the world origin

> make sure the reset button actually resets to the 0,0,0 position of the crosshair curser.

Reset / Home sets the shared cursor to world origin and refits the views without unloading layers.

* Gate test: real-engine scene cursor and UI cursor equal [0,0,0] exactly, the world field reads
0.0 0.0 0.0, and loaded layers remain unchanged after either action.
