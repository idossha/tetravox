/**
 * The extension store (§13, downloadable extensions): the policy, not the plumbing.
 *
 * `module-io.test.ts` is the template — every assertion here is about a **refusal or an admission**,
 * because that is the feature. The channels themselves are eight `ipcMain.handle` lines; what
 * matters is that a file whose hash does not match is never installed, that an installed file is
 * re-hashed before it is ever reachable as script, that an unconsented module 404s from the scheme
 * and fails a job with a message the user can act on, and that disabling one revokes its write list
 * *in main* rather than asking the renderer to give it back.
 *
 * No network: every download goes through the injected `fetchImpl`, exactly as `sample-data.test.ts`
 * does. The filesystem is real, in a temp directory, so the `.part`-then-rename is the one the
 * product performs. `electron` is mocked — and its `protocol.handle` is **captured**, so the
 * `tetravox://module` host is driven here for real rather than only in the packaged E2E.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two roots, filled in `beforeAll`.
 *
 * `vi.hoisted` because the `electron` mock's factory closes over them and runs before this file's
 * body does; every member below reads them from inside a function, so the mock sees the real
 * directories by the time anything calls it.
 */
const dirs = vi.hoisted(() => ({ home: '', appPath: '', packaged: false }));

/** Captured so the `tetravox://module` handler can be driven directly, not only in a packaged E2E. */
const captured = vi.hoisted(() => ({
  handler: null as null | ((req: unknown) => Promise<Response>),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (): string => dirs.home,
    getAppPath: (): string => dirs.appPath,
    // A getter, so the env-seam test can flip `app.isPackaged` and put it back; every other test
    // sees the dev default (`false`).
    get isPackaged(): boolean {
      return dirs.packaged;
    },
  },
  net: {
    // `streamFile` fetches the file it is serving through `net.fetch(pathToFileURL(file))`.
    fetch: async (url: string): Promise<Response> => {
      try {
        return new Response(readFileSync(fileURLToPath(url)));
      } catch {
        return new Response(null, { status: 404 });
      }
    },
  },
  shell: { openPath: async (): Promise<string> => '' },
  protocol: {
    registerSchemesAsPrivileged: (): void => {},
    handle: (_scheme: string, handler: (req: unknown) => Promise<Response>): void => {
      captured.handler = handler;
    },
  },
  dialog: {},
  ipcMain: { handle: (): void => {}, on: (): void => {} },
  BrowserWindow: class {},
}));

import {
  RECEIPT_NAME,
  bootstrapInstalledModules,
  cancelInstall,
  catalogue,
  compareVersions,
  consents,
  disableModule,
  enableModule,
  installModule,
  installedModule,
  installedModules,
  isModuleConsented,
  moduleDir,
  moduleStatuses,
  refreshInstalledManifests,
  removeModule,
  startInstall,
  verifyInstalled,
  type ExtensionFile,
} from './module-store';
import { clearServedModules, handleScheme, servedModuleKeys } from './protocol';
import { admitModuleWrite, clearModuleWriteLists, isModuleWritable } from './module-io';
import { allManifests, installedManifests, registerInstalledManifests } from '../modules/manifests';
import { validateJob } from './job';
import { configHome, writeSettings } from './settings';

const sha = (b: Uint8Array | string): string =>
  createHash('sha256')
    .update(typeof b === 'string' ? new TextEncoder().encode(b) : b)
    .digest('hex');

const ID = 'vendor.thing';

function manifestText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: ID,
    title: 'A thing',
    version: '1.0.0',
    hostApi: 1,
    docs: 'https://example.invalid/thing',
    activation: ['onToggle'],
    commands: [{ id: 'go', title: 'Go' }],
    operations: [{ id: 'run', args: {} }],
    ...over,
  });
}

const ENTRY_JS = 'export const activate = () => {};\n';

/** Build a one-version catalogue whose file urls are keys into `served`. */
function indexFor(
  files: { name: string; text: string }[],
  over: { version?: string; hostApi?: number; declaredSha?: Record<string, string> } = {}
): { index: object; files: ExtensionFile[]; bodies: Record<string, Uint8Array> } {
  const bodies: Record<string, Uint8Array> = {};
  const list: ExtensionFile[] = files.map((f) => {
    const bytes = new TextEncoder().encode(f.text);
    const url = `https://store/${f.name}`;
    bodies[url] = bytes;
    return {
      name: f.name,
      bytes: bytes.length,
      sha256: over.declaredSha?.[f.name] ?? sha(bytes),
      url,
    };
  });
  return {
    index: {
      schema: 1,
      modules: [
        {
          id: ID,
          title: 'A thing',
          summary: 'one line',
          versions: [{ version: over.version ?? '1.0.0', hostApi: over.hostApi ?? 1, files: list }],
        },
      ],
    },
    files: list,
    bodies,
  };
}

function serveFrom(bodies: Record<string, Uint8Array>, calls: string[] = []) {
  return async (url: string): Promise<Response> => {
    calls.push(url);
    const body = bodies[url];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  };
}

function writeIndex(index: object): void {
  const path = join(dirs.home, 'index.json');
  writeFileSync(path, JSON.stringify(index));
  process.env['TETRAVOX_EXT_INDEX'] = path;
}

/** Put a module on disk directly, the way an install would have left it. */
function place(
  root: string,
  opts: {
    id?: string;
    version?: string;
    manifest?: string;
    files?: Record<string, string>;
    receipt?: boolean | object;
  } = {}
): string {
  const id = opts.id ?? ID;
  const version = opts.version ?? '1.0.0';
  const dir = join(root, id, version);
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    'manifest.json': opts.manifest ?? manifestText({ id, version }),
    'index.js': ENTRY_JS,
    ...opts.files,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  if (opts.receipt === false) return dir;
  const receipt =
    typeof opts.receipt === 'object'
      ? opts.receipt
      : {
          schema: 1,
          id,
          version,
          installedAt: '2026-08-30T00:00:00.000Z',
          files: Object.entries(files).map(([name, text]) => ({
            name,
            bytes: new TextEncoder().encode(text).length,
            sha256: sha(text),
          })),
        };
  writeFileSync(join(dir, RECEIPT_NAME), JSON.stringify(receipt));
  return dir;
}

function bundledRoot(): string {
  return join(dirs.appPath, 'resources', 'modules');
}

/**
 * The bundled tree as `scripts/fetch-locked-modules.mjs` leaves it: the locked files, and beside
 * them the receipt it writes from the lock entry it verified — same name, same shape, same
 * two-space JSON. The script's own tests prove it produces this; these prove main accepts it.
 */
function placeLikeBundlingStep(): string {
  const dir = place(bundledRoot(), { receipt: false });
  const files = ['index.js', 'manifest.json'].map((name) => {
    const bytes = readFileSync(join(dir, name));
    return { name, bytes: bytes.length, sha256: sha(bytes) };
  });
  writeFileSync(
    join(dir, RECEIPT_NAME),
    `${JSON.stringify({ schema: 1, id: ID, version: '1.0.0', installedAt: new Date().toISOString(), files }, null, 2)}\n`
  );
  return dir;
}

beforeAll(() => {
  dirs.home = mkdtempSync(join(tmpdir(), 'tvx-modstore-home-'));
  dirs.appPath = mkdtempSync(join(tmpdir(), 'tvx-modstore-app-'));
  process.env['TETRAVOX_HOME'] = dirs.home;
  process.env['TETRAVOX_MODULE_DIR'] = join(dirs.home, 'modules');
});

afterAll(() => {
  delete process.env['TETRAVOX_HOME'];
  delete process.env['TETRAVOX_MODULE_DIR'];
  delete process.env['TETRAVOX_EXT_INDEX'];
  rmSync(dirs.home, { recursive: true, force: true });
  rmSync(dirs.appPath, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(moduleDir(), { recursive: true, force: true });
  rmSync(bundledRoot(), { recursive: true, force: true });
  rmSync(join(dirs.home, 'settings.json'), { force: true });
  delete process.env['TETRAVOX_EXT_INDEX'];
  clearServedModules();
  clearModuleWriteLists();
  registerInstalledManifests([]);
});

afterEach(() => {
  clearServedModules();
});

describe('the catalogue', () => {
  it('is the shipped copy by default, so the dialog is correct with no network', () => {
    // `sample-data.ts`'s precedent exactly. An empty shipped index is a dialog with no cards, never
    // a dialog that cannot open.
    expect(Array.isArray(catalogue())).toBe(true);
  });

  it('is replaced by TETRAVOX_EXT_INDEX, which is the E2E’s and this file’s seam', () => {
    const { index } = indexFor([{ name: 'index.js', text: ENTRY_JS }]);
    writeIndex(index);
    expect(catalogue().map((m) => m.id)).toEqual([ID]);
  });

  it('falls back to the shipped copy when the override does not parse', () => {
    // No override yet (beforeEach cleared it): this is the copy the build ships, which carries the
    // bundled sEEG extension since the extraction (§13.8) rather than being empty.
    const shipped = catalogue().map((m) => m.id);
    expect(shipped).toContain('tetravox.seeg');
    const path = join(dirs.home, 'bad.json');
    writeFileSync(path, '{ not json');
    process.env['TETRAVOX_EXT_INDEX'] = path;
    expect(catalogue().map((m) => m.id)).toEqual(shipped);
  });

  it('ignores TETRAVOX_MODULE_DIR and TETRAVOX_EXT_INDEX in a shipped build, unless the E2E opts back in', () => {
    const realModuleDir = process.env['TETRAVOX_MODULE_DIR'];
    const evil = join(dirs.home, 'evil-modules');
    const { index } = indexFor([{ name: 'index.js', text: ENTRY_JS }]);
    writeIndex(index); // sets TETRAVOX_EXT_INDEX to a real fixture file
    process.env['TETRAVOX_MODULE_DIR'] = evil;
    try {
      // Dev (unpackaged): both seams are honoured, exactly as the E2E and this file rely on.
      expect(moduleDir()).toBe(evil);
      expect(catalogue().map((m) => m.id)).toEqual([ID]);

      // Packaged: an ambient env var cannot repoint the store or spoof the catalogue — the real
      // configHome()/modules store and the shipped catalogue win (finding, 2026-08-31). The shipped
      // index carries the bundled sEEG since the extraction (§13.8), so the win is that the env
      // fixture's id is absent, not that the catalogue is empty.
      dirs.packaged = true;
      expect(moduleDir()).toBe(join(configHome(), 'modules'));
      expect(moduleDir()).not.toBe(evil);
      const shippedPackaged = catalogue().map((m) => m.id);
      expect(shippedPackaged).toContain('tetravox.seeg');
      expect(shippedPackaged).not.toContain(ID);

      // …unless the packaged E2E leg opts back in with TETRAVOX_E2E=1 (the csp.spec.ts seam).
      process.env['TETRAVOX_E2E'] = '1';
      expect(moduleDir()).toBe(evil);
      expect(catalogue().map((m) => m.id)).toEqual([ID]);
    } finally {
      dirs.packaged = false;
      delete process.env['TETRAVOX_E2E'];
      delete process.env['TETRAVOX_EXT_INDEX'];
      if (realModuleDir === undefined) delete process.env['TETRAVOX_MODULE_DIR'];
      else process.env['TETRAVOX_MODULE_DIR'] = realModuleDir;
    }
  });
});

describe('compareVersions', () => {
  it('orders releases numerically and sorts a pre-release below its release', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
  });
});

describe('installing', () => {
  it('downloads, verifies and writes a receipt — and enables nothing', () => {
    const { index, bodies } = indexFor([
      { name: 'manifest.json', text: manifestText() },
      { name: 'index.js', text: ENTRY_JS },
    ]);
    writeIndex(index);
    return installModule(ID, '1.0.0', {
      fetchImpl: serveFrom(bodies),
      signal: new AbortController().signal,
    }).then((result) => {
      expect(result).toEqual({ ok: true, version: '1.0.0' });
      const dir = join(moduleDir(), ID, '1.0.0');
      expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe(ENTRY_JS);
      const receipt = JSON.parse(readFileSync(join(dir, RECEIPT_NAME), 'utf8')) as {
        files: { name: string; sha256: string }[];
      };
      expect(receipt.files.map((f) => f.name).sort()).toEqual(['index.js', 'manifest.json']);
      // Installing is **not** enabling: no consent, and nothing reachable through the scheme.
      expect(consents()[ID]).toBeUndefined();
      expect(servedModuleKeys()).toEqual([]);
    });
  });

  it('an update over an enabled module tears the old version off the map, revoking its writes and consent', async () => {
    const signal = (): AbortSignal => new AbortController().signal;
    // Install and enable v1, and admit a write the way a Save sheet would.
    const v1 = indexFor(
      [
        { name: 'manifest.json', text: manifestText({ version: '1.0.0' }) },
        { name: 'index.js', text: ENTRY_JS },
      ],
      { version: '1.0.0' }
    );
    writeIndex(v1.index);
    expect(
      (await installModule(ID, '1.0.0', { fetchImpl: serveFrom(v1.bodies), signal: signal() })).ok
    ).toBe(true);
    expect(enableModule(ID).ok).toBe(true);
    expect(servedModuleKeys()).toEqual([`${ID}/1.0.0/index.js`]);
    expect(consents()[ID]?.version).toBe('1.0.0');
    const target = join(dirs.home, 'notes.tsv');
    admitModuleWrite(ID, target, []);
    expect(isModuleWritable(ID, target)).toBe(true);

    // The update: install v2. Cancelling the following consent sheet is the renderer's business;
    // what is asserted here is main's own teardown, which runs regardless of the sheet.
    const v2 = indexFor(
      [
        { name: 'manifest.json', text: manifestText({ version: '2.0.0' }) },
        { name: 'index.js', text: ENTRY_JS },
      ],
      { version: '2.0.0' }
    );
    writeIndex(v2.index);
    expect(
      (await installModule(ID, '2.0.0', { fetchImpl: serveFrom(v2.bodies), signal: signal() })).ok
    ).toBe(true);

    // v1 is no longer served, its consent is gone, and its write admissions are revoked — the card's
    // "Enable" is now honest: the declined-update module is genuinely inert (finding, 2026-08-31).
    expect(servedModuleKeys()).toEqual([]);
    expect(consents()[ID]).toBeUndefined();
    expect(isModuleWritable(ID, target)).toBe(false);
  });

  it('refuses a file whose sha256 does not match, and leaves no .part behind', async () => {
    const { index, bodies } = indexFor(
      [
        { name: 'manifest.json', text: manifestText() },
        { name: 'index.js', text: ENTRY_JS },
      ],
      { declaredSha: { 'index.js': sha('something else entirely') } }
    );
    writeIndex(index);
    const result = await installModule(ID, '1.0.0', {
      fetchImpl: serveFrom(bodies),
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('refusing to install it');
    const dir = join(moduleDir(), ID, '1.0.0');
    expect(existsSync(join(dir, 'index.js'))).toBe(false);
    expect(existsSync(join(dir, `index.js.part`))).toBe(false);
    // No receipt, so even the manifest that *did* verify cannot be enabled.
    expect(existsSync(join(dir, RECEIPT_NAME))).toBe(false);
    expect(enableModule(ID).ok).toBe(false);
  });

  it('deletes the directory when the downloaded manifest is not a valid manifest', async () => {
    const { index, bodies } = indexFor([
      { name: 'manifest.json', text: JSON.stringify({ id: 'nope' }) },
      { name: 'index.js', text: ENTRY_JS },
    ]);
    writeIndex(index);
    const result = await installModule(ID, '1.0.0', {
      fetchImpl: serveFrom(bodies),
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(moduleDir(), ID, '1.0.0'))).toBe(false);
  });

  it('refuses when the catalogue and the manifest disagree about hostApi', async () => {
    // The redundancy in the index exists so a card can be drawn without downloading anything; a
    // disagreement between the two is therefore a hard failure, never a silent preference for one.
    // The index says hostApi 1; the manifest that actually downloads says 2.
    const { index, bodies } = indexFor(
      [
        { name: 'manifest.json', text: manifestText({ hostApi: 2 }) },
        { name: 'index.js', text: ENTRY_JS },
      ],
      { hostApi: 1 }
    );
    writeIndex(index);
    const result = await installModule(ID, '1.0.0', {
      fetchImpl: serveFrom(bodies),
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('the manifest says 2');
    expect(existsSync(join(moduleDir(), ID, '1.0.0'))).toBe(false);
  });

  it('refuses a catalogue version this build’s host API cannot run', async () => {
    const { index, bodies } = indexFor(
      [
        { name: 'manifest.json', text: manifestText({ hostApi: 9 }) },
        { name: 'index.js', text: ENTRY_JS },
      ],
      { hostApi: 9 }
    );
    writeIndex(index);
    const result = await installModule(ID, '1.0.0', {
      fetchImpl: serveFrom(bodies),
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('host API 9');
  });

  it('refuses a version with no manifest.json in it at all', async () => {
    const { index, bodies } = indexFor([{ name: 'index.js', text: ENTRY_JS }]);
    writeIndex(index);
    const result = await installModule(ID, '1.0.0', {
      fetchImpl: serveFrom(bodies),
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ships no manifest.json');
  });

  it('reports progress and joins a second request for the same id', async () => {
    const { index, bodies } = indexFor([
      { name: 'manifest.json', text: manifestText() },
      { name: 'index.js', text: ENTRY_JS },
    ]);
    writeIndex(index);
    const states: string[] = [];
    const first = startInstall(ID, '1.0.0', (p) => states.push(p.state), serveFrom(bodies));
    const second = startInstall(ID, '1.0.0', () => {}, serveFrom(bodies));
    expect(second).toBe(first);
    expect((await first).ok).toBe(true);
    expect(states).toContain('downloading');
    expect(states[states.length - 1]).toBe('done');
    // The in-flight entry is gone, so cancelling afterwards is honestly `false`.
    expect(cancelInstall(ID)).toBe(false);
  });
});

describe('what is on disk', () => {
  it('reads a valid installation and ignores a directory whose manifest disagrees with its name', () => {
    place(moduleDir());
    place(moduleDir(), { id: 'vendor.other', manifest: manifestText({ id: ID }) });
    expect(installedModules().map((m) => m.id)).toEqual([ID]);
  });

  it('ignores a directory whose manifest.json does not validate', () => {
    place(moduleDir(), { manifest: JSON.stringify({ id: ID, title: 'x' }) });
    expect(installedModules()).toEqual([]);
  });

  it('keeps the newest of two versions of one id', () => {
    place(moduleDir(), { version: '1.0.0', manifest: manifestText({ version: '1.0.0' }) });
    place(moduleDir(), { version: '1.2.0', manifest: manifestText({ version: '1.2.0' }) });
    expect(readdirSync(join(moduleDir(), ID)).sort()).toEqual(['1.0.0', '1.2.0']);
    expect(installedModule(ID)?.version).toBe('1.2.0');
  });

  it('lets a bundled module win a collision with a user-installed one of the same id', () => {
    place(moduleDir(), { version: '9.0.0', manifest: manifestText({ version: '9.0.0' }) });
    place(bundledRoot(), { version: '1.0.0' });
    const found = installedModule(ID);
    expect(found?.bundled).toBe(true);
    expect(found?.version).toBe('1.0.0');
  });
});

describe('enabling', () => {
  it('re-hashes every file and only then puts the .js on the protocol map', () => {
    place(moduleDir(), { files: { 'panel.css': 'a{}', 'notes.txt': 'hello' } });
    const result = enableModule(ID);
    expect(result.ok).toBe(true);
    // `.js` and `.css` only — `manifest.json`, the receipt and a stray `.txt` are never script.
    expect(servedModuleKeys()).toEqual([`${ID}/1.0.0/index.js`, `${ID}/1.0.0/panel.css`]);
    expect(consents()[ID]?.version).toBe('1.0.0');
    expect(isModuleConsented(ID)).toBe(true);
  });

  it('refuses a file that changed on disk after it was installed, and serves nothing', () => {
    // The `sample-data.ts` rule — a cached file is re-hashed, not trusted — with the sharper reason:
    // between install and enable this file became a script that runs with the whole preload bridge.
    const dir = place(moduleDir());
    writeFileSync(join(dir, 'index.js'), 'globalThis.pwned = true;\n');
    const result = enableModule(ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('refusing to run it');
    expect(servedModuleKeys()).toEqual([]);
    expect(consents()[ID]).toBeUndefined();
  });

  it('refuses a user-installed module with no receipt beside it', () => {
    place(moduleDir(), { receipt: false });
    const result = enableModule(ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(RECEIPT_NAME);
    expect(servedModuleKeys()).toEqual([]);
  });

  it('refuses a receipt naming a file that is not there', () => {
    const dir = place(moduleDir());
    rmSync(join(dir, 'index.js'));
    const result = enableModule(ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('is missing');
  });

  it('refuses a receipt naming a file outside its own directory', () => {
    place(moduleDir(), {
      receipt: {
        schema: 1,
        id: ID,
        version: '1.0.0',
        installedAt: '',
        files: [{ name: '../../../etc/passwd', bytes: 1, sha256: sha('x') }],
      },
    });
    const result = enableModule(ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unusable file');
  });

  it('refuses a manifest whose hostApi this build does not implement', () => {
    place(moduleDir(), { manifest: manifestText({ hostApi: 2 }) });
    const result = enableModule(ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('host API 2');
    expect(servedModuleKeys()).toEqual([]);
  });

  it('refuses a module with no script in it at all', () => {
    // The helper always writes an entry, so delete it and rewrite the receipt without its row.
    const dir = place(moduleDir());
    rmSync(join(dir, 'index.js'));
    writeFileSync(
      join(dir, RECEIPT_NAME),
      JSON.stringify({
        schema: 1,
        id: ID,
        version: '1.0.0',
        installedAt: '',
        files: [
          {
            name: 'manifest.json',
            bytes: readFileSync(join(dir, 'manifest.json')).length,
            sha256: sha(readFileSync(join(dir, 'manifest.json'))),
          },
        ],
      })
    );
    const result = enableModule(ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('nothing to load');
  });

  it('accepts a bundled module with no receipt, whose bytes are inside the signed application', () => {
    // The narrow exemption: a tree assembled by hand in a checkout. The bundling step always leaves
    // a receipt, which is what the next two tests are about.
    place(bundledRoot(), { receipt: false });
    expect(verifyInstalled(installedModule(ID)!).ok).toBe(true);
    expect(enableModule(ID).ok).toBe(true);
  });

  it('verifies a bundled module against the receipt the bundling step wrote', () => {
    // `scripts/fetch-locked-modules.mjs` writes exactly this file from the `modules.lock` entry
    // whose hashes it has just verified — so a bundled module goes through the same gate a
    // downloaded one does, against numbers a reviewer approved in a pull request.
    const dir = placeLikeBundlingStep();
    const receipt = JSON.parse(readFileSync(join(dir, RECEIPT_NAME), 'utf8')) as {
      schema: number;
      files: { name: string }[];
    };
    expect(receipt.schema).toBe(1);
    expect(receipt.files.map((f) => f.name).sort()).toEqual(['index.js', 'manifest.json']);
    expect(verifyInstalled(installedModule(ID)!).ok).toBe(true);
    expect(enableModule(ID).ok).toBe(true);
    expect(servedModuleKeys()).toEqual([`${ID}/1.0.0/index.js`]);
  });

  it('refuses a bundled file that no longer matches its receipt, and serves nothing', () => {
    // Before the bundling step wrote receipts this was undetectable: a bundled module with no
    // receipt is exempt, so anything that reached `resources/modules/` ran. Now the release's own
    // hashes are on disk beside it, and they are what decides.
    const dir = placeLikeBundlingStep();
    writeFileSync(join(dir, 'index.js'), 'globalThis.pwned = true;\n');
    const result = enableModule(ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('refusing to run it');
    expect(servedModuleKeys()).toEqual([]);
    expect(consents()[ID]).toBeUndefined();
  });

  it('replaces the previous version’s entries rather than serving both', () => {
    place(moduleDir(), { version: '1.0.0', manifest: manifestText({ version: '1.0.0' }) });
    expect(enableModule(ID).ok).toBe(true);
    place(moduleDir(), { version: '1.1.0', manifest: manifestText({ version: '1.1.0' }) });
    expect(enableModule(ID).ok).toBe(true);
    expect(servedModuleKeys()).toEqual([`${ID}/1.1.0/index.js`]);
    // The consent is for the version that is now installed; the old one is not silently carried.
    expect(consents()[ID]?.version).toBe('1.1.0');
  });

  it('treats an update as a new ask: a consent for 1.0.0 is not one for 1.1.0', () => {
    place(moduleDir(), { version: '1.0.0', manifest: manifestText({ version: '1.0.0' }) });
    expect(enableModule(ID).ok).toBe(true);
    place(moduleDir(), { version: '1.1.0', manifest: manifestText({ version: '1.1.0' }) });
    writeSettings({
      extensions: { [ID]: { version: '1.0.0', hostApi: 1, grantedAt: '', permissions: [] } },
    });
    expect(isModuleConsented(ID)).toBe(false);
  });
});

describe('the tetravox://module host', () => {
  beforeEach(() => {
    handleScheme(dirs.appPath);
  });

  async function get(url: string): Promise<Response> {
    expect(captured.handler).not.toBeNull();
    return captured.handler!({ url, method: 'GET' });
  }

  it('serves an enabled module’s entry and 404s everything else', async () => {
    place(moduleDir());
    expect(enableModule(ID).ok).toBe(true);
    const ok = await get(`tetravox://module/${ID}/1.0.0/index.js`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(ENTRY_JS);
    expect(ok.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    // The manifest and the receipt are on disk beside it and are not on the map, so they 404.
    expect((await get(`tetravox://module/${ID}/1.0.0/manifest.json`)).status).toBe(404);
    expect((await get(`tetravox://module/${ID}/1.0.0/${RECEIPT_NAME}`)).status).toBe(404);
  });

  it('404s a module that is installed but not consented — consent gates execution', async () => {
    place(moduleDir());
    expect((await get(`tetravox://module/${ID}/1.0.0/index.js`)).status).toBe(404);
  });

  it('404s a module nobody has ever installed', async () => {
    expect((await get('tetravox://module/tetravox.absent/1.0.0/index.js')).status).toBe(404);
  });

  it('has no traversal surface, because the pathname is a map key and not a path', async () => {
    // Chromium's standard-scheme parser normalises the pathname before the handler sees it, and the
    // handler then does a **map lookup** — so a `..` cannot walk anywhere: it either normalises onto
    // a key that is already served (harmless, below) or onto one that is not (404). There is no
    // join, no root, and therefore nothing to contain.
    place(moduleDir());
    expect(enableModule(ID).ok).toBe(true);
    for (const path of [
      `${ID}/1.0.0/../${RECEIPT_NAME}`,
      `${ID}/1.0.0/../../${ID}/1.0.0/manifest.json`,
      `${ID}/1.0.0/%2e%2e/manifest.json`,
      `..%2F..%2Fetc%2Fpasswd`,
      `${ID}/1.0.0`,
      `/`,
    ]) {
      const res = await get(`tetravox://module/${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it('normalises a `..` that lands back on a served key, which reaches nothing new', async () => {
    place(moduleDir());
    expect(enableModule(ID).ok).toBe(true);
    for (const path of [
      `${ID}/1.0.0/index.js/../index.js`,
      // `..` is clamped at the root by the standard-scheme parser, so ascending past it lands back
      // on the same key rather than anywhere above it.
      `${ID}/../../${ID}/1.0.0/index.js`,
    ]) {
      const res = await get(`tetravox://module/${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(ENTRY_JS);
    }
  });

  it('stops serving the moment the module is disabled', async () => {
    place(moduleDir());
    expect(enableModule(ID).ok).toBe(true);
    expect((await get(`tetravox://module/${ID}/1.0.0/index.js`)).status).toBe(200);
    disableModule(ID);
    expect((await get(`tetravox://module/${ID}/1.0.0/index.js`)).status).toBe(404);
  });
});

describe('disabling and removing', () => {
  it('revokes the module’s write list in main, not by asking the renderer', () => {
    // `fixwave-reports.md` finding 1: `tetravox:module-clear-writes` is renderer-cooperative by
    // construction, and a compromised renderer simply never sends it. Withdrawing a capability
    // cannot be a message main hopes to receive, so `disableModule` calls the revocation itself.
    place(moduleDir());
    expect(enableModule(ID).ok).toBe(true);
    const target = join(dirs.home, 'electrodes.tsv');
    expect(admitModuleWrite(ID, target, ['{name}.{stamp}.bak'])).not.toBeNull();
    expect(isModuleWritable(ID, target)).toBe(true);

    disableModule(ID);
    expect(isModuleWritable(ID, target)).toBe(false);
    expect(servedModuleKeys()).toEqual([]);
    expect(consents()[ID]).toBeUndefined();
  });

  it('revokes on remove as well, and deletes the directory', () => {
    place(moduleDir());
    expect(enableModule(ID).ok).toBe(true);
    const target = join(dirs.home, 'electrodes.tsv');
    admitModuleWrite(ID, target, []);
    expect(isModuleWritable(ID, target)).toBe(true);

    expect(removeModule(ID)).toEqual({ ok: true });
    expect(isModuleWritable(ID, target)).toBe(false);
    expect(existsSync(join(moduleDir(), ID))).toBe(false);
    expect(installedModules()).toEqual([]);
  });

  it('refuses to remove a bundled module, and disables it instead', () => {
    place(bundledRoot());
    expect(enableModule(ID).ok).toBe(true);
    const result = removeModule(ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ships with Tetravox');
    // Disabled all the same: the refusal is about deleting files, not about withdrawing consent.
    expect(servedModuleKeys()).toEqual([]);
    expect(existsSync(join(bundledRoot(), ID))).toBe(true);
  });
});

describe('a compiled-in id cannot be shadowed by an on-disk module', () => {
  const SHADOW = 'tetravox.hello'; // a real MANIFESTS id in this build (sEEG left MANIFESTS on 2026-08-31)

  it('refuses it entirely — not installed, not served, no consent fabricated at boot', () => {
    place(moduleDir(), {
      id: SHADOW,
      version: '9.9.9',
      manifest: manifestText({ id: SHADOW, version: '9.9.9' }),
    });
    // An on-disk copy claiming a built-in id is not in the installed set at all — the same skip the
    // renderer's eligibility check makes (finding, 2026-08-31).
    expect(installedModule(SHADOW)).toBeNull();
    expect(installedModules().some((m) => m.id === SHADOW)).toBe(false);
    // The MANIFESTS short-circuit still answers `true` for genuinely compiled-in code…
    expect(isModuleConsented(SHADOW)).toBe(true);
    // …but boot neither serves the shadow's bytes nor writes a fabricated consent record for it.
    bootstrapInstalledModules();
    expect(servedModuleKeys().some((k) => k.startsWith(`${SHADOW}/`))).toBe(false);
    expect(consents()[SHADOW]).toBeUndefined();
  });
});

describe('the card states', () => {
  it('says installed, enabled, bundled and updatable, and derives the permission list', () => {
    const { index } = indexFor([{ name: 'index.js', text: ENTRY_JS }], { version: '1.4.0' });
    writeIndex(index);
    place(moduleDir(), { version: '1.0.0', manifest: manifestText({ version: '1.0.0' }) });
    const before = moduleStatuses().find((s) => s.id === ID);
    expect(before).toMatchObject({
      installed: '1.0.0',
      enabled: false,
      bundled: false,
      available: '1.4.0',
      updatable: true,
    });
    expect(before?.permissions).toContain('Run from a job file: run');

    expect(enableModule(ID).ok).toBe(true);
    expect(moduleStatuses().find((s) => s.id === ID)?.enabled).toBe(true);
  });

  it('derives `enabled` from the served map, not the consent record: a consented-but-unserved module is not "Enabled"', () => {
    place(moduleDir(), { version: '1.0.0', manifest: manifestText({ version: '1.0.0' }) });
    expect(enableModule(ID).ok).toBe(true);
    expect(moduleStatuses().find((s) => s.id === ID)?.enabled).toBe(true);
    // An enable that did not survive to the map — a boot-time verification failure, or an in-session
    // update that unserved the old version — leaves the consent record but nothing served. The card
    // must not claim "Enabled ✓" while its code is not actually reachable (finding, 2026-08-31).
    clearServedModules();
    expect(consents()[ID]?.version).toBe('1.0.0');
    expect(moduleStatuses().find((s) => s.id === ID)?.enabled).toBe(false);
  });

  it('lists a catalogue module that is not installed, with nothing claimed about it', () => {
    const { index } = indexFor([{ name: 'index.js', text: ENTRY_JS }]);
    writeIndex(index);
    expect(moduleStatuses().find((s) => s.id === ID)).toMatchObject({
      installed: null,
      enabled: false,
      updatable: false,
      permissions: [],
    });
  });

  it('marks an installed module this build cannot run, rather than hiding it', () => {
    place(moduleDir(), { manifest: manifestText({ hostApi: 7 }) });
    expect(moduleStatuses().find((s) => s.id === ID)?.incompatible).toBe(
      'needs Tetravox host API 7'
    );
  });
});

describe('the manifest registration', () => {
  it('registers every installed manifest — consented or not — so a name is always available', () => {
    // Consent is checked where it bites (the protocol map, the job validator). Hiding the *name*
    // would only turn "installed but not enabled" into "no such module", which is a worse message.
    place(moduleDir());
    refreshInstalledManifests();
    expect(installedManifests().map((m) => m.id)).toEqual([ID]);
    expect(allManifests().some((m) => m.id === ID)).toBe(true);
  });

  it('drops a module from the registration when it is removed', () => {
    place(moduleDir());
    refreshInstalledManifests();
    removeModule(ID);
    expect(installedManifests()).toEqual([]);
  });

  it('pre-consents a bundled module at startup and serves it without a sheet', () => {
    place(bundledRoot());
    bootstrapInstalledModules();
    expect(consents()[ID]?.version).toBe('1.0.0');
    expect(servedModuleKeys()).toEqual([`${ID}/1.0.0/index.js`]);
  });

  it('does not pre-consent a user-installed module at startup', () => {
    place(moduleDir());
    bootstrapInstalledModules();
    expect(consents()[ID]).toBeUndefined();
    expect(servedModuleKeys()).toEqual([]);
    // …but it is registered, so a job naming it gets the honest message rather than "no such module".
    expect(installedManifests().map((m) => m.id)).toEqual([ID]);
  });
});

describe('a job naming an installed module (settled decision O4)', () => {
  const job = {
    scene: { files: ['/tmp/a.nii.gz'], preset: 'plain' },
    actions: [{ type: 'module', module: ID, op: 'run', args: {} }],
  };

  it('fails validation with an actionable message while the module is not enabled', () => {
    place(moduleDir());
    refreshInstalledManifests();
    const result = validateJob(job, allManifests(), isModuleConsented);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('installed but not enabled');
    expect(result.errors.join('\n')).toContain('File ▸ Extensions…');
  });

  it('passes once the user has consented', () => {
    place(moduleDir());
    expect(enableModule(ID).ok).toBe(true);
    expect(validateJob(job, allManifests(), isModuleConsented).ok).toBe(true);
  });

  it('still says "not a module this build carries" for a module nobody installed', () => {
    const result = validateJob(job, allManifests(), isModuleConsented);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('must be a module this build carries');
  });

  it('leaves a compiled-in module alone: the default gate consents to everything', () => {
    const compiled = {
      scene: { files: ['/tmp/a.nii.gz'], preset: 'plain' },
      actions: [{ type: 'module', module: 'tetravox.hello', op: 'noop', args: {} }],
    };
    // `tetravox.hello` declares no operations, so this fails on the *operation* — which is the point:
    // the consent gate never fired, because a compiled-in module is always runnable.
    const result = validateJob(compiled, allManifests(), isModuleConsented);
    expect(result.errors.join('\n')).not.toContain('installed but not enabled');
  });
});
