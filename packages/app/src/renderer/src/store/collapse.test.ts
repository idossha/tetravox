/**
 * The layer panel's disclosure state (docs/PLAN-2026-08-28-directed.md #1).
 *
 * Two properties matter and neither is a pixel: the state is **chrome** — it never reaches the
 * engine and never reaches a `ViewSpec` — and it survives everything the scene does to a layer
 * except deleting it. Driven through `ShellController` against the stand-in engine, like
 * `controller.test.ts`, so "no logic in React" is what is being asserted rather than assumed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { NoGlEngine } from '../engine/mockEngine';
import { ShellController } from './controller';
import { collapseAllAction, createUiStore, isLayerCollapsed, pruneCollapsed } from './store';
import type { UiStore } from './store';
import type { OpenRequest } from '../open/sources';

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
});

function pathRequest(path: string): OpenRequest {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { name, path, source: { kind: 'path', path } };
}

async function settled(store: UiStore): Promise<void> {
  for (let i = 0; i < 500; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (!store.getState().loads.some((c) => c.state === 'queued' || c.state === 'loading')) return;
  }
  throw new Error('loads never settled');
}

async function twoLayers(): Promise<{
  engine: NoGlEngine;
  store: UiStore;
  controller: ShellController;
  ids: string[];
}> {
  const { engine, store, controller } = harness();
  controller.open([pathRequest('/d/T1.nii.gz'), pathRequest('/d/labels.nii.gz')]);
  await settled(store);
  const ids = store.getState().layers.map((l) => l.id);
  expect(ids).toHaveLength(2);
  return { engine, store, controller, ids };
}

describe('pruneCollapsed', () => {
  it('returns the same object when every key is still a live layer', () => {
    const collapsed = { a: true } as Record<string, boolean>;
    const same = pruneCollapsed(collapsed, [{ id: 'a' }, { id: 'b' }] as never);
    expect(same).toBe(collapsed);
  });

  it('drops entries for layers that are gone', () => {
    const pruned = pruneCollapsed({ a: true, b: true } as never, [{ id: 'b' }] as never);
    expect(pruned).toEqual({ b: true });
  });
});

describe('collapseAllAction', () => {
  it('offers collapse while any row is open and expand once they are all shut', () => {
    const layers = [{ id: 'a' }, { id: 'b' }] as never;
    expect(collapseAllAction({ layers, collapsedLayers: {} } as never)).toBe('collapse');
    expect(collapseAllAction({ layers, collapsedLayers: { a: true } } as never)).toBe('collapse');
    expect(collapseAllAction({ layers, collapsedLayers: { a: true, b: true } } as never)).toBe(
      'expand'
    );
  });
});

describe('the layer disclosure', () => {
  it('starts expanded, toggles one row at a time, and touches no other row', async () => {
    const { store, controller, ids } = await twoLayers();
    const [first, second] = ids as [string, string];
    expect(isLayerCollapsed(store.getState(), first)).toBe(false);

    controller.toggleLayerCollapsed(first);
    expect(isLayerCollapsed(store.getState(), first)).toBe(true);
    expect(isLayerCollapsed(store.getState(), second)).toBe(false);

    controller.toggleLayerCollapsed(first);
    expect(isLayerCollapsed(store.getState(), first)).toBe(false);
  });

  it('expand/collapse-all covers every row, and a new layer still arrives expanded', async () => {
    const { store, controller, ids } = await twoLayers();
    controller.setAllLayersCollapsed(true);
    for (const id of ids) expect(isLayerCollapsed(store.getState(), id)).toBe(true);

    // "Others keep their state": collapse-all shut both, and opening a third leaves those two shut
    // while the newcomer — absent from the map — is open.
    controller.open([pathRequest('/d/third.nii.gz')]);
    await settled(store);
    const third = store
      .getState()
      .layers.map((l) => l.id)
      .find((id) => !ids.includes(id));
    expect(third).toBeDefined();
    for (const id of ids) expect(isLayerCollapsed(store.getState(), id)).toBe(true);
    expect(isLayerCollapsed(store.getState(), third as string)).toBe(false);

    controller.setAllLayersCollapsed(false);
    expect(store.getState().collapsedLayers).toEqual({});
  });

  it('survives a reorder and is forgotten when the layer is closed', async () => {
    const { store, controller, ids } = await twoLayers();
    const [first, second] = ids as [string, string];
    controller.setLayerCollapsed(second, true);

    controller.moveLayer(second, -1);
    expect(store.getState().layers.map((l) => l.id)).toEqual([second, first]);
    expect(isLayerCollapsed(store.getState(), second)).toBe(true);

    const datasetId = store.getState().layers.find((l) => l.id === second)?.datasetId as string;
    controller.closeDataset(datasetId);
    expect(store.getState().collapsedLayers).toEqual({});
  });

  it('is never serialised into the scene — a ViewSpec has no disclosure in it', async () => {
    const { engine, store, controller } = await twoLayers();
    controller.setAllLayersCollapsed(true);
    expect(JSON.stringify(store.getState().collapsedLayers)).not.toBe('{}');
    expect(JSON.stringify(engine.serialize())).not.toContain('collapsed');
  });
});
