/**
 * Protocol 3, end to end: a **surface** is not a **mesh** is not a **volume**.
 *
 * The maintainer's ask was one sentence — "distinguish between NIfTI, mesh, and a surface, where a
 * mesh is a tetrahedral FEM and a surface is just a triangular two-dimensional surface" — and it is
 * an ask about what the *viewer* does with a file, not about a schema. So every assertion here goes
 * through the real iframe, the real protocol and the real engine, and reads the layer back out of
 * the `loaded` event the host actually receives.
 *
 * **These tests need no `TETRAVOX_TESTDATA`.** They run against the committed synthetic fixtures in
 * `testdata/` — the same ones `packages/engine/test/e2e/surface.spec.ts` uses — served over Vite's
 * `/@fs/` mount, which `vite.config.ts` already allows for the repository root. That is deliberate:
 * the kind a file opens as is a property of its bytes, and the four-vertex patch proves it exactly
 * as a hemisphere would, so the one part of the embed contract a host is most likely to get wrong is
 * not the part that skips on a machine without a reference subject.
 *
 * Both geometry formats are exercised, because they take different branches of `tvx_mesh_io::sniff`:
 * `lh.fixture.surf` is FreeSurfer's 24-bit big-endian magic and `surf_ascii.surf.gii` is GIfTI XML.
 */

import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;

/** FreeSurfer binary geometry — and note it carries no extension a sniffer could use. */
const FS_SURFACE = fixture('lh.fixture.surf');
/** GIfTI geometry, the ASCII encoding. */
const GIFTI_SURFACE = fixture('surf_ascii.surf.gii');
// The FreeSurfer annotation, `testdata/lh.fixture.annot` (four labels and a colour table), is
// named RELATIVE to its surface in every scene below rather than as a constant here — that is the
// §4.6 rule the sidecar tests are checking, and a constant would quietly resolve it against the page.
/** A tetrahedral Gmsh mesh — the thing a surface must NOT be confused with. */
const TET_MESH = fixture('mesh_tetonly.msh');
/** A NIfTI. */
const VOLUME = fixture('labels_freesurfer.nii.gz');

interface HostWindow {
  __host: {
    send(message: Record<string, unknown>, expectReply?: boolean): Promise<Record<string, unknown>>;
    events: Record<string, unknown>[];
  };
}

interface LoadedLayer {
  id: string;
  kind: string;
  name: string;
  colorMode?: string;
  [key: string]: unknown;
}

async function openHost(page: Page): Promise<Record<string, unknown>> {
  await page.goto('/example/host.html?data=/none');
  await page.waitForFunction(
    () => (window as unknown as HostWindow).__host?.events.some((e) => e['type'] === 'ready'),
    undefined,
    { timeout: 60_000 }
  );
  return page.evaluate(
    () =>
      (window as unknown as HostWindow).__host.events.find((e) => e['type'] === 'ready') as Record<
        string,
        unknown
      >
  );
}

const send = (
  page: Page,
  message: Record<string, unknown>,
  reply = true
): Promise<Record<string, unknown>> =>
  page.evaluate(
    ([m, r]) =>
      (window as unknown as HostWindow).__host.send(m as Record<string, unknown>, r as boolean),
    [message, reply] as const
  );

/** `load` this scene and return the reply, whatever it is. */
const load = (page: Page, scene: Record<string, unknown>): Promise<Record<string, unknown>> =>
  send(page, { type: 'load', scene });

/** `load` this scene, insist it succeeded, and hand back the live layers. */
async function loadOk(page: Page, scene: Record<string, unknown>): Promise<LoadedLayer[]> {
  const reply = await load(page, scene);
  expect(reply['type'], JSON.stringify(reply)).toBe('loaded');
  return reply['layers'] as LoadedLayer[];
}

test.describe('protocol 3 announces itself', () => {
  test('ready.version is 3, and the envelope is still 1', async ({ page }) => {
    const ready = await openHost(page);
    // The feature level moved; `tvx` did not, which is what keeps every protocol-1 and protocol-2
    // host talking to this build.
    expect(ready['version']).toBe(3);
    expect(ready['tvx']).toBe(1);
  });
});

test.describe('a surface opens as a surface', () => {
  test('from a FreeSurfer binary surface, with no extension to go on', async ({ page }) => {
    await openHost(page);
    const layers = await loadOk(page, {
      datasets: [{ id: 'd1', kind: 'surface', name: 'lh.fixture.surf', path: FS_SURFACE }],
      layers: [{ id: 'l1', datasetId: 'd1', kind: 'surface', name: 'lh' }],
    });
    expect(layers).toHaveLength(1);
    // The whole point: not 'mesh'.
    expect(layers[0]?.kind).toBe('surface');
    // A geometry-only file has no overlay and no atlas, so it is a solid colour.
    expect(layers[0]?.colorMode).toBe('solid');
    // And it carries none of the tetrahedral vocabulary.
    expect(layers[0]).not.toHaveProperty('tagStyle');
    expect(layers[0]).not.toHaveProperty('fillIn2D');
    // A sheet has no interior, so its clip has planes and no caps.
    expect(layers[0]?.['clip']).toEqual({ planes: [] });
  });

  test('from a GIfTI, which is a different branch of the sniffer', async ({ page }) => {
    await openHost(page);
    const layers = await loadOk(page, {
      datasets: [{ id: 'd1', kind: 'surface', name: 'surf_ascii.surf.gii', path: GIFTI_SURFACE }],
      layers: [{ id: 'l1', datasetId: 'd1', kind: 'surface', name: 'gii' }],
    });
    expect(layers[0]?.kind).toBe('surface');
    expect(layers[0]?.colorMode).toBe('solid');
  });

  test("the dataset kind 'mesh' on a surface file still works, and loads identically", async ({
    page,
  }) => {
    // The compatibility half of the dataset-kind spelling: `'surface'` is a nicety for the host's
    // own document, and a protocol-2 host that writes `'mesh'` must not get a different picture.
    await openHost(page);
    const asMesh = await loadOk(page, {
      datasets: [{ id: 'd1', kind: 'mesh', name: 'lh.fixture.surf', path: FS_SURFACE }],
      layers: [{ id: 'l1', datasetId: 'd1', kind: 'surface', name: 'lh' }],
    });
    expect(asMesh[0]?.kind).toBe('surface');
    expect(asMesh[0]?.['solidColor']).toEqual([1, 0.9, 0.15, 1]);
  });

  test('a host that names no colour gets the load-order palette', async ({ page, context }) => {
    // Documented in `EMBED.md` §5(c) because it surprises: two hemispheres come out yellow and
    // green rather than both the same, and a host that wanted one colour has to say so.
    // Hold the first file until the second surface is visible: palette order must follow the
    // document even when worker/network completion runs in the opposite order.
    await context.route('**/lh.fixture.surf', async (route) => {
      await page.waitForFunction(() =>
        (window as unknown as HostWindow).__host.events.some(
          (event) =>
            event['type'] === 'layers' &&
            (event['layers'] as LoadedLayer[]).some((layer) => layer.name === 'rh')
        )
      );
      await route.continue();
    });
    await openHost(page);
    const layers = await loadOk(page, {
      datasets: [
        { id: 'd1', kind: 'surface', name: 'lh', path: FS_SURFACE },
        { id: 'd2', kind: 'surface', name: 'rh', path: GIFTI_SURFACE },
      ],
      layers: [
        { id: 'l1', datasetId: 'd1', kind: 'surface', name: 'lh' },
        { id: 'l2', datasetId: 'd2', kind: 'surface', name: 'rh' },
      ],
    });
    expect(layers[0]?.['solidColor']).toEqual([1, 0.9, 0.15, 1]);
    expect(layers[1]?.['solidColor']).toEqual([0.45, 0.78, 0.42, 1]);
  });

  test('a colour the host DID name survives the palette', async ({ page }) => {
    await openHost(page);
    const layers = await loadOk(page, {
      datasets: [{ id: 'd1', kind: 'surface', name: 'lh', path: FS_SURFACE }],
      layers: [
        {
          id: 'l1',
          datasetId: 'd1',
          kind: 'surface',
          solidColor: [0.1, 0.2, 0.3, 1],
          opacity: 0.5,
        },
      ],
    });
    expect(layers[0]?.['solidColor']).toEqual([0.1, 0.2, 0.3, 1]);
    // Per-layer opacity, like a volume's.
    expect(layers[0]?.['opacity']).toBe(0.5);
  });
});

test.describe('an .annot attaches through sidecars.fields and colours the surface', () => {
  /** The scene EMBED.md §5(c) documents: geometry, plus an atlas as a second file. */
  const annotated = {
    datasets: [
      {
        id: 'd1',
        kind: 'surface',
        name: 'lh.fixture.surf',
        path: FS_SURFACE,
        sidecars: { fields: [{ path: 'lh.fixture.annot' }] },
      },
    ],
    layers: [
      {
        id: 'l1',
        datasetId: 'd1',
        kind: 'surface',
        name: 'lh + DK40',
        colorMode: 'annotation',
        annotation: { name: 'lh.fixture.annot', mode: 'fill' },
      },
    ],
  };

  test('the layer comes back coloured BY the annotation, not solid', async ({ page }) => {
    // The failure this guards is the quiet one: an annotation whose name does not match the field
    // the reader produced does not fail the load — the layer silently falls back to 'solid'. So
    // asserting the *reply* rather than the absence of an error is the only assertion that means
    // anything here.
    await openHost(page);
    const layers = await loadOk(page, annotated);
    expect(layers[0]?.kind).toBe('surface');
    expect(layers[0]?.colorMode).toBe('annotation');
    // Named after the FILE, which is what lets two atlases on one hemisphere coexist.
    expect((layers[0]?.['annotation'] as { name: string } | undefined)?.name).toBe(
      'lh.fixture.annot'
    );
  });

  test('the sidecar path is resolved against the DATASET, not the page', async ({ page }) => {
    // `lh.fixture.annot` is a bare relative path and the embed document lives at
    // `/index.html` — so if it were resolved against the page it would 404 and the layer
    // would come back solid. This test fails if that regresses, without needing a network assertion.
    await openHost(page);
    const layers = await loadOk(page, annotated);
    expect(layers[0]?.colorMode).toBe('annotation');
  });

  test('an annotation that is not there opens the surface solid, not broken', async ({ page }) => {
    // Best-effort, exactly like `lut` and `opt`: a missing sidecar is a missing table and never a
    // failed load. Documented because a host WILL hit it and the load still says `loaded`.
    await openHost(page);
    const layers = await loadOk(page, {
      datasets: [
        {
          id: 'd1',
          kind: 'surface',
          name: 'lh',
          path: FS_SURFACE,
          sidecars: { fields: [{ path: 'no-such-atlas.annot' }] },
        },
      ],
      layers: [
        {
          id: 'l1',
          datasetId: 'd1',
          kind: 'surface',
          colorMode: 'annotation',
          annotation: { name: 'no-such-atlas.annot', mode: 'fill' },
        },
      ],
    });
    expect(layers[0]?.kind).toBe('surface');
    expect(layers[0]?.colorMode).toBe('solid');
  });
});

test.describe('the other two kinds are unchanged', () => {
  test('a tetrahedral .msh still opens as a mesh, with its tags', async ({ page }) => {
    // The other half of the distinction. A surface layer must not have swallowed the mesh one:
    // `colorMode: 'tag'` is the tissue vocabulary a sheet does not have.
    await openHost(page);
    const layers = await loadOk(page, {
      datasets: [{ id: 'd1', kind: 'mesh', name: 'mesh_tetonly.msh', path: TET_MESH }],
      layers: [{ id: 'l1', datasetId: 'd1', kind: 'mesh', name: 'tets' }],
    });
    expect(layers[0]?.kind).toBe('mesh');
    expect(layers[0]).toHaveProperty('tagStyle');
  });

  test('a NIfTI still opens as a volume', async ({ page }) => {
    await openHost(page);
    const layers = await loadOk(page, {
      datasets: [{ id: 'd1', kind: 'volume', name: 'labels.nii.gz', path: VOLUME }],
      layers: [{ id: 'l1', datasetId: 'd1', kind: 'volume', name: 'labels' }],
    });
    expect(layers[0]?.kind).toBe('volume');
  });

  test('all three in one scene, each as itself', async ({ page }) => {
    // The maintainer's sentence, as one assertion.
    await openHost(page);
    const layers = await loadOk(page, {
      datasets: [
        { id: 'd1', kind: 'volume', name: 'labels.nii.gz', path: VOLUME },
        { id: 'd2', kind: 'mesh', name: 'mesh_tetonly.msh', path: TET_MESH },
        { id: 'd3', kind: 'surface', name: 'lh.fixture.surf', path: FS_SURFACE },
      ],
      layers: [
        { id: 'l1', datasetId: 'd1', kind: 'volume', name: 'NIfTI' },
        { id: 'l2', datasetId: 'd2', kind: 'mesh', name: 'FEM mesh' },
        { id: 'l3', datasetId: 'd3', kind: 'surface', name: 'surface' },
      ],
    });
    expect(layers.map((l) => l.kind)).toEqual(['volume', 'mesh', 'surface']);
  });
});

test.describe('an unknown layer kind is refused with a message that says what to send', () => {
  test('the reply is an error, not a silently emptied scene', async ({ page }) => {
    // Before protocol 3 this was the worst path in the contract: `Engine.load` skips a kind it does
    // not know, so the host got `loaded` and a scene with the layer missing. A host cannot detect
    // that; it can detect an `error`.
    await openHost(page);
    const reply = await load(page, {
      datasets: [{ id: 'd1', kind: 'surface', name: 'lh', path: FS_SURFACE }],
      layers: [{ id: 'l1', datasetId: 'd1', kind: 'hologram' }],
    });
    expect(reply['type']).toBe('error');
    expect(reply['message']).toMatch(/unknown layer kind "hologram"/);
    expect(reply['message']).toMatch(/volume, mesh, surface, points/);
  });

  test('the message tells a host which of mesh and surface it meant', async ({ page }) => {
    await openHost(page);
    const reply = await load(page, {
      datasets: [{ id: 'd1', kind: 'surface', name: 'lh', path: FS_SURFACE }],
      layers: [{ id: 'l1', datasetId: 'd1', kind: 'tetmesh' }],
    });
    expect(reply['message']).toMatch(/tetrahedral FEM \.msh is 'mesh'/);
    expect(reply['message']).toMatch(/triangular surface \(FreeSurfer or GIfTI\) is 'surface'/);
  });

  test('the host also hears status: error, as it does for a bad URL', async ({ page }) => {
    await openHost(page);
    await load(page, {
      datasets: [{ id: 'd1', kind: 'surface', name: 'lh', path: FS_SURFACE }],
      layers: [{ id: 'l1', datasetId: 'd1', kind: 'hologram' }],
    });
    const statuses = await page.evaluate(() =>
      (window as unknown as HostWindow).__host.events
        .filter((e) => e['type'] === 'status')
        .map((e) => e['phase'])
    );
    expect(statuses).toContain('error');
  });

  test('a good scene still loads afterwards, so a refusal is not a dead viewer', async ({
    page,
  }) => {
    await openHost(page);
    await load(page, {
      datasets: [{ id: 'd1', kind: 'surface', name: 'lh', path: FS_SURFACE }],
      layers: [{ id: 'l1', datasetId: 'd1', kind: 'hologram' }],
    });
    const layers = await loadOk(page, {
      datasets: [{ id: 'd1', kind: 'surface', name: 'lh', path: FS_SURFACE }],
      layers: [{ id: 'l1', datasetId: 'd1', kind: 'surface' }],
    });
    expect(layers[0]?.kind).toBe('surface');
  });
});

test.describe('a surface survives a serialize round trip', () => {
  test('serialize gives back a surface layer and its sidecars.fields', async ({ page }) => {
    // The `scene` reply is what a host persists. If the surface came back as a `mesh`, or the
    // annotation's file were not listed, reopening the saved scene would give a different picture —
    // which is the failure `sidecars.fields` exists to prevent.
    await openHost(page);
    await loadOk(page, {
      datasets: [
        {
          id: 'd1',
          kind: 'surface',
          name: 'lh.fixture.surf',
          path: FS_SURFACE,
          sidecars: { fields: [{ path: 'lh.fixture.annot' }] },
        },
      ],
      layers: [
        {
          id: 'l1',
          datasetId: 'd1',
          kind: 'surface',
          colorMode: 'annotation',
          annotation: { name: 'lh.fixture.annot', mode: 'fill' },
        },
      ],
    });
    const reply = await send(page, { type: 'serialize' });
    const spec = reply['spec'] as {
      datasets: { kind: string; sidecars?: { fields?: { path: string; absPath?: string }[] } }[];
      layers: { kind: string; annotation?: { name: string } }[];
    };
    expect(spec.layers[0]?.kind).toBe('surface');
    expect(spec.layers[0]?.annotation?.name).toBe('lh.fixture.annot');
    // §4.6's DatasetRef has no 'surface' kind — the round trip writes what the engine knows.
    expect(spec.datasets[0]?.kind).toBe('mesh');
    const fields = spec.datasets[0]?.sidecars?.fields ?? [];
    expect(fields).toHaveLength(1);
    expect(`${fields[0]?.path}${fields[0]?.absPath ?? ''}`).toMatch(/lh\.fixture\.annot$/);
  });
});
