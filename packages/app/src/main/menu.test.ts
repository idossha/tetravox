/**
 * The Open dialog's filters, and the installer's file associations — one list of formats, in two
 * files that must agree (§8, §12.3).
 *
 * A unit test rather than an e2e leg: `OPEN_FILTERS` is a constant in main, and driving an
 * OS-modal dialog to read it back would be testing Electron. What matters is that a format the
 * reader supports is a format the user can reach, from both directions.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPEN_FILTERS, isScenePath, splitScenes } from './menu';

const BUILDER = readFileSync(
  fileURLToPath(new URL('../../electron-builder.yml', import.meta.url)),
  'utf8'
);

/** Every extension any filter offers, lowercased. */
const OFFERED = new Set(OPEN_FILTERS.flatMap((f) => f.extensions.map((e) => e.toLowerCase())));

describe('the Open dialog', () => {
  it('offers every format the readers support', () => {
    for (const ext of [
      'nii',
      'gz',
      'mgh',
      'mgz',
      'nrrd',
      'mha',
      'msh',
      'gii',
      'vtk',
      'vtu',
      'vtp',
      'stl',
      'ply',
      'obj',
      'off',
      'mesh',
      'geo',
      'pos',
    ]) {
      expect(OFFERED.has(ext), ext).toBe(true);
    }
  });

  it('has a filter dedicated to Gmsh parsed views, so a net is one click away', () => {
    const view = OPEN_FILTERS.find(
      (f) =>
        f.extensions.includes('geo') && f.extensions.includes('pos') && f.extensions.length === 2
    );
    expect(view, 'a `.geo`/`.pos`-only filter').toBeDefined();
  });

  it('still ends with the escape hatch', () => {
    expect(OPEN_FILTERS[OPEN_FILTERS.length - 1]?.extensions).toEqual(['*']);
  });

  /**
   * Contact tables (§5 rule 11, §13). A `.tsv` reaches no dataset reader — a module claims the path
   * and reads its text over `tetravox:module-read-text` — so this filter exists to make the file
   * *reachable* from ⌘O. It is deliberately its own entry rather than an addition to the combined
   * "Volumes, meshes and scenes" filter, whose name would then be wrong.
   */
  it('offers electrode tables as their own filter', () => {
    const tables = OPEN_FILTERS.find((f) => f.name.startsWith('Electrode tables'));
    expect(tables?.extensions).toEqual(['tsv', 'csv', 'fcsv']);
    for (const ext of ['tsv', 'csv', 'fcsv']) expect(OFFERED.has(ext), ext).toBe(true);
    const combined = OPEN_FILTERS[0];
    expect(combined?.name).toBe('Volumes, meshes and scenes');
    expect(combined?.extensions).not.toContain('tsv');
  });
});

describe('the installer’s file associations', () => {
  it('registers .geo and .pos', () => {
    expect(BUILDER).toMatch(/- ext: geo\b/);
    expect(BUILDER).toMatch(/- ext: pos\b/);
  });

  it('registers the other volume and mesh formats the readers support', () => {
    for (const ext of [
      'mgz',
      'mgh',
      'nrrd',
      'mha',
      'vtk',
      'vtu',
      'vtp',
      'stl',
      'ply',
      'obj',
      'off',
    ]) {
      expect(BUILDER, ext).toMatch(new RegExp(`- ext: ${ext}\\b`));
    }
  });

  /**
   * `.geo` is **not** `rank: Owner`. The extension is shared with Gmsh's geometry-script language,
   * which this app does not open, so claiming to be the system-wide handler for every `.geo` on the
   * machine would hijack files it then refuses (`docs/DECISIONS.md`, 2026-08-28).
   */
  it('claims .pos but not .geo as the system-wide handler', () => {
    const block = (ext: string): string =>
      BUILDER.slice(BUILDER.indexOf(`- ext: ${ext}\n`), BUILDER.indexOf(`- ext: ${ext}\n`) + 260);
    expect(block('geo')).toContain('rank: Default');
    expect(block('pos')).toContain('rank: Owner');
  });

  /**
   * The same argument, one step further (2026-08-30): a contact table is offered in the Open dialog
   * and is registered with the OS **not at all**. `.tsv` and `.csv` belong to every spreadsheet on
   * the machine, and this app opens one only through a module that claims the name.
   */
  it('registers no association for the electrode-table extensions', () => {
    for (const ext of ['tsv', 'csv', 'fcsv']) {
      expect(BUILDER, ext).not.toMatch(new RegExp(`- ext: ${ext}\\b`));
    }
  });
});

/**
 * Scene files take the **scene** route (directed task 13): `sendOpened` splits them off so that one
 * set of doors — the menu, a drop, argv, `open-file`, a second instance — serves both kinds, and the
 * renderer never sniffs a filename to decide which of the two a path is.
 */
describe('scene files among the opened paths', () => {
  it('recognises `*.tetravox.json` and nothing else', () => {
    expect(isScenePath('/a/b/study.tetravox.json')).toBe(true);
    expect(isScenePath('study.TETRAVOX.JSON')).toBe(true);
    expect(isScenePath('C:\\scenes\\study.tetravox.json')).toBe(true);
    // §7.6's user colormaps are `.json` too. Opening one as a scene would report "no datasets
    // array" instead of loading a colormap, so the whole compound suffix is what is matched.
    expect(isScenePath('/luts/hot.json')).toBe(false);
    expect(isScenePath('/data/tetravox.json.nii.gz')).toBe(false);
    expect(isScenePath('/data/ernie.msh')).toBe(false);
  });

  it('splits a mixed selection, keeping each side in order', () => {
    const { data, scenes } = splitScenes([
      '/d/T1.nii.gz',
      '/d/a.tetravox.json',
      '/d/ernie.msh',
      '/d/b.tetravox.json',
    ]);
    expect(data).toEqual(['/d/T1.nii.gz', '/d/ernie.msh']);
    expect(scenes).toEqual(['/d/a.tetravox.json', '/d/b.tetravox.json']);
  });

  it('offers scenes in the Open dialog, so ⌘O opens one like any other file', () => {
    expect(OFFERED.has('json')).toBe(true);
  });

  it('is a file association the installer registers', () => {
    expect(BUILDER).toContain('ext: tetravox.json');
  });
});
