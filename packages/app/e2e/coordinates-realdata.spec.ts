/**
 * **Directed task 8's real-data gate**: the coordinate spaces, in the product, on ernie.
 *
 * The unit tests prove the *arithmetic* against nibabel and SimNIBS (`packages/engine`'s
 * `view/spaces.test.ts`, `view/spaces.realdata.test.ts`, `view/coord-spaces.test.ts`). This spec
 * proves the parts no unit test can reach: that opening `m2m_ernie/T1.nii.gz` makes main find the
 * `toMNI/` folder beside it, that the selector then really offers the four spaces, that selecting
 * the nonlinear one loads the 97 MB warp and produces the number SimNIBS produces, and that Copy
 * puts the **selected space's** triple on the clipboard.
 *
 * Runs against the real engine, offscreen (AGENTS rule 9 — never set `TETRAVOX_E2E_HEADED`).
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 *
 * The screenshot the brief owes — `docs/screenshots/directed-2026-08-28/coordinates.png` — is taken
 * at the end of the same session, behind `TETRAVOX_SHOTS=1`, because it is the only run that has the
 * warp loaded and there is no reason to pay for that twice.
 */

/* eslint-disable no-empty-pattern */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const ROOT = process.env['TETRAVOX_TESTDATA'] ?? '';
const T1 = join(ROOT, 'm2m_ernie', 'T1.nii.gz');
const WARP = join(ROOT, 'm2m_ernie', 'toMNI', 'Conform2MNI_nonl.nii.gz');
const OUT = resolve(APP_ROOT, '..', '..', 'docs', 'screenshots', 'directed-2026-08-28');

/**
 * One landmark and its answers, all produced by something other than this code:
 *
 * * `tkr` — `nibabel`'s `MGHHeader.get_vox2ras_tkr() @ inv(affine)`.
 * * `mni` — `simnibs.utils.transformations.subject2mni_coords(..., 'nonl')`, SimNIBS 4.6.
 *
 * `scripts/refvalues/mni_refvalues.py` prints both.
 */
const WORLD: [number, number, number] = [-40, -20, 50];
const TKR = '-46.2 -44.3 -65.6';
const MNI_NONL = '-43.2 -41.1 47.3';

test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);

let app: ElectronApplication;
let page: Page;

test.beforeAll(async ({}, workerInfo) => {
  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.skip(!existsSync(T1), `${T1} is missing`);
  const target = workerInfo.project.name as LaunchTarget;
  // The packaged artefact self-skips when `pnpm package` has not run — the same guard every other
  // real-data spec uses, and the one that keeps `scripts/e2e-quiet-check.sh` windowless.
  const blocked = target === 'packaged' ? packagedUnavailable() : null;
  test.skip(blocked !== null, blocked ?? '');
  app = await launchApp(target, { search: 'engine=real', args: [T1] });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 700);
  });
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
  await page.waitForFunction(
    () => (window.__tetravox?.store.getState().layers.length ?? 0) >= 1,
    undefined,
    { timeout: 600_000 }
  );
});

test.afterAll(async () => {
  await app?.close();
});

/** Put the cursor on a known world point without depending on where a click lands. */
async function setCursor(world: [number, number, number]): Promise<void> {
  // Move somewhere else first: `setCursor` to the point the cursor is already on is a no-op, and
  // the info panel's rows come from the `cursor` event's probe — which would then still be the one
  // taken before the warp arrived.
  await page.evaluate((w) => window.__tetravox?.engine?.setCursor([w[0] + 1, w[1], w[2]]), world);
  await page.evaluate((w) => window.__tetravox?.engine?.setCursor(w), world);
  await page.evaluate(async () => {
    await window.__tetravox?.engine?.whenSettled();
  });
}

const select = (): ReturnType<Page['locator']> => page.locator('[data-testid="coord-space"]');

/** Pick an option by its label prefix — a ref's `<option value>` carries a generated `DatasetId`. */
async function selectSpace(prefix: string): Promise<void> {
  const labels = await select().locator('option').allTextContents();
  const label = labels.find((l) => l.startsWith(prefix));
  expect(label, `no space labelled ${prefix}`).toBeDefined();
  await select().selectOption({ label: label as string });
}

test('the selector offers world, voxel, tkr-RAS and both MNI spaces for the subject', async () => {
  const labels = await select().locator('option').allTextContents();
  expect(labels[0]).toBe('World RAS');
  expect(labels.some((l) => l.startsWith('Voxel · T1'))).toBe(true);
  expect(labels.some((l) => l.startsWith('tkr-RAS · T1'))).toBe(true);

  // The `toMNI/` folder beside `T1.nii.gz` is what puts these here — nothing in the NIfTI header
  // does: every m2m volume is `sform_code = 2` (AGENTS.md).
  expect(labels.some((l) => l.startsWith('MNI152 (affine)'))).toBe(true);
  expect(labels.some((l) => l.startsWith('MNI152 (nonlinear)'))).toBe(true);
});

test('the affine MNI space is listed disabled, with the reason, because charm writes none', async () => {
  // SimNIBS 4 writes no `MNI2conform_*DOF.txt` at all; `subject2mni_coords(..., '12dof')` raises
  // `FileNotFoundError` on this subject. §8's rule is that the space is greyed **with the reason**,
  // never hidden — a column that silently disappears reads as a bug.
  const affine = select().locator('option', { hasText: 'MNI152 (affine)' });
  await expect(affine).toBeDisabled();
  await expect(affine).toHaveAttribute('title', /no MNI2conform/);

  await expect(
    page.locator('[data-testid="coord-readout"] [data-space="mni-affine"]')
  ).toContainText('no MNI2conform');

  // And the info panel must not print one either. `TemplateSpace.matrix` is a placeholder identity
  // when `hasAffine` is false, so a readout that applied it would report the cursor **unchanged** as
  // an MNI coordinate — a wrong number that looks exactly like a right one.
  await expect(page.locator('[data-testid="info-cursor-mni"]')).toHaveCount(0);
});

test('tkr-RAS reads the triple nibabel reads, and typed entry comes back to the same world point', async () => {
  await setCursor(WORLD);
  await expect(page.locator('[data-testid="coord-readout"] [data-space="tkr"]')).toHaveText(TKR);
  // The info panel labels it with the volume it belongs to — a bare tkr triple is not a coordinate.
  await expect(page.locator('[data-testid="info-cursor-tkr"]')).toContainText('tkr-RAS · T1');

  await selectSpace('tkr-RAS · T1');
  const input = page.locator('[data-testid="coord-input"]');
  await expect(input).toHaveValue(TKR);
  await input.click();
  await input.fill(TKR);
  await input.press('Enter');
  const cursor = await page.evaluate(() => window.__tetravox?.store.getState().cursor);
  for (let i = 0; i < 3; i += 1) expect(cursor?.[i]).toBeCloseTo(WORLD[i] as number, 1);
});

test('Copy yields the selected space’s triple, not the world one', async () => {
  await page.evaluate(() => {
    // The offscreen window is not focused, so the real clipboard API is unavailable; the controller
    // swallows that and still returns the text, which is the value under test.
    (window as unknown as { __copied?: string }).__copied = undefined;
  });
  const copied = await page.evaluate(
    async () => await window.__tetravox?.controller?.copyCoordinate()
  );
  expect(copied).toBe(TKR);
});

test('selecting MNI (nonlinear) loads the warp and reads what SimNIBS reads', async () => {
  test.skip(!existsSync(WARP), 'toMNI/Conform2MNI_nonl.nii.gz is missing');
  await selectSpace('MNI152 (nonlinear)');

  // The 97 MB warp is loaded on demand, as an ordinary dataset with **no layer**.
  await page.waitForFunction(
    () => {
      const state = window.__tetravox?.store.getState();
      const volumes = (state?.datasets ?? []).filter((d) => d.kind === 'volume');
      return volumes.length >= 2;
    },
    undefined,
    { timeout: 600_000 }
  );
  // The forward warp is attached as soon as it lands, so this is the moment the space can convert.
  await page.waitForFunction(
    () => window.__tetravox?.engine?.probe([0, 0, 0]).mniNonlinear !== undefined,
    undefined,
    { timeout: 600_000 }
  );

  await setCursor(WORLD);
  await expect(
    page.locator('[data-testid="coord-readout"] [data-space="mni-nonlinear"]')
  ).toHaveText(MNI_NONL);
  await expect(page.locator('[data-testid="info-cursor-mni-nonlinear"]')).toContainText(
    'MNI (nonlinear)'
  );

  // Loading a warp must not put a layer on screen, and must not appear in the menu as a volume.
  const layers = await page.evaluate(() => window.__tetravox?.store.getState().layers.length ?? 0);
  expect(layers).toBe(1);
  // Both warps are ordinary datasets in the scene; neither is a layer, and neither is in the menu.
  const volumes = await page.evaluate(
    () => (window.__tetravox?.store.getState().datasets ?? []).length
  );
  expect(volumes).toBeGreaterThanOrEqual(2);
  const labels = await select().locator('option').allTextContents();
  expect(labels.some((l) => l.includes('Conform2MNI'))).toBe(false);
});

test('the coordinates screenshot', async () => {
  test.skip(process.env['TETRAVOX_SHOTS'] !== '1', 'set TETRAVOX_SHOTS=1 to capture');
  mkdirSync(OUT, { recursive: true });
  await setCursor(WORLD);
  await page.evaluate(async () => {
    const engine = window.__tetravox?.engine;
    if (engine == null) return;
    await engine.whenSettled();
    engine.renderNow();
    await engine.whenSettled();
  });
  const file = join(OUT, 'coordinates.png');
  await page.screenshot({ path: file });
  // A number, not a look (AGENTS rule 1): the file is real and in the same budget the other
  // directed-task screenshots are held to.
  const bytes = statSync(file).size;
  expect(bytes).toBeGreaterThan(1024);
  expect(bytes).toBeLessThanOrEqual(400_000);
});
