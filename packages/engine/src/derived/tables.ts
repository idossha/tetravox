/**
 * **Table textures** — the one mechanism every derived draw uses to read a per-triangle or
 * per-element value without a per-vertex attribute.
 *
 * §7.4 already names it for the mesh path: a de-indexed draw reads "the per-face scalar from
 * `texelFetch(elmFieldTex, ivec2(...), 0)` at `gl_VertexID / 3`". This file is that, generalised to
 * the three element types the derived programs need — `R32F` for a field, `R32UI` for an id table,
 * `RGBA8` for the tag LUT — with one rule behind all of it:
 *
 * **Nothing here builds an array.** Every upload is a `TypedArray` exactly as the worker produced it
 * (§5 rule 7, AGENTS rule 7): the cut's `tag` reaches the GPU as a zero-copy `Uint32Array` *view*
 * over the worker's `Int32Array` buffer, not as a converted copy, and a field texture is the
 * `field` op's own `Float32Array`. The only array this file allocates is the tag LUT, which is
 * `4 · (maxTag + 1)` bytes — 8 KB for the SEEG meshes' tag 2102, against 24 bytes per *triangle* for
 * the per-vertex attribute it replaces.
 *
 * Rows rather than one long row because `MAX_TEXTURE_SIZE` is only guaranteed to be 2048 in WebGL2,
 * and ernie's mid-axial cut alone is 62,966 triangles `[M2Max]`.
 */

/** Row width of every table. Inside WebGL2's guaranteed `MAX_TEXTURE_SIZE` of 2048. */
export const TABLE_W = 1024;

export type TableKind = 'f32' | 'u32' | 'rgba8';

export interface Table {
  texture: WebGLTexture;
  /** Row width, in texels — the shader's `% w` / `/ w`. */
  width: number;
  /** Allocated rows. `width · rows` is the capacity a rewrite must fit. */
  rows: number;
  /** How many texels carry data; the tail of the last row is padding. */
  count: number;
}

function rowsFor(count: number, width: number): number {
  return Math.max(1, Math.ceil(Math.max(1, count) / width));
}

/**
 * Upload one table.
 *
 * `data` is read as-is. For `'u32'` an `Int32Array` is accepted and reinterpreted through a
 * `Uint32Array` view over the same buffer — Gmsh tags and element numbers are non-negative, and the
 * shader clamps anything that is not, so the reinterpretation is total.
 */
export function createTable(
  gl: WebGL2RenderingContext,
  kind: TableKind,
  data: Float32Array | Uint32Array | Int32Array | Uint8Array,
  countOverride?: number,
  capacityOverride?: number
): Table {
  const count = countOverride ?? (kind === 'rgba8' ? data.length / 4 : data.length);
  const width = TABLE_W;
  const rows = rowsFor(Math.max(count, capacityOverride ?? 0), width);
  const tex = gl.createTexture();
  if (tex === null) throw new Error('createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  switch (kind) {
    case 'f32':
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, width, rows);
      break;
    case 'u32':
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, width, rows);
      break;
    case 'rgba8':
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, rows);
      break;
  }
  // R32F and R32UI are not filterable; NEAREST is the only legal filter and §7.1's invariant makes
  // leaving LINEAR on a non-filterable format a silently black texture.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const table: Table = { texture: tex, width, rows, count };
  writeTable(gl, table, kind, data, count);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return table;
}

/**
 * Overwrite a table's contents in place.
 *
 * The caller has already checked the capacity — {@link tableFits} — because a table, like §7.4's cap
 * VBO set, grows by doubling and is never shrunk during a drag.
 */
export function writeTable(
  gl: WebGL2RenderingContext,
  table: Table,
  kind: TableKind,
  data: Float32Array | Uint32Array | Int32Array | Uint8Array,
  count: number
): void {
  const width = table.width;
  gl.bindTexture(gl.TEXTURE_2D, table.texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  // Full rows first, then the ragged tail, so no padding has to be allocated.
  const full = Math.floor(count / width);
  if (kind === 'rgba8') {
    const src = data as Uint8Array;
    if (full > 0) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        full,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        src.subarray(0, full * width * 4)
      );
    }
    const tail = count - full * width;
    if (tail > 0) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        full,
        tail,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        src.subarray(full * width * 4, count * 4)
      );
    }
  } else {
    const fmt = kind === 'f32' ? gl.RED : gl.RED_INTEGER;
    const type = kind === 'f32' ? gl.FLOAT : gl.UNSIGNED_INT;
    const src =
      kind === 'u32' && data instanceof Int32Array
        ? new Uint32Array(data.buffer, data.byteOffset, data.length)
        : (data as Float32Array | Uint32Array);
    if (full > 0) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        full,
        fmt,
        type,
        src.subarray(0, full * width) as ArrayBufferView
      );
    }
    const tail = count - full * width;
    if (tail > 0) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        full,
        tail,
        1,
        fmt,
        type,
        src.subarray(full * width, count) as ArrayBufferView
      );
    }
  }
  table.count = count;
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/** Whether `count` texels still fit the storage `table` was allocated with. */
export function tableFits(table: Table, count: number): boolean {
  return count <= table.rows * table.width;
}

/**
 * Rewrite a table, growing it **by doubling** when the new contents do not fit.
 *
 * The same rule §7.4 states for the cap VBO set — "grown by doubling, never shrunk during a drag" —
 * because a sweep re-cuts at 30 fps and a per-step reallocation is the one thing that would put a
 * `texStorage2D` in the frame budget.
 */
export function updateTable(
  gl: WebGL2RenderingContext,
  table: Table | null,
  kind: TableKind,
  data: Float32Array | Uint32Array | Int32Array | Uint8Array,
  count: number
): Table {
  if (table !== null && tableFits(table, count)) {
    writeTable(gl, table, kind, data, count);
    return table;
  }
  if (table !== null) gl.deleteTexture(table.texture);
  const capacity = Math.max(count, table === null ? 0 : table.rows * table.width * 2);
  return createTable(gl, kind, data, count, capacity);
}
