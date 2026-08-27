/**
 * §8 centre region: "view grid (coloured border on the active view pane)".
 *
 * One canvas, sized to the host, handed to the engine — §1: "One context / one depth buffer for
 * volumes *and* meshes". The canvas element is created by `Shell` and **adopted** here, because the
 * engine holds the element it was given at boot and React must not swap it under the engine.
 *
 * The pane overlays are **`pointer-events: none`**: §7.5's interaction (left-drag sets the cursor,
 * right-drag is window/level, wheel steps the slice, double-click picks) belongs to the engine and
 * lives on the canvas, and a div on top would swallow all of it. Active-pane focus is therefore
 * derived from the host rectangle by `cellIndexAt`, which is pure and tested.
 */

import { useCallback, useEffect, useRef } from 'react';
import { cellIndexAt, layoutGrid } from '../lib/layout';
import { useController, useUi } from './context';

export interface ViewGridProps {
  canvas: HTMLCanvasElement;
  dpr: number;
}

export function ViewGrid({ canvas, dpr }: ViewGridProps): React.JSX.Element {
  const controller = useController();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const layoutKind = useUi((s) => s.layoutKind);
  const cells = useUi((s) => s.cells);
  const activeViewId = useUi((s) => s.activeViewId);

  // Adopt the canvas, then keep its drawing buffer the size of the host in device pixels. The engine
  // reads the size it is given; nothing here draws.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    host.insertBefore(canvas, host.firstChild);
    const resize = (): void => {
      const width = Math.max(1, Math.round(host.clientWidth * dpr));
      const height = Math.max(1, Math.round(host.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => {
      observer.disconnect();
      canvas.remove();
    };
  }, [canvas, dpr]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (host === null || cells.length === 0) return;
      const rect = host.getBoundingClientRect();
      const index = cellIndexAt(
        layoutKind,
        cells.length,
        rect,
        event.clientX - rect.left,
        event.clientY - rect.top
      );
      const id = cells[index];
      if (id !== undefined && id !== activeViewId) controller.setActiveView(id);
    },
    [activeViewId, cells, controller, layoutKind]
  );

  const grid = layoutGrid(layoutKind, cells.length);

  return (
    <div
      data-testid="view-grid"
      data-layout={layoutKind}
      ref={hostRef}
      className="relative min-h-0 min-w-0 flex-1 bg-tvx-bg"
      onPointerDownCapture={onPointerDown}
    >
      <div
        className="pointer-events-none absolute inset-0 grid gap-px"
        style={{ gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows }}
      >
        {cells.map((id) => (
          <div
            key={id}
            data-testid={`view-cell-${id}`}
            data-active={id === activeViewId}
            className={
              'relative border ' +
              (id === activeViewId ? 'border-tvx-accent' : 'border-tvx-line/60')
            }
          >
            <span className="absolute left-1 top-1 font-mono text-[10px] uppercase text-tvx-dim">
              {id}
            </span>
          </div>
        ))}
      </div>
      {cells.length === 0 && (
        <p
          data-testid="view-grid-empty"
          className="absolute inset-0 grid place-items-center text-xs text-tvx-dim"
        >
          No views.
        </p>
      )}
    </div>
  );
}
