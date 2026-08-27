/**
 * `Program` — compile/link, uniform cache, and the §7.1 **variant cache keyed on
 * `(colorMode, flatShading, isLabel, activeClipPlaneCount)`**.
 *
 * Why variants rather than uniform switches (§7.1, §7.4):
 * * Binding an integer texture to a `sampler3D` is `INVALID_OPERATION` `[M2Max]`, so `isLabel` must
 *   be a compile-time branch, not a uniform.
 * * On ANGLE/Metal each clip distance costs a **full varying vector** out of `MAX_VARYING_VECTORS`
 *   = 30, so a blanket `[6]` would tax every mesh program forever.
 *
 * No per-frame allocations: uniform locations are cached on first use and the variant map is keyed
 * by a plain string.
 */

export type ShaderDefines = Record<string, string | number | boolean>;

function definesToSource(defines: ShaderDefines): string {
  const keys = Object.keys(defines).sort();
  let out = '';
  for (const k of keys) {
    const v = defines[k];
    if (v === false || v === undefined) continue;
    out += `#define ${k} ${v === true ? '1' : String(v)}\n`;
  }
  return out;
}

/** `#version` must be the very first line, so defines are spliced in after it. */
function assemble(source: string, defines: ShaderDefines): string {
  const header = '#version 300 es\n';
  const body = source.startsWith(header) ? source.slice(header.length) : source;
  return header + definesToSource(defines) + body;
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const sh = gl.createShader(type);
  if (sh === null) throw new Error('createShader returned null');
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (gl.getShaderParameter(sh, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(sh) ?? '(no log)';
    gl.deleteShader(sh);
    const numbered = source
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
      .join('\n');
    throw new Error(
      `${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader failed to compile: ${log}\n${numbered}`
    );
  }
  return sh;
}

export class Program {
  readonly program: WebGLProgram;
  readonly #gl: WebGL2RenderingContext;
  readonly #uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(gl: WebGL2RenderingContext, vs: string, fs: string, defines: ShaderDefines = {}) {
    this.#gl = gl;
    const v = compile(gl, gl.VERTEX_SHADER, assemble(vs, defines));
    const f = compile(gl, gl.FRAGMENT_SHADER, assemble(fs, defines));
    const p = gl.createProgram();
    if (p === null) throw new Error('createProgram returned null');
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    // Shaders are deleted after link: the program keeps its own reference.
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (gl.getProgramParameter(p, gl.LINK_STATUS) !== true) {
      const log = gl.getProgramInfoLog(p) ?? '(no log)';
      gl.deleteProgram(p);
      throw new Error(`program failed to link: ${log}`);
    }
    this.program = p;
  }

  use(): void {
    this.#gl.useProgram(this.program);
  }

  /** Cached; a missing uniform yields `null` and every setter below is then a no-op. */
  loc(name: string): WebGLUniformLocation | null {
    let l = this.#uniforms.get(name);
    if (l === undefined) {
      l = this.#gl.getUniformLocation(this.program, name);
      this.#uniforms.set(name, l);
    }
    return l;
  }

  int(name: string, v: number): void {
    const l = this.loc(name);
    if (l !== null) this.#gl.uniform1i(l, v);
  }
  float(name: string, v: number): void {
    const l = this.loc(name);
    if (l !== null) this.#gl.uniform1f(l, v);
  }
  vec2(name: string, v: ArrayLike<number>): void {
    const l = this.loc(name);
    if (l !== null) this.#gl.uniform2fv(l, v as Float32List);
  }
  vec3(name: string, v: ArrayLike<number>): void {
    const l = this.loc(name);
    if (l !== null) this.#gl.uniform3fv(l, v as Float32List);
  }
  vec4(name: string, v: ArrayLike<number>): void {
    const l = this.loc(name);
    if (l !== null) this.#gl.uniform4fv(l, v as Float32List);
  }
  mat4(name: string, v: ArrayLike<number>): void {
    const l = this.loc(name);
    if (l !== null) this.#gl.uniformMatrix4fv(l, false, v as Float32List);
  }

  dispose(): void {
    this.#gl.deleteProgram(this.program);
  }
}

/** The §7.1 variant cache. One instance per (vs, fs) pair. */
export class ProgramVariants {
  readonly #gl: WebGL2RenderingContext;
  readonly #vs: string;
  readonly #fs: string;
  readonly #cache = new Map<string, Program>();

  constructor(gl: WebGL2RenderingContext, vs: string, fs: string) {
    this.#gl = gl;
    this.#vs = vs;
    this.#fs = fs;
  }

  get(defines: ShaderDefines): Program {
    const key = definesToSource(defines);
    let p = this.#cache.get(key);
    if (p === undefined) {
      p = new Program(this.#gl, this.#vs, this.#fs, defines);
      this.#cache.set(key, p);
    }
    return p;
  }

  dispose(): void {
    for (const p of this.#cache.values()) p.dispose();
    this.#cache.clear();
  }
}
