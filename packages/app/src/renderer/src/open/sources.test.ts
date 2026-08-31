/**
 * `DatasetSource` construction (§8, §5 rule 9).
 *
 * The bridge is stubbed with an allow-list of paths that "exist", because that is exactly what
 * `allowPath` reports: it returns null for anything it cannot `realpath`, so the renderer learns a
 * sidecar's existence from the same call that admits it — and never stats a file itself.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TetravoxBridge } from '../../../preload/index';
import { requestFromDroppedFile, requestFromPath } from './sources';

interface Stub {
  bridge: TetravoxBridge;
  allowed: string[];
  droppedPath: string;
}

function stubBridge(existing: readonly string[], droppedPath = ''): Stub {
  const stub: Stub = {
    allowed: [],
    droppedPath,
    bridge: {
      // Settings: this stub keeps no preferences, which is what a test wants.
      settings: async () => ({
        theme: 'system' as const,
        freesurferSubjectsDir: '',
        recentScenes: [],
        reopenLastScene: false,
        screenshotDefaults: { background: 'scene' as const, dpi: 144, autoTrim: false },
        checkForUpdates: true,
        skippedUpdateVersion: '',
      }),
      setSettings: async () => ({
        theme: 'system' as const,
        freesurferSubjectsDir: '',
        recentScenes: [],
        reopenLastScene: false,
        screenshotDefaults: { background: 'scene' as const, dpi: 144, autoTrim: false },
        checkForUpdates: true,
        skippedUpdateVersion: '',
      }),
      configPath: async () => '/tvx-test/tetravoxrc',
      revealConfigFile: async () => {},
      onOpenSettings: () => () => {},
      sampleCatalog: async () => ({ samples: [], cacheDir: '' }),
      sampleStatuses: async () => [],
      sampleOpen: async () => ({ ok: false, error: 'no samples in this test' }),
      sampleCancel: async () => false,
      sampleRemove: async () => [],
      sampleRevealCache: async () => {},
      onSampleProgress: () => () => {},
      onOpenSampleData: () => () => {},
      // The `--job` half of the bridge: this window was not launched for one.
      jobSpec: async () => null,
      jobWrite: async () => ({ ok: false, error: 'not a job run' }),
      jobCapture: async () => null,
      jobFrames: async () => ({ ok: false, error: 'not a job run' }),
      jobLog: () => {},
      jobDone: async () => false,
      openDialog: async () => [],
      getDroppedFilePath: () => stub.droppedPath,
      allowPath: async (path: string) => {
        if (!existing.includes(path)) return null;
        stub.allowed.push(path);
        return { path, url: `tetravox://file/${encodeURIComponent(path)}` };
      },
      startupPaths: async () => [],
      subjectSpaces: async () => null,
      surfaceSpaces: async () => null,
      chooseDirectory: async () => null,
      phase0Fixture: async () => null,
      onOpened: () => () => {},
      log: () => {},
      // Phase 2's scene IO. Nothing under test here touches it, and the stub says so rather than
      // being cast: the point of stubbing the whole `TetravoxBridge` shape is that a new member is
      // a compile error here and now, not an `undefined` at runtime later.
      openSceneDialog: async () => null,
      saveSceneDialog: async () => null,
      relocateDialog: async () => null,
      readSceneFile: async () => ({ ok: false, error: 'not stubbed' }),
      writeSceneFile: async () => ({ ok: false, error: 'not stubbed' }),
      onOpenScene: () => () => {},
      startupScene: async () => null,
      rememberScene: async () => null,
      onSceneCommand: () => () => {},
      // §5 rule 11's module channels: no module is under test here, so every one refuses.
      moduleReadText: async () => ({ ok: false as const, error: 'no module io in this test' }),
      moduleOpenDialog: async () => [],
      moduleSaveDialog: async () => null,
      moduleWriteText: async () => ({ ok: false as const, error: 'no module io in this test' }),
      setDocumentEdited: () => {},
    },
  };
  (globalThis as { tetravox?: TetravoxBridge }).tetravox = stub.bridge;
  return stub;
}

afterEach(() => {
  delete (globalThis as { tetravox?: TetravoxBridge }).tetravox;
});

describe('requestFromPath', () => {
  it('builds a `path` source and admits the sidecars beside it (§5 rule 9)', async () => {
    const stub = stubBridge([
      '/d/m2m_ernie/final_tissues.nii.gz',
      '/d/m2m_ernie/final_tissues_LUT.txt',
    ]);
    const request = await requestFromPath('/d/m2m_ernie/final_tissues.nii.gz');
    expect(request?.name).toBe('final_tissues.nii.gz');
    expect(request?.source).toEqual({
      kind: 'path',
      path: '/d/m2m_ernie/final_tissues.nii.gz',
      sidecars: { lut: '/d/m2m_ernie/final_tissues_LUT.txt' },
    });
    // The sidecar was allow-listed too, or the worker's fetch of it would 403.
    expect(stub.allowed).toContain('/d/m2m_ernie/final_tissues_LUT.txt');
  });

  it('picks up a `.msh.opt` for a mesh (§6.2, §7.6)', async () => {
    stubBridge(['/d/ernie.msh', '/d/ernie.msh.opt', '/d/ernie_LUT.txt']);
    const request = await requestFromPath('/d/ernie.msh');
    expect(request?.source).toEqual({
      kind: 'path',
      path: '/d/ernie.msh',
      sidecars: { lut: '/d/ernie_LUT.txt', opt: '/d/ernie.msh.opt' },
    });
  });

  it('omits `sidecars` entirely when there are none', async () => {
    stubBridge(['/d/T1.nii.gz']);
    const request = await requestFromPath('/d/T1.nii.gz');
    expect(request?.source).toEqual({ kind: 'path', path: '/d/T1.nii.gz' });
  });

  it('returns null when main refuses the path', async () => {
    stubBridge([]);
    expect(await requestFromPath('/etc/hosts')).toBeNull();
  });
});

describe('requestFromDroppedFile (§8)', () => {
  const file = (name: string): File => ({ name }) as File;

  it('takes the path branch when `getPathForFile` answers', async () => {
    const stub = stubBridge(['/d/ernie.msh'], '/d/ernie.msh');
    const request = await requestFromDroppedFile(file('ernie.msh'));
    expect(request?.source).toEqual({ kind: 'path', path: '/d/ernie.msh' });
    expect(stub.allowed).toEqual(['/d/ernie.msh']);
  });

  it('falls back to the `File` itself when it returns "" — and never reads its bytes', async () => {
    stubBridge([], '');
    const dropped = file('ernie.msh');
    const arrayBuffer = vi.fn();
    Object.assign(dropped, { arrayBuffer, stream: vi.fn() });
    const request = await requestFromDroppedFile(dropped);
    expect(request?.source).toEqual({ kind: 'file', file: dropped });
    expect(request?.path).toBeNull();
    // §5 rule 3 / AGENTS rule 7: a 492 MB allocation on the UI thread is exactly what this forbids.
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('falls back to the `File` when the path exists but main will not admit it', async () => {
    // A file deleted between the drop and the IPC round trip still has a live `File` handle.
    stubBridge([], '/d/gone.msh');
    const dropped = file('gone.msh');
    const request = await requestFromDroppedFile(dropped);
    expect(request?.source).toEqual({ kind: 'file', file: dropped });
  });
});
