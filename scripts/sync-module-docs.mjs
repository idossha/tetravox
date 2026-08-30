/**
 * `docs/AUTOMATION.md` §2.7 — **generated from the module manifests** (ARCHITECTURE.md §13.6).
 *
 * A module's operations are the automation surface a script writes against, and they are declared in
 * exactly one place: the manifest `main/job.ts` validates a job action against. A hand-written table
 * of them is a second declaration, and the two would agree only until someone added an argument —
 * at which point the documentation would be the thing that told a user a job was legal and the
 * validator the thing that refused it. So the table is written from the manifests, and CI runs this
 * script with `--check` in the `docs-guard` job to keep them together.
 *
 * ```sh
 * node scripts/sync-module-docs.mjs           # rewrite §2.7 in place
 * node scripts/sync-module-docs.mjs --check    # fail if it is out of date (CI)
 * ```
 *
 * **Importing a TypeScript manifest from a plain ESM script.** Node runs `.ts` by stripping the
 * types: unflagged from 23.6 (so CI's Node 24 and a local Node 25 need nothing), behind
 * `--experimental-strip-types` from 22.6 to 23.5. This script therefore imports the manifests
 * directly and, if that fails the way an older Node fails it, re-execs **itself** once with the flag
 * — which is why every path here is computed from `import.meta.url` rather than from `process.cwd()`.
 * It imports each `<id>/manifest.ts` rather than the `manifests.ts` barrel, because a manifest's own
 * imports are all `import type` and vanish with the types, while the barrel has a real
 * `import { helloManifest } from './hello/manifest'` — extensionless, which is a TypeScript
 * convention Node's resolver does not implement. `modules.test.ts` is what keeps a manifest that
 * self-contained.
 *
 * Every rule is a pure exported function, so `sync-module-docs.test.mjs` can drive it with fixture
 * objects instead of by editing a shipped manifest.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const AUTOMATION = 'docs/AUTOMATION.md';
export const MODULES_DIR = 'packages/app/src/modules';

/**
 * The heading this script owns. It writes everything from that line up to the next heading or `---`
 * rule, and refuses to invent the section: where §2.7 sits in the document is the document's
 * decision, not this script's.
 */
export const HEADING = '### 2.7 Module operations';

/** How each `ArgType` is spelled in the table. The `?` forms are the same words plus "optional". */
const ARG_WORDS = {
  number: 'a number',
  string: 'a string',
  boolean: 'true or false',
  vec3: 'three numbers `[x, y, z]`, world RAS mm',
  path: 'a path to an existing file',
  out: 'a file name under `--out`',
};

/** One argument, as a table cell fragment: `` `radiusMm` a number (optional) ``. */
export function describeArg(name, type) {
  const optional = type.endsWith('?');
  const words = ARG_WORDS[optional ? type.slice(0, -1) : type] ?? type;
  return `\`${name}\` ${words}${optional ? ' *(optional)*' : ''}`;
}

/** One module's block: a heading with its version, and a row per operation. */
export function renderModule(manifest) {
  const lines = [`#### \`${manifest.id}\` — ${manifest.title} ${manifest.version}`, ''];
  const operations = manifest.operations ?? [];
  if (operations.length === 0) {
    lines.push('This module declares no job operations.', '');
    return lines;
  }
  lines.push('| Operation | Arguments |', '|---|---|');
  for (const operation of operations) {
    const args = Object.entries(operation.args ?? {});
    const cell = args.length === 0 ? '—' : args.map(([n, t]) => describeArg(n, t)).join('<br>');
    lines.push(`| \`${operation.id}\` | ${cell} |`);
  }
  lines.push('');
  return lines;
}

/**
 * The whole section, heading included.
 *
 * The lead paragraph is generated too, and says so: a reader who edits this table by hand has to be
 * told, in the place they are editing, that the next `--check` will undo it.
 */
export function renderSection(manifests) {
  const lines = [
    HEADING,
    '',
    'Every operation every module in this build declares, with the arguments each one takes.',
    '**This section is generated** from the manifests by `scripts/sync-module-docs.mjs` — the same',
    'declarations the job validator checks an action against — so edit a manifest and re-run the',
    'script rather than editing the table. CI checks it with `--check`.',
    '',
  ];
  for (const manifest of [...manifests].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(...renderModule(manifest));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Replace the section under {@link HEADING} with `section`, or say why it could not be found.
 *
 * The boundary is the next `#` heading or `---` rule, which is markdown the site's own converter
 * already understands. An HTML comment marker would have been the obvious alternative and is the
 * wrong one here: `website/scripts/sync.mjs` escapes every tag it does not recognise, so a
 * `<!-- BEGIN -->` would appear as text on the published page.
 */
export function replaceSection(text, section) {
  const lines = text.split('\n');
  const start = lines.indexOf(HEADING);
  if (start === -1) {
    return {
      ok: false,
      error: `${AUTOMATION} has no \`${HEADING}\` line; add the heading where the section belongs and re-run.`,
    };
  }
  // A heading at this level **or above**, or a rule. Not any heading: the section's own body is
  // one `####` block per module, and a scan that stopped at the first of those would re-insert the
  // section in front of the tables it had just written — the check would then fail immediately
  // after a successful write, which is exactly how this rule was found.
  const level = (HEADING.match(/^#+/) ?? ['###'])[0].length;
  const boundary = new RegExp(`^#{1,${level}} `);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (boundary.test(lines[i]) || /^---\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // Spliced as **lines**, never as three concatenated strings: `join` on a slice that ends in a
  // blank line produces one trailing newline rather than two, so a string splice silently ate the
  // blank line above the heading on the first run and glued the heading to the paragraph above it
  // on the second.
  const body = section.replace(/\n+$/, '').split('\n');
  return {
    ok: true,
    text: [...lines.slice(0, start), ...body, '', ...lines.slice(end)].join('\n'),
  };
}

/** Every `packages/app/src/modules/<id>/manifest.ts`, in directory order. */
export function manifestFiles(root = REPO_ROOT) {
  const dir = join(root, MODULES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, 'manifest.ts'))
    .filter((file) => existsSync(file))
    .sort();
}

/** Does this object look like a `ModuleManifest`? The exported name is not the contract; this is. */
export function isManifest(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.version === 'string' &&
    Array.isArray(value.activation)
  );
}

/** Import every manifest file and collect the manifest objects it exports. */
export async function readManifests(root = REPO_ROOT) {
  const out = [];
  for (const file of manifestFiles(root)) {
    const module = await import(pathToFileURL(file).href);
    for (const value of Object.values(module)) if (isManifest(value)) out.push(value);
  }
  return out;
}

/** The failure an older Node gives for `import('./x.ts')`: it needs the flag this script re-execs with. */
export function needsStripTypes(error) {
  const message = String(error?.message ?? error ?? '');
  return (
    error?.code === 'ERR_UNKNOWN_FILE_EXTENSION' ||
    /Unknown file extension|experimental-strip-types|typescript/i.test(message)
  );
}

export async function main(argv = process.argv.slice(2), log = console) {
  const check = argv.includes('--check');
  const root = argv.includes('--root') ? resolve(argv[argv.indexOf('--root') + 1]) : REPO_ROOT;
  const file = join(root, AUTOMATION);

  const manifests = await readManifests(root);
  const current = readFileSync(file, 'utf8');
  const replaced = replaceSection(current, renderSection(manifests));
  if (!replaced.ok) {
    log.error(`sync-module-docs: ${replaced.error}`);
    return 1;
  }

  if (replaced.text === current) {
    log.log(`sync-module-docs: ${AUTOMATION} §2.7 is up to date (${manifests.length} modules).`);
    return 0;
  }
  if (check) {
    log.error(
      `sync-module-docs: ${AUTOMATION} §2.7 does not match the manifests. ` +
        'Run `node scripts/sync-module-docs.mjs` and commit the result.'
    );
    return 1;
  }
  writeFileSync(file, replaced.text);
  log.log(`sync-module-docs: rewrote ${AUTOMATION} §2.7 from ${manifests.length} manifests.`);
  return 0;
}

// `node scripts/sync-module-docs.mjs` runs it; an `import` of this file does not.
if (process.argv[1] !== undefined && process.argv[1].endsWith('sync-module-docs.mjs')) {
  try {
    process.exitCode = await main();
  } catch (error) {
    // One retry, with the flag a Node between 22.6 and 23.5 needs to read a `.ts` file at all.
    // `TETRAVOX_STRIP_TYPES` stops the child doing the same thing again if the flag did not help.
    if (!needsStripTypes(error) || process.env['TETRAVOX_STRIP_TYPES'] === '1') throw error;
    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, TETRAVOX_STRIP_TYPES: '1' } }
    );
    process.exitCode = child.status ?? 1;
  }
}
