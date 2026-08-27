/// <reference types="vite/client" />

import type { Engine, EngineEvents } from '@tetravox/engine';
import type { TetravoxBridge } from '../../preload/index';
import type { Phase0Report } from './phase0';
import type { ShellController } from './store/controller';
import type { UiStore } from './store/store';

declare global {
  interface Window {
    /** The §5 preload bridge: paths and small JSON only, never bytes. */
    tetravox: TetravoxBridge;
    /** Phase-0 e2e handle (ROADMAP gate 2 & 3). Populated once the first frame has been drawn. */
    __tetravox_phase0?: Phase0Report;
    /**
     * Phase-1 e2e handle. The store *is* the rendered state (§8's panels are projections of it) and
     * the controller is the only thing that calls the engine — so a Playwright test can assert what
     * the UI shows and drive what a user would press, without either being a screenshot.
     */
    __tetravox?: {
      store: UiStore;
      controller: ShellController | null;
      /**
       * The live engine, for the one thing the store cannot express: **emitting** an engine event.
       * `EngineEvents.hover` has no `Engine` setter (§4.7) — the engine raises it from its own
       * pointer handling — so a test that wants the §8 Mouse block populated has to raise it here.
       *
       * `emit` is **optional** because it is not on the frozen facade: the stand-in publishes it, and
       * a test that uses it is by definition a stand-in test.
       */
      engine:
        | (Engine & {
            emit?<E extends keyof EngineEvents>(event: E, payload: EngineEvents[E]): void;
          })
        | null;
    };
  }
}

export {};
