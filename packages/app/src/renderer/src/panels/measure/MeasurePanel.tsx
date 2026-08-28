/**
 * §8's **Measurements** panel — directed task 11 (2026-08-28).
 *
 * One row per `Scene.measurement` (§4.5): its name, its value, a jump-to and a delete. That is the
 * whole list, and it is deliberately small — a measurement is a note, not a layer, so it gets a
 * strip rather than an editor.
 *
 * Every control here is one controller call and every controller call is one §4.7 member (§8: "no
 * logic in React"). The value in particular is **not** computed here: `formatMeasurementHtml` is the
 * engine's, the same arithmetic the overlay's label comes from, so the number in the panel and the
 * number on the picture can never disagree.
 *
 * The panel renders nothing at all when the mode is off and there is nothing to list — an empty
 * heading over an empty list in a 20 rem column is chrome that costs the info panel four lines and
 * says nothing.
 */

import { formatMeasurementHtml } from '@tetravox/engine';
import { useController, useUi } from '../../ui/context';

export function MeasurePanel(): React.JSX.Element | null {
  const controller = useController();
  const measurements = useUi((s) => s.measurements);
  const measureMode = useUi((s) => s.measureMode);

  if (measurements.length === 0 && !measureMode) return null;

  return (
    <section
      data-testid="measure-panel"
      data-measure-mode={measureMode}
      className="border-t border-tvx-line px-2 py-1.5"
    >
      <header className="flex items-center justify-between pb-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-tvx-dim">
          Measurements
        </h2>
        <span data-testid="measure-count" className="text-[10px] text-tvx-dim">
          {measurements.length}
        </span>
      </header>

      {measurements.length === 0 ? (
        <p data-testid="measure-empty" className="text-[10px] text-tvx-dim">
          Click two points in a pane for a length; a third makes an angle. Esc cancels.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {measurements.map((m) => (
            <li
              key={m.id}
              data-testid={`measure-row-${m.id}`}
              data-measure-kind={m.kind}
              className="flex items-center gap-1.5 text-[11px]"
            >
              <span className="w-8 shrink-0 truncate text-tvx-dim">{m.name}</span>
              <span data-testid={`measure-value-${m.id}`} className="flex-1 tabular-nums">
                {formatMeasurementHtml(m)}
              </span>
              <button
                type="button"
                data-testid={`measure-jump-${m.id}`}
                className="tvx-btn"
                title="Put the cursor on this measurement, so every pane slices through it"
                onClick={() => controller.jumpToMeasurement(m.id)}
              >
                Go
              </button>
              <button
                type="button"
                data-testid={`measure-delete-${m.id}`}
                className="tvx-btn"
                aria-label={`Delete ${m.name}`}
                onClick={() => controller.removeMeasurement(m.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
