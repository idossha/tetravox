/**
 * The §8 sidebar collapse state — a different disclosure from `collapse.test.ts`'s per-layer-row
 * one. This is "is the whole left/right panel shown at all", chrome that is never serialised into a
 * `ViewSpec` and is persisted in `localStorage` (`lib/panels.ts`) rather than in the scene.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoGlEngine } from '../engine/mockEngine';
import { ShellController } from './controller';
import { createUiStore } from './store';
import type { UiStore } from './store';
import {
  DEFAULT_PANEL_PREFS,
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
    const a = { leftPanelCollapsed: true, rightPanelCollapsed: false, mouseBlockCollapsed: false };
    savePanelPrefs(a);
    expect(loadPanelPrefs()).toEqual(a);
    const b = { leftPanelCollapsed: false, rightPanelCollapsed: true, mouseBlockCollapsed: true };
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
    });
  });
});
