#!/usr/bin/env node
/**
 * Generate the Gallery page from docs/screenshots/2026-08-29/manifest.json —
 * the capture manifest is the source of truth; this script never hand-copies
 * its titles or descriptions.
 *
 * The manifest is a JSON array of
 *   { file, group, title, what_it_shows, dataset }
 * where `file` is the path inside the capture directory, including its group
 * subdirectory (`hero/hero-t1-atlas-2x2.png`). sync.mjs has already copied the
 * whole directory to website/public/shots/, so this script only references
 * `/shots/<file>` and copies nothing itself.
 *
 * Groups get one `## ` section each, in GROUPS order. A `motion` entry names
 * its `.gif`; the page embeds the `.mp4` sibling as an autoplaying loop.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBSITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(WEBSITE, '..');
const SHOTS_DIR = join(REPO, 'docs', 'screenshots', '2026-08-29');
const MANIFEST = join(SHOTS_DIR, 'manifest.json');
const SRC_OUT = join(WEBSITE, 'src');

// Order is the reading order of the page: what it looks like, what it opens,
// the head model, what it opens, what it does, what it does in motion, and finally the app's own chrome.
const GROUPS = [
  {
    id: 'hero',
    heading: 'Hero',
    blurb: 'The pictures the home page and README lead with — one scene per data domain.',
  },
  {
    id: 'brain',
    heading: 'Brain',
    blurb:
      'The SimNIBS head model the viewer was built around: the T1, its surfaces, atlas and electrodes, the tissue mesh, and simulated tES fields on it.',
  },
  {
    id: 'modalities',
    heading: 'Modalities',
    blurb:
      'The same viewer across MRI, CT and segmentations of the head, chest, abdomen, spine and pelvis — each dataset as an overview and a zoomed detail.',
  },
  {
    id: 'features',
    heading: 'Features',
    blurb: 'One or two plates per section of the guide, so every control has a picture.',
  },
  {
    id: 'motion',
    heading: 'Motion',
    blurb: 'Orbits, slice sweeps and animated parameters, rendered offscreen by the job runner.',
  },
  { id: 'ui', heading: 'Interface', blurb: 'The window, its panels and its dialogs.' },
];

const entries = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : [];
if (!Array.isArray(entries)) {
  throw new Error('gallery.mjs: ' + MANIFEST + ' must be a JSON array of capture entries');
}
if (!existsSync(MANIFEST)) {
  console.warn('gallery.mjs: no manifest at ' + MANIFEST + ' - writing an empty gallery');
}

const known = new Set(GROUPS.map((g) => g.id));
for (const e of entries) {
  if (!known.has(e.group)) {
    throw new Error(
      `gallery.mjs: entry "${e.file}" has unknown group "${e.group}" - expected one of ${[...known].join(', ')}`
    );
  }
}

function escapeAttr(text) {
  return String(text ?? '').replace(/"/g, '&quot;');
}

/** `<` and `>` in prose would be parsed as markup by VitePress' Vue compiler. */
function escapeText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function media(entry) {
  if (entry.group !== 'motion') {
    return `<img src="/shots/${entry.file}" alt="${escapeAttr(entry.title)}" loading="lazy">`;
  }
  const mp4 = entry.file.replace(/\.gif$/, '.mp4');
  return `<video src="/shots/${mp4}" autoplay loop muted playsinline></video>`;
}

function card(entry) {
  const dataset = entry.dataset
    ? `\n    <p class="gallery-card__meta">${escapeText(entry.dataset)}</p>`
    : '';
  return `<div class="gallery-card">
  ${media(entry)}
  <div class="gallery-card__body">
    <p class="gallery-card__title">${escapeText(entry.title)}</p>
    <p class="gallery-card__text">${escapeText(entry.what_it_shows)}</p>${dataset}
  </div>
</div>`;
}

const sections = GROUPS.map((group) => {
  const items = entries.filter((e) => e.group === group.id);
  if (items.length === 0) return '';
  return `## ${group.heading}

${group.blurb}

<div class="gallery-grid">

${items.map(card).join('\n')}

</div>
`;
})
  .filter(Boolean)
  .join('\n');

const page = `---
title: Gallery
---

# Gallery

${entries.length} plates captured from the datasets listed in
[\`docs/screenshots/2026-08-29/DATASETS.md\`](https://github.com/idossha/tetravox/blob/main/docs/screenshots/2026-08-29/DATASETS.md)
— brain MRI and head models, head/chest/abdomen CT, abdominal and spinal MRI, and the segmentations that
go with them. Every plate is rendered offscreen by the same engine the window uses, from a job document in
[\`docs/screenshots/2026-08-29/jobs/\`](https://github.com/idossha/tetravox/tree/main/docs/screenshots/2026-08-29/jobs).

${sections}`;

mkdirSync(SRC_OUT, { recursive: true });
writeFileSync(join(SRC_OUT, 'gallery.md'), page);
// The old per-plate copy under public/gallery/ is no longer produced - the
// gallery now points at the same /shots/ tree sync.mjs writes.
rmSync(join(WEBSITE, 'public', 'gallery'), { recursive: true, force: true });

console.log(`gallery.mjs: wrote ${entries.length} plates to website/src/gallery.md`);
