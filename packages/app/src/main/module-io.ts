/**
 * File IO for §13 modules (§5 rule 11): five channels, registered from here the way
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
 * What `module-write-text` will write (2026-09-03).
 *
 * The read list plus `.svg` and `.html` — the two shapes a QC figure takes when it is *text*: an
 * SVG histogram a reviewer can open in a browser and reflow in Illustrator, and a small HTML report
 * that links the figures beside it. They are not on {@link MODULE_READ_EXTENSIONS}, because reading
 * markup back in is a different question from writing it out and this list is the narrower one to
 * widen.
 *
 * **This channel had no extension filter at all before**, which is the defect the list fixes rather
 * than a feature it adds: a path admitted by a Save sheet could be written with any suffix the
 * module chose, so an extension that named `report.tsv` in the sheet could write `report.command`
 * beside it through the `{name}`-derived sibling it had already been granted. The set is a superset
 * of everything any extension in this tree writes, so no existing save changes behaviour.
 */
export const MODULE_WRITE_TEXT_EXTENSIONS: readonly string[] = [
  ...MODULE_READ_EXTENSIONS,
  '.svg',
  '.html',
];

/** What `module-write-binary` will write. One extension, on purpose — see {@link moduleWriteBinary}. */
export const MODULE_WRITE_BINARY_EXTENSIONS: readonly string[] = ['.png'];

/**
 * 32 MiB for a PNG (2026-09-03).
 *
 * Four times the text cap because a picture is four times the thing a table is: a 4096 × 4096 RGBA
 * screenshot of a 3-D implant is ~6 MB compressed, and a supersampled figure sheet is a few of
 * those. It is still a **cap**, and it is still the line between "a figure" and "a data channel".
 */
export const MAX_MODULE_WRITE_BINARY_BYTES = 32 * 1024 * 1024;

/**
 * A sibling **template** before substitution: `{name}.{stamp}.bak`, `{stem}_editlog.json`. The
 * braces are in the class because this is the un-substituted form; `SIBLING_NAME` is what the
 * result must match.
 */
export const SIBLING_TEMPLATE = /^[A-Za-z0-9_.{}-]{1,96}$/;

/** A sibling **name** after substitution: no separator, no brace left over, and `..` refused below. */
export const SIBLING_NAME = /^[A-Za-z0-9_.-]{1,96}$/;

/**
 * A **derivatives** template (2026-09-03): `{derivatives}` and then 1–8 path segments.
 *
 * `{derivatives}/tetravox/sub-{id}/ieeg/figures/sub-{id}_desc-spacing_qc.svg`. It is a *separate*
 * class from {@link SIBLING_TEMPLATE} rather than a loosening of it, because the two are admitted on
 * different evidence: a plain sibling is a name in the chosen file's own directory and needs no
 * filesystem at all, while this one is resolved against a `derivatives/` directory that has to be
 * *found*. Keeping them apart is what stops a `/` from becoming legal in a plain sibling name.
 *
 * The leading token is fixed. There is no `{derivatives}` in the middle of a path, no second one,
 * and no template that starts anywhere else — a writer either writes beside the file the user named
 * or under the dataset's own derivatives tree.
 */
export const DERIVATIVE_TEMPLATE =
  /^\{derivatives\}(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9_.{}-]{1,96}){1,8}$/;

/** The most directories a `{derivatives}` search climbs. A BIDS anchor is 2–4 below its root. */
export const MAX_DERIVATIVES_ASCENT = 8;

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
  const name = substituteTokens(template, anchorName, stamp);
  if (name === null) return null;
  if (name.includes('..') || name === '.') return null;
  return SIBLING_NAME.test(name) ? name : null;
}

/**
 * The BIDS entities of an anchor's basename that a template may name (2026-09-03).
 *
 * `sub-P076_space-T1w_electrodes.tsv` gives `{sub}` = `sub-P076`, `{id}` = `P076` and `{space}` =
 * `T1w`. Entities are `<key>-<label>` segments separated by `_`, which is the BIDS filename rule
 * read literally and the same shape `renderer/src/modules/siblings.ts` captures with a manifest's
 * named groups on the *read* side — the difference being that a writer has no regexp to write, so
 * the entities are parsed rather than declared.
 *
 * A token the anchor does not carry is simply absent, and a template naming it is then **dropped**
 * — the rule every other bad template already follows. A subject-less anchor must not silently
 * become a path with `sub-` and nothing after it.
 */
export function anchorTokens(anchorName: string): Record<string, string> {
  const tokens: Record<string, string> = { name: anchorName, stem: stemOf(anchorName) };
  for (const part of stemOf(anchorName).split('_')) {
    const dash = part.indexOf('-');
    if (dash <= 0 || dash === part.length - 1) continue;
    const key = part.slice(0, dash);
    const label = part.slice(dash + 1);
    if (!/^[A-Za-z0-9]{1,32}$/.test(key) || !/^[A-Za-z0-9.]{1,64}$/.test(label)) continue;
    // First occurrence wins: BIDS entities are unique in a name, and a repeat is a malformed name
    // whose *second* value is the one nobody meant.
    if (tokens[key] === undefined) tokens[key] = label;
    if (key === 'sub' && tokens['id'] === undefined) tokens['id'] = label;
  }
  // `{sub}` is the whole entity, `{id}` its label — both, because a path says `sub-{id}` in one
  // place and a filename says `{sub}_...` in another, and making an author write `sub-{sub}` or
  // strip a prefix by hand is how the two halves of one name drift apart.
  if (tokens['sub'] !== undefined) tokens['sub'] = `sub-${tokens['sub']}`;
  return tokens;
}

/**
 * One substitution pass over a template, or null when a token was not available.
 *
 * One pass, so a token that appears *inside* a substituted value is not substituted again; an
 * unknown token survives as a brace and is refused here rather than reaching the filesystem.
 */
function substituteTokens(template: string, anchorName: string, stamp: string): string | null {
  const tokens: Record<string, string> = { ...anchorTokens(anchorName), stamp };
  let missing = false;
  const out = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, token: string) => {
    const value = tokens[token];
    if (value === undefined) {
      missing = true;
      return '';
    }
    return value;
  });
  if (missing) return null;
  return out.includes('{') || out.includes('}') ? null : out;
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
  const parts: string[] = [];
  for (const part of template.split('{stamp}')) {
    // `'{stamp}'` is not a token here — it has already been split out — so any stamp the *anchor's
    // own name* contributed is a literal, which is what `escapeRegExp` below is for.
    const substituted = substituteTokens(part, anchorName, '');
    if (substituted === null) return null;
    parts.push(escapeRegExp(substituted));
  }
  return new RegExp(`^${parts.join(STAMP_SOURCE)}$`);
}

// ------------------------------------------------------------------------------------------------
// The module-scoped write list
// ------------------------------------------------------------------------------------------------

interface WriteList {
  /** Exact paths: the chosen file and every stamp-free sibling. */
  paths: Set<string>;
  /** Stamp-bearing siblings, as a directory and a name matcher. */
  stamped: { dir: string; name: RegExp }[];
  /**
   * The `{derivatives}` roots this module's saves resolved (2026-09-03).
   *
   * A write **creates directories** only under one of these. Everything else is written into a
   * directory that already exists, which is what it was before this list existed: a plain sibling
   * lives beside the file the user chose, so its directory is the one they chose it in.
   */
  derivativeRoots: string[];
}

const writeLists = new Map<string, WriteList>();

/** Canonicalise for the write list. The file may not exist yet, so `realpath` is not an option. */
function normalise(candidate: string): string | null {
  if (!candidate || !isAbsolute(candidate)) return null;
  return resolve(candidate);
}

/**
 * The BIDS `derivatives/` directory for `anchorDir`, or null (2026-09-03).
 *
 * Two rules, tried in order, and both climb at most {@link MAX_DERIVATIVES_ASCENT} directories:
 *
 *  1. an ancestor **named** `derivatives` — the anchor is already inside a derivative, so its
 *     figures belong in the same tree rather than in a second one;
 *  2. an ancestor holding `dataset_description.json` — the BIDS root — whose `derivatives`
 *     subdirectory is the answer whether or not it exists yet.
 *
 * Null when neither is found, and the templates that named the token are then dropped exactly as an
 * unresolvable `{sub}` is. A default of "beside the anchor" would be worse than nothing: an
 * extension writing `tetravox/sub-01/…` into whatever directory a user happened to save into is a
 * derivative tree in the wrong place, and BIDS's own tools would then find two.
 *
 * `exists` is injected so the rule is testable without a filesystem; main passes `existsSync`.
 */
export function resolveDerivativesRoot(
  anchorDir: string,
  exists: (path: string) => boolean = existsSync
): string | null {
  let dir = resolve(anchorDir);
  for (let climbed = 0; climbed <= MAX_DERIVATIVES_ASCENT; climbed += 1) {
    if (basename(dir) === 'derivatives') return dir;
    if (exists(join(dir, 'dataset_description.json'))) return join(dir, 'derivatives');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Is this a `{derivatives}` template at all? Checked before any substitution, like its sibling. */
export function isDerivativeTemplate(template: unknown): template is string {
  return typeof template === 'string' && DERIVATIVE_TEMPLATE.test(template);
}

/**
 * A `{derivatives}` template as an absolute path under `root`, or null.
 *
 * Every segment is substituted and then re-validated against {@link SIBLING_NAME}, which is the
 * same both-ends check {@link substituteSibling} does and for the same reason: the template guards
 * what an extension may *declare*, the per-segment check guards what an anchor's name can turn it
 * into. A segment that is `.`, `..` or empty after substitution is refused rather than normalised,
 * so nothing can climb back out of the derivatives tree.
 */
export function substituteDerivative(
  template: string,
  root: string,
  anchorName: string,
  stamp: string
): string | null {
  if (!isDerivativeTemplate(template)) return null;
  const segments = template.split('/').slice(1);
  const out: string[] = [];
  for (const segment of segments) {
    const value = substituteTokens(segment, anchorName, stamp);
    if (value === null || value === '.' || value.includes('..') || !SIBLING_NAME.test(value)) {
      return null;
    }
    out.push(value);
  }
  return join(root, ...out);
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
  templates: readonly string[],
  exists: (path: string) => boolean = existsSync
): ModuleSaveTarget | null {
  const path = normalise(target);
  if (path === null) return null;
  const dir = dirname(path);
  const anchor = basename(path);
  const stamp = stampNow();

  const list = writeLists.get(moduleId) ?? {
    paths: new Set<string>(),
    stamped: [],
    derivativeRoots: [],
  };
  writeLists.set(moduleId, list);
  list.paths.add(path);

  // Resolved once per save, not once per template: the walk touches the filesystem and every
  // `{derivatives}` template of one writer resolves against the same anchor.
  const derivativesRoot = templates.some(isDerivativeTemplate)
    ? resolveDerivativesRoot(dir, exists)
    : null;
  if (derivativesRoot !== null && !list.derivativeRoots.includes(derivativesRoot)) {
    list.derivativeRoots.push(derivativesRoot);
  }

  const siblings: Record<string, string> = {};
  for (const template of templates) {
    if (isDerivativeTemplate(template)) {
      if (derivativesRoot === null) continue;
      const derived = substituteDerivative(template, derivativesRoot, anchor, stamp);
      if (derived === null) continue;
      // A derivative target is always an exact path, never a stamped *shape*: it is named by the
      // manifest rather than minted beside a file, so there is no later moment to widen for.
      siblings[template] = derived;
      list.paths.add(derived);
      continue;
    }
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

/**
 * This module's resolved `{derivatives}` roots — the only *new* place a write may create
 * directories (2026-09-03).
 *
 * It is a read-back rather than a guard because the guard already exists and is stronger: a write
 * creates `dirname(path)` only for a `path` that is on the write list, and the only admitted paths
 * with a directory that may not exist yet are the `{derivatives}` targets below and a `--job`
 * envelope's `out` names. Exported so a test can state that subtree by name.
 */
export function derivativeRootsOf(moduleId: string): readonly string[] {
  return writeLists.get(moduleId)?.derivativeRoots ?? [];
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
// The five channels
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
  const extension = extensionOf(basename(path));
  if (!MODULE_WRITE_TEXT_EXTENSIONS.includes(extension)) {
    return {
      ok: false,
      error: `${basename(path)} is not one of ${MODULE_WRITE_TEXT_EXTENSIONS.join(' ')}`,
    };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_MODULE_WRITE_BYTES) {
    return { ok: false, error: `${bytes} bytes exceeds the ${MAX_MODULE_WRITE_BYTES}-byte cap` };
  }
  return writeAdmitted(moduleId, path, text, ((raw ?? {}) as { backup?: unknown }).backup === true);
}

/**
 * `tetravox:module-write-binary` — **PNG bytes** to a path this module's Save sheet admitted, ≤ 32
 * MiB (2026-09-03).
 *
 * The twin of {@link moduleWriteText}, and everything that makes that one safe is the same here:
 * the module-scoped write list decides the path, the `.part` + rename makes the replacement atomic,
 * the optional `.bak` is copied **in main** from the file about to be replaced, and the written path
 * is allow-listed for reading back.
 *
 * The two differences are the whole reason it is a second channel rather than a `writeText` that
 * takes bytes: **`.png` only**, and a larger cap. Main decides which set applies from the channel it
 * was called on, so a module cannot pick the looser rule by changing the shape of an argument, and
 * "which extensions may an extension write" stays a question with two answers rather than a
 * negotiation. A caller that wants a `.svg` figure writes text — SVG *is* text — which is why the
 * binary list has exactly one member and no plans for a second.
 *
 * `bytes` arrives as a `Uint8Array` over the structured clone; `ArrayBuffer.isView` is the check,
 * because a renderer may legitimately send a view over a larger buffer and `Buffer.from(view)` on
 * one that is not a view would silently write the wrong thing.
 */
export function moduleWriteBinary(
  moduleId: unknown,
  candidate: unknown,
  bytes: unknown,
  raw: unknown
): ModuleWriteResult {
  if (typeof moduleId !== 'string' || moduleId === '')
    return { ok: false, error: 'not an extension' };
  if (typeof candidate !== 'string' || !ArrayBuffer.isView(bytes)) {
    return { ok: false, error: 'not a path and bytes' };
  }
  const path = normalise(candidate);
  if (path === null || !isModuleWritable(moduleId, path)) {
    return { ok: false, error: 'not on the extension write list' };
  }
  const extension = extensionOf(basename(path));
  if (!MODULE_WRITE_BINARY_EXTENSIONS.includes(extension)) {
    return {
      ok: false,
      error: `${basename(path)} is not one of ${MODULE_WRITE_BINARY_EXTENSIONS.join(' ')}`,
    };
  }
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength > MAX_MODULE_WRITE_BINARY_BYTES) {
    return {
      ok: false,
      error: `${view.byteLength} bytes exceeds the ${MAX_MODULE_WRITE_BINARY_BYTES}-byte cap`,
    };
  }
  return writeAdmitted(moduleId, path, view, ((raw ?? {}) as { backup?: unknown }).backup === true);
}

/**
 * The bytes-to-disk half both write channels share: `.bak`, `<path>.part`, rename, allow-list.
 *
 * Extracted rather than duplicated (2026-09-03) because every line of it is a rule stated somewhere
 * else — §5 rule 11's backup-in-main, `sample-data.ts`'s temp-then-rename, `writeSceneFile`'s
 * allow-listing of what it wrote — and two copies of a rule is one copy that will be fixed.
 *
 * `mkdirSync(dirname(path), { recursive: true })` is unchanged from `moduleWriteText`: it has been
 * there since a `--job` `out` name legally contained a separator, and it cannot widen anything,
 * because `path` is already on this module's write list. A `{derivatives}` target is what makes it
 * matter for an interactive save too — `derivatives/tetravox/sub-01/ieeg/figures/` is four
 * directories that will not exist the first time — and those are the only directories one creates,
 * because they are the only admitted paths outside the directory the user chose.
 */
function writeAdmitted(
  moduleId: string,
  path: string,
  contents: string | Uint8Array,
  wantsBackup: boolean
): ModuleWriteResult {
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
      mkdirSync(dirname(path), { recursive: true });
      if (typeof contents === 'string') writeFileSync(part, contents, 'utf8');
      else writeFileSync(part, contents);
      renameSync(part, path);
    } catch (error: unknown) {
      rmSync(part, { force: true });
      throw error;
    }
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
  ipcMain.handle(
    'tetravox:module-write-binary',
    (_event, moduleId: unknown, path: unknown, bytes: unknown, opts: unknown) =>
      moduleWriteBinary(moduleId, path, bytes, opts)
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
