/**
 * The keyboard-map help sheet — **Phase 2** (owner: A-SHELL).
 *
 * ROADMAP Phase 2 lists "keyboard map" beside scene save/load and the screenshot spec. Phase 1 ships
 * `KEYMAP_HELP`, a one-line string in the toolbar's `title`, which is discoverable only by hovering.
 *
 * The rows come from `keymap.ts` so there is **one** source of truth: a sheet that lists a binding
 * the resolver does not implement is worse than no sheet. When §7.5's pointer gestures land (P2-01)
 * they belong here too — `Shift+drag` for opacity and right-drag for window/level are the two a user
 * is least likely to guess.
 */

export interface KeyboardHelpProps {
  open: boolean;
  onClose(): void;
}

export function KeyboardHelp(_props: KeyboardHelpProps): React.JSX.Element | null {
  return null;
}
