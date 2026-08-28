/**
 * Discovery of a subject's **template registration** on disk (§8's MNI spaces, directed task 8).
 *
 * §5 keeps the filesystem in main, and this is a filesystem question the load path cannot answer: a
 * SimNIBS registration lives in a `toMNI/` folder *beside* the volume, not inside it, so nothing
 * that parses `T1.nii.gz` ever learns it exists. The renderer hands main a path it already opened
 * and gets back the small facts — an affine as **text**, and allow-listed URLs for the two warp
 * fields, which the dataset worker then fetches over `tetravox://file/…` like any other volume.
 *
 * Nothing here reads a `.nii.gz`. The only bytes that cross the bridge are the ≤ 1 KB affine text
 * file; the 97 MB and 230 MB warps are named, never copied (§5 rule 3, AGENTS rule 7).
 *
 * **What SimNIBS writes, and what it means** (`simnibs/utils/file_finder.py`,
 * `simnibs/utils/transformations.py`, both read at 4.6):
 *
 * | File | Direction | Used for |
 * |---|---|---|
 * | `MNI2conform_6DOF.txt` / `.mat` | MNI → subject | subject → MNI is `inv()` of it |
 * | `MNI2conform_12DOF.txt` / `.mat` | MNI → subject | ditto; preferred over 6-DOF |
 * | `Conform2MNI_nonl.nii.gz` | subject → MNI | the forward warp, sampled trilinearly |
 * | `MNI2Conform_nonl.nii.gz` | MNI → subject | the return warp, for typed entry |
 *
 * **SimNIBS 4 writes neither `.txt`** — `charm` produces only the two warps, and
 * `subject2mni_coords(..., '12dof')` raises `FileNotFoundError` on the reference subject `[DATA]`.
 * The affine is still looked for because SimNIBS 3 / `headreco` subjects have it and nothing else,
 * and because a `.mat` written by a different pipeline lands in the same place.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Bigger than any 4×4 text matrix by three orders of magnitude; a guard, not a budget. */
const MAX_AFFINE_BYTES = 64 * 1024;

/** How many ancestors of the volume are searched for a `toMNI/`. `m2m_x/segmentation/labeling.nii.gz`
 * is two up; a simulation output under `Simulations/<name>/TI/niftis/` is four but belongs to a
 * *different* directory tree, so the walk stops at the first hit and never leaves an `m2m_*`. */
const MAX_ASCENT = 3;

export interface SubjectSpaceFiles {
  /** The directory holding `toMNI/` — normally `m2m_<subject>`. */
  subjectDir: string;
  /** `toMNI/`. */
  toMniDir: string;
  /** The affine as it is written on disk, MNI → subject, with the file it came from. */
  affine?: { file: string; text: string };
  /** `toMNI/Conform2MNI_nonl.nii.gz`, absolute — subject → MNI. */
  forwardField?: string;
  /** `toMNI/MNI2Conform_nonl.nii.gz`, absolute — MNI → subject. */
  inverseField?: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find the `toMNI/` that governs `volumePath`, or an explicit folder the user pointed at.
 *
 * `explicit` is either a `toMNI` directory or the `m2m_*` above it — both are accepted, because a
 * user asked to "point at the transforms" will do one or the other and being wrong about which is
 * not an error worth reporting.
 */
export function discoverSubjectSpaces(
  volumePath: string,
  explicit?: string
): SubjectSpaceFiles | null {
  let toMniDir: string | null = null;

  if (explicit !== undefined && explicit.length > 0) {
    if (basename(explicit) === 'toMNI' && isDir(explicit)) toMniDir = explicit;
    else if (isDir(join(explicit, 'toMNI'))) toMniDir = join(explicit, 'toMNI');
    if (toMniDir === null) return null;
  } else {
    let dir = dirname(volumePath);
    for (let i = 0; i <= MAX_ASCENT; i += 1) {
      const candidate = join(dir, 'toMNI');
      if (isDir(candidate)) {
        toMniDir = candidate;
        break;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (toMniDir === null) return null;
  }

  const out: SubjectSpaceFiles = { subjectDir: dirname(toMniDir), toMniDir };

  // 12-DOF first: it is the more general registration, and SimNIBS itself defaults to the
  // higher-DOF transform whenever a caller does not name one.
  for (const stem of ['MNI2conform_12DOF', 'MNI2conform_6DOF']) {
    for (const ext of ['.txt', '.mat']) {
      const p = join(toMniDir, stem + ext);
      if (!existsSync(p)) continue;
      try {
        if (statSync(p).size > MAX_AFFINE_BYTES) continue;
        out.affine = { file: stem + ext, text: readFileSync(p, 'utf8') };
      } catch {
        // An unreadable transform is a missing transform; the readout says so.
      }
      break;
    }
    if (out.affine !== undefined) break;
  }

  const forward = join(toMniDir, 'Conform2MNI_nonl.nii.gz');
  if (existsSync(forward)) out.forwardField = forward;
  const inverse = join(toMniDir, 'MNI2Conform_nonl.nii.gz');
  if (existsSync(inverse)) out.inverseField = inverse;

  // A `toMNI/` with nothing usable in it is the same as no `toMNI/` at all.
  if (out.affine === undefined && out.forwardField === undefined) return null;
  return out;
}
