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
  Engine,
  Layer,
  LayerId,
  LayoutKind,
  ProbeResult,
  ViewSpec,
  vec3,
} from '@tetravox/engine';
import type { ShellController } from '../../app/src/renderer/src/store/controller';
import type { UiStore } from '../../app/src/renderer/src/store/store';
import { spaceKey } from '../../app/src/renderer/src/store/store';
import {
  PROTOCOL_VERSION,
  acceptMessage,
  withId,
  type EmbedMessage,
  type HostMessage,
  type LoadedDataset,
} from './protocol';
import { normalizeScene } from './normalize';

/** How often at most a `cursor` event may leave the frame. 30 Hz — see `CursorMessage`. */
export const CURSOR_THROTTLE_MS = 1000 / 30;

export interface EmbedHostOptions {
  controller: ShellController;
  engine: Engine;
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

export class EmbedHost {
  readonly #controller: ShellController;
  readonly #engine: Engine;
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
  readonly #template: ViewSpec;

  #offs: (() => void)[] = [];
  #lastCursorAt = 0;
  #lastLayers: readonly Layer[] | null = null;

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
    this.#template = opts.engine.serialize();
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

    this.#offs.push(
      this.#engine.on('progress', (p) => {
        const ds = this.#engine.scene.datasets.get(p.datasetId);
        this.send({
          tvx: PROTOCOL_VERSION,
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
      this.#engine.on('error', (e) => {
        this.send({ tvx: PROTOCOL_VERSION, type: 'error', code: e.code, message: e.message });
      })
    );

    // The store rather than the engine for these two: `Engine.load` writes cursor and layout
    // straight into the scene without emitting an event per field, and `ShellController` is what
    // reconciles that back into the projections (`resyncFromEngine`). Subscribing to the store is
    // therefore the only place that sees *every* change, including a load's.
    this.#offs.push(
      this.#store.subscribe((state, prev) => {
        if (state.layers !== prev.layers) this.emitLayers(state.layers);
        if (state.cursor !== prev.cursor) this.emitCursor(state.cursor);
      })
    );

    this.emitReady();
    this.emitStatus();
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
  }

  // ---- outbound ---------------------------------------------------------------------------------

  /** Post to the host. `'*'` as the configured origin becomes `'*'` as the target origin. */
  send(message: EmbedMessage): void {
    if (this.#hostOrigin === '') return;
    this.#post(message, this.#hostOrigin);
  }

  private emitReady(request?: { id?: string }): void {
    const caps = this.#store.getState().caps;
    const ok = this.#store.getState().status !== 'webgl2-null' && caps !== null;
    const message: EmbedMessage = {
      tvx: PROTOCOL_VERSION,
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
      tvx: PROTOCOL_VERSION,
      type: 'status',
      phase,
      ...(message === undefined ? {} : { message }),
    });
  }

  private emitLayers(layers: readonly Layer[]): void {
    if (layers === this.#lastLayers) return;
    this.#lastLayers = layers;
    this.send({ tvx: PROTOCOL_VERSION, type: 'layers', layers: [...layers] });
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
      tvx: PROTOCOL_VERSION,
      type: 'cursor',
      world: [...world] as vec3,
      ...(probe?.mni === undefined ? {} : { mni: [...probe.mni] as vec3 }),
      ...(probe?.tkr === undefined ? {} : { tkr: [...probe.tkr] as vec3 }),
      space: spaceKey(state.coordSpace),
    });
  }

  private fail(request: HostMessage, error: unknown): void {
    const code = errorCodeOf(error);
    this.send(
      withId(
        {
          tvx: PROTOCOL_VERSION,
          type: 'error',
          ...(code === undefined ? {} : { code }),
          message: errorMessageOf(error),
        },
        request
      )
    );
  }

  // ---- inbound ----------------------------------------------------------------------------------

  /** Exhaustive over `HostMessage`. Public so the e2e can drive it without a second window. */
  async handle(message: HostMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'hello':
          this.emitReady(message);
          this.emitStatus();
          return;
        case 'load':
          await this.load(message.scene, message.baseUrl, message);
          return;
        case 'setTheme':
          // `persist: false`: there is no `settings.json` behind an embed, and the host owns the
          // preference anyway — it sent it. Persisting would write through a null bridge and change
          // nothing, which is a slower way of doing the same thing less honestly.
          this.#controller.setThemeChoice(message.theme, { persist: false });
          return;
        case 'setLayout':
          this.#controller.setLayout(message.kind as LayoutKind);
          return;
        case 'setCursor':
          this.#controller.setCursorWorld([...message.world] as vec3);
          return;
        case 'setLayerVisible':
          this.#controller.patchLayer(message.layerId as LayerId, { visible: message.visible });
          return;
        case 'setLayerOpacity':
          this.#controller.setOpacity(message.layerId as LayerId, message.opacity);
          return;
        case 'updateLayer':
          this.#controller.patchLayer(message.layerId as LayerId, message.patch as Partial<Layer>);
          // A clip plane that follows the cursor needs its subscription armed, exactly as the
          // property editor's own checkbox does (`ClipPlanes.tsx`). Without this a host can set
          // `followCursor: true` and watch the plane never move.
          this.#controller.applyClipFollowsCursor(message.layerId as LayerId);
          return;
        case 'setActiveLayer':
          this.#controller.setActiveLayer(message.layerId as LayerId | null);
          return;
        case 'screenshot':
          await this.screenshot(message);
          return;
        case 'serialize':
          this.send(
            withId(
              {
                tvx: PROTOCOL_VERSION,
                type: 'scene',
                id: message.id,
                spec: this.#engine.serialize(),
              },
              message
            )
          );
          return;
        case 'probe': {
          const result: ProbeResult = this.#controller.probeWorld([...message.world] as vec3);
          this.send(
            withId({ tvx: PROTOCOL_VERSION, type: 'probe', id: message.id, result }, message)
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
          this.#controller.newScene();
          this.emitLayers(this.#store.getState().layers);
          this.emitStatus();
          return;
      }
    } catch (error: unknown) {
      this.fail(message, error);
    }
  }

  private async load(
    scene: Parameters<typeof normalizeScene>[0],
    baseUrl: string | undefined,
    request: HostMessage
  ): Promise<void> {
    this.send({ tvx: PROTOCOL_VERSION, type: 'status', phase: 'loading' });
    let normalized;
    try {
      normalized = normalizeScene(scene, this.#template, baseUrl ?? this.#defaultBaseUrl);
    } catch (error: unknown) {
      // A bad `baseUrl` or an unresolvable ref throws in `new URL`. Reported as the host's own
      // error, with the message naming the URL it could not make sense of.
      this.send({ tvx: PROTOCOL_VERSION, type: 'status', phase: 'error' });
      this.fail(request, error);
      return;
    }

    const ok = await this.#controller.loadSpecFromUrls(normalized.spec, normalized.resolved);
    if (!ok) {
      const message = this.#store.getState().sceneError ?? 'the scene could not be loaded';
      this.send({ tvx: PROTOCOL_VERSION, type: 'status', phase: 'error', message });
      this.send(withId({ tvx: PROTOCOL_VERSION, type: 'error', message }, request));
      return;
    }

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
        { tvx: PROTOCOL_VERSION, type: 'loaded', datasets, layers: [...state.layers] },
        request
      )
    );
    this.emitStatus();
  }

  private async screenshot(message: Extract<HostMessage, { type: 'screenshot' }>): Promise<void> {
    const options = {
      ...this.#controller.snapshotOptions(),
      target: message.target ?? 'grid',
      ...(message.viewId === undefined ? {} : { viewId: message.viewId }),
      ...(message.width === undefined ? {} : { width: message.width }),
      ...(message.height === undefined ? {} : { height: message.height }),
    };
    const blob = await this.#controller.captureScreenshot(options as never);
    const dataUrl = await blobToDataUrl(blob);
    this.send(
      withId({ tvx: PROTOCOL_VERSION, type: 'screenshot', id: message.id, dataUrl }, message)
    );
  }
}
