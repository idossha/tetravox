/**
 * The Phase-0 walking skeleton (ROADMAP Phase-0 gate 2 & 3).
 *
 * React is chrome only (§1). Everything visual here is one raw-WebGL2 triangle whose colour came out
 * of a real `tvx-wasm` call made in a module Worker under the `tetravox://app` origin.
 *
 * **Phase 1 did not delete it.** Gate items 2, 3 and 8 are proved by this component and by nothing
 * else, and the macOS CI leg runs the packaged E2E against it with `TETRAVOX_REQUIRE_PACKAGED=1`, so
 * a skip there is a failure. It is now reached by `?ui=phase0` (see `App.tsx`), which
 * `e2e/phase0.spec.ts` passes as `--tvx-search=ui=phase0`; the default UI is the §8 shell.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { OpenedPath } from '../../preload/index';
import { BACKGROUND, CANVAS_HEIGHT, CANVAS_WIDTH, PING_SEED, colorFromPing } from './phase0';
import type { DropRecord, Phase0Report, WorkerRequest, WorkerResponse } from './phase0';
import { Webgl2Unavailable, createContext, drawTriangle, readPixel } from './triangle';

const bridge = (): Window['tetravox'] => window.tetravox;

function hex([r, g, b]: readonly [number, number, number]): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** One round-trip to a fresh Phase-0 worker. Rejects if it reports a failure. */
async function askWorker(request: WorkerRequest): Promise<WorkerResponse> {
  const worker = new Worker(new URL('../workers/phase0-worker.ts', import.meta.url), {
    type: 'module',
    name: 'tetravox-phase0',
  });
  try {
    return await new Promise<WorkerResponse>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message || 'worker error'));
      worker.postMessage(request);
    });
  } finally {
    // §5 rule 1: closing a dataset is `worker.terminate()`. Here it is just tidiness, but the
    // lifetime is the one Phase 1 keeps.
    worker.terminate();
  }
}

/**
 * One dropped file, taken down whichever §8 branch applies (ROADMAP Phase-0 gate 8).
 *
 * The path branch allow-lists the path (§5 rule 9) and lets the worker `fetch` the resulting
 * `tetravox://file/…`. The fallback branch posts the `File` itself — structured-cloneable, and the
 * only branch left when `getPathForFile` returns `''`. Note what is *not* here: the UI thread never
 * calls `file.arrayBuffer()`, and no `ArrayBuffer` crosses IPC (§5 rule 3, AGENTS rule 7).
 *
 * Phase 1 replaces the digest with a real `LoadSource` and a parse; the branch decision is this one.
 */
async function ingestDrop(
  file: File,
  path: string
): Promise<{ record: DropRecord; opened: OpenedPath | null }> {
  const base = { name: file.name, path: null, url: null, bytes: null, digest: null, error: null };

  let opened: OpenedPath | null = null;
  let request: WorkerRequest;
  if (path === '') {
    request = { kind: 'digest', source: { kind: 'file', file } };
  } else {
    opened = await bridge().allowPath(path);
    if (opened === null) {
      return { record: { ...base, branch: 'path', path, error: 'not allow-listed' }, opened: null };
    }
    request = { kind: 'digest', source: { kind: 'url', url: opened.url } };
  }

  const located = {
    ...base,
    branch: path === '' ? ('file' as const) : ('path' as const),
    path: opened?.path ?? null,
    url: opened?.url ?? null,
  };
  try {
    const response = await askWorker(request);
    if (response.kind !== 'digested') {
      const message = response.kind === 'failed' ? response.message : `unexpected ${response.kind}`;
      return { record: { ...located, error: message }, opened };
    }
    return { record: { ...located, bytes: response.bytes, digest: response.digest }, opened };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { record: { ...located, error: message }, opened };
  }
}

export function Phase0App(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const startedRef = useRef(false);
  const [report, setReport] = useState<Phase0Report | null>(null);
  const [opened, setOpened] = useState<OpenedPath[]>([]);
  const [drops, setDrops] = useState<DropRecord[]>([]);

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
      drops: [] as DropRecord[],
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
        const response = await askWorker({
          kind: 'start',
          seed: PING_SEED,
          fileUrl: fixture?.url ?? null,
        });
        if (response.kind !== 'ready') {
          throw new Error(response.kind === 'failed' ? response.message : `got ${response.kind}`);
        }

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
      window.__tetravox_phase0 = { ...report, openedPaths: opened.map((o) => o.path), drops };
  }, [report, opened, drops]);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      // §8: `webUtils.getPathForFile` first, and the `File` itself only when it returns ''. The
      // `dataTransfer.files` list does not survive the first `await`, so snapshot it here.
      const files = Array.from(event.dataTransfer.files);
      void (async () => {
        for (const file of files) {
          const path = bridge().getDroppedFilePath(file);
          const { record, opened: allowed } = await ingestDrop(file, path);
          if (allowed !== null) setOpened((prev) => [...prev, allowed]);
          setDrops((prev) => [...prev, record]);
          note(
            record.error !== null
              ? `drop: ${record.name} (${record.branch}) failed: ${record.error}`
              : `drop: ${record.name} via ${record.branch} -> ${record.bytes} B ` +
                  `digest=0x${(record.digest ?? 0).toString(16)}`
          );
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
      data-testid="drop-target"
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
