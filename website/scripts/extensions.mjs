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

function mb(n) {
  return n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} kB`
    : `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Newest release first — the index stores `versions` oldest-first, so a page reads it reversed. */
function newestFirst(versions) {
  return [...versions].reverse();
}

let out = `---
title: Extensions
---

# Extensions

<figure class="shot">
<img src="/seeg-extension-p077.png" alt="The sEEG contact editor in Tetravox">
<figcaption>The <strong>sEEG contacts</strong> extension editing subject P077 — coloured electrode shafts across the 2×2 panes, labelled contacts on the head mesh in 3D, and the full <strong>SEEG CONTACTS</strong> panel on the right.</figcaption>
</figure>

Optional tools that add a whole workflow to Tetravox — their own panel, keys, files and undo — installed
and managed in **File ▸ Extensions…** in the app. This is the list the dialog shows, and it is the copy
the app ships, so it is correct with no network; the curated source lives at
[idossha/tetravox-extensions](https://github.com/idossha/tetravox-extensions).

An extension reaches the app one of two ways. A **bundled** one ships inside the signed application,
pre-consented — installing Tetravox was the consent — and enabled at first launch. An **installed** one
is downloaded from the source below, verified against the hashes here, and consented to at runtime. Either
way the two files an extension is — \`index.js\` and \`manifest.json\` — are re-hashed before the app runs a
byte of it, and the consent sheet always shows the permissions the *installed* manifest actually implies.
`;

if (index.modules.length === 0) {
  out += `\nNothing is listed yet.\n`;
}

for (const m of [...index.modules].sort((a, b) => a.id.localeCompare(b.id))) {
  out += `\n## ${m.title}\n\n`;
  out += `\`${m.id}\`${m.author === undefined ? '' : ` · by ${m.author}`} · ${m.licence}\n\n`;
  out += `${m.summary}\n\n`;
  if (m.description !== undefined && m.description !== '') out += `${m.description}\n\n`;
  // A flagship extension has its own hand-written page at website/extensions/<slug>.md
  // (slug is the id after the dot: tetravox.seeg → seeg). Point at it when it exists,
  // otherwise send readers straight to the source repository. This stays generated so
  // it can never list a page that is not there, or miss one that was added.
  const slug = m.id.split('.').pop();
  if (existsSync(join(WEBSITE, 'extensions', `${slug}.md`))) {
    out += `**[Open the ${m.title} page](/extensions/${slug})**\n\n`;
  } else {
    out += `**[${m.title} on GitHub](${m.repo})**\n\n`;
  }
  const links = [`[Source](${m.repo})`];
  if (m.docs !== undefined && m.docs !== '') links.push(`[Documentation](${m.docs})`);
  out += `${links.join(' · ')}\n\n`;

  for (const v of newestFirst(m.versions)) {
    const when = v.published === undefined ? '' : ` — ${v.published}`;
    out += `### ${v.version} · host API ${v.hostApi}${when}\n\n`;
    const files = v.files
      .map((f) => `<a href="${f.url}"><code>${f.name}</code></a> (${mb(f.bytes)})`)
      .join(', ');
    out += `Files: ${files}\n\n`;
    if (Array.isArray(v.permissions) && v.permissions.length > 0) {
      out += `What it can do:\n\n`;
      for (const p of v.permissions) out += `- ${p}\n`;
      out += `\n`;
    }
  }
}

writeFileSync(PAGE, out);
console.log(`extensions: ${index.modules.length} extension(s) → ${PAGE}`);
