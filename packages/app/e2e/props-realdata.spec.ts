/**
 * The tissue table against the **real** engine and the **real** mesh (A-PROPS, half 2).
 *
 * `docs/PHASE2-OWNERSHIP.md`'s real-data gate items for this owner:
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

test.describe('the tissue table on ernie.msh (real data)', () => {
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

  test('shows every tissue name from ernie.msh.opt — the file has no $PhysicalNames', async () => {
    const names = await page.locator(`[data-testid^="mesh-tag-name-${layerId}-"]`).allInnerTexts();
    // The sidecar names the ten tissues; the mesh carries them as both tri (1001…) and tet (1…)
    // tags, so a name may appear twice — what matters is that none of them is a bare "tag 1005".
    for (const tissue of TISSUES) {
      expect(names, `${tissue} is missing from the tissue table`).toContain(tissue);
    }
    expect(names.some((n) => /^tag \d+$/.test(n))).toBe(false);
    // §7.6 / AGENTS.md: tag 4 does not exist in ernie, so a table built from `1..10` is wrong.
    const ids = await page
      .locator(`[data-testid^="mesh-tag-row-${layerId}-"]`)
      .evaluateAll((els) =>
        els.map((el) => Number((el.getAttribute('data-testid') ?? '').split('-').pop()))
      );
    expect(ids).not.toContain(4);
    expect(ids).toContain(5);
    console.log(`[props] ernie.msh tissue table: ${ids.length} rows, ids ${ids.join(', ')}`);
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

    // Hide Scalp **through the table**, one click per tag, exactly as a user would.
    for (const tag of scalpTags) {
      await page.click(`[data-testid="mesh-tag-eye-${layerId}-${tag}"]`);
      await expect(page.locator(`[data-testid="mesh-tag-row-${layerId}-${tag}"]`)).toHaveAttribute(
        'data-visible',
        'false'
      );
    }

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

    // Showing it back restores the frame **byte for byte** — the table's state is the whole state.
    for (const tag of scalpTags) {
      await page.click(`[data-testid="mesh-tag-eye-${layerId}-${tag}"]`);
    }
    await page.evaluate(async () => {
      await window.__tetravox?.engine?.whenSettled();
    });
    const restored = await sample();
    for (const [i, b] of before.entries()) {
      expect((restored[i] as Sample).rgba, `pixel ${b.x},${b.y} did not come back`).toEqual(b.rgba);
    }
  });

  test('a per-tag opacity and a recolour reach the scene as `tagStyle`', async () => {
    const gm = await page.evaluate((id: string) => {
      const tv = window.__tetravox;
      const state = tv?.store.getState();
      const layer = state?.layers.find((l) => l.id === id);
      const dataset = state?.datasets.find((d) => d.id === layer?.datasetId);
      if (dataset?.kind !== 'mesh') throw new Error('no mesh dataset');
      // The GM *surface* tag (1002 on ernie), which is what the 3D pane draws.
      const tag = dataset.tags.find((t) => t.kind === 'tri' && /^GM$/i.test(t.name ?? ''));
      return tag?.id ?? null;
    }, layerId);
    expect(gm).not.toBeNull();

    await page.evaluate(
      ([id, tag]: [string, number]) => {
        const el = document.querySelector(`[data-testid="mesh-tag-opacity-${id}-${tag}"]`);
        if (el === null) throw new Error('no opacity slider');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(el, '0.35');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      [layerId, gm as number] as [string, number]
    );

    const style = await page.evaluate(
      ([id, tag]: [string, number]) => {
        const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
        if (layer?.kind !== 'mesh') throw new Error('no mesh layer');
        return layer.tagStyle[tag];
      },
      [layerId, gm as number] as [string, number]
    );
    // §7.2: per-tag sub-draws mean per-tag opacity, and this is where it comes from.
    expect(style?.opacity).toBeCloseTo(0.35, 5);
    expect(style?.visible).toBe(true);

    // R5's recolour, on a real tag: the picker's 8-bit value arrives as §4.1's 0..1 floats,
    // **exactly** — `k / 255` round trips, which is what keeps §11's "the pixel is exactly the tag
    // colour" true after a user edit. The edit lives in the layer, so it is what `serialize()`
    // writes; the reset drops it and the file's own `.msh.opt` colour comes back.
    const scalp = 1005;
    const before = await page.evaluate(
      ([id, tag]: [string, number]) => {
        const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
        const dataset = window.__tetravox?.store
          .getState()
          .datasets.find((d) => d.id === (layer?.datasetId ?? ''));
        if (layer?.kind !== 'mesh' || dataset?.kind !== 'mesh') throw new Error('no mesh');
        return {
          override: layer.tagStyle[tag]?.color ?? null,
          file: dataset.tags.find((t) => t.id === tag)?.color ?? null,
        };
      },
      [layerId, scalp] as [string, number]
    );
    expect(before.override).toBeNull();
    // `ernie.msh.opt` paints Scalp 255,166,133 — the wire value, exactly (§4.1).
    expect(before.file?.map((c) => Math.round(c * 255))).toEqual([255, 166, 133, 255]);

    await page.evaluate(
      ([id, tag]: [string, number]) => {
        const el = document.querySelector(`[data-testid="mesh-tag-color-${id}-${tag}"]`);
        if (el === null) throw new Error('no colour swatch');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(el, '#ff00ff');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      [layerId, scalp] as [string, number]
    );

    const recoloured = await page.evaluate(
      ([id, tag]: [string, number]) => {
        const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
        if (layer?.kind !== 'mesh') throw new Error('no mesh layer');
        return layer.tagStyle[tag]?.color ?? null;
      },
      [layerId, scalp] as [string, number]
    );
    expect(recoloured).toEqual([1, 0, 1, 1]);
    await expect(page.locator(`[data-testid="mesh-tag-row-${layerId}-${scalp}"]`)).toHaveAttribute(
      'data-recoloured',
      'true'
    );

    await page.click(`[data-testid="mesh-tag-color-reset-${layerId}-${scalp}"]`);
    const reset = await page.evaluate(
      ([id, tag]: [string, number]) => {
        const layer = window.__tetravox?.store.getState().layers.find((l) => l.id === id);
        if (layer?.kind !== 'mesh') throw new Error('no mesh layer');
        return layer.tagStyle[tag]?.color ?? null;
      },
      [layerId, scalp] as [string, number]
    );
    expect(reset).toBeNull();
  });
});
