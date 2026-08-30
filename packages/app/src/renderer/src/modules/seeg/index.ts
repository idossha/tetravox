/**
 * `tetravox.seeg` — the sEEG contact editor's `activate` (ARCHITECTURE.md §13.1).
 *
 * Deliberately thin: `editor.ts` holds the state and every command, `Panel.tsx` is chrome, and this
 * is the `ModuleInstance` that connects them to the host. The whole of §13.6's promise is visible
 * here — `runCommand` and `runOperation` reach the same model, so a button and a job file cannot
 * drift apart.
 *
 * **Imports.** `../host` for types, `../shared/contacts/*` through `editor.ts`, `react` for the
 * panel, and nothing else. No store, no `bridge()`, no engine runtime; `modules.test.ts` re-proves
 * it by reading this file.
 */

import { createElement } from 'react';
import type { ExtensionBlock, ModuleHost, ModuleInstance } from '../host';
import { createModel } from './editor';
import { SeegPanel } from './Panel';

export const activate = (host: ModuleHost): ModuleInstance => {
  const model = createModel(host);

  return {
    Panel: () => createElement(SeegPanel, { model }),

    runCommand(id: string): void | Promise<void> {
      return model.run(id);
    },

    runOperation(op, args) {
      return model.runOperation(op, args);
    },

    openPath(readerId, path) {
      return model.openPath(readerId, path);
    },

    onSibling(anchor, found) {
      return model.onSibling(anchor, found);
    },

    restoreBlock(block: ExtensionBlock) {
      return model.restoreBlock(block);
    },

    dirty: () => model.dirty(),

    dispose(): void {
      model.dispose();
    },
  };
};
