/**
 * `src/modules/manifest-schema.ts` — the JSON carrier's `tsc` (§13.1, downloadable extensions).
 *
 * **Why this file is in `main/` and not beside the thing it tests.** `modules.test.ts`'s "src/modules
 * is data only" block reads every source under `packages/app/src/modules` and requires every import
 * in it to resolve *inside* that directory — which is what lets main import a manifest before a
 * window exists. `import { describe } from 'vitest'` is not inside that directory, so a test living
 * there would fail the rule it exists to support. Main is the consumer that validates an installed
 * manifest, so the test lives with the consumer.
 *
 * Two of these are cross-checks rather than unit tests, and they are the ones that would actually
 * catch a drift:
 *
 *  * every compiled-in manifest passes the validator written for the downloaded ones — one schema,
 *    two carriers, and the two are checked against each other rather than each against a comment;
 *  * the sibling-template rule matches `main/module-io.ts`'s admission rule character for character.
 *    A manifest that declares a template main would refuse is a module whose save is rejected by the
 *    very list that exists to permit it.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
}));

import {
  ARG_TYPES,
  CONTRIBUTED_ID,
  MANIFEST_ID,
  SEMVER,
  SIBLING_TEMPLATE,
  derivePermissions,
  validateManifest,
} from '../modules/manifest-schema';
import { MANIFESTS } from '../modules/manifests';
import { MODULE_HOST_VERSION, MODULE_KEY_POOL } from '../modules/manifest-types';
import { SIBLING_TEMPLATE as MAIN_SIBLING_TEMPLATE } from './module-io';

/** The smallest manifest that passes, so each case below changes exactly one thing. */
function base(): Record<string, unknown> {
  return {
    id: 'vendor.thing',
    title: 'A thing',
    version: '1.0.0',
    hostApi: 1,
    docs: 'https://example.invalid/thing',
    activation: ['onToggle'],
    commands: [{ id: 'save', title: 'Save', key: 's' }],
  };
}

function errorsFor(patch: Record<string, unknown>): string[] {
  const result = validateManifest({ ...base(), ...patch });
  return result.ok ? [] : result.errors;
}

describe('the two carriers agree', () => {
  it('accepts every manifest compiled into this build', () => {
    // The load-bearing assertion of this file. `modules.test.ts` proves the compiled-in manifests
    // obey the rules; this proves the *validator* agrees with those rules, so a downloaded manifest
    // and a compiled-in one are held to one standard.
    for (const manifest of MANIFESTS) {
      const result = validateManifest(JSON.parse(JSON.stringify(manifest)));
      expect(result.ok, `${manifest.id}: ${result.ok ? '' : result.errors.join('; ')}`).toBe(true);
    }
  });

  it('uses the same sibling-template rule main admits against', () => {
    expect(SIBLING_TEMPLATE.source).toBe(MAIN_SIBLING_TEMPLATE.source);
    expect(SIBLING_TEMPLATE.flags).toBe(MAIN_SIBLING_TEMPLATE.flags);
  });

  it('names every key in the live pool and every live ArgType', () => {
    for (const key of MODULE_KEY_POOL) {
      expect(errorsFor({ commands: [{ id: 'c', title: 'C', key }] })).toEqual([]);
    }
    for (const type of ARG_TYPES) {
      expect(errorsFor({ operations: [{ id: 'op', args: { a: type } }] })).toEqual([]);
    }
  });
});

describe('validateManifest', () => {
  it('accepts the minimal manifest and returns it unchanged', () => {
    const raw = base();
    const result = validateManifest(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest).toEqual(raw);
  });

  it('reports every problem at once, not just the first', () => {
    // The `validateJob` house style: a module author gets one list, not four builds.
    const errors = errorsFor({ id: 'nope', version: 'v1', hostApi: 'one', docs: '' });
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.some((e) => e.startsWith('id:'))).toBe(true);
    expect(errors.some((e) => e.startsWith('version:'))).toBe(true);
    expect(errors.some((e) => e.startsWith('hostApi:'))).toBe(true);
    expect(errors.some((e) => e.startsWith('docs:'))).toBe(true);
  });

  it.each([
    ['a string', 'manifest'],
    ['an array', []],
    ['null', null],
    ['a number', 7],
  ])('refuses %s outright', (_name, raw) => {
    expect(validateManifest(raw).ok).toBe(false);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // `manifest.json` is `ModuleManifest` and nothing more: file names, sizes and hashes belong to
    // the release and to the install receipt. A typo has to be an error or it is a silent feature.
    expect(errorsFor({ entry: 'index.js' })).toEqual([
      'manifest.entry: unknown key (expected id, title, version, hostApi, docs, activation, commands, readers, siblings, writers, operations, sceneBlock, ui)',
    ]);
  });

  it.each([
    'thing',
    'Vendor.thing',
    'vendor.Thing',
    '1vendor.thing',
    'vendor.thing.extra',
    'vendor/thing',
    '../etc',
  ])('rejects the id %s', (id) => {
    expect(errorsFor({ id })).not.toEqual([]);
    expect(MANIFEST_ID.test(id)).toBe(false);
  });

  it.each(['1.0', '1.0.0.0', 'v1.0.0', '01.0.0', ''])('rejects the version %s', (version) => {
    expect(errorsFor({ version })).not.toEqual([]);
    expect(SEMVER.test(version)).toBe(false);
  });

  it('accepts a pre-release version, because a module may ship one', () => {
    expect(errorsFor({ version: '1.0.0-rc.1' })).toEqual([]);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '1'],
  ])('rejects a %s hostApi', (_name, hostApi) => {
    expect(errorsFor({ hostApi })).not.toEqual([]);
  });

  it('accepts a hostApi this build does not implement — refusing it is the *host*’s job', () => {
    // The whole reason `InstalledManifest.hostApi` is a `number`: a stale manifest has to be
    // *representable* so the version gate can see it and say why. A schema that refused it here
    // would turn "needs Tetravox host API 2" into "not a manifest", which is a worse message.
    expect(errorsFor({ hostApi: MODULE_HOST_VERSION + 1 })).toEqual([]);
  });

  it.each([[[]], [['onNothing']], [['onToggle', 'onWhatever']], ['onToggle']])(
    'rejects the activation list %j',
    (activation) => {
      expect(errorsFor({ activation })).not.toEqual([]);
    }
  );

  it('rejects a duplicate contributed id inside one manifest', () => {
    const errors = errorsFor({
      commands: [
        { id: 'save', title: 'Save' },
        { id: 'save', title: 'Save again' },
      ],
    });
    expect(errors.some((e) => e.includes('duplicate id "save"'))).toBe(true);
  });

  it.each(['Save', 'save-it!', '-save', '1save', ''])('rejects the command id %s', (id) => {
    expect(errorsFor({ commands: [{ id, title: 'X' }] })).not.toEqual([]);
    expect(CONTRIBUTED_ID.test(id)).toBe(false);
  });

  it('rejects a key outside §13.5’s pool, including a core one', () => {
    for (const key of ['q', 'Escape', ' ', 'r', 'ArrowUp']) {
      expect(errorsFor({ commands: [{ id: 'c', title: 'C', key }] })).not.toEqual([]);
    }
  });

  it('rejects a reader extension with a dot, an upper case letter or nothing in it', () => {
    for (const ext of ['.tsv', 'TSV', '']) {
      const errors = errorsFor({
        readers: [{ id: 'r', title: 'R', extensions: [ext] }],
      });
      expect(errors, `extension ${JSON.stringify(ext)}`).not.toEqual([]);
    }
  });

  it('rejects a reader `match` that will not compile', () => {
    expect(
      errorsFor({ readers: [{ id: 'r', title: 'R', extensions: ['tsv'], match: '([' }] })
    ).not.toEqual([]);
  });

  it('caps sibling candidates at three ascents (contracts §2)', () => {
    const ok = errorsFor({
      siblings: [{ from: '(?<sub>sub-[^_]+)', candidates: ['../../../x.json'] }],
    });
    expect(ok).toEqual([]);
    const tooFar = errorsFor({
      siblings: [{ from: '(?<sub>sub-[^_]+)', candidates: ['../../../../x.json'] }],
    });
    expect(tooFar.some((e) => e.includes('".." ascents'))).toBe(true);
  });

  it('rejects an absolute sibling candidate, and one that ascends after descending', () => {
    expect(errorsFor({ siblings: [{ from: 'a', candidates: ['/etc/passwd'] }] })).not.toEqual([]);
    expect(errorsFor({ siblings: [{ from: 'a', candidates: ['sub/../../up'] }] })).not.toEqual([]);
  });

  it('rejects a writer sibling template main would refuse to admit', () => {
    // A separator or a space is the case that matters: `admitModuleWrite` drops the template, the
    // save "works", and the editlog silently never lands.
    for (const template of ['../{name}.bak', 'a/b.bak', '{name} copy.bak', '']) {
      expect(
        errorsFor({
          writers: [
            {
              id: 'w',
              title: 'W',
              filters: [{ name: 'T', extensions: ['tsv'] }],
              siblings: [template],
            },
          ],
        }),
        template
      ).not.toEqual([]);
    }
  });

  it('accepts the two templates the sEEG writer really declares', () => {
    expect(
      errorsFor({
        writers: [
          {
            id: 'w',
            title: 'W',
            filters: [{ name: 'T', extensions: ['tsv'] }],
            siblings: ['{name}.{stamp}.bak', '{stem}_editlog.json'],
            backup: 'timestamped',
          },
        ],
      })
    ).toEqual([]);
  });

  it('rejects an operation argument type that is not an ArgType', () => {
    expect(errorsFor({ operations: [{ id: 'op', args: { a: 'int' } }] })).not.toEqual([]);
    expect(errorsFor({ operations: [{ id: 'op', args: { a: 'path' } }] })).toEqual([]);
  });

  it('rejects a sceneBlock without a positive integer version', () => {
    expect(errorsFor({ sceneBlock: { version: 1 } })).toEqual([]);
    expect(errorsFor({ sceneBlock: {} })).not.toEqual([]);
    expect(errorsFor({ sceneBlock: { version: 0 } })).not.toEqual([]);
    expect(errorsFor({ sceneBlock: { version: 1, extra: true } })).not.toEqual([]);
  });
});

describe('derivePermissions', () => {
  it('derives the sheet from the manifest and from nothing else', () => {
    const result = validateManifest({
      ...base(),
      commands: [
        { id: 'save', title: 'Save', key: 's' },
        { id: 'del', title: 'Delete', key: 'Delete' },
      ],
      readers: [{ id: 'r', title: 'R', extensions: ['tsv', 'csv'] }],
      writers: [
        {
          id: 'w',
          title: 'W',
          filters: [{ name: 'T', extensions: ['tsv'] }],
          siblings: ['{name}.{stamp}.bak'],
        },
      ],
      operations: [{ id: 'load', args: {} }],
      sceneBlock: { version: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = derivePermissions(result.manifest);
    expect(lines).toContain('Read .csv, .tsv files you choose');
    expect(lines).toContain('Write .tsv files you name in a Save sheet');
    expect(lines).toContain('Write {name}.{stamp}.bak beside the file you save');
    expect(lines).toContain('Bind the keys Delete, s while it is active');
    expect(lines).toContain('Run from a job file: load');
    expect(lines).toContain('Store its own data inside a saved scene');
  });

  it('says nothing about a module that asks for nothing', () => {
    const result = validateManifest({ ...base(), commands: [{ id: 'go', title: 'Go' }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(derivePermissions(result.manifest)).toEqual([]);
  });

  it('names a top-level `siblings` block as a read capability, so a siblings-only module is never empty', () => {
    // The finding's manifest: nothing but a keyless command and a `siblings` block that ascends to a
    // secrets file. Its runtime `host.files.siblings` admits and reads arbitrary text files, so its
    // sheet must not derive an empty list — which the dialog renders as "nothing beyond drawing".
    const result = validateManifest({
      ...base(),
      commands: [{ id: 'go', title: 'Go' }],
      siblings: [{ from: '.*', candidates: ['../../../secrets.tsv'] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = derivePermissions(result.manifest);
    expect(lines).toContain('Discover and read files named near a file you open');
    expect(lines).not.toEqual([]);
  });
});

describe('the `ui` block (§13.10)', () => {
  it('is optional, and every field of it is', () => {
    expect(errorsFor({})).toEqual([]);
    expect(errorsFor({ ui: {} })).toEqual([]);
    expect(errorsFor({ ui: { popout: 'preferred', windowWidth: 900, windowHeight: 700 } })).toEqual(
      []
    );
  });

  it('refuses a popout mode it does not know, rather than treating it as the default', () => {
    // The failure this prevents is silent: an unknown value falling back to `'allowed'` gives a
    // module that asked never to be popped out a ⧉ button.
    expect(errorsFor({ ui: { popout: 'sometimes' } })).toEqual([
      'ui.popout: must be one of allowed, preferred, never',
    ]);
  });

  it('refuses a window no screen can hold, and a fractional one', () => {
    expect(errorsFor({ ui: { windowWidth: 30000 } })).not.toEqual([]);
    expect(errorsFor({ ui: { windowHeight: 12.5 } })).not.toEqual([]);
    expect(errorsFor({ ui: { windowWidth: 100 } })).not.toEqual([]);
  });

  it('is not a permission — where a panel draws is not a capability', () => {
    // The consent sheet must not grow a line for a module that only asked for a bigger window: a
    // sheet that lists layout facts beside file-write capabilities teaches people to skim it.
    const result = validateManifest({
      ...base(),
      commands: [{ id: 'go', title: 'Go' }],
      ui: { popout: 'preferred', windowWidth: 900 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(derivePermissions(result.manifest)).toEqual([]);
  });
});
