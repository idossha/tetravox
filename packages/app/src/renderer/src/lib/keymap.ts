/**
 * The §7.5 keyboard map, as a pure function from a key event to a command.
 *
 * §7.5, verbatim: "`r` reset view, `1..6` presets, `c` toggle crosshair, `x` cycle layout,
 * `o` orthographic, `[`/`]` cycle the active layer, `v` toggle the active layer's visibility,
 * `Shift+drag` its opacity, `Ctrl+↑/↓` reorder it, `,`/`.` step the active volume layer's 4D index",
 * plus 2D "arrows nudge the cursor; PgUp/PgDn slice".
 *
 * Resolution is separated from execution so the map is testable without an engine, a DOM or React.
 * `Shift+drag` is a pointer gesture on the canvas and belongs to the engine (§7.5), not here.
 *
 * `⌘O` is deliberately **absent**: the Electron application menu owns that accelerator (§8), and
 * binding it here too would open two dialogs.
 */

export type CameraPreset = 'A' | 'P' | 'L' | 'R' | 'S' | 'I';

export type Command =
  | { kind: 'cycleLayout' }
  | { kind: 'toggleCrosshair' }
  | { kind: 'resetView' }
  | { kind: 'cameraPreset'; preset: CameraPreset }
  | { kind: 'toggleOrthographic' }
  | { kind: 'cycleActiveLayer'; delta: -1 | 1 }
  | { kind: 'toggleActiveLayerVisible' }
  | { kind: 'reorderActiveLayer'; delta: -1 | 1 }
  | { kind: 'stepVolumeIndex'; delta: -1 | 1 }
  | { kind: 'stepCursor'; steps: -1 | 1 };

/** `1..6` → the §7.5 3D camera presets, in A/P/L/R/S/I order. */
export const PRESET_KEYS: Record<string, CameraPreset> = {
  '1': 'A',
  '2': 'P',
  '3': 'L',
  '4': 'R',
  '5': 'S',
  '6': 'I',
};

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** True when focus is in a text field — every shortcut is suppressed there. */
  editable: boolean;
}

/** True when the event target is a field the user could be typing a coordinate into. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function resolveKey(event: KeyEventLike): Command | null {
  if (event.editable) return null;
  // Anything with a platform modifier is a menu accelerator or a browser shortcut, except the one
  // §7.5 reserves: Ctrl+↑/↓ to reorder the active layer.
  const modified = event.ctrlKey || event.metaKey;

  if (modified) {
    if (event.altKey || event.shiftKey) return null;
    if (event.key === 'ArrowUp') return { kind: 'reorderActiveLayer', delta: 1 };
    if (event.key === 'ArrowDown') return { kind: 'reorderActiveLayer', delta: -1 };
    return null;
  }
  if (event.altKey) return null;

  const preset = PRESET_KEYS[event.key];
  if (preset !== undefined) return { kind: 'cameraPreset', preset };

  switch (event.key) {
    case 'r':
    case 'R':
      return { kind: 'resetView' };
    case 'c':
    case 'C':
      return { kind: 'toggleCrosshair' };
    case 'x':
    case 'X':
      return { kind: 'cycleLayout' };
    case 'o':
    case 'O':
      return { kind: 'toggleOrthographic' };
    case '[':
      return { kind: 'cycleActiveLayer', delta: -1 };
    case ']':
      return { kind: 'cycleActiveLayer', delta: 1 };
    case 'v':
    case 'V':
      return { kind: 'toggleActiveLayerVisible' };
    case ',':
      return { kind: 'stepVolumeIndex', delta: -1 };
    case '.':
      return { kind: 'stepVolumeIndex', delta: 1 };
    case 'PageUp':
    case 'ArrowUp':
    case 'ArrowRight':
      return { kind: 'stepCursor', steps: 1 };
    case 'PageDown':
    case 'ArrowDown':
    case 'ArrowLeft':
      return { kind: 'stepCursor', steps: -1 };
    default:
      return null;
  }
}

/** One-line help, shown in the toolbar's title attribute so the map is discoverable. */
export const KEYMAP_HELP =
  '[ / ] active layer · v visibility · Ctrl+↑/↓ reorder · x layout · c crosshair · ' +
  'r reset · 1–6 A/P/L/R/S/I · o orthographic · , / . 4D index · ↑↓←→ PgUp/PgDn slice';
