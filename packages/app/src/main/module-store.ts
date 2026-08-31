/**
 * File ▸ Extensions… (§13, downloadable extensions, 2026-08-30): installing, verifying, consenting
 * to and serving modules that were **not** compiled into this build.
 *
 * This is `sample-data.ts` for code instead of for data, and it is deliberately the same file twice
 * over — the catalogue is content-addressed, a download goes to `<target>.part` and is renamed only
 * after its sha256 matches, and a file already on disk is re-hashed rather than trusted. Everything
 * that is *different* is different because the payload is script:
 *
 *  1. **Nothing is reachable until it is enabled.** A downloaded file sits in
 *     `~/.tetravox/modules/<id>/<version>/` and is inert: the renderer cannot name a path and cannot
 *     fetch one. {@link enableModule} re-hashes every file against the receipt written at install
 *     time and only then puts it on `protocol.ts`'s `tetravox://module` map. An installed module the
 *     user has not consented to 404s from the scheme, so **consent gates execution**, not just the
 *     switcher row.
 *  2. **Revocation is main's, not the renderer's.** `disableModule` and `removeModule` call
 *     `revokeModuleWrites(id)` themselves, in the same breath as dropping the protocol entries.
 *     `tetravox:module-clear-writes` — the renderer's cooperative half — is right for "a module left
 *     the slot" and is exactly wrong here: withdrawing a capability cannot be a message main hopes
 *     to receive.
 *  3. **The manifest is validated, not parsed.** `manifest-schema.ts` is `tsc` for the JSON carrier;
 *     a manifest that fails it is a module that is never registered, never listed and never served.
 *
 * Two roots, read in this order:
 *
 *  * **bundled** — `resources/modules/` inside the application (`extraResources`, so
 *    `process.resourcesPath` when packaged and `<appPath>/resources` in dev). Read-only, seeded into
 *    `settings.extensions` on first run without a sheet: it shipped inside the signed application,
 *    so installing the app *was* the consent, and this is what keeps the flagship module working out
 *    of the box. `scripts/fetch-locked-modules.mjs` builds this tree from `modules.lock` and leaves
 *    the same {@link RECEIPT_NAME} receipt an install does, so a bundled module is verified here by
 *    exactly the code that verifies a downloaded one.
 *  * **user** — `TETRAVOX_MODULE_DIR ?? <configHome()>/modules`, writable, everything the dialog
 *    installs. `configHome()` already honours `TETRAVOX_HOME`, so a test never touches a real
 *    `~/.tetravox`.
 *
 * A bundled id wins a collision: a user-installed module can never shadow one the build ships.
 */

import { app, net, shell } from 'electron';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import indexJson from '../shared/extensions-index.json';
import { derivePermissions, validateManifest } from '../modules/manifest-schema';
import type { InstalledManifest } from '../modules/manifest-types';
import { MODULE_HOST_VERSION } from '../modules/manifest-types';
import { MANIFESTS, registerInstalledManifests } from '../modules/manifests';
import { revokeModuleWrites } from './module-io';
import { serveModuleFile, servedModuleKeys, servedModuleVersion, unserveModule } from './protocol';
import { configHome, readSettings, writeSettings } from './settings';
import type { ModuleConsent } from './settings';

// ------------------------------------------------------------------------------------------------
// The catalogue
// ------------------------------------------------------------------------------------------------

/** One downloadable artefact of one module version. Content-addressed, exactly like a sample file. */
export interface ExtensionFile {
  /** The name it gets on disk. `index.js` is the entry the loader imports. */
  name: string;
  bytes: number;
  sha256: string;
  url: string;
}

export interface ExtensionVersion {
  version: string;
  hostApi: number;
  published?: string;
  files: ExtensionFile[];
}

export interface ExtensionEntry {
  id: string;
  title: string;
  summary: string;
  description?: string;
  repo?: string;
  author?: string;
  licence?: string;
  docs?: string;
  versions: ExtensionVersion[];
}

interface ExtensionsIndex {
  schema: number;
  generated?: string;
  modules: ExtensionEntry[];
}

/** A module file is code, not a dataset: 32 MiB is already an order of magnitude past plausible. */
export const MAX_MODULE_FILE_BYTES = 32 * 1024 * 1024;

/**
 * The install receipt written beside a module's files. Its name is part of the on-disk contract.
 *
 * Two writers, one shape: {@link installModule} after a download, and
 * `scripts/fetch-locked-modules.mjs` for a module `modules.lock` bundles into the packaged app.
 * That script's test reads {@link InstallReceipt} out of this file and compares the field lists, so
 * the two halves cannot drift apart unnoticed.
 */
export const RECEIPT_NAME = 'tetravox-module.json';

/** What a module ships as executable. Nothing else is ever put on the protocol map. */
const SERVABLE = /\.(js|css)$/i;

const SHIPPED_INDEX = indexJson as unknown as ExtensionsIndex;

function readIndexFile(path: string): ExtensionsIndex | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const index = parsed as ExtensionsIndex;
    return Array.isArray(index.modules) ? index : null;
  } catch {
    return null;
  }
}

/**
 * Whether the dev/E2E env seams (`TETRAVOX_MODULE_DIR`, `TETRAVOX_EXT_INDEX`) are honoured.
 *
 * They are **trust-relevant**: an ambient export from a dotfile, a wrapper script or a parent process
 * could silently repoint the installed store or replace the whole catalogue the user browses — a
 * spoofed 'official' module whose sha256 self-consistency passes because the same attacker authored
 * both the index and the files. A **shipped** build must ignore them and always read its bundled
 * catalogue and the real `configHome()/modules` store, exactly the reasoning that closed the
 * identical `TETRAVOX_E2E_DISCARD` seam in a packaged build (`shouldPromptOnClose`, module-io.ts,
 * 2026-08-30). They stay live for dev (`!app.isPackaged`) and for the packaged E2E leg, which sets
 * `TETRAVOX_E2E=1` so `csp.spec.ts` can still stage a fixture module against a real build (finding,
 * 2026-08-31).
 */
function envSeamsAllowed(): boolean {
  return !app.isPackaged || process.env['TETRAVOX_E2E'] === '1';
}

/**
 * The catalogue the dialog shows.
 *
 * The **shipped** copy by default — `sample-data.ts`'s precedent exactly, and the reason the dialog
 * is correct with no network at all. `TETRAVOX_EXT_INDEX` names a JSON file instead, which is how
 * the E2E and the unit tests offer a fixture module without a registry existing — honoured only when
 * {@link envSeamsAllowed}, so a shipped build cannot be pointed at a spoofed catalogue.
 */
export function catalogue(): readonly ExtensionEntry[] {
  const override = envSeamsAllowed() ? process.env['TETRAVOX_EXT_INDEX'] : undefined;
  if (override !== undefined && override !== '') {
    const loaded = readIndexFile(override);
    if (loaded !== null) return loaded.modules;
  }
  return SHIPPED_INDEX.modules;
}

export function catalogueEntry(id: string): ExtensionEntry | null {
  return catalogue().find((m) => m.id === id) ?? null;
}

/** The newest catalogue version of `id` this build's host API can run, or null. */
export function newestCompatible(entry: ExtensionEntry): ExtensionVersion | null {
  const usable = entry.versions.filter((v) => v.hostApi === MODULE_HOST_VERSION);
  if (usable.length === 0) return null;
  return usable.reduce((best, v) => (compareVersions(v.version, best.version) > 0 ? v : best));
}

/** Numeric-segment semver compare; a pre-release tail sorts below the release it belongs to. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .split('-')[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const pre = (v: string): string => v.split('-').slice(1).join('-');
  const pa = pre(a);
  const pb = pre(b);
  if (pa === pb) return 0;
  if (pa === '') return 1;
  if (pb === '') return -1;
  return pa < pb ? -1 : 1;
}

// ------------------------------------------------------------------------------------------------
// The two roots
// ------------------------------------------------------------------------------------------------

/**
 * Where the dialog installs. `TETRAVOX_MODULE_DIR` is the E2E's and the tests' seam, honoured only
 * when {@link envSeamsAllowed} — a shipped build always reads the real `configHome()/modules` store,
 * so an ambient env var cannot repoint where installed modules are read from.
 */
export function moduleDir(): string {
  const override = envSeamsAllowed() ? process.env['TETRAVOX_MODULE_DIR'] : undefined;
  return override ?? join(configHome(), 'modules');
}

/**
 * The read-only root inside the application, or null when there is none.
 *
 * `electron-builder.yml` already ships `resources/**` as `extraResources` with `to: .`, and
 * `main/index.ts` already resolves a resource this way for the Phase-0 fixture — so bundling a
 * module needs no packaging change at all, which is the whole reason the layout is this one.
 */
export function bundledModuleDir(): string | null {
  try {
    const root = app.isPackaged
      ? join(process.resourcesPath, 'modules')
      : join(app.getAppPath(), 'resources', 'modules');
    return existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// What is on disk
// ------------------------------------------------------------------------------------------------

export interface ReceiptFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface InstallReceipt {
  schema: number;
  id: string;
  version: string;
  installedAt: string;
  files: ReceiptFile[];
}

export interface InstalledModule {
  id: string;
  version: string;
  hostApi: number;
  title: string;
  /** The directory holding `manifest.json`, the entry file and the receipt. */
  dir: string;
  bundled: boolean;
  manifest: InstalledManifest;
  /** The receipt, or null for a bundled module that shipped without one. */
  receipt: InstallReceipt | null;
}

function readReceipt(dir: string): InstallReceipt | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, RECEIPT_NAME), 'utf8')) as unknown;
    if (raw === null || typeof raw !== 'object') return null;
    const receipt = raw as InstallReceipt;
    if (!Array.isArray(receipt.files)) return null;
    for (const file of receipt.files) {
      if (typeof file.name !== 'string' || typeof file.sha256 !== 'string') return null;
    }
    return receipt;
  } catch {
    return null;
  }
}

/** A file name a module may ship. No separator, no `..`, no dotfile. */
function isModuleFileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(name) && !name.includes('..');
}

function readModuleAt(dir: string, bundled: boolean): InstalledModule | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
  const validated = validateManifest(parsed);
  if (!validated.ok) return null;
  const manifest = validated.manifest;
  return {
    id: manifest.id,
    version: manifest.version,
    hostApi: manifest.hostApi,
    title: manifest.title,
    dir,
    bundled,
    manifest,
    receipt: readReceipt(dir),
  };
}

function scanRoot(root: string | null, bundled: boolean): InstalledModule[] {
  if (root === null) return [];
  let ids: string[];
  try {
    ids = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: InstalledModule[] = [];
  for (const id of ids) {
    let versions: string[];
    try {
      versions = readdirSync(join(root, id), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const version of versions) {
      const found = readModuleAt(join(root, id, version), bundled);
      if (found === null) continue;
      // The directory names are not evidence — the manifest is — but they have to agree, or an
      // update would install beside itself under a name nothing looks for.
      if (found.id !== id || found.version !== version) continue;
      out.push(found);
    }
  }
  return out;
}

/** The newest installed copy of each id, bundled winning a collision. */
export function installedModules(): InstalledModule[] {
  // A compiled-in id cannot be shadowed by an on-disk module (manifests.ts: "module-store.ts refuses
  // an installed module whose id collides"). An installed copy of `tetravox.hello`
  // is refused **entirely** here — the same skip the renderer's eligibility check makes — so its
  // bytes are never served, no consent is fabricated for it at boot, its manifest never joins the
  // registered set, and it never mislabels the built-in module's card (finding, 2026-08-31).
  const compiledIn = new Set<string>(MANIFESTS.map((m) => m.id));
  const found = [...scanRoot(bundledModuleDir(), true), ...scanRoot(moduleDir(), false)].filter(
    (m) => !compiledIn.has(m.id)
  );
  const best = new Map<string, InstalledModule>();
  for (const module of found) {
    const current = best.get(module.id);
    if (current === undefined) {
      best.set(module.id, module);
      continue;
    }
    if (current.bundled && !module.bundled) continue;
    if (!current.bundled && module.bundled) {
      best.set(module.id, module);
      continue;
    }
    if (compareVersions(module.version, current.version) > 0) best.set(module.id, module);
  }
  return [...best.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function installedModule(id: string): InstalledModule | null {
  return installedModules().find((m) => m.id === id) ?? null;
}

// ------------------------------------------------------------------------------------------------
// Consent
// ------------------------------------------------------------------------------------------------

/** What the user has consented to, by id. */
export function consents(): Record<string, ModuleConsent> {
  return readSettings().extensions;
}

/**
 * Has the user consented to run **this** module at **this** version?
 *
 * The version is part of the question on purpose: an update is a new set of bytes with a new
 * permission list, and a consent recorded for 1.0.0 is not a consent for 1.1.0. A mismatch is not an
 * error — it is the card going back to "Enable", which is one click and an honest sheet.
 */
export function isModuleConsented(id: string): boolean {
  // A **compiled-in** module needs no consent and never had one recorded: it is code the build
  // shipped, reviewed in the pull request that added it, and installing Tetravox was the consent.
  // Without this line the same predicate that gates an installed module would fail every job that
  // names `tetravox.hello`.
  if (MANIFESTS.some((m) => m.id === id)) return true;
  const module = installedModule(id);
  if (module === null) return false;
  const record = consents()[id];
  return record !== undefined && record.version === module.version;
}

function grantConsent(module: InstalledModule): void {
  const next = { ...consents() };
  next[module.id] = {
    version: module.version,
    hostApi: module.hostApi,
    grantedAt: new Date().toISOString(),
    permissions: derivePermissions(module.manifest),
  };
  writeSettings({ extensions: next });
}

function dropConsent(id: string): void {
  const next = { ...consents() };
  if (!(id in next)) return;
  delete next[id];
  writeSettings({ extensions: next });
}

// ------------------------------------------------------------------------------------------------
// Enable / disable — the protocol map and the write list
// ------------------------------------------------------------------------------------------------

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export type EnableResult = { ok: true; served: string[] } | { ok: false; error: string };

/**
 * Re-hash every file of an installed module against its receipt.
 *
 * `sample-data.ts` re-hashes a cached file rather than trusting it, and this is the same rule with
 * a sharper reason: between install and enable the file is a script that will run with the whole
 * preload bridge. **A bundled module is checked the same way**: the bundling step writes a receipt
 * from the `modules.lock` entry whose hashes it has just verified, so the check runs against a
 * number a reviewer approved in a pull request rather than against the file itself.
 *
 * A bundled module with *no* receipt is the one exemption, and it is a narrow one — a tree assembled
 * by hand in a checkout rather than by the bundling step. Its bytes are inside the application's own
 * signature, and refusing to start over a missing receipt in a developer's `resources/` directory
 * would be a worse failure than trusting the signature that already covers it.
 */
export function verifyInstalled(
  module: InstalledModule
): { ok: true } | { ok: false; error: string } {
  if (module.receipt === null) {
    if (module.bundled) return { ok: true };
    return {
      ok: false,
      error: `${module.id}: no ${RECEIPT_NAME} beside it — refusing to run files whose hashes were never recorded`,
    };
  }
  for (const file of module.receipt.files) {
    if (!isModuleFileName(file.name)) {
      return {
        ok: false,
        error: `${module.id}: ${RECEIPT_NAME} names an unusable file "${file.name}"`,
      };
    }
    const path = join(module.dir, file.name);
    let got: string;
    try {
      got = sha256File(path);
    } catch {
      return { ok: false, error: `${module.id}: ${file.name} is missing` };
    }
    if (got !== file.sha256) {
      return {
        ok: false,
        error:
          `${module.id}: ${file.name} hashes to ${got.slice(0, 12)}…, the receipt says ` +
          `${file.sha256.slice(0, 12)}… — refusing to run it`,
      };
    }
  }
  return { ok: true };
}

/**
 * Consent to a module and make it reachable: verify, then put its `.js`/`.css` on the
 * `tetravox://module` map and record the consent.
 *
 * Nothing partial survives a failure — a module that fails verification has every entry taken back
 * off the map before the error is returned, so a tampered file cannot leave half a module served.
 */
export function enableModule(id: string): EnableResult {
  const module = installedModule(id);
  if (module === null) return { ok: false, error: `no module ${id} is installed` };
  if (module.hostApi !== MODULE_HOST_VERSION) {
    return {
      ok: false,
      error: `${id} needs Tetravox host API ${module.hostApi}; this build implements ${MODULE_HOST_VERSION}`,
    };
  }
  const verified = verifyInstalled(module);
  if (!verified.ok) return verified;

  unserveModule(id);
  const names =
    module.receipt === null
      ? readdirSync(module.dir).filter((n) => isModuleFileName(n))
      : module.receipt.files.map((f) => f.name);
  const servedNames: string[] = [];
  for (const name of names) {
    if (!SERVABLE.test(name)) continue;
    serveModuleFile(module.id, module.version, name, join(module.dir, name));
    servedNames.push(name);
  }
  if (servedNames.length === 0) {
    unserveModule(id);
    return { ok: false, error: `${id} ships no index.js — there is nothing to load` };
  }
  grantConsent(module);
  refreshInstalledManifests();
  return { ok: true, served: servedNames };
}

/**
 * Withdraw consent: off the protocol map, out of `settings.extensions`, and — the half the renderer
 * is not asked about — its write admissions revoked here, in main.
 */
export function disableModule(id: string): boolean {
  const had = unserveModule(id) > 0 || consents()[id] !== undefined;
  unserveModule(id);
  dropConsent(id);
  revokeModuleWrites(id);
  refreshInstalledManifests();
  return had;
}

/** Disable, then delete the directory. A bundled module is refused: it is not ours to delete. */
export function removeModule(id: string): { ok: true } | { ok: false; error: string } {
  const module = installedModule(id);
  disableModule(id);
  if (module === null) return { ok: true };
  if (module.bundled) {
    return {
      ok: false,
      error: `${id} ships with Tetravox and cannot be removed — disable it instead`,
    };
  }
  rmSync(join(moduleDir(), id), { recursive: true, force: true });
  refreshInstalledManifests();
  return { ok: true };
}

export function revealModuleDir(): void {
  const dir = moduleDir();
  mkdirSync(dir, { recursive: true });
  void shell.openPath(dir);
}

// ------------------------------------------------------------------------------------------------
// Installing
// ------------------------------------------------------------------------------------------------

export type ModuleProgressState = 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';

export interface ModuleProgress {
  id: string;
  file: string;
  received: number;
  total: number;
  state: ModuleProgressState;
  error?: string;
}

/** What the dialog shows per module without touching the network. */
export interface ModuleStatus {
  id: string;
  title: string;
  /** Installed at this version, or null. */
  installed: string | null;
  bundled: boolean;
  /** The installed version's files are on the `tetravox://module` protocol map — it is live. */
  enabled: boolean;
  /** The newest catalogue version this build's host API can run, or null. */
  available: string | null;
  /** `available` is newer than `installed`. */
  updatable: boolean;
  /** Present when the installed manifest names a host API this build does not implement. */
  incompatible?: string;
  /** The derived list the consent sheet shows. Empty when nothing is installed. */
  permissions: string[];
}

export function moduleStatuses(): ModuleStatus[] {
  const installed = installedModules();
  const ids = new Set<string>([...installed.map((m) => m.id), ...catalogue().map((c) => c.id)]);
  const out: ModuleStatus[] = [];
  for (const id of [...ids].sort()) {
    const module = installed.find((m) => m.id === id) ?? null;
    const entry = catalogueEntry(id);
    const newest = entry === null ? null : newestCompatible(entry);
    out.push({
      id,
      title: module?.title ?? entry?.title ?? id,
      installed: module?.version ?? null,
      bundled: module?.bundled ?? false,
      // `enabled` is the **served map**, not the consent record: a module is enabled iff its
      // installed version's files are on the protocol scheme right now. Deriving it from consent-vs-
      // newest-installed made the card lie in two directions — an in-session update left the old
      // version served while the pill went dark, and a consented module whose enable failed at boot
      // (tampered file, incompatible hostApi) showed "Enabled ✓" though nothing was on the map
      // (finding, 2026-08-31).
      enabled: module !== null && servedModuleVersion(id) === module.version,
      available: newest?.version ?? null,
      updatable:
        module !== null && newest !== null && compareVersions(newest.version, module.version) > 0,
      ...(module !== null && module.hostApi !== MODULE_HOST_VERSION
        ? { incompatible: `needs Tetravox host API ${module.hostApi}` }
        : {}),
      permissions: module === null ? [] : derivePermissions(module.manifest),
    });
  }
  return out;
}

/** The one network call, injectable so the download path is unit-tested without a server. */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const defaultFetch: FetchLike = (url, init) => net.fetch(url, init);

/**
 * Download one file into `<moduleDir()>/<id>/<version>/`, verifying its sha256.
 *
 * `.part` then `renameSync`, `sample-data.ts#ensureFile` verbatim: an interrupted install cannot
 * leave half an `index.js` where a whole one is expected, and a mismatch deletes the partial file
 * rather than keeping it around to be found later.
 */
export async function ensureModuleFile(
  id: string,
  version: string,
  file: ExtensionFile,
  opts: { fetchImpl?: FetchLike; signal: AbortSignal; onBytes?: (received: number) => void }
): Promise<string> {
  if (!isModuleFileName(file.name)) throw new Error(`${file.name}: not a usable module file name`);
  if (file.bytes > MAX_MODULE_FILE_BYTES) {
    throw new Error(`${file.name}: ${file.bytes} B is past the ${MAX_MODULE_FILE_BYTES} B ceiling`);
  }
  const dir = join(moduleDir(), id, version);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, file.name);

  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const res = await fetchImpl(file.url, { signal: opts.signal });
  if (!res.ok || res.body === null) {
    throw new Error(`${file.name}: HTTP ${res.status} from ${file.url}`);
  }

  const part = `${target}.part`;
  const hash = createHash('sha256');
  let received = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      received += chunk.length;
      opts.onBytes?.(received);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream),
      tap,
      createWriteStream(part),
      { signal: opts.signal }
    );
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }

  const got = hash.digest('hex');
  if (got !== file.sha256 || received !== file.bytes) {
    rmSync(part, { force: true });
    throw new Error(
      `${file.name}: downloaded ${received} B with sha256 ${got.slice(0, 12)}…, the catalogue says ` +
        `${file.bytes} B / ${file.sha256.slice(0, 12)}… — refusing to install it`
    );
  }
  renameSync(part, target);
  return target;
}

export type InstallResult = { ok: true; version: string } | { ok: false; error: string };

/**
 * Install one catalogue version: every file, verified, then the receipt.
 *
 * The receipt is written **last** and is what makes the directory an installation rather than a
 * pile of files — {@link enableModule} refuses a user-installed module without one, so a run that
 * dies mid-download leaves something inert rather than something enabled.
 *
 * Nothing is consented and nothing is served here. Installing is not enabling.
 */
export async function installModule(
  id: string,
  version: string,
  opts: { fetchImpl?: FetchLike; signal: AbortSignal; onProgress?: (p: ModuleProgress) => void }
): Promise<InstallResult> {
  const entry = catalogueEntry(id);
  if (entry === null) return { ok: false, error: `unknown module ${id}` };
  const wanted = entry.versions.find((v) => v.version === version);
  if (wanted === undefined) return { ok: false, error: `${id} has no version ${version}` };
  if (wanted.hostApi !== MODULE_HOST_VERSION) {
    return {
      ok: false,
      error: `${id} ${version} needs Tetravox host API ${wanted.hostApi}; this build implements ${MODULE_HOST_VERSION}`,
    };
  }
  if (!wanted.files.some((f) => f.name === 'manifest.json')) {
    return { ok: false, error: `${id} ${version} ships no manifest.json` };
  }

  const total = wanted.files.reduce((n, f) => n + f.bytes, 0);
  let before = 0;
  const report = (
    file: string,
    state: ModuleProgressState,
    received: number,
    error?: string
  ): void =>
    opts.onProgress?.({
      id,
      file,
      received: before + received,
      total,
      state,
      ...(error === undefined ? {} : { error }),
    });

  for (const file of wanted.files) {
    report(file.name, 'downloading', 0);
    try {
      await ensureModuleFile(id, version, file, {
        signal: opts.signal,
        onBytes: (n) => report(file.name, 'downloading', n),
        ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      });
    } catch (err) {
      const aborted = opts.signal.aborted;
      report(file.name, aborted ? 'cancelled' : 'error', 0, aborted ? undefined : String(err));
      return { ok: false, error: aborted ? 'cancelled' : String(err) };
    }
    before += file.bytes;
  }

  report('', 'verifying', total);
  const dir = join(moduleDir(), id, version);
  const read = readModuleAt(dir, false);
  if (read === null || read.id !== id || read.version !== version) {
    rmSync(dir, { recursive: true, force: true });
    const error = `${id} ${version}: its manifest.json is not a valid module manifest for ${id}@${version}`;
    report('manifest.json', 'error', total, error);
    return { ok: false, error };
  }
  if (read.hostApi !== wanted.hostApi) {
    rmSync(dir, { recursive: true, force: true });
    const error = `${id} ${version}: the catalogue says hostApi ${wanted.hostApi}, the manifest says ${read.hostApi}`;
    report('manifest.json', 'error', total, error);
    return { ok: false, error };
  }

  const receipt: InstallReceipt = {
    schema: 1,
    id,
    version,
    installedAt: new Date().toISOString(),
    files: wanted.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
  };
  writeFileSync(join(dir, RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`);

  // An update over an enabled module must not leave the previous version live. Installing is not
  // enabling, but the newly-installed version is now the newest of its id, so the card flips to
  // "Enable" (its consent no longer matches) — and without this the old version's files would stay
  // on the protocol map and its Save-sheet write admissions would stay honoured, a module the user
  // sees as inert still running with capability they believe was withdrawn. So when a *different*
  // version is currently served or consented, take it off the map, revoke its writes and drop its
  // stale consent, leaving the id in the same inert, must-re-consent state the card advertises
  // (finding, 2026-08-31).
  const servedVersion = servedModuleVersion(id);
  const consentVersion = consents()[id]?.version;
  if (
    (servedVersion !== null && servedVersion !== version) ||
    (consentVersion !== undefined && consentVersion !== version)
  ) {
    unserveModule(id);
    revokeModuleWrites(id);
    dropConsent(id);
  }

  refreshInstalledManifests();
  report('', 'done', total);
  return { ok: true, version };
}

/** One in-flight install per module; a second request for the same id joins it. */
const inflight = new Map<string, { controller: AbortController; done: Promise<InstallResult> }>();

export function startInstall(
  id: string,
  version: string,
  onProgress: (p: ModuleProgress) => void,
  fetchImpl?: FetchLike
): Promise<InstallResult> {
  const existing = inflight.get(id);
  if (existing !== undefined) return existing.done;
  const controller = new AbortController();
  const done = installModule(id, version, {
    signal: controller.signal,
    onProgress,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  }).finally(() => inflight.delete(id));
  inflight.set(id, { controller, done });
  return done;
}

export function cancelInstall(id: string): boolean {
  const entry = inflight.get(id);
  if (entry === undefined) return false;
  entry.controller.abort();
  return true;
}

// ------------------------------------------------------------------------------------------------
// Startup
// ------------------------------------------------------------------------------------------------

/**
 * Hand `manifests.ts` every installed manifest — consented or not.
 *
 * Not only the consented ones, deliberately. `manifestFor` answers a *naming* question ("what is
 * this module called?") that the layer badges and the toasts ask about modules that are merely
 * installed, and `validateJob` needs to find the manifest in order to say "installed but not
 * enabled" rather than the much worse "no such module". Consent is checked where it bites — the
 * protocol map, and the job validator's own gate — never by hiding the name.
 */
export function refreshInstalledManifests(): readonly InstalledManifest[] {
  const list = installedModules().map((m) => m.manifest);
  registerInstalledManifests(list);
  return list;
}

/**
 * Everything that has to happen before `prepareJob` parses a job file (§13.6): the installed set is
 * read, bundled modules are pre-consented, and every consented module is verified and served.
 *
 * Called once from `main/index.ts` at module scope — **before** `prepareJob`, because a job naming a
 * module has to be validated against the manifests this launch actually carries, and after
 * `whenReady` would be far too late.
 */
export function bootstrapInstalledModules(): void {
  const installed = refreshInstalledManifests();
  const modules = installedModules();
  for (const module of modules) {
    if (module.bundled && consents()[module.id]?.version !== module.version) grantConsent(module);
  }
  for (const module of modules) {
    if (!isModuleConsented(module.id)) continue;
    const enabled = enableModule(module.id);
    if (!enabled.ok) console.log(`[tetravox] extension ${module.id} not enabled: ${enabled.error}`);
  }
  if (installed.length > 0) {
    console.log(
      `[tetravox] extensions: ${modules.map((m) => `${m.id}@${m.version}`).join(', ')} ` +
        `(${servedModuleKeys().length} files served)`
    );
  }
}

/** Test seam: forget everything this process learned about installed modules. */
export function resetModuleStore(): void {
  inflight.clear();
  registerInstalledManifests([]);
}

/**
 * What the five state-changing channels answer with: whether it worked, why not, and the refreshed
 * card states — so the dialog never has to make a second round trip to find out what it now shows.
 */
export interface ModuleActionResult {
  ok: boolean;
  error?: string;
  statuses: ModuleStatus[];
}

function withStatuses(result: { ok: true } | { ok: false; error: string }): ModuleActionResult {
  return {
    ok: result.ok,
    ...(result.ok ? {} : { error: result.error }),
    statuses: moduleStatuses(),
  };
}

/** `tetravox:module-enable` — consent, verify, serve. */
export function enableModuleAction(id: unknown): ModuleActionResult {
  if (typeof id !== 'string' || id === '') {
    return { ok: false, error: 'not a module id', statuses: moduleStatuses() };
  }
  const enabled = enableModule(id);
  return withStatuses(enabled.ok ? { ok: true } : { ok: false, error: enabled.error });
}

/** `tetravox:module-disable` — withdraw consent, unserve, revoke the write list. */
export function disableModuleAction(id: unknown): ModuleActionResult {
  if (typeof id !== 'string' || id === '') {
    return { ok: false, error: 'not a module id', statuses: moduleStatuses() };
  }
  disableModule(id);
  return withStatuses({ ok: true });
}

/** `tetravox:module-remove` — disable, then delete the directory. */
export function removeModuleAction(id: unknown): ModuleActionResult {
  if (typeof id !== 'string' || id === '') {
    return { ok: false, error: 'not a module id', statuses: moduleStatuses() };
  }
  return withStatuses(removeModule(id));
}

/** `tetravox:module-install` — download and verify. Installing is not enabling. */
export async function installModuleAction(
  id: unknown,
  version: unknown,
  onProgress: (p: ModuleProgress) => void,
  fetchImpl?: FetchLike
): Promise<ModuleActionResult> {
  if (typeof id !== 'string' || id === '') {
    return { ok: false, error: 'not a module id', statuses: moduleStatuses() };
  }
  const entry = catalogueEntry(id);
  const wanted =
    typeof version === 'string' && version !== ''
      ? version
      : ((entry === null ? null : newestCompatible(entry)?.version) ?? null);
  if (wanted === null) {
    return {
      ok: false,
      error: `${id} has no version this build can run`,
      statuses: moduleStatuses(),
    };
  }
  const result = await startInstall(id, wanted, onProgress, fetchImpl);
  return withStatuses(result.ok ? { ok: true } : { ok: false, error: result.error });
}
