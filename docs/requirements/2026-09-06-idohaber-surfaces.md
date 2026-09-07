# Surfaces as their own layer kind — 2026-09-06 (surface-layer gate items R1–R5)

These are **hard gate items for the surface-layer milestone**, each proven by an engine end-to-end
test with analytic pixel assertions on the committed fixtures, a vitest on the scene model, or an
Electron test on the reference dataset gated on `TETRAVOX_TESTDATA`. They refine §4.4, §4.6, §4.7,
§7.4 and §8 of `docs/ARCHITECTURE.md`; where they conflict with the contract, they win and the
contract is amended in the same commit. **No backward compatibility is owed**: the product is in
internal development and a scene saved before this date may open differently.

## Asks, verbatim

1. "TetraVox needs to distinguish between a mesh and a surface. Currently it looks like when we load
   a .gii file it treats it as a mesh and it's not, it's a surface only."
2. "we have to treat surfaces as first class citizens and their simple structures than a mesh and
   their entire way we treat them and the menu that comes with them needs to be simpler or at least
   unique compared to the meshes"
3. "It does not have to be backward compatible because this is still not in production and only in
   internal development"
4. "it needs to have a logical modular separation that would make sense for neuroscientists and 3D
   developers."

## R1 — A triangle-only file opens as a **surface** layer, not a mesh layer

* WHEN a dataset with triangles and no tetrahedra opens (GIfTI, FreeSurfer, STL/PLY/OBJ/OFF, `.vtp`,
  a `.geo` with triangles) THE SYSTEM SHALL create a layer of `kind: 'surface'`; a dataset with
  tetrahedra still creates `kind: 'mesh'`. The layer row reads `surface`; the summary reads
  `<hemisphere> · <n> vertices · <m> triangles` with the hemisphere read from an `lh.`/`rh.` prefix
  and omitted otherwise.
* `SurfaceLayer` is its own scene type: colour source `solid | overlay | annotation`, one `overlay`
  (a node field) and one `annotation` (a label table), opacity, shading, clip planes, and the 2D
  outline. It has **no** `tagStyle`, `isolate`, `glyphs`, `fillIn2D`, caps or cap colour mode.
* Gate test (`packages/engine/src/scene/*.test.ts`, `packages/app/e2e/annot-realdata.spec.ts`):
  `defaultLayerFor` on `surf_ascii.surf.gii`'s meta yields `kind === 'surface'` exactly, and on
  `mesh_v2_binary.msh`'s meta yields `kind === 'mesh'` exactly; opening `m2m_ernie/surfaces/lh.pial.gii`
  in the app gives one layer whose kind is `surface` and whose summary begins `lh ·`.

## R2 — A surface opens in a single colour with its 2D outline, and renders as before

* A new surface opens `colorMode: 'solid'` with `solidColor` = its palette entry in load order (the
  contour palette, first entry Freeview yellow, §7.4), `contoursIn2D: true`, `contourWidthPx: 1.5`,
  `faceMode` from `orient.openComponents` as today. Nothing about a tet mesh's defaults moves.
* Gate test (`packages/engine/test/e2e/surface.spec.ts`): on `lh.fixture.surf`, every interior pixel
  the pick pass attributes to a triangle satisfies `solveShading(solidColor·255, px)` and fails it
  for the other two palette entries; golden `surface-default` under the §11 policy
  (`GOLDEN_MAX_DIFF_PIXEL_RATIO`). The existing mesh goldens are byte-identical before and after.

## R3 — An attached overlay or annotation is the surface's colour source

* WHEN a `.annot`/`.label.gii` attaches (`attachSurfaceData`) THE SYSTEM SHALL set
  `colorMode: 'annotation'` and `annotation: { name, table, mode: 'fill', outlineWidthPx: 1 }` on every
  surface layer of that dataset; a scalar sets `colorMode: 'overlay'` and `overlay: { name,
  component: 'mag' }` with the scale re-seeded from that field's stats. The user can switch back to
  `solid` and forth from the panel without losing either.
* Gate test (`mesh-annot.spec.ts`, `annot-realdata.spec.ts`): after attaching `surf_regions.label.gii`
  to `lh.fixture.surf` and selecting `annotation`, the monochrome-triangle pixels satisfy
  `solveShading` for their label colour and no other (exact feasibility); on real data
  `lh.ernie_DK40.annot` gives `colorMode === 'annotation'` and a table of `nEntries` from
  `scripts/refvalues/annot_refvalues.json`, exactly.

## R4 — The surface editor is its own panel

* The surface layer's property editor shows exactly these sections: **Colour** (solid / overlay /
  annotation with the picker for the chosen one and Attach file…), **Regions** (only when an
  annotation is attached), **Appearance** (opacity, flat shading, back faces, edges), **2D outline**
  (on/off, width, colour) and **Clip planes** (planes only). It shows no tissue table, no Isolation,
  no Glyphs, no cross-section fill and no cap controls.
* Gate test (`packages/app/src/renderer/src/panels/layers/properties.test.tsx`): rendering
  `SurfaceProperties` for a surface layer yields the five section test ids and none of
  `mesh-isolation-*`, `mesh-glyphs-*`, `mesh-crosssection-*`, `mesh-clip-caps-*`; rendering
  `MeshProperties` for a tet mesh is unchanged (its existing test ids all present).

## R5 — Surface state is a separate module on both sides of the worker boundary

* The engine keeps `scene/surface.ts` (the `SurfaceLayer` type's defaults and its projection onto
  the shared triangle renderer) and `layers/surface.ts` (the runtime); the app keeps
  `panels/layers/surface/`. Mesh code paths import nothing from them; the renderer's triangle passes
  stay shared, since a surface is drawn by the same shaders as a tet mesh's boundary (§7.4).
* Gate test (`packages/engine/src/layers/registry.test.ts`, an import-wall test reading the source
  off disk): `layers/mesh.ts` and `panels/layers/mesh/*` contain no import of a `surface` module;
  `LAYER_KINDS` equals `['volume', 'mesh', 'iso', 'points', 'surface']` exactly.
