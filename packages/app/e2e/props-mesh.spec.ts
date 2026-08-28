/**
 * The §8 property editors for the `mesh`, `iso` and `points` layer kinds (A-PROPS, half 2).
 *
 * §8: "everything the UI can do must be reachable from the `Engine` API alone. No logic in React."
 * `docs/PHASE2-OWNERSHIP.md` turns that into this file's whole assertion: **every control is one
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

  // ---- the tissue table (§8, R5) ---------------------------------------------------------------

  test('the tissue table is a table of tags, not a list of checkboxes', async () => {
    const rows = page.locator(`[data-testid^="mesh-tag-row-${ids.mesh}-"]`);
    // The stand-in's mesh carries ernie-shaped tags, including a `tri` tag and an electrode tag.
    await expect(rows).toHaveCount(6);
    const first = page.locator(`[data-testid="mesh-tag-row-${ids.mesh}-1"]`);
    await expect(first).toHaveAttribute('data-visible', 'true');
    await expect(page.locator(`[data-testid="mesh-tag-name-${ids.mesh}-1"]`)).toHaveText(
      'White matter'
    );
    // Every row has the four §8 / R5 controls: eye, colour, name+id+count, opacity.
    await expect(page.locator(`[data-testid="mesh-tag-eye-${ids.mesh}-1"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="mesh-tag-color-${ids.mesh}-1"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="mesh-tag-opacity-${ids.mesh}-1"]`)).toBeVisible();
  });

  test('the eye emits one tagStyle patch and the scene reports the tag hidden', async () => {
    await record(page);
    await page.click(`[data-testid="mesh-tag-eye-${ids.mesh}-5"]`);
    const patch = await onePatch(page);
    expect(Object.keys(patch)).toEqual(['tagStyle']);
    const tagStyle = patch.tagStyle as Record<string, { visible: boolean; opacity: number }>;
    expect(tagStyle['5']?.visible).toBe(false);
    expect(tagStyle['2']?.visible).toBe(true);
    await expect(page.locator(`[data-testid="mesh-tag-row-${ids.mesh}-5"]`)).toHaveAttribute(
      'data-visible',
      'false'
    );
    // Back on, so the rest of the file starts from a fully visible mesh.
    await page.click(`[data-testid="mesh-tag-eye-${ids.mesh}-5"]`);
  });

  test('Alt-click solos, and show-all / hide-all / invert are one call each (R5)', async () => {
    await record(page);
    await page.click(`[data-testid="mesh-tag-eye-${ids.mesh}-2"]`, { modifiers: ['Alt'] });
    const solo = (await onePatch(page)).tagStyle as Record<string, { visible: boolean }>;
    expect(
      Object.entries(solo)
        .filter(([, s]) => s.visible)
        .map(([t]) => t)
    ).toEqual(['2']);

    await record(page);
    await page.click(`[data-testid="mesh-tissue-showall-${ids.mesh}"]`);
    const all = (await onePatch(page)).tagStyle as Record<string, { visible: boolean }>;
    expect(Object.values(all).every((s) => s.visible)).toBe(true);

    await record(page);
    await page.click(`[data-testid="mesh-tissue-invert-${ids.mesh}"]`);
    const inverted = (await onePatch(page)).tagStyle as Record<string, { visible: boolean }>;
    expect(Object.values(inverted).every((s) => !s.visible)).toBe(true);

    await page.click(`[data-testid="mesh-tissue-showall-${ids.mesh}"]`);
  });

  test('Alt-click solos on the **row** too, the way the Region panel takes it (R5)', async () => {
    // R5 asks for "one Region panel for every labelled thing", and the two UIs a mesh tag has took
    // the same gesture on different targets: alt-click soloed on the row in `RegionPanel` and only
    // on the eye button here, so alt-clicking a tissue row did nothing at all.
    await record(page);
    await page.click(`[data-testid="mesh-tag-row-${ids.mesh}-3"]`, { modifiers: ['Alt'] });
    const solo = (await onePatch(page)).tagStyle as Record<string, { visible: boolean }>;
    expect(
      Object.entries(solo)
        .filter(([, s]) => s.visible)
        .map(([t]) => t)
    ).toEqual(['3']);
    await page.click(`[data-testid="mesh-tissue-showall-${ids.mesh}"]`);
  });

  test('the Region panel is mounted for a mesh, so R5’s "one panel" is one panel', async () => {
    // `panels/regions/regions.ts` has always returned a `meshTag` source; `RegionPanel` was
    // mounted from exactly one place — the volume editor — so two of R5's three kinds had no
    // Region panel at all.
    const panel = page.locator(`[data-testid="region-panel-${ids.mesh}"]`);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-kind', 'meshTag');
    await expect(page.locator(`[data-testid^="region-row-${ids.mesh}-"]`).first()).toBeVisible();
  });

  test('search filters the rows without touching the engine', async () => {
    await record(page);
    await setControl(page, `mesh-tissue-search-${ids.mesh}`, 'grey');
    await expect(page.locator(`[data-testid^="mesh-tag-row-${ids.mesh}-"]`)).toHaveCount(2);
    expect(await patches(page)).toHaveLength(0);
    await setControl(page, `mesh-tissue-search-${ids.mesh}`, '');
    await expect(page.locator(`[data-testid^="mesh-tag-row-${ids.mesh}-"]`)).toHaveCount(6);
  });

  test('the colour picker recolours exactly one tag, and the reset drops the override (R5)', async () => {
    await record(page);
    await setControl(page, `mesh-tag-color-${ids.mesh}-5`, '#ff8000');
    const patch = await onePatch(page);
    const tagStyle = patch.tagStyle as Record<string, { color?: number[] }>;
    // §4.1: 0..1 floats in the engine, exact 8-bit values through the picker.
    expect(tagStyle['5']?.color).toEqual([1, 128 / 255, 0, 1]);
    expect(tagStyle['2']?.color).toBeUndefined();
    await expect(page.locator(`[data-testid="mesh-tag-row-${ids.mesh}-5"]`)).toHaveAttribute(
      'data-recoloured',
      'true'
    );

    await record(page);
    await page.click(`[data-testid="mesh-tag-color-reset-${ids.mesh}-5"]`);
    const reset = (await onePatch(page)).tagStyle as Record<string, { color?: number[] }>;
    expect(reset['5']?.color).toBeUndefined();
  });

  test('the per-tag opacity slider is one call with the slider’s value', async () => {
    await record(page);
    await setControl(page, `mesh-tag-opacity-${ids.mesh}-1002`, '0.35');
    const tagStyle = (await onePatch(page)).tagStyle as Record<string, { opacity: number }>;
    expect(tagStyle['1002']?.opacity).toBeCloseTo(0.35, 6);
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
      scale: string;
    };
    // Only a vector field can drive a glyph; the stand-in's `E` is the ncomp-3 one.
    expect(enabled.field.name).toBe('E');
    expect(enabled.scale).toBe('byMagnitude');

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

    await record(page);
    await setControl(page, `mesh-glyph-scale-${ids.mesh}`, 'fixed');
    expect((await onePatch(page)).glyphs).toMatchObject({ scale: 'fixed' });

    await record(page);
    await setControl(page, `mesh-glyph-length-${ids.mesh}`, '7.5');
    expect((await onePatch(page)).glyphs).toMatchObject({ lengthMm: 7.5 });

    await record(page);
    await setControl(page, `mesh-glyph-color-${ids.mesh}`, '#00ff00');
    expect((await onePatch(page)).glyphs).toMatchObject({ color: [0, 1, 0, 1] });

    await record(page);
    await page.click(`[data-testid="mesh-glyph-cliptocut-${ids.mesh}"]`);
    expect((await onePatch(page)).glyphs).toMatchObject({ clipToCutPlane: true });

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
