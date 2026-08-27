/**
 * The Phase-2 placeholders exist, are typed, and render nothing.
 *
 * A module nobody imports is a module nobody compiles against in practice — the props of the
 * relocate dialog and the histogram are the seams two owners have to agree on, so they are exercised
 * here rather than left to be discovered when the first one is wired up.
 */

import { describe, expect, it } from 'vitest';
import type { DatasetRef, ScreenshotOptions } from '@tetravox/engine';
import { Histogram } from './histogram/Histogram';
import { RegionPanel } from './regions/RegionPanel';
import { RelocateDialog } from '../dialogs/RelocateDialog';
import { ScreenshotDialog } from '../dialogs/ScreenshotDialog';
import { KeyboardHelp } from '../keyboard/KeyboardHelp';

const SCREENSHOT: ScreenshotOptions = {
  target: 'grid',
  background: 'scene',
  include: {
    colorbar: true,
    orientationLabels: true,
    crosshair: true,
    cornerInfo: true,
    scaleBar: false,
  },
  autoTrim: false,
};

const MISSING: DatasetRef[] = [
  { id: 'ds1', kind: 'volume', name: 'T1.nii.gz', path: '../T1.nii.gz', fingerprint: 'abc' },
];

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
    expect(
      RelocateDialog({ missing: MISSING, onResolved: () => {}, onCancel: () => {} })
    ).toBeNull();
    expect(
      ScreenshotDialog({
        views: ['axial', 'view3d'],
        initial: SCREENSHOT,
        onConfirm: () => {},
        onCancel: () => {},
      })
    ).toBeNull();
    expect(KeyboardHelp({ open: false, onClose: () => {} })).toBeNull();
  });
});
