/**
 * Module key resolution — what a key means *after* the §7.5 map has declined it (§13.5).
 *
 * Three keydown listeners share this window and the order between them is the whole design:
 *
 *  1. the **engine**, on the canvas, which owns Space, `Esc`, `+`/`=`, `-`/`_` and `r` because only
 *     it knows which pane the pointer is in;
 *  2. the **core map** (`keyboard/keymap.ts`), asked first in `Shell.tsx`;
 *  3. **this**, asked only when the core map returned `null`, and only while a module is active.
 *
 * So a module can never shadow a documented binding, and adding a module can never change what any
 * key already does. `modules.test.ts` proves the other half — that every key in the pool really is
 * one the core map declines — by probing the live resolver rather than by reading this comment.
 *
 * Pure: no store, no controller, no DOM. `ShellController.handleModuleKey` is the dispatch.
 */

import { MODULE_KEY_POOL } from '../../../modules/manifest-types';
import type { ModuleCommand, ModuleKey, ModuleManifest } from '../../../modules/manifest-types';

/** The same shape `keymap.ts`'s `KeyEventLike` has, so `Shell.tsx` builds one object for both. */
export interface ModuleKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** True when focus is in a text field — every binding is suppressed there, module ones included. */
  editable: boolean;
}

/** What the module can currently act on, for the `when` gate. */
export interface ModuleKeyContext {
  hasSelection: boolean;
  toolArmed: boolean;
}

const POOL: ReadonlySet<string> = new Set<string>(MODULE_KEY_POOL);

/**
 * `'Z'` with Shift held is the `z` binding's shifted form, not a different key.
 *
 * The browser reports the shifted character in `event.key`, so a resolver that compared it to the
 * manifest's `'z'` would never match `Shift+Z`. Named keys (`Delete`, `Backspace`) are left alone.
 */
function normalise(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * The module command this chord runs, or null.
 *
 * Null for: a text field, any platform or Alt modifier, a key outside §13.5's pool, a key the
 * manifest does not bind, a Shift state that does not match the binding, and a `when` gate that is
 * not satisfied. `Escape` can never reach here — it is outside the pool — which matters because
 * `keymap.ts` returns `cancelMeasurement` for it unconditionally and `Shell.tsx` preventDefaults it,
 * so "core first, module on null" could not deliver it even if the pool allowed it.
 */
export function resolveModuleKey(
  manifest: ModuleManifest,
  event: ModuleKeyEvent,
  context: ModuleKeyContext
): ModuleCommand | null {
  if (event.editable) return null;
  // A platform modifier is a menu accelerator (`keymap.ts` reserves every ctrl/meta chord to the
  // native menu), and Alt is nothing's.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = normalise(event.key);
  if (!POOL.has(key)) return null;
  for (const command of manifest.commands) {
    if (command.key === undefined || (command.key as ModuleKey) !== key) continue;
    if ((command.shift ?? false) !== event.shiftKey) continue;
    if (command.when === 'selection' && !context.hasSelection) continue;
    if (command.when === 'toolArmed' && !context.toolArmed) continue;
    return command;
  }
  return null;
}

/** How a chord is written on the help sheet and in the panel's tooltips: `g`, `⇧S`, `⌫`. */
export function moduleChordLabel(command: ModuleCommand): string {
  if (command.key === undefined) return '';
  const key =
    command.key === 'Backspace'
      ? '⌫'
      : command.key === 'Delete'
        ? 'Del'
        : command.shift === true
          ? command.key.toUpperCase()
          : command.key;
  return `${command.shift === true ? '⇧' : ''}${key}`;
}
