/// <reference types="vite/client" />

import type { TetravoxBridge } from '../../preload/index';
import type { Phase0Report } from './phase0';

declare global {
  interface Window {
    /** The §5 preload bridge: paths and small JSON only, never bytes. */
    tetravox: TetravoxBridge;
    /** Phase-0 e2e handle (ROADMAP gate 2 & 3). Populated once the first frame has been drawn. */
    __tetravox_phase0?: Phase0Report;
  }
}

export {};
