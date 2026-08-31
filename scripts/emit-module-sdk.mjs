/**
 * `@tetravox/module-sdk` — built from the core tree, per `MODULE_HOST_VERSION` (ARCHITECTURE.md
 * §13.8).
 *
 * ```sh
 * node scripts/emit-module-sdk.mjs                 # -> dist/module-sdk/<name>.tgz
 * node scripts/emit-module-sdk.mjs --out <dir>
 * node scripts/emit-module-sdk.mjs --no-tarball    # leave the unpacked package/ only
 * ```
 *
 * **What it is for.** A module lives in its own repository, is built there, and is downloaded as one
 * ESM file. It must therefore be typechecked against *this* app's declarations without depending on
 * this repository: the SDK is that dependency, pinned by URL to one core release, and the module
 * repo's CI runs `tsc --noEmit` against it. There is no npm publishing anywhere in this.
 *
 * **Everything in it is generated from the sources it mirrors**, which is the only property that
 * makes it trustworthy — a hand-written copy of `ModuleHost` would be a second declaration of a
 * frozen interface, and the first additive change to `host.ts` would leave a module compiling
 * against a surface the app no longer has. The one hand-written file is
 * `scripts/module-sdk/sdk-runtime.ts`, which contains no declarations at all: it reads values off
 * `globalThis.__tetravoxModuleSdk`.
 *
 * ## What lands in the tarball
 *
 * ```
 * package/
 *   package.json            name @tetravox/module-sdk, version <hostApi>.0.0-core.<coreVersion>
 *   index.js                the runtime shim — ZERO imports, inlined by the module build
 *   index.d.ts              the whole type surface, as one entry
 *   README.md               how a module repo consumes it
 *   manifest-schema.mjs     the manifest validator as plain ESM (when the core tree carries one)
 *   manifest-types.mjs      what it imports, beside it, because a .mjs may not reach into src
 *   types/host.d.ts             from renderer/src/modules/host.ts        (FROZEN §12.3 item 6)
 *   types/manifest-types.d.ts   from src/modules/manifest-types.ts
 *   types/manifest-schema.d.ts  from src/modules/manifest-schema.ts      (when present)
 *   types/engine.d.ts           the type-only subset of @tetravox/engine a module can name
 *   types/contacts/*.d.ts       from renderer/src/modules/shared/contacts/**
 *   types/sdk-runtime.ts        the shim's source, beside the declarations it references
 * ```
 *
 * ## How the types are produced
 *
 * The sources are **copied into a staging tree** whose shape is the shipped `types/` directory, with
 * every import specifier rewritten to a staged one, and `tsc --emitDeclarationOnly` is run over that.
 * The rewrite is a closed table (`stagedSources`) plus one alias (`@tetravox/engine`) plus one
 * allowed bare specifier (`react`); anything else is a hard failure naming the file and the
 * specifier. That is the same wall `modules.test.ts` puts around `packages/app/src/modules` — a list
 * of what may be reached, rather than a hope that nothing else is.
 *
 * `types/engine.d.ts` is not a copy of the engine. `packages/engine/src/scene/types.ts` has **no
 * imports at all** and is pure declarations, so it is carried verbatim; the six names a module needs
 * from `packages/engine/src/api.ts` (`NewLayer`, `ProbeResult`, `CoordSpaceRef`, `PointToolSpec`,
 * `PointSelection`, `PointToolEvent`) are extracted with their transitive closure, which is those six
 * plus `ProbeRow`. A name the closure reaches and cannot find is a hard failure, and the emitted
 * package is then compiled once more against a probe file, so a subset that does not typecheck never
 * ships.
 *
 * ## The four gates this script is
 *
 * 1. every import in every staged source resolves inside the SDK;
 * 2. `index.js` contains no `import` and no `export … from` — the property the module repo's
 *    zero-imports bundle check depends on;
 * 3. the emitted package typechecks against a probe that imports it the way a module does;
 * 4. `manifest-schema.mjs`, when it ships, is *imported* and made to validate a manifest — the
 *    README tells a module repo to run exactly that, and a specifier rewrite that did not resolve
 *    would otherwise ship as a green build and fail in somebody else's CI.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The npm package name a module repo depends on. Never published — pinned by release URL. */
export const PACKAGE_NAME = '@tetravox/module-sdk';

/** `renderer/src/modules/shared/contacts` — the kit that stays in core and is re-exported. */
const CONTACTS_DIR = 'packages/app/src/renderer/src/modules/shared/contacts';

/** The engine names a module may write, per the §13.8 SDK contents. */
export const ENGINE_API_ROOTS = [
  'NewLayer',
  'ProbeResult',
  'CoordSpaceRef',
  'PointToolSpec',
  'PointSelection',
  'PointToolEvent',
];

/** Bare specifiers a staged source may keep. A module repo brings its own `@types/react`. */
const ALLOWED_BARE = new Set(['react']);

// ------------------------------------------------------------------------------------------------
// Names and versions
// ------------------------------------------------------------------------------------------------

/**
 * The SDK package's own version: the **host API** major, the core release in the prerelease field.
 *
 * `1.0.0-core.0.2.0` sorts under `1.0.0`, which is right — an SDK is never a finished 1.0.0 of
 * anything, it is one core build's snapshot of host API 1 — and it carries both numbers a module
 * author has to reason about in a string a resolver understands.
 */
export function sdkVersion(hostApi, coreVersion) {
  return `${hostApi}.0.0-core.${coreVersion}`;
}

/**
 * The release asset name.
 *
 * Both numbers again, and both are load-bearing: `hostApi` says which app builds can run modules
 * built against it, `coreVersion` says which release it was cut from. A module repo pins the whole
 * URL, so this string is a public interface — `docs/RELEASING.md` §9 and `release.yml`'s `verify`
 * job both name it.
 */
export function assetName(hostApi, coreVersion) {
  return `tetravox-module-sdk-${hostApi}-${coreVersion}.tgz`;
}

/** `MODULE_HOST_VERSION`, read from the manifest contract rather than restated. */
export async function readHostVersion(root = REPO_ROOT) {
  const url = pathToFileURL(join(root, 'packages/app/src/modules/manifest-types.ts'));
  const mod = await import(url.href);
  return mod.MODULE_HOST_VERSION;
}

/** The core release this SDK is cut from. */
export function readCoreVersion(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

// ------------------------------------------------------------------------------------------------
// The staged source table, and the import rewrite
// ------------------------------------------------------------------------------------------------

/**
 * Which core source becomes which staged file.
 *
 * Keys are repo-relative source paths, values are paths inside the staging tree (which *is* the
 * shipped `types/` directory). `engine.ts` and `contacts/index.ts` have no key: they are generated.
 */
export function stagedSources(root = REPO_ROOT) {
  const map = new Map([
    ['packages/app/src/renderer/src/modules/host.ts', 'host.ts'],
    ['packages/app/src/modules/manifest-types.ts', 'manifest-types.ts'],
  ]);
  // W1a's hand-written validator. Absent from this tree until that wave lands; the SDK is emitted
  // without it rather than failing, because a module repo can validate its manifest by typechecking
  // it against `ModuleManifest` in the meantime.
  if (existsSync(join(root, 'packages/app/src/modules/manifest-schema.ts'))) {
    map.set('packages/app/src/modules/manifest-schema.ts', 'manifest-schema.ts');
  }
  for (const name of contactsModules(root)) {
    map.set(`${CONTACTS_DIR}/${name}.ts`, `contacts/${name}.ts`);
  }
  return map;
}

/** The contacts kit's module names, in a stable order and without its tests. */
export function contactsModules(root = REPO_ROOT) {
  return readdirSync(join(root, CONTACTS_DIR))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.slice(0, -3))
    .sort();
}

/**
 * Rewrite one import specifier for the staged tree, or throw.
 *
 * `sourcePath` is the repo-relative path of the file being staged; `spec` is what it imported.
 * Returns the specifier the staged copy should carry.
 */
export function rewriteSpecifier(spec, sourcePath, staged) {
  const from = staged.get(sourcePath);
  if (from === undefined) throw new Error(`not a staged source: ${sourcePath}`);
  const stagedDir = dirname(from);
  const toStaged = (target) => {
    const rel = relative(stagedDir, target).replaceAll('\\', '/');
    return rel.startsWith('.') ? rel : `./${rel}`;
  };

  if (spec === '@tetravox/engine') return toStaged('engine');
  if (!spec.startsWith('.')) {
    if (ALLOWED_BARE.has(spec)) return spec;
    throw new Error(
      `${sourcePath}: imports '${spec}', which the SDK does not carry. The SDK's sources may reach ` +
        `only each other, '@tetravox/engine' (types) and ${[...ALLOWED_BARE].join(', ')}.`
    );
  }
  const resolved = join(dirname(sourcePath), spec).replaceAll('\\', '/');
  for (const candidate of [`${resolved}.ts`, `${resolved}/index.ts`, resolved]) {
    const target = staged.get(candidate);
    if (target !== undefined) return toStaged(target.replace(/\.ts$/, ''));
  }
  throw new Error(
    `${sourcePath}: imports '${spec}', which resolves to ${resolved} — not one of the SDK's sources.`
  );
}

/** Every import/export specifier in a TypeScript source, with the offsets that hold them. */
export function specifierSites(text) {
  const sites = [];
  const re = /(?:^|[\s;}])(?:import|export)\b[^'"`;]*?from\s*(['"])([^'"]+)\1/g;
  for (const m of text.matchAll(re)) {
    const quote = m[1];
    const spec = m[2];
    const at = m.index + m[0].lastIndexOf(`${quote}${spec}${quote}`) + 1;
    sites.push({ spec, at });
  }
  // Bare side-effect imports (`import './x';`) — none today, but a silent miss would be a runtime
  // import in a bundle that promises none, so they are found rather than assumed away.
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*(['"])([^'"]+)\1/g)) {
    sites.push({ spec: m[2], at: m.index + m[0].lastIndexOf(m[2]) });
  }
  return sites.sort((a, b) => a.at - b.at);
}

/** The staged text of one source: the same file, with every specifier rewritten. */
export function stageText(text, sourcePath, staged) {
  let out = '';
  let cursor = 0;
  for (const site of specifierSites(text)) {
    out += text.slice(cursor, site.at);
    out += rewriteSpecifier(site.spec, sourcePath, staged);
    cursor = site.at + site.spec.length;
  }
  return out + text.slice(cursor);
}

// ------------------------------------------------------------------------------------------------
// types/engine.d.ts — the type-only subset
// ------------------------------------------------------------------------------------------------

const DECL_HEAD =
  /^(?:export\s+)?(?:declare\s+)?(interface|type|class|const|function|enum)\s+([A-Za-z_$][\w$]*)/;

/**
 * Index the top-level declarations of a TypeScript source by name.
 *
 * A regex reader rather than a parser, and it is honest about that: it recognises the shapes this
 * repository's frozen type files actually use (a JSDoc block, then one `export interface X { … }` or
 * `export type X = …;` at column 0) and the closure walk below then *verifies* itself by compiling
 * what it produced. A parser would be the right tool for arbitrary input; this input is two files
 * that §12.3 forbids reshaping without a documented decision.
 */
export function declarationIndex(text) {
  const lines = text.split('\n');
  const decls = new Map();
  for (let i = 0; i < lines.length; i++) {
    const head = DECL_HEAD.exec(lines[i]);
    if (head === null) continue;
    const [, kind, name] = head;
    let end = i;
    if (kind === 'interface' || kind === 'class' || kind === 'enum') {
      let depth = 0;
      let started = false;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') {
            depth++;
            started = true;
          } else if (ch === '}') depth--;
        }
        if (started && depth === 0) {
          end = j;
          break;
        }
      }
    } else {
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if ('{(['.includes(ch)) depth++;
          else if ('})]'.includes(ch)) depth--;
        }
        if (depth === 0 && /;\s*(?:\/\/.*)?$/.test(lines[j])) {
          end = j;
          break;
        }
      }
    }
    // Carry the JSDoc block above it: the comments are half of what these declarations are.
    let start = i;
    if ((lines[i - 1] ?? '').trim().endsWith('*/')) {
      let k = i - 1;
      while (k >= 0 && !lines[k].trim().startsWith('/**')) k--;
      if (k >= 0) start = k;
    }
    decls.set(name, { name, kind, start, end, head: i });
    i = end;
  }
  return decls;
}

/** The names a declaration's own text mentions. Coarse on purpose — the closure over-reaches, never under. */
export function referencedNames(text) {
  return new Set([...text.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
}

/** Comments removed, so a `{@link Engine.foo}` in prose is not read as a type reference. */
export function stripComments(text) {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');
}

/**
 * The names a source **imports from somewhere the SDK does not carry**.
 *
 * `api.ts` reaches `./scene/types` (which the subset carries whole), and also `./gl/caps`,
 * `./overlay/theme` and `./engine` (which it cannot). A subset that quietly referenced one of those
 * would emit a `.d.ts` naming a type that is not in the file, so they are found by name here and the
 * failure says which import brought it in.
 */
export function foreignImports(text, carried = ['./scene/types']) {
  const names = new Set();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    if (carried.includes(m[2])) continue;
    for (const part of m[1].split(',')) {
      const name = part
        .replace(/\btype\b/, '')
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name !== undefined && name !== '') names.add(name.trim());
    }
  }
  for (const m of text.matchAll(
    /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g
  )) {
    if (!carried.includes(m[2])) names.add(m[1]);
  }
  return names;
}

/**
 * `types/engine.d.ts`: `scene/types.ts` verbatim, plus the closure of {@link ENGINE_API_ROOTS} out
 * of `api.ts`.
 *
 * Returns `{ text, reached }`. Throws when a reached name is in neither file — which is the signal
 * that `api.ts` grew a reference into `engine.ts` or `gl/caps.ts` and the subset can no longer be a
 * subset.
 */
export function engineSubset(sceneTypes, apiSource, roots = ENGINE_API_ROOTS) {
  const sceneNames = new Set(declarationIndex(sceneTypes).keys());
  const apiDecls = declarationIndex(apiSource);
  const apiLines = apiSource.split('\n');

  const reached = new Set();
  const missing = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (reached.has(name) || sceneNames.has(name)) continue;
    const decl = apiDecls.get(name);
    if (decl === undefined) {
      missing.add(name);
      continue;
    }
    reached.add(name);
    const body = apiLines.slice(decl.head, decl.end + 1).join('\n');
    for (const id of referencedNames(body)) {
      if (id !== name && (apiDecls.has(id) || sceneNames.has(id))) queue.push(id);
    }
  }
  // A name the walk reached that neither file declares, and a name one of the extracted blocks
  // imported from somewhere the subset does not carry, are the same failure: the emitted
  // `engine.d.ts` would name a type that is not in it.
  const foreign = foreignImports(apiSource);
  for (const name of reached) {
    const decl = apiDecls.get(name);
    const body = stripComments(apiLines.slice(decl.head, decl.end + 1).join('\n'));
    for (const id of referencedNames(body)) {
      if (foreign.has(id)) missing.add(id);
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `packages/engine/src/api.ts: the SDK's engine subset reaches ${[...missing].sort().join(', ')}, ` +
        `which ${missing.size === 1 ? 'is' : 'are'} declared in neither api.ts nor scene/types.ts. ` +
        `Either the subset needs another source or the roots need trimming.`
    );
  }

  const blocks = [...reached]
    .map((n) => apiDecls.get(n))
    .sort((a, b) => a.start - b.start)
    .map((d) => apiLines.slice(d.start, d.end + 1).join('\n'));

  const text = [
    '/**',
    ' * The type-only subset of `@tetravox/engine` a Tetravox module may name.',
    ' *',
    ' * GENERATED by `scripts/emit-module-sdk.mjs` — do not edit. `packages/engine/src/scene/types.ts`',
    ' * is carried verbatim (it has no imports and declares no values); the block below it is the',
    ' * closure of the names `ModuleHost` exposes, lifted out of `packages/engine/src/api.ts`.',
    ' *',
    ' * A module never *calls* the engine — everything it can do goes through `ModuleHost` — so this',
    ' * file is declarations only, and a module repo needs no engine dependency at all.',
    ' */',
    '',
    stripLeadingBlockComment(sceneTypes).trimEnd(),
    '',
    '// -- from packages/engine/src/api.ts ----------------------------------------------------------',
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
  return { text, reached: [...reached].sort() };
}

/** Drop a file's own header comment: the generated banner replaces it. */
export function stripLeadingBlockComment(text) {
  const m = /^\s*\/\*[\s\S]*?\*\/\s*/.exec(text);
  return m === null ? text : text.slice(m[0].length);
}

// ------------------------------------------------------------------------------------------------
// The generated package files
// ------------------------------------------------------------------------------------------------

/** `types/contacts/index.ts` — the kit as one namespace, which is how the shim hands it over. */
export function contactsBarrel(names) {
  return [
    '/**',
    ' * The `shared/contacts` kit as one module — GENERATED by `scripts/emit-module-sdk.mjs`.',
    ' *',
    " * `sdk.contacts` is `typeof import('./index')`, so this barrel is what makes the runtime",
    ' * namespace and its declarations the same shape.',
    ' */',
    '',
    ...names.map((n) => `export * from './${n}';`),
    '',
  ].join('\n');
}

/**
 * `index.d.ts` — the one entry a module imports from.
 *
 * `export type *` for the declarations and an explicit `declare` for every runtime member, never
 * `export *`: a plain star over `manifest-types` would promise `MODULE_KEY_POOL` and
 * `ENGINE_RESERVED_KEYS` as values that `index.js` does not export, and a `.d.ts` that lies about
 * what exists at runtime is worse than one that omits it. The explicit declarations below are
 * exactly `index.js`'s exports, and the probe compile is what keeps that true.
 */
export function indexDts() {
  return `/**
 * ${PACKAGE_NAME} — GENERATED by \`scripts/emit-module-sdk.mjs\`. Do not edit.
 *
 * Types come from the core tree's own declarations; the runtime members are what
 * \`index.js\` reads off \`globalThis.__tetravoxModuleSdk\`.
 */

export type * from './types/host';
export type * from './types/manifest-types';
export type * from './types/engine';
export type * from './types/contacts/index';
export type { TetravoxModuleSdk } from './types/sdk-runtime';

type ReactNamespace = typeof import('react');

export declare const react: ReactNamespace;
export declare const createElement: ReactNamespace['createElement'];
export declare const useSyncExternalStore: ReactNamespace['useSyncExternalStore'];
export declare const useState: ReactNamespace['useState'];
export declare const useEffect: ReactNamespace['useEffect'];
export declare const useMemo: ReactNamespace['useMemo'];
export declare const useRef: ReactNamespace['useRef'];
export declare const useCallback: ReactNamespace['useCallback'];

/** The host's class, so \`instanceof\` holds across the module boundary. */
export declare const ModuleHostError: typeof import('./types/host').ModuleHostError;

/** \`{stem}\` — the one definition, shared with the main process. */
export declare const stemOf: (name: string) => string;

/** The \`shared/contacts\` kit, as the host's single instance. */
export declare const contacts: typeof import('./types/contacts/index');

/** The host API version the running app implements. */
export declare const MODULE_HOST_VERSION: number;
`;
}

/**
 * The package manifest. No dependencies: React and the engine types both come from the host.
 *
 * `subpaths` are the extra entry points this emission produced — `manifest-schema.mjs` and what it
 * imports. They have to be **named in `exports`** or they are not reachable at all: a package with
 * an `exports` map does not serve a file merely for being in the tarball, and
 * `import('@tetravox/module-sdk/manifest-schema.mjs')` — which the README tells a module repo to run
 * — fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Listed rather than a wildcard, because the SDK's
 * public surface should be a list of what it offers.
 */
export function packageJsonFor(hostApi, coreVersion, subpaths = []) {
  return {
    name: PACKAGE_NAME,
    version: sdkVersion(hostApi, coreVersion),
    description: `Types and runtime shim for Tetravox modules (host API ${hostApi}, core ${coreVersion}).`,
    license: 'MIT',
    type: 'module',
    main: './index.js',
    types: './index.d.ts',
    exports: {
      '.': { types: './index.d.ts', default: './index.js' },
      ...Object.fromEntries([...subpaths].sort().map((name) => [`./${name}`, `./${name}`])),
    },
    sideEffects: false,
    tetravox: { hostApi, coreVersion },
    repository: { type: 'git', url: 'git+https://github.com/idossha/tetravox.git' },
    peerDependencies: { react: '>=19' },
    peerDependenciesMeta: { react: { optional: true } },
  };
}

/**
 * Gate 4: import the emitted validator and make it decide a manifest.
 *
 * `manifest-schema.mjs` is `tsc`'s JavaScript with `./manifest-types` rewritten to
 * `./manifest-types.mjs`, which is a rewrite nothing else checks — and a module repository's CI runs
 * this exact import (`docs/RELEASING.md` §9.3, the SDK README). An emission whose validator cannot
 * be loaded, or that accepts an empty object, is not a usable SDK.
 */
export async function assertSchemaRuns(schemaPath, hostApi) {
  // The query string is a cache-buster: a second emission in one process writes new bytes to the
  // same path, and the module registry would otherwise hand back the first one.
  const mod = await import(`${pathToFileURL(schemaPath).href}?emit=${Date.now()}`);
  if (typeof mod.validateManifest !== 'function') {
    throw new Error(`${schemaPath} exports no validateManifest`);
  }
  const good = mod.validateManifest({
    id: 'vendor.name',
    title: 'Probe',
    version: '1.0.0',
    hostApi,
    docs: 'https://example.invalid/probe',
    activation: ['onToggle'],
    commands: [],
  });
  if (!good.ok) {
    throw new Error(
      `the emitted manifest schema refuses a valid manifest:\n${good.errors.join('\n')}`
    );
  }
  if (mod.validateManifest({}).ok) {
    throw new Error(`the emitted manifest schema accepts {} — it is not validating anything`);
  }
}

/** The probe a module repo's `tsc --noEmit` is a bigger version of. Gate 3. */
export function probeSource() {
  return `import type { ModuleActivate, ModuleHost, ModuleInstance } from '@tetravox/module-sdk';
import type { Layer, PointsLayer, vec3, vec4, PointToolSpec } from '@tetravox/module-sdk';
import type { ModuleManifest, ModuleId } from '@tetravox/module-sdk';
import type { Contact, ContactSet } from '@tetravox/module-sdk';
import {
  MODULE_HOST_VERSION,
  ModuleHostError,
  contacts,
  createElement,
  react,
  stemOf,
  useSyncExternalStore,
} from '@tetravox/module-sdk';

const manifest: ModuleManifest = {
  id: 'probe.module' as ModuleId,
  title: 'Probe',
  version: '1.0.0',
  hostApi: 1,
  docs: 'Probe',
  activation: ['onToggle'],
  commands: [{ id: 'go', title: 'Go', key: 'g' }],
};

export const activate: ModuleActivate = (host: ModuleHost): ModuleInstance => {
  const layers: readonly Layer[] = host.scene.layers();
  const points = layers.find((l): l is PointsLayer => l.kind === 'points');
  const cursor: vec3 = host.scene.cursor();
  const colour: vec4 = [1, 0, 0, 1];
  const spec: PointToolSpec = { layerId: points?.id ?? '', mode: 'select', template: { color: colour } };
  host.tool.setPointTool(spec);
  const set: ContactSet = contacts.emptySet();
  const one: Contact | null = contacts.contactById(set, 'x');
  void one;
  void stemOf(manifest.docs);
  void MODULE_HOST_VERSION;
  void cursor;
  void react.version;
  if (points === undefined) throw new ModuleHostError('no points layer');
  return {
    Panel: () => {
      useSyncExternalStore(
        () => () => {},
        () => 0,
        () => 0
      );
      return createElement('div', null, 'probe');
    },
    runCommand: () => {},
    dirty: () => false,
    dispose: () => {},
  };
};
`;
}

// ------------------------------------------------------------------------------------------------
// Emission
// ------------------------------------------------------------------------------------------------

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  return { status: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** Every file under `dir`, repo-relative to it, sorted — the order the tarball is built in. */
export function filesUnder(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, rel));
    else out.push(rel);
  }
  return out;
}

export async function emit({ root = REPO_ROOT, out, tarball = true, log = console.log } = {}) {
  const hostApi = await readHostVersion(root);
  const coreVersion = readCoreVersion(root);
  const outDir = out ?? join(root, 'dist/module-sdk');
  const work = join(outDir, '.work');
  const staging = join(work, 'staging');
  const pkg = join(outDir, 'package');

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  mkdirSync(join(pkg, 'types'), { recursive: true });

  // 1. Stage every source, rewriting its imports (gate 1).
  const staged = stagedSources(root);
  for (const [source, target] of staged) {
    const text = readFileSync(join(root, source), 'utf8');
    const full = join(staging, target);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, stageText(text, source, staged));
  }

  // 2. The two generated staging files: the engine subset and the contacts barrel.
  const { text: engineText, reached } = engineSubset(
    readFileSync(join(root, 'packages/engine/src/scene/types.ts'), 'utf8'),
    readFileSync(join(root, 'packages/engine/src/api.ts'), 'utf8')
  );
  writeFileSync(join(staging, 'engine.ts'), engineText);
  const contacts = contactsModules(root);
  writeFileSync(join(staging, 'contacts/index.ts'), contactsBarrel(contacts));

  // 3. The shim, staged beside the declarations it names.
  cpSync(join(root, 'scripts/module-sdk/sdk-runtime.ts'), join(staging, 'sdk-runtime.ts'));

  // 4. Declarations, then JavaScript. Two passes because only the shim's JS is shipped and the
  //    declarations are the whole of the rest.
  const tsc = join(root, 'node_modules/.bin/tsc');
  const tsconfig = join(work, 'tsconfig.sdk.json');
  const base = {
    target: 'ES2022',
    lib: ['ES2023', 'DOM', 'DOM.Iterable', 'WebWorker'],
    module: 'ESNext',
    moduleResolution: 'bundler',
    moduleDetection: 'force',
    isolatedModules: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    strict: true,
    noUncheckedIndexedAccess: true,
    // The staged copies are read-only mirrors: an unused local in one of them is the core tree's
    // business, not a reason the SDK cannot be emitted.
    noUnusedLocals: false,
    noUnusedParameters: false,
    types: [],
    baseUrl: root,
    paths: { react: ['packages/app/node_modules/@types/react'] },
    rootDir: staging,
  };
  writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          ...base,
          declaration: true,
          emitDeclarationOnly: true,
          outDir: join(pkg, 'types'),
        },
        include: [join(staging, '**/*.ts')],
      },
      null,
      2
    )
  );
  const dts = run(tsc, ['-p', tsconfig], root);
  if (dts.status !== 0) throw new Error(`tsc (declarations) failed:\n${dts.out}`);

  const jsDir = join(work, 'js');
  const tsconfigJs = join(work, 'tsconfig.sdk.js.json');
  writeFileSync(
    tsconfigJs,
    JSON.stringify(
      {
        compilerOptions: { ...base, declaration: false, outDir: jsDir },
        include: [join(staging, '**/*.ts')],
      },
      null,
      2
    )
  );
  const js = run(tsc, ['-p', tsconfigJs], root);
  if (js.status !== 0) throw new Error(`tsc (javascript) failed:\n${js.out}`);

  // 5. The package's own files.
  const shim = readFileSync(join(jsDir, 'sdk-runtime.js'), 'utf8');
  assertNoImports(shim); // gate 2
  writeFileSync(join(pkg, 'index.js'), shim);
  writeFileSync(join(pkg, 'index.d.ts'), indexDts());
  cpSync(join(staging, 'sdk-runtime.ts'), join(pkg, 'types/sdk-runtime.ts'));
  writeFileSync(
    join(pkg, 'README.md'),
    readFileSync(join(root, 'scripts/module-sdk/README.md'), 'utf8')
      .replaceAll('{{HOST_API}}', String(hostApi))
      .replaceAll('{{CORE_VERSION}}', coreVersion)
      .replaceAll('{{ASSET}}', assetName(hostApi, coreVersion))
      .replaceAll('{{SDK_VERSION}}', sdkVersion(hostApi, coreVersion))
  );
  // The extra entry points, before `package.json`, because `exports` has to name every one of them.
  const subpaths = [];
  const schemaJs = join(jsDir, 'manifest-schema.js');
  if (existsSync(schemaJs)) {
    // Plain ESM so a module repo's CI can validate its own manifest.json with node and no install.
    for (const name of ['manifest-schema', 'manifest-types']) {
      const src = join(jsDir, `${name}.js`);
      if (!existsSync(src)) continue;
      writeFileSync(
        join(pkg, `${name}.mjs`),
        readFileSync(src, 'utf8').replace(/(from\s*['"])(\.\/[\w.-]+?)(['"])/g, '$1$2.mjs$3')
      );
      subpaths.push(`${name}.mjs`);
    }
  }
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify(packageJsonFor(hostApi, coreVersion, subpaths), null, 2)}\n`
  );
  // Gate 4: the validator this SDK ships is *run*. The `.mjs` files are rewritten copies of tsc's
  // output, so their specifiers are only proved by resolving them, and the README's `node -e` is
  // exactly this import.
  if (subpaths.includes('manifest-schema.mjs')) {
    await assertSchemaRuns(join(pkg, 'manifest-schema.mjs'), hostApi);
  }

  // 6. Gate 3: the emitted package typechecks against a probe that imports it the way a module does.
  const probeDir = join(work, 'probe');
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(join(probeDir, 'probe.ts'), probeSource());
  const probeConfig = join(probeDir, 'tsconfig.json');
  writeFileSync(
    probeConfig,
    JSON.stringify(
      {
        compilerOptions: {
          ...base,
          rootDir: probeDir,
          noEmit: true,
          jsx: 'react-jsx',
          baseUrl: root,
          paths: {
            react: ['packages/app/node_modules/@types/react'],
            '@tetravox/module-sdk': [relative(root, join(pkg, 'index.d.ts')).replaceAll('\\', '/')],
          },
        },
        include: [join(probeDir, '*.ts')],
      },
      null,
      2
    )
  );
  const probe = run(tsc, ['-p', probeConfig], root);
  if (probe.status !== 0) throw new Error(`the emitted SDK does not typecheck:\n${probe.out}`);

  // 7. The tarball, npm-pack shaped (`package/` prefix) so a URL dependency installs.
  const files = filesUnder(pkg);
  let archive = null;
  if (tarball) {
    archive = join(outDir, assetName(hostApi, coreVersion));
    const tar = run('tar', ['-czf', archive, '-C', outDir, 'package'], root);
    if (tar.status !== 0) throw new Error(`tar failed:\n${tar.out}`);
  }

  rmSync(work, { recursive: true, force: true });

  log(`${PACKAGE_NAME}@${sdkVersion(hostApi, coreVersion)}`);
  log(`  engine subset: scene/types.ts + ${reached.join(', ')}`);
  log(`  contacts:      ${contacts.join(', ')}`);
  for (const f of files) {
    const buf = readFileSync(join(pkg, f));
    log(`  ${sha256(buf).slice(0, 16)}  ${String(buf.length).padStart(7)}  package/${f}`);
  }
  if (archive !== null) {
    log(`  -> ${relative(root, archive)}  (${statSync(archive).size} B)`);
  }
  return { hostApi, coreVersion, outDir, pkg, archive, files, reached, contacts };
}

/**
 * Gate 2 — the shim must not import anything.
 *
 * This is the property the module repo's bundle check rests on: the module build inlines the shim,
 * so a single surviving `import` in it becomes an unresolvable specifier in a file the renderer
 * loads over `tetravox://module/`.
 */
export function assertNoImports(js) {
  const offenders = [...js.matchAll(/^\s*(?:import\b[^\n]*|export\b[^\n]*\bfrom\b[^\n]*)$/gm)].map(
    (m) => m[0].trim()
  );
  if (offenders.length > 0) {
    throw new Error(
      `the SDK runtime shim must have no imports (it is inlined by every module build), but it has:\n` +
        offenders.map((o) => `  ${o}`).join('\n')
    );
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  try {
    await emit({
      out: outAt === -1 ? undefined : resolve(argv[outAt + 1]),
      tarball: !argv.includes('--no-tarball'),
    });
  } catch (err) {
    console.error(`emit-module-sdk: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
