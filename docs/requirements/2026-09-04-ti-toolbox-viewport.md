# TI-Toolbox viewport requirements — 2026-09-04

This is a gate item for the embedded viewport used by TI-Toolbox 3.0.0. It is proven by the
headless `packages/embed/test/e2e/embed-viewport.spec.ts` suite, using the committed
`testdata/mesh_v2_binary.msh` fixture with DOM, camera, protocol and analytic pixel assertions.
It refines §5 rule 15 and §8 of `docs/ARCHITECTURE.md`; where it conflicts, this requirement wins
and the contract is amended in the same commit.

## Ask, verbatim

> For example, what I mean is that we do not need to have all the buttons for the UI because we only require the 3D visualization panel.

## R1 — Let the host show a visualization panel with its own controls

* A host can opt into `embed=1&presentation=viewport` to give the whole iframe to the existing
  view grid. Toolbar, layers and probe panels, collapse rails, status bar, toasts and dialogs are
  absent. The host's usual status/error messages still report failures.
* The canvas keeps its orientation annotations and pointer gestures. Host layer and camera
  commands continue working. Shell shortcuts and file drops cannot activate invisible tools or
  replace the host's selected datasets. The full embedded viewer remains the default.
* Gate test: `embed-viewport.spec.ts` asserts exact absence of the omitted controls, exact canvas
  bounds equal to the iframe bounds, working camera orbit and layer-opacity updates, and explicit
  no-WebGL2 reporting. A white opaque synthetic mesh with ambient lighting of one has an interior
  RGBA pixel exactly `[255, 255, 255, 255]`; a sample outside its silhouette is exactly the authored
  black background. The same analytic assertions and full controls pass with absent or unknown
  presentation. Its viewport golden retains the orientation annotations under the §11 tolerance.
