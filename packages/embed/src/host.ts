/**
 * The embed side of the host protocol: a `message` listener on one end, the `ShellController` and
 * the `Engine` on the other (`docs/EMBED.md`, `protocol.ts`).
 *
 * **Every host message ends in a call a user can make with the mouse.** `load` is the route File ▸
 * Open Scene… takes, `setCursor` is a click in a pane, `updateLayer` is the property editor,
 * `screenshot` is the toolbar button. There is no embed-only path into the scene, which is the same
 * property `automation/run.ts` keeps for `--job` and for the same reason: a picture the host asks
 * for is a picture the product can produce, and a bug reachable from the protocol is a bug a user
 * can reach too.
 *
 * The class owns no scene state. It is a translation layer plus three subscriptions — the engine's
 * `progress` and `error`, and the store's projections — and its `stop()` removes all of them.
 */

import type {
  Camera3D,
  Engine,
  Layer,
  LayerId,
  PointsLayer,
  ProbeResult,
  ProbeRow,
  ViewSpec,
  vec3,
} from '@tetravox/engine';
import type { ShellController } from '../../app/src/renderer/src/store/controller';
import type { UiStore } from '../../app/src/renderer/src/store/store';
import { spaceKey } from '../../app/src/renderer/src/store/store';
import { fieldKey, selectField } from '../../app/src/renderer/src/panels/layers/mesh/state';
import {
  ENVELOPE_VERSION,
  PROTOCOL_VERSION,
  acceptMessage,
  withId,
  type EmbedMessage,
  type EmbedViewSpec,
  type HostMessage,
  type LoadedDataset,
} from './protocol';
import { normalizeScene } from './normalize';
import { resolvePoint, stateColorsOf } from './points';
import { resolveLayout } from './layout';

/** How often at most a `cursor` event may leave the frame. 30 Hz — see `CursorMessage`. */
export const CURSOR_THROTTLE_MS = 1000 / 30;

export interface EmbedHostOptions {
  /** Null when there is no WebGL2 context — see `ShellReady`. */
  controller: ShellController | null;
  engine: Engine | null;
  store: UiStore;
  /** The origin the host must post from; `'*'` accepts any. `''` accepts none. */
  hostOrigin: string;
  /** Where a reply goes. Defaults to `window.parent.postMessage`. */
  post?: (message: EmbedMessage, targetOrigin: string) => void;
  /** The window a message must have come from. Defaults to `window.parent`. */
  expectedSource?: unknown;
  /** Base for a relative `DatasetRef.path` when the host sends no `baseUrl`. */
  defaultBaseUrl?: string;
  now?: () => number;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** A `Blob` as a `data:` URL. `FileReader` rather than a manual base64 loop over a 10 MB PNG. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the screenshot'));
    reader.readAsDataURL(blob);
  });
}

/** Which modifiers were held on the press that produced a {@link PickMessage}. */
export interface PickModifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * One thing a press resolved to, before the best of them is chosen.
 *
 * `rank` is how *specific* the answer is, and the ordering is the whole reason this type exists:
 * a point the user actually hit (2) says more than the triangle behind it (1), which says more than
 * "the crosshair moved" (0). Highest rank wins; ties go to the first, because the first is the one
 * the engine resolved rather than a consequence of it.
 */
interface PickCandidate {
  rank: 0 | 1 | 2;
  kind: 'point' | 'tri' | 'tet' | 'slice' | 'cursor';
  world: vec3;
  viewId?: string;
  layerId?: string;
  pointId?: string;
  elementId?: number;
}

/** The label row a `pick` lifts out of its `ProbeResult` — the "which region did I click" answer. */
function labelOf(result: ProbeResult): { id: number; name?: string; layerId: string } | undefined {
  const row: ProbeRow | undefined = result.rows.find(
    (r) => r.kind === 'volume' && r.labelId !== undefined
  );
  if (row?.labelId === undefined) return undefined;
  return {
    id: row.labelId,
    ...(row.labelName === undefined ? {} : { name: row.labelName }),
    layerId: row.layerId,
  };
}

/** The tissue-tag row, the mesh twin of {@link labelOf}. */
function tagOf(result: ProbeResult): { id: number; name?: string; layerId: string } | undefined {
  const row: ProbeRow | undefined = result.rows.find(
    (r) => r.kind === 'mesh' && r.tag !== undefined
  );
  if (row?.tag === undefined) return undefined;
  return {
    id: row.tag,
    ...(row.tagName === undefined ? {} : { name: row.tagName }),
    layerId: row.layerId,
  };
}

/**
 * What every message except `hello` is answered with when there is no context.
 *
 * A host that ignored `ready.caps.webgl2` and sent a `load` anyway gets a reason rather than
 * silence — silence here would be indistinguishable from a dropped message, and would send it
 * looking for a bug in its own origin check.
 */
const NO_ENGINE = 'no WebGL2 context: this embed cannot render (see ready.caps.webgl2)';

export class EmbedHost {
  readonly #controller: ShellController | null;
  readonly #engine: Engine | null;
  readonly #store: UiStore;
  readonly #hostOrigin: string;
  readonly #post: (message: EmbedMessage, targetOrigin: string) => void;
  readonly #expectedSource: unknown;
  readonly #defaultBaseUrl: string;
  readonly #now: () => number;

  /**
   * `Engine.serialize()` on the **empty** scene, captured in the constructor.
   *
   * This is what fills the nine §4.6 view fields a host omits (`normalize.ts`). It has to be taken
   * before anything loads: once a scene is in, `serialize()` describes *that* camera, and a second
   * `load` sending no `view3d` would silently inherit the previous scene's view instead of the
   * fitted one the engine would have chosen.
   */
  readonly #template: ViewSpec | null;

  #offs: (() => void)[] = [];
  #lastCursorAt = 0;
  #lastLayers: readonly Layer[] | null = null;

  // -- protocol 2: pick events (2026-09-04) ------------------------------------------------------
  /**
   * Whether `pick` is being emitted at all — `setPickEvents`, and **off** until a host asks.
   *
   * The whole compatibility claim rests on this being false by default: a protocol-1 host receives
   * exactly the messages a protocol-1 build would have sent it.
   */
  #pickEvents = false;
  /** §6.7's `setHoverEvents`, and the last point reported — `null` is "nothing under the pointer". */
  #hoverEvents = false;
  #hovered: { layerId: string; pointId: string } | null = null;
  /**
   * The press in flight, and the best thing it has resolved to so far.
   *
   * One press is one `pick`, and the signals do not arrive in order of usefulness: placing a point
   * in the 3-D pane runs §7.2.3's id pass *first* (`#placePoint` picks to find a world point) and
   * emits `pointTool: 'placed'` after it. So the candidates are ranked and the best one is sent
   * once the whole event dispatch is over — `setTimeout(0)` rather than a microtask, because a
   * microtask checkpoint runs *between* two listeners of the same event and would fire while the
   * engine's own handler had not run yet.
   */
  #press: { modifiers: PickModifiers; best: PickCandidate | null; timer: number } | null = null;

  constructor(opts: EmbedHostOptions) {
    this.#controller = opts.controller;
    this.#engine = opts.engine;
    this.#store = opts.store;
    this.#hostOrigin = opts.hostOrigin;
    this.#expectedSource = opts.expectedSource ?? globalThis.parent;
    this.#now = opts.now ?? (() => Date.now());
    this.#defaultBaseUrl =
      opts.defaultBaseUrl ??
      (typeof document === 'undefined' ? 'http://localhost/' : document.baseURI);
    this.#post =
      opts.post ??
      ((message, targetOrigin) => {
        (globalThis.parent as Window | undefined)?.postMessage(message, targetOrigin);
      });
    this.#template = opts.engine?.serialize() ?? null;
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  /** Attach every listener and announce the embed. Returns the detach function. */
  start(): () => void {
    const onMessage = (event: MessageEvent): void => {
      const message = acceptMessage(
        { source: event.source, origin: event.origin, data: event.data },
        { expectedSource: this.#expectedSource, hostOrigin: this.#hostOrigin }
      );
      // `null` is the overwhelmingly common case on any page with other postMessage traffic — a
      // dev-server HMR ping, a framework's devtools bridge. Silence, never an `error` reply.
      if (message !== null) void this.handle(message);
    };
    globalThis.addEventListener('message', onMessage as EventListener);
    this.#offs.push(() => globalThis.removeEventListener('message', onMessage as EventListener));

    const engine = this.#engine;
    if (engine !== null) {
      this.#offs.push(
        engine.on('progress', (p) => {
          const ds = engine.scene.datasets.get(p.datasetId);
          this.send({
            tvx: ENVELOPE_VERSION,
            type: 'progress',
            datasetId: p.datasetId,
            name: ds?.name ?? '',
            phase: p.phase,
            done: p.done,
            total: p.total,
          });
        })
      );
      this.#offs.push(
        engine.on('error', (e) => {
          this.send({ tvx: ENVELOPE_VERSION, type: 'error', code: e.code, message: e.message });
        })
      );
    }

    // The store rather than the engine for these two: `Engine.load` writes cursor and layout
    // straight into the scene without emitting an event per field, and `ShellController` is what
    // reconciles that back into the projections (`resyncFromEngine`). Subscribing to the store is
    // therefore the only place that sees *every* change, including a load's.
    this.#offs.push(
      this.#store.subscribe((state, prev) => {
        if (state.layers !== prev.layers) this.emitLayers(state.layers);
        if (state.cursor !== prev.cursor) {
          // Offered **before** the 30 Hz throttle: a cursor event a host does not need every frame
          // is still a click a host must not lose. `notePick` is a no-op unless a press is in
          // flight, so the host's own `setCursor` and the arrow keys produce no `pick`.
          this.notePick({ rank: 0, kind: 'cursor', world: [...state.cursor] as vec3 });
          this.emitCursor(state.cursor);
        }
      })
    );

    // -- protocol 2 -----------------------------------------------------------------------------
    if (engine !== null) {
      // §7.2.3's id pass answered. In 3-D this is the double-click that sets the cursor and the
      // world point `place` mode lands on; in 2-D nothing calls it, which is why `pick` also
      // listens to the cursor above.
      this.#offs.push(
        engine.on('pick', (hit) => {
          if (hit === null) return;
          this.notePick({
            rank: 1,
            kind: hit.elementKind,
            world: [...hit.world] as vec3,
            layerId: hit.layerId,
            elementId: hit.elementId,
          });
        })
      );
      // §7.5's point tool. Forwarded whole — a host editing points needs `dragEnd` and `cleared`'s
      // `reason`, not a summary — and `placed`/`selected` are also the most specific thing a press
      // can resolve to, so they outrank everything above.
      this.#offs.push(
        engine.on('pointTool', (event) => {
          this.send({ tvx: ENVELOPE_VERSION, type: 'pointTool', event });
          if (event.kind !== 'placed' && event.kind !== 'selected') return;
          const world = event.world ?? this.pointPosition(event.layerId, event.pointId);
          if (world === null) return;
          this.notePick({
            rank: 2,
            kind: 'point',
            world,
            layerId: event.layerId,
            ...(event.pointId === null ? {} : { pointId: event.pointId }),
            ...(event.viewId === undefined ? {} : { viewId: event.viewId }),
          });
        })
      );
    }

    // The press itself. On `document` and in the **capture** phase so it is recorded before the
    // engine's own canvas handler runs the gesture that produces the candidates above; filtered to
    // the engine canvas so a click on the layer panel is not a pick.
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest('[data-testid="engine-canvas"]') === null
      ) {
        return;
      }
      this.beginPress({
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
      });
    };
    globalThis.document?.addEventListener('pointerdown', onPointerDown as EventListener, true);
    this.#offs.push(() =>
      globalThis.document?.removeEventListener('pointerdown', onPointerDown as EventListener, true)
    );

    // §6.7's hover (2026-09-05). Off by default and, when on, a hit test per move — which is why it
    // is opt-in: §8 gives hover a 16 ms budget and a host that does not paint a hover must not pay
    // for one. `pointermove` on the canvas, not on `document`, because a move over the layer panel
    // is not over a pane and the engine's own hit test would have to be asked to say so.
    const onPointerMove = (event: PointerEvent): void => {
      if (!this.#hoverEvents) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const canvas = target.closest('[data-testid="engine-canvas"]');
      if (!(canvas instanceof HTMLCanvasElement)) return;
      this.noteHover(canvas, event.clientX, event.clientY);
    };
    const onPointerLeave = (): void => {
      if (this.#hoverEvents) this.emitHover(null);
    };
    globalThis.document?.addEventListener('pointermove', onPointerMove as EventListener, true);
    globalThis.document?.addEventListener('pointerleave', onPointerLeave as EventListener, true);
    this.#offs.push(() => {
      globalThis.document?.removeEventListener('pointermove', onPointerMove as EventListener, true);
      globalThis.document?.removeEventListener(
        'pointerleave',
        onPointerLeave as EventListener,
        true
      );
    });

    this.emitReady();
    this.emitStatus();
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
    if (this.#press !== null) clearTimeout(this.#press.timer);
    this.#press = null;
  }

  // ---- outbound ---------------------------------------------------------------------------------

  /** Post to the host. `'*'` as the configured origin becomes `'*'` as the target origin. */
  send(message: EmbedMessage): void {
    if (this.#hostOrigin === '') return;
    this.#post(message, this.#hostOrigin);
  }

  /**
   * Answer a request that acts and returns nothing — `setPointTool`, `setPointSelection`,
   * `setPoints`.
   *
   * **Only when the request carried an `id`.** That is `withId`'s rule for every other reply in this
   * file, and here it is the whole message: an `ack` with nothing to correlate is an event no host
   * subscribed to, and posting one to every protocol-1 host would break the guarantee that their
   * message stream is byte for byte the one they get today.
   */
  private ack(request: HostMessage): void {
    if (request.id === undefined) return;
    this.send({ tvx: ENVELOPE_VERSION, type: 'ack', id: request.id, of: request.type });
  }

  private emitReady(request?: { id?: string }): void {
    const caps = this.#store.getState().caps;
    const ok =
      this.#engine !== null && this.#store.getState().status !== 'webgl2-null' && caps !== null;
    const message: EmbedMessage = {
      tvx: ENVELOPE_VERSION,
      type: 'ready',
      version: PROTOCOL_VERSION,
      caps: ok
        ? { webgl2: true, renderer: caps?.renderer, norm16: caps?.norm16 }
        : { webgl2: false },
    };
    this.send(request === undefined ? message : withId(message, request));
  }

  private emitStatus(message?: string): void {
    const state = this.#store.getState();
    const phase =
      state.status === 'webgl2-null'
        ? 'no-webgl2'
        : state.status === 'failed'
          ? 'error'
          : state.layers.length > 0
            ? 'ready'
            : 'idle';
    this.send({
      tvx: ENVELOPE_VERSION,
      type: 'status',
      phase,
      ...(message === undefined ? {} : { message }),
    });
  }

  private emitLayers(layers: readonly Layer[]): void {
    if (layers === this.#lastLayers) return;
    this.#lastLayers = layers;
    this.send({ tvx: ENVELOPE_VERSION, type: 'layers', layers: [...layers] });
  }

  /**
   * The cursor, at most 30 times a second.
   *
   * A drag moves the cursor once per frame and each one carries a `probe` — a point-in-tetrahedron
   * search over the loaded meshes. Throttling here rather than in the host is deliberate: the cost
   * being avoided is the *structured clone* out of the frame and the host's re-render, and only
   * this side can decline to pay it.
   */
  private emitCursor(world: vec3): void {
    const now = this.#now();
    if (now - this.#lastCursorAt < CURSOR_THROTTLE_MS) return;
    this.#lastCursorAt = now;
    const state = this.#store.getState();
    const probe = state.cursorProbe;
    this.send({
      tvx: ENVELOPE_VERSION,
      type: 'cursor',
      world: [...world] as vec3,
      ...(probe?.mni === undefined ? {} : { mni: [...probe.mni] as vec3 }),
      ...(probe?.tkr === undefined ? {} : { tkr: [...probe.tkr] as vec3 }),
      space: spaceKey(state.coordSpace),
    });
  }

  // ---- protocol 2: pick ---------------------------------------------------------------------------

  /**
   * Which point is under the pointer, if any — §6.7's `pointHover`.
   *
   * Two engine calls and no new engine API: `paneAt` says which pane a canvas point is in and hands
   * back **pane-local device** pixels, and `pointAtScreen` is the same hit test the point tool's own
   * grab uses, in **CSS** pixels — so the conversion between them is the one `/ dpr` below, and a
   * host's hover and a user's click can never disagree about which electrode they are on. Doing it
   * per pane rather than assuming the active one is what makes this correct in a 2x2 layout.
   *
   * The engine's own hover (`hoverAtScreen`) is a *world point*, not an identity, which is why this
   * exists at all: a host painting "the electrode under the mouse" needs the id it sent, and a
   * coordinate would make it re-solve a hit test the engine has already run.
   */
  private noteHover(canvas: HTMLCanvasElement, clientX: number, clientY: number): void {
    const engine = this.#engine;
    if (engine === null) return;
    const box = canvas.getBoundingClientRect();
    const dpr = canvas.width / Math.max(1, box.width);
    const pane = engine.paneAt((clientX - box.left) * dpr, (clientY - box.top) * dpr);
    if (pane === null) {
      this.emitHover(null);
      return;
    }
    const hit = engine.pointAtScreen(pane.viewId, pane.x / dpr, pane.y / dpr);
    this.emitHover(hit === null ? null : { layerId: hit.layerId, pointId: hit.pointId });
  }

  /**
   * Post a `pointHover` — but only when the answer **changed**.
   *
   * A move is many events per second and the answer is the same for all but two of them; a host
   * that repainted on each would be repainting a net of 185 electrodes at pointer rate to say
   * nothing. The edge is the event: one message when the pointer arrives on a point, one when it
   * leaves it (`pointId: null`), and nothing in between.
   */
  private emitHover(next: { layerId: string; pointId: string } | null): void {
    const was = this.#hovered;
    if (was?.pointId === next?.pointId && was?.layerId === next?.layerId) return;
    this.#hovered = next;
    this.send({
      tvx: ENVELOPE_VERSION,
      type: 'pointHover',
      layerId: next?.layerId ?? null,
      pointId: next?.pointId ?? null,
    });
  }

  /**
   * A left press landed on a pane. Open a window for the candidates it will produce.
   *
   * A press that is already open is replaced rather than extended — two presses is two picks, and
   * the second one's modifiers are the ones the user is holding now.
   */
  private beginPress(modifiers: PickModifiers): void {
    if (!this.#pickEvents) return;
    if (this.#press !== null) clearTimeout(this.#press.timer);
    const timer = setTimeout(() => this.flushPick(), 0) as unknown as number;
    this.#press = { modifiers, best: null, timer };
  }

  /** Offer one answer for the press in flight. Higher {@link PickCandidate.rank} wins; ties keep the first. */
  private notePick(candidate: PickCandidate): void {
    const press = this.#press;
    if (press === null) return;
    if (press.best === null || candidate.rank > press.best.rank) press.best = candidate;
  }

  /**
   * Send the best answer this press produced, with the probe at the point it landed on.
   *
   * `probeWorld` is the controller's own — the call §8's info panel makes — so what a host reads out
   * of `pick.probe` is what a user reads under the crosshair. Its mesh rows are at most one round
   * trip stale (§4.7); the volume rows, `label` among them, are exact.
   */
  private flushPick(): void {
    const press = this.#press;
    this.#press = null;
    if (press === null || press.best === null || !this.#pickEvents) return;
    const controller = this.#controller;
    if (controller === null) return;
    const best = press.best;
    const probe = controller.probeWorld([...best.world] as vec3);
    const label = labelOf(probe);
    const tag = tagOf(probe);
    this.send({
      tvx: ENVELOPE_VERSION,
      type: 'pick',
      kind: best.kind,
      world: [...best.world] as vec3,
      ...(best.viewId === undefined ? {} : { viewId: best.viewId }),
      ...(best.layerId === undefined ? {} : { layerId: best.layerId }),
      ...(best.pointId === undefined ? {} : { pointId: best.pointId }),
      ...(best.elementId === undefined ? {} : { elementId: best.elementId }),
      ...(label === undefined ? {} : { label }),
      ...(tag === undefined ? {} : { tag }),
      modifiers: press.modifiers,
      probe,
    });
  }

  /**
   * Where a point is, for a `pointTool` event that carried no `world`.
   *
   * `selected` from `Engine.setPointSelection` — the host's own `setPointSelection`, or a
   * `points` replacement re-resolving the selection — has no click behind it and therefore no
   * world point. The layer still knows where the point is.
   */
  private pointPosition(layerId: string, pointId: string | null): vec3 | null {
    if (pointId === null) return null;
    const layer = this.#engine?.scene.layers.find((l) => l.id === layerId);
    if (layer === undefined || layer.kind !== 'points') return null;
    const point = (layer as PointsLayer).points.find((p) => p.id === pointId);
    return point === undefined ? null : ([...point.position] as vec3);
  }

  private fail(request: HostMessage, error: unknown): void {
    const code = errorCodeOf(error);
    this.send(
      withId(
        {
          tvx: ENVELOPE_VERSION,
          type: 'error',
          ...(code === undefined ? {} : { code }),
          message: errorMessageOf(error),
        },
        request
      )
    );
  }

  /**
   * The three things that exist only with a context, after `handle`'s guard has established that
   * they do. TypeScript cannot carry that narrowing across a method call, and the alternative — a
   * non-null assertion at each of the five uses — would be five places that stop being checked.
   */
  #live(): { controller: ShellController; engine: Engine; template: ViewSpec } {
    if (this.#controller === null || this.#engine === null || this.#template === null) {
      throw new Error(NO_ENGINE);
    }
    return { controller: this.#controller, engine: this.#engine, template: this.#template };
  }

  // ---- inbound ----------------------------------------------------------------------------------

  /** Exhaustive over `HostMessage`. Public so the e2e can drive it without a second window. */
  async handle(message: HostMessage): Promise<void> {
    try {
      // `hello` is the one message a context-less embed can still answer, and it is the one that
      // matters most there: its `ready` is how the host learns why nothing else will work.
      if (message.type === 'hello') {
        this.emitReady(message);
        this.emitStatus();
        return;
      }
      const controller = this.#controller;
      const engine = this.#engine;
      if (controller === null || engine === null) {
        this.send(withId({ tvx: ENVELOPE_VERSION, type: 'error', message: NO_ENGINE }, message));
        return;
      }
      switch (message.type) {
        case 'load':
          await this.load(message.scene, message.baseUrl, message);
          return;
        case 'setTheme':
          // `persist: false`: there is no `settings.json` behind an embed, and the host owns the
          // preference anyway — it sent it. Persisting would write through a null bridge and change
          // nothing, which is a slower way of doing the same thing less honestly.
          controller.setThemeChoice(message.theme, { persist: false });
          return;
        case 'setLayout': {
          // `layout.ts` says why this is a lookup and not a cast: four of the seven kinds
          // `docs/EMBED.md` documents are not §4.5 `LayoutKind`s, and one of those reaching
          // `Engine.setLayout` stored `cells: undefined` and threw in the *render loop* on the next
          // frame — a documented message that killed the viewer with no reply to the host.
          const layout = resolveLayout(message.kind);
          if (layout === null) {
            this.send(
              withId(
                {
                  tvx: ENVELOPE_VERSION,
                  type: 'error',
                  message: `unknown layout kind '${String(message.kind)}'`,
                },
                message
              )
            );
            return;
          }
          // The active view first: `layoutCells('1x1', …, preferred)` is the only thing that decides
          // *which* pane a single-pane layout shows.
          if (layout.viewId !== undefined) controller.setActiveView(layout.viewId);
          controller.setLayout(layout.kind);
          return;
        }
        case 'setCursor':
          controller.setCursorWorld([...message.world] as vec3);
          return;
        case 'setLayerVisible':
          controller.patchLayer(message.layerId as LayerId, { visible: message.visible });
          return;
        case 'setLayerOpacity':
          controller.setOpacity(message.layerId as LayerId, message.opacity);
          return;
        case 'updateLayer':
          controller.patchLayer(message.layerId as LayerId, message.patch as Partial<Layer>);
          // A clip plane that follows the cursor needs its subscription armed, exactly as the
          // property editor's own checkbox does (`ClipPlanes.tsx`). Without this a host can set
          // `followCursor: true` and watch the plane never move.
          controller.applyClipFollowsCursor(message.layerId as LayerId);
          return;
        case 'setActiveLayer':
          controller.setActiveLayer(message.layerId as LayerId | null);
          return;
        case 'screenshot':
          await this.screenshot(message);
          return;
        case 'serialize':
          this.send(
            withId(
              {
                tvx: ENVELOPE_VERSION,
                type: 'scene',
                id: message.id,
                spec: engine.serialize(),
              },
              message
            )
          );
          return;
        case 'probe': {
          const result: ProbeResult = controller.probeWorld([...message.world] as vec3);
          this.send(
            withId({ tvx: ENVELOPE_VERSION, type: 'probe', id: message.id, result }, message)
          );
          return;
        }
        case 'focus':
          // The canvas, not `window` — an iframe's `window.focus()` scrolls the *host* to the frame
          // and does not put the caret anywhere the §7.5 key map can see it.
          (document.querySelector('[data-testid="engine-canvas"]') as HTMLElement | null)?.focus();
          globalThis.focus?.();
          return;
        case 'reset':
          // §5 rule 1: `newScene` closes every dataset, and closing a dataset is
          // `worker.terminate()`, which is the only way its wasm heap comes back.
          controller.newScene();
          this.emitLayers(this.#store.getState().layers);
          this.emitStatus();
          return;

        // -- protocol 2 (2026-09-04) ------------------------------------------------------------
        case 'setPickEvents':
          this.#pickEvents = message.enabled;
          if (!message.enabled && this.#press !== null) {
            clearTimeout(this.#press.timer);
            this.#press = null;
          }
          return;
        case 'setHoverEvents':
          this.#hoverEvents = message.enabled;
          // Turning it off forgets what was under the pointer, so turning it back on re-announces
          // rather than staying silent because the answer "has not changed" since last time.
          if (!message.enabled) this.#hovered = null;
          this.ack(message);
          return;
        case 'setPointTool':
          // The same call the sEEG editor's Add button makes. `null` disarms and emits one
          // `pointTool: 'cleared'` with `reason: 'host'`; arming materialises `p<index>` ids on a
          // layer whose points carry none, which is why a `layers` event follows.
          engine.setPointTool(
            message.layerId === null
              ? null
              : {
                  layerId: message.layerId as LayerId,
                  mode: message.mode ?? 'select',
                  ...(message.template === undefined ? {} : { template: message.template }),
                }
          );
          this.ack(message);
          return;
        case 'setPointSelection':
          engine.setPointSelection(
            message.pointId === null
              ? null
              : { layerId: message.layerId as LayerId, pointId: message.pointId }
          );
          this.ack(message);
          return;
        case 'setPoints': {
          // Through `patchLayer` like every other edit, so the store, the property editor and the
          // scene's dirty flag all see it. The palette comes off the live layer: `stateColors` is
          // kept there by `resolvePointsLayer` for exactly this call.
          const live = engine.scene.layers.find((l) => l.id === message.layerId);
          const points = message.points.map((p) => resolvePoint(p, stateColorsOf(live)));
          controller.patchLayer(message.layerId as LayerId, { points } as Partial<Layer>);
          // After the patch, so `await setPoints(...)` then `screenshot` is a sequence and not a
          // race: the `layers` event carrying the new points has already gone out.
          this.ack(message);
          return;
        }
        case 'getCamera':
          this.send(
            withId(
              { tvx: ENVELOPE_VERSION, type: 'camera', camera: controller.moduleCamera() },
              message
            )
          );
          return;
        case 'setCamera': {
          // The preset first, then the patch: a host asking for "left, but pulled back" means the
          // preset's rotation with its own distance, and the other order would throw the distance
          // away. `cameraPreset` and `setModuleCamera` are the controller's own calls — the keyboard's
          // `1..6` and §13.1's `scene.setCamera` — so nothing here is an embed-only path into the view.
          if (message.preset !== undefined) controller.cameraPreset(message.preset);
          if (message.patch !== undefined) {
            controller.setModuleCamera(message.patch as Partial<Camera3D>);
          }
          if (message.id !== undefined) {
            this.send(
              withId(
                { tvx: ENVELOPE_VERSION, type: 'camera', camera: controller.moduleCamera() },
                message
              )
            );
          }
          return;
        }
      }
    } catch (error: unknown) {
      this.fail(message, error);
    }
  }

  private async load(
    scene: EmbedViewSpec,
    baseUrl: string | undefined,
    request: HostMessage
  ): Promise<void> {
    const { controller, template } = this.#live();
    this.send({ tvx: ENVELOPE_VERSION, type: 'status', phase: 'loading' });
    let normalized;
    try {
      normalized = normalizeScene(scene, template, baseUrl ?? this.#defaultBaseUrl);
    } catch (error: unknown) {
      // A bad `baseUrl` or an unresolvable ref throws in `new URL`. Reported as the host's own
      // error, with the message naming the URL it could not make sense of.
      this.send({ tvx: ENVELOPE_VERSION, type: 'status', phase: 'error' });
      this.fail(request, error);
      return;
    }

    const ok = await controller.loadSpecFromUrls(normalized.spec, normalized.resolved);
    if (!ok) {
      const message = this.#store.getState().sceneError ?? 'the scene could not be loaded';
      this.send({ tvx: ENVELOPE_VERSION, type: 'status', phase: 'error', message });
      this.send(withId({ tvx: ENVELOPE_VERSION, type: 'error', message }, request));
      return;
    }

    this.seedMeshFieldWindows(scene, controller);

    const state = this.#store.getState();
    const datasets: LoadedDataset[] = state.datasets.map((ds) => {
      const bytes = state.heapBytes[ds.id];
      return {
        id: ds.id,
        name: ds.name,
        kind: ds.kind === 'volume' ? 'volume' : 'mesh',
        ...(bytes === undefined ? {} : { bytes }),
      };
    });
    this.#lastLayers = state.layers;
    this.send(
      withId(
        { tvx: ENVELOPE_VERSION, type: 'loaded', datasets, layers: [...state.layers] },
        request
      )
    );
    this.emitStatus();
  }

  /**
   * Window a mesh field layer the host selected a field for but could not scale.
   *
   * `scene/defaults.ts` gives a mesh layer `scale: { kind: 'linear', lo: 0, hi: 1 }`, because a
   * layer has no field until something picks one. In the desktop app the *property editor* picks
   * it, and `selectField` re-seeds the scale and the threshold from that field's own `Stats` — the
   * comment there says why: "a viridis ramp still pinned to the previous field's range is the same
   * bug as an unset window". A host sending a `ViewSpec` never goes through that editor, and it
   * cannot compute the range itself: `MeshFieldInfo.stats` is derived by the parser, in the
   * worker, from bytes the host has never seen. Left alone, a `TI_max` field whose values live in
   * 0.002..0.13 renders as one flat colour at the bottom of the ramp — which is exactly what this
   * looked like before the seeding was added.
   *
   * So the embed makes the call the editor would have made, and **only** where the host said
   * nothing: a spec that carries its own `scale` — every scene saved by the app does — is left
   * exactly as it was written. `selectField` is the app's own function, not a copy of it, so the
   * window a host gets is the window a user gets.
   *
   * The live layer is found positionally. `Engine.load` adds one layer per restorable spec layer,
   * in order, which is the same correspondence `applyScene` uses to restore `activeLayerId`.
   */
  private seedMeshFieldWindows(scene: EmbedViewSpec, controller: ShellController): void {
    const live = this.#store.getState().layers;
    scene.layers.forEach((specLayer, index) => {
      if (specLayer['kind'] !== 'mesh') return;
      if (specLayer['scale'] !== undefined) return;
      const field = specLayer['field'] as { source: 'node' | 'elm'; name: string } | undefined;
      if (field === undefined) return;
      const layer = live[index];
      if (layer === undefined || layer.kind !== 'mesh') return;
      const dataset = this.#engine?.scene.datasets.get(layer.datasetId);
      if (dataset === undefined || dataset.kind !== 'mesh') return;
      const patch = selectField(dataset, layer, fieldKey(field));
      if (Object.keys(patch).length > 0) controller.patchLayer(layer.id, patch);
    });
  }

  private async screenshot(message: Extract<HostMessage, { type: 'screenshot' }>): Promise<void> {
    const { controller } = this.#live();
    const options = {
      ...controller.snapshotOptions(),
      target: message.target ?? 'grid',
      ...(message.viewId === undefined ? {} : { viewId: message.viewId }),
      ...(message.width === undefined ? {} : { width: message.width }),
      ...(message.height === undefined ? {} : { height: message.height }),
    };
    const blob = await controller.captureScreenshot(options as never);
    const dataUrl = await blobToDataUrl(blob);
    this.send(
      withId({ tvx: ENVELOPE_VERSION, type: 'screenshot', id: message.id, dataUrl }, message)
    );
  }
}
