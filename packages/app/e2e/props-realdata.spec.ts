/**
 * The tissue rows against the **real** engine and the **real** mesh (A-PROPS, half 2).
 *
 * The real-data gate items for this area:
 *
 * > The tissue table on `ernie.msh` shows all ten tissue names from `ernie.msh.opt` (the file has
 * > **no** `$PhysicalNames`; the sidecar is the only source).
 * > App e2e: the tissue table drives the engine (a tag toggled off in the table is a tag the scene
 * > reports hidden), on ernie.
 *
 * and the mesh half of **R5**'s gate: *hiding a region removes its colour from the pane while the
 * others are unchanged.* So this asserts three things a DOM test alone cannot: the names really came
 * off the sidecar, the click really reached `Engine.updateLayer`, and the **3D pane really changed**
 * — pixels sampled through `Engine.readPixel`, with the background bytes asserted **identical** and
 * the whole image asserted byte-identical again once the tag is shown back.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 */

/* eslint-disable no-empty-pattern */

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const ERNIE = join(ROOT, 'm2m_ernie', 'ernie.msh');

/** The ten tissue names `ernie.msh.opt` carries — AGENTS.md's per-tag census. */
const TISSUES = [
  'WM',
  'GM',
  'CSF',
  'Scalp',
  'Eye_balls',
  'Compact_bone',
  'Spongy_bone',
  'Blood',
  'Muscle',
] as const;

/** An 11 × 11 grid over the pane: enough to see a tissue disappear, cheap enough to read back. */
const GRID = 11;

interface Sample {
  x: number;
  y: number;
  rgba: number[];
}

test.describe('the tissue rows on ernie.msh (real data)', () => {
  let app: ElectronApplication;
  let page: Page;
  let layerId: string;

  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    test.setTimeout(300_000);
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=real' });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });

    // Open `ernie.msh` with its `.msh.opt` sidecar, exactly as the Open dialog does. Without the
    // sidecar the §6.2 tag ladder falls through to the deterministic palette and the tissue table
    // would show "tag 1005" rather than "Scalp" — which is the first thing this file asserts.
    layerId = await page.evaluate(async (path: string) => {
      const tv = window.__tetravox;
      if (tv?.controller == null || tv.engine == null) throw new Error('no shell');
      const allowed = await window.tetravox.allowPath(path);
      if (allowed === null) throw new Error(`main refused ${path}`);
      const opt = await window.tetravox.allowPath(`${allowed.path}.opt`);
      const name = allowed.path.split('/').pop() ?? allowed.path;
      tv.controller.open([
        {
          name,
          path: allowed.path,
          source: {
            kind: 'path',
            path: allowed.path,
            ...(opt === null ? {} : { sidecars: { opt: opt.path } }),
          },
        },
      ]);
      const started = Date.now();
      while (Date.now() - started < 240_000) {
        const mesh = tv.store.getState().layers.find((l) => l.kind === 'mesh');
        if (mesh !== undefined) return mesh.id;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('ernie.msh never landed');
    }, ERNIE);

    // One big 3D pane. The canvas size is **not** set by hand here: `ViewGrid`'s `ResizeObserver`
    // owns the drawing buffer, and a buffer that disagrees with the pane rect the engine last laid
    // out makes `readPixel` read outside it — which comes back as `0,0,0,0` and looks like a
    // rendering bug rather than a measuring one.
    await page.evaluate(async () => {
      const engine = window.__tetravox?.engine;
      if (engine == null) throw new Error('no engine');
      engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
      await engine.whenSettled();
      engine.renderNow();
      await engine.whenSettled();
    });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('19 tags become 10 rows: one per tissue, named from ernie.msh.opt', async () => {
    // AGENTS.md's per-tag census: tri 1001–1010 + 1099, tet 1–10 with **no tag 4** — 19 tags for
    // ten tissues, because a `.msh` carries each tissue as a volume tag and a surface tag with the
    // same `.msh.opt` name. The editor used to list all 19, twice over (its own tissue table *and*
    // a Region panel under it). One list, one row per tissue, is what this pins.
    const tags = await page.evaluate((id: string) => {
      const state = window.__tetravox?.store.getState();
      const layer = state?.layers.find((l) => l.id === id);
      const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
      if (ds?.kind !== 'mesh') throw new Error('no mesh dataset');
      return ds.tags.map((t) => ({ id: t.id, kind: t.kind }));
    }, layerId);
    expect(tags).toHaveLength(19);

    await expect(page.getByTestId(`region-panel-${layerId}`)).toHaveAttribute(
      'data-kind',
      'meshTag'
    );
    await expect(page.getByTestId(`region-list-${layerId}`)).toHaveAttribute('data-rows', '10');
    // The old second list is gone entirely, not merely collapsed.
    await expect(page.locator(`[data-testid="mesh-tissue-list-${layerId}"]`)).toHaveCount(0);

    // The rows are the **volume** tag ids plus the one tri tag with no volume half.
    const ids = await page
      .locator(`[data-testid^="region-row-${layerId}-"]`)
      .evaluateAll((els) =>
        els.map((el) => Number((el.getAttribute('data-testid') ?? '').split('-').pop()))
      );
    expect(ids).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 1099]);
    // §7.6 / AGENTS.md: tag 4 does not exist in ernie, so a table built from `1..10` is wrong.
    expect(ids).not.toContain(4);

    const names = await page.locator(`[data-testid^="region-name-${layerId}-"]`).allInnerTexts();
    for (const tissue of TISSUES) {
      expect(names, `${tissue} is missing from the tissue rows`).toContain(tissue);
    }
    // Each name appears **once** now — that was the whole complaint.
    for (const tissue of TISSUES) {
      expect(names.filter((n) => n === tissue)).toHaveLength(1);
    }
    expect(names.some((n) => /^Tag \d+$/.test(n))).toBe(false);

    // Scalp's row carries both halves, with AGENTS.md's exact element counts on the hovers.
    await expect(page.getByTestId(`region-vol-${layerId}-5`)).toHaveAttribute(
      'title',
      '5 · 567,089 tets'
    );
    await expect(page.getByTestId(`region-surf-${layerId}-5`)).toHaveAttribute(
      'title',
      '1005 · 77,032 tris'
    );
    // …and the count column is their sum, compact enough for a 300 px panel, with the exact
    // figures on the hover rather than pushed off the row.
    await expect(page.getByTestId(`region-tally-${layerId}-5`)).toHaveText(
      new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
        567_089 + 77_032
      )
    );

    // `1099 Internal_air_surface` has no volume half — the row renders with only "Surf" live.
    await expect(page.getByTestId(`region-surf-${layerId}-1099`)).toBeEnabled();
    await expect(page.getByTestId(`region-vol-${layerId}-1099`)).toBeDisabled();
    console.log(`[props] ernie.msh: ${tags.length} tags → ${ids.length} tissue rows`);
  });

  test('the "Surf" toggle on the Scalp row hides EXACTLY tag 1005', async () => {
    await page.getByTestId(`region-surf-${layerId}-5`).click();
    const style = await page.evaluate((id: string) => {
      const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
      if (layer?.kind !== 'mesh') throw new Error('no mesh layer');
      const out: Record<number, boolean> = {};
      for (const tag of [1, 2, 3, 5, 1002, 1005, 1099]) {
        out[tag] = layer.tagStyle[tag]?.visible ?? true;
      }
      return out;
    }, layerId);
    // The surface tag alone. The tets of the same tissue, and every other tissue, are untouched.
    expect(style[1005]).toBe(false);
    expect(style[5]).toBe(true);
    expect(style[1002]).toBe(true);
    expect(style[1099]).toBe(true);
    // The row is still "visible": half the tissue is still drawn.
    await expect(page.getByTestId(`region-row-${layerId}-5`)).toHaveAttribute(
      'data-visible',
      'true'
    );
    await page.getByTestId(`region-surf-${layerId}-5`).click();
  });

  test('Alt-click solo leaves BOTH tags of one tissue visible, and nothing else', async () => {
    await page.getByTestId(`region-name-${layerId}-5`).click({ modifiers: ['Alt'] });
    const visible = await page.evaluate((id: string) => {
      const state = window.__tetravox?.store.getState();
      const layer = state?.layers.find((l) => l.id === id);
      const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
      if (layer?.kind !== 'mesh' || ds?.kind !== 'mesh') throw new Error('no mesh');
      return ds.tags.filter((t) => layer.tagStyle[t.id]?.visible ?? true).map((t) => t.id);
    }, layerId);
    expect([...visible].sort((a, b) => a - b)).toEqual([5, 1005]);
    await page.getByTestId(`region-showAll-${layerId}`).click();
  });

  test('one swatch recolours BOTH of a tissue’s tags', async () => {
    const setSwatch = async (hex: string): Promise<void> =>
      page.evaluate(
        ([id, value]: [string, string]) => {
          const el = document.querySelector(`[data-testid="region-color-${id}-5"]`);
          if (el === null) throw new Error('no colour swatch');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        [layerId, hex] as [string, string]
      );

    const colors = async (): Promise<{ vol: number[] | null; surf: number[] | null }> =>
      page.evaluate((id: string) => {
        const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
        if (layer?.kind !== 'mesh') throw new Error('no mesh layer');
        return {
          vol: layer.tagStyle[5]?.color ?? null,
          surf: layer.tagStyle[1005]?.color ?? null,
        };
      }, layerId);

    expect(await colors()).toEqual({ vol: null, surf: null });
    await setSwatch('#ff00ff');
    // §4.1: the picker's exact 8-bit value arrives as 0..1 floats, on **both** tags at once.
    expect(await colors()).toEqual({ vol: [1, 0, 1, 1], surf: [1, 0, 1, 1] });

    // …and the row's Reset drops both overrides, so `ernie.msh.opt`'s own colour comes back.
    // The sidecar paints Scalp 255,166,133 (AGENTS.md), which is what the dataset still holds.
    const file = await page.evaluate((id: string) => {
      const state = window.__tetravox?.store.getState();
      const layer = state?.layers.find((l) => l.id === id);
      const ds = state?.datasets.find((d) => d.id === layer?.datasetId);
      if (ds?.kind !== 'mesh') throw new Error('no mesh dataset');
      return ds.tags.find((t) => t.id === 5)?.color ?? null;
    }, layerId);
    expect(file?.map((c) => Math.round(c * 255))).toEqual([255, 166, 133, 255]);

    await page.getByTestId(`region-color-reset-${layerId}-5`).click();
    expect(await colors()).toEqual({ vol: null, surf: null });
  });

  test('hiding Scalp in the table changes the 3D pane, and showing it back restores it exactly', async () => {
    test.setTimeout(180_000);

    /** Read a GRID × GRID lattice of pixels out of the 3D pane through §4.7's `readPixel`. */
    const sample = async (): Promise<Sample[]> =>
      page.evaluate((grid: number) => {
        const engine = window.__tetravox?.engine;
        if (engine == null) throw new Error('no engine');
        engine.renderNow();
        const out: { x: number; y: number; rgba: number[] }[] = [];
        const canvas = document.querySelector('canvas');
        // Pane-relative CSS pixels, which is what §4.7's `readPixel` takes.
        const w = canvas?.clientWidth ?? 0;
        const h = canvas?.clientHeight ?? 0;
        if (w === 0 || h === 0) throw new Error('the view grid has no box');
        for (let i = 1; i <= grid; i += 1) {
          for (let j = 1; j <= grid; j += 1) {
            const x = Math.round((i * w) / (grid + 1));
            const y = Math.round((j * h) / (grid + 1));
            out.push({ x, y, rgba: [...engine.readPixel('view3d', x, y)] });
          }
        }
        return out;
      }, GRID);

    /** Every tag the sidecar calls Scalp — ernie carries it as tri 1005 and tet 5. */
    const scalpTags = await page.evaluate((id: string) => {
      const tv = window.__tetravox;
      const state = tv?.store.getState();
      const layer = state?.layers.find((l) => l.id === id);
      const dataset = state?.datasets.find((d) => d.id === layer?.datasetId);
      if (dataset?.kind !== 'mesh') throw new Error('no mesh dataset');
      return dataset.tags.filter((t) => /scalp/i.test(t.name ?? '')).map((t) => t.id);
    }, layerId);
    expect(scalpTags.length).toBeGreaterThan(0);

    const before = await sample();
    const background = await page.evaluate(() =>
      [...(window.__tetravox?.engine?.scene.background ?? [])].map((c) => Math.round(c * 255))
    );
    // "Background" is the cleared frame — or an untouched pixel, which is how a mis-measured read
    // would show up, and which must never be counted as covered.
    const isBackground = (s: Sample): boolean =>
      s.rgba[3] === 0 || s.rgba.every((c, i) => Math.abs(c - (background[i] ?? 0)) <= 1);
    const covered = before.filter((s) => !isBackground(s));
    // Phase-1 gate 2 rendered ernie's tag surfaces over a quarter of the pane; anything less than
    // this and the assertion below would be measuring the background.
    expect(covered.length / before.length).toBeGreaterThan(0.2);

    // Hide Scalp **through the panel**, with the row's eye — which is one click for the tissue now,
    // not one per tag, because the row is the tissue and carries both of its tags.
    await page.getByTestId(`region-eye-${layerId}-5`).click();
    await expect(page.getByTestId(`region-row-${layerId}-5`)).toHaveAttribute(
      'data-visible',
      'false'
    );

    // The scene — not the panel — reports the tags hidden: the click reached `Engine.updateLayer`.
    const hidden = await page.evaluate(
      ([id, tags]: [string, number[]]) => {
        const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
        if (layer?.kind !== 'mesh') throw new Error('no mesh layer');
        return tags.map((t) => layer.tagStyle[t]?.visible ?? true);
      },
      [layerId, scalpTags] as [string, number[]]
    );
    expect(hidden.every((v) => v === false)).toBe(true);

    await page.evaluate(async () => {
      await window.__tetravox?.engine?.whenSettled();
    });
    const after = await sample();

    // R5's gate, on the mesh: the tissue's pixels change, and the pixels that were never it do not.
    let changed = 0;
    for (const [i, b] of before.entries()) {
      const a = after[i] as Sample;
      const differs = b.rgba.some((c, k) => Math.abs(c - (a.rgba[k] ?? 0)) > 8);
      if (differs) changed += 1;
      // Scalp is the outermost surface: a pixel that was background can only stay background.
      if (isBackground(b)) expect(a.rgba, `background moved at ${b.x},${b.y}`).toEqual(b.rgba);
    }
    console.log(
      `[props] hiding Scalp (tags ${scalpTags.join(', ')}): ${changed}/${before.length} sampled ` +
        `pixels changed, ${covered.length}/${before.length} were covered`
    );
    // Scalp is what the camera sees first, so most covered samples must move.
    expect(changed).toBeGreaterThan(covered.length * 0.5);

    // Showing it back restores the frame **byte for byte** — the row's state is the whole state.
    await page.getByTestId(`region-eye-${layerId}-5`).click();
    await page.evaluate(async () => {
      await window.__tetravox?.engine?.whenSettled();
    });
    const restored = await sample();
    for (const [i, b] of before.entries()) {
      expect((restored[i] as Sample).rgba, `pixel ${b.x},${b.y} did not come back`).toEqual(b.rgba);
    }
  });

  test('the row’s opacity slider reaches the scene as `tagStyle` on both halves', async () => {
    // GM is tet 2 + tri 1002 on ernie; the 3D pane draws the tri half, §7.2's per-tag sub-draws
    // give each half its own opacity, and one slider is meant to set them together.
    await page.evaluate((id: string) => {
      const el = document.querySelector(`[data-testid="region-opacity-${id}-2"]`);
      if (el === null) throw new Error('no opacity slider');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, '0.35');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, layerId);

    const style = await page.evaluate((id: string) => {
      const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
      if (layer?.kind !== 'mesh') throw new Error('no mesh layer');
      return { vol: layer.tagStyle[2], surf: layer.tagStyle[1002] };
    }, layerId);
    expect(style.vol?.opacity).toBeCloseTo(0.35, 5);
    expect(style.surf?.opacity).toBeCloseTo(0.35, 5);
    expect(style.vol?.visible).toBe(true);
    expect(style.surf?.visible).toBe(true);
  });
});
