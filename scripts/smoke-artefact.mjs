#!/usr/bin/env node
/**
 * The artefact smoke test that ARCHITECTURE.md §12.1 requires of every `package` leg:
 *
 * > launch the packaged binary with a CLI arg pointing at a fixture and assert it exits 0 after
 * > rendering one frame.
 *
 * It runs the **packaged** binary — not `electron out/main`, not a dev build — with
 * `--job <fixture> --out <tmp>` and then asserts on `job-result.json`: `ok: true`, one screenshot
 * output, and a PNG on disk that is bigger than a header. That is a real frame off the GPU, so a
 * build that packages cleanly and then cannot start a renderer is red here rather than in a user's
 * download.
 *
 * Why `--job` and not a window: a `--job` launch is forced offscreen by `src/main/window.ts` and is
 * exempt from the single-instance lock, so it works on a hosted runner with no display manager (with
 * an Xvfb on Linux, as CI already provides) and it never takes a developer's focus. AGENTS.md rule 9.
 *
 * Usage:
 *   node scripts/smoke-artefact.mjs                        # auto-discover in packages/app/release
 *   node scripts/smoke-artefact.mjs --exe <path>           # an explicit binary
 *   node scripts/smoke-artefact.mjs --version-only         # launch-and-exit only (Windows, see below)
 *   node scripts/smoke-artefact.mjs --software-gl          # force ANGLE/SwiftShader (GPU-less runner)
 *
 * **`--software-gl`** is for a hosted runner with no GPU, and it is the difference between a leg that
 * renders and one that cannot start a context at all. It launches the binary with `--software-gl`
 * (see `src/main/index.ts` §2 for the switches that turns into) and then *asserts* that the renderer
 * the job actually got was a software one — so a leg that silently found a real GPU, or one whose
 * flags stopped working, is red rather than quietly making a different claim than its name.
 *
 * **`--version-only`** is the Windows leg's contract and a deliberately weaker claim. Electron on a
 * hosted `windows-latest` runner has no GPU and no compositor, and the offscreen path there is
 * SwiftShader at best; rather than let the Windows leg go green on a vacuous render, it asserts only
 * that the installed binary starts, prints a version and exits 0. What Windows proves is
 * "the installer produced a runnable exe"; what macOS and Linux prove is "it renders".
 */

import { spawn } from 'node:child_process';
import {
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = join(ROOT, 'packages', 'app', 'release');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? '');
};
const has = (name) => argv.includes(name);

const TIMEOUT_MS = Number(process.env['TETRAVOX_SMOKE_TIMEOUT_MS'] ?? 180_000);

function die(message) {
  console.error(`[smoke] FAIL: ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------------------------------------
// Finding the binary
// ------------------------------------------------------------------------------------------------

/**
 * The packaged executable inside `packages/app/release`.
 *
 * On macOS `electron-builder` leaves the unpacked `.app` in `release/mac-arm64/` (and `release/mac/`
 * for x64), which is what this launches — mounting a `.dmg` in CI is a `hdiutil attach` away from
 * being the thing under test, and the `.app` inside it is byte-identical to the one on disk here.
 *
 * On Linux, the `.AppImage` needs libfuse2 to self-mount, which the builder container does not have.
 * So `linux-unpacked/tetravox` is preferred and the AppImage is only used when the unpacked tree is
 * absent — `scripts/package-linux.sh` extracts the AppImage with `--appimage-extract` instead.
 */
function discoverExecutable() {
  if (!existsSync(RELEASE)) die(`no ${RELEASE} — run \`pnpm package\` first`);
  const entries = readdirSync(RELEASE);
  if (process.platform === 'darwin') {
    // The host's own arch FIRST. electron-builder writes arm64 to `release/mac-arm64` and x64 to
    // `release/mac`, both are present after a two-arch build, and a plain readdir finds `mac` first —
    // which on Apple silicon smoke-tests the x64 slice under Rosetta and never touches the arm64 one.
    // That leg passes, so the hole is silent.
    const preferred = process.arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-arm64'];
    for (const dir of [...preferred, ...entries]) {
      const exe = join(RELEASE, dir, 'Tetravox.app', 'Contents', 'MacOS', 'Tetravox');
      if (existsSync(exe)) return exe;
    }
    die('no Tetravox.app under packages/app/release');
  }
  if (process.platform === 'win32') {
    for (const dir of entries) {
      const exe = join(RELEASE, dir, 'Tetravox.exe');
      if (existsSync(exe)) return exe;
    }
    die('no Tetravox.exe under packages/app/release');
  }
  const unpacked = join(RELEASE, 'linux-unpacked', 'tetravox');
  if (existsSync(unpacked)) return unpacked;
  const appImage = entries.find((e) => e.endsWith('.AppImage'));
  if (appImage) return join(RELEASE, appImage);
  return die('no linux-unpacked/tetravox and no .AppImage under packages/app/release');
}

/**
 * **Every** packaged binary this platform produced, for `--all`.
 *
 * On macOS that is both slices, and both are smoke-tested on one runner: `electron-builder.yml`
 * builds `arch: [arm64, x64]` whatever `--mac --arm64` asks for, so a single Apple-silicon runner
 * already emits all six mac assets. The x64 slice then runs under Rosetta 2 — a *real* Metal
 * renderer, measured at 37 s for this job on an M2 — which is a far stronger claim than the
 * GPU-less Intel runner could make (docs/RELEASING.md §1).
 */
function discoverAllExecutables() {
  if (!existsSync(RELEASE)) die(`no ${RELEASE} — run \`pnpm package\` first`);
  if (process.platform !== 'darwin') return [discoverExecutable()];
  const found = [];
  for (const dir of ['mac-arm64', 'mac']) {
    const exe = join(RELEASE, dir, 'Tetravox.app', 'Contents', 'MacOS', 'Tetravox');
    if (existsSync(exe)) found.push(exe);
  }
  if (found.length === 0) die('no Tetravox.app under packages/app/release');
  return found;
}

const explicit = flag('--exe');
const exes =
  explicit !== null ? [explicit] : has('--all') ? discoverAllExecutables() : [discoverExecutable()];
for (const exe of exes) {
  if (!existsSync(exe)) die(`no such executable: ${exe}`);
  console.log(`[smoke] binary: ${exe} (${(statSync(exe).size / 1e6).toFixed(1)} MB)`);
}

/**
 * Chromium's SUID sandbox helper is not root-owned setuid inside an AppImage or an unpacked tree, and
 * Chromium aborts with SIGTRAP rather than drop the sandbox silently — even for `--version`. §12.2.
 */
const LINUX_ARGS = process.platform === 'linux' ? ['--no-sandbox'] : [];

/** `--software-gl`, or the env var so a workflow can set it once for a whole leg. */
const SOFTWARE_GL = has('--software-gl') || process.env['TETRAVOX_SOFTWARE_GL'] === '1';
const GL_ARGS = SOFTWARE_GL ? ['--software-gl'] : [];
if (SOFTWARE_GL) console.log('[smoke] software GL: ANGLE/SwiftShader requested');

function run(exe, args, env) {
  return new Promise((done) => {
    const child = spawn(exe, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += `\n[smoke] killed after ${TIMEOUT_MS} ms`;
    }, TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ code: 127, stdout, stderr: `${stderr}\n${String(error)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr });
    });
  });
}

// ------------------------------------------------------------------------------------------------
// The two checks
// ------------------------------------------------------------------------------------------------

if (has('--version-only')) {
  for (const exe of exes) {
    const { code, stdout, stderr } = await run(exe, [...LINUX_ARGS, ...GL_ARGS, '--version']);
    console.log(stdout.trim() || stderr.trim());
    if (code !== 0) die(`--version exited ${code}\n${stderr}`);
  }
  console.log('[smoke] PASS (launch-and-exit)');
  process.exit(0);
}

/**
 * The fixture: two committed synthetic files (a NIfTI and a tet-only `.msh`), a `plain` preset and one
 * screenshot. Small on purpose — this test asks "does the packaged renderer produce a frame", not
 * "is the frame correct", which is §11's job and is covered on the dev build by hundreds of tests.
 */
const dir = mkdtempSync(join(tmpdir(), 'tetravox-smoke-'));
const outDir = join(dir, 'out');
mkdirSync(outDir, { recursive: true });
const jobPath = join(dir, 'job.json');
writeFileSync(
  jobPath,
  JSON.stringify(
    {
      version: 1,
      scene: {
        files: [
          join(ROOT, 'testdata', 'vol_asym.nii'),
          join(ROOT, 'testdata', 'mesh_v2_ascii.msh'),
        ],
        preset: 'plain',
      },
      window: { width: 640, height: 480 },
      actions: [
        { type: 'set', layout: '2x2', view: 'axial' },
        { type: 'screenshot', out: 'smoke.png', view: 'axial', width: 400 },
      ],
    },
    null,
    2
  )
);

for (const file of ['vol_asym.nii', 'mesh_v2_ascii.msh']) {
  const p = join(ROOT, 'testdata', file);
  if (!existsSync(p)) die(`fixture missing: ${p} (run from a full checkout)`);
}

/** The whole §12.1 claim, for one binary. Called once per slice under `--all`. */
async function jobSmoke(exe) {
  const started = Date.now();
  const { code, stdout, stderr } = await run(
    exe,
    [...LINUX_ARGS, ...GL_ARGS, '--job', jobPath, '--out', outDir],
    {
      // A private profile, so the smoke run never joins a developer's running copy or writes to it.
      TETRAVOX_SMOKE: '1',
    }
  );
  const elapsed = Date.now() - started;

  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());

  const resultPath = join(outDir, 'job-result.json');
  if (!existsSync(resultPath)) die(`exit ${code} and no job-result.json in ${outDir}`);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));

  if (code !== 0)
    die(`the packaged binary exited ${code}; errors: ${JSON.stringify(result.errors)}`);
  if (result.ok !== true) die(`job-result.json is not ok: ${JSON.stringify(result.errors)}`);

  const files = result.outputs.flatMap((o) => o.files);
  if (files.length === 0) die('job-result.json reports ok but wrote no files');

  const png = join(outDir, 'smoke.png');
  if (!existsSync(png))
    die(`job-result.json claims ${files.join(', ')} but smoke.png is not on disk`);
  const bytes = statSync(png).size;
  // A 400 px PNG of anything at all is kilobytes; a header-only or one-flat-colour image is not what
  // a working renderer writes. This is the "rendered one frame" half of the §12.1 requirement.
  if (bytes < 2000) die(`smoke.png is ${bytes} bytes — that is not a rendered frame`);

  /**
   * Which renderer answered. `src/renderer/src/automation/run.ts` logs `gl: <renderer> (software|
   * hardware)` as the job's first line, so this is the packaged app's own report, not an inference.
   *
   * Under `--software-gl` it is an assertion: the leg exists to prove the flags work on a GPU-less
   * runner, and a run that quietly found a real GPU is not that proof. Without the flag it is only
   * reported — the mac legs are allowed to be, and should be, hardware.
   */
  const glLine = /^\[?.*\bgl: (.+?) \((software|hardware)\)/m.exec(stdout);
  if (glLine === null) {
    if (SOFTWARE_GL) die('the job never logged its GL renderer, so software GL is unproven');
    console.log('[smoke] renderer: not reported');
  } else {
    console.log(`[smoke] renderer: ${glLine[1]} (${glLine[2]})`);
    if (SOFTWARE_GL && glLine[2] !== 'software')
      die(`--software-gl asked for SwiftShader and got a ${glLine[2]} renderer (${glLine[1]})`);
  }

  console.log(
    `[smoke] PASS ${exe} — ok=true, ${files.length} output(s), smoke.png ${bytes} B, ` +
      `load ${result.timings.loadMs} ms, total ${elapsed} ms`
  );
  // Between slices: the next run must write its own result, not inherit this one's.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
}

for (const exe of exes) await jobSmoke(exe);
rmSync(dir, { recursive: true, force: true });
