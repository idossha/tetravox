/**
 * `Texture2D` / `Texture3D` (§7.1).
 *
 * **Invariant, and the reason this file exists rather than raw `gl.*` calls at each site:** never
 * leave `TEXTURE_MIN/MAG_FILTER = LINEAR` on a format `caps` says is not filterable. The texture
 * becomes incomplete and samples **0 with no GL error** `[M2Max]` — a silently black volume.
 * `create3D` therefore takes `filterable` and refuses to set LINEAR without it.
 */

import type { GpuScalarFormat } from '../scene/types';

export interface Format3D {
  internalFormat: GLenum;
  format: GLenum;
  type: GLenum;
  /** `usampler3D` rather than `sampler3D` — a compile-time shader branch (§7.1). */
  integer: boolean;
  bytesPerVoxel: number;
}

/** `EXT_texture_norm16`'s `R16_EXT`. Not in the WebGL2 core enum set. */
const R16_EXT = 0x822a;

export function format3D(gl: WebGL2RenderingContext, f: GpuScalarFormat): Format3D {
  switch (f) {
    case 'R8':
      return {
        internalFormat: gl.R8,
        format: gl.RED,
        type: gl.UNSIGNED_BYTE,
        integer: false,
        bytesPerVoxel: 1,
      };
    case 'R8UI':
      return {
        internalFormat: gl.R8UI,
        format: gl.RED_INTEGER,
        type: gl.UNSIGNED_BYTE,
        integer: true,
        bytesPerVoxel: 1,
      };
    case 'R16':
      return {
        internalFormat: R16_EXT,
        format: gl.RED,
        type: gl.UNSIGNED_SHORT,
        integer: false,
        bytesPerVoxel: 2,
      };
    case 'R16UI':
      return {
        internalFormat: gl.R16UI,
        format: gl.RED_INTEGER,
        type: gl.UNSIGNED_SHORT,
        integer: true,
        bytesPerVoxel: 2,
      };
    case 'R16F':
      return {
        internalFormat: gl.R16F,
        format: gl.RED,
        type: gl.HALF_FLOAT,
        integer: false,
        bytesPerVoxel: 2,
      };
    case 'R32F':
      return {
        internalFormat: gl.R32F,
        format: gl.RED,
        type: gl.FLOAT,
        integer: false,
        bytesPerVoxel: 4,
      };
    case 'RGBA8':
      return {
        internalFormat: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        integer: false,
        bytesPerVoxel: 4,
      };
  }
}

/** Bytes-per-voxel for a §6.1 payload format, without needing a GL context. */
export function bytesPerVoxel(f: GpuScalarFormat): number {
  return f === 'R8' || f === 'R8UI' ? 1 : f === 'R32F' || f === 'RGBA8' ? 4 : 2;
}

function viewFor(fmt: Format3D, bytes: ArrayBuffer): ArrayBufferView {
  switch (fmt.type) {
    case 0x1401: // UNSIGNED_BYTE
      return new Uint8Array(bytes);
    case 0x1403: // UNSIGNED_SHORT
      return new Uint16Array(bytes);
    case 0x140b: // HALF_FLOAT
      return new Uint16Array(bytes);
    case 0x1406: // FLOAT
      return new Float32Array(bytes);
    default:
      return new Uint8Array(bytes);
  }
}

export interface Upload3DOptions {
  dims: [number, number, number];
  format: GpuScalarFormat;
  bytes: ArrayBuffer;
  /** LINEAR is legal on this format on this GPU — from the §6.1 payload, not guessed here. */
  filterable: boolean;
  /** The layer's reading preference; downgraded to NEAREST when `filterable` is false. */
  linear: boolean;
  /** Upload as z-slabs (§7.3). */
  chunked: boolean;
}

/**
 * Allocate with `texStorage3D` and upload, in z-slabs when `chunked`.
 *
 * §7.3 measured one-shot upload at 69–96 ms for the 416 MB R32F case and 9–16 ms for the 52 MB one
 * `[M2Max]`, and calls it a **load-time hitch, not an interactive one** — so this slabs to bound a
 * single call, and deliberately does **not** build a per-frame upload budget scheduler.
 */
export function createTexture3D(
  gl: WebGL2RenderingContext,
  o: Upload3DOptions
): { texture: WebGLTexture; fmt: Format3D } {
  const fmt = format3D(gl, o.format);
  const tex = gl.createTexture();
  if (tex === null) throw new Error('createTexture returned null');
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texStorage3D(gl.TEXTURE_3D, 1, fmt.internalFormat, o.dims[0], o.dims[1], o.dims[2]);

  // The invariant. An integer format is never filterable, whatever the caller asks for.
  const linear = o.linear && o.filterable && !fmt.integer;
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

  const view = viewFor(fmt, o.bytes);
  const perZ = o.dims[0] * o.dims[1];
  const elemPerVoxel =
    view.byteLength /
    (perZ * o.dims[2]) /
    (view as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
  if (!o.chunked) {
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      0,
      0,
      0,
      o.dims[0],
      o.dims[1],
      o.dims[2],
      fmt.format,
      fmt.type,
      view
    );
  } else {
    // ~32 MB slabs (§7.3).
    const bytesPerZ = perZ * fmt.bytesPerVoxel;
    const zPerSlab = Math.max(1, Math.floor((32 * 1024 * 1024) / Math.max(1, bytesPerZ)));
    const Ctor = (
      view as unknown as {
        constructor: new (b: ArrayBuffer, o: number, l: number) => ArrayBufferView;
      }
    ).constructor;
    const bpe = (view as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
    for (let z = 0; z < o.dims[2]; z += zPerSlab) {
      const depth = Math.min(zPerSlab, o.dims[2] - z);
      const offsetElems = z * perZ * elemPerVoxel;
      const lengthElems = depth * perZ * elemPerVoxel;
      const slab = new Ctor(o.bytes, offsetElems * bpe, lengthElems);
      gl.texSubImage3D(
        gl.TEXTURE_3D,
        0,
        0,
        0,
        z,
        o.dims[0],
        o.dims[1],
        depth,
        fmt.format,
        fmt.type,
        slab
      );
    }
  }
  gl.bindTexture(gl.TEXTURE_3D, null);
  return { texture: tex, fmt };
}

/** An `N×1 RGBA8` texture — colormap LUTs (§7.6) and label palettes (§7.3). */
export function createLut(gl: WebGL2RenderingContext, rgba: Uint8Array): WebGLTexture {
  const tex = gl.createTexture();
  if (tex === null) throw new Error('createTexture returned null');
  const width = rgba.length / 4;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  // NEAREST: a colormap LUT is sampled at the exact texel the normalised value selects, and a label
  // palette must never blend two labels' colours.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/** A single-channel 8-bit 2D texture — the §7 overlay's bitmap font atlas. */
export function createAlpha2D(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  data: Uint8Array
): WebGLTexture {
  const tex = gl.createTexture();
  if (tex === null) throw new Error('createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, height);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}
