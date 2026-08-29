/**
 * The handful of controls the mesh / iso / points editors are built out of.
 *
 * They are deliberately dumb: a value in, a callback out, a `data-testid` so the E2E can drive them.
 * No control here knows what a layer is, and none of them holds state — the layer is the state, and
 * every edit goes out as one `Engine.updateLayer` (§8: no logic in React).
 *
 * These live under `mesh/` rather than at the top of `panels/layers/`, which is a shared directory:
 * The properties editors are split across files, and a new file at the root
 * of `layers/` would be a collision waiting to happen. `iso/` and `points/` import from here.
 */

import { useId, useState } from 'react';

export function Section({
  title,
  testId,
  right,
  defaultOpen = false,
  children,
}: {
  title: string;
  testId: string;
  right?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      data-testid={testId}
      data-open={open}
      className="mt-1 rounded border border-tvx-line/70 bg-tvx-bg/30"
    >
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          data-testid={`${testId}-toggle`}
          aria-expanded={open}
          className="flex-1 text-left text-[10px] font-semibold uppercase tracking-wider text-tvx-dim hover:text-tvx-accent"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? '▾' : '▸'} {title}
        </button>
        {right}
      </div>
      {open ? <div className="flex flex-col gap-1 px-1.5 pb-1.5">{children}</div> : null}
    </section>
  );
}

export function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-1.5 text-[10px] text-tvx-dim">
      <span className="w-20 shrink-0 truncate" title={label}>
        {label}
      </span>
      {children}
    </label>
  );
}

export function Toggle({
  testId,
  label,
  on,
  onChange,
  disabled = false,
  title,
}: {
  testId: string;
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  title?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={on}
      disabled={disabled}
      {...(title === undefined ? {} : { title })}
      className={`tvx-btn tvx-btn-sm ${on ? 'tvx-btn-on' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    >
      {label}
    </button>
  );
}

export function NumberField({
  testId,
  value,
  onCommit,
  step = 1,
  min,
  max,
  width = 'w-16',
}: {
  testId: string;
  value: number;
  onCommit: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  width?: string;
}): React.JSX.Element {
  return (
    <input
      type="number"
      data-testid={testId}
      className={`tvx-input ${width} px-1 py-0.5 font-mono text-[10px]`}
      value={Number.isFinite(value) ? value : 0}
      step={step}
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = Number(e.currentTarget.value);
        if (Number.isFinite(next)) onCommit(next);
      }}
    />
  );
}

export function Slider({
  testId,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  testId: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  format?: (v: number) => string;
}): React.JSX.Element {
  return (
    <>
      <input
        type="range"
        data-testid={testId}
        // `min-w-0`: a range input has an intrinsic width (~130 px) it will not shrink below on
        // its own, which pushed the readout and its unit past the card's edge in a narrow panel.
        className="h-1 min-w-0 flex-1 accent-tvx-accent"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      <span
        data-testid={`${testId}-value`}
        className="w-12 shrink-0 text-right font-mono text-[10px] text-tvx-dim"
      >
        {(format ?? ((v: number) => v.toFixed(2)))(value)}
      </span>
    </>
  );
}

export function Swatch({
  testId,
  hex,
  onChange,
  title,
}: {
  testId: string;
  hex: string;
  onChange: (hex: string) => void;
  title?: string;
}): React.JSX.Element {
  return (
    <input
      type="color"
      data-testid={testId}
      aria-label={title ?? 'Colour'}
      {...(title === undefined ? {} : { title })}
      className="h-4 w-6 shrink-0 cursor-pointer rounded border border-tvx-line bg-transparent p-0"
      value={hex}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  );
}

export function Select<T extends string>({
  testId,
  value,
  options,
  onChange,
  disabled = false,
}: {
  testId: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const id = useId();
  return (
    <select
      id={id}
      data-testid={testId}
      className="tvx-input min-w-0 flex-1 px-1 py-0.5 text-[10px]"
      value={value}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.currentTarget.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * §7.4's UX consequence, made visible: the first `edges.surface`, the first element field and the
 * first `colorMode:'label'` build the de-indexed geometry variant in the worker. They are loads with
 * a progress state, not instant checkboxes — and free thereafter.
 */
export function Pending({ testId, label }: { testId: string; label: string }): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      className="shrink-0 animate-pulse font-mono text-[10px] text-tvx-warn"
      title="Building the de-indexed geometry variant in the worker (§7.4) — free once it is built"
    >
      {label}…
    </span>
  );
}
