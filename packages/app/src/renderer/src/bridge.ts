/**
 * Access to the §5 preload bridge, with a null object for contexts that have none (vitest, a plain
 * browser tab). Paths and small JSON only — there is deliberately no byte channel to reach for.
 */

import type {
  JobDonePayload,
  JobFramesPayload,
  JobFramesResult,
  JobSpec,
  JobWriteResult,
  OpenedPath,
  SceneCommand,
  SceneIoResult,
  TetravoxBridge,
} from '../../preload/index';

const ABSENT: TetravoxBridge = {
  openDialog: async () => [],
  getDroppedFilePath: () => '',
  allowPath: async () => null,
  startupPaths: async () => [],
  phase0Fixture: async () => null,
  onOpened: () => () => {},
  log: () => {},
  // Phase 2's scene IO. A context with no bridge has no filesystem at all, so "the user cancelled"
  // and "there is nowhere to write" are the same answer — and the reason is carried, not swallowed.
  openSceneDialog: async () => null,
  saveSceneDialog: async () => null,
  relocateDialog: async () => null,
  readSceneFile: async () => ({ ok: false, error: 'no preload bridge' }),
  writeSceneFile: async () => ({ ok: false, error: 'no preload bridge' }),
  onSceneCommand: () => () => {},
  // No bridge means no filesystem and no launch argv, so there is no job to run — which is exactly
  // what a vitest run and a plain browser tab should see.
  jobSpec: async () => null,
  jobWrite: async () => ({ ok: false, error: 'no preload bridge' }),
  jobFrames: async () => ({ ok: false, error: 'no preload bridge' }),
  jobLog: () => {},
  jobDone: async () => false,
};

export function bridge(): TetravoxBridge {
  return (globalThis as { tetravox?: TetravoxBridge }).tetravox ?? ABSENT;
}

export function hasBridge(): boolean {
  return (globalThis as { tetravox?: TetravoxBridge }).tetravox !== undefined;
}

export type {
  JobDonePayload,
  JobFramesPayload,
  JobFramesResult,
  JobSpec,
  JobWriteResult,
  OpenedPath,
  SceneCommand,
  SceneIoResult,
};
