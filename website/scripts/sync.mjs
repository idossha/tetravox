#!/usr/bin/env node
/**
 * Pull the repo's Markdown documentation into the VitePress site.
 *
 * docs/*.md (and AGENTS.md) are the single source of truth for prose - this
 * script never hand-copies their text. It only:
 *   1. strips the old Jekyll frontmatter block,
 *   2. injects VitePress frontmatter (title),
 *   3. rewrites image paths to the copies this script makes under public/,
 *   4. rewrites cross-doc links (Jekyll `{{ site.baseurl }}/X.html` and
 *      bare `docs/X.md`) to the site's own routes,
 *   5. rewrites repo-relative links (`../python`, `../examples/...`) to
 *      GitHub URLs, since the built site does not ship the whole repo tree,
 *   6. escapes bare `<...>` text (Rust/TS generics, placeholders) that is
 *      not one of the few real HTML tags these docs use, so Vue's SFC
 *      compiler does not try to parse it as markup.
 *
 * Output lands in website/src/ - generated, gitignored, rebuilt on every
 * `pnpm dev` / `pnpm build`. Nothing under website/src/ should be hand-edited.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBSITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(WEBSITE, '..');
const DOCS = join(REPO, 'docs');
const SRC_OUT = join(WEBSITE, 'src');
const PUBLIC = join(WEBSITE, 'public');

const GITHUB_BLOB = 'https://github.com/idossha/tetravox/blob/main/';
const GITHUB_TREE = 'https://github.com/idossha/tetravox/tree/main/';

// path -> is it a directory link (tree) rather than a file (blob)?
const REPO_LINKS = {
  '../python': 'tree',
  '../examples/capture': 'tree',
  '../examples/capture/README.md': 'blob',
  '../examples/capture/showcase.py': 'blob',
  '../examples/capture/screenshot.py': 'blob',
  '../examples/capture/sweep.py': 'blob',
  '../examples/capture/orbit.py': 'blob',
  '../scripts/fetch-data.sh': 'blob',
  '../data/README.md': 'blob',
};

// Tags this site actually intends as raw HTML (screenshots, side-by-side
// figures). Anything else that looks like `<...>` in these docs is prose -
// Rust/TS generics (`<T>`, `<u8>`), placeholders (`<out>-0000.png`) - never
// meant as a tag, and left alone it makes Vue's SFC compiler choke trying to
// parse it as one (duplicate/invalid attributes, unclosed elements).
const ALLOWED_TAGS = /^\/?(p|div|img|figure|figcaption|kbd|br|video|source)(\s|\/|$)/i;

/**
 * Escape a bare `<...>` span. When `allowRealTags` is true, the handful of
 * tags this site actually uses (`<img>`, `<p align>`, ...) are left alone;
 * every other doc has no real HTML in it at all, so those escape everything.
 */
function escapeStrayAngles(text, allowRealTags) {
  // Protect inline code spans first: markdown-it already escapes their
  // contents safely, and `<`/`>` inside one must not be touched here.
  const codeSpans = [];
  const mark = (i) => ' CS' + i + ' ';
  const protectedText = text.replace(/`[^`\n]*`/g, (m) => {
    codeSpans.push(m);
    return mark(codeSpans.length - 1);
  });

  const escaped = protectedText.replace(/<([^<>\n]*)>/g, (whole, inner) => {
    return allowRealTags && ALLOWED_TAGS.test(inner) ? whole : '&lt;' + inner + '&gt;';
  });

  return escaped.replace(/ CS(\d+) /g, (_, i) => codeSpans[Number(i)]);
}

/** Apply escapeStrayAngles line by line, skipping fenced code blocks whole. */
function sanitizeAngles(body, allowRealTags) {
  const lines = body.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : escapeStrayAngles(line, allowRealTags);
    })
    .join('\n');
}

function stripFrontmatter(source) {
  if (!source.startsWith('---\n')) return source;
  const end = source.indexOf('\n---', 4);
  if (end === -1) return source;
  const rest = source.slice(end + 4);
  return rest.replace(/^\n+/, '');
}

function rewriteLinks(body) {
  let out = body;
  // Screenshots referenced relative to docs/ -> the copies this script makes.
  out = out.replaceAll('screenshots/2026-08-29/', '/shots/');
  // Jekyll cross-doc links. Must run before the generic `{{ }}` escape below,
  // since it matches these exact `{{ site.baseurl }}` strings.
  out = out.replaceAll('{{ site.baseurl }}/AUTOMATION.html', '/automation');
  out = out.replaceAll('{{ site.baseurl }}/ARCHITECTURE.html', '/developers/architecture');
  out = out.replaceAll('{{ site.baseurl }}/TESTING.html', '/developers/testing');
  out = out.replaceAll('docs/AUTOMATION.md', '/automation');
  out = out.replaceAll('docs/TESTING.md', '/developers/testing');
  // USER_GUIDE.md cross-links to its own other sections, once split into
  // one page per topic under /guide/ (see splitGuide() below).
  out = out.replace(/\{\{ site\.baseurl \}\}\/guide\/([a-z0-9-]+)\.html/g, '/guide/$1');
  // Repo-relative links the site does not ship as pages.
  for (const [repoPath, kind] of Object.entries(REPO_LINKS)) {
    const url = (kind === 'tree' ? GITHUB_TREE : GITHUB_BLOB) + repoPath.replace(/^\.\.\//, '');
    out = out.split('](' + repoPath + ')').join('](' + url + ')');
  }
  // Leftover Jekyll `{% raw %}...{% endraw %}` guards around literal GitHub
  // Actions `${{ ... }}` expressions (e.g. a workflow matrix). VitePress
  // compiles every page as a Vue template, where bare `{{ }}` is mustache
  // interpolation - Vue tries to evaluate the GitHub Actions expression as
  // JS and chokes. Drop the now-meaningless Jekyll tags and entity-escape
  // the braces so they render as literal text instead of being evaluated.
  out = out.replaceAll('{% raw %}', '').replaceAll('{% endraw %}', '');
  // Function replacers, not literal replacement strings: a literal '$&' in a
  // string replacement is itself a special "insert the match" token in
  // JS's replace/replaceAll, which would silently reintroduce the `{{`.
  out = out.replaceAll('${{', () => '$&#123;&#123;').replaceAll('}}', () => '&#125;&#125;');
  return out;
}

function writeDoc({ srcPath, outPath, title, allowRealTags = false }) {
  const raw = readFileSync(srcPath, 'utf8');
  const body = sanitizeAngles(rewriteLinks(stripFrontmatter(raw)), allowRealTags);
  const frontmatter = '---\ntitle: ' + title + '\n---\n\n';
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, frontmatter + body);
}

// ---------------------------------------------------------------- clean slate
rmSync(SRC_OUT, { recursive: true, force: true });
mkdirSync(SRC_OUT, { recursive: true });

// -------------------------------------------------------------------- assets
// The whole capture set, subdirectories and all (hero/, brain/, modalities/, features/,
// motion/, ui/), so a doc's `screenshots/2026-08-29/hero/x.png` becomes
// `/shots/hero/x.png` on the site - see rewriteLinks() above.
const SHOTS_SRC = join(DOCS, 'screenshots', '2026-08-29');
rmSync(join(PUBLIC, 'shots'), { recursive: true, force: true });
mkdirSync(join(PUBLIC, 'shots'), { recursive: true });
if (existsSync(SHOTS_SRC)) {
  // Markdown is filtered out: VitePress' srcDir is the website root, so a
  // .md file landing under public/ is picked up as a page and its
  // repo-relative links fail the dead-link check.
  cpSync(SHOTS_SRC, join(PUBLIC, 'shots'), {
    recursive: true,
    filter: (src) => !src.endsWith('.md'),
  });
} else {
  console.warn('sync.mjs: ' + SHOTS_SRC + ' does not exist yet - no screenshots copied');
}

mkdirSync(join(PUBLIC, 'media'), { recursive: true });
for (const asset of [
  'showcase.mp4',
  'showcase-preview.gif',
  // The two figures that moved out of `website/public/` on 2026-08-31: a page referencing one of
  // them is a red `check-images` (and a broken image on the site) until it is copied here.
  'sample-data-dialog.png',
  'seeg-extension-p077.png',
]) {
  const from = join(DOCS, 'media', asset);
  if (existsSync(from)) cpSync(from, join(PUBLIC, 'media', asset));
}

// ---------------------------------------------------------------------- docs
const DOC_PAGES = [
  // USER_GUIDE.md and AUTOMATION.md use a handful of real HTML tags for
  // screenshot figures - keep them. Every other doc has no real HTML in it
  // at all (verified: only Rust/TS generics and placeholder text look like
  // tags), so those get every `<...>` escaped, not just the disallowed ones.
  { src: 'AUTOMATION.md', out: 'automation.md', title: 'Automation & Python', allowRealTags: true },
  { src: 'ARCHITECTURE.md', out: 'developers/architecture.md', title: 'Architecture' },
  { src: 'DECISIONS.md', out: 'developers/decisions.md', title: 'Decisions' },
  { src: 'TESTING.md', out: 'developers/testing.md', title: 'Testing' },
  { src: 'BENCHMARKS.md', out: 'developers/benchmarks.md', title: 'Benchmarks' },
  { src: 'ROADMAP.md', out: 'developers/roadmap.md', title: 'Roadmap' },
  { src: 'RELEASING.md', out: 'developers/releasing.md', title: 'Releasing' },
];

for (const page of DOC_PAGES) {
  writeDoc({
    srcPath: join(DOCS, page.src),
    outPath: join(SRC_OUT, page.out),
    title: page.title,
    allowRealTags: page.allowRealTags,
  });
}

// ------------------------------------------------------------- guide (split)
// docs/USER_GUIDE.md is the single source of truth for guide content, but the
// site gives each ## section its own sidebar page (16 short, scannable pages
// beat one long one). Split on top-level `## ` headings; the intro prose
// before the first heading becomes the "Opening data & formats" page's lead
// paragraph is NOT dropped here - it stays with the doc's own H1, which this
// script does not carry into any split page (each split page gets its own
// title from GUIDE_PAGES instead, matching the site's existing convention).
const GUIDE_PAGES = [
  { heading: 'Opening data & formats', slug: 'opening-data' },
  { heading: 'The panes', slug: 'panes' },
  { heading: 'Volume layers', slug: 'volume-layers' },
  { heading: 'Atlases & regions', slug: 'atlases-regions' },
  { heading: 'Meshes', slug: 'meshes' },
  { heading: 'Surfaces & annotations', slug: 'surfaces-annotations' },
  { heading: 'Isosurfaces', slug: 'isosurfaces' },
  { heading: 'Vector fields', slug: 'vector-fields' },
  { heading: 'Points & electrodes', slug: 'points-electrodes' },
  { heading: 'Measurements', slug: 'measurements' },
  { heading: 'Extensions', slug: 'extensions' },
  { heading: 'sEEG contacts', slug: 'seeg-contacts' },
  { heading: 'Coordinates', slug: 'coordinates' },
  { heading: 'Themes & settings', slug: 'themes-settings' },
  { heading: 'Scenes', slug: 'scenes' },
  { heading: 'Screenshots & video', slug: 'screenshots-video' },
  { heading: 'Keyboard shortcuts', slug: 'keyboard-shortcuts' },
  { heading: 'Troubleshooting', slug: 'troubleshooting' },
];

function splitGuide() {
  const raw = readFileSync(join(DOCS, 'USER_GUIDE.md'), 'utf8');
  const body = stripFrontmatter(raw);
  // The doc opens with an `# H1` and an intro (kept only on the first split
  // page, "Opening data & formats", so a reader who lands there still gets
  // the one-paragraph "what is this" instead of jumping straight into
  // format details).
  const firstHeadingIdx = body.indexOf('\n## Opening data & formats');
  const intro = body
    .slice(0, firstHeadingIdx)
    .replace(/^# .*\n/, '')
    .trim();

  const sections = body.split(/\n(?=## )/g).filter((s) => s.startsWith('## '));
  const bySlug = new Map();
  for (const section of sections) {
    const heading = section.slice(3, section.indexOf('\n')).trim();
    const page = GUIDE_PAGES.find((p) => p.heading === heading);
    if (!page) {
      throw new Error(
        `sync.mjs: USER_GUIDE.md has an unmapped section "${heading}" - add it to GUIDE_PAGES`
      );
    }
    // Drop the `## Heading` line itself - the page's own title (frontmatter)
    // already says it, and VitePress' outline shows H2s within the page.
    const content = section.slice(section.indexOf('\n') + 1).trim();
    bySlug.set(page.slug, content);
  }
  for (const page of GUIDE_PAGES) {
    if (!bySlug.has(page.slug)) {
      throw new Error(`sync.mjs: USER_GUIDE.md is missing its "${page.heading}" section`);
    }
  }

  for (const page of GUIDE_PAGES) {
    const raw =
      page.slug === 'opening-data' ? intro + '\n\n' + bySlug.get(page.slug) : bySlug.get(page.slug);
    const body = sanitizeAngles(rewriteLinks(raw), true);
    const frontmatter = '---\ntitle: ' + page.heading + '\n---\n\n';
    const outPath = join(SRC_OUT, 'guide', page.slug + '.md');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, frontmatter + '# ' + page.heading + '\n\n' + body);
  }
}

splitGuide();

// AGENTS.md lives at the repo root, not under docs/, but is the source of
// truth for the Developers "Contributing" page (commands, test data, rules).
writeDoc({
  srcPath: join(REPO, 'AGENTS.md'),
  outPath: join(SRC_OUT, 'developers', 'contributing.md'),
  title: 'Contributing',
});

console.log(
  'sync.mjs: wrote ' + (DOC_PAGES.length + 1) + ' pages to website/src/, copied shots + media'
);
