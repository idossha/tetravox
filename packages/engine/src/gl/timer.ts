/**
 * `Timer` — optional GPU timing via `EXT_disjoint_timer_query_webgl2` (§7.1).
 *
 * The named fallback when the extension is absent is **wall-clock frame time only**; `gpuMs` is then
 * simply `undefined` on the `frame` event, which is what the §8 status bar shows.
 *
 * A query's result is not available in the frame that issued it, so this keeps a small ring and
 * reports the most recent completed one. Never blocks.
 */

interface Ext {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class Timer {
  readonly available: boolean;
  readonly #gl: WebGL2RenderingContext;
  readonly #ext: Ext | null;
  readonly #pending: WebGLQuery[] = [];
  #active: WebGLQuery | null = null;
  #lastMs: number | undefined;

  constructor(gl: WebGL2RenderingContext, enabled: boolean) {
    this.#gl = gl;
    // The extension object must come from `getExtension`, which §7.1 confines to context creation —
    // but the *object* is what carries the enums, so it is re-requested here. Re-requesting returns
    // the same object and is not a second probe.
    this.#ext = enabled ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as Ext | null) : null;
    this.available = this.#ext !== null;
  }

  begin(): void {
    if (this.#ext === null || this.#active !== null) return;
    const q = this.#gl.createQuery();
    if (q === null) return;
    this.#gl.beginQuery(this.#ext.TIME_ELAPSED_EXT, q);
    this.#active = q;
  }

  end(): void {
    if (this.#ext === null || this.#active === null) return;
    this.#gl.endQuery(this.#ext.TIME_ELAPSED_EXT);
    this.#pending.push(this.#active);
    this.#active = null;
    this.#drain();
  }

  /** Milliseconds of the most recently completed query, or `undefined`. */
  get lastMs(): number | undefined {
    this.#drain();
    return this.#lastMs;
  }

  #drain(): void {
    const gl = this.#gl;
    if (this.#ext === null) return;
    const disjoint = gl.getParameter(this.#ext.GPU_DISJOINT_EXT) === true;
    while (this.#pending.length > 0) {
      const q = this.#pending[0];
      if (q === undefined) break;
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) !== true) break;
      this.#pending.shift();
      // A disjoint event invalidates the measurement; drop it rather than reporting a lie.
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        this.#lastMs = ns / 1e6;
      }
      gl.deleteQuery(q);
    }
    // Never let the ring grow without bound if results stop arriving.
    while (this.#pending.length > 8) {
      const q = this.#pending.shift();
      if (q !== undefined) gl.deleteQuery(q);
    }
  }

  dispose(): void {
    for (const q of this.#pending) this.#gl.deleteQuery(q);
    this.#pending.length = 0;
  }
}
