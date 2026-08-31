/**
 * The installed-extension loader and the SDK global (§13.8, downloadable extensions, 2026-08-30).
 *
 * Four things a pull request could break where nothing else would notice:
 *
 *  1. **The URL shape.** `installed.ts` re-declares `main/protocol.ts#moduleUrl` because the renderer
 *     must not import from `main`. The two are compared here by reading `protocol.ts` off disk —
 *     a contract nothing compares is a contract that has already drifted.
 *  2. **The gates.** Not enabled, a stale `hostApi`, or an id the build already ships: three reasons
 *     a manifest that exists on disk is not offered, and each one is a different bug if it stops
 *     holding. The `hostApi` gate is also what narrows an `InstalledManifest` back to a
 *     `ModuleManifest`, so it is a type-level claim as well as a runtime one.
 *  3. **The failure mode.** A module whose file will not load must produce a *reported* failure and
 *     a rejected `load()`, never a half-built switcher — the row is a manifest, and the failure is
 *     inside `load()`, which is exactly where `ShellController.activateModule`'s catch already is.
 *  4. **The SDK global is the five members the shim expects.** The two halves live in different
 *     processes' code and were written in different waves; this reads
 *     `scripts/module-sdk/sdk-runtime.ts`'s `TetravoxModuleSdk` and asserts the object this file
 *     builds has exactly those keys. `scripts/emit-module-sdk.test.mjs` pins the same list from the
 *     other side.
 *
 * The `import()` in `load()` is exercised for real here: `tetravox://module/…` is unreachable under
 * vitest, so the rejection path is the one that runs, which is the path a 404 from an unconsented
 * module takes in the product.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MODULE_HOST_VERSION } from '../../../modules/manifest-types';
import type { InstalledManifest } from '../../../modules/manifest-types';
import type { ModuleStatus } from '../../../preload/index';
import {
  MODULE_ENTRY,
  checkLoadedShape,
  eligibleInstalled,
  installedRegistrations,
  moduleUrl,
} from './installed';
import {
  MODULES,
  enabledModules,
  installedModuleRegistrations,
  setInstalledModules,
} from './registry';
import { contactsKit, installModuleSdk, moduleSdk } from './sdk-runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..', '..');
const PROTOCOL = resolve(HERE, '..', '..', '..', 'main', 'protocol.ts');
const SHIM = resolve(REPO_ROOT, 'scripts', 'module-sdk', 'sdk-runtime.ts');

function manifest(over: Partial<InstalledManifest> = {}): InstalledManifest {
  return {
    id: 'vendor.thing',
    title: 'Thing',
    version: '1.0.0',
    hostApi: MODULE_HOST_VERSION,
    docs: 'https://example.invalid/thing',
    activation: ['onToggle'],
    commands: [],
    ...over,
  };
}

function status(over: Partial<ModuleStatus> = {}): ModuleStatus {
  return {
    id: 'vendor.thing',
    title: 'Thing',
    installed: '1.0.0',
    bundled: false,
    enabled: true,
    available: null,
    updatable: false,
    permissions: [],
    ...over,
  };
}

afterEach(() => {
  setInstalledModules([]);
});

describe('the loader URL', () => {
  it('is byte-for-byte `main/protocol.ts#moduleUrl`', () => {
    const source = readFileSync(PROTOCOL, 'utf8');
    // The template literal main serves from. Both sides are `${SCHEME}://module/${id}/${version}/…`
    // by way of `moduleKey`, so what is compared is the *key* shape plus the host.
    expect(source).toContain('return `${id}/${version}/${file}`;');
    expect(source).toContain('return `${SCHEME}://module/${moduleKey(id, version, file)}`;');
    expect(source).toContain("export const SCHEME = 'tetravox';");
    expect(moduleUrl('vendor.thing', '1.0.0', MODULE_ENTRY)).toBe(
      'tetravox://module/vendor.thing/1.0.0/index.js'
    );
  });

  it('names `index.js`, which is what `enableModule` serves', () => {
    expect(MODULE_ENTRY).toBe('index.js');
  });
});

describe('the loaded namespace is shape-checked', () => {
  it('accepts a namespace with an `activate` function', () => {
    const checked = checkLoadedShape({ activate: () => ({}) }, 'vendor.thing');
    expect(checked.ok).toBe(true);
  });

  it('accepts extra exports beside `activate`', () => {
    const checked = checkLoadedShape(
      { activate: () => ({}), manifest: {}, VERSION: '1.0.0' },
      'vendor.thing'
    );
    expect(checked.ok).toBe(true);
  });

  it('refuses a namespace with no `activate`, naming the module', () => {
    const checked = checkLoadedShape({ hello: 1 }, 'vendor.thing');
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error('unreachable');
    expect(checked.error).toContain('vendor.thing');
    expect(checked.error).toContain('activate');
  });

  it('refuses a non-object and a null', () => {
    expect(checkLoadedShape(null, 'vendor.thing').ok).toBe(false);
    expect(checkLoadedShape('index.js', 'vendor.thing').ok).toBe(false);
  });
});

describe('which installed manifests are offered', () => {
  it('offers an enabled, compatible manifest', () => {
    expect(eligibleInstalled([manifest()], [status()], []).map((m) => m.id)).toEqual([
      'vendor.thing',
    ]);
  });

  it('does not offer one that is installed but not enabled — consent gates the switcher too', () => {
    expect(eligibleInstalled([manifest()], [status({ enabled: false })], [])).toEqual([]);
  });

  it('does not offer one whose `hostApi` this build does not implement', () => {
    const stale = manifest({ hostApi: MODULE_HOST_VERSION + 1 });
    expect(eligibleInstalled([stale], [status()], [])).toEqual([]);
  });

  it('does not let an installed module shadow a compiled-in id', () => {
    const shadow = manifest({ id: 'tetravox.hello' });
    expect(
      eligibleInstalled([shadow], [status({ id: 'tetravox.hello' })], ['tetravox.hello'])
    ).toEqual([]);
  });

  it('narrows `hostApi` to the literal the build implements', () => {
    const [only] = eligibleInstalled([manifest()], [status()], []);
    expect(only?.hostApi).toBe(MODULE_HOST_VERSION);
  });
});

describe('a registration whose file will not load', () => {
  it('reports the failure and rejects, rather than resolving something broken', async () => {
    const seen: { id: string; reason: string }[] = [];
    const [registration] = installedRegistrations(
      eligibleInstalled([manifest()], [status()], []),
      (id, reason) => seen.push({ id, reason })
    );
    if (registration === undefined) throw new Error('no registration built');
    // The row exists before the load is ever attempted — that is what keeps the switcher whole.
    expect(registration.manifest.id).toBe('vendor.thing');
    await expect(registration.load()).rejects.toThrow(/vendor\.thing/);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe('vendor.thing');
    expect(seen[0]?.reason).toContain(MODULE_ENTRY);
  });
});

describe('the registry merges the installed set', () => {
  it('is empty until something is set', () => {
    expect(installedModuleRegistrations()).toEqual([]);
    expect(enabledModules('').map((m) => m.manifest.id)).toEqual(
      MODULES.filter((m) => m.fixture !== true).map((m) => m.manifest.id)
    );
  });

  it('appends installed registrations after the compiled-in ones', () => {
    setInstalledModules(
      installedRegistrations(eligibleInstalled([manifest()], [status()], []), () => {})
    );
    const ids = enabledModules('').map((m) => m.manifest.id);
    expect(ids).toContain('vendor.thing');
    expect(ids.indexOf('vendor.thing')).toBe(ids.length - 1);
  });

  it('lets a compiled-in module win a duplicate id', () => {
    // `eligibleInstalled` already refuses this, so the registry's own guard is the second lock —
    // and the one that would matter if a caller built registrations some other way. `hello` is the
    // only compiled-in module since the sEEG editor became a bundled extension (§13.8, 2026-08-31);
    // it is a fixture, so the search names it to bring the compiled-in copy into `enabledModules`.
    setInstalledModules([
      {
        manifest: { ...manifest({ id: 'tetravox.hello' }), hostApi: 1 },
        load: async () => ({ activate: () => ({}) as never }),
      },
    ]);
    const ids = enabledModules('?modules=hello').map((m) => m.manifest.id);
    expect(ids.filter((id) => id === 'tetravox.hello')).toHaveLength(1);
  });

  it('drops everything again when the set is replaced', () => {
    setInstalledModules(
      installedRegistrations(eligibleInstalled([manifest()], [status()], []), () => {})
    );
    setInstalledModules([]);
    expect(enabledModules('').map((m) => m.manifest.id)).not.toContain('vendor.thing');
  });
});

describe('the SDK global', () => {
  /** The member list `scripts/module-sdk/sdk-runtime.ts` declares — the shim's own source. */
  function shimMembers(): string[] {
    const shim = readFileSync(SHIM, 'utf8');
    const body = /export interface TetravoxModuleSdk \{([\s\S]*?)\n\}/.exec(shim);
    if (body === null) throw new Error('the shim no longer declares TetravoxModuleSdk');
    return [...body[1]!.matchAll(/^ {2}(\w+)[?:]/gm)].map((m) => m[1]!).sort();
  }

  it('is exactly the members the shim reads, and no more', () => {
    expect(Object.keys(moduleSdk()).sort()).toEqual(shimMembers());
    expect(shimMembers()).toEqual([
      'ModuleHostError',
      'contacts',
      'hostVersion',
      'react',
      'stemOf',
    ]);
  });

  it('hands over the host’s own values, not copies of them', async () => {
    const sdk = moduleSdk();
    const { ModuleHostError } = await import('./host');
    const { stemOf } = await import('../../../modules/manifest-types');
    // `instanceof` across the module boundary is the whole reason the class travels rather than a
    // second declaration of it.
    expect(sdk.ModuleHostError).toBe(ModuleHostError);
    expect(new sdk.ModuleHostError('x')).toBeInstanceOf(ModuleHostError);
    expect(sdk.stemOf).toBe(stemOf);
    expect(sdk.hostVersion).toBe(MODULE_HOST_VERSION);
    expect(typeof sdk.react.createElement).toBe('function');
    expect(typeof sdk.react.useSyncExternalStore).toBe('function');
  });

  it('flattens the whole contacts kit into one namespace', () => {
    const kit = contactsKit();
    // One name from each of the seven modules the SDK's generated barrel re-exports.
    for (const name of [
      'buildEditlog',
      'fitLine',
      'pointsOf',
      'emptySet',
      'paletteColor',
      'snapContacts',
      'parseTable',
    ]) {
      expect(typeof (kit as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('is installed on `globalThis` under the one key the shim reads', () => {
    const shim = readFileSync(SHIM, 'utf8');
    for (const key of [...shim.matchAll(/globalThis\.(__\w+)/g)].map((m) => m[1])) {
      expect(key).toBe('__tetravoxModuleSdk');
    }
    const sdk = installModuleSdk();
    expect(globalThis.__tetravoxModuleSdk).toBe(sdk);
  });
});
