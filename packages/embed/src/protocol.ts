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
 * ## Two numbers, and only one of them moves
 *
 * {@link ENVELOPE_VERSION} is the `tvx` field. It is the wire discriminator and it changes **only**
 * for a breaking change — never for a feature. It is `1` and, as long as this contract stays
 * additive, it stays `1` forever.
 *
 * {@link PROTOCOL_VERSION} is the *feature level*: which edition of the tables in `docs/EMBED.md`
 * this build implements. It is what `ready.version` announces and what the tarball's
 * `manifest.json.protocol` records, and it is `2`. A host reads it to decide
 * whether a feature is there — never to decide whether to talk at all, which is what `tvx` is for.
 *
 * Conflating the two would have been the one change that breaks every existing host: a protocol-1
 * host filters on `tvx !== 1` and posts `tvx: 1`, so bumping the envelope would have made an
 * additive release unreachable by exactly the hosts the additive promise was made to.
 *
 * ## What protocol 2 added (2026-09-04), all of it optional
 *
 *  * a **points layer** in the `ViewSpec` — inline coordinates and ids, per-point state, colour and
 *    radius, and a label mode ({@link EmbedPointsLayer});
 *  * {@link SetPointToolMessage} / {@link SetPointSelectionMessage} / {@link SetPointsMessage} —
 *    arm the point tool on a layer, set its selection, replace its points;
 *  * {@link SetPickEventsMessage} and the {@link PickMessage} / {@link PointToolMessage} events —
 *    what a click landed on, **off by default**, so a protocol-1 host's message stream is byte for
 *    byte the one it gets today;
 *  * {@link GetCameraMessage} / {@link SetCameraMessage} / {@link CameraMessage} — read and restore
 *    the 3-D camera;
 *  * {@link AckMessage} — the reply the three point-layer messages send to a request that carried an
 *    `id`, so a host can `await` them (2026-09-05);
 *  * {@link SetHoverEventsMessage} / {@link PointHoverMessage} — which point the pointer is on, off
 *    by default (2026-09-05).
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

import type {
  Camera3D,
  CameraPreset,
  Layer,
  LayoutKind,
  PointToolEvent,
  ProbeResult,
  ViewSpec,
  vec3,
  vec4,
} from '@tetravox/engine';

/**
 * The value of the `tvx` envelope field. Bumped only by a **breaking** change (see above).
 *
 * Not the same number as {@link PROTOCOL_VERSION}, and it has not moved: a protocol-2 build still
 * speaks `tvx: 1`, which is what makes protocol 2 additive rather than a second protocol.
 */
export const ENVELOPE_VERSION = 1;

/**
 * The **feature level** this build implements — `ready.version` and the tarball manifest's
 * `protocol` (see above). `1` up to Tetravox 0.3.9; `2` from 0.3.11; `3` from 0.4.0.
 *
 * It is **not** the tarball's version. The embed is versioned with the repository — one number for
 * the whole tree, bumped by `scripts/release.sh` — so `tetravox-embed-0.4.0.tgz` is the embed built
 * from Tetravox 0.4.0, and this constant says which edition of the contract that build implements.
 *
 * **Why 3 is not additive in the way 2 was.** Everything protocol 2 added was a message or a field
 * a host could decline to send. Protocol 3 adds a `ViewSpec` layer *kind* — `'surface'` — and a
 * kind is the one thing a spec cannot be partly understood: a protocol-2 build handed a
 * `kind: 'surface'` layer dropped it in silence (`isRestorableKind` predates the kind, so the layer
 * simply never became a layer) and reported a successful load of a scene with nothing in it. The
 * number moves so a host can ask *before* sending one, which is the whole reason `ready.version`
 * exists.
 *
 * The compatibility rule is therefore about the direction, not the number: a **protocol-2 host is
 * unaffected**, because every spec it can write — `volume`, `mesh`, `points` — means exactly what it
 * always did, and no reply or event changed shape. What a host must not do is send a `surface`
 * layer to a build whose `ready.version` is below 3.
 */
export const PROTOCOL_VERSION = 3;

/** The query parameter that puts the renderer in embed mode, and the one that names the host. */
export const EMBED_PARAM = 'embed';
export const HOST_ORIGIN_PARAM = 'hostOrigin';

/** Every message carries these. `id` is present on a request that wants a reply, and on its reply. */
export interface Envelope {
  tvx: typeof ENVELOPE_VERSION;
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

/**
 * Choose the pane arrangement.
 *
 * `kind` is one of §4.5's seven `LayoutKind`s, **or** one of four names that name a view rather than
 * a grid: `'3d'` (the 3-D pane alone) and `'axial'` / `'coronal'` / `'sagittal'` (that slice pane
 * alone). `docs/EMBED.md` has documented those four since protocol 1; `layout.ts` is where they
 * became real, and what it says about the crash they used to cause is worth reading.
 *
 * A `kind` this build does not know is answered with an `error`, never acted on.
 */
export interface SetLayoutMessage extends Envelope {
  type: 'setLayout';
  kind: LayoutKind | '3d' | 'axial' | 'coronal' | 'sagittal';
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

// ------------------------------------------------------------------------------------------------
// Protocol 2 (2026-09-04) — the point tool, pick events and the camera. Appended, all optional:
// absent, every one of them is off and the embed behaves exactly as protocol 1 did.
// ------------------------------------------------------------------------------------------------

/**
 * Arm §7.5's point tool on one points layer, or disarm it with `layerId: null`.
 *
 * This is the same call the sEEG contact editor's **Add** button makes (`Engine.setPointTool`), so
 * everything below is something a user can do with the mouse: in `'place'` mode every left click
 * appends a point; in `'select'` mode a click grabs the point under it and drags it, and a click on
 * nothing does nothing.
 *
 * Two consequences a host must know, both of them the engine's and neither invented here:
 *
 *  * **Arming materialises ids.** A layer whose `points[]` carry no `id` gets `p<index>` on every
 *    one of them, which fires a `layers` event. Send your own ids if you want to recognise them.
 *  * **Arming turns measure mode off**, and only one click-consuming mode can be armed (§7.5).
 *
 * The tool is disarmed by a `load` and by the layer being removed; the {@link PointToolMessage}
 * event says which, in `reason`, so a host knows whether to arm again.
 *
 * With an `id`, the reply is {@link AckMessage} — sent after the engine call returns, so a host may
 * `await` it and then send the next message knowing the tool is armed.
 */
export interface SetPointToolMessage extends Envelope {
  type: 'setPointTool';
  /** The points layer to arm on — a **live** id, from `loaded.layers`. `null` disarms. */
  layerId: string | null;
  /** Default `'select'`. Ignored when `layerId` is `null`. */
  mode?: 'select' | 'place';
  /** What a placed point starts as. `position` and `id` are the engine's. */
  template?: { color?: vec4; radiusMm?: number; group?: string };
}

/**
 * Select a point by **id**, or clear the selection with `pointId: null`.
 *
 * By id and not by index because the index is a frame's key and not an identity: deleting the
 * second of twelve contacts renumbers ten of them (§4.4). The selection is re-resolved against the
 * live `points[]`, so an id that is not there clears it — with a `pointTool` event whose `reason`
 * is `'selection'` — rather than silently pointing at the neighbour.
 *
 * The selection is what draws §7.2's ring. It is **not** `points[].state`: `state` paints the
 * marker (any number of points may carry it), the selection is the one point the tool is holding.
 *
 * With an `id`, the reply is {@link AckMessage}. A `pointTool` event may arrive before it — the
 * engine emits that synchronously — so a host must not treat the `ack` as "nothing else happened".
 */
export interface SetPointSelectionMessage extends Envelope {
  type: 'setPointSelection';
  layerId: string;
  pointId: string | null;
}

/**
 * Replace a points layer's `points[]` wholesale.
 *
 * `updateLayer` with a `points` patch reaches the engine unchanged and is still there; this message
 * exists because it is the one that runs {@link EmbedPoint}'s `state` → colour resolution, the same
 * one `load` runs. A host that sends `state` through `updateLayer` gets points with no colour, which
 * is a silent difference between two spellings of the same thing.
 *
 * Replacing the array is also how a point is deleted, and the engine re-resolves the selection
 * against the new one (see {@link SetPointSelectionMessage}).
 *
 * With an `id`, the reply is {@link AckMessage}, posted after the layer has been patched — which is
 * what makes "replace the points, then screenshot" a sequence rather than a race. The `layers` event
 * carrying the new points is posted first.
 */
export interface SetPointsMessage extends Envelope {
  type: 'setPoints';
  layerId: string;
  points: EmbedPoint[];
}

/**
 * Turn {@link PickMessage} on or off. **Off is the default, and that is the point.**
 *
 * A `pick` carries a whole `ProbeResult` and fires on every click. A protocol-1 host never asked for
 * one and cannot read one, so it must not be made to pay for it: with pick events off, the stream a
 * host receives from a protocol-2 build is byte for byte the stream a protocol-1 build sends. The
 * guarantee is therefore structural rather than "they will ignore what they do not know".
 */
export interface SetPickEventsMessage extends Envelope {
  type: 'setPickEvents';
  enabled: boolean;
}

/**
 * Turn {@link PointHoverMessage} on or off. **Off is the default**, like {@link SetPickEventsMessage}
 * and for the same reason: a protocol-1 host's message stream must stay byte for byte the one it has.
 *
 * On, the embed runs one point hit test per pointer move — the same one the point tool's grab uses,
 * so the id a host paints as "hovered" is the id a click would select. §8 gives hover a 16 ms budget
 * and a host that draws no hover state must not spend it, which is why this is a switch and not a
 * standing event.
 *
 * With an `id`, the reply is {@link AckMessage}.
 */
export interface SetHoverEventsMessage extends Envelope {
  type: 'setHoverEvents';
  enabled: boolean;
}

/** Ask for the 3-D camera. The reply is {@link CameraMessage}. */
export interface GetCameraMessage extends Envelope {
  type: 'getCamera';
  id: string;
}

/**
 * Move the 3-D camera: an anatomical `preset`, a `patch`, or both (preset first, then patch).
 *
 * A **patch** and not a whole `Camera3D` for the reason the extension API gives (§13.1): `near` and
 * `far` are derived from the fit radius (§7.2), so restoring a saved pose by writing all seven
 * fields carries a stale clip range back with it. Write `target`, `distance` and `rotation`; leave
 * the rest to the engine.
 *
 * `preset` is §7.5's `1..6` — `'A'`/`'P'`/`'L'`/`'R'`/`'S'`/`'I'`, anterior through inferior — the
 * same six the keyboard offers, which is what a "front / left / top" button in a host should send.
 *
 * With an `id`, the reply is {@link CameraMessage} carrying the camera that resulted.
 */
export interface SetCameraMessage extends Envelope {
  type: 'setCamera';
  preset?: CameraPreset;
  patch?: Partial<Camera3D>;
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
  | ResetMessage
  // Protocol 2 (2026-09-04), appended.
  | SetPointToolMessage
  | SetPointSelectionMessage
  | SetPointsMessage
  | SetPickEventsMessage
  | GetCameraMessage
  | SetCameraMessage
  // 2026-09-05, appended.
  | SetHoverEventsMessage;

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
  // Protocol 2 (2026-09-04). Appended, never reordered: a host may compare this list against its
  // own to decide what a build supports, and the order it is written in is part of the diff.
  'setPointTool',
  'setPointSelection',
  'setPoints',
  'setPickEvents',
  'getCamera',
  'setCamera',
  // 2026-09-05. Appended, never reordered — see the note above.
  'setHoverEvents',
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

// ------------------------------------------------------------------------------------------------
// Protocol 2 (2026-09-04) — the events. `pick` is opt-in ({@link SetPickEventsMessage}); the other
// two only ever fire in reply to something a protocol-2 host asked for.
// ------------------------------------------------------------------------------------------------

/**
 * What a click landed on. Emitted only while {@link SetPickEventsMessage} has enabled it.
 *
 * **One per press.** A left press on a pane produces exactly one `pick`, whatever it resolved to:
 * a point the tool hit or placed, a surface the id pass returned, or the plain cursor set §7.5's
 * R1 does when a click lands on nothing in particular. A drag that follows it emits no more.
 *
 * `kind` says which of those it was, and it is the field to branch on:
 *
 *  * `'point'` — a point of a points layer. `layerId` is that layer and `pointId` the point; this
 *    is the only kind that carries one.
 *  * `'tri'` / `'tet'` / `'slice'` — §7.2.3's id pass answered: a surface triangle, a tetrahedron,
 *    or a slice quad. `layerId` and `elementId` are the layer and the Gmsh element number.
 *  * `'cursor'` — the click moved the crosshair and nothing owned the pixel. `world` is where.
 *
 * `probe` is `ProbeResult` at `world`, so the label under a click, a tissue tag and a field value
 * arrive **with** the click rather than a round trip later. `label` and `tag` are the two rows a
 * host reaches for, lifted out of it — a label volume's value and name (which is what "click a
 * region" means), and a mesh's tissue tag and name.
 *
 * **The mesh rows are at most one round trip stale**, which is §4.7's standing rule and not a
 * property of this message: `probe` is synchronous while `locate` is a worker call. The volume
 * rows — the label one included — are exact, because §4.3 keeps a volume's voxels on the UI thread
 * for exactly this. A host that needs the settled mesh answer sends a `probe` with this event's own
 * `world`.
 */
export interface PickMessage extends Envelope {
  type: 'pick';
  kind: 'point' | 'tri' | 'tet' | 'slice' | 'cursor';
  world: vec3;
  /** The pane the click was in. */
  viewId?: string;
  /** The layer that owned the pixel — absent for `'cursor'`. */
  layerId?: string;
  /** Present for `kind: 'point'` only. */
  pointId?: string;
  /** Gmsh element number (§6.2), or the plane index for a slice quad. */
  elementId?: number;
  /** The label volume's value under the click, and its LUT name where there is one. */
  label?: { id: number; name?: string; layerId: string };
  /** A mesh's tissue tag under the click, and its `.msh.opt` name where there is one. */
  tag?: { id: number; name?: string; layerId: string };
  /** Which modifiers were held on the press, so a host can offer "add to selection". */
  modifiers: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
  probe: ProbeResult;
}

/**
 * §7.5's point tool did something — the engine's own `PointToolEvent`, forwarded unchanged.
 *
 * Only fires while a tool is armed, so a protocol-1 host, which cannot arm one, never sees it.
 *
 * `kind` is `'placed'`, `'selected'`, `'dragEnd'` or `'cleared'`, and two of them have grammar a
 * host gets wrong exactly once:
 *
 *  * **A plain click emits a zero-length `dragEnd`.** A `select`-mode click grabs the point under
 *    it, and a grab is a drag that ended without moving — so clicking down a list of contacts gives
 *    `selected`, `dragEnd`, `selected`, `dragEnd`, … Compare positions against the snapshot taken
 *    at `selected` before recording an edit. (The one exception: a click on a point the layer draws
 *    *off* its slice selects it and starts no gesture, so it emits `selected` and no `dragEnd`.)
 *  * **`cleared` says why, in `reason`.** `'esc'`, `'measure'`, `'load'`, `'layer'`, `'host'` — and
 *    `'selection'`, which means only the selection went and the tool is still armed.
 *
 * The scene has already changed when this arrives: a drag writes every intermediate position, so
 * `dragEnd` is the commit point and the new coordinates are in the `layers` event beside it.
 */
export interface PointToolMessage extends Envelope {
  type: 'pointTool';
  event: PointToolEvent;
}

/**
 * "Done." — the reply to a host message that changes something and has nothing to report back.
 *
 * `setPointTool`, `setPointSelection` and `setPoints` each act on the scene and produce no value, so
 * before this they replied with silence. Silence is indistinguishable from a dropped message on a
 * `postMessage` channel, and the ordinary host shape — *select this electrode, then redraw* — is an
 * `await` on a reply that never came. So a request that carried an `id` gets one back.
 *
 * `id` is **required** here, because that is the whole message: an `ack` with nothing to correlate
 * would be an event nobody subscribed to. A request with no `id` is still answered with nothing,
 * which is {@link withId}'s rule everywhere else — "a reply to an id-less request carries no id".
 *
 * `of` names the request's type, so a host multiplexing several in flight can assert what it is
 * looking at without keeping its own table.
 *
 * Not an echo of {@link LayersMessage}: `layers` also fires when a *user* clicks in the layer panel
 * or drags a point, and a host correlating on it would treat someone else's edit as its own reply.
 */
export interface AckMessage extends Envelope {
  type: 'ack';
  id: string;
  /** The `type` of the request this answers. */
  of: HostMessage['type'];
}

/**
 * The point under the pointer changed — §6.7, and **only while {@link SetHoverEventsMessage} is on**.
 *
 * `pointId` is `null` when the pointer left every point, which is the message a host paints a hover
 * *off* with. Both fields are null together.
 *
 * **One event per edge, not per move.** The pointer produces dozens of moves a second and the answer
 * is the same for nearly all of them; this fires when the answer changes and at no other time, so a
 * host may repaint on every one it receives.
 *
 * There is no `stateColors.hover` and no hover state on a point, deliberately: the host owns colour
 * (that is what {@link EmbedPoint.color} and `stateColors` are for), and an engine-side hover colour
 * could not know that "lighter than this electrode's channel hue" is what the host wanted. What the
 * host cannot compute for itself is *which point the mouse is on* — the hit test is the engine's —
 * so that, and only that, is what this carries.
 */
export interface PointHoverMessage extends Envelope {
  type: 'pointHover';
  /** The layer the hovered point belongs to, or `null` when nothing is hovered. */
  layerId: string | null;
  /** The point's `id` (§4.4's minted `p<index>` for a layer that sent none), or `null`. */
  pointId: string | null;
}

/** The reply to {@link GetCameraMessage}, and to a {@link SetCameraMessage} that carried an `id`. */
export interface CameraMessage extends Envelope {
  type: 'camera';
  camera: Camera3D;
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
  | ErrorMessage
  // Protocol 2 (2026-09-04), appended.
  | PickMessage
  | PointToolMessage
  | CameraMessage
  | AckMessage
  | PointHoverMessage;

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
  // Protocol 2 (2026-09-04). Appended, never reordered — see HOST_MESSAGE_TYPES.
  'pick',
  'pointTool',
  'camera',
  // 2026-09-05. Appended: the reply the three point-layer messages had been missing, and the hover.
  'ack',
  'pointHover',
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
  /**
   * What kind of file this is — and, from protocol 3, **three** answers rather than two.
   *
   * §4.6's `DatasetRef` has only `'volume' | 'mesh'`, because the engine decides surface-ness from
   * the bytes: a `MeshDataset` with `nTets === 0` *is* a surface (`isSurfaceMesh`), and there is no
   * third dataset kind to add. `'surface'` here is therefore a **host-facing spelling of
   * `'mesh'`**, mapped down in `normalize.ts` before the engine sees the ref.
   *
   * It exists because the alternative reads as a mistake. Without it a host writes
   * `datasets: [{ kind: 'mesh', name: 'lh.pial.gii' }]` and `layers: [{ kind: 'surface' }]` in the
   * same document and has to know that the disagreement is intended — which is exactly the
   * volume/mesh/surface confusion protocol 3 exists to end. `'mesh'` on a surface file keeps
   * working and always will; the two spellings load the same bytes the same way.
   *
   * It is **not** a format hint and it does not choose a parser. See `path`.
   */
  kind: 'volume' | 'mesh' | 'surface';
  name: string;
  /**
   * Absolute `http(s)://`, or relative/root-relative — resolved against `LoadMessage.baseUrl`.
   *
   * **The format is read from the bytes, not from this string.** `tvx_mesh_io::sniff` tries
   * `$MeshFormat`, VTK, MEDIT, GIfTI's XML, VTK-XML, OFF, PLY, STL and FreeSurfer's 24-bit
   * big-endian magic in that order, and only falls back to the extension when none of them
   * answers. That is why there is no `format: 'freesurfer' | 'gifti'` field on this type: the
   * loader would not read it, and a field that is accepted, documented and inert is the bug this
   * repository has already shipped once (`stateColors.idle`, §6.1).
   *
   * It is also why the extensionless FreeSurfer surfaces work — `lh.central`, `lh.pial`, `rh.white`
   * carry no extension at all in a SimNIBS or FreeSurfer tree, and are recognised by their magic.
   */
  path: string;
  fingerprint?: string;
  /** `path` is resolved against **the dataset's own URL**, per §4.6: a sidecar travels with it. */
  sidecars?: {
    lut?: { path: string };
    opt?: { path: string };
    /**
     * Per-vertex files attached to a **surface** after it opens (protocol 3; §4.6's third sidecar
     * role, `Engine.attachSurfaceData`): a FreeSurfer `.annot`, a morph file (`.thickness`,
     * `.curv`, `.sulc`, …) or a data-only GIfTI (`.func.gii`, `.shape.gii`, `.label.gii`).
     *
     * An array, and **the order matters**: they are attached in it, and each is named after its own
     * file — `lh.ernie_DK40.annot`, not `annot` — so two atlases on one hemisphere coexist and a
     * layer's `overlay.name` / `annotation.name` says which one it means.
     *
     * Best-effort, like the other two roles: one that 404s is a missing table, never a failed load.
     * Which means a surface whose annotation URL does not resolve opens **grey**, with a successful
     * `loaded` — check the `layers` event's `colorMode` if that matters to you.
     */
    fields?: { path: string }[];
  };
}

// ------------------------------------------------------------------------------------------------
// Protocol 2: a points layer a host can write inline (2026-09-04).
// ------------------------------------------------------------------------------------------------

/**
 * One point of an {@link EmbedPointsLayer} — §4.4's `PointsLayer['points'][number]`, plus `state`.
 *
 * The field names are the engine's own (`position`, `name`, `id`, `group`), deliberately: this is
 * §4.4 written by a host, not a second vocabulary for the same thing. Whatever a host sends that is
 * not listed here rides through to the engine unchanged, as every other layer's fields do.
 *
 * There is **no points file** an embed could serve — a `.geo` net is a Gmsh parsed view and a
 * contacts table is a TSV neither the engine nor this protocol reads — so the coordinates are
 * inline. That is also what makes the layer host-owned: the ids are the host's, the positions are
 * the host's, and `setPoints` replaces them.
 */
export interface EmbedPoint {
  /**
   * The point's identity, and what a {@link PickMessage} and a {@link SetPointSelectionMessage}
   * name it by. Unique within the layer.
   *
   * Optional because the engine mints `p<index>` for a point that has none — but a host that wants
   * to recognise its own electrode in a `pick` sends its own, because `p<index>` is an index and an
   * index moves when a point is deleted.
   */
  id?: string;
  /** World-RAS millimetres (§3). */
  position: vec3;
  /** The point's own text — what `labelMode: 'names'` draws and what a probe row calls it. */
  name?: string;
  /**
   * What this point currently *is*, in the host's own terms — and the one field here the engine has
   * no concept of.
   *
   * It is resolved to a colour before the engine sees the layer, from
   * {@link EmbedPointsLayer.stateColors} or the documented defaults, so a host says "this electrode
   * is selected" rather than restating what selected looks like at four call sites. An explicit
   * `color` on the same point **wins** — the state is a shorthand, never an override.
   *
   * Not the same thing as the tool's selection (see {@link SetPointSelectionMessage}): any number of
   * points may be `'selected'` here; exactly one point per layer can be the selection.
   */
  state?: 'idle' | 'selected' | 'disabled';
  /** 0..1 RGBA. Overrides whatever {@link state} would have painted. */
  color?: vec4;
  /** This point's own radius, overriding the layer's. */
  radiusMm?: number;
  /** Which set the point belongs to — an electrode, a montage, a parcel. Uninterpreted (§4.4). */
  group?: string;
  /** 1-based position within {@link group}. */
  ordinal?: number;
  /** The point's scalar, for `valueMode: 'value'`. */
  value?: number;
  [key: string]: unknown;
}

/**
 * A points layer as a host writes one.
 *
 * `datasetId` names a dataset **already in this spec** — the T1 the points sit over, say. §4.4 hangs
 * every layer off a carrier dataset and a points layer is no exception; it is the same arrangement
 * the sEEG contact editor uses in the desktop app, where the contacts hang off the CT they were
 * localised on. There is nothing to fetch: the coordinates arrived with the layer.
 *
 * Everything except `id`, `datasetId`, `kind` and `points` is optional and falls back to §4.4's
 * defaults — 4 mm spheres, no labels, and the engine's default colour.
 */
export interface EmbedPointsLayer {
  id: string;
  datasetId: string;
  kind: 'points';
  name?: string;
  visible?: boolean;
  opacity?: number;
  /** Whether §7.2.3's id pass answers for this layer. Points are hit-tested by the tool regardless. */
  pickable?: boolean;
  points: EmbedPoint[];
  /** `'sphere'` (the default) is `radiusMm` in world millimetres; `'dot'` is a constant screen size. */
  shape?: 'sphere' | 'dot';
  radiusMm?: number;
  /** 0..1 RGBA — the colour of every point that has neither a `color` nor a resolved `state`. */
  color?: vec4;
  /**
   * Where the in-pane text comes from, as one field rather than §4.4's `showLabels` +
   * `labelSource` pair:
   *
   *  * `'none'` — no text. The default, and what §4.4 does with `showLabels: false`.
   *  * `'names'` — each point's own `name`, drawn at its own position.
   *  * `'labels'` — the layer's free-standing `labels[]` anchors, which only a parsed Gmsh view has;
   *    an inline layer has none, so this draws nothing unless the host also sent `labels`.
   *
   * There is no `'hover'`: the engine draws no hover text, and a mode that silently did nothing
   * would be worse than the absence of one. A host that wants a tooltip draws it itself, from the
   * `pick` event.
   */
  labelMode?: 'none' | 'names' | 'labels';
  /**
   * What each {@link EmbedPoint.state} paints. Absent states keep the documented default:
   * `idle` → the layer's `color`, `selected` → `[1, 0.8, 0.2, 1]`, `disabled` → `[0.6, 0.6, 0.6, 1]`.
   */
  stateColors?: { idle?: vec4; selected?: vec4; disabled?: vec4 };
  /** 0..1. How visible a point is in a 2-D pane it is not on — absent is §7.2's hard cull. */
  offPlaneOpacity?: number;
  [key: string]: unknown;
}

// ------------------------------------------------------------------------------------------------
// Protocol 3: a surface is not a mesh (2026-09-06).
// ------------------------------------------------------------------------------------------------

/**
 * A **surface** layer — §4.4's `SurfaceLayer`, as a host writes one (protocol 3).
 *
 * ## What a surface is, and what it is not
 *
 * A surface is a triangle sheet with no tetrahedra: a hemisphere from a FreeSurfer binary
 * (`lh.pial`, `rh.white`, `lh.central`) or a GIfTI (`lh.pial.gii`), an STL/PLY/OBJ shell, a `.vtp`.
 * A **mesh** (`kind: 'mesh'`) is a tetrahedral FEM volume — a SimNIBS `.msh` with element
 * fields, tissue tags and an interior to cut open.
 *
 * They are drawn by the same §7.4 triangle passes, and that is deliberate; the difference is the
 * *model*. A surface has no tissue tags, no isolation, no glyphs, no 2-D fill and **no caps** —
 * a sheet has no interior to cap — so `tagStyle`, `clip.caps`, `fillIn2D` and `field` have no
 * meaning here and are not fields of this type. What it has instead is exactly one colour source
 * at a time, which is what `colorMode` picks.
 *
 * Before protocol 3 a `.gii` had to be sent as `kind: 'mesh'` (`docs/EMBED.md` §5(c) said so), and
 * it worked — the renderer drew the triangles — but the layer carried a tet mesh's whole vocabulary
 * and the host had to know which two thirds of it were inert. `'mesh'` on a surface file still
 * loads and still draws; it is the model that is wrong, not the picture.
 *
 * ## Three ways to colour one
 *
 *  * `'solid'` — one `solidColor`. The default, and what a geometry-only file gets.
 *  * `'overlay'` — a **per-vertex scalar**: curvature, thickness, a `.func.gii`, an `.mgz` morph.
 *    `overlay.name` names it, `colormap` / `scale` / `threshold` window it. This is `source: 'node'`
 *    data, never a `.msh`'s per-element `'elm'` field.
 *  * `'annotation'` — a **per-vertex atlas**: a FreeSurfer `.annot`, a `.label.gii`, or a
 *    `<LabelTable>` the geometry file carried. `annotation.name` names it and `mode` says whether
 *    the parcels are filled, outlined, or both.
 *
 * A file opened as geometry carries neither an overlay nor an annotation unless it had one inside
 * it. Both of the other two normally arrive as a **second file**, listed in the dataset's
 * `sidecars.fields` (see {@link EmbedDatasetRef}) — and the name to use here is the *file's* name,
 * `lh.ernie_DK40.annot`, because that is what the reader calls the field it produced.
 *
 * ## What happens when a name misses
 *
 * `annotation.table` is §4.4's one non-JSON field (it is a `LabelTable`) and is **not** part of this
 * type: the engine re-derives it from the dataset by `annotation.name` at load. A name that matches
 * nothing does not fail the load — the layer falls back to `colorMode: 'solid'` and its palette
 * colour. So does an annotation whose file 404'd. The `layers` event is where you find out.
 *
 * ## Omitting colours
 *
 * A layer that sends neither `solidColor` nor `contourColor` is seeded from the surface palette **by
 * load order** — the first surface is Freeview yellow, the second green, and so on, wrapping at six.
 * That is a nicety for two hemispheres and a trap for a host that expected a fixed colour: name one
 * if you care.
 *
 * Everything except `id`, `datasetId` and `kind` is optional and falls back to
 * `defaultSurfaceLayer` — visible, opaque, `colorMode: 'solid'`, `contoursIn2D: true` at 1.5 px.
 * `contoursIn2D` defaulting to *true* is the one default that differs from a mesh's: a sheet's
 * whole 2-D presence is its outline, and without it a surface is invisible in the slice panes.
 */
export interface EmbedSurfaceLayer {
  id: string;
  /** A dataset in this spec — the surface file. Its `kind` may be `'surface'` or `'mesh'`. */
  datasetId: string;
  kind: 'surface';
  name?: string;
  visible?: boolean;
  /** 0..1. */
  opacity?: number;
  pickable?: boolean;
  showColorbar?: boolean;
  /** Which of the three colour sources below is live. Absent is `'solid'`. */
  colorMode?: 'solid' | 'overlay' | 'annotation';
  /** 0..1 RGBA. Absent takes the load-order palette entry — see this type's doc comment. */
  solidColor?: vec4;
  /**
   * The per-vertex scalar that colours the surface, when `colorMode` is `'overlay'`.
   *
   * `name` is the field's name in the dataset — for an attached file, the file's own base name
   * (`lh.thickness`, `surf.func.gii`). `component` is `'mag'` for a scalar, or a 0-based index for
   * a vector. There is no `source`: a surface's data is per-vertex by construction, which is the
   * `source: 'node'` a mesh layer has to say out loud.
   */
  overlay?: { name: string; component?: 'mag' | 0 | 1 | 2 };
  /**
   * The per-vertex atlas that colours the surface, when `colorMode` is `'annotation'`.
   *
   * `table` is deliberately absent: it is re-derived from the dataset by `name` on load, and a host
   * has never seen the colours in the `.annot` it is naming. `visibleLabels` is a whitelist of
   * label ids — absent means all of them.
   */
  annotation?: {
    name: string;
    mode?: 'fill' | 'outline' | 'both';
    outlineWidthPx?: number;
    visibleLabels?: number[];
  };
  colormap?: string;
  colormapNegative?: string;
  /** §4.2. Omit it and an overlay is windowed from its own field's stats. */
  scale?: Record<string, unknown>;
  threshold?: Record<string, unknown>;
  flatShading?: boolean;
  /** Forced to `'both'` for a surface with open edges, whatever this says. */
  faceMode?: 'cull' | 'both';
  edges?: boolean;
  edgeColor?: vec4;
  edgeWidthPx?: number;
  /**
   * Clip **planes only**. A mesh layer's `caps` and `capColorMode` are not here: a sheet has no
   * interior, so there is nothing for a cap to fill.
   */
  clip?: { planes: Record<string, unknown>[] };
  /** Absent is `true` — a surface's 2-D presence is its outline. */
  contoursIn2D?: boolean;
  contourWidthPx?: number;
  contourColor?: vec4;
  [key: string]: unknown;
}

/** The layer kinds a host may write, and the message an unknown one is refused with. */
export const EMBED_LAYER_KINDS = ['volume', 'mesh', 'surface', 'points'] as const;

export type EmbedLayerKind = (typeof EMBED_LAYER_KINDS)[number];

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
  if (v['tvx'] !== ENVELOPE_VERSION) return false;
  const type = v['type'];
  return typeof type === 'string' && (HOST_MESSAGE_TYPES as readonly string[]).includes(type);
}

/** The mirror of {@link isHostMessage}, for a host validating what it receives. */
export function isEmbedMessage(v: unknown): v is EmbedMessage {
  if (!isRecord(v)) return false;
  if (v['tvx'] !== ENVELOPE_VERSION) return false;
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
