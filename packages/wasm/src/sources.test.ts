/**
 * `readStream`'s §5 rule 4 behaviour: `.gz` by name, gzip magic by fact.
 *
 * The double-decode case is not hypothetical — any transport that answers
 * `content-encoding: gzip` for a `.nii.gz` hands `fetch` an already-inflated body, and piping that
 * into `DecompressionStream('gzip')` fails on perfectly good data.
 */

import { describe, expect, it, vi } from 'vitest';

import { loadSource, readStream, sourceName } from './sources';

function stream(bytes: Uint8Array, chunk = 7): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(at, Math.min(at + chunk, bytes.length)));
      at += chunk;
    },
  });
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const out = new Response(
    stream(bytes).pipeThrough(
      new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
    )
  );
  return new Uint8Array(await out.arrayBuffer());
}

const PAYLOAD = new Uint8Array(4096).map((_, i) => (i * 31) & 0xff);

describe('readStream (§5 rule 4)', () => {
  it('inflates a .gz whose bytes really are gzip', async () => {
    const got = await readStream('T1.nii.gz', stream(await gzip(PAYLOAD)), 0);
    expect(got).toEqual(PAYLOAD);
  });

  it('passes a .gz through untouched when the transport already decoded it', async () => {
    const got = await readStream('T1.nii.gz', stream(PAYLOAD), PAYLOAD.length);
    expect(got).toEqual(PAYLOAD);
  });

  it('never inflates a name without .gz', async () => {
    const got = await readStream('T1.nii', stream(PAYLOAD), PAYLOAD.length);
    expect(got).toEqual(PAYLOAD);
  });

  it('handles an empty body without inventing bytes', async () => {
    expect(await readStream('empty.nii.gz', stream(new Uint8Array(0)), 0)).toEqual(
      new Uint8Array(0)
    );
  });

  it('reports read progress, first chunk included, and ends on the true total', async () => {
    const seen: Array<[string, number, number]> = [];
    await readStream('T1.nii', stream(PAYLOAD, 512), PAYLOAD.length, (phase, done, total) =>
      seen.push([phase, done, total])
    );
    expect(seen[0]).toEqual(['read', 512, PAYLOAD.length]);
    expect(seen.at(-1)).toEqual(['read', PAYLOAD.length, PAYLOAD.length]);
  });

  it('reports the inflate phase for a gzip body', async () => {
    const seen: string[] = [];
    await readStream('T1.nii.gz', stream(await gzip(PAYLOAD)), 0, (phase) => seen.push(phase));
    expect(new Set(seen)).toEqual(new Set(['inflate']));
  });
});

describe('sourceName (§6.5.1)', () => {
  it('takes the last path segment of a tetravox://file URL and decodes it', () => {
    expect(
      sourceName({
        kind: 'url',
        url: 'tetravox://file/Users/x/m2m_ernie/final_tissues.nii.gz',
      })
    ).toBe('final_tissues.nii.gz');
    expect(sourceName({ kind: 'url', url: 'tetravox://file/a/my%20mesh.msh' })).toBe('my mesh.msh');
  });

  it('ignores a query string, which would otherwise defeat the .gz test', () => {
    expect(sourceName({ kind: 'url', url: 'http://h/testdata/vol_u8.nii.gz?v=1' })).toBe(
      'vol_u8.nii.gz'
    );
  });

  it('takes the basename of a **percent-encoded** path, which is what the app actually sends', () => {
    // `datasets/source.ts`'s `fileUrl` is `tetravox://file/${encodeURIComponent(path)}`, so every
    // separator is `%2F` and the last literal `/` is the one after `file`. Splitting before
    // decoding returned the whole absolute path as the file's name.
    const abs = '/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie/m2m_ernie/T1.nii.gz';
    expect(sourceName({ kind: 'url', url: `tetravox://file/${encodeURIComponent(abs)}` })).toBe(
      'T1.nii.gz'
    );
    // …and it is still a `.gz` afterwards, which is what the sniff downstream keys on.
    expect(
      sourceName({
        kind: 'url',
        url: `tetravox://file/${encodeURIComponent('/a b/c d/ernie.msh')}`,
      })
    ).toBe('ernie.msh');
  });

  it('treats a backslash as a separator, for a Windows path that reached a URL', () => {
    expect(
      sourceName({ kind: 'url', url: `tetravox://file/${encodeURIComponent('C:\\data\\T1.nii')}` })
    ).toBe('T1.nii');
  });

  it('uses the declared name for bytes sources', () => {
    expect(sourceName({ kind: 'bytes', name: 'ernie.msh', bytes: new ArrayBuffer(0) })).toBe(
      'ernie.msh'
    );
  });
});

describe('loadSource sidecars (§6.5.1)', () => {
  const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

  it('reads a sidecar that is there', async () => {
    const out = await loadSource({
      kind: 'bytes',
      name: 'ernie.msh',
      bytes: bytes('mesh'),
      sidecars: { opt: bytes('opt'), lut: bytes('lut') },
    });
    expect(new TextDecoder().decode(out.opt)).toBe('opt');
    expect(new TextDecoder().decode(out.lut)).toBe('lut');
  });

  it('treats a sidecar that will not read as a **missing** sidecar, not a failed load', async () => {
    // The regression: a scene reopened from a moved directory names its `.msh.opt` relative to
    // wherever the dataset resolved to, and if the pair did not travel together that URL 404s.
    // Refusing the whole load there would mean a relocated scene cannot be opened at all, while
    // everything downstream already has an answer for "no sidecar" — §7.6's deterministic palette
    // and `Label <id>`.
    const MESH = 'https://example.invalid/ernie.msh';
    const OPT = 'https://example.invalid/ernie.msh.opt';
    vi.stubGlobal('fetch', async (url: string) =>
      url === MESH ? new Response('mesh') : new Response(null, { status: 404 })
    );
    try {
      const out = await loadSource({ kind: 'url', url: MESH, sidecars: { opt: OPT } });
      expect(new TextDecoder().decode(out.bytes)).toBe('mesh');
      expect(out.opt, 'the sidecar is absent, and the mesh still loaded').toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('…while the **dataset**’s own failure is still fatal', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    try {
      await expect(
        loadSource({ kind: 'url', url: 'https://example.invalid/gone.msh' })
      ).rejects.toThrow(/404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
