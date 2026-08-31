/**
 * A module in its own OS window (ARCHITECTURE.md §13.10).
 *
 * **The module does not move.** `window.open('', name)` from the renderer gives a same-origin popup
 * that Chromium keeps in *this* renderer process and this JS realm, so the panel is rendered by the
 * same React root, out of the same instance, over the same `ModuleHost` — `createPortal` is the
 * whole mechanism. Nothing about §13.1's synchronous host changes, which is the reason this is a
 * hundred lines rather than the async host rewrite §13.9 prices at stage 3.
 *
 * What that buys, and why the feature exists at all:
 *
 *  * **several modules at once** — the slot is one section of one column, so it can hold one editor;
 *    a window is its own surface and can hold any number of them, on any number of monitors;
 *  * **real estate** — a module whose panel wants 900 px (a time-domain trace, a table of a thousand
 *    contacts) is unusable in a 20 rem aside and fine in a window;
 *  * **no second instance** — the alternative, a second `BrowserWindow` with its own renderer, needs
 *    a second `activate()` over the same scene. Two contact editors over one electrodes table is a
 *    merge conflict, not a feature.
 *
 * Three details are load-bearing and each one is a bug if it is dropped:
 *
 *  1. **The stylesheets are copied, not linked.** A popup document starts empty; Tailwind's emitted
 *     `<style>` (dev) and `<link rel=stylesheet>` (packaged) live in the opener's head, and a portal
 *     moves DOM, never CSS. Every node is cloned across, and in dev a `MutationObserver` on the
 *     opener's head keeps them in step so HMR does not leave the popup unstyled.
 *  2. **`data-theme` and the `dark` class are mirrored.** The theme is an attribute on the opener's
 *     `<html>`; the popup has its own, and a theme switch has to reach both or the popped-out module
 *     stays in yesterday's palette.
 *  3. **The popup owns its keystrokes.** A key event in the popup never reaches the opener's window
 *     listener, so this component installs the same `handleModuleKey` dispatch on the popup document
 *     with its own module's id. That is also what makes concurrency well-defined: a keystroke has
 *     exactly one target document, so two live modules can never both claim one.
 *
 * A user closing the window re-docks rather than unloading — the same rule as everywhere else in
 * §13: a gesture about *where* a module is showing never throws its edits away.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ModuleManifest } from '../../../modules/manifest-types';
import { useController } from '../ui/context';

/** What a manifest gets if it named no size: the aside's width doubled, and a tall-enough window. */
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 820;

/** Clamp to something the user can actually find on screen. */
function clampSize(value: number | undefined, fallback: number, available: number): number {
  const wanted = value ?? fallback;
  return Math.max(240, Math.min(wanted, Math.max(240, available)));
}

/**
 * Clone the opener's stylesheets into `target`, and keep them in step while the window lives.
 *
 * Returns the teardown. The observer is dev's concern (HMR replaces `<style>` nodes wholesale) and
 * costs nothing in a packaged build, where the head never changes after boot.
 */
function adoptStyles(source: Document, target: Document): () => void {
  const copy = (): void => {
    // The window may already be gone: an observer callback that reaches into a released context
    // throws Electron's "IPC method called after context was released", which lands as an unhandled
    // renderer error and takes the *main* window down with it. Every touch of the popup's document
    // is guarded for that reason, here and in the teardown.
    if (target.defaultView === null || target.defaultView.closed) return;
    for (const node of target.head.querySelectorAll('[data-tvx-adopted]')) node.remove();
    for (const node of source.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      const clone = node.cloneNode(true) as HTMLElement;
      clone.setAttribute('data-tvx-adopted', '');
      target.head.append(clone);
    }
  };
  copy();
  const observer = new MutationObserver(copy);
  observer.observe(source.head, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

/** Mirror the theme the opener is wearing onto the popup's own root element. */
function adoptTheme(source: Document, target: Document): () => void {
  const copy = (): void => {
    if (target.defaultView === null || target.defaultView.closed) return;
    const root = source.documentElement;
    target.documentElement.className = root.className;
    const theme = root.getAttribute('data-theme');
    if (theme === null) target.documentElement.removeAttribute('data-theme');
    else target.documentElement.setAttribute('data-theme', theme);
    target.body.className = source.body.className;
  };
  copy();
  const observer = new MutationObserver(copy);
  observer.observe(source.documentElement, { attributes: true });
  observer.observe(source.body, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

export interface ModuleWindowProps {
  manifest: ModuleManifest;
  Panel: React.ComponentType;
}

export function ModuleWindow({ manifest, Panel }: ModuleWindowProps): React.JSX.Element | null {
  const controller = useController();
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const width = clampSize(
      manifest.ui?.windowWidth,
      DEFAULT_WIDTH,
      window.screen?.availWidth ?? DEFAULT_WIDTH
    );
    const height = clampSize(
      manifest.ui?.windowHeight,
      DEFAULT_HEIGHT,
      window.screen?.availHeight ?? DEFAULT_HEIGHT
    );
    // `''` rather than a URL: an empty popup inherits the opener's origin and CSP and boots no second
    // copy of the app. A `tetravox://app/…` URL would load the whole renderer again — a second engine,
    // a second store, a second WebGL context — to draw one panel.
    const popup = window.open(
      '',
      `tetravox-module-${manifest.id}`,
      `popup=yes,width=${width},height=${height}`
    );
    // A blocked popup is not a crash and must not lose the module: say so and put it back in the
    // slot, which is where it was a moment ago.
    if (popup === null || popup.closed) {
      controller.moduleToast(
        'warn',
        manifest.title,
        'This window could not be opened — it stays in the panel.'
      );
      controller.setModulePlacement(manifest.id, 'docked');
      return;
    }

    popup.document.title = `${manifest.title} — Tetravox`;
    const mount = popup.document.createElement('div');
    // The popup body is the panel's whole viewport: a module that reflows reads *this* width.
    mount.className = 'flex h-full min-h-0 flex-col overflow-y-auto bg-tvx-panel p-2 text-tvx-fg';
    popup.document.body.style.margin = '0';
    popup.document.body.style.height = '100vh';
    popup.document.body.append(mount);

    const stopStyles = adoptStyles(document, popup.document);
    const stopTheme = adoptTheme(document, popup.document);

    // §13.5's keys, for this module, in this document. `resolveModuleKey`'s gating is unchanged —
    // this only says which session the keystroke belongs to.
    const onKeyDown = (event: KeyboardEvent): void => {
      const consumed = controller.handleModuleKey(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          editable: isEditable(event.target),
        },
        manifest.id
      );
      if (consumed) event.preventDefault();
    };
    popup.document.addEventListener('keydown', onKeyDown);

    // Closing the window re-docks. The user closed a *view*, not an editor: the instance, its undo
    // history and its layers are untouched, and the module is back in the slot where the ✕ that
    // does unload it lives.
    const onUnload = (): void => controller.setModulePlacement(manifest.id, 'docked');
    popup.addEventListener('beforeunload', onUnload);
    // …and a poll, because `beforeunload` is not the only way a window dies. A native close — the
    // traffic light, ⌘W, the window server tearing it down at quit, Electron destroying the
    // `BrowserWindow` — can reach `closed === true` without the opener's listener ever running, and
    // a module that is "in a window" with no window is unreachable: it holds its edits, draws
    // nowhere, and the slot that would show it says it is somewhere else. `closed` is the one signal
    // that is true in every one of those cases.
    const poll = window.setInterval(() => {
      if (popup.closed) controller.setModulePlacement(manifest.id, 'docked');
    }, 250);
    // The opener going away must not leave an orphan window on the user's desktop.
    const onOpenerUnload = (): void => popup.close();
    window.addEventListener('beforeunload', onOpenerUnload);

    setHost(mount);
    return () => {
      // Order matters: the observers stop first, then React is told there is no portal target
      // (`setHost(null)`), and only then is the window touched — and it is touched at all only if it
      // is still open. A cleanup that reached into a closed window's document threw "IPC method
      // called after context was released" out of an effect, which React reports as an unhandled
      // error and which killed the whole renderer — the *opener*, not the popup, so closing a
      // module's window blanked the app.
      stopStyles();
      stopTheme();
      window.clearInterval(poll);
      window.removeEventListener('beforeunload', onOpenerUnload);
      setHost(null);
      if (popup.closed) return;
      try {
        popup.removeEventListener('beforeunload', onUnload);
        popup.document.removeEventListener('keydown', onKeyDown);
        popup.close();
      } catch {
        // Closed between the check and the call. There is nothing left to clean up.
      }
    };
  }, [controller, manifest]);

  if (host === null) return null;
  return createPortal(
    <section data-testid="module-window" data-module={manifest.id} className="min-h-0 flex-1">
      <Panel />
    </section>,
    host
  );
}

/** The same "do not steal a key from a text field" rule the main window's handler applies. */
function isEditable(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
  );
}
