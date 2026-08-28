#!/usr/bin/env node
/**
 * Print CHANGELOG.md's section for one version, plus the unsigned-build note, as GitHub Release body
 * text. `.github/workflows/release.yml` pipes this into `GITHUB_OUTPUT`; `generate_release_notes`
 * then appends the commit/PR summary underneath, so the notes are a human paragraph followed by a
 * machine one rather than only the machine one.
 *
 *   node scripts/changelog-section.mjs 0.2.0
 *
 * A version with no section is not an error: a release can be cut from a tag whose notes were never
 * written, and refusing to draft it would be a worse outcome than drafting it with the boilerplate
 * only. It says so on stderr.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('usage: changelog-section.mjs <version>');
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n');

const heading = `## [${version}]`;
const start = lines.findIndex((l) => l.startsWith(heading));
let body = '';
if (start === -1) {
  console.error(`[changelog] no "${heading}" section — the release body will be boilerplate only.`);
} else {
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## ['));
  body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

const unsigned = [
  '### Unsigned builds',
  '',
  'Every artefact here is unsigned (ARCHITECTURE.md §12.2). Signing and notarisation are a documented',
  'switch, not a plan; auto-update stays out of scope while unsigned.',
  '',
  '- **macOS** — Gatekeeper refuses the first launch. `xattr -dr com.apple.quarantine /Applications/Tetravox.app`',
  '- **Windows** — SmartScreen warns. More info → Run anyway.',
  '- **Linux** — the AppImage needs `--no-sandbox`, or a root-owned setuid `chrome-sandbox`.',
].join('\n');

process.stdout.write(`${body ? `${body}\n\n---\n\n` : ''}${unsigned}\n`);
