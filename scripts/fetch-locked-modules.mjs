/**
 * Download the modules `modules.lock` bundles, verify their hashes, and place them where the
 * packaged app finds them (ARCHITECTURE.md §13.8).
 *
 * ```sh
 * node scripts/fetch-locked-modules.mjs                # download, verify, place (release.yml, ci.yml package)
 * node scripts/fetch-locked-modules.mjs --verify-only  # no network: check what is already on disk (ci.yml test)
 * node scripts/fetch-locked-modules.mjs --store <dir>  # a local store, for tests and offline builds
 * ```
 *
 * # THE ON-DISK LAYOUT OF A BUNDLED MODULE
 *
 * **This block is the definition.** `main`'s bundled-module discovery, the module-store's two roots
 * and the extraction's `modules.lock` entry all cite *this* comment (and `docs/RELEASING.md` §9,
 * which restates it for an operator); nothing else describes the layout, so nothing else can drift
 * from it.
 *
 * ```
 * packages/app/resources/modules/
 *   bundled.json                          what this build ships, and the hashes main re-verifies
 *   <moduleId>/<version>/index.js         the module bundle the renderer imports
 *   <moduleId>/<version>/manifest.json    the module's own ModuleManifest, byte for byte
 * ```
 *
 * * `<moduleId>` is the manifest id verbatim (`tetravox.seeg`), `<version>` its version. Both are
 *   validated by `check-modules-lock.mjs` **before** anything is written, so neither can carry a
 *   path separator; so can every file name, which is one segment with no `..` in it.
 * * `electron-builder.yml` already ships `resources/**` as `extraResources` with `to: .`, so this
 *   needs **no packaging configuration at all**. The packaged root is
 *   `join(process.resourcesPath, 'modules')` and the development root is
 *   `join(app.getAppPath(), 'resources', 'modules')` — exactly the `phase0FixturePath()` pattern
 *   already in `src/main/index.ts`.
 * * `bundled.json` is `{ schema, modules: [{ id, version, hostApi, repo, tag, bundled: true,
 *   files: [{ name, bytes, sha256 }] }] }` — the lock's bundled entries, and nothing else. It is
 *   what lets main re-hash a bundled file at enable **without** shipping `modules.lock`, which is a
 *   build-time file and not part of the app.
 * * The tree is **read-only and pre-consented**: main seeds `settings.extensions[<id>]` from
 *   `bundled.json` on first run and never writes here. The other root — the user's installs, at
 *   `~/.tetravox/modules/<id>/<version>/` — has the same per-module shape and *is* writable.
 * * The tree is **not committed**. It is rebuilt from the lock on every packaging run, which is what
 *   makes "the release shipped these exact bytes" a claim the hashes prove rather than a claim the
 *   repository history has to be trusted for.
 *
 * # Where a file comes from
 *
 * `https://github.com/<repo>/releases/download/<tag>/<sha256>` — the asset's **name is its own
 * hash**, which is `scripts/sample-data/publish.sh`'s store layout verbatim and is what lets a
 * download be verified against its own URL. The lock therefore carries no URL of its own: an entry
 * cannot name one repository and download from another.
 *
 * A file already on disk is **re-hashed, not trusted** (`main/sample-data.ts` does the same with a
 * cached sample), and a download lands in `<target>.part` and is renamed only after its bytes
 * verify — so an interrupted build leaves no file that a later run would accept.
 *
 * A hash mismatch **fails the build**. That is the whole point: an unverified module must never
 * reach a packaged app, and a leg that could not verify one is a leg that must not produce an
 * artefact.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK, readLock, readHostVersion, validateLock } from './check-modules-lock.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one place the layout's root is spelled. */
export const RESOURCES_MODULES = 'packages/app/resources/modules';
/** What main reads instead of the lock, which is a build-time file and is not shipped. */
export const BUNDLED_INDEX = 'bundled.json';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** `https://github.com/<repo>/releases/download/<tag>/<sha256>` — derived, never carried. */
export function assetUrl(entry, file) {
  return `https://github.com/${entry.repo}/releases/download/${entry.tag}/${file.sha256}`;
}

/** Where one file of one locked module lands. Repo-relative. */
export function targetPath(entry, file) {
  return `${RESOURCES_MODULES}/${entry.id}/${entry.version}/${file.name}`;
}

/**
 * What ships beside the files: the lock's bundled entries, and nothing else.
 *
 * Deliberately the same shape as the lock rather than a new one — a second schema for the same facts
 * is a second thing to keep in step, and main validates the hashes it finds here against the bytes
 * on disk either way.
 */
export function bundledIndex(lock) {
  return {
    schema: lock.schema,
    modules: lock.modules
      .filter((m) => m.bundled)
      .map((m) => ({
        id: m.id,
        version: m.version,
        hostApi: m.hostApi,
        repo: m.repo,
        tag: m.tag,
        bundled: true,
        files: m.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
      })),
  };
}

/**
 * Does the file on disk match what the lock says? Re-hashed, never trusted for being there.
 *
 * Returns `null` when it matches, and the reason it does not otherwise.
 */
export function verifyOnDisk(absolute, file) {
  if (!existsSync(absolute)) return 'absent';
  const bytes = readFileSync(absolute);
  if (bytes.length !== file.bytes) return `is ${bytes.length} B, the lock says ${file.bytes} B`;
  const got = sha256(bytes);
  if (got !== file.sha256) return `hashes ${got}, the lock says ${file.sha256}`;
  return null;
}

/**
 * Read one asset's bytes.
 *
 * `store` is the build-time seam — a directory of files named by their own hash, or a base URL —
 * that lets a test, an offline build or a mirror stand in for GitHub. It changes *where* the bytes
 * come from and never whether they are checked: the caller verifies the hash either way, which is
 * why an override here cannot weaken anything.
 */
export async function readAsset(entry, file, store) {
  if (store !== undefined && store !== '' && !/^https?:/.test(store)) {
    const path = isAbsolute(store) ? join(store, file.sha256) : resolve(store, file.sha256);
    if (!existsSync(path)) throw new Error(`${file.sha256} is not in the store at ${store}`);
    return readFileSync(path);
  }
  const url =
    store === undefined || store === ''
      ? assetUrl(entry, file)
      : `${store.replace(/\/$/, '')}/${file.sha256}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Place one file: skip it when the bytes already on disk verify, otherwise fetch into `.part`,
 * verify, and rename. A mismatch throws — a bundled module is verified or the build stops.
 */
export async function placeFile(root, entry, file, { store, verifyOnly = false } = {}) {
  const rel = targetPath(entry, file);
  const absolute = join(root, rel);
  const wrong = verifyOnDisk(absolute, file);
  if (wrong === null) return { rel, action: 'verified' };
  if (verifyOnly) {
    if (wrong === 'absent') return { rel, action: 'absent' };
    throw new Error(`${rel} ${wrong}`);
  }

  mkdirSync(dirname(absolute), { recursive: true });
  const part = `${absolute}.part`;
  rmSync(part, { force: true });
  const bytes = await readAsset(entry, file, store);
  writeFileSync(part, bytes);
  const bad = verifyOnDisk(part, file);
  if (bad !== null) {
    rmSync(part, { force: true });
    throw new Error(
      `${entry.id}@${entry.version} ${file.name}: the download ${bad}. ` +
        `A bundled module is verified or it is not shipped — the lock and the release disagree.`
    );
  }
  renameSync(part, absolute);
  return { rel, action: 'downloaded' };
}

/** The whole run. Returns what it did, so a caller (and a test) can assert on it. */
export async function fetchLocked({
  root = REPO_ROOT,
  lock,
  store = process.env['TETRAVOX_MODULE_STORE'],
  verifyOnly = false,
  log = console.log,
} = {}) {
  const bundled = lock.modules.filter((m) => m.bundled);
  const placed = [];
  for (const entry of bundled) {
    for (const file of entry.files) {
      const result = await placeFile(root, entry, file, { store, verifyOnly });
      placed.push(result);
      log(`  ${result.action.padEnd(10)} ${result.rel}`);
    }
  }

  const indexPath = join(root, RESOURCES_MODULES, BUNDLED_INDEX);
  const index = `${JSON.stringify(bundledIndex(lock), null, 2)}\n`;
  if (verifyOnly) {
    // An ABSENT tree is not a failure: `--verify-only` runs in the `test` leg, which never fetches,
    // and its job is to catch a lock the tree *disagrees* with — not to demand a download it was
    // told not to make. A present index that does not match the lock is the drift it is looking for.
    if (existsSync(indexPath) && readFileSync(indexPath, 'utf8') !== index) {
      throw new Error(
        `${RESOURCES_MODULES}/${BUNDLED_INDEX} does not match ${LOCK}. Re-run without --verify-only.`
      );
    }
  } else if (bundled.length > 0) {
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, index);
    log(`  wrote      ${RESOURCES_MODULES}/${BUNDLED_INDEX}`);
  } else if (existsSync(indexPath)) {
    // An empty lock must leave an empty tree: a module removed from the lock is a module the next
    // build must not ship, and a stale index would tell main it is still there.
    rmSync(indexPath, { force: true });
    log(`  removed    ${RESOURCES_MODULES}/${BUNDLED_INDEX} (the lock bundles nothing)`);
  }
  return { bundled: bundled.length, placed };
}

export async function main(
  argv = [],
  { root = REPO_ROOT, log = console.log, err = console.error } = {}
) {
  const storeAt = argv.indexOf('--store');
  const parsed = readLock(join(root, LOCK));
  if (!parsed.ok) {
    for (const line of parsed.errors) err(line);
    return 1;
  }
  const { ok, errors } = validateLock(parsed.lock, { hostApi: await readHostVersion(root) });
  if (!ok) {
    for (const line of errors) err(line);
    err(`\n${LOCK} is not valid; nothing was fetched.`);
    return 1;
  }

  const verifyOnly = argv.includes('--verify-only');
  const bundled = parsed.lock.modules.filter((m) => m.bundled).length;
  log(
    `${LOCK}: ${bundled} bundled module${bundled === 1 ? '' : 's'}` +
      `${verifyOnly ? ' (verify only, no network)' : ''}`
  );
  try {
    await fetchLocked({
      root,
      lock: parsed.lock,
      verifyOnly,
      log,
      ...(storeAt === -1 ? {} : { store: argv[storeAt + 1] }),
    });
  } catch (e) {
    err(`fetch-locked-modules: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (bundled === 0) log('  nothing to fetch.');
  return 0;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(await main(process.argv.slice(2)));
