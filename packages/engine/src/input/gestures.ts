/**
 * The §7.5 gesture state machine — **pure**, and the only place that decides what a drag *means*.
 *
 * It knows nothing about the DOM, about GL or about the scene: it takes button numbers, modifier
 * flags and pane-local pixel positions, and emits {@link GestureEvent}s. `input/pointer.ts` feeds it
 * real `PointerEvent`s; `input/gestures.test.ts` feeds it a script. That split exists because the
 * interesting half of a pointer layer is the bookkeeping — which pane a drag belongs to once it has
 * left that pane, what happens when a second finger lands mid-drag, whether a `pointerup` for a
 * pointer that never went down is a crash — and none of that needs a browser to test.
 *
 * **The pane is latched at `pointerdown`.** Every later `pointermove` of that drag belongs to the
 * pane it started in, however far outside it the pointer travels; §7.5's gestures are per-pane and a
 * drag that changed pane mid-flight would set the cursor in one pane from a delta measured in
 * another. This is the same reason the DOM layer takes a pointer capture.
 */

/** Which of §7.5's gestures a press resolved to. */
export type GestureKind =
  /** 2D left-drag: the cursor follows the pointer (R1). */
  | 'cursor'
  /** 2D middle-drag / `space`+left-drag / two-finger drag: pan the pane (R3). */
  | 'pan'
  /** 2D right-drag: window/level on the active layer (R3). */
  | 'windowLevel'
  /** `Shift`+drag: the active layer's opacity (§7.5). */
  | 'opacity'
  /** 3D left-drag: arcball orbit. */
  | 'orbit'
  /** 3D right/middle-drag: pan the 3D camera target. */
  | 'pan3d'
  /** 3D left-drag that started on a cut-plane gizmo handle: manipulate the plane (§7.5). */
  | 'gizmo'
  /**
   * 2D left-drag that started **on a point** while §13's point tool is armed in `select` mode:
   * the point follows the pointer (2026-08-30).
   *
   * Appended, never inserted: the union is read by `pointer.ts`'s dispatch switch and by
   * `render/passes`, and a kind that changed position in the list would change nothing at all —
   * which is exactly why this note is here rather than in a commit message.
   */
  | 'point';

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  /** `space` held — §7.5's explicit pan modifier, tracked by the DOM layer. */
  space: boolean;
}

export const NO_MODIFIERS: Modifiers = {
  shift: false,
  ctrl: false,
  meta: false,
  alt: false,
  space: false,
};

/**
 * What the press landed **on**, as far as the pointer layer could tell before resolving anything.
 *
 * An options bag rather than a growing tail of positional booleans (2026-08-30): `overGizmo` was
 * the fourth argument and `overPoint` would have been the fifth, at which point every call site is
 * a row of bare `true`/`false` whose meaning is in this file rather than at the call. A plain
 * `boolean` is still accepted in that position and means `{ overGizmo }`, so nothing that predates
 * §13 changes.
 */
export interface GestureTargets {
  /** §7.5's cut-plane gizmo handle is under the press (3D panes only). */
  overGizmo?: boolean;
  /** §13's point tool is armed in `select` mode and a point is under the press (2D panes only). */
  overPoint?: boolean;
}

/**
 * Which gesture a press starts, from the button, the modifiers and the pane kind.
 *
 * §7.5, and R3 for the emphasis: *left-drag never pans*. Pan is middle-drag, `space`+left-drag or a
 * two-finger trackpad drag, and nothing else.
 *
 * `Shift` wins over everything because §7.5 binds `Shift+drag` to the active layer's opacity without
 * qualifying it by pane kind — it is a layer gesture, not a camera one, and it means the same thing
 * in the 3D pane as in a 2D one.
 */
export function resolveGesture(
  button: number,
  mods: Modifiers,
  is3D: boolean,
  targets: GestureTargets | boolean = false
): GestureKind | null {
  const over = typeof targets === 'boolean' ? { overGizmo: targets } : targets;
  // A platform modifier on the primary button is a menu accelerator or, on macOS, the OS's own
  // right-click emulation — which Chromium has already turned into `button === 2` by the time it
  // gets here. Either way it is not a drag.
  if (button === 0 && (mods.ctrl || mods.meta)) return null;
  if (mods.shift && button === 0) return 'opacity';
  if (is3D) {
    // §7.5's gizmo takes precedence over the orbit it would otherwise start: a handle the user can
    // see and aim at has to be grabbable, and the orbit is available everywhere else in the pane.
    if (button === 0 && over.overGizmo === true) return 'gizmo';
    if (button === 0) return 'orbit';
    if (button === 1 || button === 2) return 'pan3d';
    return null;
  }
  // §13's point tool (2026-08-30), in the **2D** branch and only here: the 3D pane has no point
  // drag in v1. It sits after the ctrl/meta and `Shift` branches above, so a platform-modified
  // click is still not a drag and `Shift`+drag over a contact is still the layer's opacity, and
  // before the `space` test below rather than inside it, so `space`+drag over a contact still pans
  // the pane. Those three are §7.5's, and a new tool does not get to quietly take them.
  if (button === 0 && !mods.space && over.overPoint === true) return 'point';
  if (button === 0) return mods.space ? 'pan' : 'cursor';
  if (button === 1) return 'pan';
  if (button === 2) return 'windowLevel';
  return null;
}

/** A pointer position in **pane-local device pixels, top-left origin**. */
export interface PanePoint {
  viewId: string;
  is3D: boolean;
  /** Pane-local, top-left origin. */
  x: number;
  y: number;
}

export type GestureEvent =
  | { type: 'begin'; kind: GestureKind; viewId: string; x: number; y: number }
  /** `dx`/`dy` are since the previous move of this drag; `x`/`y` are pane-local and may be outside. */
  | {
      type: 'move';
      kind: GestureKind;
      viewId: string;
      x: number;
      y: number;
      dx: number;
      dy: number;
    }
  | { type: 'end'; kind: GestureKind; viewId: string }
  /** Two pointers moved apart or together: zoom about their midpoint (R2's pinch). */
  | { type: 'pinch'; viewId: string; x: number; y: number; factor: number }
  /** Two pointers moved together in the same direction: pan (R3's two-finger drag). */
  | { type: 'twoFingerPan'; viewId: string; dx: number; dy: number };

interface Tracked {
  x: number;
  y: number;
}

/** Below this the pinch midpoint is numerically meaningless and the ratio explodes. */
const MIN_PINCH_SPAN_PX = 8;

/**
 * Turns a stream of pointer down/move/up into {@link GestureEvent}s.
 *
 * One instance per engine. It holds at most the pointers that are currently down, the gesture the
 * first of them started, and the pane that gesture belongs to.
 */
export class GestureMachine {
  readonly #down = new Map<number, Tracked>();
  #kind: GestureKind | null = null;
  #viewId: string | null = null;
  #primary: number | null = null;
  /** Set once a second pointer lands: the single-pointer gesture is over, this is a pinch. */
  #pinch: { span: number; midX: number; midY: number } | null = null;

  /** The gesture currently in flight, or `null`. */
  get kind(): GestureKind | null {
    return this.#kind;
  }

  /** True while any pointer is down or a pinch is in flight — §7.2's `interacting` source. */
  get active(): boolean {
    return this.#down.size > 0;
  }

  /** The pane the in-flight gesture was latched to at `pointerdown`. */
  get viewId(): string | null {
    return this.#viewId;
  }

  /**
   * A pointer went down. `targets` says what it landed on — see {@link GestureTargets}; a bare
   * `boolean` there is the pre-2026-08-30 spelling of `{ overGizmo }`.
   */
  down(
    pointerId: number,
    button: number,
    at: PanePoint,
    mods: Modifiers,
    targets: GestureTargets | boolean = false
  ): GestureEvent[] {
    const out: GestureEvent[] = [];
    this.#down.set(pointerId, { x: at.x, y: at.y });

    if (this.#down.size >= 2) {
      // A second finger cancels the one-pointer gesture rather than running both: a pinch that also
      // dragged the cursor would move the cursor every time the user zoomed.
      if (this.#kind !== null && this.#viewId !== null) {
        out.push({ type: 'end', kind: this.#kind, viewId: this.#viewId });
      }
      this.#kind = null;
      this.#primary = null;
      this.#pinch = this.#measurePinch();
      if (this.#viewId === null) this.#viewId = at.viewId;
      return out;
    }

    const kind = resolveGesture(button, mods, at.is3D, targets);
    if (kind === null) return out;
    this.#kind = kind;
    this.#viewId = at.viewId;
    this.#primary = pointerId;
    out.push({ type: 'begin', kind, viewId: at.viewId, x: at.x, y: at.y });
    return out;
  }

  move(pointerId: number, x: number, y: number): GestureEvent[] {
    const prev = this.#down.get(pointerId);
    if (prev === undefined) return [];
    const dx = x - prev.x;
    const dy = y - prev.y;
    prev.x = x;
    prev.y = y;

    const viewId = this.#viewId;
    if (viewId === null) return [];

    if (this.#down.size >= 2) {
      const before = this.#pinch;
      const now = this.#measurePinch();
      this.#pinch = now;
      if (before === null || now === null) return [];
      const out: GestureEvent[] = [];
      const panDx = now.midX - before.midX;
      const panDy = now.midY - before.midY;
      if (panDx !== 0 || panDy !== 0) {
        out.push({ type: 'twoFingerPan', viewId, dx: panDx, dy: panDy });
      }
      if (before.span >= MIN_PINCH_SPAN_PX && now.span >= MIN_PINCH_SPAN_PX) {
        const factor = before.span / now.span;
        if (factor !== 1) {
          out.push({ type: 'pinch', viewId, x: now.midX, y: now.midY, factor });
        }
      }
      return out;
    }

    if (this.#kind === null || pointerId !== this.#primary) return [];
    if (dx === 0 && dy === 0) return [];
    return [{ type: 'move', kind: this.#kind, viewId, x, y, dx, dy }];
  }

  up(pointerId: number): GestureEvent[] {
    if (!this.#down.delete(pointerId)) return [];
    const out: GestureEvent[] = [];
    if (this.#down.size >= 2) {
      this.#pinch = this.#measurePinch();
      return out;
    }
    this.#pinch = null;
    if (this.#kind !== null && this.#viewId !== null && pointerId === this.#primary) {
      out.push({ type: 'end', kind: this.#kind, viewId: this.#viewId });
    }
    if (this.#down.size === 0) {
      this.#kind = null;
      this.#primary = null;
      this.#viewId = null;
    }
    return out;
  }

  /** Drop everything — `pointercancel`, or the engine being destroyed mid-drag. */
  reset(): GestureEvent[] {
    const out: GestureEvent[] = [];
    if (this.#kind !== null && this.#viewId !== null) {
      out.push({ type: 'end', kind: this.#kind, viewId: this.#viewId });
    }
    this.#down.clear();
    this.#kind = null;
    this.#primary = null;
    this.#viewId = null;
    this.#pinch = null;
    return out;
  }

  #measurePinch(): { span: number; midX: number; midY: number } | null {
    const pts = [...this.#down.values()];
    const a = pts[0];
    const b = pts[1];
    if (a === undefined || b === undefined) return null;
    return {
      span: Math.hypot(b.x - a.x, b.y - a.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  }
}
