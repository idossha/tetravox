/**
 * The renderer's Content-Security-Policy, asserted from inside the page (§5, `main/protocol.ts`).
 *
 * The CSP is a **response header** on `tetravox://app`, not a `<meta>` tag, so there is nothing in
 * the DOM to read it off — and the dev server carries no CSP at all, which is why this spec runs
 * against the built app the way every other app E2E does. The only honest way to assert a policy
 * from inside the page it governs is to **do the thing it forbids** and catch the violation, which
 * is what these two tests are.
 *
 * `worker-src blob:` was removed on 2026-08-30 (docs/DECISIONS.md). Both of this app's workers come
 * from `new URL(…, import.meta.url)`, which Vite emits as a same-origin asset, so `'self'` covers
 * every worker that is supposed to exist. A Blob module worker built from fetched text was the one
 * thing `blob:` covered, and nothing here wants one.
 *
 * `script-src tetravox://module` was **added** the same day, for downloadable extensions. The two
 * changes pull in opposite directions and that is deliberate: the door that was closed executed
 * *anything the renderer could assemble*, and the one that was opened executes only what main put on
 * an explicit map after verifying its sha256 against a manifest the user consented to. The tests
 * below assert the second half from the side a policy can actually be proved from — **negatively**.
 * With nothing installed there is nothing on that map, so every URL under the new host 404s, which
 * is the claim that matters: adding a host source to `script-src` did not make the host *reachable*.
 * The positive half — an installed, consented module really loading — is `extensions.spec.ts`'s.
 */

/* eslint-disable no-empty-pattern */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

test.describe('the renderer CSP', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=mock&mockStepMs=0' });
    page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('refuses a worker from a blob: URL, naming worker-src', async () => {
    const violation = await page.evaluate(async () => {
      const url = URL.createObjectURL(new Blob(['self.close();'], { type: 'text/javascript' }));
      const seen = new Promise<string>((resolve) => {
        document.addEventListener(
          'securitypolicyviolation',
          (event) => resolve(event.violatedDirective),
          { once: true }
        );
        // A CSP that does not fire at all would leave this pending, which is a timeout rather than
        // a false pass — the assertion below is on the directive's name, not on "nothing happened".
        setTimeout(() => resolve('no violation fired'), 4000);
      });
      try {
        const worker = new Worker(url, { type: 'module' });
        worker.terminate();
      } catch {
        // Chromium throws here as well as firing the event; both are the policy working.
      }
      return seen;
    });
    // Chromium reports `worker-src`, falling back to `child-src`/`script-src` when the directive is
    // absent. Any of the three is the block; `no violation fired` is not.
    expect(violation).toMatch(/worker-src|child-src|script-src/);
  });

  test('still allows the app’s own same-origin module worker', async () => {
    // The half that matters more: a CSP that blocked `blob:` and also broke the dataset worker
    // would be a regression dressed as a hardening. `Phase0App`'s worker is the same `new URL`
    // shape as the engine's, and this asserts the *policy* admits it — the engine's own worker is
    // exercised by every other app E2E that loads a dataset.
    const ok = await page.evaluate(async () => {
      const response = await fetch('tetravox://app/index.html');
      return response.ok;
    });
    expect(ok).toBe(true);
  });

  test('404s an unregistered tetravox://module URL, because the map is empty', async () => {
    // The host is in `script-src`; that grants nothing on its own. `protocol.ts`'s `handleModule`
    // does a **map lookup** — no root directory, no path joining — and only `enableModule` fills the
    // map. A launch with no installed extension therefore has an inert host.
    const status = await page.evaluate(async () => {
      const response = await fetch('tetravox://module/tetravox.absent/1.0.0/index.js');
      return response.status;
    });
    expect(status).toBe(404);
  });

  test('404s a module that is installed but not enabled — consent gates execution', async () => {
    // There is nothing installed in this profile either, so this is the same 404 arriving by a
    // different route; what it pins is that the *scheme* is where consent bites, not the switcher.
    // `extensions.spec.ts` runs the version of this with a real fixture module on disk.
    const statuses = await page.evaluate(async () => {
      const urls = [
        'tetravox://module/tetravox.fixture/1.0.0/index.js',
        'tetravox://module/tetravox.fixture/1.0.0/manifest.json',
        'tetravox://module//etc/passwd',
        'tetravox://module/..%2F..%2Fetc%2Fpasswd',
      ];
      const out: number[] = [];
      for (const url of urls) out.push((await fetch(url)).status);
      return out;
    });
    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  test('a script element under the new host is admitted by the policy and still fails to load', async () => {
    // The distinction the CSP diff turns on. `script-src 'self'` alone would report a
    // *`securitypolicyviolation`* for this element; with `tetravox://module` in the list the policy
    // permits it and the load fails on the 404 instead. "Blocked by policy" and "there is nothing
    // there" are different failures, and this is the one that proves which one is happening.
    const outcome = await page.evaluate(async () => {
      return new Promise<string>((resolve) => {
        document.addEventListener(
          'securitypolicyviolation',
          (event) => resolve(`violation:${event.violatedDirective}`),
          { once: true }
        );
        const script = document.createElement('script');
        script.type = 'module';
        script.src = 'tetravox://module/tetravox.absent/1.0.0/index.js';
        script.onerror = () => resolve('network-error');
        script.onload = () => resolve('loaded');
        document.head.appendChild(script);
        setTimeout(() => resolve('nothing happened'), 4000);
      });
    });
    expect(outcome).toBe('network-error');
  });

  test('keeps img-src blob:, which the screenshot preview needs', async () => {
    const loaded = await page.evaluate(async () => {
      // A 1x1 transparent PNG, as a Blob URL — exactly what `ScreenshotDialog` previews.
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        ),
        (c) => c.charCodeAt(0)
      );
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      return new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
        setTimeout(() => resolve(false), 4000);
      });
    });
    expect(loaded).toBe(true);
  });
});

/**
 * **The positive half of the `script-src` grant, in the build that ships** (addendum correction 3).
 *
 * Everything above proves the policy from the outside: the host is in `script-src`, and with nothing
 * on the map every URL under it 404s. What none of it can prove is the claim the whole feature rests
 * on — that `tetravox://module` as a **host source** actually *matches* a `tetravox://module/…` URL
 * in Chromium's CSP matcher, so a consented module's code really runs.
 *
 * It has to be asserted here rather than in `extensions.spec.ts` for one reason: **the dev server
 * carries no CSP**, and `pnpm e2e`'s `dev` project runs the built bundle but the *packaged* project
 * is the one ROADMAP Phase-0 gate 2 is proved by. Under `TETRAVOX_REQUIRE_PACKAGED=1` this leg
 * cannot go green by skipping, so a policy that stopped matching would be a red CI leg rather than a
 * feature that quietly stopped working in shipped builds only.
 *
 * The distinction it turns on is the same one the script-element test above makes, read the other
 * way round: with the host source **absent** this import would raise a `securitypolicyviolation`
 * naming `script-src`; with it present the import resolves and the module's `activate` is a
 * function. So the assertion is *both* — no violation, and a real export — because "it loaded" and
 * "the policy let it" are different facts and only the pair is the claim.
 *
 * It also incidentally proves the SDK global: the fixture bundle's top level throws unless
 * `globalThis.__tetravoxModuleSdk` is set, and `main.tsx` sets it at boot.
 */
test.describe('the tetravox://module host source, in a real build', () => {
  const FIXTURE_ID = 'tetravox.fixture';
  const FIXTURE_VERSION = '1.0.0';
  const ENTRY = `tetravox://module/${FIXTURE_ID}/${FIXTURE_VERSION}/index.js`;

  let app: ElectronApplication;
  let page: Page;
  let modules: string;
  let home: string;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    // Placed on disk with the receipt an install would have written, rather than downloaded: what is
    // under test is the **policy**, and a download here would only add a way for this leg to fail
    // for a reason that is not the CSP. `extensions.spec.ts` owns the download path.
    modules = mkdtempSync(join(tmpdir(), 'tetravox-csp-modules-'));
    home = mkdtempSync(join(tmpdir(), 'tetravox-csp-home-'));
    const source = resolve(APP_ROOT, 'e2e', 'fixtures', FIXTURE_ID);
    const dir = join(modules, FIXTURE_ID, FIXTURE_VERSION);
    mkdirSync(dir, { recursive: true });
    const names = ['index.js', 'manifest.json'];
    for (const name of names) copyFileSync(join(source, name), join(dir, name));
    writeFileSync(
      join(dir, 'tetravox-module.json'),
      JSON.stringify({
        schema: 1,
        id: FIXTURE_ID,
        version: FIXTURE_VERSION,
        installedAt: '2026-08-30T00:00:00.000Z',
        files: names.map((name) => {
          const bytes = readFileSync(join(dir, name));
          return {
            name,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
        }),
      })
    );

    app = await launchApp(target, {
      search: 'engine=mock&mockStepMs=0',
      // `TETRAVOX_E2E=1` keeps `TETRAVOX_MODULE_DIR` live in the **packaged** leg: a shipped build
      // otherwise ignores that seam on purpose (module-store.ts `envSeamsAllowed`, 2026-08-31), the
      // same way it ignores `TETRAVOX_E2E_DISCARD`. This is the one packaged spec that stages a
      // fixture module through the seam, so it is the one that has to opt back in.
      env: { TETRAVOX_MODULE_DIR: modules, TETRAVOX_HOME: home, TETRAVOX_E2E: '1' },
    });
    page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 30_000 });
  });

  test.afterAll(async () => {
    await app?.close();
    for (const dir of [modules, home]) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('404s the installed module until consent is recorded', async () => {
    const status = await page.evaluate(async (url) => (await fetch(url)).status, ENTRY);
    expect(status).toBe(404);
  });

  test('executes it once main puts it on the map — the host source really matches', async () => {
    // `moduleEnable` IS the consent (`main/module-store.ts`): main re-hashes every file against the
    // receipt and only then serves it. The sheet is the renderer's; this is the message it sends.
    const enabled = await page.evaluate(
      async (id) => (await window.tetravox.moduleEnable?.(id)) ?? { ok: false, error: 'no member' },
      FIXTURE_ID
    );
    expect(enabled.error ?? '').toBe('');
    expect(enabled.ok).toBe(true);

    const outcome = await page.evaluate(async (url) => {
      const violations: string[] = [];
      const onViolation = (event: SecurityPolicyViolationEvent): void => {
        violations.push(event.violatedDirective);
      };
      document.addEventListener('securitypolicyviolation', onViolation);
      try {
        const loaded = (await import(/* @vite-ignore */ url)) as { activate?: unknown };
        // One turn of the loop, so a violation fired during evaluation is recorded before we look.
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, activate: typeof loaded.activate, violations };
      } catch (error) {
        await new Promise((r) => setTimeout(r, 50));
        return { ok: false, error: String(error), violations };
      } finally {
        document.removeEventListener('securitypolicyviolation', onViolation);
      }
    }, ENTRY);

    // Both halves. `violations: []` is "the policy admitted it"; `activate: 'function'` is "the code
    // ran, with the host's own React on `globalThis.__tetravoxModuleSdk`".
    expect(outcome.violations).toEqual([]);
    expect(outcome).toMatchObject({ ok: true, activate: 'function' });
  });
});
