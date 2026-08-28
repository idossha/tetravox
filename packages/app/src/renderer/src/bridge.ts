/**
 * Access to the §5 preload bridge, with a null object for contexts that have none (vitest, a plain
 * browser tab). Paths and small JSON only — there is deliberately no byte channel to reach for.
 */

import type {
  AppSettings,
  JobDonePayload,
  JobFramesPayload,
  JobFramesResult,
  JobSpec,
  JobWriteResult,
  OpenedPath,
  ScreenshotDefaults,
  SceneCommand,
  SceneIoResult,
  TetravoxBridge,
} from '../../preload/index';

/** `main/settings.ts`'s `DEFAULT_SCREENSHOT_DEFAULTS`, duplicated for the same reason as everything
 * else on this page — the renderer must not import from `main`. */
const DEFAULT_SCREENSHOT_DEFAULTS: ScreenshotDefaults = {
  background: 'scene',
  dpi: 144,
  autoTrim: false,
};

const ABSENT: TetravoxBridge = {
  openDialog: async () => [],
  getDroppedFilePath: () => '',
  allowPath: async () => null,
  startupPaths: async () => [],
  // No bridge means no filesystem, so no `toMNI/` can be found — the MNI spaces stay greyed out
  // with their reason, which is the same thing they do for a subject that really has none.
  subjectSpaces: async () => null,
  // No bridge means no filesystem, so no `fsaverage` can be found and no directory can be picked —
  // the readout omits the fsaverage row, which is the same thing it does for an unset setting.
  surfaceSpaces: async () => null,
  chooseDirectory: async () => null,
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
  onOpenScene: () => () => {},
  startupScene: async () => null,
  rememberScene: async () => null,
  onSceneCommand: () => () => {},
  // No bridge means no `settings.json`, so the preference is the default and a write is a no-op
  // that still answers with what the caller will see. That is what keeps the theme switch working
  // in a browser tab and under vitest: it applies, it just does not survive a reload.
  settings: async () => ({
    theme: 'system',
    freesurferSubjectsDir: '',
    recentScenes: [],
    reopenLastScene: false,
    screenshotDefaults: DEFAULT_SCREENSHOT_DEFAULTS,
  }),
  setSettings: async (patch) => ({
    theme: 'system',
    freesurferSubjectsDir: '',
    recentScenes: [],
    reopenLastScene: false,
    screenshotDefaults: DEFAULT_SCREENSHOT_DEFAULTS,
    ...patch,
  }),
  // No bridge means no `tetravoxrc` either — the footer shows nothing to reveal.
  configPath: async () => '',
  revealConfigFile: async () => {},
  onOpenSettings: () => () => {},
  // No bridge means no filesystem and no launch argv, so there is no job to run — which is exactly
  // what a vitest run and a plain browser tab should see.
  jobSpec: async () => null,
  jobWrite: async () => ({ ok: false, error: 'no preload bridge' }),
  jobCapture: async () => null,
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
  AppSettings,
  JobDonePayload,
  JobFramesPayload,
  JobFramesResult,
  JobSpec,
  JobWriteResult,
  OpenedPath,
  ScreenshotDefaults,
  SceneCommand,
  SceneIoResult,
};
