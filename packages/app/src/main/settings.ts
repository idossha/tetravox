/**
 * App settings — `settings.json` in Electron's `userData` directory (directed task 9, 2026-08-28).
 *
 * The first *preference* the app has ever had, and deliberately the smallest thing that can hold
 * one. It is main's job rather than the renderer's for two reasons:
 *
 *  * `localStorage` is per **profile directory**, and every E2E launch gets a fresh
 *    `--user-data-dir` (`e2e/fixtures.ts`) precisely so two runs cannot collide over the
 *    single-instance lock. A preference kept there could never be tested across a relaunch without
 *    giving that up. A file main reads and writes can be tested by pointing two launches at one
 *    profile, which is what `e2e/theme.spec.ts` does.
 *  * §5 keeps the filesystem in main. The renderer asking for a value is one small JSON round trip,
 *    which is exactly what the preload bridge is for.
 *
 * Every read is defensive: a missing file, unreadable JSON, a value of the wrong type or a key
 * nobody recognises all degrade to the default. A preference file is not a place to throw — the
 * worst outcome of a corrupt one must be the app opening in the default theme, never the app not
 * opening.
 */

import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Everything the app persists. One key today; the shape is the point. */
export interface AppSettings {
  /** §8's theme switch: what the user picked, not what it resolved to. */
  theme: 'system' | 'light' | 'dark';
}

export const DEFAULT_SETTINGS: AppSettings = { theme: 'system' };

/** A settings file is a preference, not a document: a megabyte of it is a bug or an attack. */
const MAX_BYTES = 64 * 1024;

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/** Coerce whatever was on disk into an `AppSettings`, one field at a time. */
export function coerceSettings(raw: unknown): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  if (raw === null || typeof raw !== 'object') return out;
  const theme = (raw as Record<string, unknown>)['theme'];
  if (theme === 'system' || theme === 'light' || theme === 'dark') out.theme = theme;
  return out;
}

export function readSettings(): AppSettings {
  try {
    const text = readFileSync(settingsPath(), 'utf8');
    if (text.length > MAX_BYTES) return { ...DEFAULT_SETTINGS };
    return coerceSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Merge a patch over what is on disk and write it back; returns the settings as they now stand.
 *
 * Read-modify-write rather than write-whole so a second window (or a later key) cannot clobber a
 * field it did not know about. Returning the merged value means the renderer never has to guess
 * whether its write landed.
 */
export function writeSettings(patch: unknown): AppSettings {
  const next = coerceSettings({ ...readSettings(), ...coerceSettings(patch) });
  try {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // A preference that cannot be written is not worth failing a launch over; the value still
    // applies to this session and the next one simply starts at the default.
  }
  return next;
}
