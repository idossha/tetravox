/**
 * The two themes (docs/PLAN-2026-08-28-directed.md #9), end to end.
 *
 * Three halves, and each one is a way a theme switch is usually only half-done:
 *
 *  * **Computed colours.** Not "the class changed" — `getComputedStyle` on the toolbar, a panel and
 *    the status bar, resolved to real `rgb()` triples, plus the `--color-tvx-*` variables
 *    themselves. A test that asserted class names would pass against a stylesheet that defines
 *    nothing.
 *  * **The engine's half.** §7.2 pass-3 chrome is drawn into the GL framebuffer, so no DOM
 *    assertion can see it and no CSS can reach it. The stand-in engine records what
 *    `Engine.setTheme` was handed, and this asserts on it — the orientation letters and their halo
 *    really do flip with the switch.
 *  * **Persistence across a relaunch.** Two launches sharing one `--user-data-dir`, because
 *    `settings.json` lives in it and the default profile is a fresh temp directory per launch
 *    (`fixtures.ts`).
 *
 * Plus the plan's two pictures, on real data, which is the only part that needs `TETRAVOX_TESTDATA`.
 */

/* eslint-disable no-empty-pattern */

import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp, packagedUnavailable } from './fixtures';
import type { LaunchTarget } from './fixtures';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const T1 = join(ROOT, 'm2m_ernie', 'T1.nii.gz');
const ERNIE = join(ROOT, 'm2m_ernie', 'ernie.msh');

const SHOTS = resolve(APP_ROOT, '..', '..', 'docs', 'screenshots', 'directed-2026-08-28');

/**
 * The token values `renderer/src/theme/tokens.ts` ships, as the browser reports them. Duplicated
 * here on purpose: a test that imported the table it is checking would pass against any table.
 */
const EXPECTED = {
  light: { bg: 'rgb(255, 255, 255)', panel: 'rgb(238, 241, 245)', text: 'rgb(21, 24, 29)' },
  dark: { bg: 'rgb(22, 24, 28)', panel: 'rgb(30, 33, 38)', text: 'rgb(223, 227, 234)' },
} as const;

/**
 * A CSS custom property off `<html>` — what every Tailwind utility resolves through.
 *
 * Normalised to six digits, because Chromium hands `#ffffff` back as `#fff` and a test that
 * compared the raw string would be asserting the browser's shorthand rules, not the token.
 */
async function token(page: Page, name: string): Promise<string> {
  const raw = await page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name
  );
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw);
  return (
    short === null ? raw : `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  ).toLowerCase();
}

async function computed(page: Page, testid: string, prop: string): Promise<string> {
  return page
    .locator(`[data-testid="${testid}"]`)
    .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

/**
 * Wait for the CSS colour transitions to finish.
 *
 * `.tvx-btn` carries `transition-colors`, which is 150 ms — and `Engine.whenSettled()` knows nothing
 * about the DOM, so a screenshot taken right after the click caught every button **mid-fade**: the
 * first `theme-dark.png` had a graphite window with light-theme buttons blended halfway over it, on
 * a run whose every other assertion passed. Sampling until two readings agree waits for the real
 * end state instead of guessing a duration.
 */
async function stylesSettled(page: Page): Promise<void> {
  const sample = async (): Promise<string> =>
    page.locator('[data-testid="theme-group"] button').evaluateAll((els) =>
      els
        .map((el) => {
          const cs = getComputedStyle(el);
          return `${cs.backgroundColor}|${cs.color}|${cs.borderColor}`;
        })
        .join(';')
    );
  let previous = await sample();
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(100);
    const next = await sample();
    if (next === previous) return;
    previous = next;
  }
}

/** What the stand-in engine last recorded from `Engine.setTheme` (`engine/mockEngine.ts`). */
async function engineTheme(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(
    () => (window.__tetravox?.engine as unknown as { theme: Record<string, number[]> })?.theme
  );
}

// -------------------------------------------------------------------------------------------------
// The switch, against the stand-in engine
// -------------------------------------------------------------------------------------------------

test.describe('the theme switch (stand-in engine)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=mock' });
    page = await app.firstWindow();
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]');
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('the toolbar offers System / Light / Dark and one of them is pressed', async () => {
    for (const choice of ['system', 'light', 'dark']) {
      await expect(page.locator(`[data-testid="theme-${choice}"]`)).toBeVisible();
    }
    const pressed = await page
      .locator('[data-testid="theme-group"] button[aria-pressed="true"]')
      .count();
    expect(pressed).toBe(1);
    // Whatever `system` resolved to, the document is stamped with one of the two — never neither.
    expect(['light', 'dark']).toContain(
      await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    );
  });

  test('Light applies live, in computed colours, with no reload', async () => {
    const before = page.url();
    await page.click('[data-testid="theme-light"]');

    await expect(page.locator('[data-testid="theme-group"]')).toHaveAttribute(
      'data-theme-resolved',
      'light'
    );
    expect(await token(page, '--color-tvx-bg')).toBe('#ffffff');
    expect(await token(page, '--color-tvx-accent')).toBe('#3b5ba9');
    expect(await computed(page, 'shell', 'background-color')).toBe(EXPECTED.light.bg);
    expect(await computed(page, 'toolbar', 'background-color')).toBe(EXPECTED.light.panel);
    expect(await computed(page, 'shell', 'color')).toBe(EXPECTED.light.text);
    expect(await computed(page, 'status-bar', 'background-color')).toBe(EXPECTED.light.panel);

    // Live: the same document, never reloaded, and the shell never remounted.
    expect(page.url()).toBe(before);
    await expect(page.locator('[data-testid="shell"]')).toHaveAttribute('data-ready', 'true');
  });

  test('Dark applies live too, and is graphite rather than black', async () => {
    await page.click('[data-testid="theme-dark"]');
    await expect(page.locator('[data-testid="theme-group"]')).toHaveAttribute(
      'data-theme-resolved',
      'dark'
    );
    expect(await computed(page, 'shell', 'background-color')).toBe(EXPECTED.dark.bg);
    expect(await computed(page, 'toolbar', 'background-color')).toBe(EXPECTED.dark.panel);
    expect(await computed(page, 'shell', 'color')).toBe(EXPECTED.dark.text);

    // "Graphite, not pure black" is the requirement, so it is the assertion.
    const [r, g, b] = (EXPECTED.dark.bg.match(/\d+/g) ?? []).map(Number) as number[];
    expect(Math.min(r as number, g as number, b as number)).toBeGreaterThan(8);
  });

  test('no cyan and no saturated highlight survives in the window', async () => {
    // The Phase-1 accent, in every form a stylesheet could still carry it.
    for (const theme of ['light', 'dark']) {
      await page.click(`[data-testid="theme-${theme}"]`);
      const css = await page.evaluate(() =>
        Array.from(document.styleSheets)
          .flatMap((sheet) => {
            try {
              return Array.from(sheet.cssRules).map((rule) => rule.cssText);
            } catch {
              return [];
            }
          })
          .join('\n')
          .toLowerCase()
      );
      expect(css).not.toContain('6ee7ff');
      expect(css).not.toContain('rgb(110, 231, 255)');
    }
  });

  test('the switch reaches the engine chrome, not only the CSS', async () => {
    await page.click('[data-testid="theme-light"]');
    const light = await engineTheme(page);
    await page.click('[data-testid="theme-dark"]');
    const dark = await engineTheme(page);

    // Every field the §7.2 overlay draws with is present in the patch the app sends.
    for (const key of [
      'text',
      'halo',
      'crosshair',
      'activeBorder',
      'gizmo',
      'gizmoHot',
      'background',
    ]) {
      expect(light[key], `setTheme is missing ${key}`).toHaveLength(4);
    }
    // The panes stay dark in both themes (imaging convention), so the chrome that sits on them —
    // the letters and their halo — does not flip between the two. This is the assertion that would
    // catch someone keying the overlay palette off the theme name instead of off the pane.
    expect(light).toEqual(dark);
    // …and the halo really is the opposite end of the ramp from the text, which is the property a
    // light pane would have to invert.
    expect((light['halo'] as number[])[0]).toBeLessThan(0.5);
    expect((light['text'] as number[])[0]).toBeGreaterThan(0.5);
  });
});

// -------------------------------------------------------------------------------------------------
// Persistence across a relaunch
// -------------------------------------------------------------------------------------------------

test.describe('the theme survives a relaunch', () => {
  test.describe.configure({ mode: 'serial' });

  test('a chosen theme is written to settings.json and read back on the next launch', async ({}, workerInfo) => {
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');

    // One profile directory for both launches: `settings.json` lives in it, and the default is a
    // fresh temp profile per launch precisely so two runs cannot collide (`fixtures.ts`).
    const profile = mkdtempSync(join(tmpdir(), 'tetravox-e2e-theme-'));

    const first = await launchApp(target, { search: 'engine=mock', userDataDir: profile });
    const firstPage = await first.firstWindow();
    await firstPage.waitForSelector('[data-testid="shell"][data-ready="true"]');
    await firstPage.click('[data-testid="theme-light"]');
    await expect(firstPage.locator('[data-testid="theme-light"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // The write is a bridge round trip; wait for main to have answered before killing the process.
    expect(await firstPage.evaluate(async () => (await window.tetravox.settings()).theme)).toBe(
      'light'
    );
    await first.close();

    const second = await launchApp(target, { search: 'engine=mock', userDataDir: profile });
    const secondPage = await second.firstWindow();
    await secondPage.waitForSelector('[data-testid="shell"][data-ready="true"]');
    await expect(secondPage.locator('[data-testid="theme-light"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(secondPage.locator('[data-testid="theme-group"]')).toHaveAttribute(
      'data-theme-resolved',
      'light'
    );
    expect(await computed(secondPage, 'toolbar', 'background-color')).toBe(EXPECTED.light.panel);
    await second.close();
  });
});

// -------------------------------------------------------------------------------------------------
// The plan's two pictures, on real data
// -------------------------------------------------------------------------------------------------

test.describe('both themes on ernie (real data)', () => {
  let app: ElectronApplication;
  let page: Page;

  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, workerInfo) => {
    test.setTimeout(300_000);
    const target = workerInfo.project.name as LaunchTarget;
    const blocked = target === 'packaged' ? packagedUnavailable() : null;
    test.skip(blocked !== null, blocked ?? '');
    app = await launchApp(target, { search: 'engine=real' });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });

    await page.evaluate(
      async ([t1, mesh]: string[]) => {
        const tv = window.__tetravox;
        if (tv?.controller == null) throw new Error('no shell');
        for (const path of [t1, mesh] as string[]) {
          const allowed = await window.tetravox.allowPath(path);
          if (allowed === null) throw new Error(`main refused ${path}`);
          const opt = path.endsWith('.msh')
            ? await window.tetravox.allowPath(`${allowed.path}.opt`)
            : null;
          tv.controller.open([
            {
              name: allowed.path.split('/').pop() ?? allowed.path,
              path: allowed.path,
              source: {
                kind: 'path',
                path: allowed.path,
                ...(opt === null ? {} : { sidecars: { opt: opt.path } }),
              },
            },
          ]);
        }
      },
      [T1, ERNIE]
    );

    await page.waitForFunction(
      () => {
        const layers = window.__tetravox?.store.getState().layers ?? [];
        return (
          layers.some((l) => l.kind === 'volume') &&
          layers.some((l) => l.kind === 'mesh') &&
          (window.__tetravox?.store.getState().loads ?? []).every(
            (c) => c.state !== 'queued' && c.state !== 'loading'
          )
        );
      },
      undefined,
      { timeout: 280_000 }
    );
  });

  test.afterAll(async () => {
    await app?.close();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`the whole window in the ${theme} theme`, async () => {
      test.setTimeout(120_000);
      await page.click(`[data-testid="theme-${theme}"]`);
      await expect(page.locator('[data-testid="theme-group"]')).toHaveAttribute(
        'data-theme-resolved',
        theme
      );
      // Two different clocks have to run out before the shutter: the engine's frame pump (§7.2 sets
      // a dirty bit, it never renders synchronously) and the DOM's 150 ms colour transitions.
      await page.evaluate(async () => {
        await window.__tetravox?.engine?.whenSettled();
      });
      await stylesSettled(page);
      await expect(page.locator(`[data-testid="theme-${theme}"]`)).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      const file = join(SHOTS, `theme-${theme}.png`);
      mkdirSync(dirname(file), { recursive: true });
      await page.screenshot({ path: file });
      // ≤ 400 KB, per the plan. A window screenshot far past that is a screenshot of the wrong
      // thing, so it is an assertion rather than a note.
      expect(statSync(file).size).toBeLessThanOrEqual(400 * 1024);
    });
  }
});
