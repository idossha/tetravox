/**
 * `tetravox.hello` — the fixture module (ARCHITECTURE.md §13.4).
 *
 * It does nothing useful on purpose. What it does is **use every part of the host that P0 wires**, so
 * the surface has a consumer in the shipped bundle rather than only in a test: a panel in the slot, a
 * command on a key, a command gated on a selection, a status cell, a dirty flag, a scene block that
 * survives save → load, a history stack, a toast, and a job operation.
 *
 * It is also the worked example §13.7 points at. Read in order: the state and its listeners (a module
 * owns its own state — the app store is not reachable from here), `activate`, and the `ModuleInstance`
 * it returns.
 *
 * **Imports.** `../host` for types, `react` for the panel, and nothing else. The ESLint wall on
 * `modules/<id>/**` and the source scan in `modules.test.ts` both enforce that; the point of the rule
 * is §13.8's stage 2, where a module runs in a worker and could not reach the store even if it tried.
 */

import { createElement } from 'react';
import type { ExtensionBlock, ModuleHost, ModuleInstance } from '../host';
import { ModuleHostError } from '../host';
import { HelloPanel } from './Panel';

/** What the fixture keeps — and what its scene block carries, so a reopen resumes it. */
export interface HelloState {
  /** How many times `ping` has run in this scene. */
  count: number;
  /** The last thing worth saying in the panel and in the status cell. */
  note: string;
}

export const HELLO_BLOCK_VERSION = 1;

export interface HelloModel {
  state(): HelloState;
  subscribe(listener: () => void): () => void;
  ping(): void;
  reset(): void;
  restore(state: HelloState): void;
  save(): void;
  undo(): void;
  dirty(): boolean;
}

const INITIAL: HelloState = { count: 0, note: 'nothing yet' };

/**
 * The module's own tiny store.
 *
 * A module gets no access to the app's Zustand store (§13.1), which is deliberate rather than
 * incidental: everything a module renders is state it owns, so a panel that re-renders is a panel
 * whose module changed. `useSyncExternalStore` in `Panel.tsx` is the whole subscription mechanism.
 */
function createModel(host: ModuleHost): HelloModel {
  let state: HelloState = { ...INITIAL };
  let dirty = false;
  const listeners = new Set<() => void>();
  const history = host.history<HelloState>(50);

  const publish = (next: HelloState, markDirty: boolean): void => {
    state = next;
    if (markDirty) {
      dirty = true;
      host.ui.setDirty(true);
    }
    host.ui.status(next.count === 0 ? null : `hello: ${next.count}`);
    // §13.2: the block is written on every change, so "the scene knows" and "the module knows" can
    // never drift — the alternative is remembering to write it in each command, which is where a
    // module loses a user's work.
    host.scene.setBlock<HelloState>(next);
    for (const listener of listeners) listener();
  };

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ping() {
      history.push(state);
      publish({ count: state.count + 1, note: `ping ${state.count + 1}` }, true);
    },
    reset() {
      history.push(state);
      publish({ ...INITIAL }, true);
    },
    restore(next) {
      // Not an edit: the scene file already said this, so the history starts here and the dirty flag
      // stays down. Replaying the edits that produced `next` would push N undo steps for work the
      // user did in a previous session.
      history.clear();
      dirty = false;
      host.ui.setDirty(false);
      publish(next, false);
    },
    save() {
      // The fixture has no file of its own; "saved" is the flag going down, which is what the
      // discard guard reads. A real module writes through `host.files` here.
      dirty = false;
      host.ui.setDirty(false);
      publish({ ...state, note: 'saved' }, false);
    },
    undo() {
      const previous = history.undo();
      if (previous === null) {
        host.ui.toast('info', 'nothing to undo');
        return;
      }
      publish(previous, true);
    },
    dirty: () => dirty,
  };
}

/** Restore from a block written by this or an older version of the module (§13.2). */
function fromBlock(block: ExtensionBlock): HelloState {
  const data = block.data as Partial<HelloState> | null;
  return {
    count: typeof data?.count === 'number' && Number.isFinite(data.count) ? data.count : 0,
    note: typeof data?.note === 'string' ? data.note : 'restored',
  };
}

export const activate = (host: ModuleHost): ModuleInstance => {
  const model = createModel(host);

  return {
    Panel: () => createElement(HelloPanel, { model }),

    runCommand(id: string): void {
      switch (id) {
        case 'ping':
          return model.ping();
        case 'reset':
          return model.reset();
        case 'save':
          return model.save();
        case 'undo':
          return model.undo();
        case 'select-demo': {
          // The fixture's demonstration of an unwired member: P0 has no point tool, so this throws
          // `ModuleHostError` and the module reports it rather than silently doing nothing.
          // INTEGRATION(P2): once the engine has the tool, this reports the real selection.
          try {
            const selection = host.tool.selection();
            host.ui.toast('info', selection === null ? 'nothing selected' : selection.pointId);
          } catch (error: unknown) {
            const why = error instanceof ModuleHostError ? error.message : String(error);
            host.ui.toast('warn', why);
          }
          return;
        }
        default:
          host.ui.toast('warn', `hello has no command "${id}"`);
      }
    },

    // §13.6: every panel action is also a job operation, which is what keeps "there is no
    // automation-only code path" literally true. `echo` is the one the envelope test drives.
    async runOperation(
      op: string,
      args: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      if (op !== 'echo') throw new ModuleHostError(`hello has no operation "${op}"`);
      const text = typeof args['text'] === 'string' ? args['text'] : '';
      model.ping();
      return { text, count: model.state().count };
    },

    async restoreBlock(block: ExtensionBlock): Promise<void> {
      model.restore(fromBlock(block));
    },

    dirty: () => model.dirty(),

    dispose(): void {
      host.ui.status(null);
    },
  };
};
