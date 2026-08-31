/**
 * `NoGlEngine`'s §13 point tool — the stand-in the app is E2E-tested against (`?engine=mock`).
 *
 * Why this file exists at all: the app's E2E launches the shell with the stand-in, so a module that
 * arms the point tool, selects a contact and drags it is exercising **this** implementation and not
 * the WebGL2 one. A stand-in whose tool is a stub would make those specs prove nothing, and one
 * whose tool answered differently from the real engine would make them prove something false.
 *
 * So what is asserted here is the *state machine* the two engines share — arm/disarm exclusivity,
 * ids minted on arming, selection by id surviving a `points` replacement, one `dragEnd` per drag —
 * plus the one thing this engine had to decide for itself: its pane model. The hit test is the
 * engine's own exported `pointAtPane`, which is why "which contact did that click grab" is not
 * re-tested here (`packages/engine/src/layers/points.test.ts` owns that) but its *wiring* is.
 */

import { describe, expect, it } from 'vitest';
import { NoGlEngine } from './mockEngine';
import type { Dataset, Layer, LayerId, PointsLayer, vec3 } from '@tetravox/engine';

interface ToolEvent {
  layerId: LayerId;
  kind: string;
  pointId: string | null;
  index: number;
  world?: vec3;
  viewId?: string;
  /** §4.7's `PointToolEvent.reason` (2026-08-30) — `cleared` only. */
  reason?: string;
}

/**
 * A stand-in with one volume, one points layer, and every `pointTool` event recorded.
 *
 * The pane is 200×200 at `mmPerPx = 0.5` with the cursor at the origin, so the axial pane is an
 * exact 2 px/mm ruler: world `(x, y, ·)` is at `(100 + x/0.5 − 0.5, 100 − y/0.5 − 0.5)`.
 */
async function harness(points: PointsLayer['points'] = []): Promise<{
  engine: NoGlEngine;
  layerId: LayerId;
  events: ToolEvent[];
  dataset: Dataset;
}> {
  const engine = new NoGlEngine({ stepMs: 0 });
  const dataset = await engine.addDataset({ kind: 'path', path: '/tmp/t1.nii.gz' });
  const layer = engine.addLayer({
    datasetId: dataset.id,
    kind: 'points',
    points,
    shape: 'sphere',
    radiusMm: 4,
    color: [1, 0, 0, 1],
    showLabels: false,
  } as unknown as Parameters<NoGlEngine['addLayer']>[0]);
  engine.pointPane = { width: 200, height: 200 };
  engine.setCursor([0, 0, 0]);
  engine.setView('axial', { camera: { center: [0, 0], mmPerPx: 0.5 } });
  const events: ToolEvent[] = [];
  engine.on('pointTool', (e) => events.push(e as ToolEvent));
  return { engine, layerId: layer.id, events, dataset };
}

const at = (x: number, y: number): [number, number] => [100 + x / 0.5 - 0.5, 100 - y / 0.5 - 0.5];

const pointsOf = (engine: NoGlEngine, id: LayerId): PointsLayer['points'] => {
  const layer = engine.scene.layers.find((l: Layer) => l.id === id);
  return layer !== undefined && layer.kind === 'points' ? layer.points : [];
};

describe('NoGlEngine: the point tool (§13)', () => {
  it('mints `p<index>` ids when it arms a layer that has none', async () => {
    const { engine, layerId } = await harness([
      { position: [0, 0, 0] },
      { position: [4, 0, 0], id: 'c9' },
      { position: [8, 0, 0] },
    ]);
    engine.setPointTool({ layerId, mode: 'select' });
    expect(pointsOf(engine, layerId).map((p) => p.id)).toEqual(['p0', 'c9', 'p1']);
    // An id that is already taken is skipped rather than duplicated.
    const other = await harness([{ position: [0, 0, 0] }, { position: [4, 0, 0], id: 'p0' }]);
    other.engine.setPointTool({ layerId: other.layerId, mode: 'select' });
    expect(pointsOf(other.engine, other.layerId).map((p) => p.id)).toEqual(['p1', 'p0']);
  });

  it('places on every click, with the template, and says so once', async () => {
    const { engine, layerId, events } = await harness();
    engine.setPointTool({ layerId, mode: 'place', template: { group: 'LINS', radiusMm: 1.5 } });
    engine.pointToolClick('axial', ...at(10, 0));
    engine.pointToolClick('axial', ...at(20, 0));
    // The third click is on the first point: place mode has no hit test, so it places.
    engine.pointToolClick('axial', ...at(10, 0));

    const points = pointsOf(engine, layerId);
    expect(points).toHaveLength(3);
    expect(points.map((p) => p.group)).toEqual(['LINS', 'LINS', 'LINS']);
    expect(points[0]!.radiusMm).toBe(1.5);
    expect(points[0]!.position[0]).toBeCloseTo(10, 6);
    expect(points[1]!.position[0]).toBeCloseTo(20, 6);
    expect(new Set(points.map((p) => p.id)).size).toBe(3);

    expect(events.filter((e) => e.kind === 'placed')).toHaveLength(3);
    expect(events.filter((e) => e.kind === 'selected')).toHaveLength(0);
    expect(engine.pointSelection()?.index).toBe(2);
  });

  it('selects the point under a click, and drags it to the pointer', async () => {
    const { engine, layerId, events } = await harness([
      { position: [0, 0, 0], id: 'c1' },
      { position: [20, 0, 0], id: 'c2' },
    ]);
    engine.setPointTool({ layerId, mode: 'select' });

    engine.pointToolClick('axial', ...at(20, 0));
    expect(engine.pointSelection()).toEqual({ layerId, pointId: 'c2', index: 1 });
    expect(events.filter((e) => e.kind === 'selected')).toHaveLength(1);

    // 40 pane pixels at 0.5 mm/px is 20 mm of world, along the axial pane's `right` (= +X).
    const before = pointsOf(engine, layerId);
    engine.pointToolDrag('axial', at(20, 0)[0] + 40, at(20, 0)[1]);
    const moved = pointsOf(engine, layerId)[1]!.position;
    expect(moved[0]).toBeCloseTo(40, 6);
    expect(moved[1]).toBeCloseTo(0, 6);
    // The array was **replaced**, not mutated — `derived/store.ts` keys the instance buffer on its
    // identity, so a mutation would move the contact in the scene and not on the screen.
    expect(pointsOf(engine, layerId)).not.toBe(before);
    expect(before[1]!.position[0], 'and the old array still reads as it did').toBeCloseTo(20, 6);

    engine.pointToolDragEnd();
    engine.pointToolDragEnd();
    const ends = events.filter((e) => e.kind === 'dragEnd');
    expect(ends, 'one drag is one dragEnd, however many times the exits fire').toHaveLength(1);
    expect(ends[0]!.pointId).toBe('c2');
    expect(ends[0]!.world![0]).toBeCloseTo(40, 6);
  });

  it('selects a drawn ghost and grabs nothing (§7.5, 2026-08-30)', async () => {
    // 10 mm off the axial plane with a 4 mm radius: no cross-section at all, so what is on the
    // screen is the ghost the layer draws — and since the amendment, that is what a click finds.
    const { engine, layerId, events } = await harness([{ position: [0, 0, 10], id: 'ghost' }]);
    engine.updateLayer<PointsLayer>(layerId, { offPlaneOpacity: 0.6 });
    engine.setPointTool({ layerId, mode: 'select' });
    expect(engine.pointAtScreen('axial', ...at(0, 0))).toEqual({
      layerId,
      pointId: 'ghost',
      index: 0,
    });
    engine.pointToolClick('axial', ...at(0, 0));
    expect(engine.pointSelection()).toEqual({ layerId, pointId: 'ghost', index: 0 });
    expect(events.filter((e) => e.kind === 'selected')).toHaveLength(1);

    // No drag was taken, so a move writes nothing and the release emits no `dragEnd`.
    engine.pointToolDrag('axial', at(0, 0)[0] + 40, at(0, 0)[1]);
    expect(pointsOf(engine, layerId)[0]!.position).toEqual([0, 0, 10]);
    engine.pointToolDragEnd();
    expect(events.filter((e) => e.kind === 'dragEnd')).toEqual([]);
  });

  it('does not grab a ghost the layer is not drawing', async () => {
    const { engine, layerId } = await harness([{ position: [0, 0, 10], id: 'ghost' }]);
    engine.setPointTool({ layerId, mode: 'select' });
    expect(engine.pointAtScreen('axial', ...at(0, 0))).toBeNull();
    engine.pointToolClick('axial', ...at(0, 0));
    expect(engine.pointSelection()).toBeNull();
  });

  it('has no 3D hit test, and says so rather than inventing one', async () => {
    const { engine, layerId } = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    engine.setPointTool({ layerId, mode: 'select' });
    expect(engine.pointAtScreen('view3d', 100, 100)).toBeNull();
  });

  it('follows the selection by id across a replaced array, and clears when the id goes', async () => {
    const { engine, layerId, events } = await harness([
      { position: [0, 0, 0], id: 'c1' },
      { position: [20, 0, 0], id: 'c2' },
    ]);
    engine.setPointTool({ layerId, mode: 'select' });
    engine.setPointSelection({ layerId, pointId: 'c2' });
    expect(engine.pointSelection()?.index).toBe(1);

    engine.updateLayer<PointsLayer>(layerId, { points: [{ position: [20, 0, 0], id: 'c2' }] });
    expect(engine.pointSelection()).toEqual({ layerId, pointId: 'c2', index: 0 });
    expect(events.filter((e) => e.kind === 'cleared')).toHaveLength(0);

    engine.updateLayer<PointsLayer>(layerId, { points: [{ position: [0, 0, 0], id: 'c7' }] });
    expect(engine.pointSelection()).toBeNull();
    const cleared = events.filter((e) => e.kind === 'cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.pointId).toBeNull();
    expect(cleared[0]!.index).toBe(-1);
  });

  it('arms one click-consuming mode at a time', async () => {
    const { engine, layerId } = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    engine.setMeasureMode(true);
    engine.setPointTool({ layerId, mode: 'select' });
    expect(engine.measureMode()).toBe(false);
    engine.setMeasureMode(true);
    expect(engine.pointTool()).toBeNull();
  });

  it('walks `Esc` from place to select to off, clearing as it goes', async () => {
    const { engine, layerId, events } = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    engine.setPointTool({ layerId, mode: 'place' });
    engine.setPointSelection({ layerId, pointId: 'c1' });

    expect(engine.cancelPointTool()).toBe(true);
    expect(engine.pointTool()?.mode).toBe('select');
    expect(engine.pointSelection(), 'the first Esc leaves the selection alone').not.toBeNull();

    expect(engine.cancelPointTool()).toBe(true);
    expect(engine.pointTool()).toBeNull();
    expect(engine.pointSelection()).toBeNull();
    expect(events.filter((e) => e.kind === 'cleared')).toHaveLength(1);
    expect(engine.cancelPointTool(), 'a third Esc is not the tool s any more').toBe(false);
  });

  it('commits the drag it was in the middle of before it disarms', async () => {
    // The `Esc`-mid-drag case. `Esc` is the documented `place` → `select` → off key and is not
    // gated on a gesture being in flight, so a disarm can land with a contact half-dragged: every
    // intermediate position is already in the layer and already adopted by the host, and dropping
    // the drag would leave that edit with no commit point at all — no undo entry, no dirty mark.
    const { engine, layerId, events } = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    engine.setPointTool({ layerId, mode: 'select' });
    engine.pointToolClick('axial', ...at(0, 0));
    engine.pointToolDrag('axial', at(0, 0)[0] + 40, at(0, 0)[1]);
    expect(
      pointsOf(engine, layerId)[0]!.position[0],
      'the scene moved during the drag'
    ).toBeCloseTo(20, 6);

    // The zero-length `dragEnd` of the click itself has not been emitted (no exit ran yet), so the
    // one below is the drag's, and it arrives BEFORE `cleared` — a host that commits on `dragEnd`
    // and resets on `cleared` needs them in that order.
    expect(events.map((e) => e.kind)).toEqual(['selected']);
    expect(engine.cancelPointTool()).toBe(true);
    expect(events.map((e) => e.kind)).toEqual(['selected', 'dragEnd', 'cleared']);

    const end = events.find((e) => e.kind === 'dragEnd')!;
    expect(end.pointId).toBe('c1');
    expect(end.world![0], 'the commit names where the contact actually is').toBeCloseTo(20, 6);
    // …and the contact stayed where the drag left it: this exit is a commit, not a revert.
    expect(pointsOf(engine, layerId)[0]!.position[0]).toBeCloseTo(20, 6);
    // The drag is committed once, not again on a later exit.
    engine.pointToolDragEnd();
    expect(events.filter((e) => e.kind === 'dragEnd')).toHaveLength(1);
  });

  it('has nothing to commit when the drag`s point went with its layer', async () => {
    // `removeLayer` disarms *after* the layer has gone, so the commit above must not fire a
    // `dragEnd` for a contact that no longer exists.
    const { engine, layerId, events } = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    engine.setPointTool({ layerId, mode: 'select' });
    engine.pointToolClick('axial', ...at(0, 0));
    engine.pointToolDrag('axial', at(0, 0)[0] + 40, at(0, 0)[1]);
    engine.removeLayer(layerId);
    expect(engine.pointTool()).toBeNull();
    expect(events.filter((e) => e.kind === 'dragEnd')).toHaveLength(0);
  });

  it('disarms when its layer goes, and when a scene is loaded over it', async () => {
    const first = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    first.engine.setPointTool({ layerId: first.layerId, mode: 'select' });
    first.engine.removeLayer(first.layerId);
    expect(first.engine.pointTool()).toBeNull();

    const second = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    second.engine.setPointTool({ layerId: second.layerId, mode: 'select' });
    await second.engine.load(second.engine.serialize(), () => null);
    expect(second.engine.pointTool()).toBeNull();
    expect(second.events.filter((e) => e.kind === 'cleared').length).toBeGreaterThan(0);
  });

  /**
   * §4.7's `PointToolEvent.reason` (2026-08-30), mirrored here because `?engine=mock` is what the
   * app's E2E drives and a module reads the reason to decide whether to arm again.
   */
  it('says WHY it cleared, one reason per route', async () => {
    const esc = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    esc.engine.setPointTool({ layerId: esc.layerId, mode: 'select' });
    esc.engine.cancelPointTool();
    expect(esc.events.filter((e) => e.kind === 'cleared').at(-1)?.reason).toBe('esc');

    const measure = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    measure.engine.setPointTool({ layerId: measure.layerId, mode: 'select' });
    measure.engine.setMeasureMode(true);
    expect(measure.events.filter((e) => e.kind === 'cleared').at(-1)?.reason).toBe('measure');

    const gone = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    gone.engine.setPointTool({ layerId: gone.layerId, mode: 'select' });
    gone.engine.removeLayer(gone.layerId);
    expect(gone.events.filter((e) => e.kind === 'cleared').at(-1)?.reason).toBe('layer');

    const loaded = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    loaded.engine.setPointTool({ layerId: loaded.layerId, mode: 'select' });
    await loaded.engine.load(loaded.engine.serialize(), () => null);
    expect(loaded.events.filter((e) => e.kind === 'cleared').at(0)?.reason).toBe('load');

    const host = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    host.engine.setPointTool({ layerId: host.layerId, mode: 'select' });
    host.engine.setPointTool(null);
    expect(host.events.filter((e) => e.kind === 'cleared').at(-1)?.reason).toBe('host');

    // A selection that goes while the tool stays armed is a different event with a different
    // answer — this is the one a host must NOT read as "the tool is no longer mine".
    const sel = await harness([{ position: [0, 0, 0], id: 'c1' }]);
    sel.engine.setPointTool({ layerId: sel.layerId, mode: 'select' });
    sel.engine.setPointSelection({ layerId: sel.layerId, pointId: 'c1' });
    sel.engine.setPointSelection(null);
    expect(sel.events.filter((e) => e.kind === 'cleared').at(-1)?.reason).toBe('selection');
    expect(sel.engine.pointTool()).not.toBeNull();
  });

  it('returns copies, so a caller cannot edit the armed spec in place', async () => {
    const { engine, layerId } = await harness();
    engine.setPointTool({ layerId, mode: 'place', template: { group: 'A' } });
    const read = engine.pointTool()!;
    read.mode = 'select';
    read.template!.group = 'B';
    expect(engine.pointTool()!.mode).toBe('place');
    expect(engine.pointTool()!.template!.group).toBe('A');
  });
});
