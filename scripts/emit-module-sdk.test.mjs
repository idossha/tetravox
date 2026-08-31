/**
 * The SDK emitter's own tests (`node --test scripts/emit-module-sdk.test.mjs`).
 *
 * Every rule is driven **red** with a fixture as well as green — an import the SDK does not carry,
 * an engine name the subset cannot reach, a shim with an import left in it — because the three
 * things this script is are gates, and a gate nobody has seen fail is a gate nobody can trust.
 *
 * `node:test` rather than vitest for `check-frozen-docs.test.mjs`'s reason: this is a repository
 * script, not a package, and it must run in the cheap `docs-guard` job with no install behind it.
 * Nothing here shells out to `tsc` — the full emission is proved by running the script itself, which
 * `ci.yml` does in the `test` job.
 */

import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ENGINE_API_ROOTS,
  PACKAGE_NAME,
  REPO_ROOT,
  assertNoImports,
  assetName,
  contactsBarrel,
  declarationIndex,
  engineSubset,
  indexDts,
  packageJsonFor,
  rewriteSpecifier,
  specifierSites,
  stageText,
  stagedSources,
  stripLeadingBlockComment,
} from './emit-module-sdk.mjs';

const HOST = 'packages/app/src/renderer/src/modules/host.ts';
const TYPES = 'packages/app/src/modules/manifest-types.ts';
const MODEL = 'packages/app/src/renderer/src/modules/shared/contacts/model.ts';
const TSV = 'packages/app/src/renderer/src/modules/shared/contacts/tsv.ts';

/** A staging table shaped like the real one, small enough to read. */
const staged = () =>
  new Map([
    [HOST, 'host.ts'],
    [TYPES, 'manifest-types.ts'],
    [MODEL, 'contacts/model.ts'],
    [TSV, 'contacts/tsv.ts'],
  ]);

// -- names and versions --------------------------------------------------------------------------

test('the asset name carries both numbers a module author has to pin', () => {
  strictEqual(assetName(1, '0.2.0'), 'tetravox-module-sdk-1-0.2.0.tgz');
  strictEqual(packageJsonFor(1, '0.2.0').version, '1.0.0-core.0.2.0');
  strictEqual(packageJsonFor(2, '1.4.7').version, '2.0.0-core.1.4.7');
  strictEqual(packageJsonFor(1, '0.2.0').name, PACKAGE_NAME);
  deepStrictEqual(packageJsonFor(1, '0.2.0').tetravox, { hostApi: 1, coreVersion: '0.2.0' });
});

test('the SDK version is semver a resolver accepts, with the prerelease sorting under the major', () => {
  match(packageJsonFor(1, '0.2.0').version, /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/);
});

// -- the import wall (gate 1) --------------------------------------------------------------------

test('@tetravox/engine becomes the staged subset, from the root and from a subdirectory', () => {
  strictEqual(rewriteSpecifier('@tetravox/engine', HOST, staged()), './engine');
  strictEqual(rewriteSpecifier('@tetravox/engine', MODEL, staged()), '../engine');
});

test('a relative import of another staged source is rewritten to its staged path', () => {
  strictEqual(
    rewriteSpecifier('../../../modules/manifest-types', HOST, staged()),
    './manifest-types'
  );
  strictEqual(rewriteSpecifier('./model', TSV, staged()), './model');
});

test("'react' is the one bare specifier that survives", () => {
  strictEqual(rewriteSpecifier('react', HOST, staged()), 'react');
});

test('any other bare specifier is a hard failure that names the file and the specifier', () => {
  throws(
    () => rewriteSpecifier('zustand', HOST, staged()),
    (err) => err.message.includes('zustand') && err.message.includes(HOST)
  );
});

test('a relative import outside the SDK is a hard failure, not a silently broken d.ts', () => {
  throws(
    () => rewriteSpecifier('../hostImpl', HOST, staged()),
    (err) => err.message.includes('hostImpl')
  );
});

test('every specifier form this repository writes is found', () => {
  const src = [
    "import type { ComponentType } from 'react';",
    'import type {',
    '  Layer,',
    '  vec3,',
    "} from '@tetravox/engine';",
    "import { stemOf } from '../../../modules/manifest-types';",
    "export type { Layer } from '@tetravox/engine';",
    "export * from '@tetravox/engine';",
  ].join('\n');
  deepStrictEqual(
    specifierSites(src).map((s) => s.spec),
    [
      'react',
      '@tetravox/engine',
      '../../../modules/manifest-types',
      '@tetravox/engine',
      '@tetravox/engine',
    ]
  );
});

test('staging rewrites every specifier and touches nothing else', () => {
  const src =
    "import type { Layer } from '@tetravox/engine';\nexport const x: Layer | null = null;\n";
  strictEqual(
    stageText(src, MODEL, staged()),
    "import type { Layer } from '../engine';\nexport const x: Layer | null = null;\n"
  );
});

test('the real sources stage without reaching anything the SDK does not carry', () => {
  const table = stagedSources();
  for (const [source] of table) {
    const text = readFileSync(join(REPO_ROOT, source), 'utf8');
    stageText(text, source, table); // throws if any specifier escapes the SDK
  }
  ok(table.has(HOST));
  ok(table.has(TYPES));
});

// -- the engine subset ---------------------------------------------------------------------------

test('a declaration index finds interfaces, type aliases and their JSDoc', () => {
  const src = [
    '/** A point. */',
    'export interface P {',
    '  x: number;',
    '}',
    '',
    'export type Q = P | null;',
  ].join('\n');
  const decls = declarationIndex(src);
  deepStrictEqual([...decls.keys()], ['P', 'Q']);
  strictEqual(decls.get('P').start, 0, 'the JSDoc line is part of the block');
  strictEqual(decls.get('P').head, 1);
  strictEqual(decls.get('P').end, 3);
  strictEqual(decls.get('Q').end, 5);
});

test('the subset carries scene types verbatim and only the closure of its roots', () => {
  const scene = 'export type vec3 = [number, number, number];\nexport type LayerId = string;\n';
  const api = [
    'export interface Unrelated {',
    '  n: number;',
    '}',
    '',
    '/** Reached through PointToolEvent. */',
    'export interface Extra {',
    '  world: vec3;',
    '}',
    '',
    'export interface PointToolEvent {',
    '  layerId: LayerId;',
    '  extra: Extra;',
    '}',
  ].join('\n');
  const { text, reached } = engineSubset(scene, api, ['PointToolEvent']);
  deepStrictEqual(reached, ['Extra', 'PointToolEvent']);
  ok(text.includes('export type vec3'), 'scene/types.ts is carried whole');
  ok(text.includes('interface Extra'));
  ok(!text.includes('Unrelated'), 'a declaration nothing reaches is left behind');
  ok(text.indexOf('interface Extra') < text.indexOf('interface PointToolEvent'), 'source order');
});

test('a root the subset cannot resolve fails loudly and names it', () => {
  throws(
    () => engineSubset('', 'export interface A { n: number }', ['Absent']),
    (err) => err.message.includes('Absent') && err.message.includes('api.ts')
  );
});

test('a reference into a file the subset does not carry fails, rather than emitting a broken d.ts', () => {
  const api = [
    "import type { Capabilities } from './gl/caps';",
    'export interface A {',
    '  c: Capabilities;',
    '}',
  ].join('\n');
  throws(
    () => engineSubset('', api, ['A']),
    (err) => err.message.includes('Capabilities')
  );
});

test('a foreign name mentioned only in prose is not a reference', () => {
  const api = [
    "import type { Capabilities } from './gl/caps';",
    '/** Nothing to do with {@link Capabilities}. */',
    'export interface A {',
    '  n: number;',
    '}',
  ].join('\n');
  const { reached } = engineSubset('', api, ['A']);
  deepStrictEqual(reached, ['A']);
});

test('the engine files this subset is cut from are the ones §12.3 freezes', () => {
  const api = readFileSync(join(REPO_ROOT, 'packages/engine/src/api.ts'), 'utf8');
  const scene = readFileSync(join(REPO_ROOT, 'packages/engine/src/scene/types.ts'), 'utf8');
  strictEqual(
    specifierSites(scene).length,
    0,
    'scene/types.ts is carried verbatim, so it must import nothing'
  );
  const { reached } = engineSubset(scene, api);
  for (const root of ENGINE_API_ROOTS) ok(reached.includes(root));
});

test("the shipped subset's roots are the ones ModuleHost actually exposes", () => {
  const host = readFileSync(join(REPO_ROOT, HOST), 'utf8');
  for (const root of ENGINE_API_ROOTS) {
    ok(host.includes(root), `host.ts names ${root}`);
  }
});

test('a leading block comment is replaced, not appended to', () => {
  strictEqual(stripLeadingBlockComment('/** hi */\nexport type A = 1;\n'), 'export type A = 1;\n');
  strictEqual(stripLeadingBlockComment('export type A = 1;\n'), 'export type A = 1;\n');
});

// -- the zero-imports gate (gate 2) ---------------------------------------------------------------

test('a shim with no imports passes, one with any import does not', () => {
  assertNoImports('const sdk = globalThis.__tetravoxModuleSdk;\nexport const react = sdk.react;\n');
  throws(
    () => assertNoImports("import { createElement } from 'react';\n"),
    (err) => err.message.includes("import { createElement } from 'react';")
  );
  throws(
    () => assertNoImports("export { x } from './y';\n"),
    (err) => err.message.includes('./y')
  );
});

test('every import in the shim source is type-only, so the emitted shim has none at all', () => {
  const shim = readFileSync(join(REPO_ROOT, 'scripts/module-sdk/sdk-runtime.ts'), 'utf8');
  const lines = shim.split('\n');
  const sites = specifierSites(shim);
  ok(sites.length > 0, 'the shim does name its types');
  for (const site of sites) {
    const line = lines[shim.slice(0, site.at).split('\n').length - 1];
    ok(
      /^import type\b/.test(line),
      `sdk-runtime.ts may only use type-only imports, but line reads: ${line}`
    );
  }
});

// -- index.d.ts must not promise what index.js does not export ------------------------------------

test('index.d.ts declares exactly the shim run-time exports, and re-exports types with `export type *`', () => {
  const shim = readFileSync(join(REPO_ROOT, 'scripts/module-sdk/sdk-runtime.ts'), 'utf8');
  const runtime = [...shim.matchAll(/^export const ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]).sort();
  const dts = indexDts();
  const declared = [...dts.matchAll(/^export declare const ([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1])
    .sort();
  deepStrictEqual(declared, runtime);
  ok(
    !/^export \* from/m.test(dts),
    'a plain `export *` would promise values index.js does not have'
  );
  ok(/^export type \* from '\.\/types\/host';$/m.test(dts));
  ok(/^export type \* from '\.\/types\/contacts\/index';$/m.test(dts));
});

// -- the contract the renderer has to satisfy ------------------------------------------------------

test('the shim reads one global, and its name is pinned here as well as in the renderer', () => {
  const shim = readFileSync(join(REPO_ROOT, 'scripts/module-sdk/sdk-runtime.ts'), 'utf8');
  // The renderer assigns this exact key before any module is activated. It is asserted here because
  // the two halves live in different waves and in different processes' code, and a typo in either
  // one is a module that throws "not running inside a Tetravox module host" at load with nothing
  // else to go on.
  ok(shim.includes('globalThis.__tetravoxModuleSdk'));
  strictEqual((shim.match(/globalThis\.__tetravox\w*/g) ?? []).length > 0, true);
  for (const key of [...shim.matchAll(/globalThis\.(__\w+)/g)].map((m) => m[1])) {
    strictEqual(key, '__tetravoxModuleSdk', 'the shim reads exactly one global');
  }
});

test('TetravoxModuleSdk is the five members the renderer must provide, and no more', () => {
  const shim = readFileSync(join(REPO_ROOT, 'scripts/module-sdk/sdk-runtime.ts'), 'utf8');
  const body = /export interface TetravoxModuleSdk \{([\s\S]*?)\n\}/.exec(shim);
  ok(body !== null, 'the interface is declared');
  const members = [...body[1].matchAll(/^ {2}(\w+)[?:]/gm)].map((m) => m[1]).sort();
  deepStrictEqual(members, ['ModuleHostError', 'contacts', 'hostVersion', 'react', 'stemOf']);
});

test('the contacts barrel re-exports every module of the kit, in order', () => {
  const text = contactsBarrel(['model', 'tsv']);
  ok(text.includes("export * from './model';"));
  ok(text.includes("export * from './tsv';"));
  ok(text.indexOf('./model') < text.indexOf('./tsv'));
});
