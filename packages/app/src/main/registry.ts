/**
 * The live extensions catalogue (§13.8, 2026-08-31).
 *
 * The catalogue is what File ▸ Extensions… offers and — through each file's `sha256` — what an
 * install is verified against. Until now it was **only** the copy the build ships
 * (`src/shared/extensions-index.json`), which made an extension release invisible until a *core*
 * release carried a refreshed copy: publishing a one-line fix to an extension meant cutting a
 * Tetravox. This module adds the missing half — the curated index fetched from its own repository —
 * and leaves the shipped copy as the floor, so the dialog is still correct with no network at all.
 *
 * **Precedence** (`module-store.ts#catalogue`): the dev/E2E `TETRAVOX_EXT_INDEX` seam, then the
 * cache this module writes, then the shipped copy. A fetch that fails, times out, answers a
 * non-200, exceeds {@link MAX_INDEX_BYTES} or does not validate changes nothing: the previous
 * answer stands. Nothing here downloads an extension or grants anything — a catalogue entry is an
 * *offer*, and install, consent and enable are unchanged and still the user's clicks.
 *
 * **What the fetch is trusted for, stated plainly.** The shipped copy is reviewed in a pull request
 * and rides inside the signed application; a fetched one is whatever `idossha/tetravox-extensions`
 * serves over HTTPS. That is the same trust already placed in the extension's own repository, whose
 * release assets the entry points at — but it is a real widening, so it is bounded here rather than
 * assumed:
 *
 *  * {@link validateIndex} is stricter than the shipped reader: every id, version, byte count and
 *    hash is shape-checked, and every `url` must be **https on a GitHub host**, so an index that
 *    arrived over the wire cannot point the downloader at an arbitrary server.
 *  * The response is capped and abandoned after {@link FETCH_TIMEOUT_MS}.
 *  * The cache lives in `userData`, beside `settings.json`, and is re-validated on every read — a
 *    hand-edited cache is refused exactly as a bad response is.
 *  * `hostApi` still gates what can run, the consent sheet still shows the *installed* manifest's
 *    derived permissions, and `module-store.ts` still re-hashes every file before serving it.
 */

import { app, net } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The curated index, in the repository that owns it. `main` is its published branch. */
export const REGISTRY_URL =
  'https://raw.githubusercontent.com/idossha/tetravox-extensions/main/index.json';

/** A catalogue is a page of text: a megabyte of it is a bug or an attack. */
export const MAX_INDEX_BYTES = 512 * 1024;

/** Long enough for a slow link, short enough that a launch refresh is never noticed. */
export const FETCH_TIMEOUT_MS = 15_000;

/** The hosts a fetched entry may point at. GitHub releases are where extensions publish. */
const ALLOWED_FILE_HOSTS = new Set(['github.com', 'objects.githubusercontent.com']);

/** `module-store.ts`'s own seam, duplicated in shape so this file imports nothing from it. */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const defaultFetch: FetchLike = (url, init) => net.fetch(url, init);

/** Where the fetched copy is kept: app-managed data, per profile, never the user's config. */
export function cachePath(): string {
  return join(app.getPath('userData'), 'extensions-index.json');
}

/**
 * Every rule a fetched index must satisfy, in one place.
 *
 * Deliberately stricter than the shipped reader (`module-store.ts#readIndexFile`, which only asks
 * that `modules` is an array): that file is reviewed and signed, and this one is not.
 */
export function validateIndex(raw: unknown): { modules: unknown[] } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const index = raw as { modules?: unknown };
  if (!Array.isArray(index.modules)) return null;
  for (const entry of index.modules) {
    if (entry === null || typeof entry !== 'object') return null;
    const module = entry as { id?: unknown; title?: unknown; versions?: unknown };
    if (typeof module.id !== 'string' || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(module.id)) {
      return null;
    }
    if (typeof module.title !== 'string' || module.title === '') return null;
    if (!Array.isArray(module.versions) || module.versions.length === 0) return null;
    for (const candidate of module.versions) {
      if (candidate === null || typeof candidate !== 'object') return null;
      const version = candidate as { version?: unknown; hostApi?: unknown; files?: unknown };
      if (typeof version.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+/.test(version.version)) {
        return null;
      }
      if (typeof version.hostApi !== 'number' || !Number.isInteger(version.hostApi)) return null;
      if (!Array.isArray(version.files) || version.files.length === 0) return null;
      for (const item of version.files) {
        if (item === null || typeof item !== 'object') return null;
        const file = item as { name?: unknown; bytes?: unknown; sha256?: unknown; url?: unknown };
        if (typeof file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(file.name)) {
          return null;
        }
        if (file.name.includes('..')) return null;
        if (typeof file.bytes !== 'number' || !Number.isInteger(file.bytes) || file.bytes < 0) {
          return null;
        }
        if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) return null;
        if (typeof file.url !== 'string') return null;
        // The load-bearing one: an index that came over the wire may not redirect the downloader
        // somewhere else. HTTPS, and a host that publishes releases.
        let parsed: URL;
        try {
          parsed = new URL(file.url);
        } catch {
          return null;
        }
        if (parsed.protocol !== 'https:' || !ALLOWED_FILE_HOSTS.has(parsed.hostname)) return null;
      }
    }
  }
  return index as { modules: unknown[] };
}

/** The cached copy, or null when there is none, it does not parse, or it does not validate. */
export function cachedIndex(): { modules: unknown[] } | null {
  try {
    const text = readFileSync(cachePath(), 'utf8');
    if (text.length > MAX_INDEX_BYTES) return null;
    return validateIndex(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * Fetch the curated index and cache it. Answers `true` only when a new, valid copy was written.
 *
 * Never throws and never partially writes: a bad response leaves the previous cache — and therefore
 * the previous catalogue — exactly as it was.
 */
export async function refreshCatalogue(
  opts: { fetchImpl?: FetchLike; url?: string } = {}
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await (opts.fetchImpl ?? defaultFetch)(opts.url ?? REGISTRY_URL, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    // The timer stays armed across the body read: `net.fetch` resolves at the headers, and a body
    // that stalls after them would otherwise hang this promise (the same shape as the updater's
    // notify-mode read, finding 2026-08-31).
    const text = await response.text();
    if (text.length > MAX_INDEX_BYTES) return false;
    const index = validateIndex(JSON.parse(text) as unknown);
    if (index === null) return false;
    writeFileSync(cachePath(), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One in-flight refresh per process: the launch check and an Extensions… open in the same second
 * ask the same question, and the second should join the first rather than fetch again.
 */
let inflight: Promise<boolean> | null = null;

export function refreshCatalogueOnce(
  opts: { fetchImpl?: FetchLike; url?: string } = {}
): Promise<boolean> {
  // The gate lives here rather than at each call site, so "when does Tetravox talk to the registry"
  // has one answer. An injected `fetchImpl` is a test driving the real code and is always allowed.
  if (opts.fetchImpl === undefined && !registryFetchAllowed()) return Promise.resolve(false);
  if (inflight !== null) return inflight;
  inflight = refreshCatalogue(opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Test seam: forget the in-flight refresh. */
export function resetRegistry(): void {
  inflight = null;
}

/**
 * Whether this launch may reach the registry at all.
 *
 * **Packaged builds only**, which is §12.4's rule for the app's own update check (`updateMode`
 * answers `'off'` for a dev tree) applied to the same question about extensions — and it is what
 * keeps the suites hermetic: `pnpm e2e` drives the dev target, so without this every launch in
 * every spec would reach raw.githubusercontent.com and a green run would depend on GitHub being up.
 * The `TETRAVOX_EXT_INDEX` fixture also wins outright: a spec that staged a catalogue is asking for
 * that catalogue, not for whatever the registry serves today.
 */
export function registryFetchAllowed(): boolean {
  if (!app.isPackaged) return false;
  if (process.env['TETRAVOX_E2E'] === '1') return false;
  const seam = process.env['TETRAVOX_EXT_INDEX'];
  return seam === undefined || seam === '';
}
