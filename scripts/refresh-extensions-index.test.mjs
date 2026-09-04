/**
 * The shipped-catalogue refresher's own tests (`node --test scripts/refresh-extensions-index.test.mjs`).
 *
 * `node:test` rather than vitest, for `sync-module-docs.test.mjs`'s reason: this is a repository
 * script, not a package. What matters is that the refresh is a *union in the same direction the app
 * merges* — the shipped floor never loses a version — because the failure it prevents is a release
 * that silently drops an offer every offline user still has.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, mergeModules } from './refresh-extensions-index.mjs';

const v = (version, sha) => ({ version, hostApi: 1, files: [{ sha256: sha }] });
const mod = (id, title, versions) => ({ id, title, versions });

test('adds a version the registry has and the build does not', () => {
  const merged = mergeModules(
    [mod('a.b', 'A', [v('1.0.0', 'a')])],
    [mod('a.b', 'A', [v('1.1.0', 'c')])]
  );
  deepStrictEqual(
    merged[0].versions.map((x) => x.version),
    ['1.0.0', '1.1.0']
  );
});

test('keeps a version the build ships and the registry has dropped', () => {
  const merged = mergeModules(
    [mod('a.b', 'A', [v('1.0.0', 'a')])],
    [mod('a.b', 'A', [v('2.0.0', 'c')])]
  );
  strictEqual(merged[0].versions.length, 2);
});

test('takes the registry bytes for a version both name', () => {
  const merged = mergeModules(
    [mod('a.b', 'A', [v('1.0.0', 'a')])],
    [mod('a.b', 'A', [v('1.0.0', 'b')])]
  );
  strictEqual(merged[0].versions[0].files[0].sha256, 'b');
});

test('keeps an id the registry does not list, and takes one only it lists', () => {
  const merged = mergeModules(
    [mod('a.b', 'A', [v('1.0.0', 'a')])],
    [mod('c.d', 'C', [v('1.0.0', 'c')])]
  );
  deepStrictEqual(merged.map((m) => m.id).sort(), ['a.b', 'c.d']);
});

test('orders versions ascending, 0.10.0 after 0.9.0', () => {
  strictEqual(compareVersions('0.9.0', '0.10.0') < 0, true);
  const merged = mergeModules([mod('a.b', 'A', [v('0.10.0', 'a'), v('0.9.0', 'a')])], []);
  deepStrictEqual(
    merged[0].versions.map((x) => x.version),
    ['0.9.0', '0.10.0']
  );
});
