/**
 * **Host protocol v1** — the message contract between a host page and an embedded Tetravox
 * (`docs/EMBED.md`).
 *
 * Every message, in both directions, is a JSON object carrying `tvx: 1`:
 *
 * ```
 * { tvx: 1, type: string, id?: string, ...payload }
 * ```
 *
 * `tvx` is the discriminator that makes a Tetravox message recognisable in a `message` handler
 * shared with React DevTools, Vite's HMR client, an analytics SDK and everything else that posts to
 * `window`. `type` names the message. `id` is the host's correlation token: a reply carries the
 * `id` of the request that caused it, and a message with no `id` is unsolicited — an event, not an
 * answer.
 *
 * **Additive-only after v1.** New message types and new optional fields may be added; a type may
 * never be removed, renamed, or given a new required field, and the meaning of an existing field
 * may never change. A host written against v1 must keep working against every later build, and an
 * embed must ignore a message type it does not know rather than fail. If the contract ever has to
 * break, it breaks by bumping `tvx` to `2` and serving both — which is why `tvx` is a number and
 * not a boolean flag.
 *
 * ## Trust
 *
 * The embed accepts a message only when **both** hold:
 *
 *  * `event.source === window.parent` — the message came from the frame that mounted us, not from
 *    a sibling iframe, a popup, or this page's own workers; and
 *  * `event.origin === hostOrigin`, the origin named in the embed's own URL
 *    (`index.html?embed=1&hostOrigin=<origin>`).
 *
 * Anything else is dropped silently. Silence rather than an `error` reply is deliberate: replying
 * would confirm to an unknown origin that a Tetravox is listening here, and a host that mistyped
 * its own origin sees the same nothing either way — which `docs/EMBED.md` says to check first.
 *
 * The host has the mirror obligation and the embed cannot enforce it: **check `event.origin`
 * against the iframe's origin** before believing anything below. A `cursor` event is a coordinate
 * from a brain scan, but a `scene` reply is a document the host may well write to disk.
 *
 * `hostOrigin` is compared as an exact string. `'*'` is accepted and means "any origin", which
 * exists for a host serving the embed from the same origin under a path it cannot predict; it is
 * documented as the escape hatch it is, not as a default.
 *
 * ## Types
 *
 * Every message has a named interface, and the two unions {@link HostMessage} and
 * {@link EmbedMessage} are exhaustive over them. `packages/embed/protocol.schema.json` is the same
 * contract as JSON Schema, for a host that is not TypeScript; `protocol.test.ts` proves the schema
 * lists exactly the types these unions do, so the two cannot drift.
 */

import type { Layer, LayoutKind, ProbeResult, ViewSpec, vec3 } from '@tetravox/engine';

/** The value of the `tvx` envelope field. Bumped only by a breaking change (see above). */
export const PROTOCOL_VERSION = 1;

/** The query parameter that puts the renderer in embed mode, and the one that names the host. */
export const EMBED_PARAM = 'embed';
export const HOST_ORIGIN_PARAM = 'hostOrigin';

/** Every message carries these. `id` is present on a request that wants a reply, and on its reply. */
export interface Envelope {
  tvx: typeof PROTOCOL_VERSION;
  type: string;
  id?: string;
}

// ------------------------------------------------------------------------------------------------
// Host → embed
// ------------------------------------------------------------------------------------------------

/**
 * "Are you there?" — answered with {@link ReadyMessage}.
 *
 * The embed also posts `ready` **unprompted** the moment it boots, so a host that mounted the
 * iframe and started listening before `load` fires never has to poll. `hello` exists for the other
 * order: a host that attached its listener late, or one re-attaching after its own re-render, can
 * ask instead of waiting for an event that already went past.
 */
export interface HelloMessage extends Envelope {
  type: 'hello';
}

/**
 * Replace the scene with `scene` (§4.6's `ViewSpec`, version 2).
 *
 * **Dataset refs are URLs.** `DatasetRef.path` may be an absolute `http(s)://` URL, which is used
 * as-is, or a relative or root-relative one (`data/T1.nii.gz`, `/api/files/raw/T1.nii.gz`), which
 * is resolved against `baseUrl` — and `baseUrl` itself defaults to the embed document's own
 * `baseURI`, so a host serving data from its own origin can send exactly the paths its server
 * publishes and send no `baseUrl` at all. Whatever arrives, what reaches the engine's loader is
 * always an absolute URL: the worker streams it with `fetch`, and a *root*-relative path is not one
 * of the two forms `datasets/source.ts`'s `fileUrl` passes through, so resolving here is what keeps
 * `/api/...` from being mangled into a `tetravox://file/` request no browser can serve.
 *
 * `fingerprint` may be `''` or absent — see {@link EmbedDatasetRef}.
 *
 * The reply is {@link LoadedMessage} carrying this message's `id`, or {@link ErrorMessage}.
 */
export interface LoadMessage extends Envelope {
  type: 'load';
  scene: EmbedViewSpec;
  baseUrl?: string;
}

export interface SetThemeMessage extends Envelope {
  type: 'setTheme';
  theme: 'light' | 'dark';
}

export interface SetLayoutMessage extends Envelope {
  type: 'setLayout';
  kind: LayoutKind;
}

/** Move the crosshair to a world-RAS millimetre triple (§3). Emits {@link CursorMessage}. */
export interface SetCursorMessage extends Envelope {
  type: 'setCursor';
  world: vec3;
}

export interface SetLayerVisibleMessage extends Envelope {
  type: 'setLayerVisible';
  layerId: string;
  visible: boolean;
}

export interface SetLayerOpacityMessage extends Envelope {
  type: 'setLayerOpacity';
  layerId: string;
  /** Clamped to `[0, 1]`. */
  opacity: number;
}

/**
 * Patch any layer field (§4.4) — colormap, scale, threshold, clip planes, field selection, tag
 * styles, contour flags. The patch is handed to `Engine.updateLayer` unchanged.
 *
 * Deliberately untyped as `Record<string, unknown>` rather than `Partial<Layer>`: the host is
 * another process and its patch has been through JSON, so it is data to be validated by the engine
 * that owns the field, not a value this file can promise the shape of. The layer kinds and their
 * fields are §4.4's, and `docs/EMBED.md` names the ones a host reaches for.
 */
export interface UpdateLayerMessage extends Envelope {
  type: 'updateLayer';
  layerId: string;
  patch: Record<string, unknown>;
}

export interface SetActiveLayerMessage extends Envelope {
  type: 'setActiveLayer';
  layerId: string | null;
}

/**
 * Capture a PNG. The reply is {@link ScreenshotReplyMessage} carrying `id` and a `data:` URL.
 *
 * `id` is **required** here, unlike on most messages: a screenshot is worth several megabytes of
 * base64 and there is no point posting one nobody asked to correlate.
 */
export interface ScreenshotMessage extends Envelope {
  type: 'screenshot';
  id: string;
  /** Default `'grid'` — the whole view grid, which is what a host asking for "a picture" means. */
  target?: 'view' | 'grid';
  /** Required when `target` is `'view'`; ignored otherwise. */
  viewId?: string;
  width?: number;
  height?: number;
}

/** Ask for the live scene as a `ViewSpec`. The reply is {@link SceneMessage}. */
export interface SerializeMessage extends Envelope {
  type: 'serialize';
  id: string;
}

/** Probe every layer at a world point without moving the cursor. Reply: {@link ProbeReplyMessage}. */
export interface ProbeMessage extends Envelope {
  type: 'probe';
  id: string;
  world: vec3;
}

/**
 * Give the viewer keyboard focus.
 *
 * An iframe does not receive key events until something inside it is focused, and a host that has
 * just shown the frame has no way to focus across the boundary. §7.5's whole keyboard map is dead
 * until this lands.
 */
export interface FocusMessage extends Envelope {
  type: 'focus';
}

/**
 * Unload everything: every dataset closed, every worker terminated, an empty scene.
 *
 * §5 rule 1 — `worker.terminate()` is the only way a dataset's wasm heap comes back — so this is
 * the message a host sends when it navigates away from the viewer but keeps the iframe mounted.
 * Emits `status: 'idle'` and an empty {@link LayersMessage}.
 */
export interface ResetMessage extends Envelope {
  type: 'reset';
}

export type HostMessage =
  | HelloMessage
  | LoadMessage
  | SetThemeMessage
  | SetLayoutMessage
  | SetCursorMessage
  | SetLayerVisibleMessage
  | SetLayerOpacityMessage
  | UpdateLayerMessage
  | SetActiveLayerMessage
  | ScreenshotMessage
  | SerializeMessage
  | ProbeMessage
  | FocusMessage
  | ResetMessage;

/** Every `type` a host may send. The runtime half of the {@link HostMessage} union. */
export const HOST_MESSAGE_TYPES = [
  'hello',
  'load',
  'setTheme',
  'setLayout',
  'setCursor',
  'setLayerVisible',
  'setLayerOpacity',
  'updateLayer',
  'setActiveLayer',
  'screenshot',
  'serialize',
  'probe',
  'focus',
  'reset',
] as const satisfies readonly HostMessage['type'][];

// ------------------------------------------------------------------------------------------------
// Embed → host
// ------------------------------------------------------------------------------------------------

/**
 * What this embed can do. Posted **unprompted on boot** and again in reply to every `hello`.
 *
 * `caps.webgl2` is the one a host must branch on: §1 records that Chromium M137 removed the
 * automatic SwiftShader fallback, so a blocklisted driver gives `getContext('webgl2') === null` and
 * the viewer can render nothing at all. A host that ignores this shows its user an empty box.
 */
export interface ReadyMessage extends Envelope {
  type: 'ready';
  version: typeof PROTOCOL_VERSION;
  caps: {
    webgl2: boolean;
    /** `Capabilities.renderer` — the unmasked GL renderer string, absent without a context. */
    renderer?: string;
    /** `EXT_texture_norm16` (§7.1). Absent without a context. */
    norm16?: boolean;
  };
}

/**
 * The viewer's coarse state.
 *
 * `'no-webgl2'` is terminal for the life of the page — nothing a host sends will make a context
 * appear — and is the state to show an error in. `'error'` is per-operation and recoverable: the
 * next successful `load` returns to `'ready'`.
 */
export interface StatusMessage extends Envelope {
  type: 'status';
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'no-webgl2';
  message?: string;
}

/**
 * Per-dataset load progress, mirrored from the engine's own `progress` event.
 *
 * `done`/`total` are bytes where the phase knows a size and units of work where it does not, and
 * `total` is `0` for a phase that cannot say — a determinate bar must therefore check it, and a
 * host that wants one number should prefer counting datasets in the {@link LoadedMessage}.
 */
export interface ProgressMessage extends Envelope {
  type: 'progress';
  datasetId: string;
  name: string;
  phase: string;
  done: number;
  total: number;
}

/** One entry per dataset the load actually opened. */
export interface LoadedDataset {
  id: string;
  name: string;
  kind: 'volume' | 'mesh';
  bytes?: number;
}

/**
 * A `load` finished. Carries the request's `id`.
 *
 * **The ids are not the ids the host sent.** `Engine.load` re-adds every dataset, so the spec's
 * `DatasetId`s and `LayerId`s are gone the moment the load succeeds and the live ones here are what
 * every later `setLayerVisible` / `updateLayer` / `setActiveLayer` must name. That is the reason
 * this message carries the whole layer array rather than an "ok".
 */
export interface LoadedMessage extends Envelope {
  type: 'loaded';
  datasets: LoadedDataset[];
  layers: Layer[];
}

/** The layer array changed, for any reason — a load, a patch, a user click in the layer panel. */
export interface LayersMessage extends Envelope {
  type: 'layers';
  layers: Layer[];
}

/**
 * The crosshair moved — by a click in a pane, a key, or the host's own `setCursor`.
 *
 * Throttled to 30 Hz. A drag across a pane moves the cursor once per frame, and a host that
 * re-renders on every one of those is a host that drops frames inside the viewer.
 */
export interface CursorMessage extends Envelope {
  type: 'cursor';
  world: vec3;
  /** Present only when some volume carries the corresponding transform (§3). */
  mni?: vec3;
  tkr?: vec3;
  /** Which space the coordinate bar is currently showing, as its stable key. */
  space: string;
}

/** The reply to {@link ProbeMessage}: one row per layer that had something to say at that point. */
export interface ProbeReplyMessage extends Envelope {
  type: 'probe';
  id: string;
  result: ProbeResult;
}

export interface ScreenshotReplyMessage extends Envelope {
  type: 'screenshot';
  id: string;
  /** `data:image/png;base64,…`. */
  dataUrl: string;
}

/** The reply to {@link SerializeMessage}: `Engine.serialize()`, whose refs are the loaded URLs. */
export interface SceneMessage extends Envelope {
  type: 'scene';
  id: string;
  spec: ViewSpec;
}

/**
 * Something failed. Carries the `id` of the request that failed, when there was one.
 *
 * `code` is the engine's own error code where one exists (`parse`, `io`, `oom`, `cancelled`) and
 * absent otherwise; `message` is always present and always human-readable. A host should show
 * `message` and branch on `code`, never the other way round.
 */
export interface ErrorMessage extends Envelope {
  type: 'error';
  code?: string;
  message: string;
}

export type EmbedMessage =
  | ReadyMessage
  | StatusMessage
  | ProgressMessage
  | LoadedMessage
  | LayersMessage
  | CursorMessage
  | ProbeReplyMessage
  | ScreenshotReplyMessage
  | SceneMessage
  | ErrorMessage;

/** Every `type` an embed may send. The runtime half of the {@link EmbedMessage} union. */
export const EMBED_MESSAGE_TYPES = [
  'ready',
  'status',
  'progress',
  'loaded',
  'layers',
  'cursor',
  'probe',
  'screenshot',
  'scene',
  'error',
] as const satisfies readonly EmbedMessage['type'][];

// ------------------------------------------------------------------------------------------------
// The host-facing ViewSpec subset
// ------------------------------------------------------------------------------------------------

/**
 * A `DatasetRef` as a **host** can write one (§4.6 has the full form).
 *
 * Two fields of the real `DatasetRef` are optional here, and both for the same reason — a host
 * cannot know them:
 *
 *  * `fingerprint` is `tvx_core::fingerprint` over the file's own bytes, computed in the worker
 *    that read them (§5 rule 3 forbids the UI thread from ever seeing those bytes). Nothing that
 *    has not already loaded the file can produce one. It identifies a file for the relocate dialog
 *    and for nothing else, and there is no relocate dialog in an embed, so `''` is exact rather
 *    than a placeholder.
 *  * `absPath` is a filesystem path. An embed has no filesystem.
 */
export interface EmbedDatasetRef {
  id: string;
  kind: 'volume' | 'mesh';
  name: string;
  /** Absolute `http(s)://`, or relative/root-relative — resolved against `LoadMessage.baseUrl`. */
  path: string;
  fingerprint?: string;
  /** `path` is resolved against **the dataset's own URL**, per §4.6: a sidecar travels with it. */
  sidecars?: {
    lut?: { path: string };
    opt?: { path: string };
  };
}

/**
 * A `ViewSpec` as a **host** can write one: `datasets` and `layers`, everything else optional.
 *
 * §4.6's `ViewSpec` requires `slices`, `view3d`, `layout`, `cursor`, `radiological`, `background`,
 * `lighting`, `annotations` and `transparency`, because `applyViewSpec` assigns all nine
 * unconditionally — a saved scene is a *complete* description, and merging would let a stale live
 * scene leak into a loaded one. A host writing a scene by hand knows none of them and should not
 * have to invent a quaternion to show a T1.
 *
 * So the embed fills every absent key from the engine's own empty scene, captured with
 * `Engine.serialize()` at boot **before anything is loaded** (`normalize.ts`). The defaults are
 * therefore the engine's, never a second copy of them in this package, and a host that *does* send
 * a camera gets exactly the camera it sent.
 */
export interface EmbedViewSpec {
  version?: 1 | 2;
  datasets: EmbedDatasetRef[];
  layers: Record<string, unknown>[];
  activeLayerId?: string | null;
  [key: string]: unknown;
}

// ------------------------------------------------------------------------------------------------
// Guards
// ------------------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Is this a Tetravox host message?
 *
 * Envelope only: `tvx === 1` and a `type` this build knows. It deliberately does **not** validate
 * the payload — the field a message carries is validated by whatever consumes it, and a guard that
 * type-checked every `patch` here would be a second copy of §4.4 in this file. What it does
 * guarantee is that `msg.type` may be switched on exhaustively.
 */
export function isHostMessage(v: unknown): v is HostMessage {
  if (!isRecord(v)) return false;
  if (v['tvx'] !== PROTOCOL_VERSION) return false;
  const type = v['type'];
  return typeof type === 'string' && (HOST_MESSAGE_TYPES as readonly string[]).includes(type);
}

/** The mirror of {@link isHostMessage}, for a host validating what it receives. */
export function isEmbedMessage(v: unknown): v is EmbedMessage {
  if (!isRecord(v)) return false;
  if (v['tvx'] !== PROTOCOL_VERSION) return false;
  const type = v['type'];
  return typeof type === 'string' && (EMBED_MESSAGE_TYPES as readonly string[]).includes(type);
}

/** The two things about a `MessageEvent` that decide whether to trust it. */
export interface Incoming {
  source: unknown;
  origin: string;
  data: unknown;
}

export interface AcceptOptions {
  /** The window a message must have come from — the embed's `window.parent`. */
  expectedSource: unknown;
  /** The `hostOrigin` query parameter. `'*'` accepts any origin; see this file's header. */
  hostOrigin: string;
}

/**
 * The whole trust decision, as one pure function.
 *
 * Returns the message when it is one to act on, and `null` for every other case — wrong window,
 * wrong origin, not ours, a type this build does not know. `null` is not an error and must not be
 * reported as one: on a page with any other `postMessage` traffic at all, most events reaching this
 * function are somebody else's.
 *
 * Pure and window-free so that `protocol.test.ts` can drive every branch without a browser, which
 * is the point — this is the security boundary, and a boundary that can only be tested end to end
 * is one whose failure modes are never tested.
 */
export function acceptMessage(event: Incoming, opts: AcceptOptions): HostMessage | null {
  if (event.source !== opts.expectedSource) return null;
  if (opts.hostOrigin !== '*' && event.origin !== opts.hostOrigin) return null;
  if (!isHostMessage(event.data)) return null;
  return event.data;
}

/**
 * Copy the request's `id` onto a reply.
 *
 * A reply to a request that carried no `id` carries none either: the field means "this answers
 * *that*", and inventing one would tell a host it can correlate something it cannot.
 */
export function withId<M extends EmbedMessage>(reply: M, request: { id?: string }): M {
  return request.id === undefined ? reply : { ...reply, id: request.id };
}

/** Read `?embed=1&hostOrigin=…` off the embed's own URL. */
export function embedParams(search: string): { embed: boolean; hostOrigin: string } {
  const params = new URLSearchParams(search);
  return {
    embed: params.get(EMBED_PARAM) === '1',
    // No `hostOrigin` at all means no host can be authenticated, so nothing is accepted. That is a
    // safer default than `'*'` and it is what a host that forgot the parameter should see: a viewer
    // that renders and ignores it, rather than one that quietly trusts the whole web.
    hostOrigin: params.get(HOST_ORIGIN_PARAM) ?? '',
  };
}
