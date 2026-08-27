/**
 * The Phase-2 placeholders that are **still** placeholders exist, are typed, and render nothing.
 *
 * A module nobody imports is a module nobody compiles against in practice, so the seams two owners
 * have to agree on are exercised here rather than discovered when the first one is wired up.
 *
 * **Three of the original five are gone from this file, because they were built.** `RelocateDialog`,
 * `ScreenshotDialog` and `KeyboardHelp` are A-SHELL's and shipped on `p2/shell`; they are covered by
 * `dialogs/dialogs.test.tsx`, `keyboard/bindings.test.ts` and `packages/app/e2e/shell-phase2.spec.ts`,
 * and asserting `=== null` on them here would now assert the opposite of what they do. What remains
 * is A-PROPS's — the region panel and the histogram.
 */

import { describe, expect, it } from 'vitest';
import { Histogram } from './histogram/Histogram';
import { RegionPanel } from './regions/RegionPanel';

describe('Phase-2 placeholders', () => {
  it('render nothing and cost nothing to mount', () => {
    expect(RegionPanel({ layerId: 'layer1' })).toBeNull();
    expect(
      Histogram({
        stats: { min: 0, max: 1, mean: 0.5, std: 0.1, percentiles: {} } as never,
        window: { lo: 0, hi: 1 },
        threshold: null,
        onWindow: () => {},
        onThreshold: () => {},
      })
    ).toBeNull();
  });
});
