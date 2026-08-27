/**
 * The §7.5 gesture state machine (P2-01), tested without a DOM.
 *
 * R3's first clause — "**left-drag never pans** the image" — is a statement about this file and
 * nothing else, so it is asserted here as a property of the resolver rather than only through the
 * pixels of an e2e run.
 */

import { describe, expect, it } from 'vitest';
import { GestureMachine, NO_MODIFIERS, resolveGesture } from './gestures';
import type { Modifiers, PanePoint } from './gestures';

const mods = (patch: Partial<Modifiers> = {}): Modifiers => ({ ...NO_MODIFIERS, ...patch });
const pane2d: PanePoint = { viewId: 'axial', is3D: false, x: 10, y: 20 };
const pane3d: PanePoint = { viewId: 'view3d', is3D: true, x: 10, y: 20 };

describe('resolveGesture (§7.5, R3)', () => {
  it('binds the 2D buttons the way §7.5 lists them', () => {
    expect(resolveGesture(0, mods(), false)).toBe('cursor');
    expect(resolveGesture(1, mods(), false)).toBe('pan');
    expect(resolveGesture(2, mods(), false)).toBe('windowLevel');
    expect(resolveGesture(0, mods({ space: true }), false)).toBe('pan');
    expect(resolveGesture(0, mods({ shift: true }), false)).toBe('opacity');
  });

  it('R3: no combination of a plain left button ever pans', () => {
    for (const space of [false, true]) {
      for (const shift of [false, true]) {
        const kind = resolveGesture(0, mods({ space, shift }), false);
        // `space` is the one explicit pan modifier R3 allows; without it left-drag is never a pan.
        if (!space) expect(kind).not.toBe('pan');
      }
    }
  });

  it('binds the 3D buttons: left orbit, right/middle pan', () => {
    expect(resolveGesture(0, mods(), true)).toBe('orbit');
    expect(resolveGesture(2, mods(), true)).toBe('pan3d');
    expect(resolveGesture(1, mods(), true)).toBe('pan3d');
    // `Shift+drag` is a *layer* gesture and means the same thing in every pane.
    expect(resolveGesture(0, mods({ shift: true }), true)).toBe('opacity');
  });

  it('declines a platform-modified primary button — that is a menu accelerator, not a drag', () => {
    expect(resolveGesture(0, mods({ meta: true }), false)).toBeNull();
    expect(resolveGesture(0, mods({ ctrl: true }), false)).toBeNull();
    expect(resolveGesture(4, mods(), false)).toBeNull();
  });
});

describe('GestureMachine', () => {
  it('emits begin / move / end and reports the drag as active in between', () => {
    const m = new GestureMachine();
    expect(m.active).toBe(false);
    expect(m.down(1, 0, pane2d, mods())).toEqual([
      { type: 'begin', kind: 'cursor', viewId: 'axial', x: 10, y: 20 },
    ]);
    expect(m.active).toBe(true);
    expect(m.move(1, 30, 25)).toEqual([
      { type: 'move', kind: 'cursor', viewId: 'axial', x: 30, y: 25, dx: 20, dy: 5 },
    ]);
    expect(m.up(1)).toEqual([{ type: 'end', kind: 'cursor', viewId: 'axial' }]);
    expect(m.active).toBe(false);
    expect(m.kind).toBeNull();
  });

  it('latches the pane at pointerdown: a drag that leaves the pane still belongs to it', () => {
    const m = new GestureMachine();
    m.down(1, 1, pane2d, mods());
    // Pane-local coordinates go negative and past the edge; the viewId never changes.
    const out = m.move(1, -50, 900);
    expect(out).toEqual([
      { type: 'move', kind: 'pan', viewId: 'axial', x: -50, y: 900, dx: -60, dy: 880 },
    ]);
    expect(m.viewId).toBe('axial');
  });

  it('reports deltas since the previous move, not since the press', () => {
    const m = new GestureMachine();
    m.down(1, 0, pane2d, mods());
    expect(m.move(1, 20, 20)[0]).toMatchObject({ dx: 10, dy: 0 });
    expect(m.move(1, 25, 30)[0]).toMatchObject({ dx: 5, dy: 10 });
  });

  it('ignores a move for a pointer that is not down, and an up for one that never went down', () => {
    const m = new GestureMachine();
    expect(m.move(7, 1, 1)).toEqual([]);
    expect(m.up(7)).toEqual([]);
  });

  it('drops the one-pointer gesture when a second finger lands, and pinches instead', () => {
    const m = new GestureMachine();
    m.down(1, 0, pane2d, mods());
    const second = m.down(2, 0, { ...pane2d, x: 110, y: 20 }, mods());
    // The cursor drag ends rather than running alongside the pinch.
    expect(second).toEqual([{ type: 'end', kind: 'cursor', viewId: 'axial' }]);
    expect(m.kind).toBeNull();

    // Spread the fingers from 100 px apart to 200: the view zooms IN, so mmPerPx must shrink and the
    // factor (which multiplies mmPerPx) must be < 1.
    const out = m.move(2, 210, 20);
    const pinch = out.find((g) => g.type === 'pinch');
    expect(pinch).toBeDefined();
    expect(pinch!.type === 'pinch' && pinch!.factor).toBeCloseTo(100 / 200, 9);
    // The midpoint moved 50 px right, which is also a two-finger pan.
    const pan = out.find((g) => g.type === 'twoFingerPan');
    expect(pan).toBeDefined();
    expect(pan!.type === 'twoFingerPan' && pan!.dx).toBeCloseTo(50, 9);
  });

  it('two fingers translated by the same delta pan by it and net-zoom by exactly 1', () => {
    // Pointer events arrive **one pointer at a time**, so a two-finger translation is two separate
    // moves and the span wobbles in between: an intermediate pinch factor is unavoidable and is not
    // a bug. What must hold is that the completed gesture is a pure translation — the factors
    // multiply back to 1 and the pans sum to the common delta.
    const m = new GestureMachine();
    m.down(1, 0, pane2d, mods());
    m.down(2, 0, { ...pane2d, x: 110, y: 20 }, mods());
    const out = [...m.move(1, 40, 50), ...m.move(2, 140, 50)];
    let zoom = 1;
    let dx = 0;
    let dy = 0;
    for (const g of out) {
      if (g.type === 'pinch') zoom *= g.factor;
      if (g.type === 'twoFingerPan') {
        dx += g.dx;
        dy += g.dy;
      }
    }
    expect(zoom).toBeCloseTo(1, 9);
    expect(dx).toBeCloseTo(30, 9);
    expect(dy).toBeCloseTo(30, 9);
  });

  it('reset() ends the gesture and forgets every pointer', () => {
    const m = new GestureMachine();
    m.down(1, 2, pane3d, mods());
    expect(m.reset()).toEqual([{ type: 'end', kind: 'pan3d', viewId: 'view3d' }]);
    expect(m.active).toBe(false);
    expect(m.move(1, 5, 5)).toEqual([]);
  });
});
