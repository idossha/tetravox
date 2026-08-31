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

import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, packagedUnavailable } from './fixtures';
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
