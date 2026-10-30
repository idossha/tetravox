/**
 * One mesh, several fields: switching fields changes the colour bar's title and range, and each
 * field comes back with the colormap, window and threshold it was left with (§4.4 `MeshLayer.fields`,
 * §8). Dated 2026-10-30.
 *
 * Against the **real** engine, because the colour bar is the engine's (`meshColorbarScale` is what
 * §7.2's overlay pass draws from). The fixture is committed — `testdata/mesh_multifield.msh`, three
 * element fields with non-overlapping ranges — and every expected range is read from
 * `testdata/manifest.json`, whose numbers are `simnibs.mesh_io.read_msh` reading the file back
 * (`python3 scripts/gen-fixtures.py`), never the writer. The per-field reducer itself is unit-tested
 * in `panels/layers/mesh/state.test.ts`; this proves the chips, the engine and the bar agree.
 *
 * Evidence PNG (not a golden — the bar's pixels are §11's existing colorbar goldens):
 * `test-results/shots/multifield-hf_sar.png`.
 */

/* eslint-disable no-empty-pattern */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, SHOTS_DIR, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const MESH = join(TESTDATA, 'mesh_multifield.msh');

interface FieldRecord {
  name: string;
  stats: { min: number; max: number };
}
const MANIFEST = JSON.parse(readFileSync(join(TESTDATA, 'manifest.json'), 'utf8')) as {
  msh: Record<string, { fields: FieldRecord[] }>;
};
const FIELDS = MANIFEST.msh['mesh_multifield.msh']?.fields ?? [];
const range = (name: string): { min: number; max: number } => {
  const f = FIELDS.find((r) => r.name === name);
  if (f === undefined) throw new Error(`manifest has no ${name}`);
  return f.stats;
};

interface Bar {
  title: string;
  units?: string;
  lo: number;
  hi: number;
  colormap: string;
  threshold: { lo: number | null; hi: number | null };
}

/** The engine's own colour-bar description for the layer — what the overlay pass draws. */
async function bar(page: Page, id: string): Promise<Bar | null> {
  return page.evaluate((layerId) => {
    const engine = window.__tetravox?.engine as unknown as {
      meshColorbarScale(id: string): {
        title: string;
        units?: string;
        lo: number;
        hi: number;
        colormap: string;
        threshold: { lo: number; hi: number };
      } | null;
    };
    const s = engine.meshColorbarScale(layerId);
    if (s === null) return null;
    const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);
    return {
      title: s.title,
      ...(s.units === undefined ? {} : { units: s.units }),
      lo: s.lo,
      hi: s.hi,
      colormap: s.colormap,
      threshold: { lo: finite(s.threshold.lo), hi: finite(s.threshold.hi) },
    };
  }, id);
}

/** Drive a native control the way a user does — React tracks the DOM value itself. */
async function setControl(page: Page, testId: string, value: string): Promise<void> {
  const control = page.getByTestId(testId);
  if ((await control.getAttribute('type')) === 'number') {
    await control.fill(value);
    await control.blur();
    return;
  }
  await page.evaluate(
    ([tid, v]) => {
      const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLSelectElement | null;
      if (el === null) throw new Error(`no control [data-testid="${tid}"]`);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [testId, value] as const
  );
}

const chip = (id: string, name: string): string => `mesh-fieldname-${id}-elm:${name}`;

test.describe('one mesh, several fields (§4.4)', () => {
  let app: ElectronApplication;
  let page: Page;
  let id: string;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    test.setTimeout(180_000);
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=real' });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
    id = await page.evaluate(async (path: string) => {
      const tv = window.__tetravox;
      if (tv?.controller == null) throw new Error('no shell');
      const allowed = await window.tetravox.allowPath(path);
      if (allowed === null) throw new Error(`main refused ${path}`);
      tv.controller.open([
        {
          name: 'mesh_multifield.msh',
          path: allowed.path,
          source: { kind: 'path', path: allowed.path },
        },
      ]);
      const started = Date.now();
      while (Date.now() - started < 60_000) {
        const layer = tv.store.getState().layers.find((l) => l.kind === 'mesh');
        if (layer !== undefined) return layer.id;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('no mesh layer');
    }, MESH);
    await page.click(`[data-testid="layer-row-${id}"]`).catch(() => {
      /* already active */
    });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('has fields to check', () => {
    expect(FIELDS.map((f) => f.name).sort()).toEqual(['TI_max', 'hf_peak', 'hf_sar']);
  });

  test('a handful of fields are chips, the active one pressed, and the bar is its range', async () => {
    await setControl(page, `mesh-colormode-${id}`, 'field');
    for (const f of FIELDS) await expect(page.getByTestId(chip(id, f.name))).toBeVisible();
    await expect(page.getByTestId(chip(id, 'TI_max'))).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId(chip(id, 'hf_sar'))).toHaveAttribute('aria-checked', 'false');
    const ti = range('TI_max');
    await expect.poll(() => bar(page, id)).toMatchObject({ title: 'TI_max' });
    const b = (await bar(page, id)) as Bar;
    expect(b.lo).toBeCloseTo(ti.min, 4);
    expect(b.hi).toBeCloseTo(ti.max, 4);
    // A `.msh` carries no units, and none is invented.
    expect(b.units).toBeUndefined();
  });

  test('each field keeps its own colormap, window and threshold across a switch', async () => {
    await setControl(page, `mesh-colormap-${id}`, 'hot');
    await setControl(page, `mesh-scale-lo-${id}`, '0.2');
    await setControl(page, `mesh-scale-hi-${id}`, '0.8');
    await page.getByTestId(`mesh-threshold-enabled-${id}`).check();
    await setControl(page, `mesh-threshold-lo-${id}`, '0.3');
    await expect.poll(() => bar(page, id)).toMatchObject({ lo: 0.2, hi: 0.8, colormap: 'hot' });

    await page.click(`[data-testid="${chip(id, 'hf_sar')}"]`);
    const sar = range('hf_sar');
    await expect.poll(() => bar(page, id)).toMatchObject({ title: 'hf_sar' });
    const first = (await bar(page, id)) as Bar;
    // Shown for the first time: its own min…max and no threshold — not TI_max's window.
    expect(first.lo).toBeCloseTo(sar.min, 4);
    expect(first.hi).toBeCloseTo(sar.max, 4);
    expect(first.threshold).toEqual({ lo: null, hi: null });
    await setControl(page, `mesh-colormap-${id}`, 'viridis');
    await page.screenshot({ path: join(SHOTS_DIR, 'multifield-hf_sar.png') });

    await page.click(`[data-testid="${chip(id, 'TI_max')}"]`);
    await expect
      .poll(() => bar(page, id))
      .toMatchObject({
        title: 'TI_max',
        lo: 0.2,
        hi: 0.8,
        colormap: 'hot',
        threshold: { lo: 0.3 },
      });

    await page.click(`[data-testid="${chip(id, 'hf_sar')}"]`);
    await expect.poll(() => bar(page, id)).toMatchObject({ title: 'hf_sar', colormap: 'viridis' });
  });

  test('a host’s units and label title the bar, the picker and the chip', async () => {
    // The `set` patch a job (or a saved scene's layer) delivers — §4.4's metadata block.
    await page.evaluate((layerId) => {
      window.__tetravox?.engine?.updateLayer(layerId, {
        fields: {
          hf_sar: { units: '(V/m)^2', label: 'SAR proxy' },
          TI_max: { units: 'V/m', label: 'TI_{max}' },
        },
      } as never);
    }, id);
    await expect.poll(() => bar(page, id)).toMatchObject({ title: 'SAR proxy', units: '(V/m)^2' });
    await expect(page.getByTestId(`mesh-field-units-${id}`)).toHaveText('(V/m)^2');
    await expect(page.getByTestId(chip(id, 'hf_sar'))).toHaveText('SAR proxy');
    // §4.4's `X_{sub}` markup is a real subscript; a bare name is never converted.
    await expect(page.getByTestId(chip(id, 'TI_max')).locator('sub')).toHaveText('max');
    await expect(page.getByTestId(chip(id, 'hf_peak'))).toHaveText('hf_peak');
    await expect(page.getByTestId(chip(id, 'hf_peak')).locator('sub')).toHaveCount(0);
    await page.click(`[data-testid="${chip(id, 'TI_max')}"]`);
    await expect.poll(() => bar(page, id)).toMatchObject({ title: 'TI_{max}', units: 'V/m' });
    await expect(page.getByTestId(`mesh-field-active-${id}`).locator('sub')).toHaveText('max');
    // Switching kept the host's metadata beside the remembered state.
    const kept = await page.evaluate(
      (layerId) =>
        (
          window.__tetravox?.store.getState().layers.find((l) => l.id === layerId) as {
            fields?: Record<string, { units?: string; colormap?: string }>;
          }
        ).fields?.['hf_sar'],
      id
    );
    expect(kept).toMatchObject({ units: '(V/m)^2', colormap: 'viridis' });

    // The probe readout: a point inside the lattice reads every field, units from the metadata
    // and none for the field that has no entry.
    await page.evaluate(() => window.__tetravox?.engine?.setCursor([1.5, 2.5, 3.5]));
    const lines = page.getByTestId('probe-field');
    await expect(
      lines
        .filter({ hasText: /^TImax = .* V\/m$/ })
        .first()
        .locator('sub')
    ).toHaveText('max');
    await expect(lines.filter({ hasText: /^SAR proxy = .* \(V\/m\)\^2$/ }).first()).toBeVisible();
    await expect(lines.filter({ hasText: /^hf_peak = [-0-9.e]+$/ }).first()).toBeVisible();
  });
});
