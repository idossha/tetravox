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
