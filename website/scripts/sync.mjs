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
const ALLOWED_TAGS = /^\/?(p|img|figure|figcaption|kbd|br|video|source)(\s|\/|$)/i;

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
  out = out.replaceAll('screenshots/directed-2026-08-28/', '/shots/');
  // Jekyll cross-doc links. Must run before the generic `{{ }}` escape below,
  // since it matches these exact `{{ site.baseurl }}` strings.
  out = out.replaceAll('{{ site.baseurl }}/AUTOMATION.html', '/automation');
  out = out.replaceAll('{{ site.baseurl }}/ARCHITECTURE.html', '/developers/architecture');
  out = out.replaceAll('{{ site.baseurl }}/TESTING.html', '/developers/testing');
  out = out.replaceAll('docs/AUTOMATION.md', '/automation');
  out = out.replaceAll('docs/TESTING.md', '/developers/testing');
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
mkdirSync(join(PUBLIC, 'shots'), { recursive: true });
cpSync(join(DOCS, 'screenshots', 'directed-2026-08-28'), join(PUBLIC, 'shots'), {
  recursive: true,
});

mkdirSync(join(PUBLIC, 'media'), { recursive: true });
for (const asset of ['showcase.mp4', 'showcase-preview.gif', 'walkthrough.gif']) {
  const from = join(DOCS, 'media', asset);
  if (existsSync(from)) cpSync(from, join(PUBLIC, 'media', asset));
}

// ---------------------------------------------------------------------- docs
const DOC_PAGES = [
  // USER_GUIDE.md and AUTOMATION.md use a handful of real HTML tags for
  // screenshot figures - keep them. Every other doc has no real HTML in it
  // at all (verified: only Rust/TS generics and placeholder text look like
  // tags), so those get every `<...>` escaped, not just the disallowed ones.
  { src: 'USER_GUIDE.md', out: 'viewing-data.md', title: 'Viewing data', allowRealTags: true },
  { src: 'AUTOMATION.md', out: 'automation.md', title: 'Automation & Python', allowRealTags: true },
  { src: 'ARCHITECTURE.md', out: 'developers/architecture.md', title: 'Architecture' },
  { src: 'DECISIONS.md', out: 'developers/decisions.md', title: 'Decisions' },
  { src: 'TESTING.md', out: 'developers/testing.md', title: 'Testing' },
  { src: 'BENCHMARKS.md', out: 'developers/benchmarks.md', title: 'Benchmarks' },
  { src: 'ROADMAP.md', out: 'developers/roadmap.md', title: 'Roadmap' },
];

for (const page of DOC_PAGES) {
  writeDoc({
    srcPath: join(DOCS, page.src),
    outPath: join(SRC_OUT, page.out),
    title: page.title,
  });
}

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
