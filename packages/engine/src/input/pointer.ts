/**
 * The DOM half of §7.5's pointer layer — P2-01, and R1 / R2 / R3.
 *
 * This is the only file in the engine that touches a DOM event. It listens on the **canvas** (and on
 * `window` for the keys and the button-releases that happen off it), resolves which pane the pointer
 * is over, runs the {@link GestureMachine}, and calls the {@link PointerHost} — which is
 * `TetravoxEngine`. It computes nothing: the geometry is `view/geometry.ts`'s and the camera maths
 * is `input/camera.ts`'s, both pure and both unit-tested without a browser.
 *
 * Three details that are load-bearing rather than incidental:
 *
 * * **Pointer capture on `pointerdown`.** A drag that leaves the canvas — very easy in a 2×2 layout
 *   with a 96 mm pane — must keep delivering `pointermove` to the pane it started in, or the cursor
 *   stops halfway and the user is told their screen edge is a wall. Capture is what does that, and
 *   the {@link GestureMachine} latching the pane at `pointerdown` is what makes it meaningful.
 * * **`touch-action: none` on the canvas.** Without it the browser claims every touch drag for
 *   scrolling before a `pointermove` is ever dispatched, and the pointer layer is dead on a
 *   touchscreen with no error anywhere.
 * * **A wheel event with a non-zero `deltaX` is a two-finger trackpad drag, not a wheel.** That is
 *   the one honest discriminator available: a wheel emits `deltaY` alone, a two-finger drag emits
 *   both. R3 requires the two-finger drag to pan and §7.5 requires the wheel to step slices, and
 *   they arrive as the same event type.
 */

import { GestureMachine, NO_MODIFIERS } from './gestures';
import type { Modifiers } from './gestures';
import { normaliseWheelDelta, wheelZoomFactor, ZOOM_STEP } from './camera';

/** Which pane a device-pixel point on the canvas belongs to. */
export interface PaneHit {
  viewId: string;
  is3D: boolean;
  /** Pane-local, top-left origin, device pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Everything the pointer layer is allowed to ask of the engine.
 *
 * Deliberately narrow and deliberately imperative: every member is one thing §7.5 binds a gesture
 * to, and every one of them is also a public method on `TetravoxEngine`, so the app (§8: "everything
 * the UI can do must be reachable from the `Engine` API alone. No logic in React") drives the same
 * operations the mouse does.
 */
export interface PointerHost {
  readonly canvas: HTMLCanvasElement;
  /** Device pixels per CSS pixel of the canvas. */
  dpr(): number;
  /** Which pane covers this canvas point (device pixels, top-left origin). */
  paneAt(x: number, y: number): PaneHit | null;
  /** One pane's rectangle in canvas device pixels, top-left origin — the latched pane of a drag. */
  paneRect(viewId: string): { x: number; y: number; width: number; height: number } | null;
  /** §7.2: an input happened — raise `interacting` and re-arm the settle timer. */
  noteInput(): void;

  setCursorFromScreen(viewId: string, x: number, y: number): void;
  hoverAtScreen(viewId: string | null, x: number, y: number): void;
  panView(viewId: string, dxPx: number, dyPx: number): void;
  zoomViewAt(viewId: string, x: number, y: number, factor: number): void;
  zoomView(viewId: string, factor: number): void;
  stepSlice(viewId: string, steps: number): void;
  windowLevelDrag(viewId: string, nx: number, ny: number): void;
  opacityDrag(ny: number): void;
  orbitView(viewId: string, dxPx: number, dyPx: number): void;
  pan3DView(viewId: string, dxPx: number, dyPx: number): void;
  dollyView(viewId: string, deltaY: number): void;
  pickToCursor(viewId: string, x: number, y: number): void;
  resetView(viewId: string): void;

  // §7.5's oblique affordances (appended with the gizmo; same rule as the rest of this interface —
  // every member is one thing §7.5 binds, and every one is public on `TetravoxEngine`).

  /**
   * A left-click on the 3D pane's orientation cube: snap the camera to that face's preset, and say
   * whether the click was consumed (directed task 10, 2026-08-28).
   *
   * Checked **before** the gizmo and before the orbit, because the cube is chrome drawn on top of
   * both: a click that lands on a face is a click on the cube, and letting it start an orbit as well
   * would spin the camera away from the preset it just snapped to.
   */
  clickOrientationCube(viewId: string, x: number, y: number): boolean;
  /** Which cut-plane gizmo handle a 3D-pane pixel is over, latching the highlight. */
  gizmoAt(viewId: string, x: number, y: number): 'translate' | 'rotateU' | 'rotateV' | null;
  /** Drag a gizmo handle: translate along the normal, or rotate about an in-plane axis. */
  gizmoDrag(handle: 'translate' | 'rotateU' | 'rotateV', dxPx: number, dyPx: number): void;
  /** How many plane-from-3-points clicks are still being collected, or `null` when not collecting. */
  readonly planeFromPointsPending: number | null;
  /** Contribute one click to an armed plane-from-3-points; `true` while it is consuming clicks. */
  addPlanePoint(viewId: string, x: number, y: number): boolean;

  // §7.5's measure mode (directed task 11, 2026-08-28). Same rule as the rest of this interface:
  // one member per gesture, each of them public on `TetravoxEngine`.

  /** How many points the measure gesture holds, or `null` when the mode is off. */
  readonly measurePending: number | null;
  /** Contribute one click; `true` while measure mode is consuming them. */
  addMeasurePoint(viewId: string, x: number, y: number, is3D: boolean): boolean;
  /** `Esc`: abandon the measurement being placed. */
  cancelMeasurement(): void;

  // §13's point tool (2026-08-30). Same rule as the rest of this interface: one member per thing
  // §7.5 binds, each of them public on `TetravoxEngine`.

  /** Which point-tool mode is armed, or `null` — the `#onDown` slot and the cursor both ask. */
  readonly pointToolMode: 'select' | 'place' | null;
  /**
   * A left press while the tool is armed. `'consumed'` — the tool took the click and no gesture
   * follows; `'grabbed'` — a point was grabbed and a `'point'` drag should start; `'miss'` — the
   * press was not the tool's and falls through to the gizmo and the gesture machine.
   */
  pointToolDown(
    viewId: string,
    x: number,
    y: number,
    is3D: boolean
  ): 'consumed' | 'grabbed' | 'miss';
  /** The armed hover hit test (2D, `select` mode only): `true` when a point is under the pointer. */
  pointToolHover(viewId: string | null, x: number, y: number): boolean;
  /** One move of a `'point'` drag. */
  pointToolDrag(viewId: string, x: number, y: number): void;
  /** The `'point'` gesture ended — forwarded from all three exits, and emitted once. */
  endPointDrag(): void;
  /** `Esc` while armed: `place` → `select` → off. `true` when it consumed the key. */
  cancelPointTool(): boolean;
}

/** True when the key event is going into a text field and no shortcut may fire. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export class PointerLayer {
  readonly #host: PointerHost;
  readonly #canvas: HTMLCanvasElement;
  readonly #machine = new GestureMachine();
  readonly #off: (() => void)[] = [];
  #mods: Modifiers = { ...NO_MODIFIERS };
  /** The gizmo handle the current drag grabbed at `pointerdown`, for the length of that drag. */
  #gizmoHandle: 'translate' | 'rotateU' | 'rotateV' | null = null;
  /** The pane the pointer is currently over, for the keys R2 binds per pane. */
  #hovered: string | null = null;
  /** §13: this press grabbed a point, so the gesture machine resolves a `'point'` drag. */
  #overPoint = false;
  /**
   * The cursor **this layer** set on the canvas, so it can put back what it found.
   *
   * The embedder owns the element (§7.2's `#dpr` note is the same arrangement for its size), and a
   * tool that reset `style.cursor` to `''` unconditionally would erase an embedder's own choice the
   * first time a point tool was disarmed.
   */
  #cursor: '' | 'grab' | 'crosshair' = '';
  #cursorWas: string | null = null;
  #destroyed = false;

  constructor(host: PointerHost) {
    this.#host = host;
    this.#canvas = host.canvas;
    // Without this a touch drag is a page scroll and no `pointermove` is ever dispatched.
    this.#canvas.style.touchAction = 'none';

    this.#on(this.#canvas, 'pointerdown', this.#onDown as EventListener);
    this.#on(this.#canvas, 'pointermove', this.#onMove as EventListener);
    this.#on(this.#canvas, 'pointerup', this.#onUp as EventListener);
    this.#on(this.#canvas, 'pointercancel', this.#onCancel as EventListener);
    this.#on(this.#canvas, 'pointerleave', this.#onLeave as EventListener);
    this.#on(this.#canvas, 'dblclick', this.#onDoubleClick as EventListener);
    // A right-drag is window/level (§7.5); the context menu would eat the `pointerdown` that starts it.
    this.#on(this.#canvas, 'contextmenu', (e) => {
      e.preventDefault();
    });
    // `passive: false` because a `⌘/Ctrl+wheel` that is not `preventDefault`ed is a browser page
    // zoom, which would scale the canvas out from under the engine mid-gesture.
    this.#on(this.#canvas, 'wheel', this.#onWheel as EventListener, { passive: false });
    this.#on(window, 'keydown', this.#onKeyDown as EventListener);
    this.#on(window, 'keyup', this.#onKeyUp as EventListener);
    // A button released outside the window never reaches the canvas; without this the drag never ends.
    this.#on(window, 'blur', this.#onCancel as EventListener);
  }

  dispose(): void {
    this.#destroyed = true;
    for (const off of this.#off) off();
    this.#off.length = 0;
    this.#machine.reset();
    // §13: the canvas belongs to the embedder, and an engine destroyed while the point tool was
    // armed must not leave a `grab` cursor on it for ever.
    if (this.#cursor !== '') {
      this.#canvas.style.cursor = this.#cursorWas ?? '';
      this.#cursor = '';
    }
  }

  #on(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.#off.push(() => {
      target.removeEventListener(type, fn, opts);
    });
  }

  /** Canvas-local device pixels, top-left origin, from a mouse/pointer/wheel event. */
  #devicePoint(e: MouseEvent): { x: number; y: number } {
    const r = this.#canvas.getBoundingClientRect();
    // The canvas's CSS size and its backing store are two different numbers (§7.2's `#dpr`), and the
    // ratio is read off the element rather than off `devicePixelRatio`, because the embedder owns
    // the backing store.
    const sx = r.width > 0 ? this.#canvas.width / r.width : this.#host.dpr();
    const sy = r.height > 0 ? this.#canvas.height / r.height : this.#host.dpr();
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  #modsOf(e: MouseEvent | KeyboardEvent): Modifiers {
    return {
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      alt: e.altKey,
      space: this.#mods.space,
    };
  }

  readonly #onDown = (e: PointerEvent): void => {
    if (this.#destroyed) return;
    const p = this.#devicePoint(e);
    const pane = this.#host.paneAt(p.x, p.y);
    if (pane === null) return;
    this.#mods = this.#modsOf(e);
    this.#hovered = pane.viewId;
    this.#host.noteInput();
    // §7.5's plane-from-3-points, while it is armed: a left-click in a 2D pane contributes a point
    // instead of setting the cursor, and the engine sets the plane on the third one.
    if (
      e.button === 0 &&
      !pane.is3D &&
      this.#host.planeFromPointsPending !== null &&
      this.#host.addPlanePoint(pane.viewId, pane.x, pane.y)
    ) {
      e.preventDefault();
      return;
    }
    // The orientation cube is chrome on top of the 3D scene, so it takes the click before
    // everything below it — before measure mode, before the gizmo, and before the orbit gesture
    // ever starts. A face of the cube is a camera preset, and a click that landed on one was never
    // aimed at the anatomy behind it.
    if (
      e.button === 0 &&
      pane.is3D &&
      this.#host.clickOrientationCube(pane.viewId, pane.x, pane.y)
    ) {
      e.preventDefault();
      return;
    }
    // §7.5's measure mode: a left-click places a measurement point instead of setting the cursor,
    // in **both** pane kinds — a 2D click lands on that pane's plane, a 3D one on the picked
    // surface. It is tried before the gizmo so a measurement in the 3D pane is not eaten by a
    // handle the pointer happens to be over.
    if (e.button === 0 && this.#host.measurePending !== null) {
      if (this.#host.addMeasurePoint(pane.viewId, pane.x, pane.y, pane.is3D)) {
        e.preventDefault();
        return;
      }
    }
    // §13's point tool (2026-08-30), in §7.5's precedence: after measure mode and **before** the
    // gizmo, so a contact in the 3D pane is not eaten by a handle the pointer happens to be over —
    // the same argument that put measure mode ahead of the gizmo. A `'miss'` changes nothing at
    // all, which is what keeps every gesture that predates the tool exactly as it was.
    this.#overPoint = false;
    if (e.button === 0 && this.#host.pointToolMode !== null) {
      const took = this.#host.pointToolDown(pane.viewId, pane.x, pane.y, pane.is3D);
      if (took === 'consumed') {
        e.preventDefault();
        return;
      }
      this.#overPoint = took === 'grabbed';
    }
    this.#gizmoHandle = pane.is3D ? this.#host.gizmoAt(pane.viewId, pane.x, pane.y) : null;
    // Capture first: a drag that leaves the canvas must keep arriving.
    try {
      this.#canvas.setPointerCapture(e.pointerId);
    } catch {
      // Some environments refuse capture for a pointer that is already gone; the drag still works
      // for as long as the pointer stays over the canvas, which is strictly better than throwing.
    }
    e.preventDefault();
    for (const g of this.#machine.down(
      e.pointerId,
      e.button,
      { viewId: pane.viewId, is3D: pane.is3D, x: pane.x, y: pane.y },
      this.#mods,
      { overGizmo: this.#gizmoHandle !== null, overPoint: this.#overPoint }
    )) {
      if (g.type === 'begin' && g.kind === 'cursor') {
        // R1: **left-click sets the cursor**, before any movement.
        this.#host.setCursorFromScreen(g.viewId, g.x, g.y);
      }
      // §13: a second finger landing ends the one-pointer gesture (`gestures.ts`), and this loop
      // is the only place that `end` is ever delivered. Without this line a pinch started mid-drag
      // would leave the point tool believing the drag was still running.
      if (g.type === 'end' && g.kind === 'point') this.#host.endPointDrag();
    }
  };

  readonly #onMove = (e: PointerEvent): void => {
    if (this.#destroyed) return;
    const p = this.#devicePoint(e);
    this.#mods = this.#modsOf(e);

    if (!this.#machine.active) {
      // Hover (§8's `Mouse` block, P2-04). No `noteInput()`: moving the mouse over a still image is
      // not an interaction, and treating it as one would keep `interacting` latched forever and
      // hold every golden at reduced quality.
      const pane = this.#host.paneAt(p.x, p.y);
      this.#hovered = pane?.viewId ?? null;
      if (pane === null) this.#host.hoverAtScreen(null, 0, 0);
      else if (pane.is3D) this.#host.gizmoAt(pane.viewId, pane.x, pane.y);
      else this.#host.hoverAtScreen(pane.viewId, pane.x, pane.y);
      // §13's armed hover (2026-08-30). The host runs a hit test **only** while `select` mode is
      // armed, so a user who is not editing points pays one property read per move and §8's 16 ms
      // hover budget is untouched.
      this.#pointCursor(pane);
      return;
    }

    // Mid-drag the position is expressed in the **latched** pane, however far outside it we are.
    const local = this.#localTo(this.#machine.viewId, p.x, p.y);
    if (local === null) return;
    this.#host.noteInput();
    for (const g of this.#machine.move(e.pointerId, local.x, local.y)) this.#dispatch(g, local);
  };

  readonly #onUp = (e: PointerEvent): void => {
    if (this.#destroyed) return;
    this.#gizmoHandle = null;
    this.#overPoint = false;
    // §13: the drag's commit point. Every other gesture writes straight into the scene and needs
    // no end (the gizmo's `end` is still discarded); a point drag is one undo step for the host,
    // and the host cannot see the machine.
    for (const g of this.#machine.up(e.pointerId)) {
      if (g.type === 'end' && g.kind === 'point') this.#host.endPointDrag();
    }
    try {
      if (this.#canvas.hasPointerCapture(e.pointerId)) {
        this.#canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Already released, or never granted.
    }
  };

  readonly #onCancel = (): void => {
    this.#gizmoHandle = null;
    this.#overPoint = false;
    // `pointercancel`, and the window `blur` bound to the same handler — a drag that ends because
    // the user switched windows still ends, and §13's `dragEnd` is delivered exactly once.
    for (const g of this.#machine.reset()) {
      if (g.type === 'end' && g.kind === 'point') this.#host.endPointDrag();
    }
  };

  readonly #onLeave = (): void => {
    if (this.#machine.active) return;
    this.#hovered = null;
    this.#host.hoverAtScreen(null, 0, 0);
    this.#pointCursor(null);
  };

  /**
   * §7.5: double-click in the 3D pane is `setCursorFromPick`. In a 2D pane R2 offers it as the
   * modifier-held "reset to fit", the pointer twin of `r`.
   */
  readonly #onDoubleClick = (e: MouseEvent): void => {
    if (this.#destroyed) return;
    const p = this.#devicePoint(e);
    const pane = this.#host.paneAt(p.x, p.y);
    if (pane === null) return;
    this.#host.noteInput();
    if (pane.is3D) this.#host.pickToCursor(pane.viewId, pane.x, pane.y);
    else if (e.altKey) this.#host.resetView(pane.viewId);
  };

  readonly #onWheel = (e: WheelEvent): void => {
    if (this.#destroyed) return;
    const p = this.#devicePoint(e);
    const pane = this.#host.paneAt(p.x, p.y);
    if (pane === null) return;
    this.#hovered = pane.viewId;
    this.#host.noteInput();
    e.preventDefault();
    const dy = normaliseWheelDelta(e.deltaY, e.deltaMode);
    const dx = normaliseWheelDelta(e.deltaX, e.deltaMode);

    // R2: `⌘/Ctrl+wheel` **and trackpad pinch** — which Chromium delivers as a wheel with
    // `ctrlKey: true` whether or not a Ctrl key is down — zoom about the pointer.
    if (e.ctrlKey || e.metaKey) {
      if (pane.is3D) this.#host.dollyView(pane.viewId, dy);
      else this.#host.zoomViewAt(pane.viewId, pane.x, pane.y, wheelZoomFactor(dy));
      return;
    }
    // R3: a two-finger trackpad drag pans. It is the only wheel event with a horizontal component.
    if (dx !== 0) {
      if (pane.is3D) this.#host.pan3DView(pane.viewId, dx, dy);
      else this.#host.panView(pane.viewId, dx, dy);
      return;
    }
    if (pane.is3D) {
      this.#host.dollyView(pane.viewId, dy);
      return;
    }
    // §7.5: wheel = slice ±1. Scrolling up (`deltaY < 0`) advances.
    const steps = dy === 0 ? 0 : dy < 0 ? 1 : -1;
    if (steps !== 0) this.#host.stepSlice(pane.viewId, steps);
  };

  readonly #onKeyDown = (e: KeyboardEvent): void => {
    if (this.#destroyed || isEditableTarget(e.target)) return;
    if (e.code === 'Space') {
      // R3's explicit pan modifier. Not `preventDefault`ed unless the pointer is over a pane, so a
      // space keypress in the app's chrome still does whatever the app wants it to.
      this.#mods = { ...this.#mods, space: true };
      if (this.#hovered !== null) e.preventDefault();
      return;
    }
    // `Esc` cancels the measurement being placed (directed task 11). Bound here rather than in the
    // app's keymap because the draft is engine state and the canvas is where the clicks landed; it
    // is scoped to nothing, so it works wherever the pointer is.
    if (e.key === 'Escape' && this.#host.measurePending !== null) {
      this.#host.cancelMeasurement();
      return;
    }
    // §13's Esc grammar (2026-08-30): `place` → `select` → off. Here, beside the measurement's Esc
    // and **before** the `viewId === null` return below, so it works with the pointer over the
    // panel — which is where a user's pointer is when they decide they are done placing.
    if (e.key === 'Escape' && this.#host.cancelPointTool()) return;
    const viewId = this.#hovered;
    if (viewId === null || e.ctrlKey || e.metaKey || e.altKey) return;
    // R2's keyboard half: `+` / `-` about the pane centre, `r` back to fit. Scoped to the pane under
    // the pointer, which is what makes them per-pane; the app's keymap keeps its own `r` for when
    // the pointer is nowhere near the canvas, and `resetView` is idempotent so the overlap is safe.
    switch (e.key) {
      case '+':
      case '=':
        this.#host.noteInput();
        this.#host.zoomView(viewId, 1 / ZOOM_STEP);
        e.preventDefault();
        break;
      case '-':
      case '_':
        this.#host.noteInput();
        this.#host.zoomView(viewId, ZOOM_STEP);
        e.preventDefault();
        break;
      case 'r':
      case 'R':
        this.#host.noteInput();
        this.#host.resetView(viewId);
        break;
      default:
        break;
    }
  };

  readonly #onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') this.#mods = { ...this.#mods, space: false };
  };

  /**
   * Canvas device pixels → the **latched** pane's local coordinates.
   *
   * Not `paneAt`: that answers for whichever pane is under the pointer, and half the point of
   * latching is that a drag which wanders into the neighbouring pane keeps reporting positions in
   * the pane it started in — negative and past-the-edge ones included, which is exactly what a pan
   * or a window/level drag needs.
   */
  #localTo(
    viewId: string | null,
    x: number,
    y: number
  ): { x: number; y: number; width: number; height: number } | null {
    if (viewId === null) return null;
    const rect = this.#host.paneRect(viewId);
    if (rect === null) return null;
    return { x: x - rect.x, y: y - rect.y, width: rect.width, height: rect.height };
  }

  /**
   * §13's cursor: `crosshair` while `place` mode is armed, `grab` over a point in `select` mode.
   *
   * The hit test behind the `grab` is the host's and runs only while `select` is armed; everything
   * else here is a string comparison. What it restores when the tool disarms is whatever the
   * embedder had on the canvas, not `''`.
   */
  #pointCursor(pane: PaneHit | null): void {
    const mode = this.#host.pointToolMode;
    let want: '' | 'grab' | 'crosshair' = '';
    if (mode !== null && pane !== null && !pane.is3D) {
      want =
        mode === 'place'
          ? 'crosshair'
          : this.#host.pointToolHover(pane.viewId, pane.x, pane.y)
            ? 'grab'
            : '';
    } else if (mode !== null) {
      // Off a 2D pane there is nothing to be over, and the hot ring must not stay behind.
      this.#host.pointToolHover(null, 0, 0);
    }
    if (want === this.#cursor) return;
    if (this.#cursor === '') this.#cursorWas = this.#canvas.style.cursor;
    this.#cursor = want;
    this.#canvas.style.cursor = want === '' ? (this.#cursorWas ?? '') : want;
  }

  #dispatch(
    g: ReturnType<GestureMachine['move']>[number],
    local: { x: number; y: number; width: number; height: number }
  ): void {
    switch (g.type) {
      case 'move':
        switch (g.kind) {
          case 'cursor':
            this.#host.setCursorFromScreen(g.viewId, g.x, g.y);
            break;
          case 'pan':
            this.#host.panView(g.viewId, g.dx, g.dy);
            break;
          case 'windowLevel':
            this.#host.windowLevelDrag(
              g.viewId,
              g.dx / Math.max(1, local.width),
              g.dy / Math.max(1, local.height)
            );
            break;
          case 'opacity':
            this.#host.opacityDrag(g.dy / Math.max(1, local.height));
            break;
          case 'orbit':
            this.#host.orbitView(g.viewId, g.dx, g.dy);
            break;
          case 'pan3d':
            this.#host.pan3DView(g.viewId, g.dx, g.dy);
            break;
          case 'gizmo':
            if (this.#gizmoHandle !== null) {
              this.#host.gizmoDrag(this.#gizmoHandle, g.dx, g.dy);
            }
            break;
          // §13: the point follows the pointer exactly, in the latched pane's coordinates — so a
          // drag that wanders out of the pane keeps moving the contact in the plane it started in.
          case 'point':
            this.#host.pointToolDrag(g.viewId, g.x, g.y);
            break;
        }
        break;
      case 'pinch':
        this.#host.zoomViewAt(g.viewId, g.x, g.y, g.factor);
        break;
      case 'twoFingerPan':
        this.#host.panView(g.viewId, g.dx, g.dy);
        break;
      default:
        break;
    }
  }
}
