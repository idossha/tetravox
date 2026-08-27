import type { Engine, EngineEvents } from '@tetravox/engine';
import type { Phase0Report } from '../src/renderer/src/phase0';
import type { ShellController } from '../src/renderer/src/store/controller';
import type { UiStore } from '../src/renderer/src/store/store';

declare global {
  interface Window {
    /** Published by the renderer once the worker round-trip and the first frame are done. */
    __tetravox_phase0?: Phase0Report;
    /**
     * The Phase-1 shell's handle. Mirrors `src/renderer/src/env.d.ts`; duplicated because the e2e
     * tsconfig compiles the Node side and does not pull in the renderer's global declarations.
     */
    __tetravox?: {
      store: UiStore;
      controller: ShellController | null;
      engine:
        | (Engine & {
            emit?<E extends keyof EngineEvents>(event: E, payload: EngineEvents[E]): void;
          })
        | null;
    };
  }
}

export {};
