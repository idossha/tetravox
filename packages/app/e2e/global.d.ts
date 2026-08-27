import type { Phase0Report } from '../src/renderer/src/phase0';

declare global {
  interface Window {
    /** Published by the renderer once the worker round-trip and the first frame are done. */
    __tetravox_phase0?: Phase0Report;
  }
}

export {};
