/** §7.5 / §8: direct slice selection, origin reset, and capture controls without scrolling. */
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchOptions, LaunchTarget } from './fixtures';

function launchViewer(options: LaunchOptions) {
  const target = test.info().project.name as LaunchTarget;
  const unavailable = target === 'packaged' ? packagedUnavailable() : null;
  test.skip(unavailable !== null, unavailable ?? '');
  return launchApp(target, options);
}

const realData = process.env['TETRAVOX_TESTDATA'];
for (const [name, volume] of [
  ['synthetic', resolve(APP_ROOT, '../../testdata/vol_u8.nii.gz')],
  ['ernie T1', realData === undefined ? undefined : resolve(realData, 'm2m_ernie/T1.nii.gz')],
] as const) {
  test(`direct views preserve the cursor; Reset reaches world origin (${name}, real engine)`, async () => {
    test.skip(volume === undefined, 'Set TETRAVOX_TESTDATA to exercise the subject T1.');
    const app = await launchViewer({
      search: 'engine=real',
      args: [volume!],
    });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(
        () => (window.__tetravox?.store.getState().layers.length ?? 0) > 0
      );
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const input = page.getByTestId('coord-input');
      await input.fill('10 20 30');
      await input.press('Enter');
      const before = await page.evaluate(() => {
        const scene = window.__tetravox!.engine!.scene;
        return { slices: scene.slices, layers: scene.layers };
      });
      await expect(page.getByTestId('layout-3d+1')).toHaveCount(0);
      for (const mode of ['sagittal', 'coronal', 'axial']) {
        await page.getByTestId(`view-${mode}`).click();
        await expect(page.getByTestId(`view-${mode}`)).toHaveAttribute('aria-pressed', 'true');
        expect(
          await page.evaluate(() => {
            const scene = window.__tetravox!.engine!.scene;
            return {
              kind: scene.layout.kind,
              modes: scene.layout.cells.map((id) => scene.slices.find((s) => s.id === id)?.mode),
              cursor: scene.cursor,
              slices: scene.slices,
            };
          })
        ).toEqual({ kind: '1x1', modes: [mode], cursor: [10, 20, 30], slices: before.slices });
      }
      await page.getByTestId('layout-2x2').click();
      for (const action of ['button', 'Home']) {
        await input.fill('-42 18 6');
        await input.press('Enter');
        if (action === 'button') await page.getByTestId('reset-all').click();
        else {
          await input.blur();
          await page.keyboard.press('Home');
        }
        await expect(input).toHaveValue('0.0 0.0 0.0');
        expect(
          await page.evaluate(() => {
            const tv = window.__tetravox!;
            tv.engine!.renderNow();
            return {
              scene: tv.engine!.scene.cursor,
              ui: tv.store.getState().cursor,
              layers: tv.engine!.scene.layers,
            };
          })
        ).toEqual({ scene: [0, 0, 0], ui: [0, 0, 0], layers: before.layers });
      }
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
}

test('all screenshot targets fit the minimum window without scrolling (§8)', async () => {
  const app = await launchViewer({ search: 'engine=mock' });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const [width, height] of [
      [960, 600],
      [1400, 900],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0]!.setContentSize(size[0]!, size[1]!),
        [width!, height!]
      );
      await page.getByTestId('screenshot-menu').click();
      for (const target of ['grid', 'view', 'figure']) {
        await page.getByTestId('screenshot-target').selectOption(target);
        await page.getByTestId('screenshot-width').fill('96');
        await page.getByTestId('screenshot-height').fill('64');
        await page.getByTestId('screenshot-preview').click();
        await expect(page.getByTestId('screenshot-preview')).toBeEnabled();
        await expect(page.getByTestId('screenshot-preview-image')).toBeVisible();
        await page.waitForFunction(
          () =>
            (document.querySelector('[data-testid="screenshot-preview-image"]') as HTMLImageElement)
              ?.complete === true
        );
        const overflow = await page.getByTestId('screenshot-dialog').evaluate((dialog) =>
          [dialog, ...Array.from(dialog.querySelectorAll<HTMLElement>('*'))]
            .filter(
              (element) =>
                element.clientWidth > 0 &&
                element.clientHeight > 0 &&
                (element.scrollWidth > element.clientWidth + 1 ||
                  element.scrollHeight > element.clientHeight + 1)
            )
            .map((element) => ({
              tag: element.tagName,
              id: element.getAttribute('data-testid'),
              class: element.className,
              width: [element.clientWidth, element.scrollWidth],
              height: [element.clientHeight, element.scrollHeight],
            }))
        );
        expect(overflow, `${width}×${height}, ${target}`).toEqual([]);
        await expect(page.getByTestId('screenshot-save')).toBeInViewport({ ratio: 1 });
        await expect(page.getByTestId('screenshot-preview-pane')).toBeInViewport({ ratio: 1 });
      }
      await page.screenshot({ path: test.info().outputPath(`capture-${width}x${height}.png`) });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('screenshot-dialog')).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('layer controls fit the left sidebar without horizontal scrolling (§8)', async () => {
  const app = await launchViewer({
    search: 'engine=real',
    args: [
      resolve(APP_ROOT, '../../testdata/vol_u8.nii.gz'),
      resolve(APP_ROOT, '../../testdata/mesh_v2_binary.msh'),
    ],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => (window.__tetravox?.store.getState().layers.length ?? 0) >= 2);
    for (const width of [960, 1400]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900),
        width
      );
      if (width === 960) await page.getByTestId('left-panel-expand').click();
      const list = page.getByTestId('layer-list');
      expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const outside = await list.evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll('input,select,button'))
          .filter((control) => {
            const r = control.getBoundingClientRect();
            return (
              r.width > 0 &&
              (r.right > bounds.left + el.clientWidth + 1 || r.left < bounds.left - 1)
            );
          })
          .map((control) => control.getAttribute('data-testid'));
      });
      expect(outside).toEqual([]);
    }
  } finally {
    await app.close();
  }
});
