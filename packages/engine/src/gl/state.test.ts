/**
 * The state tracker's two jobs, checked without a GL context: **a block is complete** (entering it
 * from any prior state ends in the same pipeline state) and **a no-op costs nothing** (re-entering
 * a block issues no call). The first is the merge boundary `docs/PHASE2-OWNERSHIP.md` needs — an
 * appended pass cannot inherit what the previous one left enabled — and the second is why
 * completeness is affordable per frame.
 */

import { describe, expect, it } from 'vitest';
import { CLIP_DISTANCE0_WEBGL, GL_STATE, GlState } from './state';

/** The GL enums this file touches, with WebGL's real values so the log is readable. */
const ENUM = {
  DEPTH_TEST: 0x0b71,
  BLEND: 0x0be2,
  CULL_FACE: 0x0b44,
  LESS: 0x0201,
  LEQUAL: 0x0203,
  BACK: 0x0405,
  FRONT: 0x0404,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
} as const;

const NAME = new Map<number, string>([
  [ENUM.DEPTH_TEST, 'DEPTH_TEST'],
  [ENUM.BLEND, 'BLEND'],
  [ENUM.CULL_FACE, 'CULL_FACE'],
  [ENUM.LESS, 'LESS'],
  [ENUM.LEQUAL, 'LEQUAL'],
  [ENUM.BACK, 'BACK'],
  [ENUM.FRONT, 'FRONT'],
  [ENUM.SRC_ALPHA, 'SRC_ALPHA'],
  [ENUM.ONE_MINUS_SRC_ALPHA, 'ONE_MINUS_SRC_ALPHA'],
  [CLIP_DISTANCE0_WEBGL, 'CLIP_DISTANCE0'],
  [CLIP_DISTANCE0_WEBGL + 1, 'CLIP_DISTANCE1'],
  [CLIP_DISTANCE0_WEBGL + 2, 'CLIP_DISTANCE2'],
]);

function label(v: number): string {
  return NAME.get(v) ?? String(v);
}

/**
 * A recording stand-in for `WebGL2RenderingContext` that also keeps the resulting state, so a test
 * can assert the *end state* rather than a call sequence — a tracker is allowed to reach it in
 * fewer calls, which is the point.
 */
function fakeGl(): {
  gl: WebGL2RenderingContext;
  log: string[];
  state: () => Record<string, unknown>;
} {
  const log: string[] = [];
  const caps = new Set<number>();
  let depthFunc = ENUM.LESS;
  let depthMask = true;
  let blendSrc = 1;
  let blendDst = 0;
  let cullFace = ENUM.BACK;
  const gl = {
    ...ENUM,
    enable(c: number): void {
      log.push(`enable(${label(c)})`);
      caps.add(c);
    },
    disable(c: number): void {
      log.push(`disable(${label(c)})`);
      caps.delete(c);
    },
    depthFunc(f: number): void {
      log.push(`depthFunc(${label(f)})`);
      depthFunc = f as typeof depthFunc;
    },
    depthMask(on: boolean): void {
      log.push(`depthMask(${String(on)})`);
      depthMask = on;
    },
    blendFunc(s: number, d: number): void {
      log.push(`blendFunc(${label(s)}, ${label(d)})`);
      blendSrc = s;
      blendDst = d;
    },
    cullFace(f: number): void {
      log.push(`cullFace(${label(f)})`);
      cullFace = f as typeof cullFace;
    },
  } as unknown as WebGL2RenderingContext;
  return {
    gl,
    log,
    state: () => ({
      depthTest: caps.has(ENUM.DEPTH_TEST),
      depthFunc: label(depthFunc),
      depthMask,
      blend: caps.has(ENUM.BLEND),
      // Unobservable while BLEND is off, and GL latches it across a disable, so a block that does
      // not blend is not required to leave any particular value here.
      blendFunc: caps.has(ENUM.BLEND) ? `${label(blendSrc)},${label(blendDst)}` : null,
      cullFaceEnabled: caps.has(ENUM.CULL_FACE),
      // Latched like `blendFunc`, and equally unobservable while the cap is disabled.
      cullFace: caps.has(ENUM.CULL_FACE) ? label(cullFace) : null,
      clip: [0, 1, 2, 3, 4, 5].map((i) => caps.has(CLIP_DISTANCE0_WEBGL + i)),
    }),
  };
}

const BLOCKS = Object.keys(GL_STATE) as (keyof typeof GL_STATE)[];

describe('GlState.apply', () => {
  it('reaches the same state from every other block — a block is complete', () => {
    // For each target block, enter it from each possible predecessor and compare end states. A
    // block that forgot a field would land in two different states depending on what ran before.
    for (const target of BLOCKS) {
      const ends = BLOCKS.map((from) => {
        const { gl, state } = fakeGl();
        const s = new GlState(gl);
        s.apply(GL_STATE[from]);
        s.apply(GL_STATE[target]);
        return state();
      });
      for (const end of ends) expect(end).toEqual(ends[0]);
    }
  });

  it('leaves depth writes on in every block a frame can end in', () => {
    // `gl.clear(DEPTH_BUFFER_BIT)` is masked by `depthMask`. `transparentBack`/`transparentFront`
    // are the two blocks that turn it off, and `passes/mesh.ts` re-applies `opaque3d` before it
    // returns for exactly this reason.
    expect(GL_STATE.opaque3d.depthMask).toBe(true);
    expect(GL_STATE.blend2d.depthMask).toBe(true);
    expect(GL_STATE.pick.depthMask).toBe(true);
  });

  it('issues nothing when the block is already current', () => {
    const { gl, log } = fakeGl();
    const s = new GlState(gl);
    s.apply(GL_STATE.blend2d);
    const after = log.length;
    s.apply(GL_STATE.blend2d);
    s.apply(GL_STATE.blend2d);
    expect(log.slice(after)).toEqual([]);
  });

  it('re-blends without re-issuing blendFunc, which GL keeps across a disable', () => {
    const { gl, log } = fakeGl();
    const s = new GlState(gl);
    s.apply(GL_STATE.blend2d);
    log.length = 0;
    s.apply(GL_STATE.opaque3d); // blend off
    s.apply(GL_STATE.blend2d); // blend on again
    expect(log.filter((c) => c.startsWith('blendFunc'))).toEqual([]);
  });

  it('reproduces the §7.2 pass sequence a 3D pane runs', () => {
    const { gl, state } = fakeGl();
    const s = new GlState(gl);
    s.apply(GL_STATE.opaque3d); // renderer: before the clear
    s.apply(GL_STATE.opaque3d); // pass 1
    s.cull('back');
    s.apply(GL_STATE.transparentBack); // 2a
    s.apply(GL_STATE.transparentFront); // 2b
    s.cull('none'); // faceMode 'both', last in 2b
    s.apply(GL_STATE.opaque3d); // pass exit
    s.apply(GL_STATE.blend2d); // pass 3
    expect(state()).toMatchObject({
      depthTest: false,
      depthMask: true,
      blend: true,
      blendFunc: 'SRC_ALPHA,ONE_MINUS_SRC_ALPHA',
      cullFaceEnabled: false,
    });
  });
});

describe('GlState.cull', () => {
  it('switches sides without a redundant enable', () => {
    const { gl, log } = fakeGl();
    const s = new GlState(gl);
    s.cull('back');
    log.length = 0;
    s.cull('front');
    expect(log).toEqual(['cullFace(FRONT)']);
  });

  it('disables the cap for none', () => {
    const { gl, state } = fakeGl();
    const s = new GlState(gl);
    s.cull('front');
    s.cull('none');
    expect(state()).toMatchObject({ cullFaceEnabled: false });
  });
});

describe('GlState clip distances', () => {
  it('issues no call while the set stays empty — safe without the extension', () => {
    // Phase 1 never enables one, and `gl.enable(0x3000)` on a context without
    // `WEBGL_clip_cull_distance` is an INVALID_ENUM. Tracking is what keeps that call unissued.
    const { gl, log } = fakeGl();
    const s = new GlState(gl);
    s.clipDistances(0);
    s.clipDistances(0);
    s.clipDistance(3, false);
    expect(log).toEqual([]);
  });

  it('enables count planes and honours the §7.4 cap rule exception', () => {
    const { gl, state } = fakeGl();
    const s = new GlState(gl);
    s.clipDistances(3);
    expect(state()).toMatchObject({ clip: [true, true, true, false, false, false] });
    // Drawing the cap generated by plane 1: that one plane off, the others still on.
    s.clipDistances(3, 1);
    expect(state()).toMatchObject({ clip: [true, false, true, false, false, false] });
    s.clipDistances(0);
    expect(state()).toMatchObject({ clip: [false, false, false, false, false, false] });
  });

  it('ignores an out-of-range index rather than emitting a wrong enum', () => {
    const { gl, log } = fakeGl();
    const s = new GlState(gl);
    s.clipDistance(-1, true);
    s.clipDistance(6, true);
    expect(log).toEqual([]);
  });
});

describe('GlState.invalidate', () => {
  it('returns the context to the GL defaults and forgets the cache', () => {
    const { gl, log, state } = fakeGl();
    const s = new GlState(gl);
    s.apply(GL_STATE.transparentBack);
    s.clipDistances(2);
    s.invalidate();
    expect(state()).toMatchObject({
      depthTest: false,
      depthFunc: 'LESS',
      depthMask: true,
      blend: false,
      cullFaceEnabled: false,
      clip: [false, false, false, false, false, false],
    });
    log.length = 0;
    // The cache now matches the defaults, so re-applying a default-shaped field issues nothing.
    s.apply(GL_STATE.opaque3d);
    expect(log).not.toContain('depthMask(true)');
  });
});
