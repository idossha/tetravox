import { describe, expect, it } from 'vitest';
import type { LayoutKind, SliceView, View3D } from '@tetravox/engine';
import { LAYOUT_CYCLE, cellIndexAt, layoutCells, layoutGrid, nextLayout } from './layout';
import { baseName, deriveSidecarCandidates, stripKnownExtension } from './sidecars';
import {
  EMPTY_METRICS,
  FRAME_WINDOW,
  formatBytes,
  formatDuration,
  fps,
  medianFrameMs,
  medianGpuMs,
  pushFrame,
} from './metrics';
import {
  applyProgress,
  cardElapsedMs,
  cardPercent,
  dismissCard,
  failCard,
  finishCard,
  isActive,
  newCard,
  pruneCards,
  requestCancel,
  startCard,
} from './loads';
import { PRESET_KEYS, resolveKey } from '../keyboard/keymap';
import { isToastWorthy, pruneToasts, pushToast, titleForCode } from './toasts';
import { encodePng } from './png';

// ------------------------------------------------------------------------------------------------
// Layout (§4.5, §7.5 `x`)
// ------------------------------------------------------------------------------------------------

const slice = (id: string, mode: SliceView['mode']): SliceView => ({
  id,
  mode,
  normal: [0, 0, 1],
  up: [0, 1, 0],
  camera: { center: [0, 0], mmPerPx: 1 },
});
const SLICES: SliceView[] = [
  slice('axial', 'axial'),
  slice('sag', 'sagittal'),
  slice('cor', 'coronal'),
];
const VIEW3D: View3D = {
  id: 'view3d',
  camera: {
    target: [0, 0, 0],
    distance: 1,
    rotation: [0, 0, 0, 1],
    fovYDeg: 35,
    orthographic: false,
    near: 1,
    far: 2,
  },
  showSlicePlanes: true,
};

describe('layoutCells', () => {
  // The engine's own boot order (`scene/defaults.ts`: `[axial, coronal, sagittal, view3d]`), so
  // rebuilding a layout cannot renumber the panes the engine already drew.
  it('orders the slices axial → coronal → sagittal regardless of scene order', () => {
    expect(layoutCells('1x3', SLICES, VIEW3D)).toEqual(['axial', 'cor', 'sag']);
    expect(layoutCells('2x2', SLICES, VIEW3D)).toEqual(['axial', 'cor', 'sag', 'view3d']);
    expect(layoutCells('3d-only', SLICES, VIEW3D)).toEqual(['view3d']);
  });

  it('zooms the pane the user was in when going to 1x1', () => {
    expect(layoutCells('1x1', SLICES, VIEW3D, 'cor')).toEqual(['cor']);
    expect(layoutCells('1x1', SLICES, VIEW3D, 'view3d')).toEqual(['view3d']);
    // An id that is not a view falls back rather than producing an empty grid.
    expect(layoutCells('1x1', SLICES, VIEW3D, 'nope')).toEqual(['axial']);
  });

  it('cycles through the four the toolbar offers and returns to the start', () => {
    let kind: LayoutKind = LAYOUT_CYCLE[0] as LayoutKind;
    const seen: LayoutKind[] = [kind];
    for (let i = 0; i < LAYOUT_CYCLE.length - 1; i++) {
      kind = nextLayout(kind);
      seen.push(kind);
    }
    expect(seen).toEqual([...LAYOUT_CYCLE]);
    expect(nextLayout(kind)).toBe(LAYOUT_CYCLE[0]);
  });

  it('describes a grid that matches the cell count', () => {
    expect(layoutGrid('2x2', 4)).toEqual({ columns: 'repeat(2, 1fr)', rows: 'repeat(2, 1fr)' });
    expect(layoutGrid('1x3', 3)).toEqual({ columns: '1fr', rows: 'repeat(3, 1fr)' });
    expect(layoutGrid('3d-only', 1)).toEqual({ columns: '1fr', rows: '1fr' });
  });
});

describe('cellIndexAt', () => {
  const rect = { width: 400, height: 300 };
  it('reads a 2x2 grid row-major', () => {
    expect(cellIndexAt('2x2', 4, rect, 10, 10)).toBe(0);
    expect(cellIndexAt('2x2', 4, rect, 390, 10)).toBe(1);
    expect(cellIndexAt('2x2', 4, rect, 10, 290)).toBe(2);
    expect(cellIndexAt('2x2', 4, rect, 390, 290)).toBe(3);
  });
  it('stacks 1x3 vertically and clamps at the edges', () => {
    expect(cellIndexAt('1x3', 3, rect, 200, 0)).toBe(0);
    expect(cellIndexAt('1x3', 3, rect, 200, 150)).toBe(1);
    expect(cellIndexAt('1x3', 3, rect, 200, 299)).toBe(2);
    expect(cellIndexAt('1x3', 3, rect, 200, 100_000)).toBe(2);
  });
  it('is 0 for the single-pane layouts and for a zero-sized host', () => {
    expect(cellIndexAt('1x1', 1, rect, 399, 299)).toBe(0);
    expect(cellIndexAt('2x2', 4, { width: 0, height: 0 }, 1, 1)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------
// Sidecars (§7.6, §5 rule 9)
// ------------------------------------------------------------------------------------------------

describe('deriveSidecarCandidates', () => {
  it('strips the compound NIfTI extension, not just the last dot', () => {
    expect(stripKnownExtension('/data/m2m_ernie/T1.nii.gz')).toBe('/data/m2m_ernie/T1');
    expect(stripKnownExtension('/data/final_tissues.nii')).toBe('/data/final_tissues');
    expect(stripKnownExtension('/data/lh.central.gii')).toBe('/data/lh.central');
    // No known extension and no dot after the last slash: leave it alone (FreeSurfer `lh.pial` keeps
    // its dot because `.pial` is not in the list — stripping it would look for `lh_LUT.txt`).
    expect(stripKnownExtension('/data/lh.pial')).toBe('/data/lh');
  });

  it('offers `<stem>_LUT.txt` before `<stem>.txt` (§7.6)', () => {
    expect(deriveSidecarCandidates('/d/final_tissues.nii.gz').lut).toEqual([
      '/d/final_tissues_LUT.txt',
      '/d/final_tissues.txt',
    ]);
  });

  it('offers `<mesh>.msh.opt` for a mesh and nothing for a volume (§6.2)', () => {
    expect(deriveSidecarCandidates('/d/ernie.msh').opt).toEqual([
      '/d/ernie.msh.opt',
      '/d/ernie.opt',
    ]);
    expect(deriveSidecarCandidates('/d/T1.nii.gz').opt).toEqual([]);
  });

  it('takes the basename off either separator', () => {
    expect(baseName('/a/b/c.nii.gz')).toBe('c.nii.gz');
    expect(baseName('C:\\a\\b.msh')).toBe('b.msh');
    expect(baseName('bare.msh')).toBe('bare.msh');
  });
});

// ------------------------------------------------------------------------------------------------
// Status-bar metrics (§8)
// ------------------------------------------------------------------------------------------------

describe('metrics', () => {
  it('counts only frames inside the last second, so idle reads 0', () => {
    let state = EMPTY_METRICS;
    state = pushFrame(state, { at: 1000, cpuMs: 8 });
    state = pushFrame(state, { at: 1500, cpuMs: 8 });
    expect(fps(state, 1600)).toBe(2);
    // 900 ms later the first sample has aged out; 1200 ms later both have.
    expect(fps(state, 2400)).toBe(1);
    expect(fps(state, 3000)).toBe(0);
  });

  it('keeps at most the last 30 frames (§8: the median is over 30)', () => {
    let state = EMPTY_METRICS;
    for (let i = 0; i < 100; i++) state = pushFrame(state, { at: i, cpuMs: i });
    expect(state.samples).toHaveLength(FRAME_WINDOW);
    expect(state.samples[0]?.cpuMs).toBe(70);
  });

  it('takes the median, not the mean — one 400 ms hitch must not move it', () => {
    let state = EMPTY_METRICS;
    for (const cpuMs of [8, 8, 400, 9, 8]) state = pushFrame(state, { at: 0, cpuMs });
    expect(medianFrameMs(state)).toBe(8);
    expect(medianFrameMs(EMPTY_METRICS)).toBeNull();
  });

  it('reports GPU ms only when a sample carried one (§7.1: no timer query under SwiftShader)', () => {
    let state = pushFrame(EMPTY_METRICS, { at: 0, cpuMs: 8 });
    expect(medianGpuMs(state)).toBeNull();
    state = pushFrame(state, { at: 1, cpuMs: 8, gpuMs: 3 });
    expect(medianGpuMs(state)).toBe(3);
  });

  it('formats bytes and durations the way the status bar shows them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(27_262_976)).toBe('26.0 MB');
    expect(formatBytes(1_073_741_824)).toBe('1.0 GB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatDuration(320)).toBe('320 ms');
    expect(formatDuration(1543)).toBe('1.54 s');
  });
});

// ------------------------------------------------------------------------------------------------
// Load cards (§8)
// ------------------------------------------------------------------------------------------------

describe('load cards', () => {
  it('walks queued → loading → done, with percent and elapsed', () => {
    let cards = [newCard(1, 'ernie.msh', '/d/ernie.msh', 1000)];
    expect(cards[0]?.state).toBe('queued');
    expect(isActive(cards[0]!)).toBe(true);

    cards = startCard(cards, 1, 1000);
    cards = applyProgress(cards, 1, { datasetId: 'ds1', phase: 'parse', done: 3, total: 4 });
    expect(cards[0]?.phase).toBe('parse');
    expect(cards[0]?.datasetId).toBe('ds1');
    expect(cardPercent(cards[0]!)).toBe(75);
    expect(cardElapsedMs(cards[0]!, 1450)).toBe(450);

    cards = finishCard(cards, 1, 'ds1', 2000);
    expect(cards[0]?.state).toBe('done');
    expect(cardPercent(cards[0]!)).toBe(100);
    // Elapsed freezes at the end, so the card is a record and not a stopwatch.
    expect(cardElapsedMs(cards[0]!, 99_999)).toBe(1000);
    expect(isActive(cards[0]!)).toBe(false);
  });

  it('reads a denominator-free phase as 0 %, never NaN', () => {
    let cards = [newCard(1, 'a', null, 0)];
    cards = applyProgress(cards, 1, { datasetId: 'ds1', phase: 'read', done: 0, total: 0 });
    expect(cardPercent(cards[0]!)).toBe(0);
  });

  it('records a cancel pressed before the datasetId exists (§5 rule 6)', () => {
    let cards = [newCard(1, 'ernie_seeg.msh', null, 0)];
    cards = startCard(cards, 1, 0);
    cards = requestCancel(cards, 1);
    expect(cards[0]?.cancelRequested).toBe(true);
    expect(cards[0]?.datasetId).toBeNull();
    // The controller issues `cancelDataset` on the first progress event; the card only records intent.
    cards = failCard(cards, 1, 'load cancelled', 500, true);
    expect(cards[0]?.state).toBe('cancelled');
  });

  it('keeps failures on screen and ages successes out', () => {
    const done = finishCard([newCard(1, 'a', null, 0)], 1, 'ds1', 0);
    const failed = failCard([newCard(2, 'b', null, 0)], 2, 'bad magic', 0);
    const both = [...done, ...failed];
    expect(pruneCards(both, 1_000_000).map((c) => c.ticket)).toEqual([2]);
    expect(pruneCards(both, 100).map((c) => c.ticket)).toEqual([1, 2]);
    expect(dismissCard(both, 2).map((c) => c.ticket)).toEqual([1]);
  });
});

// ------------------------------------------------------------------------------------------------
// Keyboard map (§7.5)
// ------------------------------------------------------------------------------------------------

const key = (
  key: string,
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'editable', boolean>> = {}
) =>
  resolveKey({
    key,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
    editable: mods.editable ?? false,
  });

describe('resolveKey', () => {
  it('maps the §7.5 letters', () => {
    expect(key('x')).toEqual({ kind: 'cycleLayout' });
    expect(key('c')).toEqual({ kind: 'toggleCrosshair' });
    expect(key('r')).toEqual({ kind: 'resetView' });
    expect(key('o')).toEqual({ kind: 'toggleOrthographic' });
    expect(key('v')).toEqual({ kind: 'toggleActiveLayerVisible' });
    // Caps Lock must not silently disable the map.
    expect(key('X')).toEqual({ kind: 'cycleLayout' });
  });

  it('maps `[` / `]` to the active layer and `,` / `.` to the 4D index', () => {
    expect(key('[')).toEqual({ kind: 'cycleActiveLayer', delta: -1 });
    expect(key(']')).toEqual({ kind: 'cycleActiveLayer', delta: 1 });
    expect(key(',')).toEqual({ kind: 'stepVolumeIndex', delta: -1 });
    expect(key('.')).toEqual({ kind: 'stepVolumeIndex', delta: 1 });
  });

  it('maps 1..6 to the A/P/L/R/S/I presets', () => {
    for (const [digit, preset] of Object.entries(PRESET_KEYS)) {
      expect(key(digit)).toEqual({ kind: 'cameraPreset', preset });
    }
    expect(key('7')).toBeNull();
  });

  it('reserves Ctrl+↑/↓ for reordering and ignores every other modified key', () => {
    expect(key('ArrowUp', { ctrlKey: true })).toEqual({ kind: 'reorderActiveLayer', delta: 1 });
    expect(key('ArrowDown', { metaKey: true })).toEqual({ kind: 'reorderActiveLayer', delta: -1 });
    // ⌘O belongs to the Electron menu (§8); binding it here too would open two dialogs.
    expect(key('o', { metaKey: true })).toBeNull();
    expect(key('x', { ctrlKey: true })).toBeNull();
    expect(key('ArrowUp', { ctrlKey: true, shiftKey: true })).toBeNull();
  });

  it('separates the slice step from the in-plane nudge, as §7.5 lists them (P2-09)', () => {
    // PgUp/PgDn steps the slice: along the plane normal.
    expect(key('PageUp')).toEqual({ kind: 'stepCursor', steps: 1 });
    expect(key('PageDown')).toEqual({ kind: 'stepCursor', steps: -1 });
    // The arrows nudge the cursor **in** the plane: along the pane's right and up.
    expect(key('ArrowRight')).toEqual({ kind: 'nudgeCursor', dx: 1, dy: 0 });
    expect(key('ArrowLeft')).toEqual({ kind: 'nudgeCursor', dx: -1, dy: 0 });
    expect(key('ArrowUp')).toEqual({ kind: 'nudgeCursor', dx: 0, dy: 1 });
    expect(key('ArrowDown')).toEqual({ kind: 'nudgeCursor', dx: 0, dy: -1 });
  });

  it('is silent while the user is typing a coordinate', () => {
    expect(key('x', { editable: true })).toBeNull();
    expect(key('.', { editable: true })).toBeNull();
    expect(key('ArrowUp', { ctrlKey: true, editable: true })).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// Toasts (§8)
// ------------------------------------------------------------------------------------------------

describe('toasts', () => {
  it('titles the protocol error codes and never toasts a cancel', () => {
    expect(titleForCode('unsupported')).toBe('Unsupported file');
    expect(titleForCode('parse')).toBe('Could not parse the file');
    expect(titleForCode('weird')).toBe('Load failed (weird)');
    expect(isToastWorthy('cancelled')).toBe(false);
    expect(isToastWorthy('parse')).toBe(true);
  });

  it('keeps only the newest few and never ages an error out on its own', () => {
    let list = [] as ReturnType<typeof pushToast>;
    for (let i = 1; i <= 6; i++) {
      list = pushToast(list, { id: i, tone: 'error', title: `t${i}`, detail: '', at: 0 });
    }
    expect(list.map((t) => t.id)).toEqual([3, 4, 5, 6]);
    expect(pruneToasts(list, 1_000_000)).toHaveLength(4);
    const info = pushToast([], { id: 9, tone: 'info', title: 'i', detail: '', at: 0 });
    expect(pruneToasts(info, 1_000_000)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------
// PNG encoder (backs `screenshot()` on the stand-in engine)
// ------------------------------------------------------------------------------------------------

describe('encodePng', () => {
  it('writes a signature, an IHDR with the right size, and an IEND', () => {
    const png = encodePng({ width: 3, height: 2, pixels: new Uint8Array(3 * 2 * 4) });
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
    expect(view.getUint32(16)).toBe(3);
    expect(view.getUint32(20)).toBe(2);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // RGBA
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
  });

  it('writes pHYs only when a DPI is given (§4.7 ScreenshotOptions.dpi)', () => {
    const withDpi = encodePng({ width: 1, height: 1, pixels: new Uint8Array(4), dpi: 144 });
    const without = encodePng({ width: 1, height: 1, pixels: new Uint8Array(4) });
    const text = (b: Uint8Array): string => String.fromCharCode(...b);
    expect(text(withDpi)).toContain('pHYs');
    expect(text(without)).not.toContain('pHYs');
    // 144 dpi = 5669 pixels per metre, rounded.
    const at = text(withDpi).indexOf('pHYs');
    const view = new DataView(withDpi.buffer, withDpi.byteOffset, withDpi.byteLength);
    expect(view.getUint32(at + 4)).toBe(Math.round(144 / 0.0254));
  });

  it('refuses a pixel buffer that is not width * height * 4', () => {
    expect(() => encodePng({ width: 2, height: 2, pixels: new Uint8Array(3) })).toThrow();
  });
});
