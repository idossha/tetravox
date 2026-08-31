/**
 * What a module declares about itself, as data (ARCHITECTURE.md §13.1).
 *
 * A manifest is **data-only TypeScript**: type annotations and object literals, nothing else. Three
 * consumers depend on that and each one would break differently if it stopped being true:
 *
 *  * the **main process** validates a `type: "module"` job action against `MANIFESTS` before a window
 *    exists (§13.6), so this file is typechecked by `tsconfig.node.json` and must name no DOM type;
 *  * the **renderer** builds the switcher, the key rows and the reader hook from the same objects,
 *    so it is typechecked by `tsconfig.web.json`;
 *  * a **Node script** may import a manifest directly, so the syntax stays *erasable* — no enums, no
 *    namespaces, no parameter properties, nothing that has to be executed to be understood.
 *
 * `modules.test.ts` asserts the "data only" half by reading the sources: a manifest may import
 * nothing but `./manifest-types`.
 *
 * **Ids.** A module id is `<vendor>.<name>` (`tetravox.hello`). Command, reader, writer and operation
 * ids are **unprefixed inside a manifest**; the host namespaces them as `<moduleId>/<id>` wherever
 * they leave the module — so a manifest never repeats its own id, and two modules can both declare
 * `save` without colliding.
 */

/** `<vendor>.<name>`. The dot is what keeps two labs' `contacts` modules apart. */
export type ModuleId = `${string}.${string}`;

/**
 * The key pool a module may bind, unmodified or with Shift (§13.5).
 *
 * Deliberately a closed union rather than `string`: every key here is one `resolveKey`
 * (`keyboard/keymap.ts`) returns `null` for, and none of them is Space, `Esc`, `+`, `=`, `-`, `_` or
 * `r` — the seven the **engine** binds on the canvas, which no `resolveKey` probe would ever reveal.
 * `modules.test.ts` re-proves both halves against the live resolver rather than against this comment.
 */
export type ModuleKey =
  'a' | 's' | 'd' | 'f' | 'g' | 'n' | 'p' | 't' | 'z' | 'Delete' | 'Backspace';

/**
 * The argument types a job-file operation may declare (§13.6).
 *
 * `path` is a filesystem path the job runner allow-lists before the window opens; `out` is a path
 * *relative to* `--out`. A trailing `?` is "optional"; everything without one is required.
 */
export type ArgType =
  | 'number'
  | 'number?'
  | 'string'
  | 'string?'
  | 'boolean'
  | 'boolean?'
  | 'vec3?'
  | 'path'
  // Appended 2026-08-30 with the job envelope (§13.6): an **optional** input path, which the sEEG
  // `load` operation needs for the T1 it will use if it is given one. `string?` would have carried
  // the same value and none of the meaning — only a `path` joins `jobInputPaths`, and a path a job
  // named but main never allow-listed is a file the module is told about and cannot read.
  | 'path?'
  | 'out';

/**
 * The same pool as a value, because the resolver and its tests both need to *enumerate* it.
 *
 * It is here rather than in the renderer so the union and the array can never drift: a key added to
 * one and not the other fails `modules.test.ts`, which checks them against each other and then
 * probes every entry through the live `resolveKey`.
 */
export const MODULE_KEY_POOL: readonly ModuleKey[] = [
  'a',
  's',
  'd',
  'f',
  'g',
  'n',
  'p',
  't',
  'z',
  'Delete',
  'Backspace',
];

/**
 * The keys the **engine** binds on the canvas (§7.5), which no `resolveKey` probe can reveal because
 * `keymap.ts` correctly refuses to know about them: `Space` (the pan modifier), `Esc`, `+`/`=` and
 * `-`/`_` (zoom the pane under the pointer) and `r` (fit).
 *
 * A module key must miss all of them as well as everything `resolveKey` claims.
 */
export const ENGINE_RESERVED_KEYS: readonly string[] = [
  ' ',
  'Escape',
  '+',
  '=',
  '-',
  '_',
  'r',
  'R',
];

/**
 * `{stem}` — a basename without its trailing extension. **The one definition** (§13.1, §13.6).
 *
 * Three places substitute this token and all three have to produce the same string: main's sibling
 * admission (`main/module-io.ts`), the renderer's sibling instantiation
 * (`renderer/src/modules/siblings.ts`), and the sEEG module's editlog name
 * (`renderer/src/modules/seeg/bids.ts`). They were three functions until 2026-08-30 and disagreed
 * about a dotted name — main admitted `sub-01_electrodes.v2_editlog.json` while the module wrote
 * `sub-01_electrodes_editlog.json`, so the write was refused by the very list that existed to
 * permit it. It lives here because this file is the module *contract*, main-safe by construction
 * (no DOM type, no `node:` import, nothing that has to be executed), which makes it the only place
 * both processes may import from.
 *
 * The rule: **one suffix, and a compression suffix takes the extension in front of it with it.**
 * `sub-01_electrodes.tsv` → `sub-01_electrodes`, and `sub-01_ct.nii.gz` → `sub-01_ct`, because
 * `sub-01_ct.nii` is not a stem anyone would write a sibling against. A name with no dot, or one
 * whose only dot begins it (`.hidden`), is its own stem.
 *
 * "One suffix" rather than "the whole extension chain" is the half chosen deliberately: it keeps the
 * token **injective** over a directory. `a.tsv` and `a.v2.tsv` get different stems, so two tables
 * sitting beside each other can never claim one `{stem}_editlog.json` — under a chain rule they
 * collapse to the same name and the second save silently overwrites the first one's provenance.
 */
export function stemOf(name: string): string {
  const cut = (value: string): string | null => {
    const dot = value.lastIndexOf('.');
    return dot > 0 ? value.slice(0, dot) : null;
  };
  const lower = name.toLowerCase();
  if (lower.endsWith('.gz') || lower.endsWith('.bz2') || lower.endsWith('.zip')) {
    const once = cut(name);
    if (once !== null) return cut(once) ?? once;
  }
  return cut(name) ?? name;
}

export type ArgShape = Record<string, ArgType>;

export interface ModuleCommand {
  /** Unprefixed; the host runs it as `<moduleId>/<id>`. */
  id: string;
  title: string;
  key?: ModuleKey;
  shift?: boolean;
  /**
   * When the binding is live. Absent = whenever the module is active.
   *
   * `'selection'` is §13.5's one exception to "a plain key stays harmless": it may act on an
   * explicit selection, and only on one. `'toolArmed'` is live only while the module's own tool is
   * armed.
   */
  when?: 'toolArmed' | 'selection';
}

export interface ModuleReader {
  id: string;
  title: string;
  /** Lower-case, without the dot: `['tsv', 'csv']`. */
  extensions: string[];
  /** A `RegExp` source matched against the **basename**, when the extension alone is too broad. */
  match?: string;
}

export interface ModuleSibling {
  /** A `RegExp` source over the anchor's basename, with named groups the candidates may use. */
  from: string;
  /**
   * Paths relative to the anchor's **directory**, at most three `..` ascents. Tokens are
   * `{sub}` / `{space}` / `{stem}` — `{stem}` is {@link stemOf} of the anchor's basename,
   * everything else is a named group of `from`.
   */
  candidates: string[];
}

export interface ModuleWriter {
  id: string;
  title: string;
  filters: { name: string; extensions: string[] }[];
  /**
   * Same-directory companions the Save sheet admits alongside the chosen path, as templates over it:
   * `'{name}.{stamp}.bak'`, `'{stem}_editlog.json'`. `{name}` is the full basename, `{stem}` is
   * {@link stemOf} of it, `{stamp}` is `YYYYMMDD-HHMMSS`.
   */
  siblings: string[];
  backup?: 'timestamped';
}

export interface ModuleOperation {
  id: string;
  args: ArgShape;
}

/**
 * What a module says about where it wants to be shown (§13.10).
 *
 * Every field is optional and every default is what the app did before pop-out existed, which is
 * what makes this additive under §12.3: a manifest with no `ui` block is offered the ⧉ button, opens
 * docked, and gets a window sized from the slot's own width if the user pops it out.
 *
 * `popout` is a *request*, not a permission — the shell has no security interest in where a panel
 * draws. `'never'` is for a module whose panel is meaningless away from the Info panel's Cursor
 * block; `'preferred'` opens in a window the first time it is loaded, which is the setting a
 * large-canvas module (a time-domain view) wants and the reason this field is not a boolean.
 */
export interface ModuleUi {
  /** Default `'allowed'`. */
  popout?: 'allowed' | 'preferred' | 'never';
  /** CSS px the popped-out window opens at. Clamped by the shell to something a screen can hold. */
  windowWidth?: number;
  windowHeight?: number;
}

export interface ModuleManifest {
  id: ModuleId;
  title: string;
  /** The module's own semver, stamped into its scene block and into `job-result.json`. */
  version: string;
  /** The {@link MODULE_HOST_VERSION} this manifest was written against. */
  hostApi: 1;
  /** A `## ` heading in `docs/USER_GUIDE.md`. The docs-guard job fails when it is not there. */
  docs: string;
  activation: Array<'onToggle' | 'onReader' | 'onSibling' | 'onSceneBlock'>;
  commands: ModuleCommand[];
  readers?: ModuleReader[];
  siblings?: ModuleSibling[];
  writers?: ModuleWriter[];
  operations?: ModuleOperation[];
  /** The version of the module's `ViewSpec.extensions[id]` block (§13.2). */
  sceneBlock?: { version: number };
  /**
   * How this module wants to be shown (§13.10, appended 2026-08-31). All optional; absent is the
   * pre-pop-out behaviour exactly — docked, and pop-out offered.
   */
  ui?: ModuleUi;
}

/**
 * The host API's integer version (§13.1).
 *
 * A manifest names the version it was written against in `hostApi`. Host changes are **additive**
 * under §12.3, exactly like `api.ts`; a breaking change bumps this integer with a `DECISIONS.md`
 * line, and the registry test then refuses every stale manifest rather than letting one run against
 * a surface that no longer means what it said.
 */
export const MODULE_HOST_VERSION = 1 as const;

/**
 * A manifest that arrived as **JSON from disk** rather than as a compiled-in TS literal (§13.1,
 * downloadable extensions, 2026-08-30).
 *
 * Structurally identical to {@link ModuleManifest} except for `hostApi`, which is a plain `number`
 * here. That single difference is the whole point: a compiled-in manifest cannot carry a stale
 * `hostApi`, because the literal type `1` makes a wrong one a compile error — while an *installed*
 * manifest is a file some other repository wrote, whose `hostApi` may legitimately be 2 (too new) or
 * 0 (garbage), and the host has to be able to *hold* that value in order to refuse it. Typing it as
 * `1` would make the version gate a tautology: every value that reached the check would already be
 * the right one.
 *
 * `ModuleManifest` is assignable to this type (`1 extends number`), so one list can hold both kinds,
 * which is what `manifests.ts#allManifests()` returns and what `validateJob` validates against.
 */
export type InstalledManifest = Omit<ModuleManifest, 'hostApi'> & { hostApi: number };
