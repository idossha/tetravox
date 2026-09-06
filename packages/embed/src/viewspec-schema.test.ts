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
