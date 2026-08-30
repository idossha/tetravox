/**
 * Sample Data (§8): the catalogue is well-formed, and the download path verifies what it writes.
 *
 * No network: `ensureFile` takes a `fetchImpl`, and every case here hands it a `Response` built from
 * bytes in memory. The cache lives in a temp directory through `TETRAVOX_SAMPLE_DIR`, the same knob
 * the E2E uses, so `app.getPath` is never consulted.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
  shell: { openPath: async () => '' },
}));

import {
  cancelSample,
  catalogue,
  ensureFile,
  fetchSample,
  samplePath,
  sampleStatuses,
  startSample,
  type Sample,
  type SampleFile,
  type SampleProgress,
} from './sample-data';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tvx-sample-'));
  process.env['TETRAVOX_SAMPLE_DIR'] = dir;
});
afterAll(() => {
  delete process.env['TETRAVOX_SAMPLE_DIR'];
  rmSync(dir, { recursive: true, force: true });
});

const bytesA = new TextEncoder().encode('a small volume\n');
const bytesB = new TextEncoder().encode('its lookup table\n');

function sample(files: SampleFile[], id = 'unit'): Sample {
  return {
    id,
    title: 'Unit',
    group: 'Tests',
    description: '',
    thumbnail: 'ernie-t1',
    source: '',
    sourceUrl: '',
    licence: 'MIT',
    files,
  };
}

const fileA: SampleFile = {
  name: 'vol.nii.gz',
  bytes: bytesA.length,
  sha256: sha(bytesA),
  url: 'https://store/a',
};
const fileB: SampleFile = {
  name: 'vol_LUT.txt',
  bytes: bytesB.length,
  sha256: sha(bytesB),
  url: 'https://store/b',
};

const serve =
  (table: Record<string, Uint8Array>, calls: string[] = []) =>
  async (url: string): Promise<Response> => {
    calls.push(url);
    const body = table[url];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  };

describe('the catalogue', () => {
  it('is content-addressed and internally consistent', () => {
    const ids = new Set<string>();
    for (const s of catalogue()) {
      expect(ids.has(s.id), `duplicate id ${s.id}`).toBe(false);
      ids.add(s.id);
      expect(s.files.length).toBeGreaterThan(0);
      expect(s.licence).not.toBe('');
      expect(s.sourceUrl).toMatch(/^https:\/\//);
      const names = new Set<string>();
      for (const f of s.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes).toBeGreaterThan(0);
        expect(names.has(f.name), `${s.id}: ${f.name} twice`).toBe(false);
        names.add(f.name);
        // A store URL *is* the hash; anything else must at least be https.
        if (f.url.includes('/tetravox-sample-data/')) {
          expect(f.url.endsWith(`/SHA256/${f.sha256}`), `${s.id}/${f.name} url`).toBe(true);
        } else {
          expect(f.url).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it('keeps every sidecar next to the file it belongs to', () => {
    for (const s of catalogue()) {
      const names = s.files.map((f) => f.name);
      for (const lut of names.filter((n) => n.endsWith('_LUT.txt'))) {
        const stem = lut.slice(0, -'_LUT.txt'.length);
        expect(
          names.some((n) => n !== lut && n.startsWith(stem)),
          `${s.id}: ${lut} has no volume`
        ).toBe(true);
      }
    }
  });

  it('has a thumbnail for every sample', () => {
    for (const s of catalogue()) {
      expect(
        existsSync(join(__dirname, '../renderer/src/assets/samples', `${s.thumbnail}.jpg`)),
        s.id
      ).toBe(true);
    }
  });
});

describe('ensureFile', () => {
  it('downloads, verifies and renames into place', async () => {
    const s = sample([fileA]);
    const path = await ensureFile(s, fileA, {
      fetchImpl: serve({ [fileA.url]: bytesA }),
      signal: new AbortController().signal,
    });
    expect(path).toBe(samplePath(s, fileA));
    expect(readFileSync(path)).toEqual(Buffer.from(bytesA));
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it('keeps a cached file that verifies and never fetches it again', async () => {
    const s = sample([fileA]);
    const calls: string[] = [];
    await ensureFile(s, fileA, {
      fetchImpl: serve({ [fileA.url]: bytesA }, calls),
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([]);
  });

  it('re-downloads a cached file whose bytes no longer match', async () => {
    const s = sample([fileA], 'stale');
    const path = samplePath(s, fileA);
    await ensureFile(s, fileA, {
      fetchImpl: serve({ [fileA.url]: bytesA }),
      signal: new AbortController().signal,
    });
    // Same length, different content: the size check passes, the hash does not.
    writeFileSync(path, 'A SMALL VOLUME\n');
    const calls: string[] = [];
    await ensureFile(s, fileA, {
      fetchImpl: serve({ [fileA.url]: bytesA }, calls),
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([fileA.url]);
    expect(readFileSync(path)).toEqual(Buffer.from(bytesA));
  });

  it('refuses a download whose hash is wrong and leaves nothing behind', async () => {
    const s = sample([fileA], 'bad');
    await expect(
      ensureFile(s, fileA, {
        fetchImpl: serve({ [fileA.url]: bytesB }),
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/refusing to open/);
    expect(existsSync(samplePath(s, fileA))).toBe(false);
    expect(existsSync(`${samplePath(s, fileA)}.part`)).toBe(false);
  });

  it('reports a non-2xx response by name', async () => {
    const s = sample([fileA], 'missing');
    await expect(
      ensureFile(s, fileA, { fetchImpl: serve({}), signal: new AbortController().signal })
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('fetchSample', () => {
  it('walks the files in order with cumulative progress, then reports done', async () => {
    const s = sample([fileA, fileB], 'pair');
    const seen: SampleProgress[] = [];
    const paths = await fetchSample(s, {
      fetchImpl: serve({ [fileA.url]: bytesA, [fileB.url]: bytesB }),
      signal: new AbortController().signal,
      onProgress: (p) => seen.push(p),
    });
    expect(paths).toEqual([samplePath(s, fileA), samplePath(s, fileB)]);
    const total = bytesA.length + bytesB.length;
    expect(seen.every((p) => p.total === total)).toBe(true);
    expect(seen[seen.length - 1]).toMatchObject({ state: 'done', received: total });
    const verifying = seen.filter((p) => p.state === 'verifying').map((p) => p.received);
    expect(verifying).toEqual([bytesA.length, total]);
    expect(sampleStatuses().find((st) => st.id === 'pair')).toBeUndefined(); // not in the catalogue
  });

  it('marks an abort as cancelled, not as an error', async () => {
    const s = sample([fileA], 'abort');
    const ctl = new AbortController();
    const slow = async (): Promise<Response> => {
      ctl.abort();
      return new Response(bytesA);
    };
    const seen: SampleProgress[] = [];
    await expect(
      fetchSample(s, { fetchImpl: slow, signal: ctl.signal, onProgress: (p) => seen.push(p) })
    ).rejects.toBeDefined();
    expect(seen[seen.length - 1]?.state).toBe('cancelled');
  });
});

describe('startSample / cancelSample', () => {
  it('joins a second request for the same id and can be cancelled', async () => {
    const s = sample([fileA], 'inflight');
    let release: (() => void) | null = null;
    const gated = (): Promise<Response> =>
      new Promise((resolve) => {
        release = () => resolve(new Response(bytesA));
      });
    const first = startSample(s, () => {}, gated);
    const second = startSample(s, () => {}, gated);
    expect(second).toBe(first);
    expect(cancelSample('inflight')).toBe(true);
    (release as unknown as () => void)();
    await expect(first).rejects.toBeDefined();
    expect(cancelSample('inflight')).toBe(false);
  });
});
