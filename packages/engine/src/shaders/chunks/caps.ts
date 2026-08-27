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

// -------------------------------------------------------------------------------------------
// §7.4's clip planes — read by `shaders/mesh.ts` **and** `shaders/pick.ts`, because §7.2.3 makes
// the pick pass reproduce every discard of the main pass with "the same enable set". Appended
// here rather than exported from one of them so neither program owns the other's clip rule.
//
// Contract for a program that splices these: `CLIP_EXTENSION` goes **before** any precision
// qualifier (a `#extension` directive must precede every non-preprocessor token); `CLIP_WRITE`
// expects a `vec4 w` holding the world-space position in scope; `CLIP_DISCARD` expects a `vec3
// vWorld` varying and an `int uClipSkip` uniform.
// -------------------------------------------------------------------------------------------

/**
 * The two clip defines' defaults, spliced into both stages.
 *
 * They are `#ifndef`-guarded rather than always passed so that the N = 0 variant's assembled source
 * is byte-identical to Phase 1's apart from these comments — §7.4: "At N = 0: no `#extension`, no
 * redeclaration."
 */
export const CLIP_DEFINES = `#ifndef TVX_CLIP_PLANES
#define TVX_CLIP_PLANES 0
#endif
#ifndef TVX_CLIP_DISCARD
#define TVX_CLIP_DISCARD 0
#endif`;

/**
 * §7.4's `#extension … : require`, and it must come **before any non-preprocessor token** — which is
 * why it is spliced ahead of the precision qualifiers rather than beside the other declarations.
 *
 * `require`, never `enable`: a driver without the extension then fails to compile, which is what
 * trips the `discard` fallback instead of silently rendering unclipped geometry.
 */
export const CLIP_EXTENSION = `#if TVX_CLIP_PLANES > 0 && TVX_CLIP_DISCARD == 0
#extension GL_ANGLE_clip_cull_distance : require
#endif`;

/** The `vec4` plane uniforms, shared by both paths (`.xyz` = normal, `.w` = offset — §6.0's `Plane`). */
export const CLIP_UNIFORMS = `#if TVX_CLIP_PLANES > 0
uniform vec4 uClipPlanes[TVX_CLIP_PLANES];
#endif`;

/**
 * §7.4's "N **unrolled constant-index** assignments" — written out rather than looped, because
 * `gl_ClipDistance` indexing must be constant for the varying allocation the variant scheme pins.
 */
export const CLIP_WRITE = `#if TVX_CLIP_PLANES > 0 && TVX_CLIP_DISCARD == 0
  gl_ClipDistance[0] = dot(uClipPlanes[0].xyz, w.xyz) + uClipPlanes[0].w;
#if TVX_CLIP_PLANES > 1
  gl_ClipDistance[1] = dot(uClipPlanes[1].xyz, w.xyz) + uClipPlanes[1].w;
#endif
#if TVX_CLIP_PLANES > 2
  gl_ClipDistance[2] = dot(uClipPlanes[2].xyz, w.xyz) + uClipPlanes[2].w;
#endif
#if TVX_CLIP_PLANES > 3
  gl_ClipDistance[3] = dot(uClipPlanes[3].xyz, w.xyz) + uClipPlanes[3].w;
#endif
#if TVX_CLIP_PLANES > 4
  gl_ClipDistance[4] = dot(uClipPlanes[4].xyz, w.xyz) + uClipPlanes[4].w;
#endif
#if TVX_CLIP_PLANES > 5
  gl_ClipDistance[5] = dot(uClipPlanes[5].xyz, w.xyz) + uClipPlanes[5].w;
#endif
#endif`;

/**
 * The fallback's discard, and §7.4's cap rule inside it.
 *
 * `uClipSkip` is the plane whose own cap this draw is (−1 for everything else) — the fragment-shader
 * twin of `GlState.clipDistances(count, except)`. `< 0.0` and not `<= 0.0`: `gl_ClipDistance == 0.0`
 * keeps the primitive `[M2Max]`, so the fallback must keep it too or the two paths disagree on
 * exactly the pixels the cap rule is about.
 */
export const CLIP_DISCARD = `#if TVX_CLIP_PLANES > 0 && TVX_CLIP_DISCARD == 1
  for (int i = 0; i < TVX_CLIP_PLANES; ++i) {
    if (i != uClipSkip && dot(uClipPlanes[i].xyz, vWorld) + uClipPlanes[i].w < 0.0) discard;
  }
#endif`;
