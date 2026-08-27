import type { Engine, EngineEvents } from '@tetravox/engine';
import type { TetravoxBridge } from '../src/preload';
import type { Phase0Report } from '../src/renderer/src/phase0';
import type { ShellController } from '../src/renderer/src/store/controller';
import type { UiStore } from '../src/renderer/src/store/store';

declare global {
  interface Window {
    /**
     * The §5 preload bridge: paths and small JSON only, never bytes. Declared here so an e2e can
     * build the same `OpenRequest` the Open dialog builds — `allowPath` is what admits a path to the
     * main-process allow-list, and skipping it would test a path the product would refuse.
     */
    tetravox: TetravoxBridge;
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
