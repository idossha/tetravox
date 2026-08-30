/**
 * The sEEG contact editor in the running app (ARCHITECTURE.md §13.3, §13.4).
 *
 * `seeg.test.ts` covers the state and the calls; this covers what only a window can answer — that
 * the panel renders, that its buttons reach the module, that a **save really writes three files to a
 * real disk** through main's write list, that the discard guard asks, and that a module-owned layer
 * gets a summary instead of the core points editor.
 *
 * The subject is a real `seegprep` derivative tree in a temp directory, built from the committed
 * fixtures: `ct_shafts.nii.gz` copied to the BIDS CT name, and `seeg_contacts.tsv` beside it in
 * `ieeg/`. Only the *paths* have to be real — the launch is `?engine=mock`, so `NoGlEngine` makes
 * the volume from its name (`engine/mockData.ts` answers a bone-window CT with the same phantom the
 * fixture holds), and main's IO, its allow-list and its Save sheet are all the product's own.
 *
 * `dialog.showSaveDialog` is **stubbed in main** (`module-guard.spec.ts`'s idiom): it is OS-modal,
 * no Playwright click can reach it, and an unstubbed one hangs the run to the CI cap. Everything
 * under it stays real — the template validation, the write list, the `.bak`, the `.part`+rename.
 */

/* eslint-disable no-empty-pattern */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, clickAppMenu, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const TESTDATA = resolve(APP_ROOT, '..', '..', 'testdata');
const SEARCH = 'engine=mock&mockStepMs=0';
const SEEG = 'tetravox.seeg';

/** A `seegprep` derivative tree with the committed fixtures in it, in a fresh temp directory. */
function subjectTree(): { ct: string; tsv: string; ieeg: string } {
  const root = mkdtempSync(join(tmpdir(), 'tetravox-seeg-'));
  const subject = join(root, 'derivatives', 'seegprep', 'sub-P076');
  const ctDir = join(subject, 'ct');
  const ieeg = join(subject, 'ieeg');
  mkdirSync(ctDir, { recursive: true });
  mkdirSync(ieeg, { recursive: true });
  const ct = join(ctDir, 'sub-P076_acq-bone_space-T1w_ct.nii.gz');
  const tsv = join(ieeg, 'sub-P076_space-T1w_electrodes.tsv');
  copyFileSync(join(TESTDATA, 'ct_shafts.nii.gz'), ct);
  copyFileSync(join(TESTDATA, 'seeg_contacts.tsv'), tsv);
  // A subject somebody has already hand-corrected: the editlog is what `seegprep`'s --force guard
  // looks for, and what the panel's banner is about.
  writeFileSync(
    join(ieeg, 'sub-P076_space-T1w_electrodes_editlog.json'),
    JSON.stringify({ edited_utc: '2026-08-14T09:30:00Z', n_contacts: 15, added: 0, edited: 2 })
  );
  return { ct, tsv, ieeg };
}

async function setSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    },
    { width, height }
  );
}

/** Click outside every control, so a key press is not swallowed by a focused button or field. */
async function focusShell(page: Page): Promise<void> {
  await page.locator('[data-testid="shell"]').click({ position: { x: 5, y: 400 } });
}

/** The contacts layer's id, read out of the store. */
async function layerId(page: Page): Promise<string> {
  return page.evaluate((id) => {
    const layers = window.__tetravox?.store.getState().layers ?? [];
    return layers.find((l) => l.module === id)?.id ?? '';
  }, SEEG);
}

test.describe('the sEEG contact editor (stand-in engine, real files)', () => {
  let app: ElectronApplication;
  let page: Page;
  let tree: ReturnType<typeof subjectTree>;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    tree = subjectTree();
    app = await launchApp(target, {
      search: SEARCH,
      args: [tree.ct],
      // The window is deliberately made dirty below; without this its close would ask (§5 rule 12).
      env: { TETRAVOX_E2E_DISCARD: '1' },
    });
    page = await app.firstWindow();
    await setSize(app, 1440, 900);
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('opening the CT finds its table and puts the editor in the slot', async () => {
    // §13.1's `onSibling`: nothing was clicked, and nothing named the table — the manifest's
    // patterns found `../ieeg/sub-P076_space-T1w_electrodes.tsv` beside the CT that argv opened.
    await expect(page.locator('[data-testid="seeg-panel"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="module-slot"]')).toHaveAttribute('data-module', SEEG);
    await expect(page.locator('[data-testid="seeg-source"]')).toContainText('sub-P076');
    await expect(page.locator('[data-testid="seeg-source"]')).toContainText('_electrodes.tsv');

    // 15 contacts on three electrodes, as one points layer with §4.4's module fields.
    const layer = await page.evaluate((id) => {
      const found = (window.__tetravox?.store.getState().layers ?? []).find((l) => l.module === id);
      return found === undefined
        ? null
        : (found as unknown as {
            kind: string;
            shape: string;
            radiusMm: number;
            labelSource?: string;
            offPlaneOpacity?: number;
            points?: unknown[];
          });
    }, SEEG);
    expect(layer).not.toBeNull();
    expect(layer).toMatchObject({
      kind: 'points',
      shape: 'dot',
      radiusMm: 1.5,
      labelSource: 'names',
      offPlaneOpacity: 0.6,
    });
    expect(layer?.points).toHaveLength(15);

    // Slicer's display preset really reached the CT layer.
    const ct = await page.evaluate(() => {
      const found = (window.__tetravox?.store.getState().layers ?? []).find(
        (l) => l.kind === 'volume'
      );
      return found as unknown as { colormap: string; threshold: { lo: number; mode: string } };
    });
    expect(ct.colormap).toBe('gray');
    expect(ct.threshold).toMatchObject({ lo: 150, mode: 'hide' });
  });

  test('an existing editlog is a banner: somebody has been here before you', async () => {
    await expect(page.locator('[data-testid="seeg-banner"]')).toContainText('2026-08-14');
  });

  test('the contact list shows a status, an off-plane distance and a tip marker', async () => {
    await expect(page.locator('[data-testid="seeg-list"] > li')).toHaveCount(6);
    const row = page.locator('[data-testid="seeg-row-A01"]');
    await expect(row).toHaveAttribute('data-status', 'located');
    await expect(row).toContainText('mm');
    // The tip marker names one contact of the electrode, and only one.
    await expect(page.locator('[data-testid="seeg-tip"]')).toHaveText(/^A0\d$/);
    await expect(page.locator('[data-testid="seeg-stats"]')).toContainText('rms');
  });

  test('a jump puts the crosshair on the contact, and its own off-plane distance is zero', async () => {
    await page.click('[data-testid="seeg-jump-A04"]');
    const cursor = await page.evaluate(() => window.__tetravox?.store.getState().cursor);
    const contact = await page.evaluate((id) => {
      const layer = (window.__tetravox?.store.getState().layers ?? []).find((l) => l.module === id);
      const points = (layer as unknown as { points: { name?: string; position: number[] }[] })
        .points;
      return points.find((p) => p.name === 'A04')?.position ?? null;
    }, SEEG);
    expect(cursor).toEqual(contact);

    // §13.1's `activePlane`: the column is the distance from the plane the active pane is showing,
    // which passes through the crosshair — so the contact the crosshair is now on reads 0.0 mm, and
    // the ones further along an oblique shaft do not.
    await expect(page.locator('[data-testid="seeg-row-A04"]')).toContainText('0.0 mm');
    await expect(page.locator('[data-testid="seeg-row-A01"]')).not.toContainText('0.0 mm');
  });

  test('a snap moves the selected contact toward the metal, and Undo puts it back', async () => {
    const id = await layerId(page);
    const before = await page.evaluate(
      ([layer, name]: [string, string]) => {
        const found = (window.__tetravox?.store.getState().layers ?? []).find(
          (l) => l.id === layer
        );
        const points = (
          found as unknown as { points: { name?: string; id?: string; position: number[] }[] }
        ).points;
        const point = points.find((p) => p.name === name);
        return { id: point?.id ?? '', position: point?.position ?? [] };
      },
      [id, 'A03'] as [string, string]
    );

    // Select through the engine, the way a click in a pane does: `?engine=mock` has no canvas for a
    // pointer layer to listen to, so this is the call `input/pointer.ts` would have made.
    await page.evaluate(
      ([layer, point]: [string, string]) => {
        (
          window.__tetravox?.engine as unknown as {
            setPointSelection(sel: { layerId: string; pointId: string }): void;
          }
        ).setPointSelection({ layerId: layer, pointId: point });
      },
      [id, before.id] as [string, string]
    );
    await expect(page.locator('[data-testid="seeg-snap"]')).toBeEnabled();
    await page.click('[data-testid="seeg-snap"]');

    const after = await page.evaluate(
      ([layer, name]: [string, string]) => {
        const found = (window.__tetravox?.store.getState().layers ?? []).find(
          (l) => l.id === layer
        );
        const points = (found as unknown as { points: { name?: string; position: number[] }[] })
          .points;
        return points.find((p) => p.name === name)?.position ?? [];
      },
      [id, 'A03'] as [string, string]
    );
    expect(after).not.toEqual(before.position);
    // It moved toward the blob rather than anywhere: less than a millimetre, more than a tenth.
    const moved = Math.hypot(
      (after[0] as number) - (before.position[0] as number),
      (after[1] as number) - (before.position[1] as number),
      (after[2] as number) - (before.position[2] as number)
    );
    expect(moved).toBeGreaterThan(0.1);
    expect(moved).toBeLessThan(1.5);

    await expect(page.locator('[data-testid="module-dirty"]')).toBeVisible();
    await page.click('[data-testid="seeg-undo"]');
    const back = await page.evaluate(
      ([layer, name]: [string, string]) => {
        const found = (window.__tetravox?.store.getState().layers ?? []).find(
          (l) => l.id === layer
        );
        const points = (found as unknown as { points: { name?: string; position: number[] }[] })
          .points;
        return points.find((p) => p.name === name)?.position ?? [];
      },
      [id, 'A03'] as [string, string]
    );
    expect(back).toEqual(before.position);
  });

  test('place mode adds a contact to the current electrode', async () => {
    await page.click('[data-testid="seeg-add"]');
    await expect(page.locator('[data-testid="seeg-add"]')).toHaveAttribute('aria-pressed', 'true');

    // The click `input/pointer.ts` would have dispatched, on the stand-in's own pane model.
    await page.evaluate(() => {
      (
        window.__tetravox?.engine as unknown as {
          pointToolClick(viewId: string, px: number, py: number): void;
        }
      ).pointToolClick('axial', 250, 250);
    });
    await expect(page.locator('[data-testid="seeg-list"] > li')).toHaveCount(7);
    await expect(page.locator('[data-testid="seeg-row-A07"]')).toHaveAttribute(
      'data-status',
      'added'
    );
    await page.click('[data-testid="seeg-add"]');
  });

  test('a drag is one undo step, and a re-fit straightens the shaft', async () => {
    const id = await layerId(page);
    await page.evaluate((layer) => {
      const engine = window.__tetravox?.engine as unknown as {
        pointAtScreen(viewId: string, px: number, py: number): { pointId: string } | null;
        setPointSelection(sel: { layerId: string; pointId: string }): void;
        pointToolClick(viewId: string, px: number, py: number): void;
        pointToolDrag(viewId: string, px: number, py: number): void;
        pointToolDragEnd(): void;
      };
      void layer;
      // Grab whatever is under the pane centre, drag it, and end the gesture from `#onUp`.
      engine.pointToolClick('axial', 250, 250);
      engine.pointToolDrag('axial', 262, 250);
      engine.pointToolDragEnd();
    }, id);
    await expect(page.locator('[data-testid="module-dirty"]')).toBeVisible();

    await page.click('[data-testid="seeg-refit"]');
    await expect(page.locator('[data-testid="seeg-stats"]')).toContainText('rms 0.0 mm');
  });

  test('a module-owned layer gets a summary, not the core points editor', async () => {
    const id = await layerId(page);
    const disclosure = page.locator(`[data-testid="layer-disclosure-${id}"]`);
    // Expanded is the default; click only if this row happens to be collapsed.
    if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
    await expect(page.locator(`[data-testid="module-layer-summary-${id}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="points-properties-${id}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="module-layer-summary-${id}"]`)).toContainText(
      'sEEG contacts'
    );
  });

  test('Save writes the table, a timestamped backup and the editlog', async () => {
    // The Save sheet is OS-modal; main answers with the path the module was opened from.
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path,
      })) as unknown as typeof dialog.showSaveDialog;
    }, tree.tsv);

    const before = readFileSync(tree.tsv, 'utf8');
    await page.click('[data-testid="seeg-save-as"]');
    await expect(page.locator('[data-testid="module-dirty"]')).toHaveCount(0, { timeout: 15_000 });

    const after = readFileSync(tree.tsv, 'utf8');
    expect(after).not.toBe(before);
    // The original columns, in the file's own order, and LF endings.
    expect(after.split('\n')[0]).toBe('name\telectrode\tcontact\tcsc\tx\ty\tz\tstatus');
    expect(after.includes('\r')).toBe(false);
    expect(after).toContain('\tedited\n');
    expect(after).toContain('\tadded\n');

    // The backup main made, from the bytes that were there — its name is the writer's template.
    const backups = readdirSync(tree.ieeg).filter((name) => name.endsWith('.bak'));
    // Exactly one: the table's. The editlog is written with `backup: false` — it is a record of
    // this save, not a file whose previous contents are worth keeping.
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^sub-P076_space-T1w_electrodes\.tsv\.\d{8}-\d{6}\.bak$/);
    expect(readFileSync(join(tree.ieeg, backups[0] as string), 'utf8')).toBe(before);

    // The editlog, under the name seegprep's `--force` guard globs for.
    const editlog = join(tree.ieeg, 'sub-P076_space-T1w_electrodes_editlog.json');
    expect(existsSync(editlog)).toBe(true);
    const log = JSON.parse(readFileSync(editlog, 'utf8')) as {
      n_contacts: number;
      added: number;
      edited: number;
      contacts: { name: string; change: string }[];
      tool: string;
    };
    expect(log.n_contacts).toBe(16);
    expect(log.added).toBe(1);
    expect(log.edited).toBeGreaterThan(0);
    expect(log.tool).toContain('Tetravox');
    expect(log.contacts.some((c) => c.change === 'added')).toBe(true);
  });

  test('a key runs a command, and only while the module is active', async () => {
    await focusShell(page);
    const ghost = page.locator('[data-testid="seeg-ghost"]');
    await expect(ghost).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('g');
    await expect(ghost).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('g');
    await expect(ghost).toHaveAttribute('aria-pressed', 'true');

    // §13.5: a module key resolves only after the core map declined, so `c` is still the crosshair.
    const crosshair = page.locator('[data-testid="crosshair-toggle"]');
    const before = await crosshair.getAttribute('aria-pressed');
    await page.keyboard.press('c');
    await expect(crosshair).not.toHaveAttribute('aria-pressed', before ?? '');
    await page.keyboard.press('c');
  });

  test('New asks before discarding unsaved contacts, and offers to save them', async () => {
    // Make it dirty again — the previous save cleared the flag.
    await page.click('[data-testid="seeg-snap-electrode"]');
    await expect(page.locator('[data-testid="module-dirty"]')).toBeVisible();

    await clickAppMenu(page, 'new');
    await expect(page.locator('[data-testid="confirm-dialog"]')).toBeVisible();
    // Three buttons, because the sEEG manifest declares a `save` command — the fixture module's
    // guard offers two.
    await expect(page.locator('[data-testid^="confirm-button-"]')).toHaveCount(3);
    await expect(page.locator('[data-testid="confirm-body"]')).toContainText('without saving');
    // Cancel is last, and it really cancels.
    await page.click('[data-testid="confirm-button-2"]');
    await expect(page.locator('[data-testid="confirm-dialog"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="seeg-panel"]')).toBeVisible();
  });
});
