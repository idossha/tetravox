/**
 * The extension loader's build-output guard (ARCHITECTURE.md §13.8).
 *
 * `renderer/src/modules/installed.ts` loads a downloaded module with
 *
 *     const url = moduleUrl(id, version, MODULE_ENTRY);
 *     await import(<the @vite-ignore comment> url);
 *
 * and **every word of that is a claim about a bundler we do not control**. Measured against this
 * repository's own Vite (7.3.6), three things can go wrong and exactly one of them is loud:
 *
 *  * an inline template — `import(\`tetravox://module/${id}/…\`)` — is a *partially analysable*
 *    specifier, and Vite rewrites it into a glob helper. Loud: the URL string stops being in the
 *    chunk at all.
 *  * the identifier form **without** `@vite-ignore` is silently rewritten to
 *    `__variableDynamicImportRuntimeHelper` over an **empty** glob. That helper rejects every URL at
 *    runtime, and there is no build warning. Silent, and the reason this file exists.
 *  * a future Vite could start rewriting the identifier form too. Also silent.
 *
 * So the rule is checked where it is true or false — the emitted chunk — rather than in the source,
 * which is what a lint rule or a vitest could reach. Three assertions, over
 * `packages/app/out/renderer/assets/*.js`:
 *
 *  1. some chunk still contains the literal `tetravox://module/`;
 *  2. no chunk mentions `__variableDynamicImportRuntimeHelper`;
 *  3. the chunk carrying that URL also carries a dynamic import of a **variable** — `import(x)` —
 *     which is the shape only an un-rewritten specifier has.
 *
 * Usage:
 *   node scripts/check-module-loader.mjs                  # after `pnpm --filter @tetravox/app build`
 *   node scripts/check-module-loader.mjs --dir <assets>   # a different build output
 *
 * Every rule is a pure exported function so `check-module-loader.test.mjs` can drive it with fixture
 * strings, the `check-frozen-docs.mjs` idiom — a guard nobody has seen fail is a guard nobody trusts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where `electron-vite build` writes the renderer's chunks. */
export const ASSETS_DIR = 'packages/app/out/renderer/assets';

/** The URL prefix the loader builds. Must survive into the bundle as a literal. */
export const MODULE_URL_MARK = 'tetravox://module/';

/** Vite's glob shim for a variable dynamic import. Its presence here means the import was rewritten. */
export const GLOB_HELPER = '__variableDynamicImportRuntimeHelper';

/**
 * `import(x)` where `x` is an identifier — the shape an un-rewritten specifier keeps.
 *
 * The `@vite-ignore` comment survives into the chunk (rollup re-emits it on its own lines), and it
 * is *evidence*, so the pattern steps over any leading block comments rather than failing on them.
 */
const VARIABLE_IMPORT = /\bimport\(\s*(?:\/\*[\s\S]*?\*\/\s*)*[A-Za-z_$][\w$]*\s*\)/;

/**
 * The rules, over `[{ name, text }]`. Returns the problems, most specific first.
 *
 * A chunk list with nothing in it is a *failure*, not a pass: "there was no build output to check"
 * and "the build output is correct" must never be the same answer from a guard.
 */
export function loaderViolations(chunks) {
  const issues = [];
  if (chunks.length === 0) {
    return [
      `no renderer chunks to check — run \`pnpm --filter @tetravox/app run build\` first (${ASSETS_DIR})`,
    ];
  }
  const rewritten = chunks.filter((c) => c.text.includes(GLOB_HELPER));
  for (const chunk of rewritten) {
    issues.push(
      `${chunk.name} contains ${GLOB_HELPER}: a dynamic import was rewritten into Vite's glob shim. ` +
        `The extension loader's import must carry the @vite-ignore comment and a hoisted \`const\` URL ` +
        `(renderer/src/modules/installed.ts) — the shim's glob is empty and rejects every module URL.`
    );
  }
  const carriers = chunks.filter((c) => c.text.includes(MODULE_URL_MARK));
  if (carriers.length === 0) {
    issues.push(
      `no chunk contains the literal "${MODULE_URL_MARK}": the extension loader's URL did not survive ` +
        `the build. An inline template specifier is rewritten into a glob helper — hoist it into a ` +
        `\`const\` and import the identifier (renderer/src/modules/installed.ts).`
    );
    return issues;
  }
  if (!carriers.some((c) => VARIABLE_IMPORT.test(c.text))) {
    issues.push(
      `the chunk carrying "${MODULE_URL_MARK}" has no dynamic import of a variable (\`import(x)\`): ` +
        `the specifier was resolved at build time, so a module installed after the build can never be ` +
        `loaded. See renderer/src/modules/installed.ts.`
    );
  }
  return issues;
}

/** Read every `.js` chunk under `dir`. Missing directory = an empty list, which rule 0 fails on. */
export function readChunks(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => ({ name: e.name, text: readFileSync(join(dir, e.name), 'utf8') }));
}

function parseArgs(argv) {
  const args = { dir: join(REPO_ROOT, ASSETS_DIR) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = resolve(argv[++i]);
  }
  return args;
}

function main(argv) {
  const { dir } = parseArgs(argv);
  const chunks = readChunks(dir);
  const issues = loaderViolations(chunks);
  if (issues.length > 0) {
    console.error('check-module-loader: the extension loader did not survive the build\n');
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exitCode = 1;
    return;
  }
  const carrier = chunks.find((c) => c.text.includes(MODULE_URL_MARK));
  console.log(
    `check-module-loader: ${chunks.length} chunk(s); ${carrier.name} carries ` +
      `"${MODULE_URL_MARK}" and an un-rewritten variable import.`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
