/**
 * `setLayout`'s kind, and the crash it used to be (`layout.ts`).
 *
 * The regression this file pins is not a wrong picture, it is a **dead viewer**: a kind the engine
 * does not have used to reach `Engine.setLayout` with `cells: undefined` and throw inside the render
 * loop on the next frame. So the assertion that matters most here is the last one — an unknown kind
 * resolves to `null`, which the host answers with an `error` rather than acting on.
 */

import { describe, expect, it } from 'vitest';
import { ENGINE_LAYOUT_KINDS, LAYOUT_ALIASES, resolveLayout } from './layout';

describe('resolveLayout', () => {
  it('passes every §4.5 kind through unchanged', () => {
    for (const kind of ENGINE_LAYOUT_KINDS) {
      expect(resolveLayout(kind)).toEqual({ kind });
    }
  });

  it('makes the four names docs/EMBED.md documents real', () => {
    expect(resolveLayout('3d')).toEqual({ kind: '3d-only' });
    expect(resolveLayout('axial')).toEqual({ kind: '1x1', viewId: 'axial' });
    expect(resolveLayout('coronal')).toEqual({ kind: '1x1', viewId: 'coronal' });
    expect(resolveLayout('sagittal')).toEqual({ kind: '1x1', viewId: 'sagittal' });
    // The table and the map are the same four, so one cannot grow without the other.
    expect(Object.keys(LAYOUT_ALIASES).sort()).toEqual(['3d', 'axial', 'coronal', 'sagittal']);
  });

  it('refuses everything else, which is what stops the render loop from throwing', () => {
    for (const kind of ['mosaic', '', '1x2', 'AXIAL', 'view3d', 42, null, undefined, {}]) {
      expect(resolveLayout(kind)).toBeNull();
    }
  });
});
