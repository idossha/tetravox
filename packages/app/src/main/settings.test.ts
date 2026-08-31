/**
 * `main/settings.ts`'s two coercions, and the difference between them.
 *
 * The whole point of this file is the bug that appears the moment a preference file has a **second**
 * key: a patch is not a settings object. `coerceSettings` fills every missing field with its
 * default, which is right for a file read off disk and catastrophic for a partial write — spread
 * over the existing settings it resets everything the caller did not mention. `coercePatch` keeps
 * absent keys absent, and `writeSettings` merges *that*.
 *
 * Most of this file touches no disk: `readSettings`/`writeSettings` need Electron's `app.getPath`,
 * and the full round trip through a real profile directory is `e2e/theme.spec.ts`'s job. The
 * coercions are pure, and they are where the data loss would live.
 *
 * The `tetravoxrc` precedence tests at the bottom are the exception — they exercise `readSettings`
 * for real, against a temp directory. `app.getPath('userData')` is mocked (there is no real
 * Electron process under vitest's `node` environment) and `TETRAVOX_HOME` is set to the same temp
 * dir per directed task's ask, so `settings.json` and `tetravoxrc` both land somewhere this test
 * owns and cleans up, never `~/.tetravox`.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => process.env['TETRAVOX_TEST_USERDATA'] ?? tmpdir() },
}));

import {
  DEFAULT_SCREENSHOT_DEFAULTS,
  DEFAULT_SETTINGS,
  MAX_RECENT_SCENES,
  coercePatch,
  coerceSettings,
  configPath,
  ensureRcFile,
  rcPath,
  readSettings,
  writeSettings,
  writeSettingsFromRenderer,
} from './settings';

/**
 * A temp `TETRAVOX_HOME` **and** `userData`, so `tetravoxrc` and `settings.json` both land somewhere
 * this file owns. Module-scope since 2026-08-30: the extensions block below needs the same seam.
 */
function withTempHome<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'tvx-settings-'));
  const prevHome = process.env['TETRAVOX_HOME'];
  const prevUserData = process.env['TETRAVOX_TEST_USERDATA'];
  process.env['TETRAVOX_HOME'] = dir;
  process.env['TETRAVOX_TEST_USERDATA'] = dir;
  try {
    return fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env['TETRAVOX_HOME'];
    else process.env['TETRAVOX_HOME'] = prevHome;
    if (prevUserData === undefined) delete process.env['TETRAVOX_TEST_USERDATA'];
    else process.env['TETRAVOX_TEST_USERDATA'] = prevUserData;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('coerceSettings', () => {
  it('fills every field, because a file is a whole settings object', () => {
    expect(coerceSettings({ theme: 'dark' })).toEqual({
      theme: 'dark',
      freesurferSubjectsDir: '',
      recentScenes: [],
      reopenLastScene: false,
      screenshotDefaults: DEFAULT_SCREENSHOT_DEFAULTS,
      extensions: {},
    });
  });

  it.each([
    ['null', null],
    ['a string', 'dark'],
    ['a number', 7],
    ['an unknown key', { colourScheme: 'dark' }],
    ['a theme that is not one of the three', { theme: 'solarized' }],
    ['a directory of the wrong type', { freesurferSubjectsDir: 42 }],
  ])('degrades %s to the defaults rather than throwing', (_name, raw) => {
    // A preference file is not a place to throw: the worst outcome of a corrupt one must be the app
    // opening in the default theme, never the app not opening.
    expect(coerceSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('coercePatch', () => {
  it('keeps absent keys absent — this is the whole reason it exists', () => {
    expect(coercePatch({ freesurferSubjectsDir: '/opt/freesurfer/subjects' })).toEqual({
      freesurferSubjectsDir: '/opt/freesurfer/subjects',
    });
    expect(coercePatch({ theme: 'light' })).toEqual({ theme: 'light' });
    expect(coercePatch({})).toEqual({});
  });

  it('drops a field of the wrong type instead of defaulting it', () => {
    // Defaulting would be indistinguishable from the user asking for the default, and
    // `writeSettings` would then persist a reset the caller never requested.
    expect(coercePatch({ theme: 'solarized', freesurferSubjectsDir: 7 })).toEqual({});
  });

  it('is what keeps a second key from resetting the first', () => {
    // The bug, written out: this is the expression `writeSettings` evaluates.
    const onDisk = { theme: 'dark' as const, freesurferSubjectsDir: '' };
    const patch = { freesurferSubjectsDir: '/opt/fs/subjects' };
    expect(coerceSettings({ ...onDisk, ...coercePatch(patch) })).toEqual({
      theme: 'dark',
      freesurferSubjectsDir: '/opt/fs/subjects',
      recentScenes: [],
      reopenLastScene: false,
      screenshotDefaults: DEFAULT_SCREENSHOT_DEFAULTS,
      extensions: {},
    });
    // …and what it would have been with `coerceSettings` on the patch: the theme, silently lost.
    expect(coerceSettings({ ...onDisk, ...coerceSettings(patch) }).theme).toBe('system');
  });

  it('accepts an empty directory, which is how the setting is cleared', () => {
    expect(coercePatch({ freesurferSubjectsDir: '' })).toEqual({ freesurferSubjectsDir: '' });
  });
});

/**
 * File ▸ Open Recent's list (directed task 13). The coercion is where the invariants live — most
 * recent first, no duplicates, at most ten — because `rememberRecentScene` is `dedupe` plus a write,
 * and the write needs Electron's `app.getPath`.
 */
describe('recentScenes', () => {
  it('defaults to an empty list and to not reopening anything', () => {
    expect(DEFAULT_SETTINGS.recentScenes).toEqual([]);
    expect(DEFAULT_SETTINGS.reopenLastScene).toBe(false);
  });

  it('drops duplicates, keeping the first (most recent) occurrence', () => {
    const patch = coercePatch({
      recentScenes: ['/a.tetravox.json', '/b.tetravox.json', '/a.tetravox.json'],
    });
    expect(patch.recentScenes).toEqual(['/a.tetravox.json', '/b.tetravox.json']);
  });

  it(`keeps at most ${MAX_RECENT_SCENES}`, () => {
    const many = Array.from({ length: 25 }, (_v, i) => `/scene-${i}.tetravox.json`);
    expect(coercePatch({ recentScenes: many }).recentScenes).toHaveLength(MAX_RECENT_SCENES);
    expect(coercePatch({ recentScenes: many }).recentScenes?.[0]).toBe('/scene-0.tetravox.json');
  });

  it('ignores entries that are not non-empty strings rather than failing the read', () => {
    expect(coercePatch({ recentScenes: ['/a.tetravox.json', 42, '', null] }).recentScenes).toEqual([
      '/a.tetravox.json',
    ]);
  });

  it('ignores a list that is not a list, and a switch that is not a boolean', () => {
    expect(coercePatch({ recentScenes: 'nope' })).toEqual({});
    expect(coercePatch({ reopenLastScene: 'yes' })).toEqual({});
    expect(coercePatch({ reopenLastScene: true })).toEqual({ reopenLastScene: true });
  });

  it('does not reset the recents when another key is written — the `coercePatch` rule again', () => {
    const onDisk = coerceSettings({ recentScenes: ['/a.tetravox.json'], theme: 'dark' });
    const merged = coerceSettings({ ...onDisk, ...coercePatch({ freesurferSubjectsDir: '/fs' }) });
    expect(merged.recentScenes).toEqual(['/a.tetravox.json']);
    expect(merged.theme).toBe('dark');
  });
});

/** §4.7's screenshot defaults, coerced the same defensive way as everything else in this file. */
describe('screenshotDefaults coercion', () => {
  it('accepts a whole valid object', () => {
    expect(
      coercePatch({ screenshotDefaults: { background: 'white', dpi: 300, autoTrim: true } })
    ).toEqual({ screenshotDefaults: { background: 'white', dpi: 300, autoTrim: true } });
  });

  it('fills the fields it did not see with the screenshot defaults, not the whole-settings ones', () => {
    expect(coercePatch({ screenshotDefaults: { dpi: 600 } })).toEqual({
      screenshotDefaults: { ...DEFAULT_SCREENSHOT_DEFAULTS, dpi: 600 },
    });
  });

  it('drops the whole field rather than throwing on a bad shape', () => {
    expect(coercePatch({ screenshotDefaults: 'nope' })).toEqual({});
    expect(coercePatch({ screenshotDefaults: null })).toEqual({});
  });

  it('drops individual bad fields — a wrong background, a non-positive dpi, a non-boolean autoTrim', () => {
    expect(coercePatch({ screenshotDefaults: { background: 'plaid' } })).toEqual({});
    expect(coercePatch({ screenshotDefaults: { dpi: -5 } })).toEqual({});
    expect(coercePatch({ screenshotDefaults: { dpi: 0 } })).toEqual({});
    expect(coercePatch({ screenshotDefaults: { autoTrim: 'yes' } })).toEqual({});
  });

  it('accepts an optional scale, and drops it when absent or bad', () => {
    expect(coercePatch({ screenshotDefaults: { scale: 2 } })).toEqual({
      screenshotDefaults: { ...DEFAULT_SCREENSHOT_DEFAULTS, scale: 2 },
    });
    expect(coercePatch({ screenshotDefaults: { background: 'white', scale: -1 } })).toEqual({
      screenshotDefaults: { ...DEFAULT_SCREENSHOT_DEFAULTS, background: 'white' },
    });
  });

  it('is the field `DEFAULT_SETTINGS` carries', () => {
    expect(DEFAULT_SETTINGS.screenshotDefaults).toEqual(DEFAULT_SCREENSHOT_DEFAULTS);
  });
});

/**
 * `tetravoxrc` precedence (directed task: unified settings, 2026-08-28): hardcoded defaults <
 * `tetravoxrc` < `settings.json`. Real `fs`, a real temp directory for both files, `app.getPath`
 * mocked at the top of this file.
 */
describe('tetravoxrc precedence', () => {
  it('degrades to the hardcoded defaults when neither file exists', () => {
    withTempHome(() => {
      expect(readSettings()).toEqual(DEFAULT_SETTINGS);
    });
  });

  it('ensureRcFile creates a starter file once, and never overwrites it again', () => {
    withTempHome((dir) => {
      ensureRcFile();
      const first = JSON.parse(readFileSync(rcPath(), 'utf8')) as { _comment?: unknown };
      expect(typeof first._comment).toBe('string');
      expect(configPath()).toBe(rcPath());
      expect(rcPath()).toBe(join(dir, 'tetravoxrc'));

      writeFileSync(rcPath(), JSON.stringify({ theme: 'dark' }), 'utf8');
      ensureRcFile();
      expect(readSettings().theme).toBe('dark');
    });
  });

  it('tetravoxrc sets a default that settings.json has never mentioned', () => {
    withTempHome(() => {
      writeFileSync(rcPath(), JSON.stringify({ freesurferSubjectsDir: '/rc/subjects' }), 'utf8');
      expect(readSettings().freesurferSubjectsDir).toBe('/rc/subjects');
    });
  });

  it('settings.json wins over tetravoxrc for the same key', () => {
    withTempHome(() => {
      writeFileSync(rcPath(), JSON.stringify({ theme: 'dark' }), 'utf8');
      writeSettings({ theme: 'light' });
      expect(readSettings().theme).toBe('light');
    });
  });

  it('a corrupt tetravoxrc degrades to the defaults silently, never throws', () => {
    withTempHome(() => {
      writeFileSync(rcPath(), '{ not json', 'utf8');
      expect(() => readSettings()).not.toThrow();
      expect(readSettings()).toEqual(DEFAULT_SETTINGS);
    });
  });

  it('rc and settings.json compose field-by-field rather than one replacing the other', () => {
    withTempHome(() => {
      writeFileSync(rcPath(), JSON.stringify({ theme: 'dark' }), 'utf8');
      writeSettings({ freesurferSubjectsDir: '/opt/fs/subjects' });
      const settings = readSettings();
      expect(settings.theme).toBe('dark');
      expect(settings.freesurferSubjectsDir).toBe('/opt/fs/subjects');
    });
  });
});

/**
 * `extensions` — the consent record (§13, downloadable extensions, 2026-08-30).
 *
 * The one key here whose coercion is a **security** property rather than a preference. Every other
 * field degrades to a default when it is corrupt; this one degrades to *absent*, because a filled-in
 * default would be a capability nobody confirmed. The tests below are all one assertion in different
 * clothes: a record that is not exactly what `enableModule` wrote is a module that is not enabled.
 */
describe('the extensions consent record', () => {
  const good = {
    version: '1.0.0',
    hostApi: 1,
    grantedAt: '2026-08-30T12:00:00.000Z',
    permissions: ['Read .tsv files you choose'],
  };

  it('is empty by default, so a fresh profile consents to nothing', () => {
    expect(DEFAULT_SETTINGS.extensions).toEqual({});
    expect(coerceSettings({}).extensions).toEqual({});
  });

  it('round-trips a well-formed grant', () => {
    expect(coercePatch({ extensions: { 'tetravox.seeg': good } })).toEqual({
      extensions: { 'tetravox.seeg': good },
    });
  });

  it.each([
    ['no version', { ...good, version: undefined }],
    ['an empty version', { ...good, version: '' }],
    ['a non-integer hostApi', { ...good, hostApi: 1.5 }],
    ['a string hostApi', { ...good, hostApi: '1' }],
    ['no grantedAt', { ...good, grantedAt: undefined }],
    ['permissions that are not a list', { ...good, permissions: 'everything' }],
    ['a whole entry that is not an object', 'yes'],
    ['a null entry', null],
  ])('drops an entry with %s rather than repairing it', (_name, entry) => {
    const patch = coercePatch({ extensions: { 'tetravox.seeg': entry } });
    expect(patch.extensions).toEqual({});
  });

  it('drops an id that is not `<vendor>.<name>`, so a key cannot be a path or a wildcard', () => {
    const patch = coercePatch({
      extensions: { '../../etc': good, '*': good, Tetravox: good, 'tetravox.ok': good },
    });
    expect(Object.keys(patch.extensions ?? {})).toEqual(['tetravox.ok']);
  });

  it('drops a non-string permission and caps the list, because it is a label, not a payload', () => {
    const patch = coercePatch({
      extensions: {
        'tetravox.seeg': { ...good, permissions: ['read', 7, null, ...Array(64).fill('write')] },
      },
    });
    const permissions = patch.extensions?.['tetravox.seeg']?.permissions ?? [];
    expect(permissions.length).toBe(32);
    expect(permissions[0]).toBe('read');
    expect(permissions.every((p) => typeof p === 'string')).toBe(true);
  });

  it('is absent from a patch that does not mention it, so a theme write cannot revoke a consent', () => {
    // The `coercePatch` rule, stated where it bites hardest: `writeSettings({ theme: 'dark' })`
    // must not be able to disable every installed module as a side effect.
    expect(coercePatch({ theme: 'dark' })).toEqual({ theme: 'dark' });
    expect('extensions' in coercePatch({ theme: 'dark' })).toBe(false);
  });

  it('survives a round trip through the real settings file', () => {
    withTempHome(() => {
      writeSettings({ extensions: { 'tetravox.seeg': good } });
      writeSettings({ theme: 'dark' });
      const settings = readSettings();
      expect(settings.theme).toBe('dark');
      expect(settings.extensions['tetravox.seeg']).toEqual(good);
    });
  });

  it('cannot be authored from the renderer settings channel — `writeSettingsFromRenderer` strips it', () => {
    withTempHome(() => {
      const forged = {
        'acme.tool': {
          version: '9.9.9',
          hostApi: 1,
          grantedAt: '2026-08-31T00:00:00.000Z',
          permissions: ['Read everything'],
        },
      };
      // The renderer channel drops `extensions`: a hostile in-renderer script's forged grant never
      // lands, while a real preference in the same patch still does (finding, 2026-08-31).
      const after = writeSettingsFromRenderer({ theme: 'dark', extensions: forged });
      expect(after.theme).toBe('dark');
      expect(after.extensions).toEqual({});

      // Why the channel is gated rather than trusting the shape check: `writeSettings` itself — the
      // path `grantConsent`/`dropConsent` use internally — *would* persist the forged record.
      expect(writeSettings({ extensions: forged }).extensions['acme.tool']).toBeDefined();
    });
  });
});
