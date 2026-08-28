/**
 * `main/settings.ts`'s two coercions, and the difference between them.
 *
 * The whole point of this file is the bug that appears the moment a preference file has a **second**
 * key: a patch is not a settings object. `coerceSettings` fills every missing field with its
 * default, which is right for a file read off disk and catastrophic for a partial write — spread
 * over the existing settings it resets everything the caller did not mention. `coercePatch` keeps
 * absent keys absent, and `writeSettings` merges *that*.
 *
 * Nothing here touches the disk: `readSettings`/`writeSettings` need Electron's `app.getPath`, and
 * the round trip through a real profile directory is `e2e/theme.spec.ts`'s job. The coercions are
 * pure, and they are where the data loss would live.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, coercePatch, coerceSettings } from './settings';

describe('coerceSettings', () => {
  it('fills every field, because a file is a whole settings object', () => {
    expect(coerceSettings({ theme: 'dark' })).toEqual({
      theme: 'dark',
      freesurferSubjectsDir: '',
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
    });
    // …and what it would have been with `coerceSettings` on the patch: the theme, silently lost.
    expect(coerceSettings({ ...onDisk, ...coerceSettings(patch) }).theme).toBe('system');
  });

  it('accepts an empty directory, which is how the setting is cleared', () => {
    expect(coercePatch({ freesurferSubjectsDir: '' })).toEqual({ freesurferSubjectsDir: '' });
  });
});
