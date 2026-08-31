/**
 * **A downloadable extension, end to end** (ARCHITECTURE.md §13.8, `main/module-store.ts`,
 * `renderer/src/modules/installed.ts`, `dialogs/ExtensionsDialog.tsx`).
 *
 * `csp.spec.ts` proves the *negative* half — with nothing installed, every URL under the new host
 * 404s, and a script element under it is admitted by the policy and then fails on the 404. This
 * spec is the positive half, and it is the only test that can be: it needs a real Electron, a real
 * `tetravox://module` map, a real preload bridge and a real React tree, and every one of those is
 * absent under vitest.
 *
 * What it drives, in one launch: the catalogue renders from a **fixture index** (`TETRAVOX_EXT_INDEX`,
 * `sample-data.spec.ts`'s discipline — a local store and no network), install downloads and verifies
 * from a `file://` URL, the consent sheet appears with the permissions **derived from the manifest**,
 * enabling puts the module in the switcher, activating it renders its own panel — built with the
 * *host's* React, off `globalThis.__tetravoxModuleSdk` — disabling takes it back out, and removing
 * deletes it from disk.
 *
 * Two more claims sit beside it because they are the same feature seen from elsewhere: a `--job`
 * naming a module that is installed but **not consented** fails validation with the sentence that
 * says how to fix it (settled decision O4), and a module whose `hostApi` this build does not
 * implement is listed and greyed rather than hidden — "needs a newer Tetravox" is an answer and an
 * absent card is not.
 *
 * The fixture module (`e2e/fixtures/tetravox.fixture/`) is checked in as an **emitted artefact**:
 * zero imports, the SDK shim inlined, using `contacts.paletteColor` through the SDK global. That is
 * what a module repository's `rollup -c` produces, and no module repository exists yet.
 */

/* eslint-disable no-empty-pattern */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { APP_ROOT, launchApp } from './fixtures';

const FIXTURES = resolve(APP_ROOT, 'e2e', 'fixtures');
const FIXTURE_ID = 'tetravox.fixture';
const FIXTURE_VERSION = '1.0.0';
const FUTURE_ID = 'tetravox.future';

/** `paletteColor(0)` is `[0.9, 0.1, 0.1, 1]`, so `cssColor` is `#e61a1a` — computed, not copied. */
const SWATCH_0 = '#e61a1a';

const temporaryDirectories: string[] = [];

function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tetravox-ext-${name}-`));
  temporaryDirectories.push(dir);
  return dir;
}

interface StoredFile {
  name: string;
  bytes: number;
  sha256: string;
  url: string;
}

/**
 * Stage the fixture module as a **release store**: every asset named by its own sha256.
 *
 * `scripts/sample-data/publish.sh`'s layout verbatim — "an asset's content is its name, so
 * re-uploading can only ever be a no-op or a mistake" — and what lets a download be verified against
 * its own URL. `file://` rather than `http://` because `net.fetch` reaches it and a spec that needed
 * a server would be a spec that could fail for a reason that is not the app's.
 */
function stageStore(
  sourceDir: string,
  names: readonly string[]
): { dir: string; files: StoredFile[] } {
  const dir = temp('store');
  const files: StoredFile[] = [];
  for (const name of names) {
    const from = join(sourceDir, name);
    const bytes = readFileSync(from);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    copyFileSync(from, join(dir, sha256));
    files.push({
      name,
      bytes: bytes.length,
      sha256,
      url: pathToFileURL(join(dir, sha256)).toString(),
    });
  }
  return { dir, files };
}

/** A one-module catalogue, in the registry index's own schema. */
function writeIndex(files: readonly StoredFile[]): string {
  const dir = temp('index');
  const path = join(dir, 'index.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        schema: 1,
        generated: '2026-08-30T00:00:00Z',
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
              { version: FIXTURE_VERSION, hostApi: 1, published: '2026-08-30', files: [...files] },
            ],
          },
        ],
      },
      null,
      2
    )
  );
  return path;
}

/** Open the dialog the way a user does: the switcher's one non-module row. */
async function openExtensionsDialog(page: Page): Promise<void> {
  await page.click('[data-testid="module-switcher"]');
  await page.click('[data-testid="module-switcher-manage"]');
  await expect(page.locator('[data-testid="extensions-dialog"]')).toBeVisible();
}

test.describe('downloadable extensions', () => {
  // The dev target only. `packaged` is where the **CSP** claim has to be proved, and `csp.spec.ts`
  // owns that leg; repeating this whole round trip there would double a two-minute spec for
  // coverage of the same renderer code.
  test.beforeAll(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'dev', 'the dev target only');
  });

  test.afterAll(() => {
    for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test.setTimeout(180_000);

  test('catalogue → install → consent → enable → activate → disable → remove', async () => {
    const { files } = stageStore(join(FIXTURES, FIXTURE_ID), ['index.js', 'manifest.json']);
    const indexPath = writeIndex(files);
    const modules = temp('modules');
    const home = temp('home');

    const app = await launchApp('dev', {
      // `modules=hello` only so the switcher exists before anything is installed: it renders no
      // control at all in a build offering no module, which is what keeps the toolbar byte-identical
      // in a default launch. The fixture module is what this spec is about.
      search: 'engine=mock&mockStepMs=0&modules=hello',
      env: {
        TETRAVOX_MODULE_DIR: modules,
        TETRAVOX_EXT_INDEX: indexPath,
        TETRAVOX_HOME: home,
      },
    });
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });

    // ---- the catalogue, from main, with nothing installed ---------------------------------------
    await openExtensionsDialog(page);
    await expect(page.locator('[data-testid="extension-dir"]')).toContainText(resolve(modules));
    const card = page.locator(`[data-testid="extension-card-${FIXTURE_ID}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-state', 'available');
    await expect(page.locator(`[data-testid="extension-install-${FIXTURE_ID}"]`)).toHaveText(
      'Download & enable'
    );
    // Nothing is enabled, so nothing is on the protocol map: the scheme 404s the module's own entry
    // even though its card is on screen. Consent gates execution, not the listing.
    const before = await page.evaluate(
      async (url) => (await fetch(url)).status,
      `tetravox://module/${FIXTURE_ID}/${FIXTURE_VERSION}/index.js`
    );
    expect(before).toBe(404);

    // ---- install: a download, verified against the catalogue's own hashes -----------------------
    await page.click(`[data-testid="extension-install-${FIXTURE_ID}"]`);

    // ---- the consent sheet, with the permissions DERIVED from the manifest ----------------------
    const sheet = page.locator(`[data-testid="extension-consent-${FIXTURE_ID}"]`);
    await expect(sheet).toBeVisible();
    await expect(page.locator('[data-testid="extension-consent-version"]')).toHaveText(
      FIXTURE_VERSION
    );
    await expect(page.locator('[data-testid="extension-consent-repo"]')).toHaveAttribute(
      'href',
      'https://example.invalid/tetravox-fixture'
    );
    const permissions = page.locator('[data-testid="extension-consent-permissions"]');
    // Each line is `derivePermissions` reading one part of the manifest: `readers[].extensions`,
    // `commands[].key`, `operations[].id`, `sceneBlock`. One schema, no second source of truth.
    await expect(permissions).toContainText('Read .tsv files you choose');
    await expect(permissions).toContainText('Bind the keys g');
    await expect(permissions).toContainText('Run from a job file: ping');
    await expect(permissions).toContainText('Store its own data inside a saved scene');

    // Installing is not enabling: the files are on disk and still unreachable.
    expect(existsSync(join(modules, FIXTURE_ID, FIXTURE_VERSION, 'index.js'))).toBe(true);
    expect(existsSync(join(modules, FIXTURE_ID, FIXTURE_VERSION, 'tetravox-module.json'))).toBe(
      true
    );
    const installedNotEnabled = await page.evaluate(
      async (url) => (await fetch(url)).status,
      `tetravox://module/${FIXTURE_ID}/${FIXTURE_VERSION}/index.js`
    );
    expect(installedNotEnabled).toBe(404);

    // ---- consent ---------------------------------------------------------------------------------
    await page.click('[data-testid="extension-consent-accept"]');
    await expect(sheet).toBeHidden();
    await expect(card).toHaveAttribute('data-state', 'enabled');
    await expect(page.locator(`[data-testid="extension-enabled-${FIXTURE_ID}"]`)).toBeVisible();
    // …and only now is it reachable. This is the whole claim: consent gates execution.
    const afterConsent = await page.evaluate(
      async (url) => (await fetch(url)).status,
      `tetravox://module/${FIXTURE_ID}/${FIXTURE_VERSION}/index.js`
    );
    expect(afterConsent).toBe(200);

    await page.click('[data-testid="extensions-close"]');

    // ---- the switcher, and the module's own panel -------------------------------------------------
    await page.click('[data-testid="module-switcher"]');
    const row = page.locator(`[data-testid="module-switcher-${FIXTURE_ID}"]`);
    await expect(row).toBeVisible();
    await row.click();

    const slot = page.locator(`[data-testid="module-slot"][data-module="${FIXTURE_ID}"]`);
    await expect(slot).toBeVisible();
    await expect(page.locator('[data-testid="fixture-panel"]')).toBeVisible();
    // The panel rendered, which means the bundle got the **host's** React off the SDK global — a
    // second copy would be an "invalid hook call" and no panel at all.
    await expect(page.locator('[data-testid="fixture-host-version"]')).toHaveText('host API 1');
    // …and the shared contacts kit came through the same doorway. `#e61a1a` is `paletteColor(0)`
    // computed from `CONTACT_PALETTE[0]`, not copied off a screen.
    await expect(page.locator('[data-testid="fixture-swatch-0"]')).toHaveText(SWATCH_0);

    // ---- disable: out of the slot, out of the switcher, off the map --------------------------------
    await openExtensionsDialog(page);
    await page.click(`[data-testid="extension-disable-${FIXTURE_ID}"]`);
    await expect(card).toHaveAttribute('data-state', 'installed');
    await page.click('[data-testid="extensions-close"]');
    await expect(slot).toBeHidden();
    await page.click('[data-testid="module-switcher"]');
    await expect(page.locator(`[data-testid="module-switcher-${FIXTURE_ID}"]`)).toHaveCount(0);
    await page.keyboard.press('Escape');

    const afterDisable = await page.evaluate(
      async (url) => (await fetch(url)).status,
      `tetravox://module/${FIXTURE_ID}/${FIXTURE_VERSION}/index.js`
    );
    expect(afterDisable).toBe(404);

    // ---- remove: gone from disk, back to "Download & enable" ---------------------------------------
    await openExtensionsDialog(page);
    await page.click(`[data-testid="extension-remove-${FIXTURE_ID}"]`);
    await expect(card).toHaveAttribute('data-state', 'available');
    await expect(page.locator(`[data-testid="extension-install-${FIXTURE_ID}"]`)).toHaveText(
      'Download & enable'
    );
    expect(existsSync(join(modules, FIXTURE_ID))).toBe(false);

    await app.close();
  });

  test('a module whose host API this build does not implement is listed, greyed and unusable', async () => {
    // Placed on disk rather than installed: `installModule` refuses a catalogue entry whose
    // `hostApi` this build cannot run, so the only way to *have* one is to already have it — which
    // is exactly what happens when a user updates Tetravox rather than the extension.
    const modules = temp('modules-future');
    const home = temp('home-future');
    const dir = join(modules, FUTURE_ID, '2.0.0');
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(FIXTURES, FUTURE_ID, 'manifest.json'), join(dir, 'manifest.json'));

    const app = await launchApp('dev', {
      search: 'engine=mock&mockStepMs=0&modules=hello',
      env: { TETRAVOX_MODULE_DIR: modules, TETRAVOX_HOME: home },
    });
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });

    await openExtensionsDialog(page);
    const card = page.locator(`[data-testid="extension-card-${FUTURE_ID}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-state', 'incompatible');
    await expect(card).toHaveClass(/opacity-50/);
    await expect(page.locator(`[data-testid="extension-incompatible-${FUTURE_ID}"]`)).toHaveText(
      'needs Tetravox host API 2'
    );
    // No door in: neither the install button nor the enable button exists for it.
    await expect(page.locator(`[data-testid="extension-install-${FUTURE_ID}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="extension-enable-${FUTURE_ID}"]`)).toHaveCount(0);

    // …and it never reaches the switcher, because a registration is built only for an enabled,
    // compatible module (`renderer/src/modules/installed.ts`).
    await page.click('[data-testid="extensions-close"]');
    await page.click('[data-testid="module-switcher"]');
    await expect(page.locator(`[data-testid="module-switcher-${FUTURE_ID}"]`)).toHaveCount(0);

    await app.close();
  });

  test('a job naming an installed but unconsented module is refused, with the click that fixes it', async () => {
    // Settled decision O4, from the side that has no dialog to show. The manifest is on disk, so
    // main *knows the name* — hiding it would turn "installed but not enabled" into the much worse
    // "no such module" — and the refusal is `validateJob`'s, before a window exists.
    const modules = temp('modules-job');
    const home = temp('home-job');
    const dir = join(modules, FIXTURE_ID, FIXTURE_VERSION);
    mkdirSync(dir, { recursive: true });
    for (const name of ['index.js', 'manifest.json']) {
      copyFileSync(join(FIXTURES, FIXTURE_ID, name), join(dir, name));
    }
    // The receipt an install would have written, so the directory is an installation rather than a
    // pile of files. It is never checked here: consent is refused before verification is reached.
    writeFileSync(
      join(dir, 'tetravox-module.json'),
      JSON.stringify(
        {
          schema: 1,
          id: FIXTURE_ID,
          version: FIXTURE_VERSION,
          installedAt: '2026-08-30T00:00:00.000Z',
          files: ['index.js', 'manifest.json'].map((name) => ({
            name,
            bytes: statSync(join(dir, name)).size,
            sha256: createHash('sha256')
              .update(readFileSync(join(dir, name)))
              .digest('hex'),
          })),
        },
        null,
        2
      )
    );

    const run = temp('job');
    const outDir = join(run, 'out');
    mkdirSync(outDir, { recursive: true });
    const jobPath = join(run, 'job.json');
    writeFileSync(
      jobPath,
      JSON.stringify({
        scene: {
          files: [resolve(APP_ROOT, '..', '..', 'testdata', 'vol_u8.nii.gz')],
          preset: 'plain',
        },
        window: { width: 400, height: 300 },
        actions: [{ type: 'module', module: FIXTURE_ID, op: 'ping', args: {} }],
      })
    );

    const electron = resolve(APP_ROOT, '..', '..', 'node_modules', '.bin', 'electron');
    const outcome = await new Promise<{ code: number; stderr: string }>((done) => {
      const child = spawn(
        electron,
        [
          APP_ROOT,
          `--user-data-dir=${join(run, 'profile')}`,
          ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
          '--job',
          jobPath,
          '--out',
          outDir,
        ],
        {
          cwd: APP_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, TETRAVOX_MODULE_DIR: modules, TETRAVOX_HOME: home },
        }
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.stdout.on('data', () => {});
      child.on('close', (code) => done({ code: code ?? -1, stderr }));
    });

    expect(outcome.code).not.toBe(0);
    const result = JSON.parse(readFileSync(join(outDir, 'job-result.json'), 'utf8')) as {
      ok: boolean;
      errors: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(
      `${FIXTURE_ID} is installed but not enabled — open File ▸ Extensions…, enable it, and run this job again`
    );
  });

  test('the checked-in fixture bundle is what a module release really is: no imports at all', () => {
    // The module repository's own CI check (`scripts/module-sdk/README.md`), run here because the
    // fixture is the stand-in for a module repository until one exists. If this bundle ever grew an
    // import, the round trip above would fail with a specifier error and no diagnosis.
    const source = readFileSync(join(FIXTURES, FIXTURE_ID, 'index.js'), 'utf8');
    const bad = source.match(/^\s*(?:import\b.*|export\b.*\bfrom\b.*)$/gm) ?? [];
    expect(bad).toEqual([]);
    expect(source).toContain('globalThis.__tetravoxModuleSdk');
    // …and it really is one file: the loader imports `index.js` and nothing else is served beside it.
    expect(readdirSync(join(FIXTURES, FIXTURE_ID)).sort()).toEqual(['index.js', 'manifest.json']);
  });
});
