/**
 * App settings — `settings.json` in Electron's `userData` directory (directed task 9, 2026-08-28).
 *
 * The first *preference* the app has ever had, and deliberately the smallest thing that can hold
 * one. It is main's job rather than the renderer's for two reasons:
 *
 *  * `localStorage` is per **profile directory**, and every E2E launch gets a fresh
 *    `--user-data-dir` (`e2e/fixtures.ts`) precisely so two runs cannot collide over the
 *    single-instance lock. A preference kept there could never be tested across a relaunch without
 *    giving that up. A file main reads and writes can be tested by pointing two launches at one
 *    profile, which is what `e2e/theme.spec.ts` does.
 *  * §5 keeps the filesystem in main. The renderer asking for a value is one small JSON round trip,
 *    which is exactly what the preload bridge is for.
 *
 * Every read is defensive: a missing file, unreadable JSON, a value of the wrong type or a key
 * nobody recognises all degrade to the default. A preference file is not a place to throw — the
 * worst outcome of a corrupt one must be the app opening in the default theme, never the app not
 * opening.
 */

import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Screenshot defaults (directed task: unified settings, 2026-08-28) — the subset of
 * `ScreenshotOptions` (§4.7) a user reasonably wants to fix once rather than re-pick every time the
 * dialog opens. Deliberately not the whole option set: `target`/`viewId` describe *this* capture,
 * not a standing preference.
 */
export interface ScreenshotDefaults {
  background: 'scene' | 'white' | 'black' | 'transparent';
  dpi: number;
  scale?: number;
  autoTrim: boolean;
}

export const DEFAULT_SCREENSHOT_DEFAULTS: ScreenshotDefaults = {
  background: 'scene',
  dpi: 144,
  autoTrim: false,
};

/**
 * One recorded **consent** to run an installed extension (§13, downloadable extensions, 2026-08-30).
 *
 * The record *is* the enablement: there is no separate `enabled` flag, because a module the user has
 * withdrawn consent from must not be one keystroke away from running again. Disabling deletes the
 * entry, which is the same event that empties its `tetravox://module` map entries and revokes its
 * write list.
 *
 * `version` and `hostApi` are what was consented **to**, not what is installed now: an update that
 * arrives with a different `hostApi` is a different ask, and the sheet has to be shown again.
 * `permissions` is the derived list the sheet actually displayed (`manifest-schema.ts`'s
 * `derivePermissions`), stored so a later audit can answer "what was the user shown?" without
 * re-deriving it from a manifest that may since have been updated.
 */
export interface ModuleConsent {
  version: string;
  hostApi: number;
  /** ISO 8601, so the record is readable in the file the user can open. */
  grantedAt: string;
  permissions: string[];
}

/** Everything the app persists. */
export interface AppSettings {
  /** §8's theme switch: what the user picked, not what it resolved to. */
  theme: 'system' | 'light' | 'dark';
  /**
   * The FreeSurfer **subjects directory**, for §3's fsaverage lookup (directed task 8). `''` = unset.
   *
   * A path rather than a bundled `fsaverage`: the subject is ~50 MB of surfaces per hemisphere, it
   * is licensed by FreeSurfer rather than by us, and every machine that would use this feature
   * already has one. The readout simply omits the fsaverage row when the setting is empty or the
   * files under it are not there.
   */
  freesurferSubjectsDir: string;
  /**
   * File ▸ Open Recent — the last {@link MAX_RECENT_SCENES} scene files, most recent first
   * (directed task 13, 2026-08-28).
   *
   * Absolute paths, deduplicated, and **never** validated here: a scene on an unmounted volume must
   * still be listed, because the fix is to plug the disk back in, not to have the entry quietly
   * disappear. The menu opens it and the open fails with §8's toast, which is the honest answer.
   */
  recentScenes: string[];
  /**
   * "Reopen last scene on launch" — off by default (directed task 13).
   *
   * Off, because a viewer that reopens 184 MB of mesh before the user has asked for anything is a
   * viewer that takes ten seconds to start and cannot be told not to. On, it opens
   * `recentScenes[0]` — and only when the launch names no files of its own, so
   * `Tetravox T1.nii.gz` and a double-clicked scene both still win.
   */
  reopenLastScene: boolean;
  /** Persisted §4.7 screenshot defaults, applied to `screenshotOptions` on startup. */
  screenshotDefaults: ScreenshotDefaults;
  /**
   * Which installed extensions the user has consented to run, by module id (2026-08-30).
   *
   * The one key here whose absence is a **security** property rather than a preference: an id that
   * is not in this record is a module main never puts on the `tetravox://module` map, never hands to
   * a job, and never lists as enabled. Bundled modules are seeded on first run without a sheet —
   * they shipped inside the signed application, so installing the app *was* the consent.
   */
  extensions: Record<string, ModuleConsent>;
}

/** §8's File ▸ Open Recent holds ten, which is the maintainer's ask for directed task 13. */
export const MAX_RECENT_SCENES = 10;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  freesurferSubjectsDir: '',
  recentScenes: [],
  reopenLastScene: false,
  screenshotDefaults: DEFAULT_SCREENSHOT_DEFAULTS,
  extensions: {},
};

/** A settings file is a preference, not a document: a megabyte of it is a bug or an attack. */
const MAX_BYTES = 64 * 1024;

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/**
 * rc-style config file (directed task: unified settings, 2026-08-28).
 *
 * `settings.json` in Electron's `userData` is per-profile and edited only through the app; the rc
 * file is the opposite — a plain-text, hand-editable file in a fixed, predictable place, for a user
 * who wants to set a default (say, `freesurferSubjectsDir`) once for every profile/launch rather than
 * click through the dialog, or who is scripting a fleet of headless jobs. `TETRAVOX_HOME` overrides
 * where it lives, mainly so tests never touch a real `~/.tetravox`.
 */
export function configHome(): string {
  return process.env['TETRAVOX_HOME'] ?? join(homedir(), '.tetravox');
}

/** JSON, despite the traditional rc-file look — see `ensureRcFile`'s `_comment` for why. */
export function rcPath(): string {
  return join(configHome(), 'tetravoxrc');
}

/** What the UI shows next to "Reveal": the file a user would edit by hand. */
export function configPath(): string {
  return rcPath();
}

/**
 * Write a starter file the first time `configHome()` is used, so `~/.tetravox/tetravoxrc` exists to
 * be found and edited rather than being a file the docs mention and nothing ever creates.
 *
 * JSON cannot carry `//` comments, so the "commented defaults" are a `_comment` string field —
 * `coercePatch`-style parsing already ignores unknown keys, so it costs nothing at read time and
 * explains the file to anyone who opens it. Every value below is commented **out** by being absent:
 * this is intentionally an empty override set, not a copy of the defaults a later app version would
 * have to keep in sync.
 */
export function ensureRcFile(): void {
  const path = rcPath();
  try {
    readFileSync(path, 'utf8');
    return; // already there — never overwrite a file the user may have edited.
  } catch {
    // fall through to create it
  }
  const starter = {
    _comment:
      'Tetravox rc file. JSON has no comments, so this field is the explanation: uncomment ' +
      '(add) any of theme / freesurferSubjectsDir / reopenLastScene / screenshotDefaults to set a ' +
      'machine-wide default. settings.json (the in-app dialog) wins over this file when both set ' +
      'the same key.',
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(starter, null, 2)}\n`, 'utf8');
  } catch {
    // A config file that cannot be created is not worth failing a launch over.
  }
}

/** Read `tetravoxrc` as a settings patch. Missing, corrupt or oversized degrades to `{}`, never throws. */
function readRc(): Partial<AppSettings> {
  try {
    const text = readFileSync(rcPath(), 'utf8');
    if (text.length > MAX_BYTES) return {};
    return coercePatch(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Coerce whatever was on disk into an `AppSettings`, one field at a time. */
export function coerceSettings(raw: unknown): AppSettings {
  return { ...DEFAULT_SETTINGS, ...coercePatch(raw) };
}

/**
 * The subset of `AppSettings` a value actually *carries* — keys that are absent stay absent.
 *
 * Separate from {@link coerceSettings} because a patch and a whole file are different things, and
 * conflating them is a data-loss bug that only appears once there is a second key: filling a patch's
 * missing fields with defaults and spreading it over the file resets every field the caller did not
 * mention. With one setting that was invisible; with two it would silently reset the user's theme
 * every time they set the subjects directory.
 */
export function coercePatch(raw: unknown): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  if (raw === null || typeof raw !== 'object') return out;
  const record = raw as Record<string, unknown>;
  const theme = record['theme'];
  if (theme === 'system' || theme === 'light' || theme === 'dark') out.theme = theme;
  const dir = record['freesurferSubjectsDir'];
  if (typeof dir === 'string') out.freesurferSubjectsDir = dir;
  const recent = record['recentScenes'];
  if (Array.isArray(recent)) {
    out.recentScenes = dedupe(recent.filter((v): v is string => typeof v === 'string' && v !== ''));
  }
  const reopen = record['reopenLastScene'];
  if (typeof reopen === 'boolean') out.reopenLastScene = reopen;
  const screenshotDefaults = coerceScreenshotDefaults(record['screenshotDefaults']);
  if (screenshotDefaults !== undefined) out.screenshotDefaults = screenshotDefaults;
  const extensions = coerceExtensions(record['extensions']);
  if (extensions !== undefined) out.extensions = extensions;
  return out;
}

/**
 * The consent record, one entry at a time — the same defensive shape as every other key, and for a
 * sharper reason: a corrupt entry here must **fail closed**.
 *
 * A record that does not parse is a module that is not enabled, which costs the user one click on a
 * consent sheet they have already seen. The opposite reading — filling a missing field with a
 * default and running the module anyway — would let a truncated write grant a capability nobody
 * confirmed, so every field is required and a bad entry is dropped rather than repaired.
 */
function coerceExtensions(raw: unknown): Record<string, ModuleConsent> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, ModuleConsent> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(id)) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const version = entry['version'];
    const hostApi = entry['hostApi'];
    const grantedAt = entry['grantedAt'];
    const permissions = entry['permissions'];
    if (typeof version !== 'string' || version === '') continue;
    if (typeof hostApi !== 'number' || !Number.isInteger(hostApi)) continue;
    if (typeof grantedAt !== 'string' || grantedAt === '') continue;
    if (!Array.isArray(permissions)) continue;
    out[id] = {
      version,
      hostApi,
      grantedAt,
      permissions: permissions.filter((p): p is string => typeof p === 'string').slice(0, 32),
    };
  }
  return out;
}

/** Same defensive shape as {@link coercePatch}: a bad field is dropped, never thrown on. */
function coerceScreenshotDefaults(raw: unknown): ScreenshotDefaults | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const out: ScreenshotDefaults = { ...DEFAULT_SCREENSHOT_DEFAULTS };
  let sawAny = false;
  const background = record['background'];
  if (background === 'scene' || background === 'white' || background === 'transparent') {
    out.background = background;
    sawAny = true;
  }
  const dpi = record['dpi'];
  if (typeof dpi === 'number' && Number.isFinite(dpi) && dpi > 0) {
    out.dpi = dpi;
    sawAny = true;
  }
  const scale = record['scale'];
  if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) {
    out.scale = scale;
    sawAny = true;
  }
  const autoTrim = record['autoTrim'];
  if (typeof autoTrim === 'boolean') {
    out.autoTrim = autoTrim;
    sawAny = true;
  }
  return sawAny ? out : undefined;
}

/** First occurrence wins, capped at {@link MAX_RECENT_SCENES}. */
function dedupe(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) if (!out.includes(path)) out.push(path);
  return out.slice(0, MAX_RECENT_SCENES);
}

/**
 * Move `path` to the head of the recent list and write it back.
 *
 * Called after every successful scene save *and* every successful open, so the list is "scenes this
 * user actually worked with" rather than "scenes they opened" — a scene created by Save As is the
 * one they will want back first, and it has never been opened.
 */
export function rememberRecentScene(path: string): AppSettings {
  if (path === '') return readSettings();
  const current = readSettings().recentScenes;
  return writeSettings({ recentScenes: dedupe([path, ...current]) });
}

/**
 * Precedence: hardcoded defaults < `tetravoxrc` < `settings.json` — the rc file sets a machine-wide
 * default, and the in-app dialog (backed by `settings.json`) always overrides it, because a user who
 * clicked a control in the running app has a stronger claim on the value than a file they may have
 * forgotten was there.
 */
export function readSettings(): AppSettings {
  const rcPatch = readRc();
  let filePatch: Partial<AppSettings> = {};
  try {
    const text = readFileSync(settingsPath(), 'utf8');
    if (text.length <= MAX_BYTES) filePatch = coercePatch(JSON.parse(text));
  } catch {
    // missing or corrupt settings.json degrades to {} — same as always.
  }
  return coerceSettings({ ...rcPatch, ...filePatch });
}

/**
 * Merge a patch over what is on disk and write it back; returns the settings as they now stand.
 *
 * Read-modify-write rather than write-whole so a second window (or a later key) cannot clobber a
 * field it did not know about. Returning the merged value means the renderer never has to guess
 * whether its write landed.
 */
export function writeSettings(patch: unknown): AppSettings {
  const next = coerceSettings({ ...readSettings(), ...coercePatch(patch) });
  try {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // A preference that cannot be written is not worth failing a launch over; the value still
    // applies to this session and the next one simply starts at the default.
  }
  return next;
}
