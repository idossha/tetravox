/**
 * `manifest.json` → {@link InstalledManifest}, or a list of everything wrong with it (§13.1,
 * downloadable extensions, 2026-08-30).
 *
 * **One schema, two carriers.** A compiled-in module writes its manifest as a TypeScript literal and
 * `tsc` checks it; a downloaded module ships the byte-for-byte same object as JSON, and nothing
 * checks it — so this file is what `tsc` is for the other carrier. `manifest.json` is
 * `ModuleManifest` and *nothing more*: entry file names, sizes and hashes belong to the release and
 * to the install receipt, never to a module's self-description, which is why an unknown key is an
 * error rather than something to ignore.
 *
 * **Every problem at once**, the `job.ts#validateJob` house style ("a validator that stops at the
 * first bad key turns one round of fixing into four"). A module author gets one list, not four
 * builds.
 *
 * It lives in `src/modules/` — the data-only directory — because it imports **only**
 * `./manifest-types`, which is exactly what `modules.test.ts`'s "src/modules is data only" block
 * requires. That is also what lets main validate an installed manifest before a window exists, and
 * what lets the SDK re-emit this file as plain ESM so a module repository can validate its own
 * `manifest.json` with `node` and no install.
 *
 * Its test is `main/manifest-schema.test.ts`, deliberately **outside** this directory: the data-only
 * source scan rejects an `import … from 'vitest'` in here.
 */

import { MODULE_KEY_POOL } from './manifest-types';
import type { ArgType, InstalledManifest, ModuleKey } from './manifest-types';

/** `<vendor>.<name>`, the same shape `modules.test.ts` asserts over the compiled-in barrel. */
export const MANIFEST_ID = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** A contributed id — command, reader, writer, operation. Unprefixed; the host namespaces it. */
export const CONTRIBUTED_ID = /^[a-z][a-z0-9-]*$/;

/** semver `MAJOR.MINOR.PATCH` with an optional pre-release/build tail. */
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * A writer's sibling **template** before substitution.
 *
 * The one definition that matters is `main/module-io.ts#SIBLING_TEMPLATE` — the list main admits
 * against — and this is a copy, because `src/modules` may not import from `main`. They are checked
 * against each other in `main/manifest-schema.test.ts`: a manifest that declares a template main
 * would refuse is a module whose save is rejected by the very list that exists to permit it, which
 * is the bug this rule is here to catch at review time instead of at save time.
 */
export const SIBLING_TEMPLATE = /^[A-Za-z0-9_.{}-]{1,96}$/;

/** The four activation routes (§13.1). */
export const ACTIVATION_ROUTES: readonly string[] = [
  'onToggle',
  'onReader',
  'onSibling',
  'onSceneBlock',
];

/** Every `ArgType` of the job envelope (§13.6), as a value the validator can test membership in. */
export const ARG_TYPES: readonly ArgType[] = [
  'number',
  'number?',
  'string',
  'string?',
  'boolean',
  'boolean?',
  'vec3?',
  'path',
  'path?',
  'out',
];

/** A module's own manifest may declare at most this many of anything. A manifest is not a database. */
const MAX_ITEMS = 64;

/** Ascents a sibling candidate may make out of the anchor's directory (contracts §2). */
const MAX_ASCENTS = 3;

export type ManifestValidation =
  { ok: true; manifest: InstalledManifest } | { ok: false; errors: string[] };

function isBag(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A collector, so one pass reports every problem rather than throwing on the first. */
class Errors {
  readonly list: string[] = [];

  push(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }

  /** A non-empty string, capped — a title is a label, not a payload. */
  text(path: string, value: unknown, max = 200): value is string {
    if (typeof value !== 'string' || value === '') {
      this.push(path, 'must be a non-empty string');
      return false;
    }
    if (value.length > max) {
      this.push(path, `must be at most ${max} characters`);
      return false;
    }
    return true;
  }

  /** An array with at least one entry and a sane ceiling. */
  array(path: string, value: unknown, { optional = false } = {}): value is unknown[] {
    if (value === undefined && optional) return false;
    if (!Array.isArray(value)) {
      this.push(path, 'must be an array');
      return false;
    }
    if (value.length > MAX_ITEMS) {
      this.push(path, `must have at most ${MAX_ITEMS} entries`);
      return false;
    }
    return true;
  }

  /** Reject a key nobody declared, so a typo is a failure rather than a silently ignored field. */
  keys(path: string, bag: Record<string, unknown>, known: readonly string[]): void {
    for (const key of Object.keys(bag)) {
      if (!known.includes(key))
        this.push(`${path}.${key}`, `unknown key (expected ${known.join(', ')})`);
    }
  }
}

/** A `RegExp` source a manifest supplies. Compiled here so a bad one is a manifest error, not a throw. */
function isRegExpSource(source: unknown): source is string {
  if (typeof source !== 'string' || source === '' || source.length > 400) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

function validateCommands(raw: unknown, errors: Errors): void {
  if (!errors.array('commands', raw)) return;
  const ids = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const path = `commands[${i}]`;
    if (!isBag(entry)) {
      errors.push(path, 'must be an object');
      continue;
    }
    errors.keys(path, entry, ['id', 'title', 'key', 'shift', 'when']);
    validateContributedId(`${path}.id`, entry['id'], ids, errors);
    errors.text(`${path}.title`, entry['title']);
    const key = entry['key'];
    if (key !== undefined && !MODULE_KEY_POOL.includes(key as ModuleKey)) {
      errors.push(`${path}.key`, `must be one of ${MODULE_KEY_POOL.join(', ')}`);
    }
    const shift = entry['shift'];
    if (shift !== undefined && typeof shift !== 'boolean') {
      errors.push(`${path}.shift`, 'must be a boolean');
    }
    const when = entry['when'];
    if (when !== undefined && when !== 'toolArmed' && when !== 'selection') {
      errors.push(`${path}.when`, 'must be "toolArmed" or "selection"');
    }
  }
}

function validateContributedId(
  path: string,
  value: unknown,
  seen: Set<string>,
  errors: Errors
): void {
  if (typeof value !== 'string' || !CONTRIBUTED_ID.test(value)) {
    errors.push(path, 'must be a lower-case unprefixed id matching ' + String(CONTRIBUTED_ID));
    return;
  }
  if (seen.has(value)) errors.push(path, `duplicate id "${value}" within this manifest`);
  seen.add(value);
}

/** Lower-case, no dot: `['tsv', 'csv']` — the shape the Open sheet's filters are built from. */
function validateExtensions(path: string, raw: unknown, errors: Errors): void {
  if (!errors.array(path, raw)) return;
  if (raw.length === 0) errors.push(path, 'must name at least one extension');
  for (const [i, ext] of raw.entries()) {
    if (typeof ext !== 'string' || !/^[a-z0-9]{1,16}$/.test(ext)) {
      errors.push(`${path}[${i}]`, 'must be a lower-case extension with no leading dot');
    }
  }
}

function validateReaders(raw: unknown, errors: Errors): void {
  if (raw === undefined) return;
  if (!errors.array('readers', raw)) return;
  const ids = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const path = `readers[${i}]`;
    if (!isBag(entry)) {
      errors.push(path, 'must be an object');
      continue;
    }
    errors.keys(path, entry, ['id', 'title', 'extensions', 'match']);
    validateContributedId(`${path}.id`, entry['id'], ids, errors);
    errors.text(`${path}.title`, entry['title']);
    validateExtensions(`${path}.extensions`, entry['extensions'], errors);
    const match = entry['match'];
    if (match !== undefined && !isRegExpSource(match)) {
      errors.push(`${path}.match`, 'must be a compilable RegExp source');
    }
  }
}

/**
 * A sibling candidate: relative to the anchor's directory, at most {@link MAX_ASCENTS} `..` ascents.
 *
 * The ceiling is contracts §2's, and it is the reason sibling discovery is a *derived* name rather
 * than a directory walk: three ascents reaches a BIDS subject's session and no further.
 */
function validateCandidate(path: string, value: unknown, errors: Errors): void {
  if (typeof value !== 'string' || value === '' || value.length > 256) {
    errors.push(path, 'must be a non-empty relative path');
    return;
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    errors.push(path, 'must be relative to the anchor’s directory, never absolute');
    return;
  }
  const segments = value.split('/');
  const ascents = segments.filter((s) => s === '..').length;
  if (ascents > MAX_ASCENTS) {
    errors.push(path, `must make at most ${MAX_ASCENTS} ".." ascents (this one makes ${ascents})`);
  }
  const leading = segments.findIndex((s) => s !== '..' && s !== '.');
  if (leading !== -1 && segments.slice(leading).includes('..')) {
    errors.push(path, 'may only ascend at the start: "../a/../b" is not a sibling rule');
  }
}

function validateSiblings(raw: unknown, errors: Errors): void {
  if (raw === undefined) return;
  if (!errors.array('siblings', raw)) return;
  for (const [i, entry] of raw.entries()) {
    const path = `siblings[${i}]`;
    if (!isBag(entry)) {
      errors.push(path, 'must be an object');
      continue;
    }
    errors.keys(path, entry, ['from', 'candidates']);
    if (!isRegExpSource(entry['from'])) {
      errors.push(`${path}.from`, 'must be a compilable RegExp source over the anchor’s basename');
    }
    const candidates = entry['candidates'];
    if (!errors.array(`${path}.candidates`, candidates)) continue;
    if (candidates.length === 0) errors.push(`${path}.candidates`, 'must name at least one path');
    for (const [j, candidate] of candidates.entries()) {
      validateCandidate(`${path}.candidates[${j}]`, candidate, errors);
    }
  }
}

function validateWriters(raw: unknown, errors: Errors): void {
  if (raw === undefined) return;
  if (!errors.array('writers', raw)) return;
  const ids = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const path = `writers[${i}]`;
    if (!isBag(entry)) {
      errors.push(path, 'must be an object');
      continue;
    }
    errors.keys(path, entry, ['id', 'title', 'filters', 'siblings', 'backup']);
    validateContributedId(`${path}.id`, entry['id'], ids, errors);
    errors.text(`${path}.title`, entry['title']);
    const filters = entry['filters'];
    if (errors.array(`${path}.filters`, filters)) {
      if (filters.length === 0) errors.push(`${path}.filters`, 'must name at least one filter');
      for (const [j, filter] of filters.entries()) {
        const at = `${path}.filters[${j}]`;
        if (!isBag(filter)) {
          errors.push(at, 'must be { name, extensions }');
          continue;
        }
        errors.keys(at, filter, ['name', 'extensions']);
        errors.text(`${at}.name`, filter['name']);
        validateExtensions(`${at}.extensions`, filter['extensions'], errors);
      }
    }
    const siblings = entry['siblings'];
    if (errors.array(`${path}.siblings`, siblings)) {
      for (const [j, template] of siblings.entries()) {
        if (typeof template !== 'string' || !SIBLING_TEMPLATE.test(template)) {
          errors.push(
            `${path}.siblings[${j}]`,
            'must be a same-directory template main will admit: ' + String(SIBLING_TEMPLATE)
          );
        }
      }
    }
    const backup = entry['backup'];
    if (backup !== undefined && backup !== 'timestamped') {
      errors.push(`${path}.backup`, 'must be "timestamped" when present');
    }
  }
}

function validateOperations(raw: unknown, errors: Errors): void {
  if (raw === undefined) return;
  if (!errors.array('operations', raw)) return;
  const ids = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const path = `operations[${i}]`;
    if (!isBag(entry)) {
      errors.push(path, 'must be an object');
      continue;
    }
    errors.keys(path, entry, ['id', 'args']);
    validateContributedId(`${path}.id`, entry['id'], ids, errors);
    const args = entry['args'];
    if (!isBag(args)) {
      errors.push(`${path}.args`, 'must be an object of argument name → type');
      continue;
    }
    for (const [name, type] of Object.entries(args)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name)) {
        errors.push(`${path}.args.${name}`, 'is not a usable argument name');
      }
      if (!ARG_TYPES.includes(type as ArgType)) {
        errors.push(`${path}.args.${name}`, `must be one of ${ARG_TYPES.join(', ')}`);
      }
    }
  }
}

/**
 * Validate a parsed `manifest.json`.
 *
 * Returns the manifest **as read**, never a repaired one: a validator that fills in defaults is a
 * second source of truth for what a module declared, and the consent sheet shows the user what the
 * manifest says. Either every rule holds and this is the object, or none of it is used.
 */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors = new Errors();
  if (!isBag(raw)) return { ok: false, errors: ['manifest: must be a JSON object'] };

  errors.keys('manifest', raw, [
    'id',
    'title',
    'version',
    'hostApi',
    'docs',
    'activation',
    'commands',
    'readers',
    'siblings',
    'writers',
    'operations',
    'sceneBlock',
  ]);

  const id = raw['id'];
  if (typeof id !== 'string' || !MANIFEST_ID.test(id)) {
    errors.push('id', 'must be a `<vendor>.<name>` id matching ' + String(MANIFEST_ID));
  }
  errors.text('title', raw['title'], 120);
  const version = raw['version'];
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    errors.push('version', 'must be a semver string like "1.0.0"');
  }
  const hostApi = raw['hostApi'];
  if (typeof hostApi !== 'number' || !Number.isInteger(hostApi) || hostApi < 1) {
    errors.push(
      'hostApi',
      'must be a positive integer — the host API this module was written against'
    );
  }
  // `docs` is a `## ` heading in `docs/USER_GUIDE.md` for a compiled-in module and a URL for an
  // installed one (settled decision O3, 2026-08-30): the guard that ties a heading to the guide runs
  // over `packages/app/src/modules/*/manifest.ts` and has no reach into another repository's README.
  // Both are non-empty strings, which is all this file can honestly check.
  errors.text('docs', raw['docs'], 400);

  const activation = raw['activation'];
  if (errors.array('activation', activation)) {
    if (activation.length === 0) errors.push('activation', 'must name at least one route');
    for (const [i, route] of activation.entries()) {
      if (typeof route !== 'string' || !ACTIVATION_ROUTES.includes(route)) {
        errors.push(`activation[${i}]`, `must be one of ${ACTIVATION_ROUTES.join(', ')}`);
      }
    }
  }

  validateCommands(raw['commands'], errors);
  validateReaders(raw['readers'], errors);
  validateSiblings(raw['siblings'], errors);
  validateWriters(raw['writers'], errors);
  validateOperations(raw['operations'], errors);

  const sceneBlock = raw['sceneBlock'];
  if (sceneBlock !== undefined) {
    if (!isBag(sceneBlock)) {
      errors.push('sceneBlock', 'must be { version }');
    } else {
      errors.keys('sceneBlock', sceneBlock, ['version']);
      const blockVersion = sceneBlock['version'];
      if (typeof blockVersion !== 'number' || !Number.isInteger(blockVersion) || blockVersion < 1) {
        errors.push('sceneBlock.version', 'must be a positive integer');
      }
    }
  }

  if (errors.list.length > 0) return { ok: false, errors: errors.list };
  return { ok: true, manifest: raw as unknown as InstalledManifest };
}

/**
 * The permission list the consent sheet shows, **derived from the manifest** and from nothing else
 * (§13.1, 2026-08-30).
 *
 * One schema, no second source of truth: a module cannot ask for less in a separate `permissions`
 * block than its manifest lets it do. The registry index carries a copy so a catalogue card can be
 * drawn without downloading anything, and an installed manifest that disagrees with the index entry
 * is a hard install failure — the *installed* manifest is what the user consents to.
 */
export function derivePermissions(manifest: InstalledManifest): string[] {
  const out: string[] = [];
  const reads = [...new Set((manifest.readers ?? []).flatMap((r) => r.extensions))].sort();
  if (reads.length > 0) out.push(`Read ${reads.map((e) => `.${e}`).join(', ')} files you choose`);
  const writes = [...new Set((manifest.writers ?? []).flatMap((w) => w.siblings))].sort();
  if ((manifest.writers ?? []).length > 0) {
    const filters = [
      ...new Set((manifest.writers ?? []).flatMap((w) => w.filters.flatMap((f) => f.extensions))),
    ].sort();
    out.push(`Write ${filters.map((e) => `.${e}`).join(', ')} files you name in a Save sheet`);
  }
  for (const template of writes) out.push(`Write ${template} beside the file you save`);
  const keys = (manifest.commands ?? [])
    .filter((c) => c.key !== undefined)
    .map((c) => `${c.shift === true ? 'Shift+' : ''}${String(c.key)}`)
    .sort();
  if (keys.length > 0) out.push(`Bind the keys ${keys.join(', ')} while it is active`);
  const operations = (manifest.operations ?? []).map((o) => o.id).sort();
  if (operations.length > 0) out.push(`Run from a job file: ${operations.join(', ')}`);
  if (manifest.sceneBlock !== undefined) out.push('Store its own data inside a saved scene');
  return out;
}
