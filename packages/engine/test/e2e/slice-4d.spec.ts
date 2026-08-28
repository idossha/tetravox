/**
 * §7.5's `,` / `.` — the 4D index — over the `volumeFrame` op (§6.5.2). **Audit P2-05.**
 *
 * The bug this pins: the keys were bound and the engine had a texture for index 0 only, so a 4D
 * volume's layer *silently stopped drawing* at index 1. The assertions are therefore about three
 * things at once, and a fix that satisfies one without the others is not a fix:
 *
 * 1. **The pixel is `LUT(value)` for the value of that frame**, computed on the CPU here from §4.2's
 *    linear ramp and the two-stop `gray` map, so there is no table to transcribe. The *value* comes
 *    from `testdata/manifest.json`'s spot values — written by nibabel, never by the engine — and is
 *    cross-checked against `Engine.probe`, which reads the retained typed array (§4.3) and is a
 *    genuinely different path from the GPU texture the fragment sampled.
 * 2. **`Stats` follow the frame.** §6.5.1 says `VolumeMeta.stats` is "OF VOLUME 0 ONLY"; §7.5 says
 *    the readout, the colour bar and the histogram all follow the new volume's `Stats`. A colour bar
 *    still drawing volume 0's range on volume 2 is the same class of bug, one layer up.
 * 3. **One round trip per frame, and none for a frame already on the GPU.** `volumeFrame` uploads a
 *    texture under a new `volumeKey`, so stepping back is free. The worker op log
 *    (`window.__tvxOps`, taken by wrapping `Worker.prototype.postMessage`) is the evidence.
 */

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const fixture = (name: string): string => `/@fs${REPO}testdata/${name}`;
const manifest = JSON.parse(readFileSync(`${REPO}testdata/manifest.json`, 'utf8')) as {
  volumes: Record<
    string,
    {
      nvols: number;
      spotValues: { voxel: number[]; volume: number; physical: number; world: number[] }[];
    }
  >;
};

const VOL = 'vol_4d.nii.gz';
const PANE = 768;
const MM_PER_PX = 0.02;
/** A window wide enough to hold every frame's value at voxel (0,0,0): −3.5, 246.5 and 496.5. */
const LO = -10;
const HI = 500;

const REC = manifest.volumes[VOL]!;
/** The manifest's spot value at voxel (0,0,0) for each 4D index, and the world point it sits at. */
const SPOTS = [0, 1, 2].map((k) => {
  const s = REC.spotValues.find(
    (v) => v.volume === k && v.voxel[0] === 0 && v.voxel[1] === 0 && v.voxel[2] === 0
  );
  if (s === undefined) throw new Error(`manifest has no spot value for volume ${k} at (0,0,0)`);
  return s;
});
const WORLD: [number, number, number] = [
  SPOTS[0]!.world[0]!,
  SPOTS[0]!.world[1]!,
  SPOTS[0]!.world[2]!,
];

const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/**
 * What §7.3's fragment paints for `v` under `{kind:'linear', lo, hi}` and `gray`.
 *
 * `gray` is `[0,0,0] → [255,255,255]`, so the ramp position *is* the channel; the LUT is 256 texels
 * baked at their centres and fetched `NEAREST`, so the value the fragment actually shows is the one
 * its texel was baked for.
 */
function grayFor(v: number): number {
  const i = Math.min(255, Math.floor(clamp01((v - LO) / (HI - LO)) * 256));
  return Math.round((255 * (i + 0.5)) / 256);
}

test('4D: stepping `volumeIndex` repaints the frame, moves `Stats`, and costs one round trip each', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);

  const r = await page.evaluate(
    async ([url, pane, mmPerPx, world, lo, hi]) => {
      const engine = window.__tvxEngine! as typeof window.__tvxEngine & {
        layerStats(layerId: string): { min: number; max: number; mean: number } | undefined;
      };
      const P = pane as number;
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      /** The pane's centre pixel is the cursor's own projection (`camera.center` is [0, 0]). */
      const centrePixel = (): [number, number, number, number] => {
        engine.renderNow();
        const px = new Uint8Array(4);
        gl.readPixels(P / 2, P / 2 - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, px[3] ?? 0];
      };

      const ds = await engine.addDataset({ kind: 'path', path: url as string });
      const layer = engine.addLayer({ datasetId: ds.id, kind: 'volume' });
      engine.setLayout({ kind: '1x1', cells: ['axial'] });
      engine.setView('axial', { camera: { center: [0, 0], mmPerPx: mmPerPx as number } });
      engine.setAnnotations({ crosshair: false, orientationLabels: false, cornerInfo: false });
      engine.updateLayer(layer.id, {
        interpolation: 'nearest',
        colormap: 'gray',
        scale: { kind: 'linear', lo: lo as number, hi: hi as number },
      });
      engine.setCursor(world as [number, number, number]);
      await engine.whenSettled();

      const frames: {
        index: number;
        px: [number, number, number, number];
        probe: number | null;
        stats: { min: number; max: number; mean: number } | null;
      }[] = [];
      const read = (index: number): void => {
        const row = engine.probe(world as [number, number, number]).rows[0];
        frames.push({
          index,
          px: centrePixel(),
          probe: typeof row?.value === 'number' ? row.value : null,
          stats: engine.layerStats(layer.id) ?? null,
        });
      };

      read(0);
      for (const k of [1, 2]) {
        engine.updateLayer(layer.id, { volumeIndex: k });
        await engine.whenSettled();
        read(k);
      }
      const opsAfterForward = (window.__tvxOps ?? []).filter((o) => o === 'volumeFrame').length;
      // Back to a frame already on the GPU: no second round trip for it.
      engine.updateLayer(layer.id, { volumeIndex: 1 });
      await engine.whenSettled();
      read(1);
      const opsAfterRevisit = (window.__tvxOps ?? []).filter((o) => o === 'volumeFrame').length;

      return {
        nvols: 'nvols' in ds ? ds.nvols : 0,
        background: engine.scene.background.map((c) => Math.round(c * 255)),
        frames,
        opsAfterForward,
        opsAfterRevisit,
        errors: window.__tvxErrors ?? [],
      };
    },
    [fixture(VOL), PANE, MM_PER_PX, WORLD, LO, HI] as const
  );

  expect(pageErrors).toEqual([]);
  expect(r.errors).toEqual([]);
  expect(r.nvols, 'the fixture must actually be 4D').toBe(REC.nvols);
  expect(r.nvols).toBe(3);

  const bg = r.background;
  for (const f of r.frames) {
    const spot = SPOTS[f.index]!;
    // The probe reads the retained typed array; the manifest was written by nibabel. They agree, or
    // the 4D offset into `VolumeDataset.data` is wrong and the pixel below is right by luck.
    expect(f.probe, `probe at volume ${f.index}`).toBeCloseTo(spot.physical, 4);
    const want = grayFor(spot.physical);
    // Audit P2-05: at index > 0 the layer used to draw nothing at all.
    expect(
      f.px[0] === bg[0] && f.px[1] === bg[1] && f.px[2] === bg[2],
      `volume ${f.index} painted the background — the frame has no texture (audit P2-05)`
    ).toBe(false);
    for (let c = 0; c < 3; c += 1) {
      expect(
        Math.abs((f.px[c] ?? 0) - want),
        `volume ${f.index}: channel ${c} expected ${want} for value ${spot.physical}, got ${f.px.join(',')}`
      ).toBeLessThanOrEqual(3);
    }
  }

  // Three frames, three visibly different values, so "the pixel changed" is not a coincidence.
  const greys = r.frames.slice(0, 3).map((f) => f.px[0]);
  expect(new Set(greys).size, 'every 4D frame painted the same grey').toBe(3);

  // §7.5: the colour bar and the histogram follow the new volume's `Stats` (§6.5.1: `VolumeMeta`
  // carries volume 0's only).
  const stats = r.frames.slice(0, 3).map((f) => f.stats);
  for (const s of stats) expect(s).not.toBeNull();
  expect(new Set(stats.map((s) => `${s!.min}|${s!.max}|${s!.mean}`)).size).toBe(3);

  // One `volumeFrame` per frame that was not already on the GPU, and none for one that was.
  expect(r.opsAfterForward, 'stepping to volumes 1 and 2 is two round trips').toBe(2);
  expect(r.opsAfterRevisit, 'stepping back to a cached frame must not re-fetch it').toBe(2);
});
