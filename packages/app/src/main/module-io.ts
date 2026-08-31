/**
 * File IO for §13 modules (§5 rule 11): four channels, registered from here the way
 * `registerJobIpc()` registers the `--job` group, plus §5 rule 12's unsaved-edits close guard.
 *
 * The shape is the one A-SHELL's decision 1 (DECISIONS 2026-08-27) laid down for scene IO, applied
 * to a second kind of small text file:
 *
 *  1. **Reading is a restatement of a door that is already open, not a new one.** `module-read-text`
 *     answers only for paths already on the `tetravox://file/…` allow-list (`paths.ts`) — the same
 *     paths `readSceneFile` has returned 8 MiB of, with no content check, since Phase 2, and the same
 *     ones `subject-spaces.ts` reads sidecar text out of in main. This one is *narrower* than either:
 *     ≤ 1 MiB and a five-extension filter. It has no write twin.
 *  2. **Writing is a module-scoped list only a Save sheet fills.** `module-save-dialog` admits the
 *     path the user chose **and** the writer's manifest-declared same-directory siblings, into
 *     `Map<moduleId, …>` — separate from `scene-io.ts`'s `writable`, so a module cannot write over a
 *     scene and the scene channel cannot write a module's files. Sibling templates are validated
 *     before substitution and the result is validated again: one directory, no separator, no `..`.
 *  3. **The backup and the temp-then-rename are main's, not the renderer's.** A `.bak` copy never
 *     crosses IPC — main copies the file it is about to replace — and the write itself goes to
 *     `<path>.part` and is renamed into place, the `sample-data.ts` precedent, so an interrupted
 *     write cannot leave a half-written electrode table where the whole one was.
 *
 * Sibling *discovery* is deliberately not here. The renderer already probes derived sibling names
 * through `bridge().allowPath` (`open/sources.ts#firstAllowed`), and a main-side resolver would buy
 * no admission-policy gain over that; `renderer/src/modules/hostFiles.ts` does it that way.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { BrowserWindow as BrowserWindowClass, dialog, ipcMain } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { allowPath, allowPaths, resolveAllowed } from './paths';
import { fileUrl } from './protocol';
import type { OpenedPath } from './menu';
// §13.1's data-only barrel. Main-safe by construction — no DOM type, no `node:` import, no engine —
// which is the same property that lets `job.ts` validate a module action before a window exists.
import { manifestFor } from '../modules/manifests';
import { stemOf } from '../modules/manifest-types';
import type { ModuleReader, ModuleWriter } from '../modules/manifest-types';

/**
 * What `module-read-text` will read. Text a module parses on the UI thread: an electrode table, a
 * BIDS sidecar, an edit log. Not a format with a reader — those go through a dataset worker.
 */
export const MODULE_READ_EXTENSIONS: readonly string[] = ['.tsv', '.csv', '.json', '.txt', '.fcsv'];

/** 1 MiB. A 103-contact `electrodes.tsv` is ~12 kB; a 5 000-row one is under 600 kB. */
export const MAX_MODULE_READ_BYTES = 1024 * 1024;

/** 8 MiB, the same line `scene-io.ts` draws between "small JSON" and "a byte channel". */
export const MAX_MODULE_WRITE_BYTES = 8 * 1024 * 1024;

/**
 * A sibling **template** before substitution: `{name}.{stamp}.bak`, `{stem}_editlog.json`. The
 * braces are in the class because this is the un-substituted form; `SIBLING_NAME` is what the
 * result must match.
 */
export const SIBLING_TEMPLATE = /^[A-Za-z0-9_.{}-]{1,96}$/;

/** A sibling **name** after substitution: no separator, no brace left over, and `..` refused below. */
export const SIBLING_NAME = /^[A-Za-z0-9_.-]{1,96}$/;

export type ModuleReadResult = { ok: true; text: string } | { ok: false; error: string };
export type ModuleWriteResult =
  { ok: true; backupPath: string | null } | { ok: false; error: string };

export interface ModuleDialogFilter {
  name: string;
  extensions: string[];
}

export interface ModuleOpenOptions {
  title: string;
  filters: ModuleDialogFilter[];
  /** Which of the module's `readers` this sheet is for; main prefers the manifest's own copy. */
  readerId?: string;
}

export interface ModuleSaveOptions extends ModuleOpenOptions {
  /** The writer's sibling templates, validated here and admitted with the chosen path. */
  siblings: string[];
  defaultPath: string | null;
  /** Which of the module's `writers` this sheet is for; main prefers the manifest's own copy. */
  writerId?: string;
}

/** What a Save sheet returns: the chosen path, and each template's substituted absolute path. */
export interface ModuleSaveTarget {
  path: string;
  siblings: Record<string, string>;
}

// ------------------------------------------------------------------------------------------------
// Names, stamps and sibling templates
// ------------------------------------------------------------------------------------------------

/**
 * `{stem}` — re-exported, never redefined.
 *
 * The rule and the reason it is one function live with the module contract
 * (`../modules/manifest-types`), because the renderer substitutes the same token against the same
 * anchor and may not import from `main`. Main admitting one name while the module writes another is
 * exactly the failure the shared definition exists to make impossible.
 */
export { stemOf };

/** `{stamp}` — `YYYYMMDD-HHMMSS` in local time, the form the Slicer editor's `.bak` names use. */
export function stampNow(at: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${pad(at.getFullYear(), 4)}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/** The `{stamp}` shape, for recognising a backup name a *later* write will mint. */
const STAMP_SOURCE = '\\d{8}-\\d{6}';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Is this a template a module may declare at all? Checked before any substitution happens. */
export function isSiblingTemplate(template: unknown): template is string {
  return typeof template === 'string' && SIBLING_TEMPLATE.test(template);
}

/**
 * Substitute `{name}` / `{stem}` / `{stamp}` and validate the result, or null when the template or
 * the result is not a plain sibling name.
 *
 * Both ends are checked on purpose. The template guards what a module is allowed to *declare*; the
 * result guards what an anchor name can *turn it into* — a file called `../x` cannot be opened, but
 * a manifest is data and this is the last place either can be caught.
 */
export function substituteSibling(
  template: string,
  anchorName: string,
  stamp: string
): string | null {
  if (!isSiblingTemplate(template)) return null;
  // One pass, so a token that appears *inside* a substituted value is not substituted again, and an
  // unknown token (`{sub}`, a typo) survives to be caught by the brace check below.
  const name = template.replace(/\{(name|stem|stamp)\}/g, (_match, token: string) =>
    token === 'name' ? anchorName : token === 'stem' ? stemOf(anchorName) : stamp
  );
  if (name.includes('{') || name.includes('}')) return null;
  if (name.includes('..') || name === '.') return null;
  return SIBLING_NAME.test(name) ? name : null;
}

/**
 * The same substitution as a matcher, with `{stamp}` left open.
 *
 * A `{name}.{stamp}.bak` admitted when the Save sheet closed carries the stamp of *that* moment; the
 * backup a write mints minutes later carries its own. Admitting the shape rather than one instant is
 * what lets the second save of a session still make a `.bak`, and it is still one directory, one
 * anchor and one fixed prefix and suffix.
 */
function siblingMatcher(template: string, anchorName: string): RegExp | null {
  if (!isSiblingTemplate(template) || !template.includes('{stamp}')) return null;
  const probe = substituteSibling(template, anchorName, '00000000-000000');
  if (probe === null) return null;
  // Split on `{stamp}` **first**, so a `{stamp}` that arrived inside the anchor's own name is a
  // literal to escape rather than a second wildcard.
  const source = template
    .split('{stamp}')
    .map((part) =>
      escapeRegExp(
        part.replace(/\{(name|stem)\}/g, (_match, token: string) =>
          token === 'name' ? anchorName : stemOf(anchorName)
        )
      )
    )
    .join(STAMP_SOURCE);
  return new RegExp(`^${source}$`);
}

// ------------------------------------------------------------------------------------------------
// The module-scoped write list
// ------------------------------------------------------------------------------------------------

interface WriteList {
  /** Exact paths: the chosen file and every stamp-free sibling. */
  paths: Set<string>;
  /** Stamp-bearing siblings, as a directory and a name matcher. */
  stamped: { dir: string; name: RegExp }[];
}

const writeLists = new Map<string, WriteList>();

/** Canonicalise for the write list. The file may not exist yet, so `realpath` is not an option. */
function normalise(candidate: string): string | null {
  if (!candidate || !isAbsolute(candidate)) return null;
  return resolve(candidate);
}

/**
 * Admit `target` and the substituted `templates` beside it for this module. Only a Save sheet that
 * the user confirmed calls this.
 *
 * A template that fails validation is dropped: it is not admitted, it is not returned, and the rest
 * of the save still works. A module's templates are static data, so an invalid one is a manifest bug
 * to be found by its own tests, not a reason to refuse the save the user just asked for.
 */
export function admitModuleWrite(
  moduleId: string,
  target: string,
  templates: readonly string[]
): ModuleSaveTarget | null {
  const path = normalise(target);
  if (path === null) return null;
  const dir = dirname(path);
  const anchor = basename(path);
  const stamp = stampNow();

  const list = writeLists.get(moduleId) ?? { paths: new Set<string>(), stamped: [] };
  writeLists.set(moduleId, list);
  list.paths.add(path);

  const siblings: Record<string, string> = {};
  for (const template of templates) {
    if (!isSiblingTemplate(template)) continue;
    const name = substituteSibling(template, anchor, stamp);
    if (name === null) continue;
    siblings[template] = join(dir, name);
    const matcher = siblingMatcher(template, anchor);
    if (matcher === null) list.paths.add(join(dir, name));
    else list.stamped.push({ dir, name: matcher });
  }
  return { path, siblings };
}

/** May this module write here? Exact admission, or a stamped sibling's shape in its own directory. */
export function isModuleWritable(moduleId: string, candidate: string): boolean {
  const path = normalise(candidate);
  if (path === null) return false;
  const list = writeLists.get(moduleId);
  if (list === undefined) return false;
  if (list.paths.has(path)) return true;
  const dir = dirname(path);
  const name = basename(path);
  return list.stamped.some((entry) => entry.dir === dir && entry.name.test(name));
}

/**
 * **Revocation** (2026-08-30): drop one module's admissions.
 *
 * A Save sheet admits a path for the *editing session* that opened it, not for the process. The
 * module's own `savePath` lives on its instance and dies with it (`seeg/editor.ts`), so once the
 * module leaves the slot nothing legitimate can write to those paths again without a new sheet —
 * and leaving them admitted is a capability against a subject the user has since navigated away
 * from. `tetravox:module-clear-writes` is the renderer's call on deactivate; `sendOpenScene` and
 * `sendSceneCommand('new'|'open')` are main's, for the routes that replace the whole document.
 *
 * This scopes **accidents**, not attacks: a compromised renderer simply never sends the message.
 * The durable fix is a narrower `allowPath`, which is out of scope here and is in `docs/ROADMAP.md`.
 */
export function revokeModuleWrites(moduleId: unknown): boolean {
  if (typeof moduleId !== 'string' || moduleId === '') return false;
  return writeLists.delete(moduleId);
}

/** Every module's admissions at once: a new or newly-opened document is a new editing session. */
export function revokeAllModuleWrites(): void {
  writeLists.clear();
}

/** Test seam, mirroring `paths.ts`'s and `scene-io.ts`'s. */
export function clearModuleWriteLists(): void {
  revokeAllModuleWrites();
}

// ------------------------------------------------------------------------------------------------
// The four channels
// ------------------------------------------------------------------------------------------------

/** The last suffix of a basename, lowercased and including the dot; `''` when there is none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * `tetravox:module-read-text` — UTF-8 text of an **already allow-listed** path, ≤ 1 MiB, from the
 * five extensions a module parses. No path is admitted here; that is `allowPath`'s job and a user
 * gesture's.
 */
export function moduleReadText(moduleId: unknown, candidate: unknown): ModuleReadResult {
  if (typeof moduleId !== 'string' || moduleId === '')
    return { ok: false, error: 'not an extension' };
  if (typeof candidate !== 'string') return { ok: false, error: 'not a path' };
  const real = resolveAllowed(candidate);
  if (real === null) return { ok: false, error: 'not on the allow-list' };
  const extension = extensionOf(basename(real));
  if (!MODULE_READ_EXTENSIONS.includes(extension)) {
    return {
      ok: false,
      error: `${basename(real)} is not one of ${MODULE_READ_EXTENSIONS.join(' ')}`,
    };
  }
  try {
    const size = statSync(real).size;
    if (size > MAX_MODULE_READ_BYTES) {
      return { ok: false, error: `${size} bytes exceeds the ${MAX_MODULE_READ_BYTES}-byte cap` };
    }
    return { ok: true, text: readFileSync(real, 'utf8') };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** One filter entry, or null. Extensions are names, never patterns with a separator in them. */
function coerceFilter(value: unknown): ModuleDialogFilter | null {
  if (typeof value !== 'object' || value === null) return null;
  const { name, extensions } = value as { name?: unknown; extensions?: unknown };
  if (typeof name !== 'string' || name === '' || !Array.isArray(extensions)) return null;
  const clean = extensions
    .filter((e): e is string => typeof e === 'string' && /^[A-Za-z0-9.*]{1,16}$/.test(e))
    .slice(0, 16);
  return clean.length === 0 ? null : { name: name.slice(0, 64), extensions: clean };
}

function coerceFilters(value: unknown): ModuleDialogFilter[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(coerceFilter)
    .filter((f): f is ModuleDialogFilter => f !== null)
    .slice(0, 8);
}

function coerceTitle(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value.slice(0, 120) : fallback;
}

/**
 * The reader a sheet is for, out of `MANIFESTS` — or null when main does not know this module.
 *
 * "Does not know" is a real case rather than an error: a harness drives these handlers directly, and
 * a `--job` window may be told about a module the barrel in this build does not carry. The renderer's
 * own title and filters are then the fallback, still coerced, which is why {@link coerceFilters}
 * stays on the path either way.
 */
function readerOf(moduleId: string, readerId: unknown): ModuleReader | null {
  if (typeof readerId !== 'string' || readerId === '') return null;
  return (manifestFor(moduleId)?.readers ?? []).find((r) => r.id === readerId) ?? null;
}

/** The writer a Save sheet is for, out of `MANIFESTS`. See {@link readerOf}. */
function writerOf(moduleId: string, writerId: unknown): ModuleWriter | null {
  if (typeof writerId !== 'string' || writerId === '') return null;
  return (manifestFor(moduleId)?.writers ?? []).find((w) => w.id === writerId) ?? null;
}

/**
 * `tetravox:module-open-dialog` — an Open sheet with the reader's own title and filters, whose
 * result is allow-listed exactly like `menu.ts`'s. Paths, never bytes (§5 rule 3).
 *
 * **The manifest is the authority.** `readerId` names one of the module's declared readers and main
 * reads that reader's title and extensions out of `MANIFESTS` itself, so the sheet can only ever
 * offer what a manifest declared — design §6's "never from the renderer", now that the barrel exists
 * for main to import. The renderer's own title and filters remain as a fallback for a module this
 * build does not carry, and that fallback is sanitised on arrival exactly as it always was: a
 * hostile one is a badly-named sheet, never a path.
 */
export async function moduleOpenDialog(
  win: BrowserWindow | null,
  moduleId: unknown,
  raw: unknown
): Promise<OpenedPath[]> {
  if (typeof moduleId !== 'string' || moduleId === '') return [];
  const { title, filters, readerId } = (raw ?? {}) as Partial<ModuleOpenOptions>;
  const reader = readerOf(moduleId, readerId);
  const options: Electron.OpenDialogOptions = {
    title: reader === null ? coerceTitle(title, 'Open') : coerceTitle(reader.title, 'Open'),
    properties: ['openFile', 'multiSelections'],
    filters:
      reader === null
        ? coerceFilters(filters)
        : coerceFilters([
            { name: reader.title, extensions: reader.extensions },
            // The escape hatch the renderer offered, kept: a reader whose extension list is right
            // for a manifest is still wrong for the one file a user has named something else.
            { name: 'All files', extensions: ['*'] },
          ]),
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return [];
  return allowPaths(result.filePaths).map((path) => ({ path, url: fileUrl(path) }));
}

/**
 * `tetravox:module-save-dialog` — a Save sheet whose result admits the chosen path **and** the
 * writer's siblings for writing, and nothing else. Null when the user cancelled.
 *
 * **The manifest is the authority**, as for the Open sheet: `writerId` names one of the module's
 * declared writers and its title, filters and **sibling templates** are read out of `MANIFESTS`
 * here — which is the half that matters, because a template is what admits a second path for
 * writing.
 *
 * For a module main **carries** (`manifestFor !== null`) the renderer's own `filters`/`siblings` are
 * never used: a downloaded module runs as first-party renderer code and can call this bridge method
 * directly with a `writerId` that resolves to nothing and a `siblings` array of its own invention, so
 * a fallback there would let it admit an undisclosed second path for writing — an executable
 * `<dir>/<stem>.command` beside the file the user actually named — that no consent sheet ever showed.
 * So a resolved writer is the *only* source of filters and templates; an unresolved `writerId` gets
 * the chosen path alone, and the renderer never widens its own save (finding, 2026-08-31). The
 * renderer's copies remain the fallback strictly for the harness case where main does **not** carry
 * the module (`manifestFor === null` — a `--job` window told about a module this build's barrel does
 * not hold), and every template is still validated by `isSiblingTemplate` + `substituteSibling`
 * whichever end it came from: a bad one is inert, not trusted because a manifest said it.
 */
export async function moduleSaveDialog(
  win: BrowserWindow | null,
  moduleId: unknown,
  raw: unknown
): Promise<ModuleSaveTarget | null> {
  if (typeof moduleId !== 'string' || moduleId === '') return null;
  const { title, filters, siblings, defaultPath, writerId } = (raw ??
    {}) as Partial<ModuleSaveOptions>;
  const known = manifestFor(moduleId) !== null;
  const writer = writerOf(moduleId, writerId);
  const options: Electron.SaveDialogOptions = {
    title: coerceTitle(writer?.title ?? title, 'Save'),
    filters: coerceFilters(writer?.filters ?? (known ? [] : filters)),
    ...(typeof defaultPath === 'string' && defaultPath !== '' ? { defaultPath } : {}),
  };
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || result.filePath === undefined || result.filePath === '') return null;
  const declared = writer?.siblings ?? (known ? [] : siblings);
  const templates = Array.isArray(declared)
    ? declared.filter((s): s is string => typeof s === 'string').slice(0, 8)
    : [];
  return admitModuleWrite(moduleId, result.filePath, templates);
}

/**
 * `tetravox:module-write-text` — UTF-8 text to a path this module's Save sheet admitted, ≤ 8 MiB.
 *
 * `backup: true` copies an existing file to `<path>.<YYYYMMDD-HHMMSS>.bak` first, and only when that
 * name is itself on the module's list — i.e. only when the writer declared a `{name}.{stamp}.bak`
 * sibling. A writer that did not declare one gets `backupPath: null` and its write, rather than a
 * refusal: the backup is a courtesy the manifest opts into, not a condition of saving.
 *
 * The write is `<path>.part` then `renameSync`, the `sample-data.ts` precedent: a rename within one
 * directory is atomic, so a crash mid-write leaves the previous table intact rather than half of the
 * new one.
 *
 * **The parent directory is created first** (`job-runner.ts`'s `ensureDir`, the same one line). A
 * module operation's `out` argument is a name *under* `--out` and `outName` legally admits
 * `tables/electrodes.tsv`; `job-runner.ts` then resolves and admits that path, but nothing has ever
 * made `<out>/tables`, so the `.part` write failed with ENOENT on a target main had already said
 * yes to. It cannot widen anything: `path` is on this module's write list before this line runs.
 */
export function moduleWriteText(
  moduleId: unknown,
  candidate: unknown,
  text: unknown,
  raw: unknown
): ModuleWriteResult {
  if (typeof moduleId !== 'string' || moduleId === '')
    return { ok: false, error: 'not an extension' };
  if (typeof candidate !== 'string' || typeof text !== 'string') {
    return { ok: false, error: 'not a path and a string' };
  }
  const path = normalise(candidate);
  if (path === null || !isModuleWritable(moduleId, path)) {
    return { ok: false, error: 'not on the extension write list' };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_MODULE_WRITE_BYTES) {
    return { ok: false, error: `${bytes} bytes exceeds the ${MAX_MODULE_WRITE_BYTES}-byte cap` };
  }
  const wantsBackup = ((raw ?? {}) as { backup?: unknown }).backup === true;
  const part = `${path}.part`;
  try {
    let backupPath: string | null = null;
    if (wantsBackup && existsSync(path)) {
      const target = `${path}.${stampNow()}.bak`;
      if (isModuleWritable(moduleId, target)) {
        copyFileSync(path, target);
        backupPath = target;
      }
    }
    try {
      // The `.part` and its target share a directory, so one `mkdir -p` covers the rename too.
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(part, text, 'utf8');
      renameSync(part, path);
    } catch (error: unknown) {
      rmSync(part, { force: true });
      throw error;
    }
    // Writing is also how the file becomes readable: the module just named this path through a Save
    // sheet, so reading its own output back must not need a second gesture.
    allowPath(path);
    return { ok: true, backupPath };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ------------------------------------------------------------------------------------------------
// Unsaved module edits and the window's close guard
// ------------------------------------------------------------------------------------------------

/**
 * Which windows a module has reported unsaved edits in.
 *
 * `sceneDirty` cannot answer this — it is set by any cursor click (`controller.ts`) — so the flag is
 * pushed from the renderer over `tetravox:set-document-edited` and kept per window id, which is also
 * the granularity `win.setDocumentEdited` works at.
 */
const editedWindows = new Set<number>();
/** Windows already showing the discard box, so a second `close` cannot stack a second sheet. */
const prompting = new Set<number>();

export function setDocumentEdited(win: BrowserWindow | null, edited: unknown): void {
  if (win === null) return;
  const flag = edited === true;
  if (flag) editedWindows.add(win.id);
  else editedWindows.delete(win.id);
  try {
    // macOS draws the dot in the close button from this; it is a no-op elsewhere and must not be
    // allowed to throw a renderer message into main's uncaught handler on a platform that lacks it.
    win.setDocumentEdited(flag);
  } catch {
    // Nothing to do: the flag above is what the close guard reads.
  }
}

export function documentEdited(win: BrowserWindow | null): boolean {
  return win !== null && editedWindows.has(win.id);
}

/**
 * Drop the edited flag after the user has *explicitly* discarded — the updater's pre-install
 * prompt (§12.4, 2026-08-31). Without this, the Discard answered there would be asked again by
 * {@link installCloseGuard} when the installer closes the window, and a question answered twice
 * is a question the second copy of which teaches users to stop reading.
 */
export function clearDocumentEdited(win: BrowserWindow | null): void {
  if (win !== null) editedWindows.delete(win.id);
}

/**
 * Should a `close` be interrupted?
 *
 * Pure, because the two cases that must never prompt are the ones a Playwright run and a `--job`
 * render depend on and neither is convenient to reach through a real window: a job has no user to
 * answer the box (it would hang until the 45-minute CI cap), and an e2e teardown closes a window it
 * deliberately made dirty. `TETRAVOX_E2E_DISCARD=1` is that seam, read at close time so a spec can
 * set it per launch.
 *
 * **`packaged` closes the seam** (2026-08-30). The variable is ambient state: a dotfile, a wrapper
 * script or a leftover `export` in the shell a user launches from would silently switch off the
 * only protection a dirty window has, and losing unsaved contact edits to an environment variable
 * is not a trade a shipped build gets to make. A test seam belongs to the builds that run tests, so
 * a packaged build ignores it and always asks. Absent — every existing caller — is the developer
 * build, which is what it was before.
 */
export function shouldPromptOnClose(opts: {
  edited: boolean;
  isJob: boolean;
  env?: NodeJS.ProcessEnv;
  /** `app.isPackaged`. Passed in rather than read here so the function stays pure and testable. */
  packaged?: boolean;
}): boolean {
  if (!opts.edited || opts.isJob) return false;
  if (opts.packaged === true) return true;
  return (opts.env ?? process.env)['TETRAVOX_E2E_DISCARD'] !== '1';
}

/**
 * The codebase's first `BrowserWindow 'close'` handler (only `'closed'` existed).
 *
 * Two buttons, Discard and Cancel — and deliberately no Save. Saving is the module's own write path
 * through the Save sheet and `module-write-text`; a Save button here would be a second write path
 * driven from main, which is the one thing §5's write rule exists to prevent.
 *
 * `packaged` is `app.isPackaged`, handed in by main so this file needs no `app` — it is what keeps
 * `TETRAVOX_E2E_DISCARD` out of a shipped build (2026-08-30).
 */
export function installCloseGuard(
  win: BrowserWindow,
  opts: { isJob: boolean; packaged?: boolean }
): void {
  if (opts.isJob) return;
  win.on('close', (event) => {
    if (
      !shouldPromptOnClose({
        edited: documentEdited(win),
        isJob: false,
        ...(opts.packaged === undefined ? {} : { packaged: opts.packaged }),
      })
    ) {
      return;
    }
    event.preventDefault();
    if (prompting.has(win.id)) return;
    prompting.add(win.id);
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        noLink: true,
        title: 'Unsaved changes',
        message: 'Discard unsaved edits?',
        detail:
          'An extension in this window has edits that have not been written to disk. Closing ' +
          'the window discards them.',
        buttons: ['Discard', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      })
      .then(({ response }) => {
        prompting.delete(win.id);
        if (response !== 0 || win.isDestroyed()) return;
        editedWindows.delete(win.id);
        // `destroy()` rather than `close()`: the flag is already cleared, but destroying is what
        // makes "Discard" unambiguous even if a module re-marks the window in the same tick.
        win.destroy();
      })
      .catch(() => {
        prompting.delete(win.id);
      });
  });
  win.on('closed', () => {
    editedWindows.delete(win.id);
    prompting.delete(win.id);
  });
}

// ------------------------------------------------------------------------------------------------
// Registration
// ------------------------------------------------------------------------------------------------

function windowOf(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow | null {
  return BrowserWindowClass.fromWebContents(event.sender);
}

/**
 * Register the module IPC. Called unconditionally from main, like `registerJobIpc()`: a build with
 * no modules simply never sees a call on these channels.
 *
 * `isJob` makes `tetravox:module-clear-writes` inert for a `--job` run (2026-08-30). A batch run's
 * admissions come from the envelope's `out` arguments, admitted once in `prepareJob` before there
 * is a window; its actions activate modules in whatever order the job lists them, and an
 * `activateModule` that switches away from a module calls `deactivateModule` on it — so honouring
 * the revocation there would drop an `out` target the job still has an action for.
 */
export function registerModuleIpc(opts: { isJob?: boolean } = {}): void {
  ipcMain.handle('tetravox:module-read-text', (_event, moduleId: unknown, path: unknown) =>
    moduleReadText(moduleId, path)
  );
  ipcMain.handle('tetravox:module-open-dialog', async (event, moduleId: unknown, opts: unknown) =>
    moduleOpenDialog(windowOf(event), moduleId, opts)
  );
  ipcMain.handle('tetravox:module-save-dialog', async (event, moduleId: unknown, opts: unknown) =>
    moduleSaveDialog(windowOf(event), moduleId, opts)
  );
  ipcMain.handle(
    'tetravox:module-write-text',
    (_event, moduleId: unknown, path: unknown, text: unknown, opts: unknown) =>
      moduleWriteText(moduleId, path, text, opts)
  );
  ipcMain.on('tetravox:set-document-edited', (event, edited: unknown) =>
    setDocumentEdited(windowOf(event), edited)
  );
  // The renderer's half of revocation: a module leaving the slot gives its admissions back. `send`,
  // not `invoke` — dropping a capability cannot fail and nothing waits on the answer — and it can
  // only ever *narrow* what a module may write, so it needs no gesture and no window check.
  ipcMain.on('tetravox:module-clear-writes', (_event, moduleId: unknown) => {
    if (opts.isJob === true) return;
    revokeModuleWrites(moduleId);
  });
}
