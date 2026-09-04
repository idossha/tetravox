/**
 * The live extensions catalogue (§13.8): the policy, not the plumbing.
 *
 * `module-store.test.ts`'s doctrine — every assertion is a **refusal or an admission**, because that
 * is the feature. A fetched index decides what the dialog offers and what an install is verified
 * against, so what matters is which ones are refused: a non-200, an oversized body, a shape that
 * does not validate, a hash that is not a hash, and — the one this file exists for — a `url` that
 * points somewhere other than a GitHub release. No network: every fetch goes through the injected
 * `fetchImpl`, exactly as `sample-data.test.ts` and `module-store.test.ts` do.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ home: '', appPath: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (): string => dirs.home,
    getAppPath: (): string => dirs.appPath,
    isPackaged: false,
  },
  net: { fetch: async (): Promise<Response> => new Response(null, { status: 404 }) },
  shell: { openPath: async (): Promise<string> => '' },
  protocol: { registerSchemesAsPrivileged: (): void => {}, handle: (): void => {} },
  dialog: {},
  ipcMain: { handle: (): void => {}, on: (): void => {} },
  BrowserWindow: class {},
}));

import { catalogue, mergeCatalogue, newestCompatible } from './module-store';
import {
  MAX_INDEX_BYTES,
  cachePath,
  cachedIndex,
  refreshCatalogue,
  refreshCatalogueOnce,
  registryFetchAllowed,
  resetRegistry,
  validateIndex,
} from './registry';

/** A minimal well-formed entry — the shape the registry really publishes. */
function entry(
  over: { id?: string; version?: string; url?: string; sha256?: string } = {}
): object {
  return {
    id: over.id ?? 'vendor.thing',
    title: 'Thing',
    versions: [
      {
        version: over.version ?? '2.0.0',
        hostApi: 1,
        files: [
          {
            name: 'index.js',
            bytes: 10,
            sha256: over.sha256 ?? 'a'.repeat(64),
            url:
              over.url ??
              `https://github.com/idossha/tetravox-seeg/releases/download/v2.0.0/${'a'.repeat(64)}`,
          },
        ],
      },
    ],
  };
}

function indexOf(...entries: object[]): object {
  return { schema: 1, modules: entries };
}

function serve(body: string, status = 200): typeof fetchStub {
  const fetchStub = async (): Promise<Response> =>
    ({ ok: status >= 200 && status < 300, status, text: async () => body }) as unknown as Response;
  return fetchStub;
}

beforeEach(() => {
  dirs.home = mkdtempSync(join(tmpdir(), 'tvx-registry-home-'));
  dirs.appPath = mkdtempSync(join(tmpdir(), 'tvx-registry-app-'));
  process.env['TETRAVOX_HOME'] = dirs.home;
  delete process.env['TETRAVOX_EXT_INDEX'];
  resetRegistry();
});

afterEach(() => {
  delete process.env['TETRAVOX_HOME'];
  rmSync(dirs.home, { recursive: true, force: true });
  rmSync(dirs.appPath, { recursive: true, force: true });
});

describe('validateIndex', () => {
  it('accepts the shape the registry publishes', () => {
    expect(validateIndex(indexOf(entry()))).not.toBeNull();
  });

  it.each([
    ['not an object', 42],
    ['no modules array', { schema: 1 }],
    ['an id that is not <vendor>.<name>', indexOf(entry({ id: 'thing' }))],
    ['a version that is not semver', indexOf(entry({ version: 'latest' }))],
    ['a sha256 that is not one', indexOf(entry({ sha256: 'nope' }))],
  ])('refuses %s', (_name, raw) => {
    expect(validateIndex(raw)).toBeNull();
  });

  it('refuses a file url that is not https on a GitHub host — the one an attacker would want', () => {
    // A fetched index that could name any host would turn a catalogue refresh into "download from
    // wherever I say". The hash still has to match, but the hash is in the same document.
    expect(
      validateIndex(indexOf(entry({ url: 'http://github.com/a/b/releases/download/v1/x' })))
    ).toBeNull();
    expect(validateIndex(indexOf(entry({ url: 'https://evil.example/x' })))).toBeNull();
    expect(validateIndex(indexOf(entry({ url: 'https://github.com.evil.example/x' })))).toBeNull();
    expect(
      validateIndex(indexOf(entry({ url: 'https://objects.githubusercontent.com/ok' })))
    ).not.toBeNull();
  });

  it('refuses a file name that could climb out of its directory', () => {
    const bad = indexOf(entry()) as { modules: { versions: { files: { name: string }[] }[] }[] };
    bad.modules[0]!.versions[0]!.files[0]!.name = '../evil.js';
    expect(validateIndex(bad)).toBeNull();
  });
});

describe('refreshCatalogue', () => {
  it('writes the cache when the answer is good', async () => {
    const ok = await refreshCatalogue({ fetchImpl: serve(JSON.stringify(indexOf(entry()))) });
    expect(ok).toBe(true);
    expect(cachedIndex()).not.toBeNull();
  });

  it.each([
    ['a non-200', serve('{}', 500)],
    ['a body that is not JSON', serve('<html>nope</html>')],
    ['an index that does not validate', serve(JSON.stringify(indexOf(entry({ id: 'nope' }))))],
    ['an oversized body', serve(JSON.stringify(indexOf(entry())) + ' '.repeat(MAX_INDEX_BYTES))],
  ])('leaves the previous answer standing on %s', async (_name, impl) => {
    // A good copy first, so "unchanged" is a claim with something to lose.
    expect(await refreshCatalogue({ fetchImpl: serve(JSON.stringify(indexOf(entry()))) })).toBe(
      true
    );
    const before = readFileSync(cachePath(), 'utf8');
    expect(await refreshCatalogue({ fetchImpl: impl })).toBe(false);
    expect(readFileSync(cachePath(), 'utf8')).toBe(before);
  });

  it('answers false rather than throwing when the fetch itself fails', async () => {
    const boom = async (): Promise<Response> => {
      throw new Error('ENOTFOUND raw.githubusercontent.com');
    };
    expect(await refreshCatalogue({ fetchImpl: boom })).toBe(false);
    expect(cachedIndex()).toBeNull();
  });

  it('coalesces concurrent refreshes into one request', async () => {
    let calls = 0;
    const counting = async (): Promise<Response> => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(indexOf(entry())),
      } as unknown as Response;
    };
    await Promise.all([
      refreshCatalogueOnce({ fetchImpl: counting }),
      refreshCatalogueOnce({ fetchImpl: counting }),
    ]);
    expect(calls).toBe(1);
  });
});

describe('when Tetravox may reach the registry at all', () => {
  it('never in a dev tree, which is what keeps `pnpm e2e` hermetic', async () => {
    // `app.isPackaged` is false in this mock, as it is for every dev launch and every e2e run. A
    // refresh with no injected fetch must therefore not touch the network — the suites would
    // otherwise depend on raw.githubusercontent.com being up.
    expect(registryFetchAllowed()).toBe(false);
    expect(await refreshCatalogueOnce()).toBe(false);
    expect(cachedIndex()).toBeNull();
  });

  it('an injected fetch is a test driving the real code, and is always allowed', async () => {
    expect(await refreshCatalogueOnce({ fetchImpl: serve(JSON.stringify(indexOf(entry()))) })).toBe(
      true
    );
  });
});

describe('cachedIndex', () => {
  it('refuses a hand-edited cache, so a local file cannot widen what the app offers', () => {
    writeFileSync(cachePath(), JSON.stringify(indexOf(entry({ url: 'https://evil.example/x' }))));
    expect(cachedIndex()).toBeNull();
  });

  it('refuses an unparseable cache rather than throwing', () => {
    writeFileSync(cachePath(), '{ not json');
    expect(cachedIndex()).toBeNull();
  });
});

describe('what the catalogue answers with — the union (§13.8)', () => {
  /** The shipped floor, read through the same door the dialog uses. */
  function shippedSeeg(): { versions: { version: string }[] } {
    const found = catalogue().find((m) => m.id === 'tetravox.seeg');
    if (found === undefined) throw new Error('the build ships no tetravox.seeg');
    return found;
  }

  it('adds a live-only id without disturbing the shipped ones — an extension release, no core release', async () => {
    const before = shippedSeeg().versions.map((v) => v.version);
    expect(await refreshCatalogue({ fetchImpl: serve(JSON.stringify(indexOf(entry()))) })).toBe(
      true
    );
    expect(catalogue().some((m) => m.id === 'vendor.thing')).toBe(true);
    // …and the shipped id is untouched: a live index is a floor-raiser, never a replacement.
    expect(shippedSeeg().versions.map((v) => v.version)).toEqual(before);
  });

  it('does not hide a shipped id the live index has never heard of', async () => {
    expect(await refreshCatalogue({ fetchImpl: serve(JSON.stringify(indexOf(entry()))) })).toBe(
      true
    );
    expect(catalogue().some((m) => m.id === 'tetravox.seeg')).toBe(true);
  });

  it('adds a newer live version to an id both know, and it becomes the newest', async () => {
    const live = entry({ id: 'tetravox.seeg', version: '9.9.9' });
    expect(await refreshCatalogue({ fetchImpl: serve(JSON.stringify(indexOf(live))) })).toBe(true);
    const seeg = catalogue().find((m) => m.id === 'tetravox.seeg');
    if (seeg === undefined) throw new Error('merged away');
    expect(seeg.versions.map((v) => v.version)).toContain('9.9.9');
    expect(newestCompatible(seeg)?.version).toBe('9.9.9');
  });

  it('lets the live index re-release a version the build ships — one entry, the live bytes', async () => {
    const shippedNewest = shippedSeeg().versions.at(-1);
    if (shippedNewest === undefined) throw new Error('no shipped version');
    // A re-tag after a bad build is the operation this must not break (tetravox.seeg 0.2.2): the
    // registry is already trusted to publish new versions, so pinning the shipped bytes would buy
    // no security and would strand every user of this build on the broken ones.
    const live = entry({
      id: 'tetravox.seeg',
      version: shippedNewest.version,
      sha256: 'b'.repeat(64),
    });
    expect(await refreshCatalogue({ fetchImpl: serve(JSON.stringify(indexOf(live))) })).toBe(true);
    const seeg = catalogue().find((m) => m.id === 'tetravox.seeg');
    const collided = seeg?.versions.filter((v) => v.version === shippedNewest.version);
    // Exactly one copy of that version, not two…
    expect(collided?.length).toBe(1);
    // …and it is the live one.
    expect(collided?.[0]?.files[0]?.sha256).toBe('b'.repeat(64));
  });

  it('falls back to the shipped copy when the cache is bad, never to nothing', () => {
    writeFileSync(cachePath(), '{ not json');
    expect(catalogue().some((m) => m.id === 'tetravox.seeg')).toBe(true);
    expect(catalogue().some((m) => m.id === 'vendor.thing')).toBe(false);
  });

  it('lets the dev/E2E seam win over both, so a fixture run is not raced by the network', async () => {
    expect(await refreshCatalogue({ fetchImpl: serve(JSON.stringify(indexOf(entry()))) })).toBe(
      true
    );
    const fixture = join(dirs.appPath, 'fixture-index.json');
    writeFileSync(fixture, JSON.stringify(indexOf(entry({ id: 'fixture.only' }))));
    process.env['TETRAVOX_EXT_INDEX'] = fixture;
    // Unchanged by the union: the seam is the *whole* catalogue, not a third thing to merge.
    expect(catalogue().map((m) => m.id)).toEqual(['fixture.only']);
  });
});

describe('mergeCatalogue', () => {
  const v = (
    version: string,
    sha: string
  ): { version: string; hostApi: number; files: object[] } => ({
    version,
    hostApi: 1,
    files: [{ name: 'index.js', bytes: 1, sha256: sha, url: 'https://github.com/x/y' }],
  });
  const mod = (id: string, title: string, versions: object[]): object => ({
    id,
    title,
    summary: `${title} summary`,
    versions,
  });

  it('orders versions ascending by semver whichever side they came from', () => {
    const merged = mergeCatalogue(
      [mod('a.b', 'A', [v('0.2.0', 'a'), v('0.1.0', 'a')])] as never,
      [mod('a.b', 'A', [v('0.10.0', 'a'), v('0.3.0', 'a')])] as never
    );
    expect(merged[0]?.versions.map((x) => x.version)).toEqual([
      '0.1.0',
      '0.2.0',
      '0.3.0',
      '0.10.0',
    ]);
  });

  it('takes presentation from the live entry — cosmetic fields are not a trust input', () => {
    const merged = mergeCatalogue(
      [mod('a.b', 'Old title', [v('1.0.0', 'a')])] as never,
      [mod('a.b', 'New title', [v('1.0.0', 'b')])] as never
    );
    expect(merged[0]?.title).toBe('New title');
    expect(merged[0]?.summary).toBe('New title summary');
  });

  it('logs a re-pointed version rather than resolving it silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mergeCatalogue(
      [mod('a.b', 'A', [v('1.0.0', 'a'.repeat(64))])] as never,
      [mod('a.b', 'A', [v('1.0.0', 'b'.repeat(64))])] as never
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a.b 1.0.0'));
    warn.mockRestore();
  });

  it('says nothing when the two agree about a version', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mergeCatalogue(
      [mod('a.b', 'A', [v('1.0.0', 'a'.repeat(64))])] as never,
      [mod('a.b', 'A', [v('1.0.0', 'a'.repeat(64))])] as never
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('answers the shipped catalogue unchanged for an empty live index', () => {
    const shipped = [mod('a.b', 'A', [v('1.0.0', 'a')])] as never;
    expect(mergeCatalogue(shipped, [])).toEqual(shipped);
  });
});
