/**
 * `gl/state.ts` — the one object that knows what GL state is currently set.
 *
 * WebGL state is **global and survives `useProgram`**, so a pass that only sets the bits it cares
 * about inherits the rest from whichever pass ran before it. §7.2 fixes the pass *order* but not the
 * state each pass enters with, and `docs/PHASE2-OWNERSHIP.md` makes `render/renderer.ts` an
 * append-only file — a fifth and sixth pass (E-DERIVED's contours, E-SCENE's gizmo items) get
 * appended to the sequence and would silently inherit whatever the fourth left enabled.
 *
 * The rule this file enforces: **a pass never issues a raw depth / blend / cull call, and every
 * block is complete.** {@link GlState.apply} takes one of the five named {@link GL_STATE} blocks,
 * each of which names *every* tracked field, so entering a pass puts the pipeline in a fully
 * determined state no matter what ran before it. The tracker then issues only the calls that
 * actually change, so completeness costs nothing per frame.
 *
 * **What is tracked:** `DEPTH_TEST`, `depthFunc`, `depthMask`, `BLEND`, `blendFunc`, `CULL_FACE`,
 * `cullFace`, and the `WEBGL_clip_cull_distance` enable set. **What is not:** `SCISSOR_TEST` and the
 * scissor box, which `render/renderer.ts` and `engine.ts` set around whole frames and panes rather
 * than per pass, and which the pick pass narrows to its read window. Two owners for one piece of
 * state is how a tracker goes stale, so scissor stays entirely outside this file.
 *
 * **The clear depends on this too.** `gl.clear(DEPTH_BUFFER_BIT)` is masked by `depthMask`, so
 * `Renderer.renderView` applies a block before clearing rather than trusting the previous pane's
 * last pass to have restored it.
 *
 * **Shared-file rule (see `docs/PHASE2-OWNERSHIP.md`): additive only.** Append a block to
 * {@link GL_STATE}; never change what an existing block means, because a block is read by passes
 * two owners apart.
 */

/** Which faces are culled. `'none'` disables `CULL_FACE` rather than culling nothing. */
export type CullMode = 'none' | 'back' | 'front';

/** §7.2's depth comparisons: `LEQUAL` for the frame (co-planar quads), `LESS` for the pick FBO. */
export type DepthCompare = 'less' | 'lequal';

/** `'off'` disables `BLEND`; `'srcAlpha'` is `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` — §7.2's only mode. */
export type BlendMode = 'off' | 'srcAlpha';

/** A **complete** description of the tracked pipeline state. Every field is mandatory by design. */
export interface StateBlock {
  readonly depthTest: boolean;
  /** Ignored by GL while `depthTest` is false; named anyway so a block is never half-specified. */
  readonly depthFunc: DepthCompare;
  readonly depthMask: boolean;
  readonly blend: BlendMode;
  readonly cull: CullMode;
}

/**
 * The named state blocks, one per thing §7.2 draws.
 *
 * * `opaque3d` — pass 1, and the state a frame is cleared in.
 * * `blend2d` — the 2D slice pass (§7.3: depth test off for the whole pass, compositing is layer
 *   order) and pass 3, the overlay.
 * * `transparentBack` / `transparentFront` — §7.2's two-phase split, 2a then 2b.
 * * `pick` — §7.2.3, on its own FBO. `LESS`, not `LEQUAL`: the pick pass resolves the nearest id and
 *   has no co-planar-quad problem to solve.
 */
export const GL_STATE = {
  opaque3d: {
    depthTest: true,
    depthFunc: 'lequal',
    depthMask: true,
    blend: 'off',
    cull: 'none',
  },
  blend2d: {
    depthTest: false,
    depthFunc: 'lequal',
    depthMask: true,
    blend: 'srcAlpha',
    cull: 'none',
  },
  transparentBack: {
    depthTest: true,
    depthFunc: 'lequal',
    depthMask: false,
    blend: 'srcAlpha',
    cull: 'front',
  },
  transparentFront: {
    depthTest: true,
    depthFunc: 'lequal',
    depthMask: false,
    blend: 'srcAlpha',
    cull: 'back',
  },
  pick: {
    depthTest: true,
    depthFunc: 'less',
    depthMask: true,
    blend: 'off',
    cull: 'none',
  },
} as const satisfies Record<string, StateBlock>;

export type StateBlockName = keyof typeof GL_STATE;

/**
 * `WEBGL_clip_cull_distance`'s first clip distance enable. The extension object exposes it, but the
 * value is fixed by the spec and the enum is needed on the `gl` object, not the extension object.
 *
 * **Never `CULL_DISTANCE`** — §7.1's lint forbids the identifier outright.
 */
export const CLIP_DISTANCE0_WEBGL = 0x3000;

/** §7.4's ceiling. Six is the contract's number, not the implementation's maximum. */
export const MAX_CLIP_PLANES = 6;

export class GlState {
  readonly #gl: WebGL2RenderingContext;

  // Seeded with the GL defaults, which is what a freshly created context has. `createContext` sets
  // no pipeline state, so this is accurate at construction; `invalidate()` exists for the day
  // something outside this file does.
  #depthTest = false;
  #depthFunc: DepthCompare = 'less';
  #depthMask = true;
  #blend: BlendMode = 'off';
  /**
   * The latched `blendFunc`, tracked apart from the enable bit: GL keeps the factors across a
   * `disable(BLEND)`, so re-enabling `srcAlpha` later costs one `enable` and nothing else.
   */
  #blendFunc: 'default' | 'srcAlpha' = 'default';
  #cull: CullMode = 'none';
  readonly #clip: boolean[] = new Array<boolean>(MAX_CLIP_PLANES).fill(false);

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl;
  }

  /** Enter a named block. Issues only the calls that change. */
  apply(block: StateBlock): void {
    this.#setDepthTest(block.depthTest);
    this.#setDepthFunc(block.depthFunc);
    this.#setDepthMask(block.depthMask);
    this.#setBlend(block.blend);
    this.cull(block.cull);
  }

  /**
   * The one per-draw override a block does not cover: §7.4's `faceMode`, which is a property of the
   * layer being drawn and changes inside pass 1 and inside 2b.
   */
  cull(mode: CullMode): void {
    if (this.#cull === mode) return;
    const gl = this.#gl;
    if (mode === 'none') {
      gl.disable(gl.CULL_FACE);
    } else {
      if (this.#cull === 'none') gl.enable(gl.CULL_FACE);
      gl.cullFace(mode === 'back' ? gl.BACK : gl.FRONT);
    }
    this.#cull = mode;
  }

  /**
   * §7.4's cap rule, centralised: *when drawing the cap generated by plane `i`, disable
   * `CLIP_DISTANCE0_WEBGL + i` for that draw while leaving the others enabled.* `count` planes are
   * enabled, minus `except`.
   *
   * Nothing in Phase 1 enables a clip distance, and because this tracks state it issues **no call**
   * while the set stays empty — which is what keeps it safe on a context without
   * `WEBGL_clip_cull_distance`, where `gl.enable(0x3000)` would be an `INVALID_ENUM`. E-MESH gates
   * the first `clipDistances(n > 0)` on `caps.clipDistance`; the `discard` fallback never calls
   * this at all.
   */
  clipDistances(count: number, except?: number): void {
    for (let i = 0; i < MAX_CLIP_PLANES; i += 1) {
      this.clipDistance(i, i < count && i !== except);
    }
  }

  /** One clip distance. Idempotent, and a no-op when the tracked value already matches. */
  clipDistance(index: number, on: boolean): void {
    if (index < 0 || index >= MAX_CLIP_PLANES) return;
    if (this.#clip[index] === on) return;
    const gl = this.#gl;
    const cap = CLIP_DISTANCE0_WEBGL + index;
    if (on) gl.enable(cap);
    else gl.disable(cap);
    this.#clip[index] = on;
  }

  /**
   * Forget everything and re-issue on the next `apply`. For a context whose state was changed behind
   * this object's back — a test harness, or a future embedder that shares the context.
   */
  invalidate(): void {
    const gl = this.#gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    for (let i = 0; i < MAX_CLIP_PLANES; i += 1) {
      if (this.#clip[i] === true) gl.disable(CLIP_DISTANCE0_WEBGL + i);
      this.#clip[i] = false;
    }
    this.#depthTest = false;
    this.#depthFunc = 'less';
    this.#depthMask = true;
    this.#blend = 'off';
    this.#cull = 'none';
  }

  #setDepthTest(on: boolean): void {
    if (this.#depthTest === on) return;
    const gl = this.#gl;
    if (on) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    this.#depthTest = on;
  }

  #setDepthFunc(f: DepthCompare): void {
    if (this.#depthFunc === f) return;
    const gl = this.#gl;
    gl.depthFunc(f === 'less' ? gl.LESS : gl.LEQUAL);
    this.#depthFunc = f;
  }

  #setDepthMask(on: boolean): void {
    if (this.#depthMask === on) return;
    this.#gl.depthMask(on);
    this.#depthMask = on;
  }

  #setBlend(mode: BlendMode): void {
    if (this.#blend === mode) return;
    const gl = this.#gl;
    if (mode === 'off') {
      gl.disable(gl.BLEND);
    } else {
      gl.enable(gl.BLEND);
      if (this.#blendFunc !== 'srcAlpha') {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this.#blendFunc = 'srcAlpha';
      }
    }
    this.#blend = mode;
  }
}
