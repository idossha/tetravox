// @vitest-environment node
/**
 * §5 rule 11's folder channel, on a real temp filesystem. The planted escapes are the point: each one
 * is what a renderer that is not trying to behave would send. Expected values are the rules' own.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const declared = vi.hoisted(() => ({
  manifest: {
    id: 'tetravox.tract-tools',
    writers: [
      {
        id: 'export',
        title: 'Export',
        directory: true,
        siblings: [],
        filters: [{ name: 'Tract data', extensions: ['tck', 'TSV', 'exe', 'part', '*'] }],
      },
      { id: 'sheet', title: 'Save', siblings: [], filters: [{ name: 'T', extensions: ['tsv'] }] },
    ],
  },
}));

vi.mock('../modules/manifests', () => ({
  MANIFESTS: [declared.manifest],
  manifestFor: (id: string) => (id === declared.manifest.id ? declared.manifest : null),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  net: {},
  protocol: {},
}));

import { EventEmitter } from 'node:events';
import { dialog, ipcMain } from 'electron';
import {
  MAX_MODULE_FOLDER_CHUNK_BYTES,
  MAX_MODULE_FOLDER_WRITERS,
  moduleChooseFolder,
  moduleFolderAbort,
  moduleFolderClose,
  moduleFolderCreate,
  moduleFolderWrite,
  registerModuleIpc,
  revokeAllModuleWrites,
  revokeFolders,
  revokeModuleWrites,
} from './module-io';
import { clearAllowList, resolveAllowed } from './paths';

const MOD = declared.manifest.id;
const SENDER = 7;
const base = realpathSync(mkdtempSync(join(tmpdir(), 'tvx-module-folder-')));
let root: string;
let outside: string;
let n = 0;

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

beforeEach(async () => {
  await revokeFolders(() => true);
  clearAllowList();
  n += 1;
  root = join(base, `chosen${n}`);
  outside = join(base, `outside${n}`);
  mkdirSync(root);
  mkdirSync(outside);
  vi.mocked(dialog.showOpenDialog).mockReset();
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] });
});

async function folder(): Promise<string> {
  const got = await moduleChooseFolder(null, SENDER, MOD, { writerId: 'export' });
  if (got === null || !got.ok) throw new Error(JSON.stringify(got));
  return got.token;
}

async function open(name: string, overwrite = false): Promise<string> {
  const made = await moduleFolderCreate(MOD, SENDER, await folder(), name, { overwrite });
  if (!made.ok) throw new Error(made.error);
  return made.token;
}

describe('choosing', () => {
  it('needs a manifest writer with directory: true, and asks for a directory', async () => {
    expect(await moduleChooseFolder(null, SENDER, MOD, { writerId: 'sheet' })).toMatchObject({
      ok: false,
    });
    expect(await moduleChooseFolder(null, SENDER, 'other', { writerId: 'export' })).toMatchObject({
      ok: false,
    });
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    await folder();
    const options = vi.mocked(dialog.showOpenDialog).mock.calls[0]?.[0] as {
      properties: string[];
    };
    expect(options.properties).toContain('openDirectory');
  });

  it('answers null on cancel and refuses a job, which has no one to ask', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await moduleChooseFolder(null, SENDER, MOD, { writerId: 'export' })).toBeNull();
    expect(await moduleChooseFolder(null, SENDER, MOD, { writerId: 'export' }, true)).toMatchObject(
      { ok: false }
    );
  });
});

describe('names cannot leave the folder', () => {
  const escapes = [
    '../evil.tck',
    '..\\evil.tck',
    'a/b.tck',
    'a\\b.tck',
    '/etc/evil.tck',
    'C:\\evil.tck',
    'evil\0.tck',
    '..',
    '.',
    '',
    '.tck',
    'a..tck',
    '.hidden.tck',
    'NUL.tck',
    'com1.tck',
    'x'.repeat(97) + '.tck',
    'evil.exe',
    'evil.tck.exe',
    'evil.part',
    'evil.tck.part',
    'evil',
    'evil.*',
    42,
    null,
  ];
  for (const name of escapes) {
    it(`refuses ${JSON.stringify(name)}`, async () => {
      const made = await moduleFolderCreate(MOD, SENDER, await folder(), name, {});
      expect(made.ok).toBe(false);
      expect(readdirSync(root)).toEqual([]);
      expect(readdirSync(outside)).toEqual([]);
      expect(readdirSync(base).filter((f) => f.startsWith('evil'))).toEqual([]);
    });
  }

  it('matches manifest extensions without regard to case', async () => {
    expect((await moduleFolderCreate(MOD, SENDER, await folder(), 'a.TCK', {})).ok).toBe(true);
    expect((await moduleFolderCreate(MOD, SENDER, await folder(), 'b.tsv', {})).ok).toBe(true);
  });
});

describe('links cannot leave the folder', () => {
  it('refuses a target that is a symlink out, even with overwrite, and leaves its file alone', async () => {
    const victim = join(outside, 'victim.tck');
    writeFileSync(victim, 'precious');
    symlinkSync(victim, join(root, 'a.tck'));
    expect(
      (await moduleFolderCreate(MOD, SENDER, await folder(), 'a.tck', { overwrite: true })).ok
    ).toBe(false);
    expect(readFileSync(victim, 'utf8')).toBe('precious');
  });

  it('a planted .part symlink is removed, not written through', async () => {
    const victim = join(outside, 'victim');
    writeFileSync(victim, 'precious');
    symlinkSync(victim, join(root, 'a.tck.part'));
    const token = await open('a.tck');
    await moduleFolderWrite(MOD, SENDER, token, new Uint8Array([1, 2, 3]));
    expect(await moduleFolderClose(MOD, SENDER, token)).toMatchObject({ ok: true, bytes: 3 });
    expect(readFileSync(victim, 'utf8')).toBe('precious');
    expect([...readFileSync(join(root, 'a.tck'))]).toEqual([1, 2, 3]);
  });

  it('a target planted as a symlink after create is refused at close', async () => {
    const victim = join(outside, 'victim');
    writeFileSync(victim, 'precious');
    const token = await open('a.tck', true);
    symlinkSync(victim, join(root, 'a.tck'));
    expect(await moduleFolderClose(MOD, SENDER, token)).toMatchObject({ ok: false });
    expect(readFileSync(victim, 'utf8')).toBe('precious');
    expect(existsSync(join(root, 'a.tck.part'))).toBe(false);
  });

  it('a chosen folder swapped for a symlink out is refused', async () => {
    const token = await folder();
    renameSync(root, `${root}-moved`);
    symlinkSync(outside, root);
    expect((await moduleFolderCreate(MOD, SENDER, token, 'a.tck', {})).ok).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a chosen folder that is itself a symlink resolves to where it really is', async () => {
    const link = join(base, `link${n}`);
    symlinkSync(root, link);
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [link] });
    expect(await moduleChooseFolder(null, SENDER, MOD, { writerId: 'export' })).toMatchObject({
      ok: true,
      path: root,
    });
  });
});

describe('writing', () => {
  it('streams through .part, renames on close, and admits the result for reading', async () => {
    const token = await open('a.tck');
    expect(await moduleFolderWrite(MOD, SENDER, token, new Uint8Array([1, 2]))).toEqual({
      ok: true,
    });
    expect(readdirSync(root)).toEqual(['a.tck.part']);
    const backing = new Uint8Array([9, 3, 4, 9]);
    expect((await moduleFolderWrite(MOD, SENDER, token, backing.subarray(1, 3))).ok).toBe(true);
    expect(await moduleFolderClose(MOD, SENDER, token)).toEqual({
      ok: true,
      path: join(root, 'a.tck'),
      bytes: 4,
    });
    expect(readdirSync(root)).toEqual(['a.tck']);
    expect([...readFileSync(join(root, 'a.tck'))]).toEqual([1, 2, 3, 4]);
    expect(resolveAllowed(join(root, 'a.tck'))).toBe(join(root, 'a.tck'));
    expect((await moduleFolderWrite(MOD, SENDER, token, new Uint8Array(1))).ok).toBe(false);
  });

  it('keeps order when a module does not wait between writes', async () => {
    const token = await open('a.tck');
    const pieces = Array.from({ length: 50 }, (_, i) =>
      moduleFolderWrite(MOD, SENDER, token, new Uint8Array(1024).fill(i))
    );
    const closed = moduleFolderClose(MOD, SENDER, token);
    await Promise.all(pieces);
    expect(await closed).toMatchObject({ ok: true, bytes: 50 * 1024 });
    const out = readFileSync(join(root, 'a.tck'));
    for (let i = 0; i < 50; i += 1) expect(out[i * 1024]).toBe(i);
  });

  it('overwrites only when asked', async () => {
    writeFileSync(join(root, 'a.tck'), 'old');
    expect((await moduleFolderCreate(MOD, SENDER, await folder(), 'a.tck', {})).ok).toBe(false);
    expect(readFileSync(join(root, 'a.tck'), 'utf8')).toBe('old');
    const token = await open('a.tck', true);
    expect(readFileSync(join(root, 'a.tck'), 'utf8')).toBe('old');
    await moduleFolderWrite(MOD, SENDER, token, new Uint8Array([65]));
    await moduleFolderClose(MOD, SENDER, token);
    expect(readFileSync(join(root, 'a.tck'), 'utf8')).toBe('A');
  });

  it('a file appearing during a no-overwrite write is not replaced', async () => {
    const token = await open('a.tck');
    writeFileSync(join(root, 'a.tck'), 'theirs');
    expect((await moduleFolderClose(MOD, SENDER, token)).ok).toBe(false);
    expect(readFileSync(join(root, 'a.tck'), 'utf8')).toBe('theirs');
    expect(readdirSync(root)).toEqual(['a.tck']);
  });

  it('refuses a directory target, and a second writer on a name, whatever its case', async () => {
    mkdirSync(join(root, 'd.tck'));
    expect(
      (await moduleFolderCreate(MOD, SENDER, await folder(), 'd.tck', { overwrite: true })).ok
    ).toBe(false);
    await open('a.tck');
    expect((await moduleFolderCreate(MOD, SENDER, await folder(), 'A.tck', {})).ok).toBe(false);
  });

  it('caps one call at 64 MiB and leaves the file open', async () => {
    const token = await open('a.tck');
    const big = new Uint8Array(MAX_MODULE_FOLDER_CHUNK_BYTES + 1);
    const refused = await moduleFolderWrite(MOD, SENDER, token, big);
    expect(refused).toMatchObject({ ok: false });
    expect((await moduleFolderWrite(MOD, SENDER, token, new Uint8Array(1))).ok).toBe(true);
    expect((await moduleFolderWrite(MOD, SENDER, token, 'not bytes')).ok).toBe(false);
  });

  it('caps open writers, and closing one frees a place', async () => {
    const made: string[] = [];
    for (let i = 0; i < MAX_MODULE_FOLDER_WRITERS; i += 1) made.push(await open(`f${i}.tck`));
    const over = await moduleFolderCreate(MOD, SENDER, await folder(), 'over.tck', {});
    expect(over).toMatchObject({ ok: false });
    await moduleFolderAbort(MOD, SENDER, made[0]);
    expect((await moduleFolderCreate(MOD, SENDER, await folder(), 'over.tck', {})).ok).toBe(true);
  });

  it('abort removes the .part and leaves an existing file as it was', async () => {
    writeFileSync(join(root, 'a.tck'), 'old');
    const token = await open('a.tck', true);
    await moduleFolderWrite(MOD, SENDER, token, new Uint8Array(10));
    expect(await moduleFolderAbort(MOD, SENDER, token)).toEqual({ ok: true });
    expect(readdirSync(root)).toEqual(['a.tck']);
    expect(readFileSync(join(root, 'a.tck'), 'utf8')).toBe('old');
    expect((await moduleFolderClose(MOD, SENDER, token)).ok).toBe(false);
  });
});

describe('who may touch what', () => {
  it('a handle belongs to one module and one window', async () => {
    const f = await folder();
    expect((await moduleFolderCreate('other', SENDER, f, 'a.tck', {})).ok).toBe(false);
    expect((await moduleFolderCreate(MOD, SENDER + 1, f, 'a.tck', {})).ok).toBe(false);
    expect((await moduleFolderCreate(MOD, SENDER, 'made-up', 'a.tck', {})).ok).toBe(false);
    const made = await moduleFolderCreate(MOD, SENDER, f, 'a.tck', {});
    if (!made.ok) throw new Error(made.error);
    const bytes = new Uint8Array(1);
    expect((await moduleFolderWrite('other', SENDER, made.token, bytes)).ok).toBe(false);
    expect((await moduleFolderWrite(MOD, SENDER + 1, made.token, bytes)).ok).toBe(false);
    expect((await moduleFolderClose('other', SENDER, made.token)).ok).toBe(false);
    expect((await moduleFolderAbort('other', SENDER, made.token)).ok).toBe(false);
  });
});

describe('abandoned writers', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

  it('deactivating the module aborts its files and revokes its folders', async () => {
    const f = await folder();
    const made = await moduleFolderCreate(MOD, SENDER, f, 'a.tck', {});
    if (!made.ok) throw new Error(made.error);
    revokeModuleWrites(MOD);
    expect(readdirSync(root)).toEqual([]);
    await settle();
    expect((await moduleFolderWrite(MOD, SENDER, made.token, new Uint8Array(1))).ok).toBe(false);
    expect((await moduleFolderCreate(MOD, SENDER, f, 'b.tck', {})).ok).toBe(false);
  });

  it('a new document does the same for everyone', async () => {
    await open('a.tck');
    revokeAllModuleWrites();
    expect(readdirSync(root)).toEqual([]);
    await settle();
  });

  it('a window closing or crashing aborts that window files through the registered channel', async () => {
    registerModuleIpc();
    const call = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'tetravox:module-choose-folder');
    const choose = call?.[1] as unknown as (e: unknown, m: string, o: unknown) => Promise<unknown>;
    for (const event of ['destroyed', 'render-process-gone']) {
      const sender = Object.assign(new EventEmitter(), { id: 900 });
      const got = (await choose({ sender }, MOD, { writerId: 'export' })) as { token: string };
      const made = await moduleFolderCreate(MOD, 900, got.token, `${event}.tck`, {});
      expect(made.ok).toBe(true);
      expect(readdirSync(root)).toEqual([`${event}.tck.part`]);
      sender.emit(event);
      expect(readdirSync(root)).toEqual([]);
      await settle();
    }
  });
});
