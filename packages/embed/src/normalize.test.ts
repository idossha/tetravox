/**
 * The two gaps `normalize.ts` closes: URL resolution, and the nine view fields a host cannot know.
 *
 * The URL half is the one that bites in production. A host serving data from its own API sends
 * root-relative paths (`/api/files/raw/…`), and those are **not** one of the two shapes
 * `datasets/source.ts`'s `fileUrl` passes through — unresolved they become a `tetravox://file/`
 * request no browser outside Electron can serve. Both spellings are asserted here.
 */

import { describe, expect, it } from 'vitest';
import type { ViewSpec } from '@tetravox/engine';
import { normalizeScene, resolveUrl } from './normalize';

/** A stand-in for `Engine.serialize()` on the empty scene, with the nine fields that matter. */
const TEMPLATE = {
  version: 2,
  datasets: [],
  layers: [],
  activeLayerId: null,
  slices: [{ id: 'axial' }],
  view3d: { id: 'view3d', camera: { distance: 300 } },
  layout: { kind: '2x2', cells: ['axial', 'coronal', 'sagittal', 'view3d'] },
  cursor: [0, 0, 0],
  radiological: false,
  background: [0, 0, 0, 1],
  lighting: { ambient: 0.25, headlight: true },
  annotations: { crosshair: true },
  transparency: { mode: 'twoPhase' },
} as unknown as ViewSpec;

const BASE = 'http://viewer.example/tetravox/index.html';

const scene = (path: string, extra: Record<string, unknown> = {}) => ({
  datasets: [{ id: 'd1', kind: 'volume' as const, name: 'T1.nii.gz', path, ...extra }],
  layers: [{ id: 'l1', datasetId: 'd1', kind: 'volume' }],
});

describe('dataset URL resolution', () => {
  it('passes an absolute http(s) URL through unchanged', () => {
    const { spec, resolved } = normalizeScene(
      scene('https://data.example/sub-01/T1.nii.gz'),
      TEMPLATE,
      BASE
    );
    expect(resolved['d1']).toBe('https://data.example/sub-01/T1.nii.gz');
    expect(spec.datasets[0]?.path).toBe('https://data.example/sub-01/T1.nii.gz');
  });

  it('resolves a ROOT-relative path against the base origin', () => {
    // The shape a host with its own file API sends. `/api/...` is neither `scheme://` nor `/@fs/`,
    // so leaving it for `fileUrl` would produce `tetravox://file/%2Fapi%2F...`.
    const { resolved } = normalizeScene(scene('/api/files/raw/mnt/000/T1.nii.gz'), TEMPLATE, BASE);
    expect(resolved['d1']).toBe('http://viewer.example/api/files/raw/mnt/000/T1.nii.gz');
  });

  it('resolves a document-relative path against the embed page, not the origin root', () => {
    const { resolved } = normalizeScene(scene('data/T1.nii.gz'), TEMPLATE, BASE);
    expect(resolved['d1']).toBe('http://viewer.example/tetravox/data/T1.nii.gz');
  });

  it('honours an explicit baseUrl over the default', () => {
    const { resolved } = normalizeScene(
      scene('T1.nii.gz'),
      TEMPLATE,
      'https://cdn.example/subj/9/'
    );
    expect(resolved['d1']).toBe('https://cdn.example/subj/9/T1.nii.gz');
  });

  it('resolves a sidecar against the DATASET, never against the page', () => {
    // ARCHITECTURE.md 4.6: a sidecar travels with the file it describes.
    const { spec } = normalizeScene(
      scene('/api/files/raw/m2m_ernie/final_tissues.nii.gz', {
        sidecars: { lut: { path: 'final_tissues_LUT.txt' } },
      }),
      TEMPLATE,
      BASE
    );
    expect(spec.datasets[0]?.sidecars?.lut).toEqual({
      path: '',
      absPath: 'http://viewer.example/api/files/raw/m2m_ernie/final_tissues_LUT.txt',
    });
  });

  it('defaults an absent fingerprint to the empty string', () => {
    const { spec } = normalizeScene(scene('/T1.nii.gz'), TEMPLATE, BASE);
    expect(spec.datasets[0]?.fingerprint).toBe('');
  });

  it('keeps a fingerprint the host did send', () => {
    const { spec } = normalizeScene(
      scene('/T1.nii.gz', { fingerprint: 'tvxfp1-0000000003400160-8192ec923b9c8951' }),
      TEMPLATE,
      BASE
    );
    expect(spec.datasets[0]?.fingerprint).toBe('tvxfp1-0000000003400160-8192ec923b9c8951');
  });

  it('throws on a path no base can make sense of', () => {
    expect(() => normalizeScene(scene('T1.nii.gz'), TEMPLATE, 'not-a-url')).toThrow();
  });
});

describe('view fields', () => {
  it('fills every field the host omitted from the template', () => {
    const { spec } = normalizeScene(scene('/T1.nii.gz'), TEMPLATE, BASE);
    for (const key of [
      'slices',
      'view3d',
      'layout',
      'cursor',
      'radiological',
      'background',
      'lighting',
      'annotations',
      'transparency',
    ] as const) {
      expect(spec[key]).toEqual(TEMPLATE[key]);
    }
    expect(spec.version).toBe(2);
    expect(spec.activeLayerId).toBeNull();
  });

  it('never overrides a field the host did send', () => {
    const { spec } = normalizeScene(
      { ...scene('/T1.nii.gz'), cursor: [10, 20, 30], radiological: true, activeLayerId: 'l1' },
      TEMPLATE,
      BASE
    );
    expect(spec.cursor).toEqual([10, 20, 30]);
    expect(spec.radiological).toBe(true);
    expect(spec.activeLayerId).toBe('l1');
  });

  it('carries through a field this build has never heard of', () => {
    // ARCHITECTURE.md 4.6 makes the same promise for per-layer fields, and for the same reason: a
    // host written against a later build must not have its scene silently trimmed on the way in.
    const { spec } = normalizeScene(
      { ...scene('/T1.nii.gz'), somethingNewer: { a: 1 } },
      TEMPLATE,
      BASE
    );
    expect((spec as unknown as Record<string, unknown>)['somethingNewer']).toEqual({ a: 1 });
  });

  it('passes layers through verbatim', () => {
    const layers = [{ id: 'l1', datasetId: 'd1', kind: 'volume', colormap: 'hot', opacity: 0.5 }];
    const { spec } = normalizeScene({ ...scene('/T1.nii.gz'), layers }, TEMPLATE, BASE);
    expect(spec.layers).toEqual(layers);
  });
});

describe('resolveUrl', () => {
  it('is exactly the URL constructor rule', () => {
    expect(resolveUrl('https://a.example/x', 'http://b.example/y/')).toBe('https://a.example/x');
    expect(resolveUrl('//a.example/x', 'https://b.example/y/')).toBe('https://a.example/x');
    expect(resolveUrl('../up.nii', 'http://b.example/y/z/')).toBe('http://b.example/y/up.nii');
  });
});

describe('a points layer (protocol 2)', () => {
  const points = {
    id: 'l2',
    datasetId: 'd1',
    kind: 'points',
    name: 'GSN-HydroCel-185',
    points: [
      { id: 'E1', position: [10, 20, 30], name: 'Fp1' },
      { id: 'E2', position: [-10, 20, 30], name: 'Fp2', state: 'selected' },
    ],
    labelMode: 'names',
    radiusMm: 5,
  };

  it("spends the host's vocabulary before the engine sees the layer", () => {
    const { spec } = normalizeScene(
      { ...scene('/T1.nii.gz'), layers: [scene('/T1.nii.gz').layers[0]!, points] },
      TEMPLATE,
      BASE
    );
    const layer = spec.layers[1] as unknown as Record<string, unknown>;
    expect(layer['labelMode']).toBeUndefined();
    expect(layer['showLabels']).toBe(true);
    expect(layer['labelSource']).toBe('names');
    expect((layer['points'] as { color?: number[] }[])[1]?.color).toEqual([1, 0.8, 0.2, 1]);
    // Nothing else moved: the carrier, the radius and the ids are the host's.
    expect(layer['datasetId']).toBe('d1');
    expect(layer['radiusMm']).toBe(5);
    expect((layer['points'] as { id: string }[]).map((p) => p.id)).toEqual(['E1', 'E2']);
  });

  it('needs no dataset of its own — the coordinates came with the layer', () => {
    // The compatibility-shaped half of the same claim: a points layer adds no `DatasetRef`, so the
    // resolver map is exactly what a protocol-1 scene with the same volume would have produced.
    const { resolved } = normalizeScene(
      { ...scene('/T1.nii.gz'), layers: [scene('/T1.nii.gz').layers[0]!, points] },
      TEMPLATE,
      BASE
    );
    expect(Object.keys(resolved)).toEqual(['d1']);
  });

  it('leaves a protocol-1 scene byte-identical', () => {
    // The guarantee, asserted on the object the engine is handed: a scene with no points layer is
    // the same spec it was before protocol 2 existed, layer objects included (identity, not just
    // equality — a copy here would be a place a future field could be dropped).
    const layers = [{ id: 'l1', datasetId: 'd1', kind: 'volume', colormap: 'gray' }];
    const { spec } = normalizeScene({ ...scene('/T1.nii.gz'), layers }, TEMPLATE, BASE);
    expect(spec.layers[0]).toBe(layers[0]);
  });
});

// -------------------------------------------------------------------------------------------------
// Protocol 3: the three things a host can now write, and the one it cannot.
// -------------------------------------------------------------------------------------------------

const surfaceScene = (
  dataset: Record<string, unknown>,
  layers: Record<string, unknown>[] = [{ id: 'l1', datasetId: 'd1', kind: 'surface' }]
) => ({ datasets: [{ id: 'd1', name: 'lh.pial', path: 'x', ...dataset }], layers }) as never;

describe("the dataset kind 'surface' (protocol 3)", () => {
  it("maps down to 'mesh', because the engine has no third dataset kind", () => {
    // `isSurfaceMesh` decides surface-ness from `nTets === 0`, i.e. from the bytes — so a ref that
    // reached `Engine.load` saying 'surface' would be naming a kind §4.6 does not define. The word
    // exists for the host's document, not for the engine.
    const { spec } = normalizeScene(
      surfaceScene({ kind: 'surface', path: 'https://d.example/lh.pial' }),
      TEMPLATE,
      BASE
    );
    expect(spec.datasets[0]?.kind).toBe('mesh');
  });

  it("loads identically to the same file spelled 'mesh'", () => {
    // The compatibility half: the pre-protocol-3 spelling is not deprecated and must not diverge.
    const asSurface = normalizeScene(
      surfaceScene({ kind: 'surface', path: 'https://d.example/lh.pial.gii' }),
      TEMPLATE,
      BASE
    );
    const asMesh = normalizeScene(
      surfaceScene({ kind: 'mesh', path: 'https://d.example/lh.pial.gii' }),
      TEMPLATE,
      BASE
    );
    expect(asSurface.spec.datasets).toEqual(asMesh.spec.datasets);
    expect(asSurface.resolved).toEqual(asMesh.resolved);
  });

  it('leaves volume and mesh exactly as they were', () => {
    const { spec } = normalizeScene(scene('https://d.example/T1.nii.gz'), TEMPLATE, BASE);
    expect(spec.datasets[0]?.kind).toBe('volume');
  });
});

describe("sidecars.fields — a surface's attached per-vertex files (protocol 3)", () => {
  const withFields = normalizeScene(
    surfaceScene({
      kind: 'surface',
      path: 'https://data.example/m2m_ernie/surfaces/lh.pial.gii',
      sidecars: {
        fields: [{ path: '../segmentation/lh.ernie_DK40.annot' }, { path: 'lh.thickness' }],
      },
    }),
    TEMPLATE,
    BASE
  );

  it("resolves each against the DATASET's own URL, not the page", () => {
    // §4.6's rule for every sidecar role: it travels with the file it describes. SimNIBS really does
    // write the atlas one directory over from the surface, so the `../` case is the ordinary one.
    expect(withFields.spec.datasets[0]?.sidecars?.fields).toEqual([
      {
        path: '',
        absPath: 'https://data.example/m2m_ernie/segmentation/lh.ernie_DK40.annot',
      },
      { path: '', absPath: 'https://data.example/m2m_ernie/surfaces/lh.thickness' },
    ]);
  });

  it('keeps the order, because that is the order they are attached in', () => {
    const paths = withFields.spec.datasets[0]?.sidecars?.fields?.map((f) => f.absPath);
    expect(paths?.[0]).toMatch(/lh\.ernie_DK40\.annot$/);
    expect(paths?.[1]).toMatch(/lh\.thickness$/);
  });

  it('empties `path` so `sidecarPathsFor` takes the absolute one', () => {
    // Not cosmetic: `sidecarPathsFor` PREFERS a non-empty relative path and joins it onto the
    // dataset's directory with its own string-splitting. Handing it a URL to split would be a second
    // implementation of resolution; handing it `''` makes it take the answer computed here.
    for (const f of withFields.spec.datasets[0]?.sidecars?.fields ?? []) expect(f.path).toBe('');
  });

  it('writes no `fields` key at all when a host sends none', () => {
    const { spec } = normalizeScene(scene('https://d.example/T1.nii.gz'), TEMPLATE, BASE);
    expect(spec.datasets[0]?.sidecars).toBeUndefined();
  });

  it('rides alongside lut and opt rather than replacing them', () => {
    const { spec } = normalizeScene(
      surfaceScene({
        kind: 'mesh',
        path: 'https://data.example/m2m/ernie.msh',
        sidecars: { opt: { path: 'ernie.msh.opt' }, fields: [{ path: 'lh.curv' }] },
      }),
      TEMPLATE,
      BASE
    );
    expect(spec.datasets[0]?.sidecars?.opt?.absPath).toBe('https://data.example/m2m/ernie.msh.opt');
    expect(spec.datasets[0]?.sidecars?.fields?.[0]?.absPath).toBe(
      'https://data.example/m2m/lh.curv'
    );
  });
});

describe('a surface LAYER rides through to the engine untouched', () => {
  it('is not rewritten the way a points layer is', () => {
    // The whole reason protocol 3 needed no new code path: §4.4 has had a `SurfaceLayer` since
    // Tetravox 0.4.0, so the host's vocabulary and the engine's are already the same one. Only
    // `points` has a host vocabulary to spend (`state`, `labelMode`).
    const layer = {
      id: 'l1',
      datasetId: 'd1',
      kind: 'surface',
      colorMode: 'annotation',
      annotation: { name: 'lh.ernie_DK40.annot', mode: 'both', outlineWidthPx: 2 },
      contoursIn2D: true,
    };
    const { spec } = normalizeScene(surfaceScene({ kind: 'surface' }, [layer]), TEMPLATE, BASE);
    expect(spec.layers[0]).toEqual(layer);
  });
});

describe('an unknown layer kind is refused', () => {
  const load = (kind: unknown) =>
    normalizeScene(
      surfaceScene({ kind: 'volume' }, [{ id: 'l1', datasetId: 'd1', kind }]),
      TEMPLATE,
      BASE
    );

  it('throws rather than letting the engine drop the layer in silence', () => {
    // `Engine.load` filters on `isRestorableKind` and SKIPS what it does not know — no throw, no
    // event — so without this guard a host got a successful `loaded` for a scene with nothing in it.
    // That is the worst answer available, and it is why protocol 3 moved the number.
    expect(() => load('hologram')).toThrow(/unknown layer kind "hologram"/);
  });

  it('names the four kinds that do exist, and which of them a .msh and a surface are', () => {
    // A host that got this wrong got it wrong in one specific way — sending a triangular surface as
    // a tetrahedral mesh, or the reverse — so the message answers that question rather than only
    // listing tokens.
    expect(() => load('tetra')).toThrow(/volume, mesh, surface, points/);
    expect(() => load('tetra')).toThrow(/tetrahedral FEM \.msh is 'mesh'/);
    expect(() => load('tetra')).toThrow(/triangular surface \(FreeSurfer or GIfTI\) is 'surface'/);
  });

  it('says WHICH layer, because a scene has several', () => {
    expect(() =>
      normalizeScene(
        surfaceScene({ kind: 'volume' }, [
          { id: 'l1', datasetId: 'd1', kind: 'volume' },
          { id: 'l2', datasetId: 'd1', kind: 'surfaces' },
        ]),
        TEMPLATE,
        BASE
      )
    ).toThrow(/layers\[1\]/);
  });

  it('refuses a missing or non-string kind too', () => {
    expect(() => load(undefined)).toThrow(/unknown layer kind/);
    expect(() => load(7)).toThrow(/unknown layer kind/);
  });

  it('accepts all four of the kinds that do exist', () => {
    for (const kind of ['volume', 'mesh', 'surface', 'points']) {
      expect(() => load(kind)).not.toThrow();
    }
  });

  it('refuses BEFORE anything is fetched, so a typo costs no network', () => {
    // The guard is at the top of `normalizeScene`, ahead of URL resolution: a spec that names a
    // kind this build cannot draw should not first download a 400 MB mesh to find out.
    expect(() =>
      normalizeScene(
        {
          datasets: [{ id: 'd1', kind: 'volume', name: 'T1', path: 'http://[' }],
          layers: [{ id: 'l1', datasetId: 'd1', kind: 'hologram' }],
        } as never,
        TEMPLATE,
        BASE
      )
    ).toThrow(/unknown layer kind/);
  });
});
