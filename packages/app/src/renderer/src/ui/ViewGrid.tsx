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
import { cellIndexAt, layoutCellStyle, layoutGrid } from '../lib/layout';
import { isEditableTarget } from '../keyboard/keymap';
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
      // A sidebar toggle (or any other mid-transition flex reflow) can observe a transient 0×0
      // host — `Math.max(1, …)` keeps the drawing buffer from ever collapsing to zero, which would
      // otherwise make WebGL reject the allocation.
      const width = Math.max(1, Math.round(host.clientWidth * dpr));
      const height = Math.max(1, Math.round(host.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        // Setting `canvas.width`/`.height` reallocates the drawing buffer per the WebGL spec — the
        // previous frame's pixels are gone, cleared to transparent black — but that is not itself a
        // scene mutation, so nothing else sets the engine's dirty bit for it. Without this call the
        // panes stay black after any resize that is not also a scene change (§8: the sidebar
        // chevrons/`Ctrl+[`/`Ctrl+]`, and a narrow-window collapse) until an unrelated command
        // happens to repaint. The engine's own frame pump re-derives each pane's viewport rect from
        // the new canvas size and each view's resolution-independent `camera.center`/`mmPerPx`
        // (§7.2), so the world centre and zoom the user had are preserved — this only asks for a
        // repaint, it does not touch camera state.
        controller.requestRender();
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => {
      observer.disconnect();
      canvas.remove();
    };
  }, [canvas, controller, dpr]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (host === null) return;
      // **Take the keyboard back.** §7.5's whole key map is suppressed while focus is in a text
      // field (`resolveKey` bails on `editable`, and so does the `?` handler in `Shell.tsx`), which
      // is right — a coordinate being typed must not step the slice. What was wrong is that
      // clicking the panes never *left* the field: the engine's pointer layer calls
      // `preventDefault()` on `pointerdown` (§7.5 needs it for capture and to stop the browser's
      // own drag), and that suppresses the default focus change with it. So after any use of the
      // header search or the coordinate box, every shortcut was silently typed into that box
      // instead — measured: `ArrowRight` did not move the cursor, `?` did not open the sheet, and
      // the search value became "scl?".
      //
      // Blurring here rather than in the engine because DOM focus is the shell's (§8): the engine
      // owns the canvas, not the document. `tabIndex={-1}` on the host makes it a legal focus
      // target, so focus lands somewhere meaningful instead of on `<body>`.
      const active = document.activeElement;
      if (isEditableTarget(active)) {
        (active as HTMLElement).blur();
        host.focus({ preventScroll: true });
      }
      if (cells.length === 0) return;
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
      tabIndex={-1}
      className="relative min-h-0 min-w-0 flex-1 bg-tvx-bg outline-none"
      onPointerDownCapture={onPointerDown}
    >
      <div
        className="pointer-events-none absolute inset-0 grid gap-px"
        style={{ gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows }}
      >
        {cells.map((id, index) => (
          <div
            key={id}
            data-testid={`view-cell-${id}`}
            data-active={id === activeViewId}
            style={layoutCellStyle(layoutKind, index)}
            className={
              'relative border ' +
              (id === activeViewId ? 'border-tvx-accent' : 'border-tvx-line/60')
            }
          >
            {/* No title here: the engine's corner info already names the view (bottom-left), and
                a second copy top-left was the one piece of chrome that said nothing new. */}
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
