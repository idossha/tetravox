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
  'number' | 'number?' | 'string' | 'string?' | 'boolean' | 'boolean?' | 'vec3?' | 'path' | 'out';

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
   * `{sub}` / `{space}` / `{stem}` — `{stem}` is the anchor's basename without its last extension
   * chain, everything else is a named group of `from`.
   */
  candidates: string[];
}

export interface ModuleWriter {
  id: string;
  title: string;
  filters: { name: string; extensions: string[] }[];
  /**
   * Same-directory companions the Save sheet admits alongside the chosen path, as templates over it:
   * `'{name}.{stamp}.bak'`, `'{stem}_editlog.json'`. `{name}` is the full basename, `{stem}` drops
   * its last extension chain, `{stamp}` is `YYYYMMDD-HHMMSS`.
   */
  siblings: string[];
  backup?: 'timestamped';
}

export interface ModuleOperation {
  id: string;
  args: ArgShape;
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
