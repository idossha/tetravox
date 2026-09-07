/**
 * Sidecar discovery for `LoadSource.sidecars` (§6.5.1, §7.6).
 *
 * §7.6: "Auto-associate `<volume>_LUT.txt` or `<volume>.txt` next to the volume"; `<mesh>.msh.opt`
 * seeds tag colours. §5 rule 9's Phase-1 consequence is what makes this the *app's* job: sidecars are
 * derived sibling paths, not paths the user named, so they must be added to the `tetravox://file/…`
 * allow-list at the same time as the dataset — and `allowPath` returning null is also how the
 * renderer learns a candidate does not exist, without ever touching the filesystem itself.
 *
 * Pure string work, deliberately: it is unit-testable without a disk.
 */

/** Strip the extensions a NIfTI/Gmsh/GIfTI name can carry, longest compound suffix first. */
export function stripKnownExtension(path: string): string {
  for (const ext of [
    '.nii.gz',
    '.mgz',
    '.mgh',
    '.nrrd',
    '.mha',
    '.nii',
    '.msh',
    '.gii',
    '.vtk',
    '.vtu',
    '.vtp',
    '.stl',
    '.ply',
    '.obj',
    '.off',
    '.mesh',
    '.geo',
    '.pos',
  ]) {
    if (path.toLowerCase().endsWith(ext)) return path.slice(0, path.length - ext.length);
  }
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return dot > slash + 1 ? path.slice(0, dot) : path;
}

export interface SidecarCandidates {
  /** Colour/label lookup tables, most specific first (§7.6). */
  lut: string[];
  /** Gmsh `.msh.opt` (§6.2). Empty for volumes. */
  opt: string[];
}

/**
 * The sibling paths worth trying for `path`, most specific first.
 *
 * Order matters: `<stem>_LUT.txt` before `<stem>.txt`, because `T1.txt` next to `T1.nii.gz` is far
 * more likely to be a note than a LUT, and the caller takes the first one that exists.
 */
export function deriveSidecarCandidates(path: string): SidecarCandidates {
  const stem = stripKnownExtension(path);
  const lower = path.toLowerCase();
  const lut = [`${stem}_LUT.txt`, `${stem}.txt`];
  const opt = lower.endsWith('.msh') ? [`${path}.opt`, `${stem}.opt`] : [];
  return { lut, opt };
}

/** The basename shown on the load card and the layer row. */
export function baseName(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash === -1 ? path : path.slice(slash + 1);
}

/** The FreeSurfer morph files a `.gii`-less name can be, by their conventional extensions. */
const MORPH_EXTENSIONS = ['.curv', '.sulc', '.thickness', '.area', '.volume', '.jacobian_white'];

/**
 * A file that is per-vertex **data for a surface**, not a dataset (§6.2, 2026-09-06): a `.annot`,
 * a FreeSurfer morph file, or a GIfTI whose name says it carries no geometry. Such a file is
 * attached to an open surface (`Engine.attachSurfaceData`) rather than opened on its own — opened
 * on its own, a `.annot` is "unrecognised mesh format" and a `.func.gii` an empty mesh.
 */
export function isSurfaceDataName(path: string): boolean {
  const lower = baseName(path).toLowerCase();
  if (lower.endsWith('.annot')) return true;
  if (lower.endsWith('.func.gii') || lower.endsWith('.shape.gii') || lower.endsWith('.label.gii')) {
    return true;
  }
  return MORPH_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** `lh` / `rh` from a FreeSurfer-style name (`lh.pial.gii`, `lh.ernie_DK40.annot`), else null. */
export function hemisphereOf(path: string): 'lh' | 'rh' | null {
  const lower = baseName(path).toLowerCase();
  if (lower.startsWith('lh.')) return 'lh';
  if (lower.startsWith('rh.')) return 'rh';
  return null;
}
