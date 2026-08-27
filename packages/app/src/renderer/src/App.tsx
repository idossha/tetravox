/**
 * The Phase-0 walking skeleton (ROADMAP Phase-0 gate 2 & 3).
 *
 * React is chrome only (§1). Everything visual here is one raw-WebGL2 triangle whose colour came out
 * of a real `tvx-wasm` call made in a module Worker under the `tetravox://app` origin. Phase 1
 * replaces the worker with `@tetravox/wasm`'s compute worker and the triangle with the engine.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { OpenedPath } from '../../preload/index';
import { BACKGROUND, CANVAS_HEIGHT, CANVAS_WIDTH, PING_SEED, colorFromPing } from './phase0';
import type { Phase0Report, WorkerRequest, WorkerResponse } from './phase0';
import { Webgl2Unavailable, createContext, drawTriangle, readPixel } from './triangle';

const bridge = (): Window['tetravox'] => window.tetravox;

function hex([r, g, b]: readonly [number, number, number]): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** One round-trip to the Phase-0 worker. Rejects if it reports a failure. */
async function askWorker(fileUrl: string | null): Promise<WorkerResponse> {
  const worker = new Worker(new URL('../workers/phase0-worker.ts', import.meta.url), {
    type: 'module',
    name: 'tetravox-phase0',
  });
  try {
    return await new Promise<WorkerResponse>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message || 'worker error'));
      worker.postMessage({ kind: 'start', seed: PING_SEED, fileUrl } satisfies WorkerRequest);
    });
  } finally {
    // §5 rule 1: closing a dataset is `worker.terminate()`. Here it is just tidiness, but the
    // lifetime is the one Phase 1 keeps.
    worker.terminate();
  }
}

export function App(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const startedRef = useRef(false);
  const [report, setReport] = useState<Phase0Report | null>(null);
  const [opened, setOpened] = useState<OpenedPath[]>([]);

  const note = useCallback((message: string) => {
    bridge().log(message);
  }, []);

  useEffect(
    () =>
      bridge().onOpened((paths) => {
        setOpened((prev) => [...prev, ...paths]);
        for (const item of paths) note(`opened via IPC: ${item.path}`);
      }),
    [note]
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const publish = (value: Phase0Report): void => {
      window.__tetravox_phase0 = value;
      setReport(value);
    };

    const base = {
      locationProtocol: window.location.protocol,
      origin: window.location.origin,
      openedPaths: [] as string[],
    };

    void (async () => {
      try {
        // Drain what main captured before the window existed (CLI argv, launch-time `open-file`).
        const startup = await bridge().startupPaths();
        if (startup.length > 0) {
          setOpened((prev) => [...prev, ...startup]);
          for (const item of startup) note(`argv: ${item.path}`);
        }

        const fixture = await bridge().phase0Fixture();
        const response = await askWorker(fixture?.url ?? null);
        if (response.kind === 'failed') throw new Error(response.message);

        const canvas = canvasRef.current;
        if (canvas === null) throw new Error('canvas missing');
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;

        const ctx = createContext(canvas);
        const color = colorFromPing(response.ping);
        drawTriangle(ctx.gl, color, BACKGROUND);

        publish({
          ...base,
          ok: true,
          error: null,
          wasm: response,
          color,
          centerPixel: readPixel(ctx.gl, CANVAS_WIDTH >> 1, CANVAS_HEIGHT >> 1),
          cornerPixel: readPixel(ctx.gl, 0, 0),
          renderer: ctx.renderer,
          vendor: ctx.vendor,
          isSoftware: ctx.isSoftware,
          drawingBuffer: { width: ctx.gl.drawingBufferWidth, height: ctx.gl.drawingBufferHeight },
        });
        note(
          `phase0 ok: tvx_ping(0x${PING_SEED.toString(16)})=0x${response.ping.toString(16)} ` +
            `colour=${hex(color)} wasm=${response.wasmContentType} renderer=${ctx.renderer}`
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        publish({
          ...base,
          ok: false,
          error: error instanceof Webgl2Unavailable ? 'webgl2-null' : message,
          wasm: null,
          color: null,
          centerPixel: null,
          cornerPixel: null,
          renderer: null,
          vendor: null,
          isSoftware: null,
          drawingBuffer: null,
        });
        note(`phase0 failed: ${message}`);
      }
    })();
  }, [note]);

  useEffect(() => {
    if (report !== null)
      window.__tetravox_phase0 = { ...report, openedPaths: opened.map((o) => o.path) };
  }, [report, opened]);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      // §8: `webUtils.getPathForFile` first. When it returns '' the renderer must NOT call
      // `file.arrayBuffer()` — Phase 1 posts the `File` itself to the worker as
      // `LoadSource.kind: 'file'`. Phase 0 only logs which branch a drop took.
      void (async () => {
        for (const file of Array.from(event.dataTransfer.files)) {
          const path = bridge().getDroppedFilePath(file);
          if (path === '') {
            note(`drop: no path for "${file.name}" -> LoadSource.kind:'file' fallback (Phase 1)`);
            continue;
          }
          const allowed = await bridge().allowPath(path);
          if (allowed === null) {
            note(`drop: ${path} (unreadable)`);
            continue;
          }
          setOpened((prev) => [...prev, allowed]);
          note(`drop: ${allowed.path}`);
        }
      })();
    },
    [note]
  );

  const onOpenClick = useCallback((): void => {
    void (async () => {
      const paths = await bridge().openDialog();
      setOpened((prev) => [...prev, ...paths]);
      for (const item of paths) note(`dialog: ${item.path}`);
    })();
  }, [note]);

  const failedWebgl = report !== null && report.error === 'webgl2-null';

  return (
    <div
      className="flex h-full flex-col bg-tvx-bg text-tvx-text"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <header className="flex items-center gap-3 border-b border-tvx-line bg-tvx-panel px-4 py-2">
        <span className="text-sm font-semibold tracking-wide text-tvx-accent">Tetravox</span>
        <span className="text-xs text-tvx-dim">Phase 0 — walking skeleton</span>
        <button
          type="button"
          onClick={onOpenClick}
          className="ml-auto rounded border border-tvx-line px-2 py-1 text-xs hover:border-tvx-accent"
        >
          Open…
        </button>
      </header>

      <main className="flex flex-1 items-center justify-center p-6">
        {failedWebgl ? (
          <div
            data-testid="webgl2-error"
            className="max-w-lg rounded border border-red-500/50 bg-red-950/30 p-6 text-sm"
          >
            <h1 className="mb-2 text-base font-semibold text-red-300">No WebGL2 context</h1>
            <p className="mb-2 text-tvx-dim">
              <code>getContext(&apos;webgl2&apos;)</code> returned <code>null</code>. Chromium M137
              removed the automatic SwiftShader fallback, so a blocklisted GPU driver disables
              WebGL2 outright.
            </p>
            <p className="text-tvx-dim">
              Open <code>chrome://gpu</code> in this app&apos;s DevTools to see which feature is
              blocklisted and why.
            </p>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            data-testid="phase0-canvas"
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            style={{ width: `${CANVAS_WIDTH}px`, height: `${CANVAS_HEIGHT}px` }}
            className="rounded border border-tvx-line"
          />
        )}
      </main>

      <footer
        data-testid="status-bar"
        className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-tvx-line bg-tvx-panel px-4 py-2 font-mono text-[11px] text-tvx-dim"
      >
        <span>origin</span>
        <span data-testid="status-origin">{window.location.origin}</span>
        <span>wasm</span>
        <span data-testid="status-wasm">
          {report?.wasm
            ? `tvx ${report.wasm.version} · ${report.wasm.wasmContentType ?? 'no content-type'} · ` +
              `${report.wasm.streamed ? 'instantiateStreaming' : 'buffered fallback'}`
            : (report?.error ?? 'starting…')}
        </span>
        <span>tvx_ping</span>
        <span data-testid="status-ping">
          {report?.wasm
            ? `0x${report.wasm.ping.toString(16).padStart(8, '0')} → ${report.color ? hex(report.color) : ''}`
            : '—'}
        </span>
        <span>file</span>
        <span data-testid="status-file">
          {report?.wasm && report.wasm.fileBytes !== null
            ? `${report.wasm.fileBytes} B over tetravox://file/ → tvx_ping_bytes 0x${(report.wasm.fileDigest ?? 0).toString(16)}`
            : '—'}
        </span>
        <span>renderer</span>
        <span data-testid="status-renderer">{report?.renderer ?? '—'}</span>
        <span>opened</span>
        <span data-testid="status-opened">
          {opened.length === 0
            ? 'nothing yet — File ▸ Open…, drop a file, or pass a path on argv'
            : opened.map((o) => o.path).join('  ·  ')}
        </span>
      </footer>
    </div>
  );
}
