#!/usr/bin/env node
/**
 * Fail the build when a documented image or video does not exist.
 *
 * VitePress does not check asset paths: a missing `<img src>` builds happily
 * and 404s in the browser. This walks the prose that ships — README.md,
 * docs/*.md, website/*.md and everything sync.mjs/gallery.mjs generated under
 * website/src/ — collects every markdown `![](…)` and every `src=` on an
 * `<img>`/`<video>`/`<source>`, and resolves each one:
 *
 *   /foo/bar.png   -> website/public/foo/bar.png   (site-absolute)
 *   foo/bar.png    -> relative to the file's own directory
 *   http(s):, data: -> skipped
 *
 * Run before `vitepress build`; prints every miss and exits 1.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBSITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(WEBSITE, '..');
const PUBLIC = join(WEBSITE, 'public');

const ASSET = /\.(png|jpe?g|gif|svg|webp|mp4|webm|avif)$/i;

function listMarkdown(dir, { recursive }) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (recursive) out.push(...listMarkdown(full, { recursive }));
    } else if (name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  join(REPO, 'README.md'),
  ...listMarkdown(join(REPO, 'docs'), { recursive: false }),
  ...listMarkdown(WEBSITE, { recursive: false }),
  ...listMarkdown(join(WEBSITE, 'src'), { recursive: true }),
].filter(existsSync);

/** Every asset reference in one file, as raw path strings. */
function references(text) {
  const found = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push(m[1]);
  for (const m of text.matchAll(/<(?:img|video|source)\b[^>]*?\bsrc="([^"]+)"/gi)) found.push(m[1]);
  for (const m of text.matchAll(/<source\b[^>]*?\bsrcset="([^"]+)"/gi)) found.push(m[1]);
  return found;
}

const missing = [];
let checked = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const raw of references(text)) {
    if (/^(https?:|data:|mailto:)/i.test(raw)) continue;
    const path = raw.split('#')[0].split('?')[0];
    if (!path || !ASSET.test(path)) continue;
    const abs = path.startsWith('/') ? join(PUBLIC, path.slice(1)) : resolve(dirname(file), path);
    checked += 1;
    if (!existsSync(abs)) missing.push({ file: relative(REPO, file), raw });
  }
}

if (missing.length > 0) {
  console.error(`check-images: ${missing.length} of ${checked} referenced assets are missing:\n`);
  for (const m of missing) console.error(`  ${m.file}: ${m.raw}`);
  console.error('');
  process.exit(1);
}

console.log(`check-images: ${checked} asset references, all resolved`);
