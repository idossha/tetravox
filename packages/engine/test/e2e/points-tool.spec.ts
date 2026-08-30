/**
 * §7.5's point tool — §13's contact editing, the analytic gate.
 *
 * §11 rule 0: an agent cannot judge a picture, it can judge a number. The claim this file exists
 * for is stated as a number and derived **independently of the engine**, the way `measure.spec.ts`
 * derives its length:
 *
 * > a `select`-mode drag of `n` pane pixels moves the contact `n · mmPerPx` in world millimetres.
 *
 * That identity is exact rather than approximate: §3's in-plane basis is orthonormal, the drag never
 * leaves the pane's plane (every move is `paneToWorld` at the pointer), and an orthographic 2D
 * camera is a uniform `mmPerPx` scaling of that basis. The engine reaches the same number by a
 * different route — `paneToWorld` per move, then a 3-D Euclidean norm in scanner RAS — which is what
 * makes the agreement evidence and not a tautology. The tolerance is §11's 0.05 mm.
 *
 * The rest is the grammar §7.5 states, each clause as its own case: place-on-every-click, the hit
 * boundary at 0.9 r and 1.1 r, exactly one `dragEnd` from each of the three gesture exits, a
 * selection that survives its array being replaced and is `cleared` when its id is not in the new
 * one, `Esc`, and the one-armed-mode invariant. Every pointer event is a real
 * `pointerdown`/`pointermove`/`pointerup` through Chromium's input pipeline, so what is tested is
 * the path a user's hand takes.
 *
 * Tagged `@angle` so both Playwright projects run it: this is a gesture a user performs on the real
 * GPU, and the selection ring it leaves behind is part of the frame.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readCanvasRect } from '../helpers/pixels';
import { DEFAULT_OVERLAY_THEME } from '../../src/overlay/theme';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

const LATTICE = fixture('mesh_v2_binary.msh');

/** The canvas in `test/pages/scene.html`; with `1x1` the pane *is* the canvas. */
const PANE = 768;
const CX = PANE / 2;
const CY = PANE / 2;

/** The pane's ruler: `mmPerPx = 0.05` around a cursor at the origin is exactly 20 px per mm. */
const MM_PER_PX = 0.05;
/** The layer's radius, so the on-slice disc is `2 / 0.05 = 40 px` — well clear of the 8 px floor. */
const RADIUS_MM = 2;
const DISC_PX = RADIUS_MM / MM_PER_PX;

type Vec3 = [number, number, number];

interface ToolEvent {
  layerId: string;
  kind: string;
  pointId: string | null;
  index: number;
  world?: number[];
  viewId?: string;
}

interface StoredPoint {
  id?: string;
  name?: string;
  group?: string;
  position: Vec3;
  radiusMm?: number;
}

/** `OverlayTheme.select`, as the bytes `readPixel` returns (§4.1's exact round trip). */
const SELECT_RGBA: [number, number, number] = [
  Math.round(DEFAULT_OVERLAY_THEME.select[0] * 255),
  Math.round(DEFAULT_OVERLAY_THEME.select[1] * 255),
  Math.round(DEFAULT_OVERLAY_THEME.select[2] * 255),
];

async function openScene(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/test/pages/scene.html?aa=off');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  return errors;
}

/**
 * A coronal pane over `derived.spec.ts`'s lattice, with one points layer on the same dataset.
 *
 * The cursor is at `[0, 2.5, 0]` and the camera at `{ center: [0, 0], mmPerPx: 0.05 }`, which makes
 * the pane an exact ruler: world `(x, ·, z)` is at canvas pixel `(CX + x/0.05, CY − z/0.05)`. Every
 * pixel named below follows from that rather than from a measurement.
 *
 * The `pointTool` events are collected into `window.__toolEvents` from the first frame, so a case
 * can assert what was emitted **and** how many times.
 */
async function toolScene(
  page: Page,
  points: StoredPoint[],
  layerPatch: Record<string, unknown> = {}
): Promise<{ layerId: string }> {
  return await page.evaluate(
    async ([url, pts, patch]) => {
      const engine = window.__tvxEngine!;
      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      const layer = engine.addLayer({
        datasetId: ds.id,
        kind: 'points',
        points: pts as never,
        color: [1, 0, 0, 1],
        radiusMm: 2,
        ...(patch as Record<string, unknown>),
      });
      engine.setLayout({ kind: '1x1', cells: ['coronal'] });
      engine.setCursor([0, 2.5, 0]);
      engine.setView('coronal', { camera: { center: [0, 0], mmPerPx: 0.05 } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      const events: unknown[] = [];
      engine.on('pointTool', (e) => events.push(JSON.parse(JSON.stringify(e))));
      (window as unknown as { __toolEvents: unknown[] }).__toolEvents = events;
      await engine.whenSettled();
      return { layerId: layer.id };
    },
    [LATTICE, points, layerPatch] as const
  );
}

/**
 * Pane pixels of a world point in this coronal pane: right = +X, up = +Z, 0.05 mm/px.
 *
 * Rounded to the pixel a click can actually land on, so it is within half a pixel of the point's
 * exact projection — which is 0.025 mm here, four hundred times inside the 40 px disc it aims at.
 * Where a *world* answer is asserted the test uses {@link worldOfPixel} instead, which is the same
 * ruler read the other way and carries the half-pixel.
 */
const at = (x: number, z: number): [number, number] => [CX + x / MM_PER_PX, CY - z / MM_PER_PX];

/**
 * The world point a pane pixel addresses, from §11's pixel-centre convention (`p + 0.5`) and §3's
 * coronal basis — derived here rather than asked of `paneToWorld`, which is the thing under test.
 */
const worldOfPixel = (px: number, py: number): Vec3 => [
  (px + 0.5 - CX) * MM_PER_PX,
  2.5,
  (CY - py - 0.5) * MM_PER_PX,
];

/**
 * The **exact** projected centre of a world point — {@link at} minus §11's half pixel.
 *
 * A ring is measured as a radius from a centre, so the centre has to be the real one: measuring
 * from `at()` puts `√2/2` px of error into every radius, which is most of the ring's own width.
 */
const centreOf = (x: number, z: number): [number, number] => [
  CX + x / MM_PER_PX - 0.5,
  CY - z / MM_PER_PX - 0.5,
];

const arm = async (page: Page, spec: unknown): Promise<void> => {
  await page.evaluate(async (s) => {
    window.__tvxEngine!.setPointTool(s as never);
    await window.__tvxEngine!.whenSettled();
  }, spec);
};

const pointsOf = async (page: Page, layerId: string): Promise<StoredPoint[]> =>
  await page.evaluate((id) => {
    const layer = window.__tvxEngine!.scene.layers.find((l) => l.id === id);
    return JSON.parse(
      JSON.stringify(layer !== undefined && layer.kind === 'points' ? layer.points : [])
    ) as StoredPoint[];
  }, layerId);

const eventsOf = async (page: Page): Promise<ToolEvent[]> =>
  await page.evaluate(
    () => (window as unknown as { __toolEvents: ToolEvent[] }).__toolEvents ?? []
  );

const selectionOf = async (page: Page): Promise<{ pointId: string; index: number } | null> =>
  await page.evaluate(() => {
    const sel = window.__tvxEngine!.pointSelection();
    return sel === null ? null : { pointId: sel.pointId, index: sel.index };
  });

/** A real click through Chromium's input pipeline, then a settled frame. */
async function clickAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y);
  await page.evaluate(async () => {
    await window.__tvxEngine!.whenSettled();
  });
}

const settle = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    await window.__tvxEngine!.whenSettled();
  });
};

const dist = (a: Vec3, b: Vec3): number => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

// ===============================================================================================
// place mode
// ===============================================================================================

test('@angle place mode appends a point on EVERY left click, hit test or not', async ({ page }) => {
  const errors = await openScene(page);
  const { layerId } = await toolScene(page, []);
  await arm(page, { layerId, mode: 'place', template: { group: 'LINS', radiusMm: 2 } });

  const first: [number, number] = at(-6, 4);
  await clickAt(page, ...first);
  await clickAt(page, ...at(0, 4));
  // The third click lands **on the first point's disc**. Place mode has no hit test, so it places a
  // third point rather than selecting the one under it — §7.5's whole reason for the rule.
  await clickAt(page, first[0] + 2, first[1]);

  const points = await pointsOf(page, layerId);
  expect(points).toHaveLength(3);
  // The template rode along, and the engine minted an id per point — unique within the layer.
  expect(points.map((p) => p.group)).toEqual(['LINS', 'LINS', 'LINS']);
  const ids = points.map((p) => p.id);
  expect(new Set(ids).size, 'every placed point has its own id').toBe(3);
  for (const id of ids) expect(id).toMatch(/^p\d+$/);

  // Where they landed: the world each clicked pixel addresses, derived from §11's pixel-centre
  // convention rather than read back from the engine.
  const expected = [
    worldOfPixel(...first),
    worldOfPixel(...at(0, 4)),
    worldOfPixel(first[0] + 2, first[1]),
  ];
  for (let i = 0; i < 3; i += 1) {
    for (const k of [0, 1, 2] as const) {
      expect(points[i]!.position[k]).toBeCloseTo(expected[i]![k], 6);
    }
  }
  // …and every one of them is on the pane's own plane, which is the cursor's `y`.
  for (const p of points) expect(p.position[1]).toBeCloseTo(2.5, 6);

  // One `placed` per click, each naming the point it made, and each carrying its world and pane.
  const placed = (await eventsOf(page)).filter((e) => e.kind === 'placed');
  expect(placed).toHaveLength(3);
  expect(placed.map((e) => e.pointId)).toEqual(ids);
  expect(placed.map((e) => e.index)).toEqual([0, 1, 2]);
  expect(placed[0]!.viewId).toBe('coronal');
  expect(placed[0]!.world![0]).toBeCloseTo(expected[0]![0], 6);
  // A placement selects what it placed — and says so once, as `placed`, not twice.
  expect(await selectionOf(page)).toEqual({ pointId: ids[2], index: 2 });
  expect((await eventsOf(page)).filter((e) => e.kind === 'selected')).toEqual([]);
  expect(errors).toEqual([]);
});

test('@angle place mode does not move the cursor, and select mode does not place', async ({
  page,
}) => {
  await openScene(page);
  const { layerId } = await toolScene(page, []);
  const before = await page.evaluate(() => [...window.__tvxEngine!.scene.cursor] as Vec3);

  await arm(page, { layerId, mode: 'place' });
  await clickAt(page, ...at(5, -5));
  expect(
    await page.evaluate(() => [...window.__tvxEngine!.scene.cursor] as Vec3),
    'the click was the tool s, so R1 s cursor gesture never ran'
  ).toEqual(before);

  await arm(page, { layerId, mode: 'select' });
  await clickAt(page, ...at(-9, -9));
  expect(await pointsOf(page, layerId), 'select mode places nothing').toHaveLength(1);
  // …and a click on nothing in select mode is not the tool's: R1's cursor gesture runs as usual.
  expect(await page.evaluate(() => [...window.__tvxEngine!.scene.cursor] as Vec3)).not.toEqual(
    before
  );
});

// ===============================================================================================
// select mode: the hit boundary, the ring, and the drag identity
// ===============================================================================================

test('@angle a select-mode click grabs the disc under it and rings it', async ({ page }) => {
  const errors = await openScene(page);
  const { layerId } = await toolScene(page, [
    { id: 'c1', position: [-5, 2.5, 5], name: 'LINS01' },
    { id: 'c2', position: [5, 2.5, 5], name: 'LINS02' },
  ]);
  await arm(page, { layerId, mode: 'select' });

  await clickAt(page, ...at(5, 5));
  expect(await selectionOf(page)).toEqual({ pointId: 'c2', index: 1 });
  const events = await eventsOf(page);
  const selected = events.filter((e) => e.kind === 'selected');
  expect(selected).toHaveLength(1);
  expect(selected[0]!.pointId).toBe('c2');
  // A click is a press and a release, so the gesture ran and ended: a select-mode click is a
  // **zero-length drag** and emits one `dragEnd` after its `selected`. Stated here because a host
  // that treats every `dragEnd` as an edit would otherwise record an undo step per selection.
  expect(events.map((e) => e.kind)).toEqual(['selected', 'dragEnd']);

  // The ring is on the picture, at the disc's radius plus §7.2's 2 px gap — measured off the
  // framebuffer, the way §11 measures the scale bar's length. The band is 2 px wide, so every
  // ring pixel is within half of that of `disc + 2`, plus the rasteriser's own coverage — which is
  // what the 2.5 px window allows for, and it is far tighter than the 40 px disc it is about.
  const radii = await ringRadii(page, ...centreOf(5, 5));
  expect(radii.length, 'the selection ring is drawn').toBeGreaterThan(80);
  expect(Math.min(...radii)).toBeGreaterThanOrEqual(DISC_PX + 2 - 2.5);
  expect(Math.max(...radii)).toBeLessThanOrEqual(DISC_PX + 2 + 2.5);
  expect(errors).toEqual([]);
});

test('@angle the hit boundary is the disc, with the 8 px floor under it', async ({ page }) => {
  await openScene(page);
  const { layerId } = await toolScene(page, [{ id: 'c1', position: [0, 2.5, 0] }]);
  await arm(page, { layerId, mode: 'select' });
  const [cx, cy] = at(0, 0);

  // `pointAtScreen` is the rule on its own — CSS pixels, like `pick()`, and DPR is 1 here.
  const hitAt = async (dx: number): Promise<string | null> =>
    await page.evaluate(
      ([x, y]) =>
        window.__tvxEngine!.pointAtScreen('coronal', x as number, y as number)?.pointId ?? null,
      [cx + dx, cy] as const
    );

  expect(await hitAt(DISC_PX * 0.9), '0.9 r is inside the disc').toBe('c1');
  expect(await hitAt(DISC_PX * 1.1), '1.1 r is outside it, and past the 8 px floor').toBeNull();

  // …and the click path agrees with the rule, which is the point of there being one rule.
  await clickAt(page, cx + DISC_PX * 1.1, cy);
  expect(await selectionOf(page)).toBeNull();
  await clickAt(page, cx + DISC_PX * 0.9, cy);
  expect(await selectionOf(page)).toEqual({ pointId: 'c1', index: 0 });
});

test('@angle a ghost is never hit, however visibly it is drawn', async ({ page }) => {
  await openScene(page);
  // 10 mm off the pane's plane with a 2 mm radius: no cross-section, so only a ghost can draw it.
  const { layerId } = await toolScene(page, [{ id: 'ghost', position: [0, 12.5, 0] }], {
    offPlaneOpacity: 0.6,
  });
  await arm(page, { layerId, mode: 'select' });
  const [cx, cy] = at(0, 0);

  // It IS drawn — the ghost paints the layer's red over the pane at 0.6.
  const px = await readCanvasRect(page, Math.round(cx), Math.round(cy), 1, 1);
  expect(px[0]!, 'the ghost is on the picture').toBeGreaterThan(120);
  // …and it is not selectable, from either the query or the click.
  expect(
    await page.evaluate(
      ([x, y]) => window.__tvxEngine!.pointAtScreen('coronal', x as number, y as number),
      [cx, cy] as const
    )
  ).toBeNull();
  await clickAt(page, cx, cy);
  expect(await selectionOf(page)).toBeNull();
});

test('@angle a 40 px drag moves the contact 40 · mmPerPx, and ends exactly once', async ({
  page,
}) => {
  const errors = await openScene(page);
  const { layerId } = await toolScene(page, [{ id: 'c1', position: [0, 2.5, 0] }]);
  await arm(page, { layerId, mode: 'select' });

  const [cx, cy] = at(0, 0);
  const DRAG_PX = 40;
  const before = (await pointsOf(page, layerId))[0]!.position;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // Two moves, and the identity is asserted **between them**: each move puts the contact under the
  // pointer (§7.5), so the difference between two pointer positions is the whole of the movement
  // and the press's own sub-pixel offset cancels out of it.
  await page.mouse.move(cx + 10, cy);
  await settle(page);
  const p1 = (await pointsOf(page, layerId))[0]!.position;
  expect(dist(before, p1), 'the scene moves DURING the drag, not on release').toBeGreaterThan(0.3);

  await page.mouse.move(cx + 10 + DRAG_PX, cy);
  await settle(page);
  const p2 = (await pointsOf(page, layerId))[0]!.position;

  // -- the analytic assertion -------------------------------------------------------------------
  // An orthographic 2D pane is a uniform `mmPerPx` scaling of an orthonormal in-plane basis, so a
  // 40 px drag is 40 · mmPerPx of world millimetres. Derived from §3, not read back from the engine.
  expect(Math.abs(dist(p1, p2) - DRAG_PX * MM_PER_PX)).toBeLessThan(0.05);
  // …along the pane's `right`, which is +X in a coronal pane, and in-plane: the drag was
  // horizontal, so the pane's `up` (+Z) did not move, and the along-normal coordinate is still the
  // plane's — a contact dragged in a slice stays in that slice.
  expect(p2[0] - p1[0]).toBeCloseTo(DRAG_PX * MM_PER_PX, 6);
  expect(p2[2] - p1[2]).toBeCloseTo(0, 6);
  expect(p2[1]).toBeCloseTo(before[1], 6);

  await page.mouse.up();
  await settle(page);
  const after = (await pointsOf(page, layerId))[0]!.position;
  // The release changes nothing: the scene already moved, and `dragEnd` is a commit, not an edit.
  expect(after).toEqual(p2);
  // And where it ended is the world the last pointer pixel addresses.
  const target = worldOfPixel(cx + 10 + DRAG_PX, cy);
  for (const k of [0, 1, 2] as const) expect(after[k]).toBeCloseTo(target[k], 6);

  const ends = (await eventsOf(page)).filter((e) => e.kind === 'dragEnd');
  expect(ends, 'one drag is one dragEnd').toHaveLength(1);
  expect(ends[0]!.pointId).toBe('c1');
  expect(ends[0]!.viewId).toBe('coronal');
  expect(ends[0]!.world![0]).toBeCloseTo(after[0], 6);
  expect(errors).toEqual([]);
});

test('@angle the drag ends once from pointercancel, and once from a second pointer', async ({
  page,
}) => {
  await openScene(page);
  const { layerId } = await toolScene(page, [{ id: 'c1', position: [0, 2.5, 0] }]);
  await arm(page, { layerId, mode: 'select' });
  const [cx, cy] = at(0, 0);

  // -- exit 2: `pointercancel` (and the window `blur` bound to the same handler) ------------------
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy);
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
  });
  await settle(page);
  await page.mouse.up();
  await settle(page);
  expect(
    (await eventsOf(page)).filter((e) => e.kind === 'dragEnd'),
    'cancel ends it, and the up that follows does not end it again'
  ).toHaveLength(1);

  // -- exit 3: a second pointer lands mid-drag and the gesture becomes a pinch --------------------
  await page.evaluate(() => {
    (window as unknown as { __toolEvents: unknown[] }).__toolEvents.length = 0;
  });
  const after = (await pointsOf(page, layerId))[0]!.position;
  await page.mouse.move(...at(after[0], after[2]));
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 10);
  await page.evaluate(
    ([x, y]) => {
      const canvas = document.querySelector('canvas')!;
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 2,
          button: 0,
          buttons: 1,
          clientX: r.left + (x as number),
          clientY: r.top + (y as number),
          bubbles: true,
        })
      );
    },
    [cx + 120, cy] as const
  );
  await settle(page);
  await page.mouse.up();
  await settle(page);
  expect(
    (await eventsOf(page)).filter((e) => e.kind === 'dragEnd'),
    'the second finger ends the drag, and the release does not end it twice'
  ).toHaveLength(1);
});

// ===============================================================================================
// the presses the tool must NOT take (§7.5's reserved modifiers, and a gesture already in flight)
// ===============================================================================================

test('@angle Shift+press over a contact is the layer opacity and NOTHING else', async ({
  page,
}) => {
  const errors = await openScene(page);
  const { layerId } = await toolScene(page, [{ id: 'c1', position: [0, 2.5, 0] }]);
  // §7.5's `Shift`+drag acts on the **active** layer; make it the points layer and start below 1,
  // because dragging up raises opacity and 1 has nowhere to go.
  await page.evaluate(async (id) => {
    const engine = window.__tvxEngine!;
    engine.setActiveLayer(id as never);
    engine.updateLayer(id as never, { opacity: 0.5 } as never);
    await engine.whenSettled();
  }, layerId);
  await arm(page, { layerId, mode: 'select' });

  const [cx, cy] = at(0, 0);
  const cursor0 = await page.evaluate(() => [...window.__tvxEngine!.scene.cursor] as Vec3);

  // The press lands squarely on the 40 px disc — the case the tool would have taken.
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(cx, cy - 100, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await settle(page);

  // The gesture §7.5 promises ran, and it ran alone: 100 px up of 768 is 100/768 of opacity.
  const opacity = await page.evaluate(
    (id) => window.__tvxEngine!.scene.layers.find((l) => l.id === id)!.opacity,
    layerId
  );
  expect(opacity).toBeCloseTo(0.5 + 100 / PANE, 6);
  // …and the tool never saw the press: no selection, no event, and the crosshair did not jump onto
  // the contact — which is what re-cut all three panes mid-opacity-drag before this gate existed.
  expect(await selectionOf(page)).toBeNull();
  expect(await eventsOf(page)).toEqual([]);
  expect(await page.evaluate(() => [...window.__tvxEngine!.scene.cursor] as Vec3)).toEqual(cursor0);
  expect(errors).toEqual([]);
});

test('@angle space+press in place mode pans the pane and places nothing', async ({ page }) => {
  const errors = await openScene(page);
  const { layerId } = await toolScene(page, []);
  await arm(page, { layerId, mode: 'place' });
  const cam0 = await page.evaluate(() => {
    const v = window.__tvxEngine!.views.find((view) => view.id === 'coronal') as {
      camera: { center: [number, number]; mmPerPx: number };
    };
    return { center: [...v.camera.center] as [number, number], mmPerPx: v.camera.mmPerPx };
  });

  await page.mouse.move(...at(0, 0));
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(at(0, 0)[0] + 50, at(0, 0)[1] - 20, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await settle(page);

  // R3's pan happened, by the pixels the pointer travelled…
  const cam1 = await page.evaluate(() => {
    const v = window.__tvxEngine!.views.find((view) => view.id === 'coronal') as {
      camera: { center: [number, number] };
    };
    return [...v.camera.center] as [number, number];
  });
  expect(cam1[0]).toBeCloseTo(cam0.center[0] - 50 * cam0.mmPerPx, 6);
  expect(cam1[1]).toBeCloseTo(cam0.center[1] - 20 * cam0.mmPerPx, 6);
  // …and `place` placed nothing: a trackpad user can pan while the tool is armed.
  expect(await pointsOf(page, layerId)).toEqual([]);
  expect(await eventsOf(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('@angle a platform-modified click neither places nor selects', async ({ page }) => {
  await openScene(page);
  const { layerId } = await toolScene(page, [{ id: 'c1', position: [0, 2.5, 0] }]);

  // `resolveGesture` calls a `⌘`/`Ctrl`+left press "not a drag" — a menu accelerator, or macOS's
  // own right-click emulation. It is not a tool click either, in either mode.
  await arm(page, { layerId, mode: 'place' });
  await page.keyboard.down('Control');
  await clickAt(page, ...at(4, 4));
  await page.keyboard.up('Control');
  expect(await pointsOf(page, layerId)).toHaveLength(1);

  await arm(page, { layerId, mode: 'select' });
  await page.keyboard.down('Meta');
  await clickAt(page, ...at(0, 0));
  await page.keyboard.up('Meta');
  expect(await selectionOf(page)).toBeNull();
  expect((await eventsOf(page)).filter((e) => e.kind !== 'cleared')).toEqual([]);
});

test('@angle a second pointer mid-drag commits the FIRST contact, and grabs nothing', async ({
  page,
}) => {
  const errors = await openScene(page);
  const { layerId } = await toolScene(page, [
    { id: 'c1', position: [0, 2.5, 0] },
    { id: 'c2', position: [6, 2.5, 0] },
  ]);
  await arm(page, { layerId, mode: 'select' });
  const [cx, cy] = at(0, 0);

  // Grab `c1` and drag it 40 px right — it is now 2 mm from where it started and still 4 mm short
  // of `c2`, so the two discs do not overlap and the second finger lands on `c2` alone.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 4 });
  await settle(page);
  const moved = (await pointsOf(page, layerId))[0]!.position;

  await page.evaluate(
    ([x, y]) => {
      const canvas = document.querySelector('canvas')!;
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 2,
          button: 0,
          buttons: 1,
          clientX: r.left + (x as number),
          clientY: r.top + (y as number),
          bubbles: true,
        })
      );
    },
    at(6, 0) as [number, number]
  );
  await settle(page);
  await page.mouse.up();
  await settle(page);

  const events = await eventsOf(page);
  const ends = events.filter((e) => e.kind === 'dragEnd');
  expect(ends, 'the second finger ends the drag exactly once').toHaveLength(1);
  // The whole of the bug: the end must name the contact the drag was about. The second finger used
  // to select `c2` and overwrite the drag first, so `dragEnd` arrived for a point that had not
  // moved and the module's moved-comparison skipped the commit — no undo step, no dirty mark.
  expect(ends[0]!.pointId, 'the end is the dragged contact, not the one the finger landed on').toBe(
    'c1'
  );
  expect(ends[0]!.world![0]).toBeCloseTo(moved[0], 6);
  // …and `c2` was never selected: the press that landed mid-gesture was not the tool's.
  expect(events.filter((e) => e.kind === 'selected').map((e) => e.pointId)).toEqual(['c1']);
  expect(await selectionOf(page)).toEqual({ pointId: 'c1', index: 0 });
  expect(errors).toEqual([]);
});

// ===============================================================================================
// selection lifetime, Esc, and the one-armed-mode invariant
// ===============================================================================================

test('@angle the selection survives its array being replaced, and clears when its id goes', async ({
  page,
}) => {
  await openScene(page);
  const { layerId } = await toolScene(page, [
    { id: 'c1', position: [-5, 2.5, 5] },
    { id: 'c2', position: [5, 2.5, 5] },
  ]);
  await arm(page, { layerId, mode: 'select' });
  await clickAt(page, ...at(5, 5));
  expect(await selectionOf(page)).toEqual({ pointId: 'c2', index: 1 });

  // A module deletes the FIRST contact: the array is replaced and `c2` is now index 0.
  await page.evaluate(async (id) => {
    const engine = window.__tvxEngine!;
    engine.updateLayer(id, {
      points: [{ id: 'c2', position: [5, 2.5, 5] }],
    } as never);
    await engine.whenSettled();
  }, layerId);
  expect(
    await selectionOf(page),
    'the selection followed its id, it did not stay on index 1'
  ).toEqual({ pointId: 'c2', index: 0 });
  expect((await eventsOf(page)).filter((e) => e.kind === 'cleared')).toEqual([]);

  // Now `c2` itself goes: the selection is cleared, once, with an event that says so.
  await page.evaluate(async (id) => {
    const engine = window.__tvxEngine!;
    engine.updateLayer(id, { points: [{ id: 'c9', position: [0, 2.5, 0] }] } as never);
    await engine.whenSettled();
  }, layerId);
  expect(await selectionOf(page)).toBeNull();
  const cleared = (await eventsOf(page)).filter((e) => e.kind === 'cleared');
  expect(cleared).toHaveLength(1);
  expect(cleared[0]!.pointId).toBeNull();
  expect(cleared[0]!.index).toBe(-1);
});

test('@angle Esc walks place → select → off, wherever the pointer is', async ({ page }) => {
  await openScene(page);
  const { layerId } = await toolScene(page, [{ id: 'c1', position: [0, 2.5, 0] }]);
  await arm(page, { layerId, mode: 'place' });
  await clickAt(page, ...at(0, 0));
  expect(await selectionOf(page)).not.toBeNull();

  // The pointer is deliberately left off the canvas: this Esc is handled before the pointer layer's
  // "which pane are we over" test, which is what makes it work from the panel.
  await page.mouse.move(4, 4);
  await page.keyboard.press('Escape');
  await settle(page);
  expect(await page.evaluate(() => window.__tvxEngine!.pointTool()?.mode ?? null)).toBe('select');
  // Still armed, so a click still does not move the cursor onto a contact by accident.
  expect(await selectionOf(page), 'the first Esc left the selection alone').not.toBeNull();

  await page.keyboard.press('Escape');
  await settle(page);
  expect(await page.evaluate(() => window.__tvxEngine!.pointTool())).toBeNull();
  expect(await selectionOf(page)).toBeNull();
  expect((await eventsOf(page)).filter((e) => e.kind === 'cleared')).toHaveLength(1);

  // A third Esc is not the tool's any more, and the click that follows is R1's cursor gesture.
  const before = await page.evaluate(() => [...window.__tvxEngine!.scene.cursor] as Vec3);
  await page.keyboard.press('Escape');
  await clickAt(page, ...at(8, 8));
  expect(await page.evaluate(() => [...window.__tvxEngine!.scene.cursor] as Vec3)).not.toEqual(
    before
  );
});

test('@angle Esc mid-drag COMMITS the drag before it disarms', async ({ page }) => {
  const errors = await openScene(page);
  const { layerId } = await toolScene(page, [{ id: 'c1', position: [0, 2.5, 0] }]);
  await arm(page, { layerId, mode: 'select' });
  const [cx, cy] = at(0, 0);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy, { steps: 4 });
  await settle(page);
  const moved = (await pointsOf(page, layerId))[0]!.position;
  // Where the last pointer pixel addresses, half-pixel convention included — the drag is 3 mm from
  // where the contact started, which is what makes losing it a visible edit.
  expect(moved[0], 'the scene moved during the drag').toBeCloseTo(worldOfPixel(cx + 60, cy)[0], 6);

  // `Esc` is the documented `place` → `select` → off key and is deliberately not gated on a
  // gesture being in flight — so it lands here, with the button still down and the contact already
  // 3 mm from where it started.
  await page.keyboard.press('Escape');
  await settle(page);

  const kinds = (await eventsOf(page)).map((e) => e.kind);
  // The commit arrives, and it arrives BEFORE `cleared`: a host commits on `dragEnd` and resets on
  // `cleared`, and the other order would hand it the commit after it had thrown the base away.
  expect(kinds).toEqual(['selected', 'dragEnd', 'cleared']);
  const end = (await eventsOf(page)).find((e) => e.kind === 'dragEnd')!;
  expect(end.pointId).toBe('c1');
  expect(end.world![0]).toBeCloseTo(moved[0], 6);
  // Committed, not reverted: the contact is where the drag left it, which is what makes the exit
  // one of the two honest ones rather than half of each.
  expect((await pointsOf(page, layerId))[0]!.position).toEqual(moved);

  // The release that follows commits nothing a second time.
  await page.mouse.up();
  await settle(page);
  expect((await eventsOf(page)).filter((e) => e.kind === 'dragEnd')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('@angle at most one click-consuming mode is armed', async ({ page }) => {
  await openScene(page);
  const { layerId } = await toolScene(page, [{ id: 'c1', position: [0, 2.5, 0] }]);

  await page.evaluate(() => {
    window.__tvxEngine!.setMeasureMode(true);
  });
  await arm(page, { layerId, mode: 'place' });
  expect(
    await page.evaluate(() => window.__tvxEngine!.measureMode()),
    'arming the point tool disarmed measure mode'
  ).toBe(false);

  await page.evaluate(() => {
    window.__tvxEngine!.setMeasureMode(true);
  });
  await settle(page);
  expect(
    await page.evaluate(() => window.__tvxEngine!.pointTool()),
    'and measure mode disarms the point tool'
  ).toBeNull();

  // The proof that matters: a click now measures and does not place.
  await clickAt(page, ...at(3, 3));
  await clickAt(page, ...at(6, 3));
  expect(await pointsOf(page, layerId)).toHaveLength(1);
  expect(await page.evaluate(() => window.__tvxEngine!.scene.measurements.length)).toBe(1);
});

test('@angle the hover ring and the cursor follow the pointer, only while select is armed', async ({
  page,
}) => {
  await openScene(page);
  const { layerId } = await toolScene(page, [{ id: 'c1', position: [0, 2.5, 0] }]);
  const [cx, cy] = at(0, 0);
  const cursorStyle = async (): Promise<string> =>
    await page.evaluate(() => document.querySelector('canvas')!.style.cursor);
  const hot = async (): Promise<number | null> =>
    await page.evaluate(() => window.__tvxEngine!.pointHighlight().hot?.index ?? null);

  // Unarmed: the hover path does no hit test at all.
  await page.mouse.move(cx, cy);
  await settle(page);
  expect(await hot()).toBeNull();
  expect(await cursorStyle()).toBe('');

  await arm(page, { layerId, mode: 'select' });
  await page.mouse.move(cx + 1, cy);
  await settle(page);
  expect(await hot(), 'the pointer is over the disc').toBe(0);
  expect(await cursorStyle()).toBe('grab');

  // Off the disc — but still in the pane — the hot half clears and the cursor goes back.
  await page.mouse.move(cx + DISC_PX * 2, cy);
  await settle(page);
  expect(await hot()).toBeNull();
  expect(await cursorStyle()).toBe('');

  // Place mode has nothing to be over: crosshair, and no hit test.
  await arm(page, { layerId, mode: 'place' });
  await page.mouse.move(cx, cy);
  await settle(page);
  expect(await cursorStyle()).toBe('crosshair');
  expect(await hot()).toBeNull();
});

/**
 * Every distance from `(cx, cyTop)` at which `OverlayTheme.select` appears, over a box around it.
 *
 * A ring *is* a radius, so the test measures the radius instead of poking one pixel and trusting
 * the rasteriser — §11's scale-bar idiom.
 */
async function ringRadii(page: Page, cx: number, cyTop: number, half = 70): Promise<number[]> {
  const x0 = Math.round(cx - half);
  const y0 = Math.round(cyTop - half);
  const size = half * 2;
  const px = await readCanvasRect(page, x0, y0, size, size);
  const out: number[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      const hit =
        Math.abs((px[o] ?? 0) - SELECT_RGBA[0]) <= 1 &&
        Math.abs((px[o + 1] ?? 0) - SELECT_RGBA[1]) <= 1 &&
        Math.abs((px[o + 2] ?? 0) - SELECT_RGBA[2]) <= 1;
      if (hit) out.push(Math.hypot(x0 + x - cx, y0 + y - cyTop));
    }
  }
  return out;
}

// ===============================================================================================
// Real data — AGENTS rule 2's other half.
//
// The synthetic scene above is a tidy ruler: `mmPerPx = 0.05`, `camera.center = [0, 0]`, and a
// lattice whose bounds are small. A subject is none of those, and the two things that differ are
// exactly the two the hit test reads: the **fitted** `mmPerPx`, which is an arbitrary number here,
// and R3's in-plane **anchor**, which is the scene bbox centre and is nowhere near the cursor on a
// head. A hit test that quietly measured from the cursor instead passes every case above and misses
// every contact on `T1.nii.gz`.
// ===============================================================================================

const TESTDATA = process.env.TETRAVOX_TESTDATA ?? '';
const hasRealData = TESTDATA !== '' && existsSync(`${TESTDATA}/m2m_ernie/T1.nii.gz`);
const T1 = `/@fs${TESTDATA}/m2m_ernie/T1.nii.gz`;

test('@angle real data: the tool selects and drags at a fitted camera on T1.nii.gz', async ({
  page,
}) => {
  test.skip(!hasRealData, 'needs TETRAVOX_TESTDATA');
  test.setTimeout(120_000);
  const errors = await openScene(page);

  // One axial pane filling the canvas, fitted — so `mmPerPx` is whatever the subject's bounds make
  // it, and the camera is measured from R3's **anchor** rather than from the cursor.
  const cam = await page.evaluate(async (url) => {
    const engine = window.__tvxEngine!;
    const ds = await engine.addDataset({ kind: 'path', path: url as string });
    engine.addLayer({ datasetId: ds.id, kind: 'volume' });
    engine.setLayout({ kind: '1x1', cells: ['axial'] });
    engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
    engine.resetView('axial');
    const events: unknown[] = [];
    engine.on('pointTool', (e) => events.push(JSON.parse(JSON.stringify(e))));
    (window as unknown as { __toolEvents: unknown[] }).__toolEvents = events;
    await engine.whenSettled();
    const view = engine.views.find((v) => v.id === 'axial') as {
      camera: { mmPerPx: number; center: [number, number] };
    };
    const b = ds.bounds;
    return {
      mmPerPx: view.camera.mmPerPx,
      // Read back rather than assumed to be [0, 0]: `camera.center` is R3's in-plane offset FROM
      // the anchor, and the ruler below is wrong by it if the fit ever stops centring.
      center: [...view.camera.center] as [number, number],
      cursor: [...engine.scene.cursor] as Vec3,
      anchor: [0, 1, 2].map((k) => ((b.min[k] ?? 0) + (b.max[k] ?? 0)) / 2) as Vec3,
    };
  }, T1);

  // §3's axial basis in neurological: right = +X, up = +Y, normal = +Z. The world a pane pixel
  // addresses, written out from §11's pixel-centre convention rather than asked of the engine.
  const world = (px: number, py: number): Vec3 => [
    cam.anchor[0] + cam.center[0] + (px + 0.5 - PANE / 2) * cam.mmPerPx,
    cam.anchor[1] + cam.center[1] + (PANE / 2 - py - 0.5) * cam.mmPerPx,
    cam.cursor[2],
  ];

  // Three contacts at a 3.5 mm pitch along the pane's `right`, expressed as world points a pane
  // pixel names — so the fixture and the assertion are the same arithmetic read in two directions.
  const pitchPx = 3.5 / cam.mmPerPx;
  const centre: [number, number] = [PANE / 2, PANE / 2];
  const layerId = await page.evaluate(
    async ([positions]) => {
      const engine = window.__tvxEngine!;
      const ds = [...engine.scene.datasets.values()][0]!;
      const layer = engine.addLayer({
        datasetId: ds.id,
        kind: 'points',
        points: (positions as readonly Vec3[]).map((position, i) => ({ id: `c${i}`, position })),
        radiusMm: 1.5,
        color: [1, 0, 0, 1],
      });
      engine.setPointTool({ layerId: layer.id, mode: 'select' });
      await engine.whenSettled();
      return layer.id;
    },
    [
      [
        world(centre[0] - pitchPx, centre[1]),
        world(centre[0], centre[1]),
        world(centre[0] + pitchPx, centre[1]),
      ],
    ] as const
  );

  // The middle contact, clicked at the pixel the ruler says it is at.
  await clickAt(page, centre[0], centre[1]);
  expect(await selectionOf(page), 'the click found the contact at that pixel').toEqual({
    pointId: 'c1',
    index: 1,
  });

  // …and its neighbour 3.5 mm away is a different contact, not the same one grabbed twice.
  await clickAt(page, centre[0] + pitchPx, centre[1]);
  expect(await selectionOf(page)).toEqual({ pointId: 'c2', index: 2 });

  // The drag identity again, at this camera: between two pointer positions, so the press's own
  // sub-pixel offset cancels. The two clicks above were each a zero-length drag and each emitted
  // its own `dragEnd`, so the count below is about this drag alone.
  await page.evaluate(() => {
    (window as unknown as { __toolEvents: unknown[] }).__toolEvents.length = 0;
  });
  await page.mouse.move(centre[0] + pitchPx, centre[1]);
  await page.mouse.down();
  await page.mouse.move(centre[0] + pitchPx + 10, centre[1]);
  await settle(page);
  const p1 = (await pointsOf(page, layerId))[2]!.position;
  await page.mouse.move(centre[0] + pitchPx + 50, centre[1]);
  await settle(page);
  const p2 = (await pointsOf(page, layerId))[2]!.position;
  await page.mouse.up();
  await settle(page);

  expect(Math.abs(dist(p1, p2) - 40 * cam.mmPerPx)).toBeLessThan(0.05);
  expect(p2[0] - p1[0]).toBeCloseTo(40 * cam.mmPerPx, 6);
  // Still on the pane's plane: a contact dragged in a slice stays in that slice.
  expect(p2[2]).toBeCloseTo(cam.cursor[2], 6);
  expect((await eventsOf(page)).filter((e) => e.kind === 'dragEnd')).toHaveLength(1);
  expect(errors).toEqual([]);
});
