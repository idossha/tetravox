/**
 * The help sheet cannot lie about the key map, in either direction.
 *
 * Rows are "generated from `keymap.ts`, so a sheet can never
 * list a binding the resolver does not implement". `bindings.ts` gets that by construction — it
 * *asks* `resolveKey` — so the interesting failures are the two this file pins:
 *
 *  1. **A row for a chord the resolver ignores.** Impossible by construction, and asserted anyway by
 *     re-resolving every published row: if `keymap.ts` drops a binding, its row disappears rather
 *     than going stale, and this test proves the row that survives still resolves.
 *  2. **A command with no row at all.** That one *is* possible: E-SCENE adds a `Command` kind to
 *     `keymap.ts`, `bindings.ts` has no candidate for it, and the sheet quietly omits a shortcut the
 *     app implements. The coverage assertion below is what turns that into a failing test.
 */

import { describe, expect, it } from 'vitest';
import type { Command } from './keymap';
import { PRESET_KEYS, resolveKey } from './keymap';
import {
  POINTER_GESTURES,
  coveredCommandKinds,
  keyBindingSections,
  keyBindings,
  moduleKeyRows,
} from './bindings';
// Modules (2026-08-30, §13.5), appended.
import { MANIFESTS } from '../../../modules/manifests';
import { helloManifest } from '../../../modules/hello/manifest';

/**
 * Every `Command['kind']` the resolver can return, discovered by driving it rather than by
 * duplicating the union — a hand-written list here would be the second source of truth this whole
 * module exists to avoid. The key space is finite and small: printable ASCII plus the named keys
 * §7.5 mentions, with and without each single modifier.
 */
function reachableCommandKinds(): Set<Command['kind']> {
  const named = [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'PageUp',
    'PageDown',
    'Home',
    'End',
    'Enter',
    'Escape',
    ' ',
    'Tab',
    'Delete',
    'Backspace',
    'F1',
  ];
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
  const kinds = new Set<Command['kind']>();
  for (const key of [...printable, ...named]) {
    for (const modifier of ['none', 'ctrl', 'meta', 'shift', 'alt'] as const) {
      const command = resolveKey({
        key,
        ctrlKey: modifier === 'ctrl',
        metaKey: modifier === 'meta',
        shiftKey: modifier === 'shift',
        altKey: modifier === 'alt',
        editable: false,
      });
      if (command !== null) kinds.add(command.kind);
    }
  }
  return kinds;
}

describe('the generated key sheet', () => {
  it('lists every command the resolver can reach', () => {
    const reachable = [...reachableCommandKinds()].sort();
    const covered = [...coveredCommandKinds()].sort();
    expect(covered).toEqual(reachable);
  });

  it('publishes no row for a chord the resolver does not answer', () => {
    // Re-resolving is not circular: the rows were built from *candidates*, and this asserts that
    // each surviving row's `kind` is still what the resolver returns for something.
    const kinds = reachableCommandKinds();
    for (const binding of keyBindings()) {
      expect(kinds.has(binding.kind)).toBe(true);
    }
  });

  it('gives every row a chord and a description', () => {
    for (const binding of keyBindings()) {
      expect(binding.chord.length).toBeGreaterThan(0);
      expect(binding.description.length).toBeGreaterThan(0);
    }
  });

  it('has one row per §7.5 camera preset', () => {
    const presets = keyBindingSections().find((s) => s.title === 'Camera presets');
    expect(presets?.bindings).toHaveLength(Object.keys(PRESET_KEYS).length);
    expect(presets?.bindings.every((b) => b.kind === 'cameraPreset')).toBe(true);
  });

  it('separates the two arrow meanings §7.5 lists separately', () => {
    const cursor = keyBindingSections().find((s) => s.title === 'Cursor');
    expect(cursor?.bindings.map((b) => b.chord)).toEqual(['PgUp', 'PgDn', '↑', '↓', '→', '←']);
  });

  it('groups the rows without losing any of them', () => {
    const grouped = keyBindingSections().reduce((n, s) => n + s.bindings.length, 0);
    expect(grouped).toBe(keyBindings().length);
    expect(new Set(keyBindingSections().map((s) => s.title)).size).toBe(
      keyBindingSections().length
    );
  });
});

describe('the pointer gestures', () => {
  it('carry §7.5’s canvas bindings, which no resolver can be asked about', () => {
    const chords = POINTER_GESTURES.flatMap((g) => g.gestures.map((x) => x.chord));
    // R1/R3's two headline gestures, and the one a user is least likely to guess.
    expect(chords).toContain('Left-click / drag');
    expect(chords).toContain('Middle-drag · Space + drag');
    expect(chords).toContain('Shift + drag');
  });

  it('says left-drag moves the crosshair and never the scan (R3)', () => {
    const gestures = POINTER_GESTURES.flatMap((g) => g.gestures);
    expect(gestures.find((g) => g.chord === 'Left-click / drag')?.description).toContain(
      'crosshair'
    );
    expect(gestures.find((g) => g.chord.startsWith('Middle-drag'))?.description).toContain(
      'never pans'
    );
  });
});

// -- Modules (2026-08-30, §13.5) -----------------------------------------------------------------

describe('the Modules rows', () => {
  it('are empty with no module active, so the sheet grows no tab', () => {
    expect(moduleKeyRows(null)).toEqual([]);
  });

  it('carry one row per bound key, in manifest order, labelled the way a user presses it', () => {
    const rows = moduleKeyRows(helloManifest);
    const bound = helloManifest.commands.filter((c) => c.key !== undefined);
    expect(rows).toHaveLength(bound.length);
    expect(rows.map((r) => r.chord)).toEqual(['g', 's']);
    expect(rows[0]?.description).toBe('Ping');
  });

  it('say when a binding needs a selection, rather than listing it as always live', () => {
    const rows = moduleKeyRows(helloManifest);
    const gated = rows.find((r) => r.when === 'selection');
    expect(gated?.description).toContain('selected');
  });

  it('never claim a `Command` kind, so the coverage assertion above still means what it meant', () => {
    // `POINTER_GESTURES` carries none for the same reason: a row that is not a §7.5 binding must not
    // be able to satisfy "every command the resolver can reach has a row".
    for (const manifest of MANIFESTS) {
      for (const row of moduleKeyRows(manifest)) {
        expect('kind' in row).toBe(false);
      }
    }
  });
});
