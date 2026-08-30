/**
 * `createHostFiles` — the module surface's filesystem, against a fake bridge and a fake disk.
 *
 * Two things are worth testing here and they are different in kind. The **candidate arithmetic** is
 * pure string work with a security edge (a manifest must not name a file outside the tree it was
 * pointed at), so it is tested directly. The **four calls onto the bridge** are thin, so what is
 * asserted is that each one carries the module's own id and the right half of the manifest — an
 * `openDialog` that sent another reader's filters, or a `writeText` that sent no module id, would be
 * a live bug and is otherwise invisible.
 *
 * The bridge is a plain object on `globalThis`, which is exactly how `bridge()` finds the real one
 * (`renderer/src/bridge.ts`); no Electron, no disk, no DOM.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { TetravoxBridge } from '../../../preload/index';
import {
  createHostFiles,
  resolveSibling,
  substituteCandidate,
  type HostFilesManifest,
} from './hostFiles';

const MANIFEST: HostFilesManifest = {
  id: 'tetravox.seeg',
  readers: [
    { id: 'electrodes', title: 'Electrode table', extensions: ['tsv', 'csv'] },
    { id: 'fcsv', title: 'Slicer fiducials', extensions: ['fcsv'] },
  ],
  siblings: [
    {
      // A BIDS CT: `sub-P076_space-T1w_acq-bone_ct.nii.gz` in `…/sub-P076/ct/`.
      from: '^(?<sub>sub-[A-Za-z0-9]+)_space-(?<space>[A-Za-z0-9]+).*_ct\\.nii(\\.gz)?$',
      candidates: [
        '../ieeg/{sub}_space-{space}_electrodes.tsv',
        '../ieeg/{sub}_space-{space}_coordsystem.json',
        '{sub}_notes.txt',
      ],
    },
  ],
  writers: [
    {
      id: 'electrodes',
      title: 'Save electrodes',
      filters: [{ name: 'Electrode table', extensions: ['tsv'] }],
      siblings: ['{name}.{stamp}.bak', '{stem}_editlog.json'],
      backup: 'timestamped',
    },
  ],
};

interface Calls {
  read: [string, string][];
  open: [string, unknown][];
  save: [string, unknown][];
  write: [string, string, string, unknown][];
  probed: string[];
}

/** A bridge whose four module calls record their arguments and answer from a fake disk. */
function fakeBridge(disk: Record<string, string>): Calls {
  const calls: Calls = { read: [], open: [], save: [], write: [], probed: [] };
  const stub = {
    moduleReadText: async (moduleId: string, path: string) => {
      calls.read.push([moduleId, path]);
      const text = disk[path];
      return text === undefined
        ? { ok: false as const, error: 'not on the allow-list' }
        : { ok: true as const, text };
    },
    moduleOpenDialog: async (moduleId: string, opts: unknown) => {
      calls.open.push([moduleId, opts]);
      return [{ path: '/bids/a.tsv', url: 'tetravox://file/a' }];
    },
    moduleSaveDialog: async (moduleId: string, opts: unknown) => {
      calls.save.push([moduleId, opts]);
      return {
        path: '/bids/out.tsv',
        siblings: { '{stem}_editlog.json': '/bids/out_editlog.json' },
      };
    },
    moduleWriteText: async (moduleId: string, path: string, text: string, opts: unknown) => {
      calls.write.push([moduleId, path, text, opts]);
      return { ok: true as const, backupPath: null };
    },
  };
  (globalThis as { tetravox?: TetravoxBridge }).tetravox = stub as unknown as TetravoxBridge;
  return calls;
}

/** `bridge().allowPath`'s contract: the canonical path when it exists, null when it does not. */
function fakeAllowPath(disk: Record<string, string>, calls: Calls) {
  return async (path: string): Promise<{ path: string } | null> => {
    calls.probed.push(path);
    return path in disk ? { path } : null;
  };
}

afterEach(() => {
  delete (globalThis as { tetravox?: TetravoxBridge }).tetravox;
});

// ------------------------------------------------------------------------------------------------

describe('resolveSibling', () => {
  const CT = '/bids/derivatives/seegprep/sub-P076/ct/sub-P076_ct.nii.gz';

  it('resolves a sibling and a one-directory hop', () => {
    expect(resolveSibling(CT, 'notes.txt')).toBe(
      '/bids/derivatives/seegprep/sub-P076/ct/notes.txt'
    );
    expect(resolveSibling(CT, '../ieeg/sub-P076_electrodes.tsv')).toBe(
      '/bids/derivatives/seegprep/sub-P076/ieeg/sub-P076_electrodes.tsv'
    );
    expect(resolveSibling(CT, './notes.txt')).toBe(
      '/bids/derivatives/seegprep/sub-P076/ct/notes.txt'
    );
  });

  it('climbs at most three directories', () => {
    expect(resolveSibling(CT, '../../../x.tsv')).toBe('/bids/derivatives/x.tsv');
    expect(resolveSibling(CT, '../../../../x.tsv')).toBeNull();
  });

  it('refuses an absolute candidate, a backslash and a re-descent', () => {
    expect(resolveSibling(CT, '/etc/passwd')).toBeNull();
    expect(resolveSibling(CT, 'C:/Windows/win.ini')).toBeNull();
    expect(resolveSibling(CT, '..\\..\\etc\\passwd')).toBeNull();
    // `a/../../b` would climb two while claiming one; the count has to mean something.
    expect(resolveSibling(CT, 'a/../../b.tsv')).toBeNull();
    expect(resolveSibling(CT, 'a//b.tsv')).toBeNull();
    expect(resolveSibling(CT, '')).toBeNull();
    expect(resolveSibling(CT, '..')).toBeNull();
  });

  it('cannot climb out of the root', () => {
    expect(resolveSibling('/ct.nii.gz', '../x.tsv')).toBeNull();
    expect(resolveSibling('/a/ct.nii.gz', '../x.tsv')).toBe('/x.tsv');
  });

  it('keeps a Windows anchor’s separator', () => {
    expect(resolveSibling('C:\\bids\\ct\\a_ct.nii.gz', '../ieeg/a.tsv')).toBe(
      'C:\\bids\\ieeg\\a.tsv'
    );
  });
});

describe('substituteCandidate', () => {
  it('fills the pattern’s named groups', () => {
    expect(
      substituteCandidate('{sub}_space-{space}_electrodes.tsv', { sub: 'sub-1', space: 'T1w' })
    ).toBe('sub-1_space-T1w_electrodes.tsv');
  });

  it('refuses a token the pattern never captured', () => {
    expect(substituteCandidate('{sub}_{missing}.tsv', { sub: 'sub-1' })).toBeNull();
  });
});

describe('siblings()', () => {
  const CT = '/bids/sub-P076/ct/sub-P076_space-T1w_acq-bone_ct.nii.gz';
  const TSV = '/bids/sub-P076/ieeg/sub-P076_space-T1w_electrodes.tsv';

  it('instantiates the manifest’s patterns and probes each candidate through allowPath', async () => {
    const disk = { [TSV]: 'x' };
    const calls = fakeBridge(disk);
    const files = createHostFiles(MANIFEST, fakeAllowPath(disk, calls));
    const found = await files.siblings(CT);

    expect(found['../ieeg/{sub}_space-{space}_electrodes.tsv']).toBe(TSV);
    // Declared, probed, not there: null rather than absent, so a module can tell the two apart.
    expect(found['../ieeg/{sub}_space-{space}_coordsystem.json']).toBeNull();
    expect(found['{sub}_notes.txt']).toBeNull();
    expect(calls.probed).toEqual([
      TSV,
      '/bids/sub-P076/ieeg/sub-P076_space-T1w_coordsystem.json',
      '/bids/sub-P076/ct/sub-P076_notes.txt',
    ]);
  });

  it('says nothing at all about an anchor no pattern matches', async () => {
    const calls = fakeBridge({});
    const files = createHostFiles(MANIFEST, fakeAllowPath({}, calls));
    expect(await files.siblings('/bids/sub-P076/anat/sub-P076_T1w.nii.gz')).toEqual({});
    expect(calls.probed).toEqual([]);
  });

  it('probes nothing for a manifest with no sibling rules, or an uncompilable one', async () => {
    const calls = fakeBridge({});
    const bad: HostFilesManifest = {
      id: 'tetravox.seeg',
      siblings: [{ from: '^(unclosed', candidates: ['x.tsv'] }],
    };
    expect(await createHostFiles(bad, fakeAllowPath({}, calls)).siblings('/a/b.tsv')).toEqual({});
    expect(
      await createHostFiles({ id: 'x.y' }, fakeAllowPath({}, calls)).siblings('/a/b.tsv')
    ).toEqual({});
    expect(calls.probed).toEqual([]);
  });

  it('never probes a candidate that would leave the anchor’s tree', async () => {
    const calls = fakeBridge({});
    const escaping: HostFilesManifest = {
      id: 'tetravox.seeg',
      siblings: [{ from: '^(?<sub>.+)\\.tsv$', candidates: ['/etc/passwd', '../../../../../x'] }],
    };
    const found = await createHostFiles(escaping, fakeAllowPath({}, calls)).siblings('/a/b/c.tsv');
    expect(found).toEqual({ '/etc/passwd': null, '../../../../../x': null });
    expect(calls.probed).toEqual([]);
  });
});

describe('the four bridge calls', () => {
  it('reads through the module channel and maps a refusal onto null', async () => {
    const disk = { '/bids/a.tsv': 'name\tx\n' };
    const calls = fakeBridge(disk);
    const files = createHostFiles(MANIFEST, fakeAllowPath(disk, calls));
    expect(await files.readText('/bids/a.tsv')).toBe('name\tx\n');
    expect(await files.readText('/bids/missing.tsv')).toBeNull();
    expect(calls.read).toEqual([
      ['tetravox.seeg', '/bids/a.tsv'],
      ['tetravox.seeg', '/bids/missing.tsv'],
    ]);
  });

  it('opens with the named reader’s own title and extensions, and an escape hatch', async () => {
    const calls = fakeBridge({});
    const files = createHostFiles(MANIFEST, fakeAllowPath({}, calls));
    expect(await files.openDialog('electrodes')).toEqual(['/bids/a.tsv']);
    expect(calls.open[0]).toEqual([
      'tetravox.seeg',
      {
        title: 'Electrode table',
        filters: [
          { name: 'Electrode table', extensions: ['tsv', 'csv'] },
          { name: 'All files', extensions: ['*'] },
        ],
      },
    ]);
    // A reader the manifest does not declare never reaches main.
    expect(await files.openDialog('nope')).toBeNull();
    expect(calls.open).toHaveLength(1);
  });

  it('saves with the named writer’s filters and sibling templates', async () => {
    const calls = fakeBridge({});
    const files = createHostFiles(MANIFEST, fakeAllowPath({}, calls));
    const target = await files.saveDialog('electrodes', '/bids/sub-P076_electrodes.tsv');
    expect(target?.path).toBe('/bids/out.tsv');
    expect(calls.save[0]).toEqual([
      'tetravox.seeg',
      {
        title: 'Save electrodes',
        filters: [{ name: 'Electrode table', extensions: ['tsv'] }],
        siblings: ['{name}.{stamp}.bak', '{stem}_editlog.json'],
        defaultPath: '/bids/sub-P076_electrodes.tsv',
      },
    ]);
    expect(await files.saveDialog('nope', null)).toBeNull();
    expect(calls.save).toHaveLength(1);
  });

  it('writes with an explicit backup flag, never an absent one', async () => {
    const calls = fakeBridge({});
    const files = createHostFiles(MANIFEST, fakeAllowPath({}, calls));
    await files.writeText('/bids/out.tsv', 'a\n', { backup: true });
    await files.writeText('/bids/out.tsv', 'b\n');
    expect(calls.write).toEqual([
      ['tetravox.seeg', '/bids/out.tsv', 'a\n', { backup: true }],
      ['tetravox.seeg', '/bids/out.tsv', 'b\n', { backup: false }],
    ]);
  });

  it('answers every call safely when there is no bridge at all', async () => {
    delete (globalThis as { tetravox?: TetravoxBridge }).tetravox;
    const files = createHostFiles(MANIFEST, async () => null);
    expect(await files.readText('/bids/a.tsv')).toBeNull();
    expect(await files.openDialog('electrodes')).toBeNull();
    expect(await files.saveDialog('electrodes', null)).toBeNull();
    expect(await files.writeText('/bids/a.tsv', 'x')).toEqual({
      ok: false,
      error: 'no preload bridge',
    });
  });
});
