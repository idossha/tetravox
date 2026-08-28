#!/usr/bin/env node
/**
 * Generate the Gallery page from docs/reports/2026-08-28-visualization-scenarios/scenarios.json —
 * the 18-plate scenario record is the source of truth; this script never
 * hand-copies its titles or descriptions.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBSITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(WEBSITE, '..');
const REPORT_DIR = join(REPO, 'docs', 'reports', '2026-08-28-visualization-scenarios');
const SRC_OUT = join(WEBSITE, 'src');
const PUBLIC_OUT = join(WEBSITE, 'public', 'gallery');

const scenarios = JSON.parse(readFileSync(join(REPORT_DIR, 'scenarios.json'), 'utf8'));

mkdirSync(PUBLIC_OUT, { recursive: true });

function escapeAlt(text) {
  return text.replace(/"/g, '&quot;');
}

const cards = scenarios
  .map((s) => {
    cpSync(join(REPORT_DIR, s.file), join(PUBLIC_OUT, s.file));
    return `<div class="gallery-card">
  <img src="/gallery/${s.file}" alt="${escapeAlt(s.title)}" loading="lazy">
  <div class="gallery-card__body">
    <p class="gallery-card__title">${s.title}</p>
    <p class="gallery-card__text">${escapeAlt(s.what_it_shows)}</p>
  </div>
</div>`;
  })
  .join('\n');

const page = `---
title: Gallery
---

# Gallery

${scenarios.length} rendering scenarios captured from the real \`sub-ernie\` SimNIBS dataset, one per major
feature — volumes, meshes, clipping, isosurfaces, vector glyphs, atlas labels, scenes, and the app's own
dialogs. Generated from [\`docs/reports/2026-08-28-visualization-scenarios/\`](https://github.com/idossha/tetravox/tree/main/docs/reports/2026-08-28-visualization-scenarios).

<div class="gallery-grid">

${cards}

</div>
`;

mkdirSync(SRC_OUT, { recursive: true });
writeFileSync(join(SRC_OUT, 'gallery.md'), page);

console.log(`gallery.mjs: wrote ${scenarios.length} plates to website/src/gallery.md`);
