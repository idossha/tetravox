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
import { OPEN_FILTERS } from './menu';

const BUILDER = readFileSync(
  fileURLToPath(new URL('../../electron-builder.yml', import.meta.url)),
  'utf8'
);

/** Every extension any filter offers, lowercased. */
const OFFERED = new Set(OPEN_FILTERS.flatMap((f) => f.extensions.map((e) => e.toLowerCase())));

describe('the Open dialog', () => {
  it('offers every format the readers support', () => {
    for (const ext of ['nii', 'gz', 'msh', 'gii', 'geo', 'pos']) {
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
});

describe('the installer’s file associations', () => {
  it('registers .geo and .pos', () => {
    expect(BUILDER).toMatch(/- ext: geo\b/);
    expect(BUILDER).toMatch(/- ext: pos\b/);
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
});
