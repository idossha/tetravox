/**
 * The Phase-2 placeholders exist, are typed, and render nothing.
 *
 * A module nobody imports is a module nobody compiles against in practice — the props of the
 * relocate dialog are a seam two owners have to agree on, so they are exercised here rather than
 * left to be discovered when the first one is wired up.
 *
 * The histogram and the region panel have **left** this list: A-PROPS implemented both, they read
 * React context and hold state, and a function component with hooks cannot be called outside a
 * renderer. What replaced these two assertions is `histogram/*.test.ts`, `regions/regions.test.ts`
 * and the Playwright-Electron specs that drive the real DOM.
 */

import { describe, expect, it } from 'vitest';
import type { DatasetRef, ScreenshotOptions } from '@tetravox/engine';
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
