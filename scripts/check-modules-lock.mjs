/**
 * `modules.lock` — which external modules a release **bundles**, pinned by hash (ARCHITECTURE.md
 * §13.8).
 *
 * ```sh
 * node scripts/check-modules-lock.mjs           # validate modules.lock (CI: the docs-guard job)
 * node scripts/check-modules-lock.mjs <path>
 * ```
 *
 * ## Why a lock file at all
 *
 * A module lives in its own repository and ships as release assets. A release of *this* repository
 * that carries one has to say, in a form a reviewer can read as a diff, exactly which bytes it
 * carries — so bumping a bundled module is one pull request with two hashes in it, and a build whose
 * download does not match those hashes fails the leg rather than shipping an unverified module.
 * `scripts/fetch-locked-modules.mjs` is what reads it; this file is what says whether it is legible.
 *
 * ## The schema
 *
 * ```json
 * { "schema": 1,
 *   "modules": [{
 *     "id": "tetravox.seeg",
 *     "version": "1.0.0",
 *     "hostApi": 1,
 *     "repo": "idossha/tetravox-seeg",
 *     "tag": "v1.0.0",
 *     "bundled": true,
 *     "files": [{ "name": "index.js",      "bytes": 81234, "sha256": "…64 hex…" },
 *               { "name": "manifest.json", "bytes": 3412,  "sha256": "…64 hex…" }] }] }
 * ```
 *
 * `hostApi` is checked against this build's `MODULE_HOST_VERSION` rather than merely being an
 * integer: a bundled module is loaded by *this* app, and the host refuses a stale one at activation
 * — finding that out in CI is better than finding it out as a greyed-out card in a shipped release.
 *
 * `files[].name` is the file's name **inside the app**, not the asset name in the module's release:
 * an asset is uploaded under its own sha256 (the sample-data store's layout, `scripts/sample-data/
 * publish.sh`), which is what lets a download be verified against its own URL.
 *
 * **The lock carries no `url`.** It is derived — `https://github.com/<repo>/releases/download/<tag>/
 * <sha256>` — so a lock entry cannot name one repository and download from another.
 *
 * Every rule reports at once rather than stopping at the first, which is `validateJob`'s house style
 * (`main/job.ts`): a lock with three problems should cost one CI run, not three.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK = 'modules.lock';

export const SCHEMA = 1;
/** `<vendor>.<name>` — the dot is what keeps two labs' `contacts` modules apart. */
export const ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+$/;
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
export const TAG_RE = /^[A-Za-z0-9._-]+$/;
/** A file name inside the app: one path segment, no separators, no `..`. */
export const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

/** Every module release carries these two, and the app needs both to install anything. */
export const REQUIRED_FILES = ['index.js', 'manifest.json'];

/**
 * The install receipt's name, and the one file name a locked module may **not** ship.
 *
 * `fetch-locked-modules.mjs` writes a `tetravox-module.json` into every module directory it places,
 * because `main/module-store.ts` re-hashes a module against its receipt before serving any of it. A
 * lock entry naming that file would have it overwritten by the build — so it is refused here, where
 * the message can say why, rather than silently at placement time.
 */
export const RECEIPT_NAME = 'tetravox-module.json';

const MODULE_KEYS = ['id', 'version', 'hostApi', 'repo', 'tag', 'bundled', 'files'];
const FILE_KEYS = ['name', 'bytes', 'sha256'];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `MODULE_HOST_VERSION`, read from the manifest contract rather than restated here. */
export async function readHostVersion(root = REPO_ROOT) {
  const url = pathToFileURL(join(root, 'packages/app/src/modules/manifest-types.ts'));
  return (await import(url.href)).MODULE_HOST_VERSION;
}

/**
 * Validate a parsed lock. Returns every problem, never just the first.
 *
 * `hostApi` is the version this build implements; pass it so the rule is checked against the tree
 * rather than against a number written twice.
 */
export function validateLock(raw, { hostApi } = {}) {
  const errors = [];
  const bad = (msg) => errors.push(msg);

  if (!isObject(raw)) return { ok: false, errors: [`${LOCK}: the top level must be an object.`] };
  if (raw.schema !== SCHEMA)
    bad(`${LOCK}: "schema" must be ${SCHEMA}, not ${JSON.stringify(raw.schema)}.`);
  if (!Array.isArray(raw.modules)) {
    bad(`${LOCK}: "modules" must be an array.`);
    return { ok: errors.length === 0, errors };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'schema' && key !== 'modules') bad(`${LOCK}: unknown top-level key "${key}".`);
  }

  const seen = new Map();
  raw.modules.forEach((entry, i) => {
    const at = `${LOCK}: modules[${i}]`;
    if (!isObject(entry)) {
      bad(`${at} must be an object.`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!MODULE_KEYS.includes(key)) bad(`${at}: unknown key "${key}".`);
    }
    for (const key of MODULE_KEYS) {
      if (!(key in entry)) bad(`${at}: missing "${key}".`);
    }

    if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) {
      bad(`${at}.id must be <vendor>.<name> in lower case, not ${JSON.stringify(entry.id)}.`);
    } else if (seen.has(entry.id)) {
      bad(
        `${at}.id "${entry.id}" is already locked at modules[${seen.get(entry.id)}] — one entry per module.`
      );
    } else {
      seen.set(entry.id, i);
    }

    if (typeof entry.version !== 'string' || !SEMVER_RE.test(entry.version)) {
      bad(`${at}.version must be semver, not ${JSON.stringify(entry.version)}.`);
    }
    if (!Number.isInteger(entry.hostApi)) {
      bad(`${at}.hostApi must be an integer, not ${JSON.stringify(entry.hostApi)}.`);
    } else if (hostApi !== undefined && entry.hostApi !== hostApi) {
      bad(
        `${at}.hostApi is ${entry.hostApi}, but this build implements MODULE_HOST_VERSION ${hostApi}. ` +
          `The host refuses to activate a module built against another one, so bundling it would ship a card that cannot be enabled.`
      );
    }
    if (typeof entry.repo !== 'string' || !REPO_RE.test(entry.repo)) {
      bad(`${at}.repo must be "<owner>/<name>", not ${JSON.stringify(entry.repo)}.`);
    }
    if (typeof entry.tag !== 'string' || !TAG_RE.test(entry.tag)) {
      bad(`${at}.tag must be a git tag, not ${JSON.stringify(entry.tag)}.`);
    } else if (typeof entry.version === 'string' && !entry.tag.includes(entry.version)) {
      bad(
        `${at}.tag "${entry.tag}" does not contain version "${entry.version}". A lock whose tag and ` +
          `version disagree downloads one release and claims another.`
      );
    }
    if (typeof entry.bundled !== 'boolean') {
      bad(`${at}.bundled must be true or false, not ${JSON.stringify(entry.bundled)}.`);
    }

    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      bad(`${at}.files must be a non-empty array.`);
      return;
    }
    const names = new Set();
    entry.files.forEach((file, j) => {
      const fat = `${at}.files[${j}]`;
      if (!isObject(file)) {
        bad(`${fat} must be an object.`);
        return;
      }
      for (const key of Object.keys(file)) {
        if (!FILE_KEYS.includes(key)) bad(`${fat}: unknown key "${key}".`);
      }
      for (const key of FILE_KEYS) {
        if (!(key in file)) bad(`${fat}: missing "${key}".`);
      }
      if (typeof file.name !== 'string' || !FILE_RE.test(file.name)) {
        bad(
          `${fat}.name must be one path segment (no separators, no ".."), not ${JSON.stringify(file.name)}.`
        );
      } else if (file.name === RECEIPT_NAME) {
        bad(
          `${fat}.name "${RECEIPT_NAME}" is reserved: the bundling step writes the install receipt ` +
            `under that name, and main verifies the module against it.`
        );
      } else if (names.has(file.name)) {
        bad(`${fat}.name "${file.name}" appears twice in one module.`);
      } else {
        names.add(file.name);
      }
      if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
        bad(`${fat}.bytes must be a positive integer, not ${JSON.stringify(file.bytes)}.`);
      }
      if (typeof file.sha256 !== 'string' || !SHA256_RE.test(file.sha256)) {
        bad(
          `${fat}.sha256 must be 64 lower-case hex characters, not ${JSON.stringify(file.sha256)}.`
        );
      }
    });
    for (const required of REQUIRED_FILES) {
      if (!names.has(required))
        bad(`${at}.files has no "${required}" — every module release carries one.`);
    }
  });

  const ids = raw.modules
    .map((m) => (isObject(m) ? m.id : null))
    .filter((id) => typeof id === 'string');
  const sorted = [...ids].sort();
  if (ids.join(' ') !== sorted.join(' ')) {
    bad(
      `${LOCK}: "modules" must be sorted by id (${sorted.join(', ')}) so a bump is a one-entry diff.`
    );
  }

  return { ok: errors.length === 0, errors };
}

/** The lock, parsed. A syntax error is reported the same way a rule violation is. */
export function readLock(path) {
  try {
    return { ok: true, lock: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { ok: false, errors: [`${path}: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

export async function main(
  argv = [],
  { root = REPO_ROOT, log = console.log, err = console.error } = {}
) {
  const path = argv[0] === undefined ? join(root, LOCK) : resolve(argv[0]);
  const parsed = readLock(path);
  if (!parsed.ok) {
    for (const line of parsed.errors) err(line);
    return 1;
  }
  const { ok, errors } = validateLock(parsed.lock, { hostApi: await readHostVersion(root) });
  if (!ok) {
    for (const line of errors) err(line);
    err('');
    err(`${errors.length} problem${errors.length === 1 ? '' : 's'} in ${path}.`);
    return 1;
  }
  const n = parsed.lock.modules.length;
  const bundled = parsed.lock.modules.filter((m) => m.bundled).length;
  log(
    `${LOCK}: schema ${parsed.lock.schema}, ${n} module${n === 1 ? '' : 's'} (${bundled} bundled).`
  );
  for (const m of parsed.lock.modules) {
    log(`  ${m.id}@${m.version}  ${m.repo}@${m.tag}  ${m.files.length} files`);
  }
  return 0;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(await main(process.argv.slice(2)));
