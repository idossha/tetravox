/**
 * **The Extensions dialog in the shipped build** (ARCHITECTURE.md §13.8), driven through the real
 * dialog rather than through IPC.
 *
 * `extensions.spec.ts` runs the whole install→consent→enable→activate→disable→remove round trip, but
 * only on the **dev** target, because the CSP claim it rests on is the packaged build's and
 * `csp.spec.ts` owns that leg. This spec is the two things that are only true in a *packaged* build
 * and cannot be seen anywhere else:
 *
 *  1. **The bundled sEEG card, from the SHIPPED catalogue.** A packaged `.dmg` carries
 *     `tetravox.seeg` under `Contents/Resources/modules/` (`scripts/fetch-locked-modules.mjs`,
 *     `electron-builder.yml`'s `extraResources`), and `src/shared/extensions-index.json` — the copy
 *     the build ships — lists it. So with a **clean** `TETRAVOX_HOME` and no network, the dialog
 *     draws a real card that is `Bundled`, pre-consented and `Enabled ✓`, with no Remove button
 *     (a bundled module is not the user's to delete). This is the offline-correct catalogue.
 *
 *  2. **The download path, in the shipped build.** A packaged build ignores the `TETRAVOX_MODULE_DIR`
 *     / `TETRAVOX_EXT_INDEX` seams unless `TETRAVOX_E2E=1` opts back in (`module-store.ts`
 *     `envSeamsAllowed`, the `csp.spec.ts` seam). With it, a second, non-bundled fixture module is
 *     served from a `file://` release store and a fixture index, and the whole gesture — Download &
 *     enable → the consent sheet with the manifest-derived permissions → Enable → the switcher → the
 *     module's own panel built with the host's React — runs against the real `.app`, the real
 *     `tetravox://module` map and the real CSP, not a dev server.
 *
 * The fixture bundle (`e2e/fixtures/tetravox.fixture/`) is the same checked-in emitted artefact
 * `extensions.spec.ts` and `csp.spec.ts` use: zero imports, the SDK shim inlined.
 */

/* eslint-disable no-empty-pattern */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  APP_ROOT,
  bundledSeegVersion,
  launchApp,
  packagedUnavailable,
  SHOTS_DIR,
} from './fixtures';

const FIXTURES = resolve(APP_ROOT, 'e2e', 'fixtures');
const FIXTURE_ID = 'tetravox.fixture';
const FIXTURE_VERSION = '1.0.0';
const SEEG_ID = 'tetravox.seeg';
const SEEG_VERSION = bundledSeegVersion();

/** The bundled sEEG tree the packaging step copies into the `.app` — its presence in the dev tree is
 *  the same proxy `module-seeg.spec.ts` uses for "the packaged build shipped it". */
const SEEG_BUNDLE = resolve(APP_ROOT, 'resources', 'modules', SEEG_ID, SEEG_VERSION, 'index.js');

/** `paletteColor(0)` is `[0.9, 0.1, 0.1, 1]`, so `cssColor` is `#e61a1a` — computed, not copied. */
const SWATCH_0 = '#e61a1a';

const temporaryDirectories: string[] = [];
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tetravox-extp-${name}-`));
  temporaryDirectories.push(dir);
  return dir;
}

interface StoredFile {
  name: string;
  bytes: number;
  sha256: string;
  url: string;
}

/** Stage the fixture module as a release store: every asset named by its own sha256 (a `file://`
 *  store `net.fetch` can reach), exactly `extensions.spec.ts`'s `stageStore`. */
function stageStore(sourceDir: string, names: readonly string[]): StoredFile[] {
  const dir = temp('store');
  const files: StoredFile[] = [];
  for (const name of names) {
    const bytes = readFileSync(join(sourceDir, name));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    copyFileSync(join(sourceDir, name), join(dir, sha256));
    files.push({
      name,
      bytes: bytes.length,
      sha256,
      url: pathToFileURL(join(dir, sha256)).toString(),
    });
  }
  return files;
}

/** A one-module catalogue in the registry index's schema, pointing at the staged store. */
function writeIndex(files: readonly StoredFile[]): string {
  const dir = temp('index');
  const path = join(dir, 'index.json');
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      generated: '2026-08-31T00:00:00Z',
      modules: [
        {
          id: FIXTURE_ID,
          title: 'Fixture extension',
          summary: 'A module that arrives from outside the build.',
          repo: 'https://example.invalid/tetravox-fixture',
          author: 'tetravox',
          licence: 'MIT',
          docs: 'https://example.invalid/tetravox-fixture#readme',
          versions: [
            { version: FIXTURE_VERSION, hostApi: 1, published: '2026-08-31', files: [...files] },
          ],
        },
      ],
    })
  );
  return path;
}

/** Open the dialog the way a user does: the switcher's one non-module row (File ▸ Extensions…). */
async function openExtensionsDialog(page: Page): Promise<void> {
  await page.click('[data-testid="module-switcher"]');
  await page.click('[data-testid="module-switcher-manage"]');
  await expect(page.locator('[data-testid="extensions-dialog"]')).toBeVisible();
}

test.describe('the Extensions dialog, packaged', () => {
  // Packaged only: the bundled card and the CSP-governed download are both the shipped build's
  // claims. On the dev target this whole file is `extensions.spec.ts` seen from a dev server.
  test.beforeAll(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'packaged', 'the packaged target only');
    const blocked = packagedUnavailable();
    test.skip(blocked !== null, blocked ?? '');
    // The cheap CI leg packages after `fetch-locked-modules --verify-only`, so its `.app` has no
    // sEEG; skip rather than fail there, exactly as `module-seeg.spec.ts` does.
    test.skip(
      !existsSync(SEEG_BUNDLE),
      'the bundled tetravox.seeg is not in resources/modules — run `node scripts/fetch-locked-modules.mjs`'
    );
  });

  test.afterAll(() => {
    for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test.setTimeout(180_000);

  test('the SHIPPED catalogue draws the bundled sEEG card: Bundled, pre-consented, Enabled', async () => {
    const home = temp('home-seeg');
    const app = await launchApp('packaged', {
      // No `TETRAVOX_EXT_INDEX`: the shipped `extensions-index.json` is the catalogue, and no
      // network is touched. A clean `TETRAVOX_HOME` means the bundle is freshly discovered and
      // pre-consented at this boot rather than by a previous session.
      search: 'engine=mock&mockStepMs=0',
      env: { TETRAVOX_HOME: home },
    });
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });

    await openExtensionsDialog(page);
    const card = page.locator(`[data-testid="extension-card-${SEEG_ID}"]`);
    await expect(card).toBeVisible();
    // Bundled ⇒ discovered on disk, pre-consented, its files on the protocol map: the card is enabled.
    await expect(card).toHaveAttribute('data-state', 'enabled');
    await expect(page.locator(`[data-testid="extension-bundled-${SEEG_ID}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="extension-enabled-${SEEG_ID}"]`)).toBeVisible();
    await expect(card).toContainText('sEEG contacts');
    // No install/enable button (already enabled) and no Remove button (a bundled module is not the
    // user's to delete — `module-store.ts#removeModule` refuses it, so the dialog offers no door).
    await expect(page.locator(`[data-testid="extension-install-${SEEG_ID}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="extension-enable-${SEEG_ID}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="extension-remove-${SEEG_ID}"]`)).toHaveCount(0);
    // Its files really are served: the shipped build put the bundle on the map.
    const status = await page.evaluate(
      async (url) => (await fetch(url)).status,
      `tetravox://module/${SEEG_ID}/${SEEG_VERSION}/index.js`
    );
    expect(status).toBe(200);

    await page.screenshot({ path: join(SHOTS_DIR, 'c4-seeg-card.png') });
    await app.close();
  });

  test('a non-bundled module downloads, consents and enables through the dialog', async () => {
    const files = stageStore(join(FIXTURES, FIXTURE_ID), ['index.js', 'manifest.json']);
    const indexPath = writeIndex(files);
    const modules = temp('modules');
    const home = temp('home-fixture');

    const app = await launchApp('packaged', {
      search: 'engine=mock&mockStepMs=0',
      // `TETRAVOX_E2E=1` reopens the dev/E2E seams in the packaged build (`envSeamsAllowed`); a
      // shipped build with it unset ignores both `TETRAVOX_MODULE_DIR` and `TETRAVOX_EXT_INDEX` and
      // reads its real store and shipped catalogue.
      env: {
        TETRAVOX_MODULE_DIR: modules,
        TETRAVOX_EXT_INDEX: indexPath,
        TETRAVOX_HOME: home,
        TETRAVOX_E2E: '1',
      },
    });
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });

    await openExtensionsDialog(page);
    const card = page.locator(`[data-testid="extension-card-${FIXTURE_ID}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-state', 'available');
    await expect(page.locator(`[data-testid="extension-install-${FIXTURE_ID}"]`)).toHaveText(
      'Download & enable'
    );
    await page.screenshot({ path: join(SHOTS_DIR, 'c4-fixture-available.png') });

    // Nothing enabled ⇒ nothing on the protocol map: the module's own entry 404s though its card is
    // on screen. Consent gates execution, not the listing.
    const before = await page.evaluate(
      async (url) => (await fetch(url)).status,
      `tetravox://module/${FIXTURE_ID}/${FIXTURE_VERSION}/index.js`
    );
    expect(before).toBe(404);

    // Download & verify (a `file://` release store), then the consent sheet.
    await page.click(`[data-testid="extension-install-${FIXTURE_ID}"]`);
    const sheet = page.locator(`[data-testid="extension-consent-${FIXTURE_ID}"]`);
    await expect(sheet).toBeVisible();
    await expect(page.locator('[data-testid="extension-consent-version"]')).toHaveText(
      FIXTURE_VERSION
    );
    await expect(page.locator('[data-testid="extension-consent-repo"]')).toHaveAttribute(
      'href',
      'https://example.invalid/tetravox-fixture'
    );
    // The permissions are `derivePermissions` reading the manifest — one schema, no second source.
    const permissions = page.locator('[data-testid="extension-consent-permissions"]');
    await expect(permissions).toContainText('Read .tsv files you choose');
    await expect(permissions).toContainText('Bind the keys g');
    await expect(permissions).toContainText('Run from a job file: ping');
    await expect(permissions).toContainText('Store its own data inside a saved scene');
    await page.screenshot({ path: join(SHOTS_DIR, 'c4-fixture-consent.png') });

    // Installed is not enabled: the files are on disk and still unreachable.
    expect(existsSync(join(modules, FIXTURE_ID, FIXTURE_VERSION, 'index.js'))).toBe(true);
    const installedNotEnabled = await page.evaluate(
      async (url) => (await fetch(url)).status,
      `tetravox://module/${FIXTURE_ID}/${FIXTURE_VERSION}/index.js`
    );
    expect(installedNotEnabled).toBe(404);

    // Consent → enabled, and only now reachable.
    await page.click('[data-testid="extension-consent-accept"]');
    await expect(sheet).toBeHidden();
    await expect(card).toHaveAttribute('data-state', 'enabled');
    await expect(page.locator(`[data-testid="extension-enabled-${FIXTURE_ID}"]`)).toBeVisible();
    const afterConsent = await page.evaluate(
      async (url) => (await fetch(url)).status,
      `tetravox://module/${FIXTURE_ID}/${FIXTURE_VERSION}/index.js`
    );
    expect(afterConsent).toBe(200);
    await page.click('[data-testid="extensions-close"]');

    // The switcher, and the module's own panel — built with the HOST's React off the SDK global.
    await page.click('[data-testid="module-switcher"]');
    const row = page.locator(`[data-testid="module-switcher-${FIXTURE_ID}"]`);
    await expect(row).toBeVisible();
    await row.click();
    const slot = page.locator(`[data-testid="module-slot"][data-module="${FIXTURE_ID}"]`);
    await expect(slot).toBeVisible();
    await expect(page.locator('[data-testid="fixture-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="fixture-host-version"]')).toHaveText('host API 1');
    await expect(page.locator('[data-testid="fixture-swatch-0"]')).toHaveText(SWATCH_0);
    await page.screenshot({ path: join(SHOTS_DIR, 'c4-fixture-panel.png') });

    await app.close();
  });
});
