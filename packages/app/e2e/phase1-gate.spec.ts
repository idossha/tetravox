/**
 * **Phase-1 gate item 1**, plus the benchmark numbers that can only be taken here.
 *
 * > Real ernie data loads through the worker with progress and cancel: opening
 * > `m2m_ernie/ernie_seeg.msh` (492 MB) shows a moving progress bar within 200 ms and cancels within
 * > 500 ms of the click. Cancel is `worker.terminate()` (§5 rule 6).
 *
 * This runs against the **real** engine (`packages/engine`'s `create()`) inside Electron, so the
 * renderer is ANGLE/Metal rather than the SwiftShader the goldens use — which is also why the
 * frame-time benchmarks live here and not in the engine's Playwright project.
 *
 * Both timings are taken **inside the page**, around the exact call the UI makes, so no Playwright
 * IPC round trip is counted against a budget the product has to meet.
 *
 * Skips, never fails, when `TETRAVOX_TESTDATA` is unset (AGENTS rule 2).
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { APP_ROOT, launchApp } from './fixtures';

const ROOT = process.env.TETRAVOX_TESTDATA ?? '';
const ERNIE_SEEG = join(ROOT, 'm2m_ernie', 'ernie_seeg.msh');
const ERNIE = join(ROOT, 'm2m_ernie', 'ernie.msh');
const T1 = join(ROOT, 'm2m_ernie', 'T1.nii.gz');

test.describe('Phase-1 gate item 1 — progress and cancel on the 492 MB mesh', () => {
  let app: ElectronApplication;
  let page: Page;

  test.skip(ROOT === '', 'TETRAVOX_TESTDATA is unset');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    app = await launchApp('dev', { search: 'engine=real' });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 900);
    });
    await page.waitForSelector('[data-testid="shell"][data-ready="true"]', { timeout: 60_000 });
    await page.waitForFunction(
      () => {
        const grid = document.querySelector('[data-testid="view-grid"]');
        const rect = grid?.getBoundingClientRect();
        return rect !== undefined && rect.width > 0 && rect.height > 0;
      },
      undefined,
      { timeout: 30_000 }
    );
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test('the engine behind the shell is the real WebGL2 one', async () => {
    const caps = await page.evaluate(() => {
      const e = window.__tetravox?.engine;
      return e === null || e === undefined
        ? null
        : { renderer: e.caps.renderer, isSoftware: e.caps.isSoftware };
    });
    expect(caps).not.toBeNull();
    // `NoGlEngine` throws on every member; a renderer string proves this is `packages/engine`.
    expect(caps!.renderer.length).toBeGreaterThan(0);
    console.log(`[bench] app renderer: ${caps!.renderer}${caps!.isSoftware ? ' (software)' : ''}`);
  });

  test('opening ernie_seeg.msh shows a moving progress bar < 200 ms and cancels < 500 ms', async () => {
    test.setTimeout(180_000);

    const timings = await page.evaluate(async (path: string) => {
      const tv = window.__tetravox;
      if (tv?.controller == null) throw new Error('no controller');
      const store = tv.store;
      const controller = tv.controller;

      // The same request the Open dialog, argv and a path-backed drop all build (§8).
      const allowed = await window.tetravox.allowPath(path);
      if (allowed === null) throw new Error(`main refused ${path}`);
      const name = allowed.path.split('/').pop() ?? allowed.path;

      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      const card = (ticket: number) => store.getState().loads.find((c) => c.ticket === ticket);

      const t0 = performance.now();
      controller.open([{ name, path: allowed.path, source: { kind: 'path', path: allowed.path } }]);

      // The card appears synchronously; "moving" is its first progress event from the worker.
      let ticket = -1;
      let cardVisibleMs = -1;
      let firstProgressMs = -1;
      let firstPhase = '';
      while (performance.now() - t0 < 30_000) {
        const cards = store.getState().loads;
        const c = cards[cards.length - 1];
        if (c !== undefined) {
          if (ticket === -1) {
            ticket = c.ticket;
            cardVisibleMs = performance.now() - t0;
          }
          if (c.state === 'loading' && (c.done > 0 || c.total > 0)) {
            firstProgressMs = performance.now() - t0;
            firstPhase = c.phase;
            break;
          }
        }
        await sleep(1);
      }

      // Cancel, and time it to the card actually reading `cancelled`.
      const tCancel = performance.now();
      controller.cancelLoad(ticket);
      let cancelMs = -1;
      while (performance.now() - tCancel < 30_000) {
        const c = card(ticket);
        if (c !== undefined && (c.state === 'cancelled' || c.state === 'failed')) {
          cancelMs = performance.now() - tCancel;
          break;
        }
        await sleep(1);
      }

      // Let anything in flight settle, then report what the scene actually holds.
      await sleep(250);
      const after = store.getState();
      return {
        cardVisibleMs,
        firstProgressMs,
        firstPhase,
        cancelMs,
        finalState: card(ticket)?.state ?? 'missing',
        datasets: after.datasets.length,
        layers: after.layers.length,
      };
    }, ERNIE_SEEG);

    console.log(
      `[gate 1] ernie_seeg.msh (492,090,201 B): card visible ${timings.cardVisibleMs.toFixed(1)} ms, ` +
        `first progress ${timings.firstProgressMs.toFixed(1)} ms (phase "${timings.firstPhase}"), ` +
        `cancel ${timings.cancelMs.toFixed(1)} ms`
    );

    expect(timings.firstProgressMs, 'a moving progress bar within 200 ms').toBeGreaterThanOrEqual(
      0
    );
    expect(timings.firstProgressMs, 'a moving progress bar within 200 ms').toBeLessThan(200);
    expect(timings.cancelMs, 'cancel within 500 ms of the click').toBeGreaterThanOrEqual(0);
    expect(timings.cancelMs, 'cancel within 500 ms of the click').toBeLessThan(500);
    expect(timings.finalState).toBe('cancelled');
    // §5 rule 6: cancel is `worker.terminate()`, so nothing reaches the scene.
    expect(timings.datasets).toBe(0);
    expect(timings.layers).toBe(0);
  });

  test('benchmarks: load-to-first-frame and orbit frame time at 2x DPR (ANGLE/Metal)', async () => {
    test.setTimeout(300_000);

    const bench = await page.evaluate(
      async ([t1, ernie]) => {
        const tv = window.__tetravox;
        if (tv?.controller == null || tv.engine == null) throw new Error('no controller');
        const { store, controller } = tv;
        const engine = tv.engine as unknown as {
          renderNow(): void;
          whenSettled(): Promise<void>;
          setLayout(l: { kind: string; cells: string[] }): void;
          setView(id: string, patch: unknown): void;
          scene: { view3d: { camera: Record<string, unknown> }; layers: unknown[] };
          caps: { renderer: string };
        };
        const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

        // Mirrors `open/sources.ts::requestFromPath`, which is module-private: derive the sibling
        // sidecars and allow-list them alongside the dataset (§5 rule 9's Phase-1 consequence).
        // Skipping this is not a shortcut — without `ernie.msh.opt` the §6.2 tag ladder falls
        // through to the deterministic palette, and the head renders in palette colours rather than
        // SimNIBS's tissue colours.
        const openRequest = async (path: string) => {
          const allowed = await window.tetravox.allowPath(path);
          if (allowed === null) throw new Error(`main refused ${path}`);
          const p = allowed.path;
          const stem = p.replace(/\.(nii\.gz|nii|msh|gii|mgz|mgh|stl|ply|obj)$/i, '');
          const firstAllowed = async (cands: string[]): Promise<string | undefined> => {
            for (const c of cands) {
              const ok = await window.tetravox.allowPath(c);
              if (ok !== null) return ok.path;
            }
            return undefined;
          };
          const lut = await firstAllowed([`${stem}_LUT.txt`, `${stem}.txt`]);
          const opt = p.toLowerCase().endsWith('.msh')
            ? await firstAllowed([`${p}.opt`, `${stem}.opt`])
            : undefined;
          const sidecars: { lut?: string; opt?: string } = {};
          if (lut !== undefined) sidecars.lut = lut;
          if (opt !== undefined) sidecars.opt = opt;
          return {
            name: p.split('/').pop() ?? p,
            path: p,
            source: {
              kind: 'path' as const,
              path: p,
              ...(Object.keys(sidecars).length > 0 ? { sidecars } : {}),
            },
          };
        };

        const openAndTime = async (path: string): Promise<number> => {
          const request = await openRequest(path);
          const before = store.getState().layers.length;
          const t0 = performance.now();
          controller.open([request]);
          while (performance.now() - t0 < 120_000) {
            if (store.getState().layers.length > before) break;
            await sleep(2);
          }
          await engine.whenSettled();
          engine.renderNow();
          return performance.now() - t0;
        };

        const t1Ms = await openAndTime(t1 as string);
        const ernieMs = await openAndTime(ernie as string);

        const canvas = document.querySelector('canvas');
        if (canvas === null) throw new Error('no canvas');

        // 2x DPR. The drawing buffer is set explicitly rather than inherited from the window:
        // the app defends a `minWidth` of 960 against a tiling window manager (see its
        // DECISIONS.md entry), so the grid here is ~352 px wide and a benchmark taken at that size
        // would say nothing about a real viewport. The engine reads the canvas size it is given and
        // does not resize the canvas itself, so setting it is exact.
        //
        // Frame cost is taken from the engine's own `frame` event — `cpuMs` and, where
        // `EXT_disjoint_timer_query_webgl2` is present, `gpuMs` (§7.1). Wall-clock around a
        // `requestAnimationFrame` cannot work: the wait is until the next vsync, so on this
        // machine's 120 Hz ProMotion display it measures 8.33 ms whatever the scene costs — which
        // is exactly what a first attempt at this benchmark reported for both 1x and 2x.
        const CSS_W = 1200;
        const CSS_H = 800;
        const at = async (
          scale: number
        ): Promise<{
          cpuMedian: number;
          cpuP95: number;
          gpuMedian: number | null;
          w: number;
          h: number;
          frames: number;
        }> => {
          // Order matters: the app's view grid re-sizes the canvas from a `ResizeObserver` on its
          // host, and `setLayout` re-renders the grid. Sizing before that would be undone — which
          // is exactly what happened on the first run of this benchmark, and why the 1x pass
          // reported the window's 352 px grid instead of 1200.
          engine.setLayout({ kind: '3d-only', cells: ['view3d'] });
          await engine.whenSettled();
          canvas.width = CSS_W * scale;
          canvas.height = CSS_H * scale;

          const cpu: number[] = [];
          const gpu: number[] = [];
          const off = (
            engine as unknown as {
              on(e: 'frame', cb: (p: { cpuMs: number; gpuMs?: number }) => void): () => void;
            }
          ).on('frame', (f) => {
            cpu.push(f.cpuMs);
            if (typeof f.gpuMs === 'number') gpu.push(f.gpuMs);
          });

          const cam = engine.scene.view3d.camera;
          for (let i = 0; i < 60; i += 1) {
            const a = (i / 60) * Math.PI * 2;
            engine.setView('view3d', {
              camera: { ...cam, rotation: [0, 0, Math.sin(a / 2), Math.cos(a / 2)] },
            });
            engine.renderNow();
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
          }
          off();
          const med = (v: number[]): number => {
            const s2 = [...v].sort((x, y) => x - y);
            return s2[Math.floor(s2.length / 2)] ?? 0;
          };
          const p95 = (v: number[]): number => {
            const s2 = [...v].sort((x, y) => x - y);
            return s2[Math.floor(s2.length * 0.95)] ?? 0;
          };
          return {
            cpuMedian: med(cpu),
            cpuP95: p95(cpu),
            gpuMedian: gpu.length > 0 ? med(gpu) : null,
            w: canvas.width,
            h: canvas.height,
            frames: cpu.length,
          };
        };

        const dpr1 = await at(1);
        const dpr2 = await at(2);
        return {
          renderer: engine.caps.renderer,
          devicePixelRatio: window.devicePixelRatio,
          timerQuery: (engine as unknown as { caps: { timerQuery: boolean } }).caps.timerQuery,
          t1Ms,
          ernieMs,
          dpr1,
          dpr2,
          layers: store.getState().layers.length,
        };
      },
      [T1, ERNIE] as const
    );

    const line = (name: string, r: typeof bench.dpr1): string =>
      `[bench] orbit ${name} (${r.w}x${r.h}, ${r.frames} frames): cpu median ${r.cpuMedian.toFixed(2)} ms, ` +
      `cpu p95 ${r.cpuP95.toFixed(2)} ms, gpu median ${r.gpuMedian === null ? 'n/a' : `${r.gpuMedian.toFixed(2)} ms`}`;
    console.log(
      `[bench] renderer ${bench.renderer} (devicePixelRatio ${bench.devicePixelRatio}, timerQuery ${bench.timerQuery})\n` +
        `[bench] T1.nii.gz open -> first frame: ${bench.t1Ms.toFixed(0)} ms\n` +
        `[bench] ernie.msh open -> first frame: ${bench.ernieMs.toFixed(0)} ms\n` +
        `${line('@1x', bench.dpr1)}\n${line('@2x', bench.dpr2)}`
    );

    expect(bench.layers).toBe(2);
    expect(bench.t1Ms).toBeGreaterThan(0);
    expect(bench.ernieMs).toBeGreaterThan(0);
    expect(bench.dpr2.w).toBe(bench.dpr1.w * 2);
    expect(bench.dpr1.frames).toBeGreaterThan(50);
    // Not a §9 assertion — §9.1's rows are Phase 3's to sign off. This only guarantees the number
    // recorded in docs/benchmarks/phase1.md came from a real frame loop.
    expect(bench.dpr2.cpuMedian).toBeGreaterThan(0);

    test.info().annotations.push({ type: 'bench', description: JSON.stringify(bench) });

    // Evidence a human can look at, written only when asked for — the same discipline §11 applies
    // to goldens. `docs/screenshots/phase1/` is the committed copy.
    const dir = process.env.TETRAVOX_SCREENSHOT_DIR;
    if (dir !== undefined && dir !== '') {
      const out = resolve(APP_ROOT, '..', '..', dir);
      mkdirSync(out, { recursive: true });
      // Widen the window so the screenshot shows panes rather than slivers. A tiling window manager
      // may refuse (see the app's DECISIONS.md note on `minWidth: 960`), which is why nothing is
      // asserted about the result — this is evidence, not a test.
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w?.setBounds({ x: 40, y: 40, width: 1720, height: 1040 });
      });
      await page.waitForTimeout(400);
      await page.evaluate(async () => {
        const tv = window.__tetravox;
        const engine = tv?.engine as unknown as {
          setLayout(l: { kind: string; cells: string[] }): void;
          whenSettled(): Promise<void>;
          renderNow(): void;
        };
        engine.setLayout({ kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] });
        await engine.whenSettled();
        engine.renderNow();
      });
      await page.screenshot({ path: join(out, 'app-shell-t1-and-ernie.png') });
    }
  });
});
