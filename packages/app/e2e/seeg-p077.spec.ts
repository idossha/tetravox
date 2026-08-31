/**
 * **The sEEG editor against the owner's real P077 subject, in the packaged app** (ARCHITECTURE.md
 * §13.3, §13.4; the Plan A ghost-click amendment, §7.5, 2026-08-30).
 *
 * `module-seeg.spec.ts` drives the same extension against a synthetic phantom under `?engine=mock`.
 * This spec is the other end of the ladder: the **real** engine (WebGL on the host GPU), the **real**
 * P077 scene — a T1, a bone CT and an 82-contact / 15-electrode BIDS `electrodes.tsv` — opened in the
 * **packaged** `.app` by argument, exactly as the interactive relaunch and `<binary> scene.tetravox.json`
 * do. It asserts, through the running UI where a click can reach it and through the engine's own
 * pointer seam where the geometry cannot be clicked blind, that the panel opens on the table, that
 * the counts are the subject's, that the shafts are drawn in their electrode colours, that a click on
 * a **ghosted** contact selects it and brings the slice to it (the Plan A fix, through a real mouse
 * click on the canvas this time), that the size stepper and the wire toggle do what they say, that a
 * snap pulls a contact toward the metal, and that Save writes the table, a timestamped backup and the
 * editlog.
 *
 * **The subject is copied to a temp tree and the scene is rewritten onto it**, so the owner's real
 * Desktop data is only ever *read*: the Save lands in the copy, its `.bak` is made from the copy, and
 * the original `electrodes.tsv` is never touched. The scene's `DatasetRef.path` resolves against the
 * scene's directory first (§4.6), so a scene beside the copied tree loads the copy.
 *
 * Gated three ways, and skips (never fails) on any: the packaged target must be built
 * (`packagedUnavailable`), `TETRAVOX_SEEG_FIXTURE` must name a built sEEG to stage (§13.8), and
 * the owner's `~/Desktop/example` must be present (it is real-subject data, not a committed fixture —
 * the `TETRAVOX_TESTDATA` discipline of AGENTS.md rule 2).
 */

/* eslint-disable no-empty-pattern */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, packagedUnavailable, SHOTS_DIR, stageSeeg } from './fixtures';
import type { SeegStage } from './fixtures';

const EXAMPLE = '/Users/idohaber/Desktop/example';
const SCENE_NAME = 'seeg-P077.tetravox.json';
const SEEG = 'tetravox.seeg';

/** The twelve-colour contact palette (`shared/contacts/palette.ts`), rounded like the readback. */
const PALETTE: readonly [number, number, number, number][] = [
  [0.9, 0.1, 0.1, 1],
  [0.12, 0.47, 0.71, 1],
  [0.2, 0.63, 0.17, 1],
  [1.0, 0.5, 0.0, 1],
  [0.42, 0.24, 0.6, 1],
  [0.65, 0.34, 0.16, 1],
  [0.89, 0.1, 0.55, 1],
  [0.4, 0.76, 0.65, 1],
  [0.99, 0.75, 0.44, 1],
  [0.55, 0.63, 0.8, 1],
  [0.85, 0.85, 0.1, 1],
  [0.6, 0.6, 0.6, 1],
];

interface SeegLayer {
  id: string;
  radiusMm: number;
  dotRadiusPx?: number;
  points: {
    id: string;
    name: string;
    group: string;
    position: [number, number, number];
    color: number[];
  }[];
  lineSegments?: number[];
  lineColors?: number[];
}

async function readLayer(page: Page): Promise<SeegLayer> {
  return page.evaluate((id) => {
    const layer = (window.__tetravox!.store.getState().layers ?? []).find(
      (l: { module?: string }) => l.module === id
    ) as unknown as SeegLayer & { lineSegments?: Float32Array; lineColors?: Float32Array };
    return {
      id: layer.id,
      radiusMm: layer.radiusMm,
      dotRadiusPx: layer.dotRadiusPx,
      points: layer.points,
      lineSegments: layer.lineSegments ? Array.from(layer.lineSegments) : undefined,
      lineColors: layer.lineColors ? Array.from(layer.lineColors) : undefined,
    };
  }, SEEG);
}

test.describe('the sEEG editor on real P077 (packaged, real engine)', () => {
  let app: ElectronApplication;
  let page: Page;
  let root: string;
  let home: string;
  let stage: SeegStage;
  let profile: string;
  let sceneTsv: string;
  let sceneIeeg: string;

  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(async ({}, wi) => {
    test.skip(wi.project.name !== 'packaged', 'the packaged target only');
    const blocked = packagedUnavailable();
    test.skip(blocked !== null, blocked ?? '');
    test.skip(!existsSync(join(EXAMPLE, SCENE_NAME)), `the P077 subject is not at ${EXAMPLE}`);

    // Copy ONLY the three files the scene names — the T1, the bone CT and the electrodes.tsv — into a
    // temp tree at their scene-relative paths, and rewrite the scene's absolute paths onto it, so
    // every read AND the Save happen in the copy and the owner's real data is untouched. The whole
    // `~/Desktop/example` is 3+ GB (a FreeSurfer derivative, raw sourcedata): copying it per run fills
    // the temp disk, and the scene needs none of it.
    root = mkdtempSync(join(tmpdir(), 'tetravox-p077-'));
    const needed = [
      'sub-P077/anat/sub-P077_T1w.nii.gz',
      'derivatives/seegprep/sub-P077/ct/sub-P077_acq-bone_space-T1w_ct.nii.gz',
      'derivatives/seegprep/sub-P077/ieeg/sub-P077_space-T1w_electrodes.tsv',
    ];
    for (const rel of needed) {
      const dest = join(root, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(EXAMPLE, rel), dest);
    }
    const scene = readFileSync(join(EXAMPLE, SCENE_NAME), 'utf8').split(EXAMPLE).join(root);
    const scenePath = join(root, SCENE_NAME);
    writeFileSync(scenePath, scene);
    sceneIeeg = join(root, 'derivatives', 'seegprep', 'sub-P077', 'ieeg');
    sceneTsv = join(sceneIeeg, 'sub-P077_space-T1w_electrodes.tsv');

    home = mkdtempSync(join(tmpdir(), 'tetravox-p077-home-'));
    // sEEG no longer ships bundled (2026-08-31): stage the downloaded-and-consented state from the
    // bytes TETRAVOX_SEEG_FIXTURE names, or skip.
    const staged = stageSeeg();
    test.skip(
      staged === null,
      'set TETRAVOX_SEEG_FIXTURE to a built tetravox.seeg to run this suite'
    );
    stage = staged!;
    profile = mkdtempSync(join(tmpdir(), 'tetravox-p077-profile-'));
    stage.consentInto(profile);
    app = await launchApp('packaged', {
      args: [scenePath],
      // The scene restore leaves the module clean, but a later snap/save makes it dirty; the packaged
      // build ignores `TETRAVOX_E2E_DISCARD` on purpose (§5 rule 12), so `afterAll` clears the flag
      // rather than leaning on it — the seam is set only so an interrupted run does not hang.
      userDataDir: profile,
      env: { TETRAVOX_E2E_DISCARD: '1', TETRAVOX_HOME: home, ...stage.env },
    });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900)
    );
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
    // The real volumes decode off the UI thread; the seeg layer lands when the scene has restored.
    await expect(page.locator('[data-testid="seeg-panel"]')).toBeVisible({ timeout: 45_000 });
    await expect
      .poll(async () => (await readLayer(page)).points.length, { timeout: 45_000 })
      .toBe(82);
  });

  test.afterAll(async () => {
    await page?.evaluate(() => window.tetravox.setDocumentEdited(false)).catch(() => {});
    await app?.close();
    for (const dir of [root, home]) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the panel opens on the P077 table, in the module slot', async () => {
    await expect(page.locator('[data-testid="module-slot"]')).toHaveAttribute('data-module', SEEG);
    const source = page.locator('[data-testid="seeg-source"]');
    await expect(source).toContainText('sub-P077');
    await expect(source).toContainText('_electrodes.tsv');
    await page.screenshot({ path: join(SHOTS_DIR, 'c4-p077-open.png') });
  });

  test('82 contacts across 15 electrodes', async () => {
    const layer = await readLayer(page);
    expect(layer.points).toHaveLength(82);
    const groups = new Set(layer.points.map((p) => p.group));
    expect(groups.size).toBe(15);
    // The dropdown is the UI surface for the electrode count: one option per shaft.
    await expect(page.locator('[data-testid="seeg-electrode"] option')).toHaveCount(15);
  });

  test('the shafts are drawn in their electrode colours', async () => {
    // §4.4's `lineColors`: 4 floats per segment, parallel to `lineSegments`. Readback (AGENTS rule 1:
    // numbers, not a picture) — 82 contacts, 15 shafts ⇒ 82−15 = 67 intra-shaft segments.
    const layer = await readLayer(page);
    const round = (v: number): number => Math.round(v * 100) / 100;
    const key = (a: number[]): string => a.map(round).join(',');
    expect(layer.lineSegments).toBeDefined();
    expect(layer.lineColors).toBeDefined();
    const segCount = layer.lineSegments!.length / 6;
    expect(segCount).toBe(67);
    expect(layer.lineColors!.length).toBe(segCount * 4);

    // Every segment's colour is a palette colour, and the set of shaft colours equals the set of
    // contact colours — the wires carry the same per-electrode colouring the dots do.
    const paletteKeys = new Set(PALETTE.map((c) => key(c)));
    const segColours = new Set<string>();
    for (let i = 0; i < layer.lineColors!.length; i += 4) {
      const c = key([
        layer.lineColors![i]!,
        layer.lineColors![i + 1]!,
        layer.lineColors![i + 2]!,
        layer.lineColors![i + 3]!,
      ]);
      expect(paletteKeys.has(c)).toBe(true);
      segColours.add(c);
    }
    const dotColours = new Set(layer.points.map((p) => key(p.color)));
    expect([...segColours].sort()).toEqual([...dotColours].sort());
    // 15 shafts cycling a 12-colour palette ⇒ 12 distinct colours.
    expect(segColours.size).toBe(12);
    // The first shaft in file order is S01 ⇒ palette[0].
    expect(
      key([
        layer.lineColors![0]!,
        layer.lineColors![1]!,
        layer.lineColors![2]!,
        layer.lineColors![3]!,
      ])
    ).toBe(key(PALETTE[0]!));
  });

  test('clicking a ghosted contact selects it, follows the dropdown and jumps the slice', async () => {
    // §7.5's Plan A amendment, end to end through a REAL mouse click on the canvas. With
    // `offPlaneOpacity: 0.6` the panes draw off-slice contacts as ghosts; under the old on-slice-only
    // rule a press on one fell through and the owner read it as "the selection does not update". Here
    // the crosshair is taken **off every contact**, so every drawn marker is a ghost, and a click on
    // one must (1) select it, (2) move the electrode dropdown to it and (3) bring the slice onto it.
    const layer = await readLayer(page);
    const first = layer.points[0]!;

    // Centre the axial pane on a contact, then lift the crosshair 6 mm above the whole implant along
    // the axial normal: the in-plane projection is unchanged (every marker stays where it was drawn)
    // and not one contact is on the slice. `seeg-jump` needs its electrode selected first.
    await page.locator('[data-testid="seeg-electrode"]').selectOption(first.group);
    await page.click(`[data-testid="seeg-jump-${first.name}"]`);
    const maxZ = Math.max(...layer.points.map((p) => p.position[2]));
    await page.evaluate(
      ({ z }) => {
        const eng = window.__tetravox!.engine as unknown as {
          scene: { cursor: number[] };
          setCursor(w: number[]): void;
        };
        const c = eng.scene.cursor;
        eng.setCursor([c[0]!, c[1]!, z]);
      },
      { z: maxZ + 6 }
    );

    const cell = await page.locator('[data-testid="view-cell-axial"]').boundingBox();
    if (cell === null) throw new Error('the axial pane has no bounding box');

    // Scan the axial pane (CSS px) for a ghost under some pixel — one round trip. Because every
    // contact is off the slice, whatever `pointAtScreen` finds here is a ghost.
    const found = await page.evaluate(
      ({ w, h }) => {
        const eng = window.__tetravox!.engine as unknown as {
          pointAtScreen(v: string, x: number, y: number): { pointId: string } | null;
        };
        for (let py = 4; py < h - 4; py += 2)
          for (let px = 4; px < w - 4; px += 2) {
            const hit = eng.pointAtScreen('axial', px, py);
            if (hit) return { px, py, pointId: hit.pointId };
          }
        return null;
      },
      { w: Math.round(cell.width), h: Math.round(cell.height) }
    );
    expect(found, 'a ghost is drawn in the axial pane').not.toBeNull();
    const ghost = layer.points.find((p) => p.id === found!.pointId)!;
    expect(ghost).toBeDefined();

    // It really is off the slice: farther than its own radius from the plane.
    const offSlice = await page.evaluate(
      ({ id, pid }) => {
        const eng = window.__tetravox!.engine as unknown as { scene: { cursor: number[] } };
        const layer = (window.__tetravox!.store.getState().layers ?? []).find(
          (l: { module?: string }) => l.module === id
        ) as unknown as { points: { id: string; position: number[] }[]; radiusMm: number };
        const cz = eng.scene.cursor[2]!;
        const p = layer.points.find((q) => q.id === pid)!;
        const nearest = Math.min(...layer.points.map((q) => Math.abs(q.position[2]! - cz)));
        return { own: Math.abs(p.position[2]! - cz), nearest, radius: layer.radiusMm };
      },
      { id: SEEG, pid: ghost.id }
    );
    expect(offSlice.nearest).toBeGreaterThan(offSlice.radius);

    // Send the dropdown to a DIFFERENT electrode, so following the ghost is a visible change.
    const other =
      ghost.group === first.group
        ? layer.points.find((p) => p.group !== ghost.group)!.group
        : first.group;
    await page.locator('[data-testid="seeg-electrode"]').selectOption(other);
    await expect(page.locator('[data-testid="seeg-electrode"]')).toHaveValue(other);

    // THE CLICK: a real mouse press on the canvas, over the ghost's pixel.
    await page.mouse.click(Math.round(cell.x + found!.px), Math.round(cell.y + found!.py));

    // 1. the ghost is the selection …
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const sel = (
            window.__tetravox!.engine as unknown as { pointSelection(): { pointId: string } | null }
          ).pointSelection();
          return sel?.pointId ?? null;
        })
      )
      .toBe(ghost.id);
    // 2. the dropdown and the list follow it …
    await expect(page.locator('[data-testid="seeg-electrode"]')).toHaveValue(ghost.group);
    await expect(page.locator(`[data-testid="seeg-row-${ghost.name}"]`)).toHaveAttribute(
      'data-selected',
      'true'
    );
    // 3. and the slice arrives at it: the module answers `selected` with a cursor jump (§13.3).
    const cursor = await page.evaluate(
      () => (window.__tetravox!.engine as unknown as { scene: { cursor: number[] } }).scene.cursor
    );
    for (const k of [0, 1, 2] as const) expect(cursor[k]).toBeCloseTo(ghost.position[k], 3);

    await page.screenshot({ path: join(SHOTS_DIR, 'c4-p077-ghost-click.png') });
  });

  test('the Size stepper changes the marker size', async () => {
    const size = page.locator('[data-testid="seeg-size"]');
    const drawn = async (): Promise<number | undefined> => (await readLayer(page)).dotRadiusPx;
    await expect(size).toHaveText('4');
    expect(await drawn()).toBe(4);
    await page.click('[data-testid="seeg-size-up"]');
    await page.click('[data-testid="seeg-size-up"]');
    await expect(size).toHaveText('6');
    expect(await drawn()).toBe(6);
    // Back to the default for the specs after this one.
    await page.click('[data-testid="seeg-size-down"]');
    await page.click('[data-testid="seeg-size-down"]');
    await expect(size).toHaveText('4');
  });

  test('the Wire toggle removes and restores the shaft lines', async () => {
    const wire = page.locator('[data-testid="seeg-wire"]');
    const segments = async (): Promise<number> => (await readLayer(page)).lineSegments?.length ?? 0;
    await expect(wire).toHaveAttribute('aria-pressed', 'true');
    expect(await segments()).toBe(402);
    await page.click('[data-testid="seeg-wire"]');
    await expect(wire).toHaveAttribute('aria-pressed', 'false');
    // Empty, not absent: a `Partial<Layer>` merge cannot unset a field (§4.4).
    expect(await segments()).toBe(0);
    await page.click('[data-testid="seeg-wire"]');
    await expect(wire).toHaveAttribute('aria-pressed', 'true');
    expect(await segments()).toBe(402);
  });

  test('a snap moves a selected contact toward the metal', async () => {
    const layer = await readLayer(page);
    // A mid-shaft contact, selected the way a pane click selects it (the engine call `#onDown` makes).
    const target = layer.points[40]!;
    const before = target.position;
    await page.evaluate(
      ({ id, pid }) => {
        const eng = window.__tetravox!.engine as unknown as {
          setPointSelection(s: { layerId: string; pointId: string }): void;
        };
        const layerId = (window.__tetravox!.store.getState().layers ?? []).find(
          (l: { module?: string }) => l.module === id
        )!.id;
        eng.setPointSelection({ layerId, pointId: pid });
      },
      { id: SEEG, pid: target.id }
    );
    await expect(page.locator('[data-testid="seeg-snap"]')).toBeEnabled();
    await page.click('[data-testid="seeg-snap"]');

    const after = await page.evaluate(
      ({ id, pid }) => {
        const layer = (window.__tetravox!.store.getState().layers ?? []).find(
          (l: { module?: string }) => l.module === id
        ) as unknown as { points: { id: string; position: number[] }[] };
        return layer.points.find((p) => p.id === pid)!.position;
      },
      { id: SEEG, pid: target.id }
    );
    const moved = Math.hypot(after[0]! - before[0], after[1]! - before[1], after[2]! - before[2]);
    // It moved, and toward metal rather than away — snap searches a small neighbourhood, so the step
    // is real but sub-voxel-to-a-few-mm, never a teleport.
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(6);
    await expect(page.locator('[data-testid="module-dirty"]')).toBeVisible();
  });

  test('Save writes the table, a timestamped backup and the editlog', async () => {
    // The Save sheet is OS-modal; main answers with the copy's own path (never the owner's original).
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path,
      })) as unknown as typeof dialog.showSaveDialog;
    }, sceneTsv);

    const before = readFileSync(sceneTsv, 'utf8');
    await page.click('[data-testid="seeg-save-as"]');
    await expect(page.locator('[data-testid="module-dirty"]')).toHaveCount(0, { timeout: 20_000 });

    const after = readFileSync(sceneTsv, 'utf8');
    expect(after).not.toBe(before);
    expect(after.includes('\r')).toBe(false);

    // Exactly one `.bak`, the table's, holding the bytes that were there before the save.
    const backups = readdirSync(sceneIeeg).filter((n) => n.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^sub-P077_space-T1w_electrodes\.tsv\.\d{8}-\d{6}\.bak$/);
    expect(readFileSync(join(sceneIeeg, backups[0]!), 'utf8')).toBe(before);

    // The editlog, under the name seegprep's `--force` guard globs for.
    const editlog = join(sceneIeeg, 'sub-P077_space-T1w_electrodes_editlog.json');
    expect(existsSync(editlog)).toBe(true);
    const log = JSON.parse(readFileSync(editlog, 'utf8')) as { n_contacts: number; tool: string };
    expect(log.n_contacts).toBe(82);
    expect(log.tool).toContain('Tetravox');

    await page.screenshot({ path: join(SHOTS_DIR, 'c4-p077-saved.png') });
  });
});
