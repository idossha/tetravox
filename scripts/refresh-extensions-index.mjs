/**
 * Refresh the **shipped** extensions catalogue from the live registry (ARCHITECTURE.md §13.8).
 *
 * `packages/app/src/shared/extensions-index.json` is the floor `module-store.ts#catalogue()` merges
 * the fetched index onto: a build always offers at least what it shipped with, with no network at
 * all. A floor that is never raised is a floor that goes stale, and the moment it does, an offline
 * user is offered a catalogue nobody has looked at in months. So a core release refreshes it from
 * the registry in one command, and the refresh is *this file* rather than a paragraph in
 * RELEASING.md that says "copy the JSON across" — a hand-copy loses `$comment`, reorders keys and
 * produces a diff nobody can review.
 *
 * ```sh
 * node scripts/refresh-extensions-index.mjs             # rewrite the shipped copy from the registry
 * node scripts/refresh-extensions-index.mjs --check     # exit 1 if it is behind (no writes)
 * node scripts/refresh-extensions-index.mjs --from a.json  # offline: read the index from a file
 * ```
 *
 * **What it will not do.** It is a union in the same direction the app is: a version the shipped
 * copy has and the registry does not is *kept*, because dropping it would take a working offer away
 * from every future offline user. Everything else — presentation, and a version both name — comes
 * from the registry, which is the app's rule too (`module-store.ts#mergeCatalogue`), so what a
 * release ships and what a networked user is offered cannot drift apart.
 *
 * `--check` is deliberately **not** wired into CI: it is a network call to
 * raw.githubusercontent.com on every pull request, which is a third-party outage turned into a red
 * build on changes that have nothing to do with extensions. It is a release step instead —
 * `docs/RELEASING.md` — where a human is present and a failure means "try again", not "your PR is
 * broken".
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SHIPPED = 'packages/app/src/shared/extensions-index.json';
export const REGISTRY_URL =
  'https://raw.githubusercontent.com/idossha/tetravox-extensions/main/index.json';

/** Numeric-segment semver compare, the same ordering `module-store.ts#compareVersions` uses. */
export function compareVersions(a, b) {
  const parts = (v) =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const pre = (v) => v.split('-').slice(1).join('-');
  const [pa, pb] = [pre(a), pre(b)];
  if (pa === pb) return 0;
  if (pa === '') return 1;
  if (pb === '') return -1;
  return pa < pb ? -1 : 1;
}

/**
 * The shipped modules array, refreshed from the live one. Pure, so the tests drive it with objects.
 * Same rule as the app: union by id, union by version, live wins a collision, versions ascending.
 */
export function mergeModules(shipped, live) {
  const byId = new Map();
  for (const entry of shipped) byId.set(entry.id, { ...entry, versions: [...entry.versions] });
  for (const liveEntry of live) {
    const base = byId.get(liveEntry.id);
    if (base === undefined) {
      byId.set(liveEntry.id, { ...liveEntry, versions: [...(liveEntry.versions ?? [])] });
      continue;
    }
    const versions = new Map(base.versions.map((v) => [v.version, v]));
    for (const v of liveEntry.versions ?? []) versions.set(v.version, v);
    byId.set(base.id, { ...base, ...liveEntry, id: base.id, versions: [...versions.values()] });
  }
  for (const entry of byId.values()) {
    entry.versions.sort((a, b) => compareVersions(a.version, b.version));
  }
  return [...byId.values()];
}

/** The bytes the shipped file should have: the merge, with the file's own framing preserved. */
export function render(shippedIndex, liveIndex) {
  return `${JSON.stringify(
    {
      ...shippedIndex,
      generated: new Date().toISOString(),
      modules: mergeModules(shippedIndex.modules, liveIndex.modules),
    },
    null,
    2
  )}\n`;
}

/** Only `modules` decides whether the copy is behind — `generated` is a timestamp, not content. */
function sameContent(a, b) {
  return JSON.stringify(JSON.parse(a).modules) === JSON.stringify(JSON.parse(b).modules);
}

async function readLive(from) {
  if (from !== undefined) return JSON.parse(readFileSync(resolve(from), 'utf8'));
  const response = await fetch(REGISTRY_URL);
  if (!response.ok) throw new Error(`${REGISTRY_URL}: HTTP ${response.status}`);
  return await response.json();
}

async function main(argv) {
  const check = argv.includes('--check');
  const fromAt = argv.indexOf('--from');
  const from = fromAt === -1 ? undefined : argv[fromAt + 1];
  const path = resolve(REPO_ROOT, SHIPPED);
  const current = readFileSync(path, 'utf8');
  const live = await readLive(from);
  if (!Array.isArray(live?.modules)) throw new Error('the live index has no `modules` array');
  const next = render(JSON.parse(current), live);
  if (sameContent(current, next)) {
    console.log(`${SHIPPED} is up to date with the registry.`);
    return 0;
  }
  if (check) {
    console.error(
      `${SHIPPED} is behind ${from ?? REGISTRY_URL}. Run: node scripts/refresh-extensions-index.mjs`
    );
    return 1;
  }
  writeFileSync(path, next, 'utf8');
  console.log(`Rewrote ${SHIPPED} from ${from ?? REGISTRY_URL}.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(String(err?.message ?? err));
      process.exit(1);
    }
  );
}
