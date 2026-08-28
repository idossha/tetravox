/**
 * The §8 property editors for the `mesh`, `iso` and `points` layer kinds (A-PROPS, half 2).
 *
 * §8: "everything the UI can do must be reachable from the `Engine` API alone. No logic in React."
 * That rule turns into this file's whole assertion: **every control is one
 * §4.7 call, and this asserts the call and its arguments** — `Engine.updateLayer` is wrapped in the
 * page, the control is driven the way a user drives it, and the recorded patch is compared with what
 * the reducer promised. No pixels: the layer panel is DOM, and §11's rule 0 cuts the other way here.
 *
 * It runs against the **stand-in** engine (`?engine=mock`), like `shell.spec.ts`, so it needs no GPU
 * and no real file. The real-data half — the tissue table actually changing what the 3D pane paints
 * on `ernie.msh` — is `props-realdata.spec.ts`.
 */

/* eslint-disable no-empty-pattern */

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, packagedUnavailable } from './fixtures';
import type { LaunchOptions, LaunchTarget } from './fixtures';

/** One recorded `Engine.updateLayer(id, patch)`. */
interface Recorded {
  id: string;
  patch: Record<string, unknown>;
}

/** The recorder hangs off the engine object itself, so the spec needs no new global. */
type Recording = { __tvxPatches?: Recorded[] };

async function boot(
  target: LaunchTarget,
  options: LaunchOptions = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(target, { search: 'engine=mock&mockStepMs=0', ...options });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 1000);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  return { app, page };
}

/**
 * Drive a native control the way the user does. `fill()` refuses `input[type=range]` and would not
 * exercise `<select>` uniformly, and React tracks the DOM value itself — so set through the
 * prototype setter and dispatch, which is the only way the change reaches `onChange`.
 */
async function setControl(page: Page, testId: string, value: string): Promise<void> {
  await page.evaluate(
    ([id, v]) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (el === null) throw new Error(`no control [data-testid="${id}"]`);
      const proto =
        el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter === undefined) throw new Error('no value setter');
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [testId, value] as const
  );
}

/** Wrap `updateLayer`, and clear anything recorded so far. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const engine = window.__tetravox?.engine;
    if (engine == null) throw new Error('no engine');
    const store = engine as unknown as Recording;
    if (store.__tvxPatches === undefined) {
      const calls: Recorded[] = [];
      store.__tvxPatches = calls;
      const original = engine.updateLayer.bind(engine);
      engine.updateLayer = (id, patch) => {
        // Snapshot through JSON so the assertion sees the patch as it was handed over, not an
        // object the engine mutated afterwards — **per key**, because a whole-object round trip
        // drops the keys a clear sets to `undefined` (`{ isolate: undefined }` becomes `{}`, and the
        // difference between "cleared it" and "sent nothing" is the assertion). A cleared key is
        // recorded as `null`.
        const snapshot: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
          snapshot[key] =
            value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
        }
        calls.push({ id, patch: snapshot });
        original(id, patch);
      };
    }
    store.__tvxPatches.length = 0;
  });
}

async function patches(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => {
    const engine = window.__tetravox?.engine;
    if (engine == null) throw new Error('no engine');
    return [...((engine as unknown as Recording).__tvxPatches ?? [])];
  });
}

/** The one patch a control emitted. Exactly one — a control that fires twice is a bug. */
async function onePatch(page: Page): Promise<Record<string, unknown>> {
  const recorded = await patches(page);
  expect(recorded).toHaveLength(1);
  return (recorded[0] as Recorded).patch;
}

interface LayerIds {
  mesh: string;
  iso: string;
  points: string;
}

/** Open a mesh through the controller, then add an `iso` and a `points` layer through §4.7. */
async function openLayers(page: Page): Promise<LayerIds> {
  return page.evaluate(async () => {
    const tv = window.__tetravox;
    if (tv?.controller == null || tv.engine == null) throw new Error('no shell');
    const path = '/fixtures/ernie.msh';
    tv.controller.open([{ name: 'ernie.msh', path, source: { kind: 'path', path } }]);
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      if (tv.store.getState().layers.some((l) => l.kind === 'mesh')) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const state = tv.store.getState();
    const mesh = state.layers.find((l) => l.kind === 'mesh');
    const dataset = state.datasets[0];
    if (mesh === undefined || dataset === undefined) throw new Error('no mesh layer');

    // §4.4's other two kinds. The app has no UI that creates them yet (E-DERIVED's layers and
    // A-SHELL's open paths), so the E2E adds them through the facade, fully specified.
    const iso = tv.engine.addLayer({
      datasetId: dataset.id,
      kind: 'iso',
      name: 'iso',
      source: { datasetId: dataset.id, field: { source: 'elm', name: 'TI_max', component: 'mag' } },
      iso: 1,
      color: [1, 1, 1, 1],
      smooth: true,
      faceMode: 'cull',
    });
    const points = tv.engine.addLayer({
      datasetId: dataset.id,
      kind: 'points',
      name: 'eeg_positions.csv',
      points: [
        { name: 'Fp1', position: [-21.2, 66.9, 12.1] },
        { name: 'Cz', position: [0, -9.2, 100.2] },
      ],
      shape: 'sphere',
      radiusMm: 4,
      color: [0.2, 0.8, 1, 1],
      showLabels: false,
    });
    return { mesh: mesh.id, iso: iso.id, points: points.id };
  });
}

/** Open a collapsed `Section` (clip planes, isolation and glyphs start closed). */
async function openSection(page: Page, testId: string): Promise<void> {
  const section = page.locator(`[data-testid="${testId}"]`);
  if ((await section.getAttribute('data-open')) !== 'true') {
    await page.click(`[data-testid="${testId}-toggle"]`);
    await expect(section).toHaveAttribute('data-open', 'true');
  }
}

// ------------------------------------------------------------------------------------------------

test.describe('the mesh / iso / points property editors (§8)', () => {
  let app: ElectronApplication;
  let page: Page;
  let ids: LayerIds;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    ({ app, page } = await boot(target));
    ids = await openLayers(page);
    await expect(page.locator(`[data-testid="mesh-properties-${ids.mesh}"]`)).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  // ---- the tissue rows, in the ONE Region panel (§8, R5) ---------------------------------------
  //
  // The mesh editor used to mount two lists of the same thing: its own `TissueTable` and, under it,
  // a `RegionPanel` on the same `meshTag` source. Both listed every tissue twice over, because a
  // `.msh` carries a volume tag `t` (tets) and a surface tag `t + 1000` (tris) per tissue. There is
  // one list now, one row per tissue, and the two tags are the row's "Vol" / "Surf" toggles.

  test('ONE list, one row per tissue: the paired tags collapse (7 tags → 5 rows)', async () => {
    // The old `TissueTable` is gone, not hidden.
    await expect(page.locator(`[data-testid="mesh-tissue-list-${ids.mesh}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid^="mesh-tag-row-${ids.mesh}-"]`)).toHaveCount(0);

    const panel = page.locator(`[data-testid="region-panel-${ids.mesh}"]`);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-kind', 'meshTag');

    const tags = await page.evaluate((layerId: string) => {
      const state = window.__tetravox?.store.getState();
      const layer = state?.layers.find((l) => l.id === layerId);
      const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
      if (ds?.kind !== 'mesh') throw new Error('no mesh dataset');
      return ds.tags.map((t) => t.id);
    }, ids.mesh);
    expect(tags).toEqual([1, 2, 3, 5, 101, 1002, 1101]);

    await expect(page.locator(`[data-testid="region-list-${ids.mesh}"]`)).toHaveAttribute(
      'data-rows',
      '5'
    );
    // Grey matter's two tags are one row, named once, and the row is the **volume** tag's id.
    await expect(page.locator(`[data-testid="region-row-${ids.mesh}-1002"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="region-name-${ids.mesh}-2"]`)).toHaveText(
      'Grey matter'
    );
    // Every row has R5's controls: colour, name, count — plus the two per-half toggles.
    await expect(page.locator(`[data-testid="region-color-${ids.mesh}-1"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="region-opacity-${ids.mesh}-1"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="region-vol-${ids.mesh}-2"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="region-surf-${ids.mesh}-2"]`)).toBeVisible();
  });

  test('the header counts tissues, not tags', async () => {
    const header = page.locator(`[data-testid="region-panel-${ids.mesh}"] >> text=Tissues`);
    await expect(header).toHaveText('Tissues (5)');
  });

  test('a tag with no partner renders with only the toggle it has', async () => {
    // White matter is tet-only in the stand-in, so "Surf" is there and disabled rather than absent —
    // §8 forbids a control that silently does nothing, and an absent one would shift the columns.
    const surf = page.locator(`[data-testid="region-surf-${ids.mesh}-1"]`);
    await expect(surf).toBeDisabled();
    await expect(surf).toHaveAttribute('title', /no surface \(tri\) tag/);
    await expect(page.locator(`[data-testid="region-vol-${ids.mesh}-1"]`)).toBeEnabled();
  });

  test('the "Surf" toggle hides EXACTLY its own tag, and "Vol" the other', async () => {
    await record(page);
    await page.click(`[data-testid="region-surf-${ids.mesh}-2"]`);
    const patch = await onePatch(page);
    expect(Object.keys(patch)).toEqual(['tagStyle']);
    const tagStyle = patch.tagStyle as Record<string, { visible: boolean }>;
    expect(tagStyle['1002']?.visible).toBe(false);
    expect(tagStyle['2']?.visible).toBe(true);
    // The row still reads visible — half of the tissue is still on screen.
    await expect(page.locator(`[data-testid="region-row-${ids.mesh}-2"]`)).toHaveAttribute(
      'data-visible',
      'true'
    );
    await expect(page.locator(`[data-testid="region-surf-${ids.mesh}-2"]`)).toHaveAttribute(
      'data-visible',
      'false'
    );
    await page.click(`[data-testid="region-surf-${ids.mesh}-2"]`);
  });

  test('the row eye moves BOTH tags of the tissue', async () => {
    await record(page);
    await page.click(`[data-testid="region-eye-${ids.mesh}-2"]`);
    const tagStyle = (await onePatch(page)).tagStyle as Record<string, { visible: boolean }>;
    expect(tagStyle['2']?.visible).toBe(false);
    expect(tagStyle['1002']?.visible).toBe(false);
    expect(tagStyle['1']?.visible).toBe(true);
    await page.click(`[data-testid="region-eye-${ids.mesh}-2"]`);
  });

  test('Alt-click solos the ROW, so both of its tags survive (R5)', async () => {
    await record(page);
    // The gesture must not move the panel under the cursor. `LayerRow` focuses itself on
    // `pointerdown`, and that `<li>` is the whole layer — taller than `layer-list`'s viewport once
    // the editor is open — so a focus that is allowed to scroll lands between `pointerdown` and
    // `click` and the solo arrives on a different row, or on none.
    const scrollTop = async (): Promise<number> =>
      page.evaluate(
        () => (document.querySelector('[data-testid="layer-list"]') as HTMLElement).scrollTop
      );
    const before = await scrollTop();
    await page.click(`[data-testid="region-name-${ids.mesh}-2"]`, { modifiers: ['Alt'] });
    expect(await scrollTop()).toBe(before);
    const solo = (await onePatch(page)).tagStyle as Record<string, { visible: boolean }>;
    expect(
      Object.entries(solo)
        .filter(([, v]) => v.visible)
        .map(([t]) => Number(t))
        .sort((a, b) => a - b)
    ).toEqual([2, 1002]);
    await expect(page.locator(`[data-testid="region-row-${ids.mesh}-2"]`)).toHaveAttribute(
      'data-selected',
      'true'
    );
    await page.click(`[data-testid="region-showAll-${ids.mesh}"]`);
  });

  test('Show all / Hide all / Invert act on rows and reach every tag (R5)', async () => {
    await record(page);
    await page.click(`[data-testid="region-hideAll-${ids.mesh}"]`);
    const none = (await onePatch(page)).tagStyle as Record<string, { visible: boolean }>;
    expect(Object.keys(none).length).toBe(7);
    expect(Object.values(none).every((v) => !v.visible)).toBe(true);

    await record(page);
    await page.click(`[data-testid="region-invert-${ids.mesh}"]`);
    const inverted = (await onePatch(page)).tagStyle as Record<string, { visible: boolean }>;
    expect(Object.values(inverted).every((v) => v.visible)).toBe(true);

    await record(page);
    await page.click(`[data-testid="region-showAll-${ids.mesh}"]`);
    const all = (await onePatch(page)).tagStyle as Record<string, { visible: boolean }>;
    expect(Object.values(all).every((v) => v.visible)).toBe(true);
  });

  test('search filters the rows without touching the engine', async () => {
    await record(page);
    await page.locator(`[data-testid="region-search-${ids.mesh}"]`).fill('grey');
    await expect(page.locator(`[data-testid="region-list-${ids.mesh}"]`)).toHaveAttribute(
      'data-rows',
      '1'
    );
    expect(await patches(page)).toHaveLength(0);
    await page.locator(`[data-testid="region-search-${ids.mesh}"]`).fill('');
    await expect(page.locator(`[data-testid="region-list-${ids.mesh}"]`)).toHaveAttribute(
      'data-rows',
      '5'
    );
  });

  test('one swatch recolours BOTH tags of the tissue, and the reset drops both (R5)', async () => {
    await record(page);
    await setControl(page, `region-color-${ids.mesh}-2`, '#ff8000');
    const tagStyle = (await onePatch(page)).tagStyle as Record<string, { color?: number[] }>;
    // §4.1: 0..1 floats in the engine, exact 8-bit values through the picker.
    expect(tagStyle['2']?.color).toEqual([1, 128 / 255, 0, 1]);
    expect(tagStyle['1002']?.color).toEqual([1, 128 / 255, 0, 1]);
    expect(tagStyle['1']?.color).toBeUndefined();

    await record(page);
    await page.click(`[data-testid="region-color-reset-${ids.mesh}-2"]`);
    const reset = (await onePatch(page)).tagStyle as Record<string, { color?: number[] }>;
    expect(reset['2']?.color).toBeUndefined();
    expect(reset['1002']?.color).toBeUndefined();
  });

  test('the opacity slider fades both halves of the tissue at once', async () => {
    await record(page);
    await setControl(page, `region-opacity-${ids.mesh}-2`, '0.35');
    const tagStyle = (await onePatch(page)).tagStyle as Record<string, { opacity: number }>;
    expect(tagStyle['2']?.opacity).toBeCloseTo(0.35, 6);
    expect(tagStyle['1002']?.opacity).toBeCloseTo(0.35, 6);
    await setControl(page, `region-opacity-${ids.mesh}-2`, '1');
  });

  // ---- the field selector ----------------------------------------------------------------------

  test('the field selector emits the field, and re-seeds the scale from its stats', async () => {
    await record(page);
    await setControl(page, `mesh-fieldname-${ids.mesh}`, 'elm:TI_max');
    const patch = await onePatch(page);
    expect(patch.colorMode).toBe('field');
    expect(patch.field).toEqual({ source: 'elm', name: 'TI_max', component: 'mag' });
    const scale = patch.scale as { kind: string; lo: number; hi: number };
    expect(scale.kind).toBe('linear');
    expect(scale.hi).toBeCloseTo(10.293712064403254, 6);
  });

  test('an element field is an async load with a progress state, not an instant checkbox (§7.4)', async () => {
    // The stand-in settles immediately, so the badge is asserted through the store the moment the
    // control fires: what is being pinned is that the switch goes through `patchLayerAsync` at all.
    const seen = await page.evaluate(async (layerId: string) => {
      const tv = window.__tetravox;
      if (tv?.controller == null) throw new Error('no controller');
      let pending: string[] = [];
      const stop = tv.store.subscribe((s) => {
        const now = s.meshPending[layerId] ?? [];
        if (now.length > 0) pending = now;
      });
      await tv.controller.patchLayerAsync(
        layerId,
        { edges: { surface: true, caps: false } },
        'edges'
      );
      stop();
      return { pending, after: tv.store.getState().meshPending[layerId] ?? [] };
    }, ids.mesh);
    expect(seen.pending).toEqual(['edges']);
    expect(seen.after).toEqual([]);
    await expect(page.locator(`[data-testid="mesh-edges-surface-${ids.mesh}"]`)).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  test('colormap, scale, threshold and shading are each one call', async () => {
    const cases: {
      control: string;
      value: string;
      expect: (p: Record<string, unknown>) => void;
    }[] = [
      {
        control: `mesh-colormap-${ids.mesh}`,
        value: 'inferno',
        expect: (p) => expect(p).toEqual({ colormap: 'inferno' }),
      },
      {
        control: `mesh-scalekind-${ids.mesh}`,
        value: 'heat',
        expect: (p) =>
          expect(p.scale).toMatchObject({ kind: 'heat', truncate: false, negative: 'mirror' }),
      },
      {
        control: `mesh-scale-mid-${ids.mesh}`,
        value: '3',
        expect: (p) => expect(p.scale).toMatchObject({ kind: 'heat', mid: 3 }),
      },
      {
        control: `mesh-threshold-soft-${ids.mesh}`,
        value: '0.5',
        expect: (p) => expect(p.threshold).toMatchObject({ softEdge: 0.5 }),
      },
      {
        control: `mesh-edge-width-${ids.mesh}`,
        value: '2.5',
        expect: (p) => expect(p).toEqual({ edgeWidthPx: 2.5 }),
      },
    ];
    for (const item of cases) {
      await record(page);
      await setControl(page, item.control, item.value);
      item.expect(await onePatch(page));
    }

    await record(page);
    await page.click(`[data-testid="mesh-threshold-symmetric-${ids.mesh}"]`);
    expect((await onePatch(page)).threshold).toMatchObject({ symmetric: true });

    await record(page);
    await page.click(`[data-testid="mesh-flat-${ids.mesh}"]`);
    expect(await onePatch(page)).toEqual({ flatShading: true });
  });

  // ---- R4: the 2D cross-section ----------------------------------------------------------------

  test('R4: fill and contours are independent toggles, and the cut colour is one call', async () => {
    await record(page);
    await page.click(`[data-testid="mesh-fill2d-${ids.mesh}"]`);
    expect(await onePatch(page)).toEqual({ fillIn2D: true });

    await record(page);
    await page.click(`[data-testid="mesh-contours2d-${ids.mesh}"]`);
    expect(await onePatch(page)).toEqual({ contoursIn2D: true });
    await expect(page.locator(`[data-testid="mesh-cut2d-state-${ids.mesh}"]`)).toHaveText('on');

    await record(page);
    await setControl(page, `mesh-contour-width-${ids.mesh}`, '3');
    expect(await onePatch(page)).toEqual({ contourWidthPx: 3 });

    // "Which field colours the cut" is the layer's own colour source (§7.4 draws the cut with
    // tag/field colour), so `tag` is `colorMode: 'tag'` and a field is the field patch.
    await record(page);
    await setControl(page, `mesh-cut-color-${ids.mesh}`, 'tag');
    expect(await onePatch(page)).toEqual({ colorMode: 'tag' });

    await record(page);
    await setControl(page, `mesh-cut-color-${ids.mesh}`, 'elm:E');
    const byField = await onePatch(page);
    expect(byField.colorMode).toBe('field');
    expect(byField.field).toMatchObject({ source: 'elm', name: 'E' });
  });

  /**
   * Directed task 12: the contour's **own** colour and width, each one `updateLayer` call.
   *
   * The width control already existed and is asserted above; what is new is that the two of them
   * are the pair a user reaches for when two outlines are hard to tell apart, so they are asserted
   * together — including that the swatch shows what the contour actually draws in, which for a
   * layer with no `contourColor` of its own is its `edgeColor` (`render/passes/derived.ts`'s
   * fallback). A swatch that showed something else would be a lie the moment it was opened.
   */
  test('the contour colour and width are one `updateLayer` call each', async () => {
    const swatch = page.locator(`[data-testid="mesh-contour-color-${ids.mesh}"]`);
    await expect(swatch).toHaveCount(1);

    const shown = await swatch.inputValue();
    const layer = await page.evaluate(
      (id) =>
        (window.__tetravox?.store.getState().layers ?? []).find((l) => l.id === id) as unknown as {
          contourColor?: number[];
          edgeColor: number[];
        },
      ids.mesh
    );
    const hex = (c: number[]): string =>
      `#${c
        .slice(0, 3)
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, '0')
        )
        .join('')}`;
    expect(shown).toBe(hex(layer.contourColor ?? layer.edgeColor));

    await record(page);
    await setControl(page, `mesh-contour-color-${ids.mesh}`, '#ffe626');
    const painted = (await onePatch(page)).contourColor as number[];
    // `state.ts` divides by 255 and keeps the alpha; 0xff/0xe6/0x26 is 1 / 0.902 / 0.149.
    expect(painted[0]).toBeCloseTo(1, 3);
    expect(painted[1]).toBeCloseTo(0xe6 / 255, 3);
    expect(painted[2]).toBeCloseTo(0x26 / 255, 3);
    expect(painted[3]).toBe(1);

    // The width the brief names as the surface default is inside the slider's range, and is one
    // call like every other control here.
    await record(page);
    await setControl(page, `mesh-contour-width-${ids.mesh}`, '1.5');
    expect(await onePatch(page)).toEqual({ contourWidthPx: 1.5 });
  });

  // ---- clip planes -----------------------------------------------------------------------------

  test('a clip plane: add, preset, offset, flip, follow-cursor, caps, remove', async () => {
    await openSection(page, `mesh-clip-${ids.mesh}`);

    await record(page);
    await page.click(`[data-testid="mesh-clip-add-${ids.mesh}"]`);
    const added = (await onePatch(page)).clip as {
      planes: { plane: { normal: number[]; offset: number }; enabled: boolean }[];
    };
    expect(added.planes).toHaveLength(1);
    expect(added.planes[0]?.plane.normal).toEqual([0, 0, 1]);
    expect(added.planes[0]?.enabled).toBe(true);

    await record(page);
    await page.click(`[data-testid="mesh-clip-preset-${ids.mesh}-0-sagittal"]`);
    const sagittal = (await onePatch(page)).clip as { planes: { plane: { normal: number[] } }[] };
    // §3's sagittal normal, the same one the sagittal pane uses.
    expect(sagittal.planes[0]?.plane.normal).toEqual([-1, 0, 0]);

    await record(page);
    await setControl(page, `mesh-clip-offset-${ids.mesh}-0`, '20');
    const moved = (await onePatch(page)).clip as { planes: { plane: { offset: number } }[] };
    expect(moved.planes[0]?.plane.offset).toBe(20);

    await record(page);
    await page.click(`[data-testid="mesh-clip-flip-${ids.mesh}-0"]`);
    const flipped = (await onePatch(page)).clip as {
      planes: { plane: { normal: number[]; offset: number } }[];
    };
    // Flip keeps the plane where it is: `n → −n` **and** `offset → −offset`. (The recorder round
    // trips through JSON, which folds the `−0`s of `−[−1, 0, 0]` back to `0`; the reducer's own test
    // asserts the unfolded value.)
    expect(flipped.planes[0]?.plane.normal).toEqual([1, 0, 0]);
    expect(flipped.planes[0]?.plane.offset).toBe(-20);

    // Follow-cursor: the plane's offset is re-derived from the cursor on every `cursor` event.
    await page.click(`[data-testid="mesh-clip-follow-${ids.mesh}-0"]`);
    await expect(page.locator(`[data-testid="mesh-clip-plane-${ids.mesh}-0"]`)).toHaveAttribute(
      'data-follows-cursor',
      'true'
    );
    const offset = await page.evaluate((layerId: string) => {
      const tv = window.__tetravox;
      if (tv?.engine == null) throw new Error('no engine');
      tv.engine.setCursor([12, 34, 56]);
      const layer = tv.store.getState().layers.find((l) => l.id === layerId);
      return layer?.kind === 'mesh' ? (layer.clip.planes[0]?.plane.offset ?? null) : null;
    }, ids.mesh);
    // n = +X after the flip ⇒ `offset = −dot(n, cursor) = −12`.
    expect(offset).toBe(-12);
    await page.click(`[data-testid="mesh-clip-follow-${ids.mesh}-0"]`);

    await record(page);
    await setControl(page, `mesh-clip-capcolor-${ids.mesh}`, 'tag');
    expect((await onePatch(page)).clip).toMatchObject({ capColorMode: 'tag' });

    await record(page);
    await page.click(`[data-testid="mesh-clip-remove-${ids.mesh}-0"]`);
    const removed = (await onePatch(page)).clip as { planes: unknown[] };
    expect(removed.planes).toHaveLength(0);
  });

  // ---- isolation -------------------------------------------------------------------------------

  test('isolation: tags, a sphere from the cursor, a box, and clear', async () => {
    await openSection(page, `mesh-isolate-${ids.mesh}`);

    await record(page);
    await page.click(`[data-testid="mesh-isolate-tag-${ids.mesh}-2"]`);
    const tags = (await onePatch(page)).isolate as { tags: number[]; combine: string };
    expect(tags).toMatchObject({ tags: [2], combine: 'all' });

    await record(page);
    await page.click(`[data-testid="mesh-isolate-sphere-${ids.mesh}"]`);
    const sphere = (await onePatch(page)).isolate as {
      sphere: { center: number[]; radius: number };
    };
    // §8: the centre comes from the cursor, which the clip test left at (12, 34, 56).
    expect(sphere.sphere).toEqual({ center: [12, 34, 56], radius: 10 });

    await record(page);
    await page.click(`[data-testid="mesh-isolate-box-${ids.mesh}"]`);
    const box = (await onePatch(page)).isolate as { box: { min: number[]; max: number[] } };
    expect(box.box).toEqual({ min: [2, 24, 46], max: [22, 44, 66] });

    await record(page);
    await setControl(page, `mesh-isolate-combine-${ids.mesh}`, 'any');
    expect((await onePatch(page)).isolate).toMatchObject({ combine: 'any' });

    await record(page);
    await page.click(`[data-testid="mesh-isolate-clear-${ids.mesh}"]`);
    expect(await onePatch(page)).toEqual({ isolate: null });
  });

  // ---- glyphs ----------------------------------------------------------------------------------

  test('glyphs: enable picks the vector field, then field / stride / scale / length / colour', async () => {
    await openSection(page, `mesh-glyphs-${ids.mesh}`);

    await record(page);
    await page.click(`[data-testid="mesh-glyphs-enabled-${ids.mesh}"]`);
    const enabled = (await onePatch(page)).glyphs as {
      field: { name: string };
      subsample: { everyNth: number };
      scale: { mode: string; lengthMm: number; normalizeTo: string };
    };
    // Only a vector field can drive a glyph; the stand-in's `E` is the ncomp-3 one.
    expect(enabled.field.name).toBe('E');
    // Directed task 7's defaults: linear, normalised to the field's p99, 6 mm. `docs/DECISIONS.md`
    // 2026-08-28 has the measurement that rules out normalising to the maximum.
    expect(enabled.scale).toMatchObject({ mode: 'linear', normalizeTo: 'p99', lengthMm: 6 });

    await record(page);
    await setControl(page, `mesh-glyph-stride-${ids.mesh}`, '25');
    expect((await onePatch(page)).glyphs).toMatchObject({ subsample: { everyNth: 25 } });

    // §4.4's default is `'surface'`, and it is written as *absent* — a selector showing "surface"
    // over an undefined field is what keeps every scene on disk meaning what it meant.
    expect(enabled).not.toHaveProperty('origins');
    await expect(page.locator(`[data-testid="mesh-glyph-origins-${ids.mesh}"]`)).toHaveValue(
      'surface'
    );

    // §6.5.2's `meshCentroids`: the one control that changes *which table* the origins come from.
    await record(page);
    await setControl(page, `mesh-glyph-origins-${ids.mesh}`, 'volume');
    expect((await onePatch(page)).glyphs).toMatchObject({ origins: 'volume' });

    // The four modes, and the reference they are measured against, are two controls (§4.4's
    // `GlyphScaling`). Changing one must leave the other alone.
    await record(page);
    await setControl(page, `mesh-glyph-scale-${ids.mesh}`, 'log');
    expect((await onePatch(page)).glyphs).toMatchObject({
      scale: { mode: 'log', normalizeTo: 'p99', lengthMm: 6 },
    });

    await record(page);
    await setControl(page, `mesh-glyph-normalize-${ids.mesh}`, 'max');
    expect((await onePatch(page)).glyphs).toMatchObject({
      scale: { mode: 'log', normalizeTo: 'max' },
    });

    // `log` has no zero, so its floor is its own control — and it only exists in `log`.
    await record(page);
    await setControl(page, `mesh-glyph-logfloor-${ids.mesh}`, '0.25');
    expect((await onePatch(page)).glyphs).toMatchObject({ scale: { logFloor: 0.25 } });

    // The length is written in **both** places: `scale.lengthMm` is what the renderer reads, and the
    // top-level `lengthMm` is what a scene saved before 2026-08-28 carries.
    await record(page);
    await setControl(page, `mesh-glyph-length-${ids.mesh}`, '7.5');
    expect((await onePatch(page)).glyphs).toMatchObject({
      lengthMm: 7.5,
      scale: { lengthMm: 7.5 },
    });

    await record(page);
    await setControl(page, `mesh-glyph-head-${ids.mesh}`, '0.5');
    expect((await onePatch(page)).glyphs).toMatchObject({ headProportion: 0.5 });

    await record(page);
    await setControl(page, `mesh-glyph-color-${ids.mesh}`, '#00ff00');
    expect((await onePatch(page)).glyphs).toMatchObject({ color: [0, 1, 0, 1] });

    // "To cut plane" restricts the origins to a slab about the layer's **first enabled clip plane**,
    // and with none enabled there is no plane to restrict to — so the control is disabled with the
    // reason attached rather than writing a state whose only rendering is the same picture (§8, the
    // same treatment `origins` gets on a mesh with no tets).
    await expect(page.locator(`[data-testid="mesh-glyph-cliptocut-${ids.mesh}"]`)).toBeDisabled();

    await record(page);
    await page.click(`[data-testid="mesh-glyphs-enabled-${ids.mesh}"]`);
    expect(await onePatch(page)).toEqual({ glyphs: null });
  });

  // ---- the iso editor --------------------------------------------------------------------------

  test('the iso editor: level, colour, opacity, smooth, faceMode', async () => {
    const panel = page.locator(`[data-testid="iso-properties-${ids.iso}"]`);
    await expect(panel).toBeVisible();

    await record(page);
    await setControl(page, `iso-level-exact-${ids.iso}`, '2.5');
    expect(await onePatch(page)).toEqual({ iso: 2.5 });

    await record(page);
    await setControl(page, `iso-color-${ids.iso}`, '#ff0000');
    expect(await onePatch(page)).toEqual({ color: [1, 0, 0, 1] });

    await record(page);
    await setControl(page, `iso-opacity-${ids.iso}`, '0.5');
    expect(await onePatch(page)).toEqual({ opacity: 0.5 });

    await record(page);
    await page.click(`[data-testid="iso-smooth-${ids.iso}"]`);
    expect(await onePatch(page)).toEqual({ smooth: false });

    await record(page);
    await page.click(`[data-testid="iso-facemode-${ids.iso}"]`);
    expect(await onePatch(page)).toEqual({ faceMode: 'both' });
  });

  // ---- the points editor -----------------------------------------------------------------------

  test('the points editor: source, radius, colour, labels, and one point at a time', async () => {
    await expect(page.locator(`[data-testid="points-source-${ids.points}"]`)).toContainText(
      '2 points'
    );

    await record(page);
    await setControl(page, `points-radius-${ids.points}`, '6.5');
    expect(await onePatch(page)).toEqual({ radiusMm: 6.5 });

    await record(page);
    await setControl(page, `points-color-${ids.points}`, '#0000ff');
    expect(await onePatch(page)).toEqual({ color: [0, 0, 1, 1] });

    await record(page);
    await page.click(`[data-testid="points-labels-${ids.points}"]`);
    expect(await onePatch(page)).toEqual({ showLabels: true });

    await record(page);
    await setControl(page, `points-row-color-${ids.points}-0`, '#ffffff');
    const perPoint = (await onePatch(page)).points as { name: string; color?: number[] }[];
    expect(perPoint[0]).toMatchObject({ name: 'Fp1', color: [1, 1, 1, 1] });
    expect(perPoint[1]?.color).toBeUndefined();
    await expect(page.locator(`[data-testid="points-row-${ids.points}-0"]`)).toHaveAttribute(
      'data-overridden',
      'true'
    );

    // "Go to" is `Engine.setCursor`, so the whole shell follows it — including the info panel.
    await page.click(`[data-testid="points-row-goto-${ids.points}-1"]`);
    const cursor = await page.evaluate(() => window.__tetravox?.store.getState().cursor);
    expect(cursor).toEqual([0, -9.2, 100.2]);
  });
});
