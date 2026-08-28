#!/usr/bin/env node
/**
 * Write `coverage-badge.json` — a shields.io **endpoint** badge — from vitest's coverage summary.
 *
 * Codecov is not the source of the README's coverage number, because it cannot be: this repository's
 * CI has no `CODECOV_TOKEN`, and the uploader now refuses an anonymous upload outright —
 *
 *     info  -- Found 1 coverage files to report
 *     info  -- Upload queued for processing complete
 *     error -- Upload queued for processing failed: {"message":"Token required - not valid tokenless upload"}
 *
 * — with `fail_ci_if_error: false` keeping the step green, so the only visible symptom was a shields
 * badge reading `coverage unknown` and nothing red to explain it. The upload is still attempted (it
 * costs two seconds and starts working the moment a token exists), but the badge is generated here
 * from the same run's own numbers and published to the `badges` branch, which shields reads through
 * `img.shields.io/endpoint`.
 *
 * Usage: node scripts/coverage-badge.mjs [--in coverage/coverage-summary.json] [--out coverage.json]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};

const input = resolve(flag('--in', 'coverage/coverage-summary.json'));
const output = resolve(flag('--out', 'coverage.json'));

const summary = JSON.parse(readFileSync(input, 'utf8'));
const pct = summary.total?.lines?.pct;
if (typeof pct !== 'number' || !Number.isFinite(pct)) {
  console.error(
    `[coverage-badge] ${input} has no total.lines.pct — is this a json-summary report?`
  );
  process.exit(1);
}

// Codecov's own thresholds, so the colour means the same thing it would have on their badge.
const colour =
  pct >= 90
    ? 'brightgreen'
    : pct >= 80
      ? 'green'
      : pct >= 70
        ? 'yellowgreen'
        : pct >= 60
          ? 'yellow'
          : pct >= 40
            ? 'orange'
            : 'red';

const badge = {
  schemaVersion: 1,
  label: 'coverage',
  message: `${pct.toFixed(0)}%`,
  color: colour,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(badge, null, 2)}\n`);
console.log(`[coverage-badge] ${output}: ${badge.message} (${colour})`);
