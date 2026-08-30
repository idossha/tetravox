/**
 * Module file IO (§5 rule 11): the policy, not the plumbing.
 *
 * Every assertion here is about a refusal or an admission — which templates a module may declare,
 * which paths a write may land on, which files a read will answer for — because that policy *is* the
 * feature: the channels themselves are four `ipcMain.handle` lines. `electron` is mocked (there is
 * no app, no window and no OS dialog under vitest) and the filesystem is real, in a temp directory,
 * so the `.part`-then-rename and the `.bak` copy are the ones the product performs.
 *
 * `sample-data.test.ts` is the nearest template: main-process unit tests, a temp directory, a
 * mocked `electron`, and no network or window anywhere.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  // `protocol.ts` imports both at module scope for `handleScheme`, which nothing here calls.
  net: {},
  protocol: {},
}));

import { dialog } from 'electron';
import { allowPath, clearAllowList } from './paths';
import {
  MAX_MODULE_READ_BYTES,
  MAX_MODULE_WRITE_BYTES,
  MODULE_READ_EXTENSIONS,
  admitModuleWrite,
  clearModuleWriteLists,
  isModuleWritable,
  isSiblingTemplate,
  moduleReadText,
  moduleSaveDialog,
  moduleWriteText,
  shouldPromptOnClose,
  stampNow,
  stemOf,
  substituteSibling,
} from './module-io';

const SEEG = 'tetravox.seeg';
const OTHER = 'tetravox.other';
/** The two templates the design's sEEG writer declares. */
const BAK = '{name}.{stamp}.bak';
const EDITLOG = '{stem}_editlog.json';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tvx-module-io-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clearModuleWriteLists();
  clearAllowList();
  vi.mocked(dialog.showSaveDialog).mockReset();
});

/** A file in the temp directory, created and admitted for **reading** the way a user gesture would. */
function fixture(name: string, text = 'x\ty\tz\n'): string {
  const path = join(dir, name);
  writeFileSync(path, text, 'utf8');
  const real = allowPath(path);
  if (real === null) throw new Error(`could not allow-list ${path}`);
  return real;
}

/** Point the Save sheet at a path, the way `app.evaluate` does in the e2e. */
function saveSheetReturns(path: string | null): void {
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({
    canceled: path === null,
    ...(path === null ? {} : { filePath: path }),
  } as Awaited<ReturnType<typeof dialog.showSaveDialog>>);
}

// ------------------------------------------------------------------------------------------------

describe('the sibling template rule (contracts §2)', () => {
  it('accepts the templates a writer is meant to declare', () => {
    for (const template of [BAK, EDITLOG, '{name}.bak', 'notes.txt', '{stem}-QC_v1.2.json']) {
      expect(isSiblingTemplate(template), template).toBe(true);
    }
  });

  it('refuses anything with a separator, a traversal or an exotic character in it', () => {
    for (const template of [
      '../{name}.bak',
      'sub/{name}.bak',
      'sub\\{name}.bak',
      '/etc/passwd',
      '{name} copy.bak', // a space is not in the class
      '{name}.bak;rm', // nor is a semicolon
      `${'a'.repeat(97)}`, // 96 characters is the cap
      '',
    ]) {
      expect(isSiblingTemplate(template), template).toBe(false);
    }
  });

  it('refuses a substitution that turns into a traversal or an unknown token', () => {
    // The template passes; the *anchor* is what would have escaped the directory. Neither end is
    // trusted, which is why both are checked.
    expect(substituteSibling('{name}.bak', '../etc/passwd', '20260830-101500')).toBeNull();
    expect(substituteSibling('{name}.bak', '..', '20260830-101500')).toBeNull();
    // An unknown token survives the one substitution pass and is caught by the brace check.
    expect(substituteSibling('{sub}_electrodes.tsv', 'a.tsv', '20260830-101500')).toBeNull();
    // A traversal spelled by the template itself never reaches substitution.
    expect(substituteSibling('../{name}', 'a.tsv', '20260830-101500')).toBeNull();
  });

  it('substitutes {name}, {stem} and {stamp}', () => {
    const stamp = '20260830-101500';
    expect(substituteSibling(BAK, 'sub-01_electrodes.tsv', stamp)).toBe(
      'sub-01_electrodes.tsv.20260830-101500.bak'
    );
    expect(substituteSibling(EDITLOG, 'sub-01_electrodes.tsv', stamp)).toBe(
      'sub-01_electrodes_editlog.json'
    );
  });

  it('reads a stem as the name without its extension chain', () => {
    expect(stemOf('sub-01_electrodes.tsv')).toBe('sub-01_electrodes');
    expect(stemOf('sub-01_acq-bone_ct.nii.gz')).toBe('sub-01_acq-bone_ct');
    expect(stemOf('no-extension')).toBe('no-extension');
    expect(stemOf('.hidden')).toBe('.hidden');
  });

  it('stamps a sortable local timestamp', () => {
    expect(stampNow(new Date(2026, 7, 30, 9, 5, 4))).toBe('20260830-090504');
    expect(stampNow()).toMatch(/^\d{8}-\d{6}$/);
  });
});

describe('the module write list', () => {
  it('admits the chosen path and the writer’s siblings, and nothing else', () => {
    const target = join(dir, 'sub-01_electrodes.tsv');
    const admitted = admitModuleWrite(SEEG, target, [BAK, EDITLOG]);
    expect(admitted?.path).toBe(target);
    expect(admitted?.siblings[EDITLOG]).toBe(join(dir, 'sub-01_electrodes_editlog.json'));
    expect(admitted?.siblings[BAK]).toMatch(/sub-01_electrodes\.tsv\.\d{8}-\d{6}\.bak$/);

    expect(isModuleWritable(SEEG, target)).toBe(true);
    expect(isModuleWritable(SEEG, join(dir, 'sub-01_electrodes_editlog.json'))).toBe(true);
    // A *different* stamp on the declared shape is admitted, because the backup a later write mints
    // carries its own moment. A different name in the same directory is not.
    expect(isModuleWritable(SEEG, join(dir, 'sub-01_electrodes.tsv.19990101-000000.bak'))).toBe(
      true
    );
    expect(isModuleWritable(SEEG, join(dir, 'sub-01_electrodes.tsv.bak'))).toBe(false);
    expect(isModuleWritable(SEEG, join(dir, 'other.tsv'))).toBe(false);
    // Same shape, wrong directory.
    expect(
      isModuleWritable(SEEG, join(dir, 'sub', 'sub-01_electrodes.tsv.19990101-000000.bak'))
    ).toBe(false);
  });

  it('drops a template that does not validate, leaving the rest of the save intact', () => {
    const target = join(dir, 'a.tsv');
    const admitted = admitModuleWrite(SEEG, target, ['../escape.bak', EDITLOG]);
    expect(Object.keys(admitted?.siblings ?? {})).toEqual([EDITLOG]);
    expect(isModuleWritable(SEEG, join(dir, 'escape.bak'))).toBe(false);
    expect(isModuleWritable(SEEG, join(dir, '..', 'escape.bak'))).toBe(false);
    expect(isModuleWritable(SEEG, target)).toBe(true);
  });

  it('is scoped per module: one module’s Save sheet admits nothing for another', () => {
    const target = join(dir, 'shared.tsv');
    admitModuleWrite(SEEG, target, [EDITLOG]);
    expect(isModuleWritable(SEEG, target)).toBe(true);
    expect(isModuleWritable(OTHER, target)).toBe(false);
    expect(isModuleWritable(OTHER, join(dir, 'shared_editlog.json'))).toBe(false);
  });

  it('refuses a relative path outright', () => {
    expect(admitModuleWrite(SEEG, 'relative.tsv', [])).toBeNull();
    expect(isModuleWritable(SEEG, 'relative.tsv')).toBe(false);
  });
});

describe('module-save-dialog', () => {
  it('admits what the user chose, and nothing at all when they cancelled', async () => {
    const target = join(dir, 'dialog.tsv');
    saveSheetReturns(target);
    const admitted = await moduleSaveDialog(null, SEEG, {
      title: 'Save electrodes',
      filters: [{ name: 'Electrode table', extensions: ['tsv'] }],
      siblings: [BAK, EDITLOG],
      defaultPath: target,
    });
    expect(admitted?.path).toBe(target);
    expect(isModuleWritable(SEEG, target)).toBe(true);

    clearModuleWriteLists();
    saveSheetReturns(null);
    expect(
      await moduleSaveDialog(null, SEEG, {
        title: 'x',
        filters: [],
        siblings: [],
        defaultPath: null,
      })
    ).toBeNull();
    expect(isModuleWritable(SEEG, target)).toBe(false);
  });

  it('refuses to run for something that is not a module id', async () => {
    saveSheetReturns(join(dir, 'nobody.tsv'));
    expect(await moduleSaveDialog(null, '', { siblings: [] })).toBeNull();
    expect(await moduleSaveDialog(null, 42, { siblings: [] })).toBeNull();
    expect(vi.mocked(dialog.showSaveDialog)).not.toHaveBeenCalled();
  });
});

describe('module-read-text', () => {
  it('answers only for allow-listed paths', () => {
    const path = join(dir, 'unlisted.tsv');
    writeFileSync(path, 'a\tb\n', 'utf8');
    expect(moduleReadText(SEEG, path)).toEqual({ ok: false, error: 'not on the allow-list' });
    allowPath(path);
    expect(moduleReadText(SEEG, path)).toEqual({ ok: true, text: 'a\tb\n' });
  });

  it('reads the five extensions a module parses and refuses everything else', () => {
    for (const extension of MODULE_READ_EXTENSIONS) {
      const path = fixture(`probe${extension}`, 'ok\n');
      expect(moduleReadText(SEEG, path), extension).toEqual({ ok: true, text: 'ok\n' });
    }
    // A volume is exactly what this channel must never hand to the UI thread (§5 rule 3).
    const volume = fixture('T1.nii.gz', 'not really gzip');
    expect(moduleReadText(SEEG, volume).ok).toBe(false);
    const noExtension = fixture('README', 'hello');
    expect(moduleReadText(SEEG, noExtension).ok).toBe(false);
  });

  it('caps the read at 1 MiB', () => {
    const big = fixture('big.tsv', 'x'.repeat(MAX_MODULE_READ_BYTES + 1));
    const result = moduleReadText(SEEG, big);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('exceeds');
    // One byte under the cap is fine, so the cap is a cap and not an off-by-a-megabyte.
    const edge = fixture('edge.tsv', 'x'.repeat(MAX_MODULE_READ_BYTES));
    expect(moduleReadText(SEEG, edge).ok).toBe(true);
  });

  it('refuses a call that is not a module and a path', () => {
    expect(moduleReadText('', fixture('who.tsv')).ok).toBe(false);
    expect(moduleReadText(SEEG, 42).ok).toBe(false);
  });
});

describe('module-write-text', () => {
  it('refuses a path the module’s Save sheet never admitted', () => {
    const path = join(dir, 'unadmitted.tsv');
    expect(moduleWriteText(SEEG, path, 'x', {})).toEqual({
      ok: false,
      error: 'not on the module write list',
    });
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a path another module admitted', () => {
    const path = join(dir, 'theirs.tsv');
    admitModuleWrite(OTHER, path, []);
    expect(moduleWriteText(SEEG, path, 'x', {}).ok).toBe(false);
    expect(moduleWriteText(OTHER, path, 'x', {}).ok).toBe(true);
  });

  it('writes through a .part file and leaves none behind', () => {
    const path = join(dir, 'written.tsv');
    admitModuleWrite(SEEG, path, []);
    expect(moduleWriteText(SEEG, path, 'name\tx\ty\tz\n', {})).toEqual({
      ok: true,
      backupPath: null,
    });
    expect(readFileSync(path, 'utf8')).toBe('name\tx\ty\tz\n');
    expect(existsSync(`${path}.part`)).toBe(false);
    // The written file is readable back without a second gesture.
    expect(moduleReadText(SEEG, path)).toEqual({ ok: true, text: 'name\tx\ty\tz\n' });
  });

  it('copies the previous file to a stamped .bak when the writer declared one', () => {
    const path = join(dir, 'backed.tsv');
    writeFileSync(path, 'before\n', 'utf8');
    admitModuleWrite(SEEG, path, [BAK]);
    const result = moduleWriteText(SEEG, path, 'after\n', { backup: true });
    expect(result.ok).toBe(true);
    const backupPath = result.ok ? result.backupPath : null;
    expect(backupPath).toMatch(/backed\.tsv\.\d{8}-\d{6}\.bak$/);
    expect(readFileSync(backupPath ?? '', 'utf8')).toBe('before\n');
    expect(readFileSync(path, 'utf8')).toBe('after\n');
  });

  it('makes no .bak for a writer that declared none, and still writes', () => {
    const path = join(dir, 'unbacked.tsv');
    writeFileSync(path, 'before\n', 'utf8');
    admitModuleWrite(SEEG, path, [EDITLOG]);
    expect(moduleWriteText(SEEG, path, 'after\n', { backup: true })).toEqual({
      ok: true,
      backupPath: null,
    });
    expect(readFileSync(path, 'utf8')).toBe('after\n');
    expect(readdirSync(dir).some((n) => n.startsWith('unbacked.tsv.') && n.endsWith('.bak'))).toBe(
      false
    );
  });

  it('makes no .bak for a first save, because there is nothing to copy', () => {
    const path = join(dir, 'fresh.tsv');
    admitModuleWrite(SEEG, path, [BAK]);
    expect(moduleWriteText(SEEG, path, 'first\n', { backup: true })).toEqual({
      ok: true,
      backupPath: null,
    });
  });

  it('caps the write at 8 MiB and writes nothing when it is over', () => {
    const path = join(dir, 'huge.tsv');
    admitModuleWrite(SEEG, path, []);
    const result = moduleWriteText(SEEG, path, 'x'.repeat(MAX_MODULE_WRITE_BYTES + 1), {});
    expect(result.ok).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a call that is not a module, a path and a string', () => {
    const path = join(dir, 'types.tsv');
    admitModuleWrite(SEEG, path, []);
    expect(moduleWriteText('', path, 'x', {}).ok).toBe(false);
    expect(moduleWriteText(SEEG, path, 42, {}).ok).toBe(false);
    expect(moduleWriteText(SEEG, 42, 'x', {}).ok).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});

describe('the close guard', () => {
  it('prompts only for an edited, interactive window outside the E2E seam', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(shouldPromptOnClose({ edited: true, isJob: false, env })).toBe(true);
    expect(shouldPromptOnClose({ edited: false, isJob: false, env })).toBe(false);
    // A `--job` window has nobody to answer the box; it would hang until the CI cap.
    expect(shouldPromptOnClose({ edited: true, isJob: true, env })).toBe(false);
    // The seam an e2e sets so its own teardown can close a window it deliberately made dirty.
    expect(
      shouldPromptOnClose({
        edited: true,
        isJob: false,
        env: { TETRAVOX_E2E_DISCARD: '1' } as NodeJS.ProcessEnv,
      })
    ).toBe(false);
    expect(
      shouldPromptOnClose({
        edited: true,
        isJob: false,
        env: { TETRAVOX_E2E_DISCARD: '0' } as NodeJS.ProcessEnv,
      })
    ).toBe(true);
  });
});
