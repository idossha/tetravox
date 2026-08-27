/**
 * §8's `Cursor` block and coordinate bar are driven by the `cursor` **event**, and nothing else.
 *
 * `Scene` is exposed `Readonly` and the app never polls it: `store/controller.ts` seeds the cursor
 * once at `attach()` — before any dataset exists — and updates it only from `EngineEvents.cursor`.
 * Every pane's crosshair and corner annotation, meanwhile, read `scene.cursor` directly. So an
 * engine that moves the cursor *without* emitting leaves the two halves of the UI describing
 * different points, and the info panel reports the value at world (0,0,0) while the crosshair sits
 * at the bounding-box centre — 33 mm away on `T1.nii.gz`, with an intensity to match.
 *
 * That is what Phase 1 shipped, so the auto-centre is asserted here through the event.
 */

import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

test('the first dataset moves the cursor to the bbox centre AND says so (§8)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);

  const info = await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    // Subscribed BEFORE the load, exactly as the app's controller does at attach().
    const events: [number, number, number][] = [];
    engine.on('cursor', (c) => events.push([c[0], c[1], c[2]]));
    const before = [...engine.scene.cursor] as [number, number, number];

    const ds = await engine.addDataset({ kind: 'path', path: url });
    engine.addLayer({ datasetId: ds.id, kind: 'volume' });
    await engine.whenSettled();

    const b = ds.bounds;
    return {
      before,
      events,
      sceneCursor: [...engine.scene.cursor] as [number, number, number],
      centre: [0, 1, 2].map((k) => ((b.min[k] ?? 0) + (b.max[k] ?? 0)) / 2),
      // What §8's info panel shows for that point, through the frozen `probe` path.
      probeWorld: engine.probe(engine.scene.cursor).world,
      probeVoxel: engine.probe(engine.scene.cursor).rows[0]?.voxel ?? null,
      errors: window.__tvxErrors ?? [],
    };
  }, fixture('vol_asym.nii'));

  expect(errors).toEqual([]);
  expect(info.errors).toEqual([]);
  expect(info.before, 'the scene starts at the world origin').toEqual([0, 0, 0]);

  // The engine moved the cursor…
  expect(info.sceneCursor).toEqual(info.centre);
  // …and told anyone listening, which is the only way the app can know.
  expect(info.events.length, 'exactly one cursor event for the auto-centre').toBe(1);
  expect(info.events[0]).toEqual(info.centre);
  // The two halves of §8 therefore agree: the crosshair (scene.cursor) and the readout (the event's
  // payload, probed) are the same point.
  expect(info.probeWorld).toEqual(info.centre);
  expect(info.probeVoxel, 'and it resolves to a voxel of the loaded volume').not.toBeNull();

  // A second dataset must NOT move it again — the auto-centre is a first-dataset courtesy.
  const after = await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    const events: [number, number, number][] = [];
    engine.on('cursor', (c) => events.push([c[0], c[1], c[2]]));
    await engine.addDataset({ kind: 'path', path: url });
    await engine.whenSettled();
    return { events, cursor: [...engine.scene.cursor] as [number, number, number] };
  }, fixture('vol_u8.nii.gz'));
  expect(after.events).toEqual([]);
  expect(after.cursor).toEqual(info.centre);
});
