/**
 * The docs guard's own tests (`node --test scripts/check-frozen-docs.test.mjs`).
 *
 * A guard nobody has seen fail is a guard nobody can trust, so every rule is driven **red** here
 * with a fixture, not only green: a frozen path with no docs, a frozen path with only half the docs,
 * a manifest naming a heading nobody wrote, and a heading the website's page map would drop.
 *
 * `node:test` rather than vitest because this is a repository script, not a package: it runs in the
 * `docs-guard` job beside the check itself, which is the only place either of them matters.
 * `docs/TESTING.md` says how to run it by hand.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARCHITECTURE,
  DECISIONS,
  FROZEN_PATHS,
  changedFiles,
  docsHeadingViolations,
  frozenViolations,
  guideHeadings,
  guidePageEntries,
  guidePages,
  main,
  manifestDocs,
  readManifests,
  sidebarSlugs,
} from './check-frozen-docs.mjs';

const FROZEN = FROZEN_PATHS[0];
/** A sidebar fixture with one `/guide/<slug>` link per slug, shaped like the real config's. */
const sidebarFor = (...slugs) =>
  `items: [\n${slugs.map((s) => `  { text: 'X', link: '/guide/${s}' },`).join('\n')}\n]`;

test('a change that touches no frozen path is fine on its own', () => {
  deepStrictEqual(frozenViolations(['packages/app/src/renderer/src/ui/Shell.tsx']), []);
  deepStrictEqual(frozenViolations([]), []);
});

test('a frozen path with both docs passes', () => {
  deepStrictEqual(frozenViolations([FROZEN, ARCHITECTURE, DECISIONS]), []);
});

test('a frozen path with no docs at all fails, naming both files', () => {
  const issues = frozenViolations([FROZEN]);
  strictEqual(issues.length, 1);
  ok(issues[0].includes(ARCHITECTURE));
  ok(issues[0].includes(DECISIONS));
  ok(issues[0].includes(FROZEN));
});

test('half the docs is still a failure, and says which half is missing', () => {
  const noDecisions = frozenViolations([FROZEN, ARCHITECTURE]);
  strictEqual(noDecisions.length, 1);
  ok(noDecisions[0].includes(DECISIONS));
  ok(!noDecisions[0].includes(`${ARCHITECTURE} and`));

  const noArchitecture = frozenViolations([FROZEN, DECISIONS]);
  strictEqual(noArchitecture.length, 1);
  ok(noArchitecture[0].includes(ARCHITECTURE));
});

test('every §12.3 TypeScript contract is watched', () => {
  for (const path of [
    'packages/protocol/src/index.ts',
    'packages/engine/src/scene/types.ts',
    'packages/engine/src/api.ts',
    'packages/wasm/src/index.ts',
    // Item 6, frozen 2026-08-30 with the module host's wiring commit (§13.1).
    'packages/app/src/renderer/src/modules/host.ts',
  ]) {
    ok(FROZEN_PATHS.includes(path), path);
    strictEqual(frozenViolations([path]).length, 1);
  }
});

test('a manifest’s `docs` heading is read out of its source', () => {
  strictEqual(manifestDocs("export const m = { docs: 'Modules', id: 'a.b' };"), 'Modules');
  strictEqual(manifestDocs('const m = { docs: "sEEG contacts" };'), 'sEEG contacts');
  strictEqual(manifestDocs('const m = { id: "a.b" };'), null);
});

test('the guide’s headings and the website’s page map are both parsed', () => {
  deepStrictEqual(guideHeadings('# T\n\n## One\ntext\n\n## Two & More\n'), ['One', 'Two & More']);
  deepStrictEqual(
    guidePages(
      "const GUIDE_PAGES = [\n { heading: 'One', slug: 'one' },\n { heading: 'Two', slug: 't' },\n];"
    ),
    ['One', 'Two']
  );
  deepStrictEqual(
    guidePageEntries(
      "const GUIDE_PAGES = [\n { heading: 'One', slug: 'one' },\n { heading: 'Two', slug: 't' },\n];"
    ),
    [
      { heading: 'One', slug: 'one' },
      { heading: 'Two', slug: 't' },
    ]
  );
});

test('the site sidebar’s guide links are parsed, and only those', () => {
  deepStrictEqual(
    sidebarSlugs(
      "items: [{ text: 'Home', link: '/' }, { text: 'M', link: '/guide/modules' }," +
        " { text: 'S', link: \"/guide/seeg-contacts\" }, { text: 'I', link: '/install' }]"
    ),
    ['modules', 'seeg-contacts']
  );
});

test('a manifest naming a heading nobody wrote fails', () => {
  const issues = docsHeadingViolations({
    manifests: [{ file: 'm/manifest.ts', docs: 'Ghosts' }],
    guide: '## Modules\n',
    sync: "{ heading: 'Modules', slug: 'modules' },",
    sidebar: sidebarFor('modules'),
  });
  strictEqual(issues.length, 2);
  ok(issues[0].includes('USER_GUIDE.md'));
  ok(issues[1].includes('GUIDE_PAGES'));
});

test('a heading the website would drop fails on its own', () => {
  // The guide has the section, but `sync.mjs` has no page for it — which breaks the *site* build,
  // late and confusingly, rather than this one.
  const issues = docsHeadingViolations({
    manifests: [{ file: 'm/manifest.ts', docs: 'Modules' }],
    guide: '## Modules\n',
    sync: "{ heading: 'Scenes', slug: 'scenes' },",
    sidebar: sidebarFor('scenes'),
  });
  strictEqual(issues.length, 1);
  ok(issues[0].includes('GUIDE_PAGES'));
});

test('a page the sidebar does not link to fails (§13.7 item 3)', () => {
  // The regression this exists for: guide section written, `GUIDE_PAGES` entry added, sidebar
  // forgotten. `sync.mjs` writes `website/src/guide/modules.md`, VitePress builds it happily, and
  // the page ships with nothing linking to it — `ignoreDeadLinks` only catches the other direction.
  const issues = docsHeadingViolations({
    manifests: [{ file: 'm/manifest.ts', docs: 'Modules' }],
    guide: '## Modules\n',
    sync: "{ heading: 'Modules', slug: 'modules' },",
    sidebar: sidebarFor('scenes'),
  });
  strictEqual(issues.length, 1);
  ok(issues[0].includes('/guide/modules'));
  ok(issues[0].includes('.vitepress/config.ts'));

  // …and the same three, consistent, is silent.
  deepStrictEqual(
    docsHeadingViolations({
      manifests: [{ file: 'm/manifest.ts', docs: 'Modules' }],
      guide: '## Modules\n',
      sync: "{ heading: 'Modules', slug: 'modules' },",
      sidebar: sidebarFor('scenes', 'modules'),
    }),
    []
  );
});

test('an omitted sidebar is a failure, not a skipped check', () => {
  // A caller that forgets the third file must not silently disable the rule — that *was* the bug.
  const issues = docsHeadingViolations({
    manifests: [{ file: 'm/manifest.ts', docs: 'Modules' }],
    guide: '## Modules\n',
    sync: "{ heading: 'Modules', slug: 'modules' },",
  });
  strictEqual(issues.length, 1);
  ok(issues[0].includes('config.ts'));
});

test('a manifest with no `docs` at all fails', () => {
  const issues = docsHeadingViolations({
    manifests: [{ file: 'm/manifest.ts', docs: null }],
    guide: '## Modules\n',
    sync: "{ heading: 'Modules', slug: 'modules' },",
    sidebar: sidebarFor('modules'),
  });
  strictEqual(issues.length, 1);
  ok(issues[0].includes('must name'));
});

test('no base to diff against is reported, not failed', () => {
  strictEqual(changedFiles(undefined), null);
  strictEqual(changedFiles(''), null);
  strictEqual(changedFiles('not-a-ref-that-exists-anywhere'), null);
});

test('this repository passes its own guard', () => {
  const said = [];
  const log = { log: (m) => said.push(m), error: (m) => said.push(m) };
  strictEqual(main(['--files', ''], log), 0, said.join('\n'));
  // …and every manifest that ships really does name a heading that exists.
  const manifests = readManifests();
  ok(manifests.length > 0);
  for (const manifest of manifests) ok(manifest.docs !== null, manifest.file);
});

test('the guard fails the run when a frozen file arrives without its docs', () => {
  const said = [];
  const log = { log: (m) => said.push(m), error: (m) => said.push(m) };
  strictEqual(main(['--files', FROZEN], log), 1);
  ok(said.some((line) => line.includes('§12.3')));
});
