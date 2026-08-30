#!/usr/bin/env node
/**
 * Generate the Sample data page from packages/app/src/shared/sample-catalog.json — the same
 * catalogue File ▸ Sample Data… reads, so the website can never list a dataset the app does not
 * offer, or the other way round. Thumbnails come from the app's own card images
 * (packages/app/src/renderer/src/assets/samples/), copied to public/samples/.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBSITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(WEBSITE, '..');
const CATALOG = join(REPO, 'packages', 'app', 'src', 'shared', 'sample-catalog.json');
const THUMBS = join(REPO, 'packages', 'app', 'src', 'renderer', 'src', 'assets', 'samples');
const PUBLIC_OUT = join(WEBSITE, 'public', 'samples');
const PAGE = join(WEBSITE, 'sample-data.md');

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));

function mb(n) {
  return n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} kB`
    : `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

mkdirSync(PUBLIC_OUT, { recursive: true });

const groups = [];
for (const s of catalog.samples) if (!groups.includes(s.group)) groups.push(s.group);

let out = `---
title: Sample data
---

# Sample data

Public datasets to try Tetravox on, the same list as **File ▸ Sample Data…** in the app. In the app one
click downloads a sample into the cache (once, verified by sha256) and opens it as a ready-made scene —
layout, colour maps, thresholds and camera already set; here every file is a direct link, for scripting or for a machine without the app. Nothing on this page is original work — each
sample keeps the licence of its source.

The files are hosted the way [3D Slicer's SlicerDataStore](https://github.com/Slicer/SlicerDataStore)
hosts its sample data: as assets of one GitHub release, **named by their own sha256**, at
\`${catalog.store}<sha256>\`. Non-commercial data (CC-BY-NC) is not re-hosted; those links go to the source.

`;

for (const group of groups) {
  out += `## ${group}\n\n<div class="shot-pair">\n`;
  for (const s of catalog.samples.filter((x) => x.group === group)) {
    copyFileSync(join(THUMBS, `${s.thumbnail}.jpg`), join(PUBLIC_OUT, `${s.thumbnail}.jpg`));
    const total = s.files.reduce((n, f) => n + f.bytes, 0);
    const files = s.files
      .map((f) => `<a href="${f.url}"><code>${f.name}</code></a> (${mb(f.bytes)})`)
      .join(', ');
    out += `  <figure id="${s.id}">
    <img src="/samples/${s.thumbnail}.jpg" alt="${s.title}" loading="lazy">
    <figcaption><strong>${s.title}</strong> — ${s.description}<br>
    ${mb(total)} · <a href="${s.sourceUrl}">${s.source}</a> · ${s.licence}<br>
    Files: ${files}</figcaption>
  </figure>
`;
  }
  out += `</div>\n\n`;
}

out += `## Where the app puts them

Downloads land in the app's cache — \`~/Library/Application Support/Tetravox/sample-data/\` on macOS,
\`~/.config/Tetravox/sample-data/\` on Linux, \`%APPDATA%\\Tetravox\\sample-data\\\` on Windows — one
directory per sample, so a volume and its \`_LUT.txt\` stay side by side. **Show cache** in the dialog opens
it; **Remove** deletes one sample. A file already in the cache is re-hashed before it is opened, so a
partial or altered download is fetched again rather than trusted.
`;

writeFileSync(PAGE, out);
console.log(`sample-data: ${catalog.samples.length} samples → ${PAGE}`);
