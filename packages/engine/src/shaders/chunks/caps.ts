/**
 * Shader preamble chunks — the `#version` line and the precision qualifiers every program needs.
 *
 * These are **text**, not `#include` machinery: `Program` splices `#define`s in after the `#version`
 * line (`gl/program.ts`), so a chunk is simply a string a program interpolates. Keeping them here
 * means the two facts §7.1 pins about qualifiers live in one place:
 *
 * * ESSL 3.00 has **no default precision for `int` in a fragment shader**, nor for any sampler type,
 *   so every program that declares one has to say so or fail to compile.
 * * Binding an integer texture to a `sampler3D` is `INVALID_OPERATION` `[M2Max]`, which is why the
 *   slice program is compiled in two variants keyed on `IS_LABEL` and declares **both** sampler
 *   precisions — the `#if` picks which one is actually used.
 *
 * **Shared-file rule (see `docs/PHASE2-OWNERSHIP.md`): additive only, and this file is nobody's.**
 * All four programs interpolate it — `shaders/{slice,mesh,pick,overlay}.ts` — so it sits in
 * E-SLICE's directory without being E-SLICE's file. Append a chunk; never edit one another program
 * already reads.
 *
 * Named `caps` because these are the capability-shaped half of a program's header: what the compiler
 * must be told before the driver's own defaults decide for it.
 */

export const VERSION = '#version 300 es';

export const PRECISION_FLOAT = 'precision highp float;';
export const PRECISION_INT = 'precision highp int;';
export const PRECISION_SAMPLER3D = 'precision highp sampler3D;';
export const PRECISION_USAMPLER3D = 'precision highp usampler3D;';
export const PRECISION_USAMPLER2D = 'precision highp usampler2D;';
/**
 * `sampler2D` at `highp`, for the §7.4 mesh program's node/element **field** table and its label
 * palette. Both are `texelFetch`ed by an index that reaches into the millions (ernie's element field
 * is n = 5,900,498 `[DATA]`), and a `mediump` sampler coordinate would quantise it.
 */
export const PRECISION_SAMPLER2D = 'precision highp sampler2D;';

/**
 * The two `R32UI` outputs every pick fragment shader writes (§7.2.3).
 *
 * `COLOR_ATTACHMENT1` carries depth, because WebGL2 restricts `readPixels` to RGBA / RGBA_INTEGER
 * and the implementation-defined format — `DEPTH_COMPONENT` is not a legal read format, so the depth
 * attachment can never be read back.
 */
export const PICK_OUTPUTS = `layout(location = 0) out uint outId;
layout(location = 1) out uint outDepth;`;

/** `gl_FragCoord.z` reinterpreted as the uint the pick pass reads back and unprojects with. */
export const PICK_WRITE_DEPTH = 'outDepth = floatBitsToUint(gl_FragCoord.z);';
