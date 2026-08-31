/**
 * The module-docs generator's own tests (`node --test scripts/sync-module-docs.test.mjs`).
 *
 * `node:test` rather than vitest for `check-frozen-docs.test.mjs`'s reason: this is a repository
 * script, not a package, and it runs in the `docs-guard` job beside the check itself.
 *
 * Two of the cases below are regressions from writing it. The splice is done on **lines**, because
 * a string splice ate the blank line above the heading and then glued the heading to the paragraph
 * above it on the second run; and the section's boundary is a heading at its own level or above,
 * because a scan that stopped at the first `####` would re-insert the section in front of the
 * tables it had just written. Both failed in exactly the shape a generator fails: the first run
 * looked right.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEADING,
  describeArg,
  isManifest,
  main,
  manifestFiles,
  needsStripTypes,
  readManifests,
  renderModule,
  renderSection,
  replaceSection,
} from './sync-module-docs.mjs';

const EVERY = {
  id: 'test.every',
  title: 'Every type',
  version: '2.5.0',
  hostApi: 1,
  docs: 'Modules',
  activation: ['onToggle'],
  commands: [],
  operations: [
    {
      id: 'every',
      args: {
        n: 'number',
        s2: 'string?',
        b: 'boolean',
        v: 'vec3?',
        p: 'path',
        p2: 'path?',
        o: 'out',
      },
    },
    { id: 'none', args: {} },
  ],
};

const QUIET = {
  id: 'test.quiet',
  title: 'No operations',
  version: '0.1.0',
  hostApi: 1,
  docs: 'Modules',
  activation: ['onToggle'],
  commands: [],
};

/** A document shaped like `AUTOMATION.md` around the heading: prose, the section, a rule, more. */
const DOC = [
  '## 2. The job file',
  '',
  'Some prose that must not move.',
  '',
  HEADING,
  '',
  'stale content',
  '',
  '---',
  '',
  '## 3. The Python client',
  '',
].join('\n');

test('every ArgType is spelled out, and the `?` forms say optional', () => {
  strictEqual(describeArg('n', 'number'), '`n` a number');
  strictEqual(describeArg('n', 'number?'), '`n` a number *(optional)*');
  strictEqual(describeArg('b', 'boolean'), '`b` true or false');
  strictEqual(
    describeArg('v', 'vec3?'),
    '`v` three numbers `[x, y, z]`, world RAS mm *(optional)*'
  );
  strictEqual(describeArg('ct', 'path'), '`ct` a path to an existing file');
  strictEqual(describeArg('t1', 'path?'), '`t1` a path to an existing file *(optional)*');
  strictEqual(describeArg('out', 'out'), '`out` a file name under `--out`');
  // An `ArgType` this script has not been taught is printed rather than dropped: a table missing a
  // module's argument would be worse than one naming it awkwardly.
  strictEqual(describeArg('x', 'quaternion'), '`x` quaternion');
});

test('a module renders one row per operation, and an empty arg list as a dash', () => {
  const lines = renderModule(EVERY);
  ok(lines[0].includes('`test.every`'));
  ok(lines[0].includes('2.5.0'), 'the version is in the heading: it is what a job result records');
  const every = lines.find((l) => l.startsWith('| `every`'));
  ok(every.includes('`n` a number'));
  ok(every.includes('`o` a file name under `--out`'));
  ok(lines.some((l) => l === '| `none` | — |'));
});

test('a module with no operations says so rather than printing an empty table', () => {
  const lines = renderModule(QUIET);
  ok(lines.join('\n').includes('declares no job operations'));
  ok(!lines.some((l) => l.startsWith('|')));
});

test('modules come out sorted by id, so the table does not shuffle with the filesystem', () => {
  const section = renderSection([QUIET, EVERY]);
  ok(section.indexOf('test.every') < section.indexOf('test.quiet'));
  ok(section.startsWith(HEADING));
});

test('the section replaces only itself, and keeps what is on either side', () => {
  const replaced = replaceSection(DOC, renderSection([EVERY]));
  ok(replaced.ok);
  ok(replaced.text.includes('Some prose that must not move.'));
  ok(replaced.text.includes('## 3. The Python client'));
  ok(!replaced.text.includes('stale content'));
  // The blank line above the heading survives, and the heading is still at the start of its line.
  ok(replaced.text.includes('\n\n' + HEADING + '\n'));
  ok(replaced.text.includes('\n\n---\n'));
});

test('replacing twice changes nothing the second time', () => {
  const once = replaceSection(DOC, renderSection([EVERY, QUIET])).text;
  const twice = replaceSection(once, renderSection([EVERY, QUIET])).text;
  strictEqual(twice, once);
});

test('a document with no heading is an error naming the heading, not a guess', () => {
  const result = replaceSection('## 2. The job file\n\nno section here\n', renderSection([EVERY]));
  strictEqual(result.ok, false);
  ok(result.error.includes(HEADING));
});

test('a manifest is recognised by its shape, not by its exported name', () => {
  ok(isManifest(EVERY));
  ok(!isManifest({ id: 'x.y' }));
  ok(!isManifest(null));
  ok(!isManifest('tetravox.hello'));
});

test('the shipped manifests are found and imported from a plain Node script', async () => {
  const files = manifestFiles();
  ok(files.length >= 1, 'at least the hello fixture');
  ok(files.every((f) => f.endsWith('manifest.ts')));
  const manifests = await readManifests();
  ok(manifests.some((m) => m.id === 'tetravox.hello'));
  ok(manifests.every(isManifest));
});

test('an older Node`s failure is recognised, and an unrelated one is not', () => {
  ok(
    needsStripTypes(
      Object.assign(new Error('Unknown file extension ".ts"'), {
        code: 'ERR_UNKNOWN_FILE_EXTENSION',
      })
    )
  );
  ok(!needsStripTypes(new Error('ENOENT: no such file or directory')));
});

test('the section committed to docs/AUTOMATION.md matches the manifests', async () => {
  // The check CI runs, run here too: `docs-guard` is where it fails a pull request, and this is
  // where it fails the person who changed a manifest before they push.
  const quiet = { log: () => {}, error: () => {} };
  strictEqual(await main(['--check'], quiet), 0);
});
