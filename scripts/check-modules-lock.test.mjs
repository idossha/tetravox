/**
 * `modules.lock`'s validator, driven red (`node --test scripts/check-modules-lock.test.mjs`).
 *
 * Every rule has a fixture that breaks it, because this validator is what stands between a
 * mistyped hash and a release that ships an unverified module — and a rule nobody has watched fail
 * is a rule nobody can trust. The shipped `modules.lock` is checked here too, so the file in the
 * tree is always one of the fixtures.
 *
 * `node:test` for `check-frozen-docs.test.mjs`'s reason: a repository script, run in the cheap
 * `docs-guard` job beside the check itself.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  LOCK,
  REPO_ROOT,
  REQUIRED_FILES,
  readHostVersion,
  validateLock,
} from './check-modules-lock.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** A lock that passes, as the object every fixture below mutates one field of. */
const good = () => ({
  schema: 1,
  modules: [
    {
      id: 'tetravox.seeg',
      version: '1.0.0',
      hostApi: 1,
      repo: 'idossha/tetravox-seeg',
      tag: 'v1.0.0',
      bundled: true,
      files: [
        { name: 'index.js', bytes: 81234, sha256: HASH_A },
        { name: 'manifest.json', bytes: 3412, sha256: HASH_B },
      ],
    },
  ],
});

/** The errors a mutated fixture produces. */
const errorsOf = (mutate) => {
  const lock = good();
  mutate(lock);
  return validateLock(lock, { hostApi: 1 }).errors;
};

const complains = (mutate, needle) => {
  const errors = errorsOf(mutate);
  ok(
    errors.some((e) => e.includes(needle)),
    `expected an error mentioning "${needle}", got:\n${errors.join('\n') || '(none)'}`
  );
};

test('the fixture passes, so every failure below is about the one field it changed', () => {
  deepStrictEqual(validateLock(good(), { hostApi: 1 }), { ok: true, errors: [] });
});

test('an empty lock is valid — bundling nothing is a legal release', () => {
  deepStrictEqual(validateLock({ schema: 1, modules: [] }, { hostApi: 1 }), {
    ok: true,
    errors: [],
  });
});

test('the lock in the tree is valid against the host version the tree implements', async () => {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, LOCK), 'utf8'));
  const { ok: valid, errors } = validateLock(lock, { hostApi: await readHostVersion() });
  ok(valid, errors.join('\n'));
});

test('the top level is checked, not assumed', () => {
  ok(!validateLock(null, { hostApi: 1 }).ok);
  ok(!validateLock([], { hostApi: 1 }).ok);
  complains((l) => (l.schema = 2), '"schema" must be 1');
  complains((l) => (l.extra = true), 'unknown top-level key "extra"');
  ok(!validateLock({ schema: 1 }, { hostApi: 1 }).ok);
});

test('an id must be <vendor>.<name>, lower case', () => {
  complains((l) => (l.modules[0].id = 'seeg'), 'must be <vendor>.<name>');
  complains((l) => (l.modules[0].id = 'Tetravox.Seeg'), 'must be <vendor>.<name>');
  complains((l) => (l.modules[0].id = 'a.b.c'), 'must be <vendor>.<name>');
});

test('two entries for one module are refused, and the second names the first', () => {
  complains(
    (l) => l.modules.push({ ...l.modules[0], version: '1.1.0', tag: 'v1.1.0' }),
    'already locked'
  );
});

test('entries are sorted by id, so a bump is a one-entry diff', () => {
  complains((l) => l.modules.push({ ...l.modules[0], id: 'lab.contacts' }), 'must be sorted by id');
});

test('a version must be semver and the tag must contain it', () => {
  complains((l) => (l.modules[0].version = '1.0'), 'must be semver');
  complains((l) => (l.modules[0].tag = 'v1.1.0'), 'does not contain version');
  complains((l) => (l.modules[0].tag = 'release/1.0.0'), 'must be a git tag');
});

test('hostApi is checked against what this build implements, not merely for being a number', () => {
  complains((l) => (l.modules[0].hostApi = '1'), 'must be an integer');
  const errors = validateLock(good(), { hostApi: 2 }).errors;
  ok(
    errors.some((e) => e.includes('MODULE_HOST_VERSION 2')),
    errors.join('\n')
  );
});

test('a repo is <owner>/<name>, never a URL', () => {
  complains(
    (l) => (l.modules[0].repo = 'https://github.com/idossha/tetravox-seeg'),
    '"<owner>/<name>"'
  );
  complains((l) => (l.modules[0].repo = 'idossha'), '"<owner>/<name>"');
});

test('bundled is a boolean, stated rather than implied', () => {
  complains((l) => (l.modules[0].bundled = 'yes'), 'must be true or false');
  complains((l) => delete l.modules[0].bundled, 'missing "bundled"');
});

test('a file name is one segment — no separators and no ascent', () => {
  complains((l) => (l.modules[0].files[0].name = '../index.js'), 'one path segment');
  complains((l) => (l.modules[0].files[0].name = 'sub/index.js'), 'one path segment');
  complains((l) => (l.modules[0].files[0].name = '.hidden'), 'one path segment');
});

test('a hash is 64 lower-case hex characters', () => {
  complains((l) => (l.modules[0].files[0].sha256 = HASH_A.toUpperCase()), '64 lower-case hex');
  complains((l) => (l.modules[0].files[0].sha256 = 'abc'), '64 lower-case hex');
  complains((l) => delete l.modules[0].files[0].sha256, 'missing "sha256"');
});

test('a size is a positive integer, so a truncated download is a size mismatch as well as a hash one', () => {
  complains((l) => (l.modules[0].files[0].bytes = 0), 'positive integer');
  complains((l) => (l.modules[0].files[0].bytes = -1), 'positive integer');
  complains((l) => (l.modules[0].files[0].bytes = 1.5), 'positive integer');
});

test('every module release carries index.js and manifest.json', () => {
  for (const required of REQUIRED_FILES) {
    complains(
      (l) => (l.modules[0].files = l.modules[0].files.filter((f) => f.name !== required)),
      `no "${required}"`
    );
  }
  complains((l) => (l.modules[0].files = []), 'non-empty array');
});

test('a duplicated file name inside one module is refused', () => {
  complains((l) => l.modules[0].files.push({ ...l.modules[0].files[0] }), 'appears twice');
});

test('an unknown key is a typo, and is reported as one', () => {
  complains((l) => (l.modules[0].url = 'https://example.invalid/x.js'), 'unknown key "url"');
  complains((l) => (l.modules[0].files[0].size = 1), 'unknown key "size"');
});

test('every problem is reported at once, not just the first', () => {
  const errors = errorsOf((l) => {
    l.modules[0].id = 'nope';
    l.modules[0].version = 'x';
    l.modules[0].files[0].sha256 = 'short';
  });
  strictEqual(errors.length >= 3, true, errors.join('\n'));
});
