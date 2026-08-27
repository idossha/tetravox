/**
 * The §7.5 keyboard map, as a pure function from a key event to a command.
 *
 * §7.5, verbatim: "`r` reset view, `1..6` presets, `c` toggle crosshair, `x` cycle layout,
 * `o` orthographic, `[`/`]` cycle the active layer, `v` toggle the active layer's visibility,
 * `Shift+drag` its opacity, `Ctrl+↑/↓` reorder it, `,`/`.` step the active volume layer's 4D index",
 * plus 2D "arrows nudge the cursor; PgUp/PgDn slice".
 *
 * Resolution is separated from execution so the map is testable without an engine, a DOM or React.
 *
 * **The pointer gestures are the engine's, and so are three keys.** `packages/engine/src/input/`
 * binds `pointerdown`/`move`/`up`/`wheel` on the canvas itself (P2-01), and with them `+` / `-`
 * (zoom the pane **under the pointer**) and `space` (the pan modifier) — R2 and R3 scope those to a
 * pane, and only the engine knows which pane the pointer is in. `r` is bound in both places and is
 * idempotent: the engine resets the hovered pane, this map resets the active one, and when the
 * pointer is over the active pane they are the same call twice. {@link KEYMAP_HELP} lists the
 * gestures so §8's keyboard help sheet can show the whole §7.5 surface in one place.
 *
 * §7.2 counts key repeat as an interaction. A host that wants `interacting` to cover the keyboard
 * calls `engine.noteInput()` alongside `runCommand`; the pointer layer does it for itself.
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
  | { kind: 'stepCursor'; steps: -1 | 1 }
  /**
   * §7.5's "arrows nudge the cursor" — **in the pane's plane**, not along its normal (P2-09).
   *
   * `dx` is along the pane's `right` and `dy` along its `up`, both in ±1 steps; the engine owns the
   * basis (`Engine.nudgeCursor`), because §8 forbids the app computing it.
   */
  | { kind: 'nudgeCursor'; dx: -1 | 0 | 1; dy: -1 | 0 | 1 };

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
    // §7.5 lists two bindings, and they are two: PgUp/PgDn steps the **slice** (along the plane
    // normal), the arrows nudge the cursor **in the plane**. Phase 1 gave all six keys to
    // `stepCursor`, so pressing the right arrow in the axial pane changed the axial slice.
    case 'PageUp':
      return { kind: 'stepCursor', steps: 1 };
    case 'PageDown':
      return { kind: 'stepCursor', steps: -1 };
    case 'ArrowRight':
      return { kind: 'nudgeCursor', dx: 1, dy: 0 };
    case 'ArrowLeft':
      return { kind: 'nudgeCursor', dx: -1, dy: 0 };
    case 'ArrowUp':
      return { kind: 'nudgeCursor', dx: 0, dy: 1 };
    case 'ArrowDown':
      return { kind: 'nudgeCursor', dx: 0, dy: -1 };
    default:
      return null;
  }
}

/** One-line help, shown in the toolbar's title attribute so the map is discoverable. */
export const KEYMAP_HELP =
  '[ / ] active layer · v visibility · Ctrl+↑/↓ reorder · x layout · c crosshair · ' +
  'r reset · 1–6 A/P/L/R/S/I · o orthographic · , / . 4D index · ' +
  '↑↓←→ nudge the cursor in-plane · PgUp/PgDn slice';

/**
 * The §7.5 **pointer** bindings, for the same help sheet. Handled in the engine's input layer, so
 * they are listed rather than resolved here.
 */
export const POINTER_HELP =
  '2D: left click/drag cursor · wheel slice · ⌘/Ctrl+wheel or pinch zoom about the pointer · ' +
  '+ / − zoom · r fit · middle-drag, space+drag or two-finger drag pan · right-drag window/level · ' +
  'Shift+drag opacity — 3D: left orbit · right pan · wheel dolly · double-click pick';
