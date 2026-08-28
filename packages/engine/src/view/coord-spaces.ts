/**
 * The **space selector** behind §8's coordinate bar and §4.7's `ProbeResult` (directed task 8).
 *
 * `spaces.ts` is the arithmetic; this file is the policy: which spaces a given scene can offer, what
 * each is called, which one a triple typed into the bar belongs to, and what happens when the answer
 * is "not yet" or "not for this subject". It takes a plain `Scene` and returns plain data — no GL,
 * no engine instance — so `engine.ts`, the app's `NoGlEngine` and the unit tests all read the same
 * policy instead of three copies of it.
 *
 * **Which volume?** Every space but world RAS belongs to a *volume*: a voxel index obviously, a
 * tkr-RAS because `vox2ras-tkr` is built from dims and spacing, and MNI because the registration was
 * computed for one subject's conform grid. The menu therefore lists the **active layer's** volume
 * first and then the rest top-to-bottom, and every entry carries its `datasetId` — so switching the
 * active layer re-orders the menu without silently re-pointing the space the user chose.
 */

import type { Dataset, DatasetId, Scene, TemplateSpace, VolumeDataset, vec3 } from '../scene/types';
import type { CoordSpaceOption, CoordSpaceRef } from '../api';
import { transformPoint } from './m4';
import { sampleDeformation, tkrToWorldMatrix, worldToTkrMatrix } from './spaces';

function isVolume(ds: Dataset | undefined): ds is VolumeDataset {
  return ds !== undefined && ds.kind === 'volume';
}

/**
 * Volumes in menu order: the active layer's first, then every other volume layer top-to-bottom,
 * then any volume dataset with no layer at all.
 *
 * The last group exists because a SimNIBS deformation field is loaded as a dataset with **no layer**
 * (nobody wants to look at it) — it must not appear in the menu itself, which is why
 * {@link coordinateSpaceOptions} filters it out by `isDeformationField`, but the same traversal is
 * the one that finds a subject volume that has been hidden rather than closed.
 */
export function volumesInMenuOrder(scene: Scene): VolumeDataset[] {
  const out: VolumeDataset[] = [];
  const seen = new Set<DatasetId>();
  const push = (ds: VolumeDataset | undefined): void => {
    if (ds === undefined || seen.has(ds.id)) return;
    seen.add(ds.id);
    out.push(ds);
  };

  const active = scene.layers.find((l) => l.id === scene.activeLayerId);
  if (active !== undefined) {
    const ds = scene.datasets.get(active.datasetId);
    if (isVolume(ds)) push(ds);
  }
  for (let i = scene.layers.length - 1; i >= 0; i -= 1) {
    const l = scene.layers[i];
    if (l === undefined) continue;
    const ds = scene.datasets.get(l.datasetId);
    if (isVolume(ds)) push(ds);
  }
  for (const ds of scene.datasets.values()) if (isVolume(ds)) push(ds);
  return out;
}

/**
 * A 4-D, three-volume dataset that some other volume names as its deformation field.
 *
 * It is a real dataset — it went through the ordinary §5 load path — but it is *plumbing*, and
 * offering "Voxel · Conform2MNI_nonl" in the space selector would be noise. Identified by being
 * referenced, not by its name, because a user may have renamed the file.
 */
export function isDeformationField(scene: Scene, id: DatasetId): boolean {
  for (const ds of scene.datasets.values()) {
    if (!isVolume(ds) || ds.toTemplate === undefined) continue;
    if (ds.toTemplate.forwardFieldId === id || ds.toTemplate.inverseFieldId === id) return true;
  }
  return false;
}

/** The volume whose tkr / MNI spaces the `ProbeResult` reports: the first in menu order. */
export function referenceVolume(scene: Scene): VolumeDataset | null {
  for (const ds of volumesInMenuOrder(scene)) {
    if (!isDeformationField(scene, ds.id)) return ds;
  }
  return null;
}

function field(scene: Scene, id: DatasetId | undefined): VolumeDataset | null {
  if (id === undefined) return null;
  const ds = scene.datasets.get(id);
  return isVolume(ds) && ds.nvols >= 3 ? ds : null;
}

/** The volume a `CoordSpaceRef` names, or null when it has been closed since the menu was built. */
function volumeOf(scene: Scene, ref: CoordSpaceRef): VolumeDataset | null {
  if (ref.space === 'world') return null;
  const ds = scene.datasets.get(ref.datasetId);
  return isVolume(ds) ? ds : null;
}

/** World RAS mm → `ref`'s space, or null when the reference no longer resolves. */
export function toSpace(scene: Scene, ref: CoordSpaceRef, world: vec3): vec3 | null {
  if (ref.space === 'world') return world;
  const ds = volumeOf(scene, ref);
  if (ds === null) return null;
  switch (ref.space) {
    case 'voxel':
      return transformPoint(ds.inverseAffine, world);
    case 'tkr':
      return transformPoint(worldToTkrMatrix(ds), world);
    case 'mni-affine': {
      const t = ds.toTemplate;
      if (t === undefined || t.hasAffine === false) return null;
      return transformPoint(t.matrix, world);
    }
    case 'mni-nonlinear': {
      const f = field(scene, ds.toTemplate?.forwardFieldId);
      return f === null ? null : sampleDeformation(f, world);
    }
  }
}

/**
 * `ref`'s space → world RAS mm, for Enter and paste in §8's coordinate bar.
 *
 * The nonlinear leg is the interesting one: it is **not** an inversion of the forward field, and it
 * is not a fixed-point iteration either. SimNIBS ships the opposite warp as its own file
 * (`toMNI/MNI2Conform_nonl.nii.gz`), so typed entry is a forward trilinear sample of *that* — exact
 * to the same tolerance as the outbound direction. When only the forward field was loaded there is
 * no honest answer, and this returns null rather than a guess.
 */
export function fromSpace(scene: Scene, ref: CoordSpaceRef, value: vec3): vec3 | null {
  if (ref.space === 'world') return value;
  const ds = volumeOf(scene, ref);
  if (ds === null) return null;
  switch (ref.space) {
    case 'voxel':
      return transformPoint(ds.affine, value);
    case 'tkr':
      return transformPoint(tkrToWorldMatrix(ds), value);
    case 'mni-affine': {
      const t = ds.toTemplate;
      if (t === undefined || t.hasAffine === false) return null;
      // A singular registration cannot accept input; jumping to the wrong place is worse than
      // refusing to jump (the rule `lib/coords.ts` already applies to the affine column).
      const inv = invertOrNull(t.matrix);
      return inv === null ? null : transformPoint(inv, value);
    }
    case 'mni-nonlinear': {
      const f = field(scene, ds.toTemplate?.inverseFieldId);
      return f === null ? null : sampleDeformation(f, value);
    }
  }
}

/** `invert4` substitutes identity for a singular matrix; here a singular matrix must be visible. */
function invertOrNull(m: Float32Array): Float32Array | null {
  const a = Array.from(m);
  const inv = new Float32Array(16);
  // Standard cofactor inverse of a column-major 4×4 (the same one `app/lib/coords.ts` uses).
  const at = (i: number): number => a[i] as number;
  const b00 = at(0) * at(5) - at(1) * at(4);
  const b01 = at(0) * at(6) - at(2) * at(4);
  const b02 = at(0) * at(7) - at(3) * at(4);
  const b03 = at(1) * at(6) - at(2) * at(5);
  const b04 = at(1) * at(7) - at(3) * at(5);
  const b05 = at(2) * at(7) - at(3) * at(6);
  const b06 = at(8) * at(13) - at(9) * at(12);
  const b07 = at(8) * at(14) - at(10) * at(12);
  const b08 = at(8) * at(15) - at(11) * at(12);
  const b09 = at(9) * at(14) - at(10) * at(13);
  const b10 = at(9) * at(15) - at(11) * at(13);
  const b11 = at(10) * at(15) - at(11) * at(14);
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || det === 0) return null;
  const d = 1 / det;
  const v = [
    (at(5) * b11 - at(6) * b10 + at(7) * b09) * d,
    (at(2) * b10 - at(1) * b11 - at(3) * b09) * d,
    (at(13) * b05 - at(14) * b04 + at(15) * b03) * d,
    (at(10) * b04 - at(9) * b05 - at(11) * b03) * d,
    (at(6) * b08 - at(4) * b11 - at(7) * b07) * d,
    (at(0) * b11 - at(2) * b08 + at(3) * b07) * d,
    (at(14) * b02 - at(12) * b05 - at(15) * b01) * d,
    (at(8) * b05 - at(10) * b02 + at(11) * b01) * d,
    (at(4) * b10 - at(5) * b08 + at(7) * b06) * d,
    (at(1) * b08 - at(0) * b10 - at(3) * b06) * d,
    (at(12) * b04 - at(13) * b02 + at(15) * b00) * d,
    (at(9) * b02 - at(8) * b04 - at(11) * b00) * d,
    (at(5) * b07 - at(4) * b09 - at(6) * b06) * d,
    (at(0) * b09 - at(1) * b07 + at(2) * b06) * d,
    (at(13) * b01 - at(12) * b03 - at(14) * b00) * d,
    (at(8) * b03 - at(9) * b01 + at(10) * b00) * d,
  ];
  inv.set(v);
  return inv;
}

/**
 * Every space the selector should offer, in menu order.
 *
 * A space whose transform is not usable is **listed and disabled with a reason**, never hidden —
 * §8's existing rule for the MNI column, applied to all of them. `pendingFields` are dataset ids the
 * host is still loading, so "MNI (nonlinear)" reads "loading the deformation field…" instead of
 * "not available" during the seconds a 97 MB warp takes to arrive.
 */
export function coordinateSpaceOptions(
  scene: Scene,
  pendingFields: ReadonlySet<DatasetId> = new Set()
): CoordSpaceOption[] {
  // `pendingFields` is the host's in-flight set. `TemplateSpace.nonlinearAvailable` already says a
  // warp exists on disk, which is the stronger signal; this only sharpens "loading" for a field
  // whose id is known because a scene named it.
  void pendingFields;
  const options: CoordSpaceOption[] = [
    { ref: { space: 'world' }, label: 'World RAS', decimals: 1, enabled: true },
  ];

  const volumes = volumesInMenuOrder(scene).filter((ds) => !isDeformationField(scene, ds.id));
  for (const ds of volumes) {
    options.push({
      ref: { space: 'voxel', datasetId: ds.id },
      label: `Voxel · ${ds.name}`,
      decimals: 0,
      enabled: true,
    });
    options.push({
      ref: { space: 'tkr', datasetId: ds.id },
      label: `tkr-RAS · ${ds.name}`,
      decimals: 1,
      enabled: true,
    });
  }

  // MNI is per subject, not per volume, so only the reference volume contributes it — otherwise a
  // scene with a T1 and a TI field on the same subject would offer the same registration twice.
  const ref = volumes[0];
  const template: TemplateSpace | undefined = ref?.toTemplate;
  if (ref !== undefined && template !== undefined) {
    options.push({
      ref: { space: 'mni-affine', datasetId: ref.id },
      label: `${template.name} (affine)`,
      decimals: 1,
      enabled: template.hasAffine !== false,
      ...(template.hasAffine === false
        ? { reason: 'this subject has no MNI2conform_*DOF affine — SimNIBS 4 writes only the warp' }
        : template.affineFile !== undefined
          ? { reason: `via ${template.affineFile}` }
          : {}),
    });
    const ready = field(scene, template.forwardFieldId) !== null;
    const onDisk = template.nonlinearAvailable === true;
    // Enabled as soon as the file is known to exist, not once it has loaded: selecting the space is
    // what *starts* the load, and a disabled `<option>` cannot be selected.
    options.push({
      ref: { space: 'mni-nonlinear', datasetId: ref.id },
      label: `${template.name} (nonlinear)`,
      decimals: 1,
      enabled: ready || onDisk,
      ...(!ready && onDisk ? { loading: true, reason: 'loading Conform2MNI_nonl.nii.gz…' } : {}),
      ...(!ready && !onDisk ? { reason: 'no Conform2MNI_nonl.nii.gz for this subject' } : {}),
    });
  }
  return options;
}

/** The template / tkr fields of a `ProbeResult` for one world point. */
export function probeSpaces(
  scene: Scene,
  world: vec3
): { tkr?: vec3; tkrVolume?: string; mni?: vec3; mniNonlinear?: vec3 } {
  const ref = referenceVolume(scene);
  if (ref === null) return {};
  const out: { tkr?: vec3; tkrVolume?: string; mni?: vec3; mniNonlinear?: vec3 } = {
    tkr: transformPoint(worldToTkrMatrix(ref), world),
    tkrVolume: ref.name,
  };
  // The affine column keeps Phase 2's fallback — ANY volume carrying one, not just the reference —
  // because that is what `templateSource` in the app has always shown and a scene may hold an
  // MNI-space overlay on top of a subject volume.
  for (const ds of volumesInMenuOrder(scene)) {
    const t = ds.toTemplate;
    if (t === undefined) continue;
    if (out.mni === undefined && t.hasAffine !== false) out.mni = transformPoint(t.matrix, world);
    if (out.mniNonlinear === undefined) {
      const f = field(scene, t.forwardFieldId);
      if (f !== null) {
        const v = sampleDeformation(f, world);
        if (v !== null) out.mniNonlinear = v;
      }
    }
  }
  return out;
}
