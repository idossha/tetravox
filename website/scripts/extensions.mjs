#!/usr/bin/env node
/**
 * Generate the Extensions page from packages/app/src/shared/extensions-index.json — the same
 * catalogue File ▸ Extensions… reads, so the website can never list an extension the app does not
 * offer, or the other way round. It is the exact counterpart of `sample-data.mjs`, and the index is
 * the copy the app ships (a release refreshes it from idossha/tetravox-extensions), so this page and
 * the dialog agree offline.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBSITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(WEBSITE, '..');
const INDEX = join(REPO, 'packages', 'app', 'src', 'shared', 'extensions-index.json');
const PAGE = join(WEBSITE, 'extensions.md');

const index = JSON.parse(readFileSync(INDEX, 'utf8'));

let out = `---
title: Extensions
---

# Extensions

Optional tools that add a whole workflow to Tetravox — their own panel, keys, files and undo — installed
and managed in **File ▸ Extensions…** in the app. This page is an overview — what an extension is and
what is available; each extension's own page, or its repository, covers what it does. The curated source
is [idossha/tetravox-extensions](https://github.com/idossha/tetravox-extensions).

An extension reaches the app one of two ways. A **bundled** one ships inside the signed application,
pre-consented — installing Tetravox was the consent — and enabled at first launch. An **installed** one
is downloaded from that source, verified against the hashes the app ships, and consented to at runtime. Either
way the two files an extension is — \`index.js\` and \`manifest.json\` — are re-hashed before the app runs a
byte of it, and the consent sheet always shows the permissions the *installed* manifest actually implies.
`;

if (index.modules.length === 0) {
  out += `\nNothing is listed yet.\n`;
} else {
  // This page stays an *overview*: it never discusses an individual extension. It only names what
  // is available and hands the reader off — to the extension's own page where one exists, otherwise
  // to its repository. Versions, files, hashes and permissions belong to **File \u25b8 Extensions\u2026**
  // in the app and to each extension's own page, so they are deliberately not repeated here.
  out += `\n## What is available\n\n`;
  for (const m of [...index.modules].sort((a, b) => a.id.localeCompare(b.id))) {
    const slug = m.id.split('.').pop();
    const page = existsSync(join(WEBSITE, 'extensions', `${slug}.md`))
      ? `/extensions/${slug}`
      : m.repo;
    out += `- **[${m.title}](${page})** \u2014 ${m.summary}\n`;
  }
  out += `\nOpen **File \u25b8 Extensions\u2026** in the app for each one's versions, files and the permissions it asks for.\n`;
}

writeFileSync(PAGE, out);
console.log(`extensions: ${index.modules.length} extension(s) → ${PAGE}`);
