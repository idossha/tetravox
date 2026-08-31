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
  Sample,
  SampleProgress,
  SampleStatus,
  ScreenshotDefaults,
  SceneCommand,
  SceneIoResult,
  TetravoxBridge,
  ModuleDialogFilter,
  ModuleOpenOptions,
  ModuleReadResult,
  ModuleSaveOptions,
  ModuleSaveTarget,
  ModuleWriteResult,
  // Appended 2026-08-30 with §13.8's extension channels.
  ExtensionEntry,
  ExtensionFile,
  ExtensionVersion,
  ModuleActionResult,
  ModuleProgress,
  ModuleProgressState,
  ModuleStatus,
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
  // No bridge means no network and no cache: the dialog shows an empty catalogue and every action
  // says so, rather than a browser tab pretending it could download 60 MB somewhere.
  sampleCatalog: async () => ({ samples: [], cacheDir: '' }),
  sampleStatuses: async () => [],
  sampleOpen: async () => ({ ok: false, error: 'no preload bridge' }),
  sampleCancel: async () => false,
  sampleRemove: async () => [],
  sampleRevealCache: async () => {},
  onSampleProgress: () => () => {},
  onOpenSampleData: () => () => {},
  // No bridge means no filesystem and no launch argv, so there is no job to run — which is exactly
  // what a vitest run and a plain browser tab should see.
  jobSpec: async () => null,
  jobWrite: async () => ({ ok: false, error: 'no preload bridge' }),
  jobCapture: async () => null,
  jobFrames: async () => ({ ok: false, error: 'no preload bridge' }),
  jobLog: () => {},
  jobDone: async () => false,
  // No bridge means no filesystem and no OS sheets, so a module's file calls answer the way they
  // answer a user who cancelled — with the reason carried, never swallowed. `modules/hostFiles.ts`
  // maps these onto the `null` a module already handles.
  moduleReadText: async () => ({ ok: false, error: 'no preload bridge' }),
  moduleOpenDialog: async () => [],
  moduleSaveDialog: async () => null,
  moduleWriteText: async () => ({ ok: false, error: 'no preload bridge' }),
  // No window to mark, and no window to guard: a context with no bridge cannot be closed by a user.
  setDocumentEdited: () => {},
  // Extensions (§13.8, 2026-08-30). No bridge means no disk, no network and no consent record, so
  // the dialog shows an empty catalogue and every action answers "no preload bridge" with the
  // statuses it already had — which is `[]`. That is the honest answer for vitest and a browser tab:
  // a context that cannot install a module also cannot be running one, because the only way to reach
  // a module's code is a `tetravox://module` URL only main can put a file behind.
  moduleCatalog: async () => ({ modules: [], dir: '' }),
  moduleStatuses: async () => [],
  moduleManifests: async () => [],
  moduleInstall: async () => ({ ok: false, error: 'no preload bridge', statuses: [] }),
  moduleCancel: async () => false,
  moduleEnable: async () => ({ ok: false, error: 'no preload bridge', statuses: [] }),
  moduleDisable: async () => ({ ok: false, error: 'no preload bridge', statuses: [] }),
  moduleRemove: async () => ({ ok: false, error: 'no preload bridge', statuses: [] }),
  moduleRevealDir: async () => {},
  onModuleProgress: () => () => {},
  onOpenExtensions: () => () => {},
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
  Sample,
  SampleProgress,
  SampleStatus,
  ScreenshotDefaults,
  SceneCommand,
  SceneIoResult,
  // Appended 2026-08-30 with §5 rule 11's module channels; the list is append-only so that
  // branches building on it merge.
  ModuleDialogFilter,
  ModuleOpenOptions,
  ModuleReadResult,
  ModuleSaveOptions,
  ModuleSaveTarget,
  ModuleWriteResult,
  // Appended 2026-08-30 with §13.8's extension channels; the list is append-only so that branches
  // building on it merge.
  ExtensionEntry,
  ExtensionFile,
  ExtensionVersion,
  ModuleActionResult,
  ModuleProgress,
  ModuleProgressState,
  ModuleStatus,
};
