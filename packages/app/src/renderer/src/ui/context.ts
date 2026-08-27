/**
 * The shell's one React context: a `ShellController` and the store it drives.
 *
 * Components read state through `useUi(selector)` and act through `useController()`. They never see
 * an `Engine`, which is how §8's "no logic in React" stays true by construction rather than by
 * discipline.
 */

import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { ShellController } from '../store/controller';
import type { UiState, UiStore } from '../store/store';

export interface ShellContextValue {
  controller: ShellController;
  store: UiStore;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (value === null) throw new Error('useShell outside <ShellProvider>');
  return value;
}

export function useController(): ShellController {
  return useShell().controller;
}

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(useShell().store, selector);
}
