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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A manifest barrel with one module in it, so the "the manifest is the authority" half of the two
 * dialog handlers can be driven at all: `MANIFESTS` really carries only `tetravox.hello`, which
 * declares no reader and no writer, and the module that will is P4's.
 *
 * Every existing case below passes **no** `readerId`/`writerId`, so it exercises the fallback — a
 * module main does not know — exactly as it did before the lookup existed.
 */
const declared = vi.hoisted(() => {
  const manifest = {
    id: 'tetravox.seeg',
    title: 'sEEG',
    version: '1.0.0',
    hostApi: 1 as const,
    docs: 'Modules',
    activation: ['onToggle' as const],
    commands: [],
    readers: [{ id: 'electrodes', title: 'Electrode table', extensions: ['tsv', 'csv'] }],
    writers: [
      {
        id: 'electrodes',
        title: 'Save electrodes',
        filters: [{ name: 'Electrode table', extensions: ['tsv'] }],
        siblings: ['{name}.{stamp}.bak', '{stem}_editlog.json'],
        backup: 'timestamped' as const,
      },
    ],
  };
  return { manifest };
});

vi.mock('../modules/manifests', () => ({
  MANIFESTS: [declared.manifest],
  manifestFor: (id: string) => (id === declared.manifest.id ? declared.manifest : null),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  // `protocol.ts` imports both at module scope for `handleScheme`, which nothing here calls.
  net: {},
  protocol: {},
}));

import { dialog, ipcMain } from 'electron';
import { allowPath, clearAllowList } from './paths';
import {
  MAX_MODULE_READ_BYTES,
  MAX_MODULE_WRITE_BYTES,
  MODULE_READ_EXTENSIONS,
  admitModuleWrite,
  clearModuleWriteLists,
  isModuleWritable,
  isSiblingTemplate,
  moduleOpenDialog,
  moduleReadText,
  moduleSaveDialog,
  moduleWriteText,
  registerModuleIpc,
  revokeAllModuleWrites,
  revokeModuleWrites,
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

  it('reads a stem as the name less one suffix, a compression suffix taking two', () => {
    expect(stemOf('sub-01_electrodes.tsv')).toBe('sub-01_electrodes');
    expect(stemOf('sub-01_acq-bone_ct.nii.gz')).toBe('sub-01_acq-bone_ct');
    expect(stemOf('no-extension')).toBe('no-extension');
    expect(stemOf('.hidden')).toBe('.hidden');
    // A dotted name keeps its dots. This is the case main and the renderer disagreed about, and it
    // is asserted on *this* side and on `instantiateSiblings`' (`modules/keys.test.ts`) because one
    // definition is only one definition while both halves are pinned to it: main admitting
    // `…v2_editlog.json` while a module writes `…_editlog.json` refuses the module's own save.
    expect(stemOf('sub-01_electrodes.v2.tsv')).toBe('sub-01_electrodes.v2');
  });

  it('admits a dotted anchor’s editlog under the name the module will write', () => {
    const target = join(dir, 'sub-01_electrodes.v2.tsv');
    const admitted = admitModuleWrite(SEEG, target, [EDITLOG]);
    expect(admitted?.siblings[EDITLOG]).toBe(join(dir, 'sub-01_electrodes.v2_editlog.json'));
    expect(isModuleWritable(SEEG, join(dir, 'sub-01_electrodes.v2_editlog.json'))).toBe(true);
    // The name the *chain* rule would have produced is not admitted, which is the point: it is a
    // different file, and it is the one another table in this directory legitimately owns.
    expect(isModuleWritable(SEEG, join(dir, 'sub-01_electrodes_editlog.json'))).toBe(false);
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

  it('takes the writer’s title, filters and templates from the manifest, not the renderer', async () => {
    const target = join(dir, 'authority.tsv');
    saveSheetReturns(target);
    // A renderer asking for a sheet on a writer the manifest declares: every value it sent is
    // ignored, including the sibling template — which is the one that *admits a second path for
    // writing*, and therefore the one that must not be renderer-supplied once main can look it up.
    const admitted = await moduleSaveDialog(null, SEEG, {
      writerId: 'electrodes',
      title: 'Save anything at all',
      filters: [{ name: 'Everything', extensions: ['*'] }],
      siblings: ['{stem}_elsewhere.json'],
      defaultPath: null,
    });
    expect(admitted?.path).toBe(target);
    const options = vi.mocked(dialog.showSaveDialog).mock.calls.at(-1)?.[0] as
      Electron.SaveDialogOptions | undefined;
    expect(options?.title).toBe('Save electrodes');
    expect(options?.filters).toEqual([{ name: 'Electrode table', extensions: ['tsv'] }]);
    // The manifest's `{stem}_editlog.json` is admitted; the renderer's invention is not.
    expect(isModuleWritable(SEEG, join(dir, 'authority_editlog.json'))).toBe(true);
    expect(isModuleWritable(SEEG, join(dir, 'authority_elsewhere.json'))).toBe(false);
  });

  it('falls back to the renderer’s values for a writer no manifest declares', async () => {
    const target = join(dir, 'fallback.tsv');
    saveSheetReturns(target);
    await moduleSaveDialog(null, SEEG, {
      writerId: 'not-declared',
      title: 'Save electrodes',
      filters: [{ name: 'Electrode table', extensions: ['tsv'] }],
      siblings: [EDITLOG],
      defaultPath: null,
    });
    // Still sanitised, still validated — the fallback never trusted the renderer, it only used it.
    expect(isModuleWritable(SEEG, join(dir, 'fallback_editlog.json'))).toBe(true);
    expect(isModuleWritable(SEEG, join(dir, 'anything.json'))).toBe(false);
  });
});

describe('module-open-dialog', () => {
  it('offers the manifest’s reader, with an escape hatch, and allow-lists what was chosen', async () => {
    const chosen = join(dir, 'chosen.tsv');
    writeFileSync(chosen, 'name\tx\n', 'utf8');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [chosen] });
    const opened = await moduleOpenDialog(null, SEEG, {
      readerId: 'electrodes',
      title: 'Open whatever',
      filters: [{ name: 'Everything', extensions: ['*'] }],
    });
    // `allowPaths` admits the **resolved** path (macOS's temp directory is a symlink), which is the
    // same path `module-read-text` will canonicalise the read to.
    expect(opened.map((o) => o.path)).toEqual([realpathSync(chosen)]);
    const options = vi.mocked(dialog.showOpenDialog).mock.calls.at(-1)?.[0] as
      Electron.OpenDialogOptions | undefined;
    expect(options?.title).toBe('Electrode table');
    expect(options?.filters).toEqual([
      { name: 'Electrode table', extensions: ['tsv', 'csv'] },
      { name: 'All files', extensions: ['*'] },
    ]);
    // Opening is a read gesture and nothing more: the chosen path is readable, never writable.
    expect(moduleReadText(SEEG, chosen)).toEqual({ ok: true, text: 'name\tx\n' });
    expect(isModuleWritable(SEEG, chosen)).toBe(false);
  });

  it('answers nothing for something that is not a module id, and asks no sheet', async () => {
    vi.mocked(dialog.showOpenDialog).mockClear();
    expect(await moduleOpenDialog(null, '', { title: 'x', filters: [] })).toEqual([]);
    expect(vi.mocked(dialog.showOpenDialog)).not.toHaveBeenCalled();
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
    // A stale `.part` from an interrupted earlier save. It has to be *consumed*: if the write went
    // straight to `path`, this file would survive, which is what makes the assertion below evidence
    // that the temp-then-rename really happened rather than a restatement of "the write worked".
    writeFileSync(`${path}.part`, 'left over from a crash\n', 'utf8');
    expect(moduleWriteText(SEEG, path, 'name\tx\ty\tz\n', {})).toEqual({
      ok: true,
      backupPath: null,
    });
    expect(readFileSync(path, 'utf8')).toBe('name\tx\ty\tz\n');
    expect(existsSync(`${path}.part`)).toBe(false);
    // The written file is readable back without a second gesture.
    expect(moduleReadText(SEEG, path)).toEqual({ ok: true, text: 'name\tx\ty\tz\n' });
  });

  /**
   * A module operation's `out` is a name **under** `--out`, and `job.ts`'s `outName` admits
   * `tables/electrodes.tsv` — no leading `/`, no `..`, so nothing about it is an escape.
   * `job-runner.ts` then resolves it and admits it to this module's write list before the window
   * exists. Nothing had ever created `<out>/tables`, so the `.part` write died with ENOENT on a
   * path main had already said yes to: the admission and the write disagreed about whether the
   * directory was anybody's job.
   *
   * Seeded through `admitModuleWrite` rather than a Save sheet, which is the same seam the runner
   * uses — a `--job` window has no sheet to open.
   */
  it('creates the parent directory an `out` named, and writes the sibling there too', () => {
    const path = join(dir, 'tables', 'nested', 'sub-01_electrodes.tsv');
    const admitted = admitModuleWrite(SEEG, path, [EDITLOG]);
    expect(existsSync(join(dir, 'tables'))).toBe(false);

    expect(moduleWriteText(SEEG, path, 'name\tx\ty\tz\n', {})).toEqual({
      ok: true,
      backupPath: null,
    });
    expect(readFileSync(path, 'utf8')).toBe('name\tx\ty\tz\n');
    expect(existsSync(`${path}.part`)).toBe(false);

    // The editlog is admitted in that same new directory and lands beside the table.
    const editlog = admitted?.siblings[EDITLOG] ?? '';
    expect(editlog).toBe(join(dir, 'tables', 'nested', 'sub-01_electrodes_editlog.json'));
    expect(moduleWriteText(SEEG, editlog, '{}\n', {}).ok).toBe(true);
    expect(existsSync(editlog)).toBe(true);

    // Creating a directory is not admitting one: an unadmitted path under it is still refused.
    expect(moduleWriteText(SEEG, join(dir, 'tables', 'nested', 'other.tsv'), 'x', {})).toEqual({
      ok: false,
      error: 'not on the module write list',
    });
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

  /**
   * The whole point of the rename: a save that cannot complete must leave the old file alone. The
   * failure is forced by making the target a directory, so `writeFileSync` on the `.part` succeeds
   * and `renameSync` onto it does not — the same order a full disk or a revoked permission hits.
   */
  it('reports a failed rename and clears the .part rather than leaving one', () => {
    const path = join(dir, 'occupied.tsv');
    mkdirSync(path, { recursive: true });
    admitModuleWrite(SEEG, path, []);
    const result = moduleWriteText(SEEG, path, 'never lands\n', {});
    expect(result.ok).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
    // The target is untouched: still the directory it was, not a half-written table.
    expect(statSync(path).isDirectory()).toBe(true);
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

  /**
   * The seam is a *test* seam, and a packaged build runs no tests (2026-08-30).
   *
   * `TETRAVOX_E2E_DISCARD` is ambient state: a dotfile, a launcher script or a leftover `export` in
   * the shell a user starts the app from would silently switch off the only thing standing between
   * ⌘W and an afternoon of unsaved contact edits. `app.isPackaged` is what tells the two builds
   * apart, and main passes it in so this stays a pure function.
   */
  it('ignores the E2E seam in a packaged build', () => {
    const seam = { TETRAVOX_E2E_DISCARD: '1' } as NodeJS.ProcessEnv;
    expect(shouldPromptOnClose({ edited: true, isJob: false, env: seam, packaged: true })).toBe(
      true
    );
    // …and the ambient process environment, which is what a real close reads, is no different.
    const before = process.env['TETRAVOX_E2E_DISCARD'];
    process.env['TETRAVOX_E2E_DISCARD'] = '1';
    try {
      expect(shouldPromptOnClose({ edited: true, isJob: false, packaged: true })).toBe(true);
      expect(shouldPromptOnClose({ edited: true, isJob: false, packaged: false })).toBe(false);
      expect(shouldPromptOnClose({ edited: true, isJob: false })).toBe(false);
    } finally {
      if (before === undefined) delete process.env['TETRAVOX_E2E_DISCARD'];
      else process.env['TETRAVOX_E2E_DISCARD'] = before;
    }

    // What the gate must not do: turn a clean window, or a `--job` window, into a prompt.
    expect(shouldPromptOnClose({ edited: false, isJob: false, env: seam, packaged: true })).toBe(
      false
    );
    expect(shouldPromptOnClose({ edited: true, isJob: true, env: seam, packaged: true })).toBe(
      false
    );
  });
});

/**
 * Revocation (2026-08-30): an admission belongs to the editing session that earned it.
 *
 * `admitModuleWrite` is called by every confirmed Save sheet and by a job's `out` targets, and
 * before this its only eraser was this file's own `clearModuleWriteLists`. So a user who saved
 * subject A's table and then moved to subject B left A's tsv — and the `<anchor>.<stamp>.bak` shape
 * beside it — writable for the rest of the process, against a subject nothing on screen mentioned.
 */
describe('giving a write admission back', () => {
  it('drops one module’s list and leaves every other module’s alone', () => {
    const mine = join(dir, 'revoke-mine.tsv');
    const theirs = join(dir, 'revoke-theirs.tsv');
    admitModuleWrite(SEEG, mine, [BAK, EDITLOG]);
    admitModuleWrite(OTHER, theirs, []);
    expect(isModuleWritable(SEEG, mine)).toBe(true);

    expect(revokeModuleWrites(SEEG)).toBe(true);
    expect(isModuleWritable(SEEG, mine)).toBe(false);
    // The siblings go with it — including the stamped *shape*, which is the admission that would
    // otherwise keep matching any `<anchor>.<YYYYMMDD-HHMMSS>.bak` in that directory forever.
    expect(isModuleWritable(SEEG, `${mine}.20260830-120000.bak`)).toBe(false);
    expect(isModuleWritable(SEEG, join(dir, 'revoke-mine_editlog.json'))).toBe(false);
    // Another module's Save sheet is another module's business.
    expect(isModuleWritable(OTHER, theirs)).toBe(true);

    // Revoking twice, or revoking what was never admitted, is not an error.
    expect(revokeModuleWrites(SEEG)).toBe(false);
    expect(revokeModuleWrites('tetravox.never')).toBe(false);
    expect(revokeModuleWrites('')).toBe(false);
    expect(revokeModuleWrites(42)).toBe(false);
  });

  it('a write refused after revocation leaves the file exactly as it was', () => {
    const path = join(dir, 'revoke-write.tsv');
    writeFileSync(path, 'before\n', 'utf8');
    admitModuleWrite(SEEG, path, []);
    expect(moduleWriteText(SEEG, path, 'after\n', {}).ok).toBe(true);

    revokeModuleWrites(SEEG);
    expect(moduleWriteText(SEEG, path, 'clobbered\n', {})).toEqual({
      ok: false,
      error: 'not on the module write list',
    });
    expect(readFileSync(path, 'utf8')).toBe('after\n');
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it('a new document drops every module at once', () => {
    const mine = join(dir, 'revoke-all-mine.tsv');
    const theirs = join(dir, 'revoke-all-theirs.tsv');
    admitModuleWrite(SEEG, mine, []);
    admitModuleWrite(OTHER, theirs, []);
    revokeAllModuleWrites();
    expect(isModuleWritable(SEEG, mine)).toBe(false);
    expect(isModuleWritable(OTHER, theirs)).toBe(false);
  });

  /**
   * The channel, driven through the handler `registerModuleIpc` really registers — the renderer
   * sends this from `deactivateModule`, and a channel that was never wired would look exactly like
   * a revocation that works, because both leave the list untouched from in here.
   */
  it('is reachable on `tetravox:module-clear-writes`, and inert for a --job run', () => {
    const handlerFor = (): ((event: unknown, id: unknown) => void) => {
      const call = vi
        .mocked(ipcMain.on)
        .mock.calls.findLast(([channel]) => channel === 'tetravox:module-clear-writes');
      if (call === undefined) throw new Error('tetravox:module-clear-writes was never registered');
      return call[1] as (event: unknown, id: unknown) => void;
    };

    const path = join(dir, 'revoke-ipc.tsv');
    vi.mocked(ipcMain.on).mockClear();
    registerModuleIpc();
    admitModuleWrite(SEEG, path, []);
    handlerFor()(null, SEEG);
    expect(isModuleWritable(SEEG, path)).toBe(false);

    // A `--job` run activates modules in the order its actions name them, so a deactivate between
    // two actions is not the end of an editing session — and the `out` target it would drop was
    // admitted by `prepareJob` before there was a window to send anything from.
    vi.mocked(ipcMain.on).mockClear();
    registerModuleIpc({ isJob: true });
    admitModuleWrite(SEEG, path, []);
    handlerFor()(null, SEEG);
    expect(isModuleWritable(SEEG, path)).toBe(true);
  });
});
