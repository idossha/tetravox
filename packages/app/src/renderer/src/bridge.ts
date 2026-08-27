/**
 * Access to the §5 preload bridge, with a null object for contexts that have none (vitest, a plain
 * browser tab). Paths and small JSON only — there is deliberately no byte channel to reach for.
 */

import type { OpenedPath, TetravoxBridge } from '../../preload/index';

const ABSENT: TetravoxBridge = {
  openDialog: async () => [],
  getDroppedFilePath: () => '',
  allowPath: async () => null,
  startupPaths: async () => [],
  phase0Fixture: async () => null,
  onOpened: () => () => {},
  log: () => {},
};

export function bridge(): TetravoxBridge {
  return (globalThis as { tetravox?: TetravoxBridge }).tetravox ?? ABSENT;
}

export function hasBridge(): boolean {
  return (globalThis as { tetravox?: TetravoxBridge }).tetravox !== undefined;
}

export type { OpenedPath };
