/**
 * `viewspec.schema.json` is the contract for a host that is not TypeScript, and these assertions are
 * what stop it from drifting away from {@link EmbedPointsLayer} / {@link EmbedPoint}.
 *
 * The schema is hand-maintained (there is no generator), so a field added to the TypeScript and not
 * to the JSON is invisible: the layer *works* — unknown keys ride through to the engine untouched —
 * and a host validating against the schema is told its scene is fine while its editor has no idea
 * the field exists. `protocol.test.ts` does the same job for the message types; this file does it
 * for the one layer kind a host writes by hand.
 *
 * The points-layer fields are pinned by name **and** by shape, because each of the five is one an
 * application drives an electrode picker with, and each has a wrong spelling that fails silently:
 *
 *  * `shape` — the enum, not a free string. `'dots'` would pass a `type: 'string'` and draw spheres.
 *  * `dotRadiusPx` — CSS pixels, and the `dot` branch's only size. A host that sends `radiusMm`
 *    instead gets the layer default and no complaint.
 *  * `stateColors` — the palette a later `setPoints` reads back off the live layer, so it is a layer
 *    field and never a per-point one.
 *  * per-point `state` / `color` — the two that decide what a marker looks like, with `color`
 *    winning; `radiusMm` — the per-point override of the layer's.
 *
 * Nothing here validates a document against the schema: that needs a JSON Schema library and the
 * lockfile is frozen (AGENTS.md rule 4). What is provable without one is that the schema *says*
 * these things, which is the drift being prevented.
 */

import { describe, expect, it } from 'vitest';
import schema from '../viewspec.schema.json' with { type: 'json' };

const POINTS = schema.definitions.PointsLayer;
const POINT = schema.definitions.Point;

/** `[r, g, b, a]`, 0..1 — the shape every colour in this schema has. */
const RGBA = { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 };

describe('viewspec.schema.json — the points layer', () => {
  it('is one of the layer kinds a host may write', () => {
    const refs = schema.properties.layers.items.oneOf.map((s: { $ref: string }) => s.$ref);
    expect(refs).toContain('#/definitions/PointsLayer');
    expect(POINTS.properties.kind).toEqual({ const: 'points' });
  });

  it('pins `shape` as the two-value enum, not a free string', () => {
    // A free string would accept 'dots' and silently draw spheres — the marker is the whole signal
    // in an electrode picker, so the failure would be a picker that looks wrong and validates.
    expect(POINTS.properties.shape.enum).toEqual(['sphere', 'dot']);
  });

  it('pins `dotRadiusPx` as a number, and says which pixels', () => {
    expect(POINTS.properties.dotRadiusPx.type).toBe('number');
    // CSS pixels, not world millimetres and not device pixels: `derived.ts` sends
    // `uDotPx = dotRadiusPx · uiScale`, so a host reading "pixels" as device pixels is half wrong
    // on every Retina display.
    expect(POINTS.properties.dotRadiusPx.description).toMatch(/screen radius in CSS pixels/i);
  });

  it('pins `stateColors` as a layer field with the three states, and nothing else', () => {
    const stateColors = POINTS.properties.stateColors;
    expect(Object.keys(stateColors.properties).sort()).toEqual(['disabled', 'idle', 'selected']);
    for (const state of ['idle', 'selected', 'disabled'] as const) {
      expect(stateColors.properties[state]).toEqual(RGBA);
    }
    // Closed, so a typo'd state is rejected rather than resolved to the layer colour in silence.
    expect(stateColors.additionalProperties).toBe(false);
    // It lives on the LAYER: `setPoints` reads the palette back off the live layer, which is the
    // only place it survives a whole-array replacement.
    expect(POINT.properties).not.toHaveProperty('stateColors');
  });

  it('pins the three per-point fields that decide what a marker looks like', () => {
    expect(POINT.properties.state.enum).toEqual(['idle', 'selected', 'disabled']);
    expect(POINT.properties.color).toEqual(RGBA);
    expect(POINT.properties.radiusMm.type).toBe('number');
    // `color` beats `state` — the rule `points.test.ts` asserts on the object and
    // `embed-points.spec.ts` asserts on the framebuffer. Said here too, because a host reading only
    // the schema has neither.
    expect(POINT.properties.state.description).toMatch(
      /explicit `?color`? on the same point wins/i
    );
  });

  it('requires only what a host cannot be without', () => {
    expect(POINTS.required.sort()).toEqual(['datasetId', 'id', 'kind', 'points']);
    // A point is a position. `id` is optional because the engine mints `p<index>` — and the schema
    // must not require what the engine supplies, or a valid scene would fail validation.
    expect(POINT.required).toEqual(['position']);
  });

  it('leaves unlisted fields alone, which is what makes the schema safe to be behind', () => {
    // No `additionalProperties: false` on either: §4.4 is the complete layer model and this file is
    // the host-facing subset of it, so a field the engine has and this schema does not must still
    // validate. That is also why the assertions above are by name — the schema cannot fail loudly.
    expect(POINTS).not.toHaveProperty('additionalProperties');
    expect(POINT).not.toHaveProperty('additionalProperties');
  });
});

/**
 * The surface layer (embed protocol 3, Tetravox 0.4.0), pinned for the same reason the points layer
 * is: the schema is hand-maintained, so a field that exists in the TypeScript and not here is
 * invisible to a host that validates against it — the layer *works*, and the host's editor never
 * learns the field is there.
 *
 * What is pinned is the **distinction**. The maintainer's ask was one sentence — "distinguish
 * between NIfTI, mesh, and a surface, where a mesh is a tetrahedral FEM and a surface is just a
 * triangular two-dimensional surface" — and the way that ask fails is not a missing property but a
 * quietly re-merged model: a `field` key creeping onto the surface, a `caps` on its clip, a `tag`
 * in its `colorMode`. Every assertion below is one of those.
 */
const SURFACE = schema.definitions.SurfaceLayer;
const MESH = schema.definitions.MeshLayer;

describe('viewspec.schema.json — the surface layer', () => {
  it('is one of the layer kinds a host may write', () => {
    const refs = schema.properties.layers.items.oneOf.map((s: { $ref: string }) => s.$ref);
    expect(refs).toContain('#/definitions/SurfaceLayer');
    expect(SURFACE.properties.kind).toEqual({ const: 'surface' });
  });

  it('offers the three colour sources a surface has, and not the mesh names', () => {
    // A MeshLayer says 'field' and 'tag'; a surface says 'overlay' and 'annotation'. The two
    // vocabularies mean different things — 'tag' is a tissue label a sheet does not have — and a
    // schema that accepted both would be describing the merged model this kind exists to split.
    expect(SURFACE.properties.colorMode.enum).toEqual(['solid', 'overlay', 'annotation']);
    expect(MESH.properties.colorMode.enum).toEqual(['solid', 'tag', 'field']);
  });

  it('has NO tetrahedral vocabulary: no tags, no caps, no 2-D fill, no `field`', () => {
    // The four things a sheet cannot have. Each is present on MeshLayer, which is what makes their
    // absence here a statement rather than an omission.
    for (const tetOnly of ['tagStyle', 'fillIn2D', 'field']) {
      expect(MESH.properties).toHaveProperty(tetOnly);
      expect(SURFACE.properties).not.toHaveProperty(tetOnly);
    }
    // Clip planes yes, caps no: a plane through a sheet leaves an outline, not a face to fill.
    expect(Object.keys(SURFACE.properties.clip.properties)).toEqual(['planes']);
    expect(Object.keys(MESH.properties.clip.properties).sort()).toEqual([
      'capColorMode',
      'caps',
      'planes',
    ]);
  });

  it("names an overlay without a `source`, because a surface's data is per-vertex by construction", () => {
    // The mesh has to say `source: 'node' | 'elm'` out loud — a .msh simulation field is usually per
    // ELEMENT. A surface has no elements to carry a field, so a `source` here would have one legal
    // value and would be a question with one answer.
    expect(SURFACE.properties.overlay.required).toEqual(['name']);
    expect(SURFACE.properties.overlay.properties).not.toHaveProperty('source');
    expect(MESH.properties.field.required).toEqual(['source', 'name']);
  });

  it('names an annotation and never carries its table', () => {
    // §4.4's LabelTable is the one non-JSON field. It is re-derived from the dataset by `name` at
    // load; a host has never seen the colours inside the `.annot` it is naming, so a schema that
    // invited one would be inviting a host to invent an atlas.
    expect(SURFACE.properties.annotation.required).toEqual(['name']);
    expect(SURFACE.properties.annotation.properties).not.toHaveProperty('table');
    expect(SURFACE.properties.annotation.properties.mode.enum).toEqual(['fill', 'outline', 'both']);
  });

  it('warns that a missing annotation name is silent, not an error', () => {
    // The one failure a host will actually hit — an atlas URL that 404s, or a name that does not
    // match the field the reader produced — and it does not fail the load: the layer opens solid.
    expect(SURFACE.properties.annotation.description).toMatch(
      /does NOT fail the load|falls back to colorMode 'solid'/i
    );
  });

  it('says `contoursIn2D` defaults to TRUE here, unlike a mesh', () => {
    // The only default that differs, and the one whose absence makes a surface invisible in the
    // slice panes — the state a host would report as "it did not load".
    expect(SURFACE.properties.contoursIn2D.description).toMatch(/ABSENT IS TRUE/);
  });

  it('warns that omitting the colours takes a palette entry by load order', () => {
    expect(SURFACE.properties.solidColor.description).toMatch(/BY LOAD ORDER/);
  });

  it('has the per-layer opacity, colormap and window a volume has', () => {
    expect(SURFACE.properties.opacity).toEqual({ type: 'number', minimum: 0, maximum: 1 });
    expect(SURFACE.properties.colormap.enum).toEqual(MESH.properties.colormap.enum);
    expect(SURFACE.properties.scale).toEqual(MESH.properties.scale);
    expect(SURFACE.properties.threshold).toEqual(MESH.properties.threshold);
  });

  it('requires only what a host cannot be without', () => {
    expect(SURFACE.required.sort()).toEqual(['datasetId', 'id', 'kind']);
  });

  it('leaves unlisted fields alone, like every other layer here', () => {
    expect(SURFACE).not.toHaveProperty('additionalProperties');
  });
});

describe('viewspec.schema.json — the dataset a surface comes from', () => {
  const DATASET = schema.definitions.DatasetRef;

  it("accepts 'surface' as a third spelling, and says it is a spelling of 'mesh'", () => {
    // There is no third DATASET kind in the engine: surface-ness is `nTets === 0`, read from the
    // bytes. The word is here so a host does not have to write `kind: 'mesh'` on the dataset of a
    // `kind: 'surface'` layer — which is the volume/mesh/surface confusion protocol 3 exists to end.
    expect(DATASET.properties.kind.enum).toEqual(['volume', 'mesh', 'surface']);
    expect(DATASET.properties.kind.description).toMatch(/HOST-FACING SPELLING OF `mesh`/);
    expect(DATASET.properties.kind.description).toMatch(/keeps working and loads identically/);
  });

  it('admits the third sidecar role, `fields`, as an ordered array', () => {
    // `additionalProperties: false` on `sidecars` REJECTED this until protocol 3 — the schema would
    // have told a host its annotated surface was invalid while the embed loaded it fine.
    expect(DATASET.properties.sidecars.additionalProperties).toBe(false);
    const fields = DATASET.properties.sidecars.properties.fields;
    expect(fields.type).toBe('array');
    expect(fields.items.required).toEqual(['path']);
    expect(fields.description).toMatch(/ORDER MATTERS/);
  });

  it('says a field is named after its own file, which is what a layer must name', () => {
    // `lh.ernie_DK40.annot`, never `annot`: two atlases on one hemisphere have to coexist, and the
    // layer's `annotation.name` is how it says which.
    expect(DATASET.properties.sidecars.properties.fields.description).toMatch(
      /named after ITS OWN FILE/
    );
  });

  it('refuses to pretend the format comes from the extension', () => {
    // There is deliberately NO `format: 'freesurfer' | 'gifti'`: `tvx_mesh_io::sniff` reads the
    // magic bytes and only falls back to the extension, so such a field would be accepted,
    // documented and inert — the exact shape of the `stateColors.idle` bug this repo already
    // shipped once. It is also why the extensionless `lh.central` works at all.
    expect(DATASET.properties).not.toHaveProperty('format');
    expect(DATASET.properties.path.description).toMatch(
      /READ FROM THE BYTES, NOT FROM THIS STRING/
    );
    expect(DATASET.properties.path.description).toMatch(/extensionless FreeSurfer surfaces work/);
  });
});
