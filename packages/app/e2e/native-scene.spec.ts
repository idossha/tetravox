/** Native scene requests cross real main/preload/controller IPC and produce receipts on disk.
 * Uses an isolated, forced-hidden real-engine app and the committed synthetic vol_u8 fixture.
 * Cursor values are authored input, compared with saved JSON; this is not a pixel assertion.
 * Run: pnpm --filter @tetravox/app exec playwright test --project=dev native-scene.spec.ts
 */
/* eslint-disable no-empty-pattern */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, clickAppMenu, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const VOLUME = join(resolve(APP_ROOT, '..', '..', 'testdata'), 'vol_u8.nii.gz');
const HIDDEN = { TETRAVOX_E2E_HEADED: '0', TETRAVOX_E2E_OFFSCREEN: '1' };
type Request = {
  protocol: 1;
  id: string;

  action: 'open-scene' | 'save-scene';
  path: string;
  expectedScenePath?: string;
  overwrite?: boolean;
};
function requestFile(root: string, body: Request): string {
  const directory = mkdtempSync(join(root, '.tetravox-request-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'request.json');
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}
async function receipt(path: string, body: Request): Promise<void> {
  const output = `${path}.receipt.json`;
  await expect.poll(() => existsSync(output), { timeout: 30_000 }).toBe(true);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
    protocol: 1,
    id: body.id,

    ok: true,
    path: body.path,
  });
}
async function ready(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
}
async function hidden(app: ElectronApplication): Promise<void> {
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
      }))
    )
  ).toEqual([{ visible: false, focused: false }]);
}
async function cursor(page: Page, text: string): Promise<void> {
  const input = page.locator('[data-testid="coord-input"]');
  await input.fill(text);
  await input.press('Enter');
}
async function deliver(app: ElectronApplication, path: string): Promise<void> {
  // Exercise the registered second-instance handler without starting a second process.
  // OS LaunchServices focus is deliberately a separate manual/platform gate.
  await app.evaluate(({ app: running }, requestPath) => {
    running.emit(
      'second-instance',
      {},
      [process.execPath, `--scene-request=${requestPath}`],
      process.cwd()
    );
  }, path);
}

test('cold open, edited live save and Dock-only recreation acknowledge real disk requests', async ({}, info) => {
  test.setTimeout(120_000); // Three real-engine window initializations, each bounded by readiness/receipt waits.
  const target = info.project.name as LaunchTarget;
  const blocked = target === 'packaged' ? packagedUnavailable() : null;
  test.skip(blocked !== null, blocked ?? '');
  test.skip(
    process.platform !== 'darwin',
    'Dock-only process survival is macOS-specific; this test verifies its whole cold/open/save sequence.'
  );
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tetravox-native-scene-e2e-')));
  const scenePath = join(root, 'My research scenes/source.tetravox.json');
  mkdirSync(dirname(scenePath), { recursive: true });
  const destination = join(dirname(scenePath), 'live.tetravox.json');
  let app: ElectronApplication | undefined;
  try {
    // Seed a valid scene using the normal controller save path, not a hand-retyped ViewSpec.
    app = await launchApp(target, {
      search: 'engine=real',
      args: [VOLUME],
      env: HIDDEN,
      userDataDir: join(root, 'seed-profile'),
    });
    let page = await app.firstWindow();
    await ready(page);
    await page.waitForFunction(() => window.__tetravox?.store.getState().layers.length === 1);
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: path,
      })) as typeof dialog.showSaveDialog;
    }, scenePath);
    await cursor(page, '1 2 3');
    await clickAppMenu(page, 'save-as');
    await expect.poll(() => existsSync(scenePath)).toBe(true);
    await hidden(app);
    await app.close();
    app = undefined;
    const original = readFileSync(scenePath, 'utf8');
    const datasetOriginal = readFileSync(VOLUME);
    const opening: Request = {
      protocol: 1,
      id: randomBytes(16).toString('hex'),
      action: 'open-scene',
      path: scenePath,
    };
    const openingPath = requestFile(root, opening);
    app = await launchApp(target, {
      search: 'engine=real',
      args: [`--scene-request=${openingPath}`],
      env: HIDDEN,
      userDataDir: join(root, 'viewer-profile'),
    });
    page = await app.firstWindow();
    await ready(page);
    await receipt(openingPath, opening);
    expect(await page.evaluate(() => window.__tetravox?.store.getState().layers.length)).toBe(1);
    await hidden(app);
    await cursor(page, '7 -3 11');
    const saving: Request = {
      ...opening,
      id: randomBytes(16).toString('hex'),
      action: 'save-scene',
      path: destination,
      expectedScenePath: scenePath,
    };
    const savingPath = requestFile(root, saving);
    await deliver(app, savingPath);
    await receipt(savingPath, saving);
    expect(JSON.parse(readFileSync(destination, 'utf8'))).toMatchObject({ cursor: [7, -3, 11] });
    expect(JSON.parse(readFileSync(destination, 'utf8')).layers).toHaveLength(1);
    expect(readFileSync(scenePath, 'utf8')).toBe(original);
    // An acknowledged API open is also the user's native Save destination, without Save As.
    await cursor(page, '2 4 6');
    await clickAppMenu(page, 'save');
    await expect.poll(() => JSON.parse(readFileSync(scenePath, 'utf8')).cursor).toEqual([2, 4, 6]);
    expect(await page.evaluate(() => window.__tetravox?.store.getState().sceneDirty)).toBe(false);
    expect(readFileSync(VOLUME)).toEqual(datasetOriginal);
    expect(JSON.parse(readFileSync(destination, 'utf8')).cursor).toEqual([7, -3, 11]);
    await hidden(app);
    // Destroy only this fixture's window. macOS leaves the process alive just as closing its final window does.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.destroy();
    });
    await expect
      .poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0);
    const reopening: Request = {
      ...opening,
      id: randomBytes(16).toString('hex'),
    };
    const reopeningPath = requestFile(root, reopening);
    const newWindow = app.waitForEvent('window');
    await deliver(app, reopeningPath);
    page = await newWindow;
    await ready(page);
    await receipt(reopeningPath, reopening);
    expect(await page.evaluate(() => window.__tetravox?.store.getState().layers.length)).toBe(1);
    await hidden(app);
  } finally {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
