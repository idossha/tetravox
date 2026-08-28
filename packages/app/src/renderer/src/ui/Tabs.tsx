/**
 * The one tab strip the shell's dialogs share (`SettingsDialog`, `KeyboardHelp`).
 *
 * A roving-tabindex `role="tablist"` per the WAI-ARIA Tabs pattern: only the active tab is in the
 * page's Tab order, and Left/Right arrows move both focus and selection between tabs without
 * leaving the strip. `Tab` itself moves in and out of the whole group, exactly as a native control
 * would, because only one button ever has `tabIndex={0}`.
 */

import { useRef } from 'react';

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabItem<T>[];
  active: T;
  onChange(id: T): void;
  /** Rendered as `data-testid="${testIdPrefix}-${tab.id}"`. */
  testIdPrefix: string;
  'aria-label': string;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  testIdPrefix,
  'aria-label': ariaLabel,
}: TabsProps<T>): React.JSX.Element {
  const buttonRefs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next === undefined) return;
    onChange(next.id);
    buttonRefs.current[next.id]?.focus();
  };

  return (
    <div
      className="mb-3 flex items-center gap-0.5 border-b border-tvx-line pb-2"
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map(({ id, label }, index) => (
        <button
          key={id}
          ref={(el) => {
            buttonRefs.current[id] = el;
          }}
          type="button"
          role="tab"
          aria-selected={active === id}
          tabIndex={active === id ? 0 : -1}
          data-testid={`${testIdPrefix}-${id}`}
          className={active === id ? 'tvx-btn tvx-btn-sm tvx-btn-on' : 'tvx-btn tvx-btn-sm'}
          onClick={() => onChange(id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
