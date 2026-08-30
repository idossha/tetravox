/**
 * The rows of the §7.5 keyboard help sheet, **derived from `keymap.ts` rather than retyped**.
 *
 * Keyboard help (`keyboard/KeyboardHelp.tsx`) — rows generated
 * from `keymap.ts`, so a sheet can never list a binding the resolver does not implement.
 *
 * `keymap.ts` exports a *resolver*, not a table — so this module generates
 * the table by **asking the resolver**: it runs `resolveKey` over every candidate key and modifier
 * combination §7.5 mentions and keeps the ones that produce a `Command`. That is a stronger property
 * than a hand-written table beside a hand-written switch, in both directions:
 *
 *  * a row can only exist if `resolveKey` really returns that command for that chord — an unbound
 *    key silently drops out of the sheet instead of lying about it;
 *  * a *command* with no row at all is caught by `bindings.test.ts`, which asserts that every
 *    `Command['kind']` the resolver can return appears on the sheet. Adding a command to `keymap.ts`
 *    without a description therefore fails a test rather than shipping an incomplete sheet.
 *
 * **Pointer gestures are the one thing this cannot derive**: §7.5 puts them on the canvas and
 * `keymap.ts` correctly refuses to know about them ("`Shift+drag` is a pointer gesture on the canvas
 * and belongs to the engine"). They are listed separately, and labelled as engine gestures, so the
 * sheet is complete for a user without pretending to be generated where it is not.
 */

import type { Command } from './keymap';
import { PRESET_KEYS, resolveKey } from './keymap';
// Modules (2026-08-30, §13.5). Appended per the shared-file rule.
import type { ModuleManifest } from '../../../modules/manifest-types';
import { moduleChordLabel } from '../modules/keys';

export interface KeyBinding {
  /** What the user presses, e.g. `⌃↑` or `[`. */
  chord: string;
  /** What it does, in the contract's own words where possible. */
  description: string;
  /** The `Command` the resolver returned, so a test can check coverage by kind. */
  kind: Command['kind'];
}

export interface KeySection {
  title: string;
  bindings: KeyBinding[];
}

/** A `KeyEventLike` with no modifiers and no editable target. */
function chordEvent(
  key: string,
  modifier?: 'ctrl' | 'shift' | 'alt'
): Parameters<typeof resolveKey>[0] {
  return {
    key,
    ctrlKey: modifier === 'ctrl',
    metaKey: false,
    shiftKey: modifier === 'shift',
    altKey: modifier === 'alt',
    editable: false,
  };
}

/** Every chord §7.5 names, in the order the sheet reads best. `label` is what the user sees. */
const CANDIDATES: readonly {
  key: string;
  modifier?: 'ctrl' | 'shift' | 'alt';
  label: string;
  section: string;
  description: string;
}[] = [
  // Views and layout
  { key: 'r', label: 'r', section: 'View', description: 'Reset the active view to fit the scene' },
  { key: 'x', label: 'x', section: 'View', description: 'Cycle the layout' },
  {
    key: 'o',
    label: 'o',
    section: 'View',
    description: 'Toggle the 3D camera between perspective and orthographic',
  },
  { key: 'c', label: 'c', section: 'View', description: 'Toggle the crosshair' },
  {
    key: 'Home',
    label: 'Home',
    section: 'View',
    description:
      'Reset: refit every view, send the cursor to world (0, 0, 0), cancel any measurement in ' +
      'progress — layers and loaded datasets are untouched',
  },
  // Measurements (directed task 11)
  {
    key: 'm',
    label: 'm',
    section: 'Measure',
    description: 'Measure mode: two clicks in a pane give a length in mm, a third an angle',
  },
  {
    key: 'Escape',
    label: 'Esc',
    section: 'Measure',
    description: 'Cancel the measurement being placed',
  },
  {
    key: 'Backspace',
    modifier: 'shift' as const,
    label: '⇧⌫',
    section: 'Measure',
    description: 'Delete the most recently placed measurement (Clear all is in the panel)',
  },
  {
    key: 'Delete',
    modifier: 'shift' as const,
    label: '⇧Del',
    section: 'Measure',
    description: 'Delete the most recently placed measurement',
  },
  // Camera presets, one row per §7.5 `1..6`
  ...Object.entries(PRESET_KEYS).map(([key, preset]) => ({
    key,
    label: key,
    section: 'Camera presets',
    description: `3D camera preset ${preset}`,
  })),
  // Layers
  { key: '[', label: '[', section: 'Layers', description: 'Previous layer becomes active' },
  { key: ']', label: ']', section: 'Layers', description: 'Next layer becomes active' },
  { key: 'v', label: 'v', section: 'Layers', description: "Toggle the active layer's visibility" },
  {
    key: 'ArrowUp',
    modifier: 'ctrl' as const,
    label: '⌃↑',
    section: 'Layers',
    description: 'Move the active layer up the stack',
  },
  {
    key: 'ArrowDown',
    modifier: 'ctrl' as const,
    label: '⌃↓',
    section: 'Layers',
    description: 'Move the active layer down the stack',
  },
  {
    key: ',',
    label: ',',
    section: 'Layers',
    description: 'Previous 4D volume of the active volume layer',
  },
  {
    key: '.',
    label: '.',
    section: 'Layers',
    description: 'Next 4D volume of the active volume layer',
  },
  // Cursor
  {
    key: 'PageUp',
    label: 'PgUp',
    section: 'Cursor',
    description: 'Step one slice along the view normal',
  },
  {
    key: 'PageDown',
    label: 'PgDn',
    section: 'Cursor',
    description: 'Step back one slice along the view normal',
  },
  { key: 'ArrowUp', label: '↑', section: 'Cursor', description: 'Nudge the cursor' },
  { key: 'ArrowDown', label: '↓', section: 'Cursor', description: 'Nudge the cursor' },
  { key: 'ArrowRight', label: '→', section: 'Cursor', description: 'Nudge the cursor' },
  { key: 'ArrowLeft', label: '←', section: 'Cursor', description: 'Nudge the cursor' },
  // Panels (directed task: collapsible panels)
  {
    key: '[',
    modifier: 'ctrl' as const,
    label: '⌃[',
    section: 'Panels',
    description: 'Collapse/expand the left layer panel',
  },
  {
    key: ']',
    modifier: 'ctrl' as const,
    label: '⌃]',
    section: 'Panels',
    description: 'Collapse/expand the right info panel',
  },
];

/**
 * §7.5's pointer gestures. The engine binds these on the canvas (P2-01), so no resolver can be asked
 * about them; they carry `kind: null` so a coverage test cannot mistake them for generated rows.
 */
export interface PointerGesture {
  chord: string;
  description: string;
}

export const POINTER_GESTURES: readonly { title: string; gestures: PointerGesture[] }[] = [
  {
    title: '2D panes',
    gestures: [
      {
        chord: 'Left-click / drag',
        description: 'Move the crosshair to the point under the pointer',
      },
      { chord: 'Wheel', description: 'Step the slice ±1' },
      { chord: '⌘/Ctrl + wheel', description: 'Zoom about the pointer' },
      { chord: 'Right-drag', description: 'Window/level the active layer' },
      { chord: 'Middle-drag · Space + drag', description: 'Pan the pane — left-drag never pans' },
      { chord: 'Shift + drag', description: "Change the active layer's opacity" },
    ],
  },
  {
    title: '3D pane',
    gestures: [
      { chord: 'Left-drag', description: 'Orbit (arcball)' },
      { chord: 'Right-drag', description: 'Pan' },
      { chord: 'Wheel', description: 'Dolly' },
      { chord: 'Double-click', description: 'Pick, and move the cursor to the hit point' },
    ],
  },
];

/**
 * The generated sheet. Every row is a chord `resolveKey` really answers; a candidate the resolver
 * ignores produces no row at all.
 */
export function keyBindingSections(): KeySection[] {
  const sections = new Map<string, KeyBinding[]>();
  for (const candidate of CANDIDATES) {
    const command = resolveKey(chordEvent(candidate.key, candidate.modifier));
    if (command === null) continue;
    const rows = sections.get(candidate.section) ?? [];
    rows.push({ chord: candidate.label, description: candidate.description, kind: command.kind });
    sections.set(candidate.section, rows);
  }
  return [...sections].map(([title, bindings]) => ({ title, bindings }));
}

/** Flat view, for the coverage test and for the toolbar tooltip. */
export function keyBindings(): KeyBinding[] {
  return keyBindingSections().flatMap((s) => s.bindings);
}

/** Every command kind the sheet accounts for; `bindings.test.ts` checks it against `keymap.ts`. */
export function coveredCommandKinds(): Set<Command['kind']> {
  return new Set(keyBindings().map((b) => b.kind));
}

// -- Modules (2026-08-30, §13.5) -----------------------------------------------------------------

/**
 * One row of the help sheet's **Modules** tab.
 *
 * A second row source rather than a second `CANDIDATES` table, and it carries no `Command['kind']`
 * — exactly like {@link POINTER_GESTURES} — because a module's command is not a `Command` and
 * `bindings.test.ts`'s coverage assertion must not mistake one for the other. `keyBindings()` is
 * unchanged, so that test keeps meaning what it meant.
 *
 * These rows are **live only while their module is active**, which is why they are generated from a
 * manifest handed in rather than from a registry read here: the sheet shows what is bound *now*.
 */
export interface ModuleKeyRow {
  chord: string;
  description: string;
  /** Set when the binding needs a selection or an armed tool, so the sheet can say so. */
  when?: 'toolArmed' | 'selection';
}

const WHEN_NOTE: Record<'toolArmed' | 'selection', string> = {
  selection: ' — with a contact selected',
  toolArmed: ' — while the tool is armed',
};

/** The active module's chords, in manifest order. Empty for a module that binds no key. */
export function moduleKeyRows(manifest: ModuleManifest | null): ModuleKeyRow[] {
  if (manifest === null) return [];
  const rows: ModuleKeyRow[] = [];
  for (const command of manifest.commands) {
    if (command.key === undefined) continue;
    rows.push({
      chord: moduleChordLabel(command),
      description: `${command.title}${command.when === undefined ? '' : WHEN_NOTE[command.when]}`,
      ...(command.when === undefined ? {} : { when: command.when }),
    });
  }
  return rows;
}
