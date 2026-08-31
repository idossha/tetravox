/**
 * `check-module-loader.mjs`'s own fixtures, driven red (`check-frozen-docs.test.mjs`'s idiom).
 *
 * A guard nobody has seen fail is a guard nobody trusts, and this one guards against a **silent**
 * failure: Vite rewriting a variable dynamic import into a glob helper whose glob is empty. So each
 * of the three ways the loader can stop working is spelled out here as a chunk that the checker must
 * reject, plus the shape it must accept — which is the real emitted form, `@vite-ignore` comment and
 * all, rather than a tidied-up version of it.
 *
 *   node --test scripts/check-module-loader.test.mjs
 */

import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  ASSETS_DIR,
  GLOB_HELPER,
  MODULE_URL_MARK,
  REPO_ROOT,
  loaderViolations,
  readChunks,
} from './check-module-loader.mjs';

/** What rollup really emitted for `installed.ts#load()` on 2026-08-30 (measured, not invented). */
const GOOD = `function moduleUrl(id, version, file) {
  return \`${MODULE_URL_MARK}\${id}/\${version}/\${file}\`;
}
async function load() {
  const url = moduleUrl(id, version, "index.js");
  loaded = await import(
    /* @vite-ignore */
    url
  );
}`;

const MINIFIED = `const u=\`${MODULE_URL_MARK}\${i}/\${v}/\${f}\`;await import(u)`;

test('the emitted loader passes', () => {
  deepStrictEqual(loaderViolations([{ name: 'index-abc.js', text: GOOD }]), []);
});

test('a minified variable import passes too', () => {
  deepStrictEqual(loaderViolations([{ name: 'index-abc.js', text: MINIFIED }]), []);
});

test('an empty build output is a failure, never a pass', () => {
  const issues = loaderViolations([]);
  strictEqual(issues.length, 1);
  match(issues[0], /no renderer chunks/);
});

test('the glob helper is a failure, naming @vite-ignore', () => {
  // The silent one: the identifier form WITHOUT the comment. The URL is still in the chunk, so
  // only the helper's presence gives it away.
  const text = `${GOOD}\nfunction ${GLOB_HELPER}(g,p){return g[p]()}`;
  const issues = loaderViolations([{ name: 'index-abc.js', text }]);
  ok(issues.some((i) => i.includes(GLOB_HELPER)));
  ok(issues.some((i) => i.includes('@vite-ignore')));
});

test('losing the URL literal is a failure', () => {
  const issues = loaderViolations([{ name: 'index-abc.js', text: 'const x = 1;' }]);
  strictEqual(issues.length, 1);
  match(issues[0], /did not survive/);
});

test('a URL with no variable import is a failure', () => {
  // What a build-time-resolved specifier looks like: the string is there, as data, and the import
  // beside it names a chunk. That passes rule 1 and rule 2 and is still broken.
  const text = `const u = "${MODULE_URL_MARK}x/1.0.0/index.js";\nawait import("./index-D_9pEJaW.js");`;
  const issues = loaderViolations([{ name: 'index-abc.js', text }]);
  strictEqual(issues.length, 1);
  match(issues[0], /no dynamic import of a variable/);
});

test('the URL and the import may live in different chunks only if one chunk has both', () => {
  // Rule 3 is deliberately per-chunk: a URL in one chunk and a variable import in another is two
  // unrelated facts, and the loader is one function.
  const issues = loaderViolations([
    { name: 'a.js', text: `const u = "${MODULE_URL_MARK}x/1.0.0/index.js";` },
    { name: 'b.js', text: 'await import(somethingElse);' },
  ]);
  strictEqual(issues.length, 1);
  match(issues[0], /no dynamic import of a variable/);
});

test('the real build output, when there is one', (t) => {
  const dir = join(REPO_ROOT, ASSETS_DIR);
  if (!existsSync(dir)) {
    t.skip('no renderer build output — run `pnpm --filter @tetravox/app run build`');
    return;
  }
  deepStrictEqual(loaderViolations(readChunks(dir)), []);
});

test('the source really hoists the URL and carries the comment', () => {
  // The other side of the same claim, so a source that could never produce a passing build fails
  // here rather than only after `electron-vite build`.
  const source = readFileSync(
    join(REPO_ROOT, 'packages/app/src/renderer/src/modules/installed.ts'),
    'utf8'
  );
  match(source, /const url = moduleUrl\(/);
  match(source, /await import\(\/\* @vite-ignore \*\/ url\)/);
});
