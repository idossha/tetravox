/**
 * The controller surface A-PROPS appended (`patchLayer`, `patchLayerAsync`, `setCursorWorld`,
 * `setClipFollowsCursor`), driven against the stand-in engine.
 *
 * It lives here rather than in `store/controller.test.ts` because
 * tests live under their owner's directories — and the assertions are about this editor's contract
 * with the engine: **one control, one §4.7 call, with exactly those arguments**.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeshLayer } from '@tetravox/engine';
import { NoGlEngine } from '../../../engine/mockEngine';
import { ShellController } from '../../../store/controller';
import { createUiStore } from '../../../store/store';
import type { UiStore } from '../../../store/store';
import { addClipPlane, setTagVisible, soloTag } from './state';

const open: ShellController[] = [];
afterEach(() => {
  for (const controller of open.splice(0)) controller.detach();
});

async function meshHarness(): Promise<{
  engine: NoGlEngine;
  store: UiStore;
  controller: ShellController;
  layer: () => MeshLayer;
}> {
  const engine = new NoGlEngine({ stepMs: 0 });
  const store = createUiStore();
  const controller = new ShellController(engine, store);
  controller.attach();
  open.push(controller);
  const dataset = await engine.addDataset({ kind: 'path', path: '/d/m2m_ernie/ernie.msh' });
  engine.addLayer({ datasetId: dataset.id, kind: 'mesh' });
  const layer = (): MeshLayer => {
    const found = store.getState().layers.find((l) => l.kind === 'mesh');
    if (found === undefined || found.kind !== 'mesh') throw new Error('no mesh layer');
    return found;
  };
  return { engine, store, controller, layer };
}

describe('patchLayer — one control, one §4.7 call', () => {
  it('passes the patch through to `updateLayer` verbatim and asks for a frame', async () => {
    const { engine, controller, layer } = await meshHarness();
    const update = vi.spyOn(engine, 'updateLayer');
    const render = vi.spyOn(engine, 'requestRender');
    const patch = setTagVisible(layer(), 5, false);

    controller.patchLayer(layer().id, patch);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(layer().id, patch);
    expect(render).toHaveBeenCalledTimes(1);
    // And the scene really reports the tag hidden — the E2E asserts the same thing through the DOM.
    expect(layer().tagStyle[5]?.visible).toBe(false);
    expect(layer().tagStyle[2]?.visible).toBe(true);
  });

  it('does not call the engine at all for an empty patch', async () => {
    const { engine, controller, layer } = await meshHarness();
    const update = vi.spyOn(engine, 'updateLayer');
    // Every reducer returns `{}` when it refuses — a seventh clip plane, a field the dataset does
    // not have, a component change on a layer with no field. A refusal must not become a no-op
    // `updateLayer`, which would re-render and, on the real engine, invalidate caches for nothing.
    controller.patchLayer(layer().id, {});
    let full = layer();
    for (let i = 0; i < 6; i += 1) full = { ...full, ...addClipPlane(full, [0, 0, 1], i) };
    controller.patchLayer(full.id, addClipPlane(full, [1, 0, 0], 0));
    expect(update).not.toHaveBeenCalled();
  });

  it('solos a tag in one call, not one call per tag', async () => {
    const { engine, controller, layer } = await meshHarness();
    const update = vi.spyOn(engine, 'updateLayer');
    const tags = Object.keys(layer().tagStyle).map(Number);
    controller.patchLayer(layer().id, soloTag(layer(), tags, tags[0] as number));
    expect(update).toHaveBeenCalledTimes(1);
    const visible = tags.filter((t) => layer().tagStyle[t]?.visible);
    expect(visible).toEqual([tags[0]]);
  });
});

describe('patchLayerAsync — §7.4’s three async switches', () => {
  it('shows the pending badge while the worker builds, and clears it after `whenSettled`', async () => {
    const { controller, store, layer } = await meshHarness();
    const id = layer().id;
    const inFlight = controller.patchLayerAsync<MeshLayer>(
      id,
      { edges: { surface: true, caps: false } },
      'edges'
    );
    // The badge is up synchronously: §7.4 calls these "async loads with a progress state".
    expect(store.getState().meshPending[id]).toEqual(['edges']);
    await inFlight;
    expect(store.getState().meshPending[id]).toBeUndefined();
    expect(layer().edges.surface).toBe(true);
  });

  it('clears the badge even if the engine rejects, so a failure is not a stuck spinner', async () => {
    const { engine, controller, store, layer } = await meshHarness();
    const id = layer().id;
    vi.spyOn(engine, 'whenSettled').mockRejectedValueOnce(new Error('boom'));
    await expect(
      controller.patchLayerAsync<MeshLayer>(id, { colorMode: 'label' }, 'label')
    ).rejects.toThrow('boom');
    expect(store.getState().meshPending[id]).toBeUndefined();
  });
});

describe('clip planes that follow the cursor', () => {
  it('re-derives the offset from every `cursor` event, and only for the planes that follow', async () => {
    const { engine, controller, layer } = await meshHarness();
    const id = layer().id;
    controller.patchLayer(id, addClipPlane(layer(), [0, 0, 1], 0));
    controller.patchLayer(id, addClipPlane(layer(), [1, 0, 0], 0));

    controller.setClipFollowsCursor(id, 1, true);
    // The flag is on the layer (§4.4's `ClipPlane.followCursor`), so it round-trips through
    // `serialize()`; nothing about it lives in the UI store.
    expect(layer().clip.planes[1]?.followCursor).toBe(true);
    expect(layer().clip.planes[0]?.followCursor).toBeUndefined();

    engine.setCursor([12, 34, 56]);
    expect(layer().clip.planes[0]?.plane.offset).toBe(0);
    // `offset = −dot(n, cursor)` puts the plane through the cursor: n = +X ⇒ −12.
    expect(layer().clip.planes[1]?.plane.offset).toBe(-12);

    controller.setClipFollowsCursor(id, 1, false);
    expect(layer().clip.planes[1]?.followCursor).toBeUndefined();
    engine.setCursor([90, 0, 0]);
    expect(layer().clip.planes[1]?.plane.offset).toBe(-12);
  });

  it('stops touching the engine once nothing follows', async () => {
    const { engine, controller, layer } = await meshHarness();
    const id = layer().id;
    controller.patchLayer(id, addClipPlane(layer(), [0, 1, 0], 0));
    controller.setClipFollowsCursor(id, 0, true);
    controller.setClipFollowsCursor(id, 0, false);
    const update = vi.spyOn(engine, 'updateLayer');
    engine.setCursor([1, 2, 3]);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('setCursorWorld', () => {
  it('is `Engine.setCursor` and nothing else — the points panel’s "go to this electrode"', async () => {
    const { engine, controller, store } = await meshHarness();
    const setCursor = vi.spyOn(engine, 'setCursor');
    controller.setCursorWorld([-21.2, 66.9, 12.1]);
    expect(setCursor).toHaveBeenCalledWith([-21.2, 66.9, 12.1]);
    expect(store.getState().cursor).toEqual([-21.2, 66.9, 12.1]);
  });
});
