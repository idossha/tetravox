/**
 * SimNIBS's surface annotations on **real data**, through the real engine: `segmentation/
 * lh.ernie_DK40.annot` opened together with `surfaces/lh.pial.gii` (both on argv — the same route
 * as ⌘O with both selected, or a drop of both) must land on the surface as `colorMode:'label'`
 * with the atlas's own table, and the other hemisphere's file must be refused by name — ernie's
 * two hemispheres have the same vertex count (`scripts/refvalues/annot_refvalues.json`), so no
 * count check could tell them apart.
 *
 * Every expected number is read from that JSON, which `annot_refvalues.py` produced with nibabel.
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS.md).
 */

/* eslint-disable no-empty-pattern */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const TESTDATA = process.env['TETRAVOX_TESTDATA'];
const PIAL = TESTDATA === undefined ? null : join(TESTDATA, 'm2m_ernie', 'surfaces', 'lh.pial.gii');
const annot = (hemi: 'lh' | 'rh'): string =>
  join(TESTDATA as string, 'm2m_ernie', 'segmentation', `${hemi}.ernie_DK40.annot`);

interface AnnotRef {
  annots: Record<string, { n: number; nEntries: number; names: string[] }>;
  surfaces: Record<string, { nNodes: number }>;
}
const REF: AnnotRef = JSON.parse(
  readFileSync(
    resolve(APP_ROOT, '..', '..', 'scripts', 'refvalues', 'annot_refvalues.json'),
    'utf8'
  )
) as AnnotRef;
const DK40 = REF.annots['m2m_ernie/segmentation/lh.ernie_DK40.annot']!;

let app: ElectronApplication;
let page: Page;
let userDataDir: string | null = null;

async function boot(target: LaunchTarget, files: string[]): Promise<void> {
  userDataDir = mkdtempSync(join(tmpdir(), 'tvx-annot-real-'));
  app = await launchApp(target, { args: [`--user-data-dir=${userDataDir}`, ...files] });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 1,
    undefined,
    { timeout: 120_000 }
  );
}

async function shutdown(): Promise<void> {
  await app.close();
  if (userDataDir !== null) rmSync(userDataDir, { recursive: true, force: true });
}

interface Facts {
  fields: string[];
  tables: Record<string, number>;
  colorMode: string;
  labelName: string | null;
  labelEntries: number;
  toasts: string[];
  nNodes: number;
}

async function facts(): Promise<Facts> {
  return page.evaluate(() => {
    const state = window.__tetravox!.store.getState();
    const layer = state.layers[0] as {
      colorMode: string;
      datasetId: string;
      label?: { name: string; table: { entries: unknown[] } };
    };
    const ds = state.datasets.find((d) => d.id === layer.datasetId);
    if (ds === undefined || ds.kind !== 'mesh') throw new Error('no mesh dataset');
    const tables: Record<string, number> = {};
    for (const [k, t] of Object.entries(ds.labelTables ?? {})) tables[k] = t.entries.length;
    return {
      fields: ds.fields.map((f) => f.name),
      tables,
      colorMode: layer.colorMode,
      labelName: layer.label?.name ?? null,
      labelEntries: layer.label?.table.entries.length ?? 0,
      toasts: state.toasts.map((t) => t.detail),
      nNodes: ds.nNodes,
    };
  });
}

test.describe('lh.ernie_DK40.annot onto lh.pial.gii', () => {
  test.skip(PIAL === null, 'TETRAVOX_TESTDATA is unset — real-data tests skip, never fail');

  test('the atlas colours the surface and fills its table', async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? undefined);
    await boot(target, [PIAL as string, annot('lh')]);
    try {
      await page.waitForFunction(
        () =>
          (window.__tetravox?.store.getState().layers[0] as { colorMode?: string } | undefined)
            ?.colorMode === 'label',
        undefined,
        { timeout: 120_000 }
      );
      const got = await facts();
      expect(got.nNodes).toBe(REF.surfaces['m2m_ernie/surfaces/lh.pial.gii']!.nNodes);
      expect(got.fields).toContain('lh.ernie_DK40.annot');
      expect(got.tables['lh.ernie_DK40.annot']).toBe(DK40.nEntries);
      expect(got.labelName).toBe('lh.ernie_DK40.annot');
      expect(got.labelEntries).toBe(DK40.nEntries);
      expect(got.toasts).toEqual([]);
      // The region panel lists the atlas: one row per table entry the file names.
      const rows = await page.locator('[data-testid^="region-row-"]').count();
      expect(rows).toBeGreaterThanOrEqual(DK40.nEntries - 1);
    } finally {
      await shutdown();
    }
  });

  test('the other hemisphere’s atlas is refused by name, not by count', async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? undefined);
    await boot(target, [PIAL as string, annot('rh')]);
    try {
      await page.waitForFunction(
        () => (window.__tetravox?.store.getState().toasts.length ?? 0) > 0,
        undefined,
        { timeout: 120_000 }
      );
      const got = await facts();
      expect(got.toasts[0]).toContain('other hemisphere');
      expect(got.fields).not.toContain('rh.ernie_DK40.annot');
      expect(got.colorMode).not.toBe('label');
    } finally {
      await shutdown();
    }
  });
});
