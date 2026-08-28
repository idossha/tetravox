/**
 * Discovery of the **fsaverage correspondence files** for a subject surface (§3, directed task 8).
 *
 * The sibling of `main/subject-spaces.ts`, and it exists for the same §5 reason: everything here is
 * a filesystem question about paths *beside* and *unrelated to* the file the user opened, and the
 * renderer has no filesystem. Nothing here reads a surface — it returns paths, admitted to the
 * `tetravox://file/…` allow-list, and the dataset workers fetch them (§5 rule 3).
 *
 * ## What has to line up
 *
 * A pick on `m2m_ernie/surfaces/lh.central.gii` reports an fsaverage vertex through **four** files:
 *
 * | File | Role |
 * |---|---|
 * | `<m2m>/surfaces/lh.central.gii` | what is on screen; supplies the vertex index |
 * | `<m2m>/surfaces/lh.sphere.reg.gii` | the same hemisphere, registered to fsaverage's sphere |
 * | `<subjects>/fsaverage/surf/lh.sphere` | the target sphere the lookup runs against |
 * | `<subjects>/fsaverage/surf/lh.pial` | the surface whose coordinate is quoted |
 *
 * The first two share a node numbering — every surface of one hemisphere of one SimNIBS subject
 * carries 245,762 nodes `[DATA]` — which is what makes "vertex 40188" mean the same thing on both.
 * The engine checks that rather than trusting it (`Engine.attachFsaverage`).
 *
 * **The hemisphere comes from the file name**, `lh.` or `rh.`, because that is the only place it is
 * written down: a GIfTI pointset carries no `AnatomicalStructurePrimary` in SimNIBS's output. A
 * surface whose name does not start with a hemisphere prefix simply has no correspondence, which is
 * the same answer as "the subjects directory is unset".
 *
 * **Nothing is bundled.** `fsaverage` is FreeSurfer's, ~50 MB of surfaces per hemisphere, and every
 * machine that wants this feature already has a copy. The path is an app setting
 * (`AppSettings.freesurferSubjectsDir`); when it is empty, or the files under it are not there, the
 * readout omits the fsaverage row rather than reporting anything.
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type Hemisphere = 'lh' | 'rh';

export interface SurfaceSpaceFiles {
  hemisphere: Hemisphere;
  /** `<m2m>/surfaces/<hemi>.sphere.reg.gii`, absolute. */
  subjectSphere: string;
  /** `<subjects>/fsaverage/surf/<hemi>.sphere`, absolute. */
  fsavgSphere: string;
  /** `<subjects>/fsaverage/surf/<hemi>.pial`, absolute — the coordinate that is quoted. */
  fsavgSurface?: string;
  /** What to call the target in the readout, e.g. `fsaverage lh.pial`. */
  targetName: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The hemisphere a surface file name declares, or null when it declares none. */
export function hemisphereOf(path: string): Hemisphere | null {
  const name = basename(path).toLowerCase();
  if (name.startsWith('lh.')) return 'lh';
  if (name.startsWith('rh.')) return 'rh';
  return null;
}

/**
 * The subject's registered sphere for `surfacePath`'s hemisphere, beside it.
 *
 * Both spellings are looked for: SimNIBS writes `lh.sphere.reg.gii`, FreeSurfer's own `surf/`
 * directory writes the extensionless binary `lh.sphere.reg`. The reader sniffs the format either
 * way (`tvx_mesh_io::sniff`), so the only question here is which name is on disk.
 */
export function subjectSphereFor(surfacePath: string, hemi: Hemisphere): string | null {
  const dir = dirname(surfacePath);
  for (const name of [`${hemi}.sphere.reg.gii`, `${hemi}.sphere.reg`]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Everything the fsaverage lookup needs for one surface, or null when any required piece is missing.
 *
 * `subjectsDir` is the setting. Both `<subjectsDir>/fsaverage/surf` and a `subjectsDir` that already
 * *is* an `fsaverage` directory are accepted, because a user asked for "the subjects directory" will
 * sometimes hand over the subject itself and being wrong about which is not worth a failure.
 */
export function discoverSurfaceSpaces(
  surfacePath: string,
  subjectsDir: string
): SurfaceSpaceFiles | null {
  if (subjectsDir.length === 0) return null;
  const hemisphere = hemisphereOf(surfacePath);
  if (hemisphere === null) return null;

  const subjectSphere = subjectSphereFor(surfacePath, hemisphere);
  if (subjectSphere === null) return null;
  // A surface picked from `fsaverage/surf` itself would map to its own vertices; harmless, but it is
  // not what the feature is for, and it doubles the load for nothing.
  if (subjectSphere === surfacePath) return null;

  const surfDir = isDir(join(subjectsDir, 'fsaverage', 'surf'))
    ? join(subjectsDir, 'fsaverage', 'surf')
    : isDir(join(subjectsDir, 'surf'))
      ? join(subjectsDir, 'surf')
      : null;
  if (surfDir === null) return null;

  const fsavgSphere = join(surfDir, `${hemisphere}.sphere`);
  if (!existsSync(fsavgSphere)) return null;

  const out: SurfaceSpaceFiles = {
    hemisphere,
    subjectSphere,
    fsavgSphere,
    targetName: `fsaverage ${hemisphere}.sphere`,
  };
  // `pial` first, then `white`: a coordinate on the pial surface is the one a reader recognises, and
  // it is the surface FreeSurfer's own coordinate reports are quoted against.
  for (const name of [`${hemisphere}.pial`, `${hemisphere}.white`]) {
    const candidate = join(surfDir, name);
    if (existsSync(candidate)) {
      out.fsavgSurface = candidate;
      out.targetName = `fsaverage ${name}`;
      break;
    }
  }
  return out;
}
