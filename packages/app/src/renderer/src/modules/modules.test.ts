/**
 * The module registry's governance test (§13.4).
 *
 * Everything here is a rule a module could break in a pull request and nobody would notice in review:
 *
 *  1. **Manifest shape.** Unique `<vendor>.<name>` ids, semver, the `hostApi` this build implements,
 *     unprefixed and unique command/reader/writer/operation ids, a `docs` heading that exists.
 *  2. **Keys.** Every bound key is in §13.5's pool, no two commands of one module share a chord, and
 *     — the load-bearing half — **every pool key ± Shift is probed through the live `resolveKey`**
 *     and must come back `null`, plus a miss against the seven keys the engine binds on the canvas
 *     that no resolver probe would ever reveal. Three keydown listeners share this window
 *     (`keymap.ts`, the module resolver, the engine's own), so this is the collision test.
 *  3. **Data only.** `src/modules/**` is read off disk and every import in it must resolve *inside*
 *     that directory — no engine, no store, no `node:`, no bridge. That is what lets the main
 *     process import a manifest before a window exists.
 *  4. **The lint wall, proved from the other side.** `renderer/src/modules/<id>/**` may reach
 *     `../host`, the shared control kit and `@tetravox/engine` **types**; a value import of the
 *     engine, or any import of the store / bridge / automation, fails here as well as in ESLint. A
 *     lint rule can be switched off inline; this cannot.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENGINE_RESERVED_KEYS,
  MODULE_HOST_VERSION,
  MODULE_KEY_POOL,
} from '../../../modules/manifest-types';
import type { ModuleKey } from '../../../modules/manifest-types';
import { MANIFESTS } from '../../../modules/manifests';
import { resolveKey } from '../keyboard/keymap';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/app/src/modules` — the data-only half. */
const DATA_DIR = resolve(HERE, '..', '..', '..', 'modules');
/** `packages/app/src/renderer/src/modules` — this directory; its subdirectories are the modules. */
const CODE_DIR = HERE;
const USER_GUIDE = resolve(HERE, '..', '..', '..', '..', '..', '..', 'docs', 'USER_GUIDE.md');

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesUnder(child));
    else if (/\.tsx?$/.test(entry.name)) out.push(child);
  }
  return out;
}

/** Every module specifier a file imports or re-exports, static and dynamic alike. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) out.push(match[1] as string);
  }
  return out;
}

/** True when a relative specifier stays inside `root`. Bare specifiers never do. */
function staysInside(file: string, specifier: string, root: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const target = resolve(dirname(file), specifier);
  return !relative(root, target).startsWith('..');
}

describe('every module manifest', () => {
  it('has a `<vendor>.<name>` id, and the ids are unique', () => {
    const ids = MANIFESTS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
  });

  it('declares a semver version and the host API this build implements', () => {
    for (const manifest of MANIFESTS) {
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
      expect(manifest.hostApi).toBe(MODULE_HOST_VERSION);
    }
  });

  it('names at least one activation route and gives every command a title', () => {
    for (const manifest of MANIFESTS) {
      expect(manifest.activation.length).toBeGreaterThan(0);
      for (const command of manifest.commands) {
        expect(command.title.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every contributed id unprefixed and unique within the manifest', () => {
    for (const manifest of MANIFESTS) {
      const groups = [
        manifest.commands.map((c) => c.id),
        (manifest.readers ?? []).map((r) => r.id),
        (manifest.writers ?? []).map((w) => w.id),
        (manifest.operations ?? []).map((o) => o.id),
      ];
      for (const ids of groups) {
        expect(new Set(ids).size).toBe(ids.length);
        // The host namespaces these as `<moduleId>/<id>`; a manifest that prefixed them itself would
        // produce `tetravox.hello/tetravox.hello/ping`.
        for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    }
  });

  it('points `docs` at a `## ` heading that really exists in the user guide', () => {
    const guide = readFileSync(USER_GUIDE, 'utf8');
    for (const manifest of MANIFESTS) {
      expect(guide).toContain(`\n## ${manifest.docs}\n`);
    }
  });

  it('declares a reader with lower-case, dot-less extensions', () => {
    for (const manifest of MANIFESTS) {
      for (const reader of manifest.readers ?? []) {
        expect(reader.extensions.length).toBeGreaterThan(0);
        for (const extension of reader.extensions) expect(extension).toMatch(/^[a-z0-9]+$/);
        if (reader.match !== undefined)
          expect(() => new RegExp(reader.match as string)).not.toThrow();
      }
    }
  });

  it('declares sibling patterns that compile and ascend at most three directories', () => {
    for (const manifest of MANIFESTS) {
      for (const sibling of manifest.siblings ?? []) {
        expect(() => new RegExp(sibling.from)).not.toThrow();
        for (const candidate of sibling.candidates) {
          expect(candidate.startsWith('/')).toBe(false);
          expect(candidate.split('/').filter((s) => s === '..').length).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});

describe('the §13.5 key pool', () => {
  it('is the same set as the `ModuleKey` union', () => {
    // Assigning the array to the union's element type is the compile-time half; the length is the
    // half a stale entry would slip past.
    const pool: readonly ModuleKey[] = MODULE_KEY_POOL;
    expect(new Set(pool).size).toBe(pool.length);
    expect(pool).toContain('Delete');
    expect(pool).toContain('Backspace');
  });

  it('collides with nothing `resolveKey` claims, with or without Shift', () => {
    for (const key of MODULE_KEY_POOL) {
      for (const shiftKey of [false, true]) {
        const command = resolveKey({
          key,
          ctrlKey: false,
          metaKey: false,
          shiftKey,
          altKey: false,
          editable: false,
        });
        // `Shift+Delete` / `Shift+Backspace` are `removeLastMeasurement` in the core map, so a module
        // may bind the **plain** key only. That is the one asymmetry, and it is asserted, not hidden.
        if ((key === 'Delete' || key === 'Backspace') && shiftKey) {
          expect(command).toEqual({ kind: 'removeLastMeasurement' });
          continue;
        }
        expect(command).toBeNull();
      }
    }
  });

  it('misses every key the engine binds on the canvas', () => {
    for (const key of MODULE_KEY_POOL) {
      expect(ENGINE_RESERVED_KEYS).not.toContain(key);
      // The uppercase form too: a module resolver normalises `'Z'`+Shift to `z`, and `R` is `r`.
      expect(ENGINE_RESERVED_KEYS).not.toContain(key.toUpperCase());
    }
  });

  it('binds only pool keys, and no chord twice, in any manifest', () => {
    for (const manifest of MANIFESTS) {
      const chords = new Set<string>();
      for (const command of manifest.commands) {
        if (command.key === undefined) continue;
        expect(MODULE_KEY_POOL).toContain(command.key);
        // Shift+Delete / Shift+Backspace belong to the core map (see above).
        if (command.key === 'Delete' || command.key === 'Backspace') {
          expect(command.shift ?? false).toBe(false);
        }
        const chord = `${command.shift === true ? 'shift+' : ''}${command.key}`;
        expect(chords.has(chord)).toBe(false);
        chords.add(chord);
      }
    }
  });
});

describe('`src/modules` is data only', () => {
  const files = sourcesUnder(DATA_DIR);

  it('has manifests to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('imports nothing from outside itself', () => {
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        expect(
          staysInside(file, specifier, DATA_DIR),
          `${relative(DATA_DIR, file)} imports ${specifier}`
        ).toBe(true);
      }
    }
  });
});

describe('the module import wall (§13.1)', () => {
  const moduleDirs = readdirSync(CODE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(CODE_DIR, entry.name));

  it('has a module directory to check', () => {
    // The host's own files sit **directly** in `modules/`; only the subdirectories are modules.
    expect(moduleDirs.length).toBeGreaterThan(0);
  });

  it('lets a module reach the host, the control kit and engine types, and nothing else', () => {
    const forbidden =
      /(^|\/)(store|automation|open|panels)(\/|$)|(^|\/)bridge$|(^|\/)preload(\/|$)|(^|\/)engine\/(factory|mockEngine|commands)$/;
    for (const dir of moduleDirs) {
      for (const file of sourcesUnder(dir)) {
        const text = readFileSync(file, 'utf8');
        for (const specifier of importsOf(file)) {
          const where = `${relative(CODE_DIR, file)} imports ${specifier}`;
          expect(forbidden.test(specifier), where).toBe(false);
          if (specifier !== '@tetravox/engine') continue;
          // Types only. A value import would put engine code inside a module, which §13.8's worker
          // tier could never allow — and would make the wall a style rule rather than a boundary.
          // Anchored at a line start, the way `importsOf` matches: an import statement always
          // begins one, and an unanchored pattern also matches the word "import" in a doc comment
          // that happens to sit above the file's own type import.
          const value = new RegExp(
            `(?:^|\\n)\\s*import\\s+(?!type\\b)[^;]*?from\\s*['"]@tetravox/engine['"]`
          );
          expect(value.test(text), where).toBe(false);
        }
      }
    }
  });

  it('leaves its directory only for `../host`, the control kit, `../shared` or the contract', () => {
    for (const dir of moduleDirs) {
      for (const file of sourcesUnder(dir)) {
        for (const specifier of importsOf(file)) {
          if (!specifier.startsWith('..')) continue;
          // Four legal ways out of a module's directory, and none of them is the shell: the host,
          // the shared control kit, `modules/shared/**` — the hardware-independent libraries a
          // second module of the same family is built from (`shared/contacts/README.md`) — and
          // `src/modules/manifest-types`, the **data-only module contract** its own manifest is
          // written against. `shared/` is inside the wall rather than outside it: everything under
          // it is checked by this very loop, so a library that reached the store would fail here for
          // its own file. One extra `..` is allowed because a library lives one level deeper than a
          // module's root.
          //
          // The contract was added 2026-08-30 with the one `stemOf`: it declares `{stem}` for the
          // manifest and defines it for main, and a module computing a *different* `{stem}` is how
          // an editlog write got refused by the list that admitted it. Importing it can pull nothing
          // in — §13.1 already requires that file to import nothing at all, `modules.test.ts`'s
          // "data only" block above proves it, and the ESLint wall (which is the wall; this is the
          // guard) has always allowed it.
          expect(specifier, `${relative(CODE_DIR, file)} imports ${specifier}`).toMatch(
            /^\.\.\/(\.\.\/)?(host|ui\/|shared\/)|^(?:\.\.\/)+modules\/manifest-types$/
          );
        }
      }
    }
  });
});
