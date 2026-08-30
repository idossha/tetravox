/**
 * The fixture module's panel — what the slot renders (ARCHITECTURE.md §13.3).
 *
 * Chrome only, exactly like every §8 panel: it reads the module's own state through
 * `useSyncExternalStore` and every control it draws is one `model` call, which is one command. There
 * is no `useController`, no `useUi` and no `Engine` here, and there cannot be — the module wall
 * forbids the imports that would make it possible.
 *
 * The buttons **blur on click**, which is not a style choice: the engine's Space-drag pan modifier is
 * a window keydown, so a focused button left focused turns the next Space into a button press
 * (`input/pointer.ts`).
 */

import { useSyncExternalStore } from 'react';
import type { HelloModel } from './index';

export function HelloPanel({ model }: { model: HelloModel }): React.JSX.Element {
  const state = useSyncExternalStore(model.subscribe, model.state, model.state);
  const blur = (event: React.MouseEvent<HTMLButtonElement>): void => event.currentTarget.blur();

  return (
    <div data-testid="hello-panel" className="flex flex-col gap-1.5 text-[11px]">
      <p className="text-tvx-dim">
        The fixture module (§13.4). It counts, it remembers its count in the scene, and it is the
        worked example a new module is copied from.
      </p>
      <p className="flex items-baseline gap-2">
        <span className="text-tvx-dim">count</span>
        <span data-testid="hello-count" className="tabular-nums text-tvx-text">
          {state.count}
        </span>
        <span data-testid="hello-note" className="text-tvx-dim">
          {state.note}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          data-testid="hello-ping"
          className="tvx-btn"
          title="Ping (g) — one more count, and the scene block is rewritten"
          onClick={(event) => {
            blur(event);
            model.ping();
          }}
        >
          Ping
        </button>
        <button
          type="button"
          data-testid="hello-undo"
          className="tvx-btn"
          title="Undo the last ping (host.history)"
          onClick={(event) => {
            blur(event);
            model.undo();
          }}
        >
          Undo
        </button>
        <button
          type="button"
          data-testid="hello-save"
          className="tvx-btn"
          title="Mark the module's work saved — what the discard guard reads"
          onClick={(event) => {
            blur(event);
            model.save();
          }}
        >
          Save
        </button>
        <button
          type="button"
          data-testid="hello-reset"
          className="tvx-btn"
          onClick={(event) => {
            blur(event);
            model.reset();
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
