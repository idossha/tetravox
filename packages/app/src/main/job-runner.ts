/**
 * The main-process half of `Tetravox --job job.json --out DIR [--quiet]`.
 *
 * It owns everything the renderer must not: the filesystem, the window, ffmpeg, the exit code. The
 * renderer owns the `Engine` and therefore every decision about what a picture contains (§8:
 * "everything the UI can do must be reachable from the `Engine` API alone. No logic in React" — and
 * no logic in main either).
 *
 * The sequence:
 *
 * 1. `--job` is parsed and the document validated (`job.ts`, pure). A bad job exits **before** a
 *    window is created, so a typo costs 200 ms and not a GPU context.
 * 2. Every path the job names is added to the `tetravox://file/…` allow-list (§5 directive A2). The
 *    job file **is** the user naming those paths, which is exactly what the allow-list encodes.
 * 3. A `BrowserWindow` is created in the offscreen mode `window.ts` documents — built, never shown,
 *    no dock icon, no focus. AGENTS rule 9 says a test run may not hijack the monitor; an unattended
 *    job has the same claim on it, and `TETRAVOX_E2E_HEADED` is never set here.
 * 4. The renderer pulls the job (`tetravox:job-spec`), runs it against the engine, and posts each
 *    output back as PNG bytes. Main writes the files, encodes the GIF (`gif.ts`) and, when ffmpeg is
 *    on PATH, the MP4.
 * 5. `job-result.json` is written and the process exits 0 or 1.
 *
 * **PNG bytes over IPC are not "raw file bytes on the UI thread"** (§5 rule 3). Nothing was read from
 * disk: they are a screenshot the renderer just produced, bounded by the canvas, and the existing
 * screenshot button already reads exactly such a blob back (`controller.saveScreenshot`). Dataset
 * bytes still never cross — the worker fetches those over `tetravox://file/…` as always.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import { BrowserWindow as BrowserWindowClass, app, ipcMain } from 'electron';
import { encodeGif } from './gif';
import type { GifFrame } from './gif';
import { decodePng } from './png';
import { allowPath } from './paths';
// §13.6: a module operation's `out` argument is admitted for writing here, through the same
// module-scoped write list a Save sheet fills (§5 rule 11) — a batch run has no sheet to open.
import { admitModuleWrite } from './module-io';
import {
  expandEnv,
  parseJobArgs,
  validateJob,
  JOB_SCHEMA_VERSION,
  jobInputPaths,
  jobModules,
  moduleOutTargets,
  withInputPaths,
} from './job';
import type { Job, JobInvocation, JobOutput, JobResult } from './job';

/** What the renderer pulls at startup. */
export interface JobRequest {
  job: Job;
  outDir: string;
  quiet: boolean;
}

/** One `screenshot`, or one frame of a `sweep` / `orbit`, handed over as an encoded PNG. */
export interface JobWriteRequest {
  /** Relative to `--out`. Validated again here: a renderer bug must not write outside the out dir. */
  name: string;
  bytes: Uint8Array;
}

export interface JobFramesRequest {
  /** Base name, relative to `--out`, without an extension. */
  base: string;
  fps: number;
  /** Which artefacts to produce, beyond the PNG frames that are always written. */
  gif: boolean;
  mp4: boolean;
  /** GIF palette size. */
  colors?: number;
  /**
   * The frame number the first of {@link JobFramesRequest.frames} takes — how a `sequence` of
   * several actions writes into one video (`job.ts`'s `SequenceRole`). Default 0.
   */
  startIndex?: number;
  frames: Uint8Array[];
}

export interface JobFinish {
  ok: boolean;
  outputs: JobOutput[];
  warnings: string[];
  errors: string[];
  loadMs: number;
}

// ------------------------------------------------------------------------------------------------
// State
// ------------------------------------------------------------------------------------------------

let request: JobRequest | null = null;
let startedAt = 0;

export function jobRequest(): JobRequest | null {
  return request;
}

export function isJobRun(): boolean {
  return request !== null;
}

// ------------------------------------------------------------------------------------------------
// Files
// ------------------------------------------------------------------------------------------------

/**
 * Resolve an output name inside `--out`, or throw.
 *
 * `job.ts` already rejects `..` and absolute names at validation time; this is the second check, at
 * the moment of writing, because the first one guards the *document* and this one guards the
 * *filesystem*. They are cheap and they fail differently: one is a bad job, the other is a bug.
 */
export function resolveOutput(outDir: string, name: string): string {
  const full = resolve(outDir, name);
  const rel = relative(outDir, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`output "${name}" escapes --out`);
  }
  return full;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// ------------------------------------------------------------------------------------------------
// ffmpeg
// ------------------------------------------------------------------------------------------------

/**
 * Whether `ffmpeg` answers `-version`, cached for the run.
 *
 * `which` is not used: a PATH entry that exists and cannot execute (a stale Homebrew symlink after an
 * OS upgrade is the common one) would pass it and then fail the encode. Running the binary is the
 * only check that means anything.
 */
let ffmpegChecked: string | null | undefined;

export function ffmpegPath(): string | null {
  if (ffmpegChecked !== undefined) return ffmpegChecked;
  const candidate = process.env['TETRAVOX_FFMPEG'] ?? 'ffmpeg';
  try {
    const probe = spawnSync(candidate, ['-version'], { stdio: 'ignore' });
    ffmpegChecked = probe.status === 0 ? candidate : null;
  } catch {
    ffmpegChecked = null;
  }
  return ffmpegChecked;
}

/**
 * PNG frames → H.264 MP4. Returns the file name, or a warning string explaining why there is none.
 *
 * `-pix_fmt yuv420p` and the `pad` filter are both about the same thing: a stream whose width or
 * height is odd is legal H.264 in the abstract and unplayable in QuickTime, Slack and every browser,
 * and a screenshot at a user-chosen width is odd half the time.
 */
function encodeMp4(
  outDir: string,
  base: string,
  pattern: string,
  fps: number
): { file: string } | { warning: string } {
  const ffmpeg = ffmpegPath();
  if (ffmpeg === null) {
    return { warning: `no ffmpeg on PATH — ${base}.mp4 was not written (the GIF was)` };
  }
  const file = `${base}.mp4`;
  const result = spawnSync(
    ffmpeg,
    [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      String(fps),
      '-i',
      pattern,
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '20',
      resolveOutput(outDir, file),
    ],
    { cwd: outDir, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  if (result.status !== 0) {
    const detail =
      String(result.stderr ?? '')
        .trim()
        .split('\n')
        .slice(-1)[0] ?? 'unknown error';
    return { warning: `ffmpeg failed for ${file}: ${detail}` };
  }
  return { file };
}

// ------------------------------------------------------------------------------------------------
// IPC
// ------------------------------------------------------------------------------------------------

interface Collected {
  outputs: JobOutput[];
  warnings: string[];
  errors: string[];
}

const collected: Collected = { outputs: [], warnings: [], errors: [] };

function log(message: string): void {
  if (request?.quiet !== true) console.log(`[tetravox:job] ${message}`);
}

/**
 * Register the job IPC. Called unconditionally from main, so the channels exist before the window
 * does — a renderer that asks for a spec on a normal launch is told `null` and takes the UI path.
 */
export function registerJobIpc(): void {
  ipcMain.handle('tetravox:job-spec', () => request);

  // `view: "window"` — a picture of the whole window, panels and toolbar included, rather than of
  // the engine's canvas. Only main can take it: `capturePage` is a `webContents` call, and the
  // renderer has no handle on its own window. It comes back at the display's device pixel ratio, so
  // it is resized down to the size the action asked for — which is supersampling, not upscaling, and
  // is why a UI tour frame is as sharp as an engine frame beside it in the same video.
  ipcMain.handle(
    'tetravox:job-capture',
    async (event, width: unknown, height: unknown): Promise<Uint8Array | null> => {
      if (request === null) return null;
      const win = BrowserWindowClass.fromWebContents(event.sender);
      if (win === null) return null;
      let image = await win.webContents.capturePage();
      if (typeof width === 'number' && typeof height === 'number') {
        image = image.resize({ width, height, quality: 'best' });
      }
      return new Uint8Array(image.toPNG());
    }
  );

  ipcMain.handle('tetravox:job-write', (_event, payload: unknown) => {
    if (request === null) return { ok: false, error: 'not a job run' };
    const { name, bytes } = payload as JobWriteRequest;
    try {
      const path = resolveOutput(request.outDir, name);
      ensureDir(join(path, '..'));
      writeFileSync(path, Buffer.from(bytes));
      log(`wrote ${name} (${statSync(path).size} B)`);
      return { ok: true, file: name };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('tetravox:job-frames', (_event, payload: unknown) => {
    if (request === null) return { ok: false, error: 'not a job run' };
    const { base, fps, gif, mp4, colors, startIndex, frames } = payload as JobFramesRequest;
    const first = startIndex ?? 0;
    const files: string[] = [];
    const warnings: string[] = [];
    try {
      const dir = resolveOutput(request.outDir, base);
      ensureDir(join(dir, '..'));
      // PNG frames, always. `%04d` is what ffmpeg's image2 demuxer reads back, and a zero-padded
      // name is also what sorts correctly in a file browser.
      const decoded: GifFrame[] = [];
      for (const [i, bytes] of frames.entries()) {
        const name = `${base}-${String(first + i).padStart(4, '0')}.png`;
        writeFileSync(resolveOutput(request.outDir, name), Buffer.from(bytes));
        files.push(name);
        if (gif) decoded.push(decodePng(Buffer.from(bytes)));
      }
      if (gif && first > 0) {
        // The sequence began in an earlier action, so the earlier frames are on disk and not in
        // this payload. Read them back rather than asking the renderer to resend a video's worth
        // of PNGs it has already handed over once.
        decoded.length = 0;
        for (let i = 0; i < first + frames.length; i += 1) {
          const name = `${base}-${String(i).padStart(4, '0')}.png`;
          decoded.push(decodePng(readFileSync(resolveOutput(request.outDir, name))));
        }
      }
      if (gif && decoded.length > 0) {
        const name = `${base}.gif`;
        writeFileSync(
          resolveOutput(request.outDir, name),
          Buffer.from(encodeGif(decoded, { fps, ...(colors === undefined ? {} : { colors }) }))
        );
        files.push(name);
      }
      if (mp4) {
        const made = encodeMp4(request.outDir, base, `${base}-%04d.png`, fps);
        if ('file' in made) files.push(made.file);
        else warnings.push(made.warning);
      }
      log(`wrote ${files.length} files for ${base}`);
      return { ok: true, files, warnings };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, files, warnings };
    }
  });

  ipcMain.on('tetravox:job-log', (_event, message: unknown) => log(String(message)));

  ipcMain.handle('tetravox:job-done', (_event, payload: unknown) => {
    finish(payload as JobFinish);
    return true;
  });
}

// ------------------------------------------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------------------------------------------

/**
 * Parse argv and prepare the run. Returns the invocation when this is a job launch.
 *
 * Called **before** `app.whenReady()` so the window mode is decided with the answer in hand; a
 * failure here writes what it can and exits without ever creating a window.
 */
export function prepareJob(argv: readonly string[], cwd: string): JobInvocation | null {
  const parsed = parseJobArgs(argv, cwd, (base, p) => (isAbsolute(p) ? p : resolve(base, p)));
  if (parsed === null) return null;
  if (!parsed.ok) {
    console.error(`[tetravox:job] ${parsed.error}`);
    app.exit(1);
    return null;
  }
  const invocation = parsed.invocation;
  startedAt = Date.now();

  if (!existsSync(invocation.jobPath)) {
    fail(invocation, [`job file not found: ${invocation.jobPath}`]);
    return null;
  }
  let parsedJob: unknown;
  try {
    parsedJob = JSON.parse(readFileSync(invocation.jobPath, 'utf8'));
  } catch (error: unknown) {
    fail(invocation, [`job file is not JSON: ${error instanceof Error ? error.message : error}`]);
    return null;
  }
  const validated = validateJob(parsedJob);
  if (!validated.ok || validated.job === undefined) {
    fail(invocation, validated.errors);
    return null;
  }

  const job = validated.job;
  ensureDir(invocation.outDir);

  // §5 directive A2: the job file naming a path *is* the user naming it. Sidecars are admitted by
  // the renderer's own `requestFromPath`, which asks main for each candidate.
  const expansionErrors: string[] = [];
  const wanted = jobInputPaths(job).map((raw) => {
    const expanded = expandEnv(raw, process.env);
    if (!expanded.ok) {
      expansionErrors.push(
        `${raw}: ${expanded.missing.map((n) => `$${n}`).join(', ')} is not set in the environment`
      );
      return raw;
    }
    const p = expanded.path;
    return isAbsolute(p) ? p : resolve(invocation.jobPath, '..', p);
  });
  if (expansionErrors.length > 0) {
    fail(invocation, expansionErrors);
    return null;
  }
  // `allowPath` returns null for a path that does not resolve, so it doubles as the existence check
  // — the same doubling `open/sources.ts` relies on, rather than a second `statSync` here.
  const admitted: string[] = [];
  const missing: string[] = [];
  for (const path of wanted) {
    const real = allowPath(path);
    if (real === null) missing.push(path);
    else admitted.push(real);
  }
  if (missing.length > 0) {
    fail(
      invocation,
      missing.map((p) => `input file not found: ${p}`)
    );
    return null;
  }

  // The renderer is handed the resolved paths, so a job with relative paths behaves the same whether
  // it is run from its own directory or from anywhere else. `withInputPaths` puts them back in the
  // order `jobInputPaths` took them, which is the scene's files and then every module action's
  // `path` arguments (§13.6) — one pass, so a module's input is admitted and resolved by exactly
  // the code that admits and resolves a scene's.
  const resolved = withInputPaths(job, admitted);

  // An `out` argument names a file under `--out` that the module itself writes. Admitting it here —
  // with the sibling templates its writers declare — is what lets a module save in a batch run
  // without a Save sheet, and without main growing a second write path (§5 rule 11).
  try {
    for (const target of moduleOutTargets(resolved)) {
      admitModuleWrite(
        target.module,
        resolveOutput(invocation.outDir, target.name),
        target.siblings
      );
    }
  } catch (error: unknown) {
    fail(invocation, [error instanceof Error ? error.message : String(error)]);
    return null;
  }

  request = { job: resolved, outDir: invocation.outDir, quiet: invocation.quiet };
  log(`job ${invocation.jobPath} → ${invocation.outDir}`);
  return invocation;
}

function writeResult(invocation: JobInvocation, result: JobResult): void {
  try {
    ensureDir(invocation.outDir);
    writeFileSync(
      join(invocation.outDir, 'job-result.json'),
      `${JSON.stringify(result, null, 2)}\n`
    );
  } catch (error: unknown) {
    console.error(`[tetravox:job] could not write job-result.json: ${String(error)}`);
  }
}

function fail(invocation: JobInvocation, errors: string[]): void {
  for (const error of errors) console.error(`[tetravox:job] ${error}`);
  writeResult(invocation, {
    ok: false,
    schemaVersion: JOB_SCHEMA_VERSION,
    job: invocation.jobPath,
    outDir: invocation.outDir,
    outputs: [],
    timings: { totalMs: Date.now() - startedAt, loadMs: 0, actionsMs: 0 },
    warnings: [],
    errors,
  });
  app.exit(1);
}

let invocationForResult: JobInvocation | null = null;

export function rememberInvocation(invocation: JobInvocation): void {
  invocationForResult = invocation;
}

/** The renderer's report: write `job-result.json` and exit with the verdict. */
function finish(report: JobFinish): void {
  const invocation = invocationForResult;
  if (invocation === null) return;
  collected.outputs = report.outputs;
  collected.warnings = report.warnings;
  collected.errors = report.errors;
  const totalMs = Date.now() - startedAt;
  const actionsMs = report.outputs.reduce((sum, o) => sum + o.ms, 0);
  // §13.6: which modules the run depended on, and the version that ran them — main's answer, since
  // main validated the actions against `MANIFESTS` before the window existed. Present only when the
  // job used one, so a job that uses no module writes the result file it always wrote.
  const modules = request === null ? [] : jobModules(request.job);
  const result: JobResult = {
    ok: report.ok,
    schemaVersion: JOB_SCHEMA_VERSION,
    job: invocation.jobPath,
    outDir: invocation.outDir,
    outputs: report.outputs,
    ...(modules.length > 0 ? { modules } : {}),
    timings: { totalMs, loadMs: report.loadMs, actionsMs },
    warnings: report.warnings,
    errors: report.errors,
  };
  writeResult(invocation, result);
  for (const warning of report.warnings) console.warn(`[tetravox:job] warning: ${warning}`);
  for (const error of report.errors) console.error(`[tetravox:job] error: ${error}`);
  log(`${report.ok ? 'done' : 'FAILED'} in ${totalMs} ms — ${report.outputs.length} actions`);
  app.exit(report.ok ? 0 : 1);
}

/**
 * A job that never reports is a job that hung. Without this a renderer crash before `job-done`
 * leaves an Electron process alive with no window on screen and no way to notice.
 */
export function armWatchdog(win: BrowserWindow, timeoutMs: number): void {
  const timer = setTimeout(() => {
    finish({
      ok: false,
      outputs: collected.outputs,
      warnings: collected.warnings,
      errors: [`job timed out after ${timeoutMs} ms`],
      loadMs: 0,
    });
  }, timeoutMs);
  win.once('closed', () => clearTimeout(timer));
  app.once('will-quit', () => clearTimeout(timer));
}

/** The renderer died before reporting: fail rather than hang. */
export function onRendererGone(reason: string): void {
  if (request === null) return;
  finish({ ok: false, outputs: collected.outputs, warnings: [], errors: [reason], loadMs: 0 });
}
