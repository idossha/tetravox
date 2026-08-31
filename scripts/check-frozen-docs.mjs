/**
 * The docs guard (ARCHITECTURE.md §12.1, §12.3, §13.7).
 *
 * Two rules the repository has always had and has never been able to enforce:
 *
 *  1. **A §12.3 frozen interface may not change without its documentation.** `ARCHITECTURE.md` is
 *     the contract and `DECISIONS.md` is the record of why; "edit the doc in the same commit" has
 *     until now been a review catch, which means it was a catch that scaled with reviewer attention.
 *     This makes it a red CI job instead.
 *  2. **A module's `docs` heading has to exist — in all three places.** §13.1 says a manifest names
 *     a `## ` heading in `docs/USER_GUIDE.md`; the website's `sync.mjs` splits that guide into one
 *     page per heading and *throws* on an unmapped section, so a heading added to the guide and not
 *     to `GUIDE_PAGES` breaks the site build rather than this one. The third is the VitePress
 *     **sidebar** (`website/.vitepress/config.ts`), a hand-written list `sync.mjs` neither generates
 *     nor validates: a generated page with no entry in it builds perfectly and is linked from
 *     nothing, and `ignoreDeadLinks: false` only catches the opposite mistake — a sidebar entry with
 *     no page. §13.7 item 3 has always said this job fails without all three; since 2026-08-30 it
 *     does. Checking them here turns three late, confusing failures into one early, specific one.
 *
 * Rule 1 needs a **merge-base diff**, so the job that runs this checks out with `fetch-depth: 0`.
 * With no base to compare against (a `workflow_dispatch`, a local run) it reports that and checks
 * rule 2 only — a guard that failed when it could not do its job would be turned off within a week.
 *
 * Usage:
 *   node scripts/check-frozen-docs.mjs                     # rule 2 only
 *   node scripts/check-frozen-docs.mjs --base origin/main  # both
 *   node scripts/check-frozen-docs.mjs --files a.ts,b.ts   # both, with the diff supplied (self-test)
 *
 * Every rule is a pure exported function so `check-frozen-docs.test.mjs` can drive it with fixture
 * strings rather than by making commits.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * §12.3's frozen list, as paths.
 *
 * Item 5 of §12.3 — "every Rust signature in §6.0–§6.4" — is deliberately **not** here: it is a rule
 * about signatures spread across many files, and a file-level rule over `crates/**` would fire on
 * every implementation change and teach everyone to ignore this job. The TypeScript contracts are
 * exactly the ones where "the file changed" and "the interface changed" are the same event.
 */
export const FROZEN_PATHS = [
  'packages/protocol/src/index.ts',
  'packages/engine/src/scene/types.ts',
  'packages/engine/src/api.ts',
  'packages/wasm/src/index.ts',
  // Item 6, frozen 2026-08-30 when the module host's `tool`, `files` and `scene.peakCentroid` stopped
  // being stubs (§13.1). Same class as the four above: the file *is* the interface.
  'packages/app/src/renderer/src/modules/host.ts',
];

export const ARCHITECTURE = 'docs/ARCHITECTURE.md';
export const DECISIONS = 'docs/DECISIONS.md';
export const USER_GUIDE = 'docs/USER_GUIDE.md';
export const SYNC_MJS = 'website/scripts/sync.mjs';
/** The site's hand-maintained sidebar. Nothing generates it, so nothing else can check it. */
export const SIDEBAR = 'website/.vitepress/config.ts';

/**
 * The frozen files this change touched without also editing both docs.
 *
 * Both, not either: `ARCHITECTURE.md` says what the interface now is and `DECISIONS.md` says why it
 * changed, and a repository that has one without the other loses the half it did not write.
 */
export function frozenViolations(changed) {
  const touched = FROZEN_PATHS.filter((path) => changed.includes(path));
  if (touched.length === 0) return [];
  const missing = [ARCHITECTURE, DECISIONS].filter((doc) => !changed.includes(doc));
  if (missing.length === 0) return [];
  return [
    `§12.3 frozen interface changed without ${missing.join(' and ')}: ${touched.join(', ')}. ` +
      `An additive change is still an edit — state the new shape in ARCHITECTURE.md and why in DECISIONS.md, in this commit.`,
  ];
}

/** The `docs:` heading a manifest names, or null when it declares none. */
export function manifestDocs(source) {
  const match = /\bdocs\s*:\s*'([^']*)'|\bdocs\s*:\s*"([^"]*)"/.exec(source);
  if (match === null) return null;
  return match[1] ?? match[2] ?? null;
}

/** Every `## ` heading in the user guide, in file order. */
export function guideHeadings(text) {
  return [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
}

/** Every heading `website/scripts/sync.mjs` maps to a page. */
export function guidePages(text) {
  return [...text.matchAll(/\{\s*heading:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** The same map as {@link guidePages}, carrying the slug each heading becomes a page at. */
export function guidePageEntries(text) {
  return [...text.matchAll(/\{\s*heading:\s*'([^']+)'\s*,\s*slug:\s*'([^']+)'\s*\}/g)].map((m) => ({
    heading: m[1],
    slug: m[2],
  }));
}

/**
 * Every `/guide/<slug>` the VitePress sidebar links to.
 *
 * A regex over the config rather than an import: the file is TypeScript, this script is plain ESM
 * run by `node --test` with no build step, and the sidebar is a literal array of `link:` strings —
 * the one shape a grep reads exactly as well as a parser would.
 */
export function sidebarSlugs(text) {
  return [...text.matchAll(/link:\s*['"]\/guide\/([A-Za-z0-9._-]+)['"]/g)].map((m) => m[1]);
}

/**
 * Rule 2, over one manifest.
 *
 * The website's splitter throws on a guide section it has no page for, so the two lists have to
 * agree in both directions; this checks the direction a *module* can break, which is a manifest
 * naming a heading that nobody wrote.
 *
 * The sidebar is checked last and only when the heading has a slug to look for, so a PR that forgot
 * `GUIDE_PAGES` is told that once rather than twice. `sidebar` defaults to `''` — an empty sidebar
 * has no entry for anything, so a caller that forgets to pass it gets a failure and not a silent
 * skip, which is the failure mode this check exists to end.
 */
export function docsHeadingViolations({ manifests, guide, sync, sidebar = '' }) {
  const headings = guideHeadings(guide);
  const pages = guidePages(sync);
  const entries = guidePageEntries(sync);
  const slugs = sidebarSlugs(sidebar);
  const issues = [];
  for (const { file, docs } of manifests) {
    if (docs === null || docs === '') {
      issues.push(`${file}: a manifest must name a \`docs\` heading (§13.1).`);
      continue;
    }
    if (!headings.includes(docs)) {
      issues.push(`${file}: \`docs: '${docs}'\` has no \`## ${docs}\` section in ${USER_GUIDE}.`);
    }
    if (!pages.includes(docs)) {
      issues.push(
        `${file}: \`docs: '${docs}'\` is not in ${SYNC_MJS}'s GUIDE_PAGES, so the website build would drop it.`
      );
      continue;
    }
    const slug = entries.find((entry) => entry.heading === docs)?.slug;
    if (slug !== undefined && !slugs.includes(slug)) {
      issues.push(
        `${file}: \`docs: '${docs}'\` has no \`/guide/${slug}\` entry in ${SIDEBAR}, so the page would ship with nothing linking to it (§13.7 item 3).`
      );
    }
  }
  return issues;
}

/** Every `packages/app/src/modules/<id>/manifest.ts`, with the heading each one names. */
export function readManifests(root = REPO_ROOT) {
  const dir = join(root, 'packages', 'app', 'src', 'modules');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, 'manifest.ts');
    if (!existsSync(file)) continue;
    out.push({
      file: `packages/app/src/modules/${entry.name}/manifest.ts`,
      docs: manifestDocs(readFileSync(file, 'utf8')),
    });
  }
  return out;
}

function git(args, root) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** The files this branch changed against `base`, or null when there is no base to compare with. */
export function changedFiles(base, root = REPO_ROOT) {
  if (base === undefined || base === null || base === '') return null;
  try {
    const mergeBase = git(['merge-base', base, 'HEAD'], root);
    const out = git(['diff', '--name-only', `${mergeBase}`, 'HEAD'], root);
    return out === '' ? [] : out.split('\n');
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { base: undefined, files: undefined, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--files') args.files = argv[++i].split(',').filter((s) => s !== '');
    else if (argv[i] === '--root') args.root = resolve(argv[++i]);
  }
  return args;
}

export function main(argv = process.argv.slice(2), log = console) {
  const { base, files, root } = parseArgs(argv);
  const changed = files ?? changedFiles(base, root);
  const issues = [];

  if (changed === null) {
    log.log(
      `check-frozen-docs: no base to diff against (--base was ${base === undefined ? 'not given' : `"${base}"`}); ` +
        'the §12.3 rule is skipped and the module docs rule still runs.'
    );
  } else {
    issues.push(...frozenViolations(changed));
  }

  issues.push(
    ...docsHeadingViolations({
      manifests: readManifests(root),
      guide: readFileSync(join(root, USER_GUIDE), 'utf8'),
      sync: readFileSync(join(root, SYNC_MJS), 'utf8'),
      sidebar: readFileSync(join(root, SIDEBAR), 'utf8'),
    })
  );

  if (issues.length > 0) {
    for (const issue of issues) log.error(`check-frozen-docs: ${issue}`);
    return 1;
  }
  log.log('check-frozen-docs: ok');
  return 0;
}

// `node scripts/check-frozen-docs.mjs` runs it; an `import` of this file does not.
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-frozen-docs.mjs')) {
  process.exitCode = main();
}
