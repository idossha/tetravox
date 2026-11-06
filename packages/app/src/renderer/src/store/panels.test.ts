/**
 * The §8 sidebar collapse state: "is the whole left/right panel shown at all", chrome that is never serialised into a
 * `ViewSpec` and is persisted in `localStorage` (`lib/panels.ts`) rather than in the scene.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoGlEngine } from '../engine/mockEngine';
import { ShellController } from './controller';
import { createUiStore } from './store';
import type { UiStore } from './store';
import {
  DEFAULT_PANEL_PREFS,
  MODULE_PANEL_WIDTH_PX,
  PANEL_WIDTH_LIMITS,
  loadPanelPrefs,
  savePanelPrefs,
  type PanelPrefs,
} from '../lib/panels';
import { resolveKey } from '../keyboard/keymap';

function harness(): { engine: NoGlEngine; store: UiStore; controller: ShellController } {
  const engine = new NoGlEngine({ stepMs: 0 });
  const store = createUiStore();
  const controller = new ShellController(engine, store);
  controller.attach();
  open.push(controller);
  return { engine, store, controller };
}

const open: ShellController[] = [];
afterEach(() => {
  for (const controller of open.splice(0)) controller.detach();
  savePanelPrefs(DEFAULT_PANEL_PREFS);
});

describe('sidebar collapse', () => {
  it('starts expanded on both sides', () => {
    const { store } = harness();
    expect(store.getState().leftPanelCollapsed).toBe(false);
    expect(store.getState().rightPanelCollapsed).toBe(false);
  });

  it('toggles one side without touching the other', () => {
    const { store, controller } = harness();
    controller.toggleLeftPanel();
    expect(store.getState().leftPanelCollapsed).toBe(true);
    expect(store.getState().rightPanelCollapsed).toBe(false);

    controller.toggleRightPanel();
    expect(store.getState().leftPanelCollapsed).toBe(true);
    expect(store.getState().rightPanelCollapsed).toBe(true);

    controller.toggleLeftPanel();
    expect(store.getState().leftPanelCollapsed).toBe(false);
    expect(store.getState().rightPanelCollapsed).toBe(true);
  });

  it('setLeftPanelCollapsed / setRightPanelCollapsed are idempotent no-ops when already there', () => {
    const { store, controller } = harness();
    const before = store.getState();
    controller.setLeftPanelCollapsed(false);
    expect(store.getState()).toBe(before);
  });

  it('is never written into the engine scene', () => {
    const { engine, controller } = harness();
    controller.toggleLeftPanel();
    controller.toggleRightPanel();
    expect(JSON.stringify(engine.serialize())).not.toContain('PanelCollapsed');
  });

  it('is reachable through runCommand, like every other §7.5 command', () => {
    const { store, controller } = harness();
    controller.runCommand({ kind: 'toggleLeftPanel' });
    expect(store.getState().leftPanelCollapsed).toBe(true);
    controller.runCommand({ kind: 'toggleRightPanel' });
    expect(store.getState().rightPanelCollapsed).toBe(true);
  });
});

describe('the Ctrl+[ / Ctrl+] chords', () => {
  it('resolve to the panel commands, not the plain [ / ] layer-cycle ones', () => {
    expect(
      resolveKey({
        key: '[',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        editable: false,
      })
    ).toEqual({ kind: 'toggleLeftPanel' });
    expect(
      resolveKey({
        key: ']',
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        editable: false,
      })
    ).toEqual({ kind: 'toggleRightPanel' });
  });

  it('plain [ / ] are unaffected — still the active-layer cycle', () => {
    expect(
      resolveKey({
        key: '[',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        editable: false,
      })
    ).toEqual({ kind: 'cycleActiveLayer', delta: -1 });
  });

  it('an editable target suppresses the chord like every other binding', () => {
    expect(
      resolveKey({
        key: '[',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        editable: true,
      })
    ).toBeNull();
  });
});

describe('lib/panels persistence', () => {
  beforeEach(() => savePanelPrefs(DEFAULT_PANEL_PREFS));

  it('loads the default when nothing is stored', () => {
    expect(loadPanelPrefs()).toEqual(DEFAULT_PANEL_PREFS);
  });

  it('round-trips a saved preference', () => {
    const a = { ...DEFAULT_PANEL_PREFS, leftPanelCollapsed: true, mouseBlockCollapsed: false };
    savePanelPrefs(a);
    expect(loadPanelPrefs()).toEqual(a);
    const b = { ...DEFAULT_PANEL_PREFS, rightPanelCollapsed: true, leftPanelWidth: 400 };
    savePanelPrefs(b);
    expect(loadPanelPrefs()).toEqual(b);
  });

  it('the Mouse block starts collapsed, and a pref written before it existed keeps that default', () => {
    expect(DEFAULT_PANEL_PREFS.mouseBlockCollapsed).toBe(true);
    // A v1 record from before the key existed — written through the same store the loader reads.
    savePanelPrefs({ leftPanelCollapsed: true, rightPanelCollapsed: false } as PanelPrefs);
    expect(loadPanelPrefs()).toEqual({
      leftPanelCollapsed: true,
      rightPanelCollapsed: false,
      mouseBlockCollapsed: true,
      oneLayerOpen: false,
      headerBlockCollapsed: true,
      leftPanelWidth: PANEL_WIDTH_LIMITS.left.default,
      rightPanelWidth: PANEL_WIDTH_LIMITS.right.default,
      rightModuleWidth: MODULE_PANEL_WIDTH_PX,
    });
  });

  it('a saved width above 400 px carries over to the docked width; a smaller one does not', () => {
    savePanelPrefs({ rightPanelWidth: 520 } as PanelPrefs);
    expect(loadPanelPrefs().rightPanelWidth).toBe(520);
    expect(loadPanelPrefs().rightModuleWidth).toBe(520);
    savePanelPrefs({ rightPanelWidth: 300 } as PanelPrefs);
    expect(loadPanelPrefs().rightPanelWidth).toBe(300);
    expect(loadPanelPrefs().rightModuleWidth).toBe(MODULE_PANEL_WIDTH_PX);
  });

  it('ignores a key this build no longer has', () => {
    savePanelPrefs({ centerShare: 0.5, collapsedLayers: { a: true } } as unknown as PanelPrefs);
    expect(loadPanelPrefs()).not.toHaveProperty('centerShare');
    expect(loadPanelPrefs()).not.toHaveProperty('collapsedLayers');
  });

  it('the header starts closed, and opening it is remembered', () => {
    const { store, controller } = harness();
    expect(store.getState().headerBlockCollapsed).toBe(true);
    controller.toggleHeaderBlock();
    expect(store.getState().headerBlockCollapsed).toBe(false);
    expect(loadPanelPrefs().headerBlockCollapsed).toBe(false);
  });

  it('clamps a stored width into bounds and replaces a non-number with the default', () => {
    savePanelPrefs({
      ...DEFAULT_PANEL_PREFS,
      leftPanelWidth: 10,
      rightPanelWidth: 'wide' as unknown as number,
    });
    const loaded = loadPanelPrefs();
    expect(loaded.leftPanelWidth).toBe(PANEL_WIDTH_LIMITS.left.min);
    expect(loaded.rightPanelWidth).toBe(PANEL_WIDTH_LIMITS.right.default);
  });
});

describe('sidebar width', () => {
  it('starts at the defaults, clamps, and persists only when asked', () => {
    const { store, controller } = harness();
    expect(store.getState().leftPanelWidth).toBe(PANEL_WIDTH_LIMITS.left.default);
    expect(store.getState().rightPanelWidth).toBe(PANEL_WIDTH_LIMITS.right.default);

    controller.setPanelWidth('left', 9999, false);
    expect(store.getState().leftPanelWidth).toBe(PANEL_WIDTH_LIMITS.left.max);
    expect(loadPanelPrefs().leftPanelWidth).toBe(PANEL_WIDTH_LIMITS.left.default);

    controller.setPanelWidth('right', 0);
    expect(store.getState().rightPanelWidth).toBe(PANEL_WIDTH_LIMITS.right.min);
    expect(loadPanelPrefs()).toMatchObject({
      leftPanelWidth: PANEL_WIDTH_LIMITS.left.max,
      rightPanelWidth: PANEL_WIDTH_LIMITS.right.min,
    });
  });
});
