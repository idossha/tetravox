#!/usr/bin/env node
/**
 * Record the UX walk-through and turn it into a GIF.
 *
 * ROADMAP's Phase-2 gate asks for "UX walk-through recorded as a GIF" (owner: A-SHELL). This is the
 * driver: it runs `e2e/walkthrough.spec.ts`, which writes a PNG sequence and a WebM, and then makes
 * the GIF out of the PNG sequence.
 *
 * **ffmpeg is optional, and its absence is not a failure.** It is not in `package.json` and cannot be
 * (§12.3 freezes the dependency list, and a 70 MB binary is not a devDependency anyway), so this
 * checks for it and says what it found. Without it the PNG sequence and the WebM are still on disk
 * and still show the walk — which is the whole reason the spec writes frames rather than relying on
 * the video. The script exits 0 either way; a missing GIF is a message, not a red build.
 *
 * Usage:
 *   pnpm --filter @tetravox/app walkthrough
 *   TETRAVOX_TESTDATA=… pnpm --filter @tetravox/app walkthrough   # real ernie rather than fixtures
 *   TETRAVOX_WALKTHROUGH_OUT=/somewhere pnpm --filter @tetravox/app walkthrough
 */

/* `eslint.config.js` declares Node's globals for the **root** `scripts/` directory only, and that
   file is the integrator's. Declaring them here keeps `no-undef` live without editing it. */
/* global console, process */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.TETRAVOX_WALKTHROUGH_OUT ?? join(APP_ROOT, 'test-results', 'walkthrough');

/** Frames per second of the GIF. Two is a reading pace: each step is held for half a second. */
const FPS = Number(process.env.TETRAVOX_WALKTHROUGH_FPS ?? '2');
/** Width of the GIF. 1200 keeps the toolbar's labels legible without a 20 MB file. */
const WIDTH = Number(process.env.TETRAVOX_WALKTHROUGH_WIDTH ?? '1200');

function have(command) {
  const probe = spawnSync(command, ['-version'], { stdio: 'ignore' });
  return probe.error === undefined && probe.status === 0;
}

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  return spawnSync(command, args, { stdio: 'inherit', cwd: APP_ROOT, ...options });
}

// ---- 1. Record --------------------------------------------------------------------------------

const recorded = run('pnpm', ['exec', 'playwright', 'test', 'walkthrough', '--project=dev'], {
  env: { ...process.env, TETRAVOX_WALKTHROUGH: '1', TETRAVOX_WALKTHROUGH_OUT: OUT },
});
if (recorded.status !== 0) {
  console.error('\n[walkthrough] the recording run failed; see the Playwright output above.');
  process.exit(recorded.status ?? 1);
}

const framesDir = join(OUT, 'frames');
if (!existsSync(framesDir)) {
  console.error(`[walkthrough] no frames at ${framesDir} — did the spec skip?`);
  process.exit(1);
}
const frames = readdirSync(framesDir)
  .filter((name) => name.endsWith('.png'))
  .sort();
console.log(`\n[walkthrough] ${frames.length} frames in ${framesDir}`);

if (existsSync(join(OUT, 'manifest.json'))) {
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
  console.log(`[walkthrough] real data: ${manifest.realData ? 'yes' : 'no (synthetic fixtures)'}`);
  for (const step of manifest.steps) {
    const mark = step.pending === undefined ? '·' : '○';
    const note = step.pending === undefined ? '' : `  (pending: ${step.pending})`;
    console.log(`  ${mark} ${step.name.padEnd(12)} ${step.caption}${note}`);
  }
}

const video = existsSync(join(OUT, 'video'))
  ? readdirSync(join(OUT, 'video')).find((name) => name.endsWith('.webm'))
  : undefined;
if (video !== undefined) console.log(`[walkthrough] video: ${join(OUT, 'video', video)}`);

// ---- 2. GIF, if ffmpeg is here ------------------------------------------------------------------

if (!have('ffmpeg')) {
  console.log(
    [
      '',
      '[walkthrough] ffmpeg not found — no GIF was made, and that is not an error.',
      `[walkthrough] The PNG sequence is at ${framesDir}, with captions in manifest.json,`,
      video === undefined ? '' : `[walkthrough] and the WebM is at ${join(OUT, 'video', video)}.`,
      '[walkthrough] To produce the GIF: `brew install ffmpeg` (or your package manager) and re-run.',
    ]
      .filter((line) => line !== '')
      .join('\n')
  );
  process.exit(0);
}

const gif = join(OUT, 'walkthrough.gif');
// One filter graph, two passes: `palettegen` over the whole sequence, then `paletteuse`. A GIF made
// without it quantises to the default 216-colour web palette and the dark theme turns to mud.
const filter = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`;
const made = run('ffmpeg', [
  '-y',
  '-framerate',
  String(FPS),
  '-i',
  join(framesDir, 'frame-%03d.png'),
  '-vf',
  filter,
  '-loop',
  '0',
  gif,
]);

if (made.status !== 0) {
  console.error('[walkthrough] ffmpeg failed; the PNG sequence is still at', framesDir);
  process.exit(0);
}
console.log(`\n[walkthrough] GIF: ${gif}`);
console.log(
  '[walkthrough] Commit it under docs/ when the gate is assembled — this directory is ignored.'
);
