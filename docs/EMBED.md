---
layout: page
title: Embedding Tetravox
permalink: /EMBED.html
nav_order: 5
---

# Embedding Tetravox

Tetravox ships a **browser build** of the viewer that an application mounts in an `<iframe>` and
drives with `postMessage`. It is the same React shell, the same `ShellController` and the same
WebGL2 engine the desktop window runs — not a second, cut-down renderer — so every message below
ends in a call a user can make with the mouse, and a picture the host asks for is a picture the
product can produce.

Nothing is compiled into your application. You install a released tarball, serve its `dist/` from a
route of your choosing, and talk to it through the versioned contract on this page.

---

## 1. Install and serve

Download `tetravox-embed-<version>.tgz` from the [release
page](https://github.com/idossha/tetravox/releases) and unpack it:

```sh
tar xzf tetravox-embed-0.3.11.tgz
# tetravox-embed-0.3.11/
#   manifest.json          {"name":"@tetravox/embed","version":"0.3.11","protocol":2,"sha":"…"}
#   LICENSE  EMBED.md  protocol.schema.json  viewspec.schema.json
#   dist/index.html
#   dist/assets/…          the JS chunks, the CSS, two module workers, tvx_wasm_bg-*.wasm
```

Serve `dist/` under **any** path — `/tetravox/`, `/viewer/`, a versioned CDN prefix. The build is
`base: './'`, so every URL it emits is relative to `index.html` and nothing assumes a root.

`manifest.json` says which build you are serving: `protocol` is the contract version implemented
(`2` since 0.3.11), and `sha` is the commit it was built from. `version` is the **Tetravox release
version** — the embed carries no version of its own. Quote both in a bug report.

**`protocol` is the number to gate a feature on, and it is not the `tvx` on the wire.** Pin a
*range* and the features you need, never a version: everything protocol 2 added is optional, so a
host that needs none of it works against `protocol: 1` and `protocol: 2` alike, and a host that
wants the points layer checks `protocol >= 2` and falls back rather than refusing to start.

### Headers the host must send

| Path | Header | Why |
|---|---|---|
| `dist/assets/*.wasm` | `Content-Type: application/wasm` | `WebAssembly.instantiateStreaming` **rejects** any other type. A viewer that shows chrome and never loads a file is almost always this. |
| `dist/assets/*.js` | `Content-Type: text/javascript` | The page and its workers are ES modules. |
| every response | *no* `X-Frame-Options: DENY` / `frame-ancestors 'none'` | Both stop the iframe from being framed at all. |

### Content-Security-Policy

If you set a CSP **on the embed's own document**, it needs at least:

```
script-src 'self' 'wasm-unsafe-eval';
worker-src 'self' blob:;
connect-src 'self' <every origin you will load datasets from>;
img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline';
```

* `'wasm-unsafe-eval'` — compiling WebAssembly is script evaluation as far as CSP is concerned.
  Without it nothing parses.
* `worker-src 'self' blob:` — one Web Worker **per dataset** (§5). `blob:` is there because a
  bundler may hand a worker to the browser as a blob URL.
* `connect-src` must list every origin a `DatasetRef.path` can point at. The **worker** does the
  fetching, so this is the header that decides whether data can be read at all.
* `img-src … blob:` — a `screenshot` reply is produced from a canvas blob.

Do **not** set COOP/COEP. Tetravox is deliberately not cross-origin isolated: the WASM is
single-threaded forever (§1), so `SharedArrayBuffer` is not wanted, and enabling isolation would
break plain `<img>`/`fetch` of a dataset origin that does not send CORP.

### Cross-origin data

The dataset fetch is a normal `fetch` from a worker. Data served from a **different origin** than
the embed must send `Access-Control-Allow-Origin`. Same-origin data — the common case, where your
application serves both the bundle and the files — needs nothing.

Range requests are **not** used: a dataset is streamed whole and gzip is inflated in the worker.

---

## 2. The URL contract

```
<your route>/index.html?embed=1&hostOrigin=<origin>
```

| Parameter | Meaning |
|---|---|
| `embed=1` | Hides the chrome an embed cannot use — the `Tetravox` file menu, and the Settings dialog's Paths and Startup tabs. All of them end in a desktop-only call, and a control that silently does nothing is worse than no control. |
| `hostOrigin` | The **only** origin the embed will accept a message from, compared as an exact string. Percent-encode it. Omit it and the embed renders but accepts nothing — which is the right default for a page that cannot authenticate anybody. `*` accepts any origin and exists for a host that cannot predict its own; it is an escape hatch, not a default. |
| `presentation=viewport` | With `embed=1`, shows only the view grid: no toolbar, side panels or collapse rails, status bar, toasts, dialogs, or extension windows. The host owns the surrounding controls and receives the usual status/error events. Omit it, or supply an unknown value, to keep the full viewer. |

```js
const url = new URL('/tetravox/index.html', location.href);
url.searchParams.set('embed', '1');
url.searchParams.set('hostOrigin', location.origin);
iframe.src = url.href;
```

For a panel inside an application that supplies its own controls, also set
`url.searchParams.set('presentation', 'viewport')`. This is a shell presentation option: it uses
the same canvas, engine, workers and protocol. It does not choose the pane arrangement; send
`setLayout` with `kind: '3d'` for a single 3D viewport. Layer changes, screenshots, camera commands
and host events work as in the full viewer.

The viewport retains the scene's orientation annotations and the engine's pointer gestures:
orbit, pan, wheel dolly, picking, orientation-cube clicks, and pointer-scoped keyboard controls.
Shell shortcuts and file drops are inactive, because the host owns loading and tools and an
invisible measurement or layout control would leave the user with no way to inspect its state.
Presentation is selected when the iframe is created and stays fixed for its lifetime.

`?forceWebgl2Null=1` is also honoured, and is how you exercise your no-WebGL2 branch without a
blocklisted driver.

---

## 3. The protocol

Every message, in both directions:

```ts
{ tvx: 1, type: string, id?: string, ...payload }
```

`tvx` is what makes a Tetravox message recognisable in a `message` handler shared with your
framework's devtools bridge and everything else that posts to `window`. `id` is your correlation
token: a reply carries the `id` of the request that caused it, and a message with no `id` is an
event, not an answer.

**The protocol is additive-only after v1.** Types and optional fields may be added; nothing will be
removed, renamed, made required, or given a new meaning. A host written against v1 keeps working
against every later build. Ignore a `type` you do not know — that is forward compatibility, and the
embed does the same with yours.

### Two numbers, and only one of them moves

`tvx` is the **envelope** and it is `1`. It changes only for a breaking change, which the additive
promise above says will not happen; a host filters on it and posts it, and if it ever moved every
existing host would stop talking to the viewer on the same day. It has not moved for protocol 2 and
it will not move for protocol 3.

`ready.version` — the same number as `manifest.json`'s `protocol` — is the **feature level**: which
edition of the tables below this build implements. It is `2` since Tetravox 0.3.11. Read it to decide
whether a feature is there; never to decide whether to talk at all.

**Protocol 2 (Tetravox 0.3.11) added**, all of it optional and none of it on by default:

* a **points layer** in the `ViewSpec`, written inline — §5(d) and §6;
* `setPointTool`, `setPointSelection`, `setPoints` — the point tool a user drives with the mouse;
* `setPickEvents` and the `pick` event — what a click landed on, **off until you ask**;
* `getCamera` / `setCamera` and the `camera` reply.

A protocol-1 host is unaffected in both directions: it sends none of those messages, and with `pick`
off and no tool armed the embed posts it exactly the ten types protocol 1 defined. That is a test
(`packages/embed/test/e2e/embed-compat.spec.ts`), not a promise.

`protocol.schema.json` is this contract as JSON Schema, and `packages/embed/src/protocol.ts` is the
TypeScript. Both are in the tarball.

### Both sides check the sender

The embed accepts a message only when `event.source === window.parent` **and** `event.origin ===
hostOrigin`. Everything else is dropped in silence: replying would confirm to an unknown origin that
a Tetravox is listening here.

**You must do the mirror check**, and the embed cannot do it for you:

```js
window.addEventListener('message', (event) => {
  if (event.origin !== EMBED_ORIGIN) return;          // where you serve dist/ from
  if (event.source !== iframe.contentWindow) return;  // that frame, not a sibling on the same origin
  if (event.data?.tvx !== 1) return;
  handle(event.data);
});
```

Both, not either. The origin check alone passes a sibling iframe served from the same origin.

### Host → embed

| `type` | Payload | Reply |
|---|---|---|
| `hello` | — | `ready` |
| `load` | `scene: ViewSpec`, `baseUrl?: string` | `loaded` \| `error` |
| `setTheme` | `theme: 'light' \| 'dark'` | — |
| `setLayout` | `kind` — see below | — |
| `setCursor` | `world: [x, y, z]` world-RAS mm | `cursor` event |
| `setLayerVisible` | `layerId`, `visible` | `layers` event |
| `setLayerOpacity` | `layerId`, `opacity` (0..1) | `layers` event |
| `updateLayer` | `layerId`, `patch` — any subset of §4.4's layer fields | `layers` event |
| `setActiveLayer` | `layerId: string \| null` | — |
| `screenshot` | `id` **(required)**, `target?: 'view' \| 'grid'` (default `grid`), `viewId?`, `width?`, `height?` | `screenshot` |
| `serialize` | `id` **(required)** | `scene` |
| `probe` | `id` **(required)**, `world` | `probe` |
| `focus` | — | — |
| `reset` | — | `status`, `layers` |
| `setPointTool` **(2)** | `layerId: string \| null` (null disarms), `mode?: 'select' \| 'place'`, `template?` | `pointTool`, `layers` |
| `setPointSelection` **(2)** | `layerId`, `pointId: string \| null` | `pointTool` |
| `setPoints` **(2)** | `layerId`, `points: Point[]` | `layers` |
| `setPickEvents` **(2)** | `enabled: boolean` (default `false`) | — |
| `getCamera` **(2)** | `id` **(required)** | `camera` |
| `setCamera` **(2)** | `preset?`, `patch?: Partial<Camera3D>` | `camera` (with an `id`) |

`setLayout`'s `kind` is one of the seven arrangements — `'1x1'`, `'1x3'`, `'1x3-horizontal'`,
`'2x2'`, `'3d-only'`, `'1+3'`, `'3d+1'` — **or** one of four names that pick a single pane by what is
in it: `'3d'`, `'axial'`, `'coronal'`, `'sagittal'`. Anything else is answered with an `error`.

> Those four names have been in this table since protocol 1 and did not work: they are not
> `LayoutKind` values, and one of them reaching the engine left the layout with no cells and threw
> inside the render loop on the next frame — a dead viewer, with nothing said to the host. Fixed in
> 0.3.11, in both directions: the four names now mean what this table always said they meant, and an
> unknown kind is an `error` reply rather than a crash.

`focus` matters more than it looks: an iframe gets no key events until something inside it is
focused, and a host cannot focus across the boundary — the whole §7.5 keyboard map is dead without
it. `reset` closes every dataset and terminates its worker, which is the only way a dataset's wasm
heap comes back (§5 rule 1).

### Embed → host

| `type` | Payload |
|---|---|
| `ready` | `version: 2` (the **protocol**, not the envelope), `caps: { webgl2, renderer?, norm16? }` — posted **unprompted on boot**, and again for every `hello` |
| `status` | `phase: 'idle' \| 'loading' \| 'ready' \| 'error' \| 'no-webgl2'`, `message?` |
| `progress` | `datasetId`, `name`, `phase`, `done`, `total` (`0` when the phase cannot say) |
| `loaded` | `datasets: [{ id, name, kind, bytes? }]`, `layers: Layer[]` |
| `layers` | `layers: Layer[]` — whenever they change, for any reason |
| `cursor` | `world`, `mni?`, `tkr?`, `space` — throttled to 30 Hz |
| `probe` | `id`, `result: ProbeResult` |
| `screenshot` | `id`, `dataUrl: 'data:image/png;base64,…'` |
| `scene` | `id`, `spec: ViewSpec` |
| `error` | `code?`, `message` |
| `pick` **(2)** | `kind`, `world`, `viewId?`, `layerId?`, `pointId?`, `elementId?`, `label?`, `tag?`, `modifiers`, `probe` — one per left press, **only while `setPickEvents` is on** |
| `pointTool` **(2)** | `event: PointToolEvent` — only while a tool is armed |
| `camera` **(2)** | `camera: Camera3D` — a reply, never unprompted |

**Two things a host gets wrong if it does not read them.**

*Branch on `ready.caps.webgl2`.* Chromium M137 removed the automatic SwiftShader fallback (§1), so a
blocklisted driver gives `getContext('webgl2') === null` and the viewer can draw nothing at all. It
still answers `hello` and still says `status: 'no-webgl2'` — every other message is answered with an
`error` saying why. Show your own message; do not leave an empty box.

*The ids in `loaded` are not the ids you sent.* `Engine.load` re-adds every dataset, so the spec's
`DatasetId`s and `LayerId`s are gone the moment the load succeeds. The live ones in `loaded.layers`
are what every later `setLayerVisible` / `updateLayer` / `setActiveLayer` must name. That is why the
reply carries the whole layer array rather than an `ok`.

---

## 4. Datasets are URLs

`DatasetRef.path` is a URL, not a path relative to a scene file. Two spellings, both supported:

| What you send | What is fetched |
|---|---|
| `https://data.example/sub-01/T1.nii.gz` | that, unchanged |
| `/api/files/raw/mnt/000/T1.nii.gz` | resolved against `baseUrl` → `https://<baseUrl origin>/api/files/raw/mnt/000/T1.nii.gz` |
| `data/T1.nii.gz` | resolved against `baseUrl` → `<baseUrl directory>/data/T1.nii.gz` |

`baseUrl` defaults to **the embed document's own `baseURI`** — so an application serving the bundle
at `/tetravox/` and its files at `/api/files/…` on the same origin can send exactly the paths its
server publishes and send no `baseUrl` at all.

Resolving relative refs is not a convenience: the engine's loader passes through only a string with
a `scheme://` and Vite's `/@fs/`, and turns anything else into a `tetravox://file/…` request that no
browser outside Electron can serve. The embed absolutises every ref before the engine sees one.

**Sidecars are relative to the dataset, not to the page** (§4.6 — a sidecar travels with the file it
describes). `final_tissues.nii.gz` with `sidecars.lut.path = 'final_tissues_LUT.txt'` fetches the
LUT from the same directory the volume came from. Reading a sidecar is best-effort: one that is not
there is a missing table, never a failed load.

### What a host may omit

§4.6's `ViewSpec` requires nine view fields — `slices`, `view3d`, `layout`, `cursor`,
`radiological`, `background`, `lighting`, `annotations`, `transparency` — because a saved scene is a
*complete* description and merging would let a stale scene leak into a loaded one. A host writing a
scene by hand knows none of them, so **the embed fills every absent key from the engine's own empty
scene**. Nothing you do send is ever overridden.

| Field | May omit? |
|---|---|
| `datasets`, `layers` | **No.** |
| `version` | Yes — defaults to this build's `SCENE_VERSION`. |
| `activeLayerId` | Yes — `null`. |
| `DatasetRef.fingerprint` | Yes. It is computed in the worker over bytes you have never seen (§5 rule 3) and identifies a file only for a relocate dialog an embed does not have. `''` is exact. |
| `DatasetRef.absPath` | Yes — there is no filesystem. |
| the nine view fields | Yes — filled from the engine's empty scene. |
| every layer field except `id`, `datasetId`, `kind` | Yes — filled from the engine's per-dataset default. |

Two defaults worth knowing, because they are the ones a host would otherwise have to compute from
bytes it cannot see:

* **A scalar volume with no `scale`** is windowed to its own **2nd–98th percentile**, which is what
  you want and is not min..max (`m2m_ernie/T1.nii.gz` has a physical max of exactly 65535 against a
  brain in the low hundreds).
* **A mesh layer with a `field` and no `scale`** is windowed from **that field's own stats**, the
  same re-seeding the desktop property editor does when a user picks a field. Without it the engine's
  placeholder `0..1` would render a `TI_max` field living in `0.002..0.13` as one flat colour.

---

## 5. Four scenes, verbatim

Absolute URLs throughout, and only the keys a host has to send.

### (a) T1 in grey, a heat-colormap field, and a hidden label volume with its LUT

```json
{
  "version": 2,
  "datasets": [
    { "id": "d1", "kind": "volume", "name": "T1.nii.gz",
      "path": "https://data.example/sub-ernie/m2m_ernie/T1.nii.gz" },
    { "id": "d2", "kind": "volume", "name": "TI_max.nii.gz",
      "path": "https://data.example/sub-ernie/Simulations/Thalamus/TI/niftis/grey_Thalamus_TI_subject_TI_max.nii.gz" },
    { "id": "d3", "kind": "volume", "name": "final_tissues.nii.gz",
      "path": "https://data.example/sub-ernie/m2m_ernie/final_tissues.nii.gz",
      "sidecars": { "lut": { "path": "final_tissues_LUT.txt" } } }
  ],
  "layers": [
    { "id": "l1", "datasetId": "d1", "kind": "volume", "name": "T1",
      "visible": true, "colormap": "gray" },
    { "id": "l2", "datasetId": "d2", "kind": "volume", "name": "TI_max",
      "visible": true, "opacity": 0.8, "colormap": "hot",
      "threshold": { "lo": 0.05, "hi": null, "symmetric": false, "mode": "hide", "softEdge": 0 } },
    { "id": "l3", "datasetId": "d3", "kind": "volume", "name": "tissues",
      "visible": false, "labelMode": "fill" }
  ],
  "activeLayerId": "l2"
}
```

No `scale` on either scalar layer: both get the 2nd–98th percentile window. The label volume needs
no `colormap` — it is recognised from its own data and drawn through the LUT sidecar. `threshold.hi`
is `null` because JSON has no infinity, and `null` is read back as the `+Infinity` it stands for.

### (b) T1 and a `.msh` coloured by element field `TI_max`, clipped on the cursor, contoured in 2D

```json
{
  "version": 2,
  "datasets": [
    { "id": "d1", "kind": "volume", "name": "T1.nii.gz",
      "path": "https://data.example/sub-ernie/m2m_ernie/T1.nii.gz" },
    { "id": "d2", "kind": "mesh", "name": "grey_Thalamus_TI.msh",
      "path": "https://data.example/sub-ernie/Simulations/Thalamus/TI/mesh/grey_Thalamus_TI.msh" }
  ],
  "layers": [
    { "id": "l1", "datasetId": "d1", "kind": "volume", "name": "T1",
      "visible": true, "colormap": "gray" },
    { "id": "l2", "datasetId": "d2", "kind": "mesh", "name": "TI_max",
      "visible": true,
      "colorMode": "field",
      "colormap": "jet",
      "field": { "source": "elm", "name": "TI_max", "component": "mag" },
      "contoursIn2D": true,
      "contourWidthPx": 1.5,
      "clip": {
        "planes": [
          { "plane": { "normal": [1, 0, 0], "offset": 0 },
            "enabled": true, "followCursor": true }
        ],
        "caps": true,
        "capColorMode": "inherit"
      } }
  ],
  "activeLayerId": "l2"
}
```

`followCursor: true` makes the plane track the crosshair — its `offset` is rewritten on every
`setCursor` and on every click in a pane. `caps: true` fills the cut with exact cap geometry rather
than showing a hollow shell. `component` is `"mag"` for a scalar field and `"mag"` or a 0-based index
for a vector one.

### (c) A GIfTI surface with a scalar

```json
{
  "version": 2,
  "datasets": [
    { "id": "d1", "kind": "mesh", "name": "lh.pial.gii",
      "path": "https://data.example/sub-ernie/m2m_ernie/surfaces/lh.pial.gii" }
  ],
  "layers": [
    { "id": "l1", "datasetId": "d1", "kind": "mesh", "name": "lh.pial",
      "visible": true,
      "colorMode": "field",
      "colormap": "viridis",
      "field": { "source": "node", "name": "<the scalar's name in the file>", "component": "mag" },
      "contoursIn2D": true }
  ],
  "activeLayerId": "l1"
}
```

`source: "node"` — a surface scalar is per-vertex, where a `.msh` simulation field is usually per
element (`"elm"`). A GIfTI with no data array carries no field: drop the `field` key and use
`"colorMode": "solid"` with a `solidColor`. A surface is triangles only, so it renders as an outline
in the slice panes and a shell in 3D; `contoursIn2D` is what puts the outline there.

### (d) A T1 and an electrode net — a points layer, written inline

```json
{
  "version": 2,
  "datasets": [
    { "id": "d1", "kind": "volume", "name": "T1.nii.gz",
      "path": "https://data.example/sub-ernie/m2m_ernie/T1.nii.gz" }
  ],
  "layers": [
    { "id": "l1", "datasetId": "d1", "kind": "volume", "name": "T1",
      "visible": true, "colormap": "gray" },
    { "id": "l2", "datasetId": "d1", "kind": "points", "name": "EEG net",
      "points": [
        { "id": "E1", "name": "Fp1", "position": [-25, 78, 15] },
        { "id": "E2", "name": "Fp2", "position": [25, 78, 15], "state": "selected" },
        { "id": "E3", "name": "Cz",  "position": [0, 6, 100] },
        { "id": "E4", "name": "T7",  "position": [-73, 6, 30], "state": "disabled" }
      ],
      "color": [0.2, 0.6, 1, 1],
      "radiusMm": 5,
      "labelMode": "names",
      "offPlaneOpacity": 0.5 }
  ],
  "activeLayerId": "l2"
}
```

`datasetId` names the **volume the points sit over**: §4.4 hangs every layer off a carrier dataset,
and there is no points file for an embed to fetch — the coordinates arrived with the layer. It is the
same arrangement the desktop sEEG contact editor uses, where the contacts hang off the CT they were
localised on.

`offPlaneOpacity` is what makes a net usable in the slice panes. A scalp net is a sphere of
electrodes and no axial slice holds two of them, so without it the panes show one electrode at a
time; above 0 the off-slice ones are drawn as ghosts at their full radius. Leave it out for a layer
whose points really do lie in a plane.

`viewspec.schema.json` in the tarball validates this subset — the points layer included, since
0.3.11. Fields it does not list are still accepted and passed through; §4.4 is the complete layer
model.

---

## 6. Points, picking and the camera (protocol 2)

Everything in this section is optional. A host that sends none of it gets the viewer protocol 1
described, byte for byte.

### 6.1 A point

| Field | Meaning |
|---|---|
| `position` | **Required.** World-RAS millimetres (§3). |
| `id` | The point's identity — what a `pick` names it by and what `setPointSelection` selects. Optional, and you want it: the engine mints `p<index>` for a point with none, and an index moves the moment a point is deleted. |
| `name` | The point's own text: what `labelMode: 'names'` draws, and what the probe row calls it. |
| `state` | `'idle'` \| `'selected'` \| `'disabled'` — **resolved to a colour before the engine sees the layer**. |
| `color`, `radiusMm` | This point's own, overriding the layer's — and `color` overrides whatever `state` would have painted. |
| `group`, `ordinal` | Which set the point belongs to (an electrode, a montage pair, a parcel) and its 1-based place in it. Uninterpreted by the engine; they exist so one layer can hold twelve shafts instead of twelve layers. |

`state` is the one field §4.4 has no word for, and it is there so a host says *what an electrode is*
rather than restating what selected looks like at four call sites. The defaults are byte-exact:

| `state` | Colour | Wire |
|---|---|---|
| `idle` (or absent) | the layer's own `color` | — |
| `selected` | `[1, 0.8, 0.2, 1]` | `rgb(255, 204, 51)` |
| `disabled` | `[0.6, 0.6, 0.6, 1]` | `rgb(153, 153, 153)` |

Override them per layer with `stateColors: { idle?, selected?, disabled? }`. The layer keeps that
map, so a later `setPoints` paints the same palette the `load` did.

**`state` is not the selection.** Any number of points may be `'selected'`; exactly one point per
layer can be *the* selection, which is what draws §7.2's ring and what the point tool is holding.

### 6.2 The layer

`shape` (`'sphere'` — `radiusMm` in world millimetres — or `'dot'`, a constant screen size),
`radiusMm`, `color`, `opacity`, `visible`, `offPlaneOpacity`, `dotRadiusPx` are §4.4's, unchanged.
`labelMode` is this protocol's one addition:

| `labelMode` | Draws |
|---|---|
| `'none'` (default) | nothing |
| `'names'` | each point's own `name`, at its own position |
| `'labels'` | the layer's free-standing `labels[]` anchors — which only a parsed Gmsh view has, so an inline layer draws nothing |

There is no `'hover'`: the engine draws no hover text, and a mode that silently did nothing would be
worse than its absence. Draw your own tooltip from the `pick` event.

### 6.3 The point tool

```js
send({ type: 'setPointTool', layerId, mode: 'select' });   // or 'place'
send({ type: 'setPointTool', layerId: null });             // disarm
```

`'select'` — a click grabs the point under it and drags it; a click on nothing does nothing.
`'place'` — **every** click appends a point, with no hit test first, because the click that matters
most is the one filling the gap *between* two points that are already there.

Three things follow from the engine and will surprise a host that has not read them:

* **Arming materialises ids.** A layer whose points carry none gets `p<index>` on all of them, and a
  `layers` event fires. Send your own ids.
* **A plain click emits a zero-length `dragEnd`.** A `select` click *grabs*, and a grab is a drag
  that ended without moving, so clicking down a list gives `selected`, `dragEnd`, `selected`,
  `dragEnd`, … Compare positions against the snapshot you took at `selected` before recording an
  edit. (The exception: a click on a point drawn *off* its slice selects it and starts no gesture, so
  it emits `selected` alone.)
* **`cleared` says why**, in `reason`: `'esc'`, `'measure'` (the user chose measure mode — do not
  re-arm), `'load'`, `'layer'`, `'host'`, and `'selection'` — which means only the selection went and
  the tool is still armed.

`setPointSelection { layerId, pointId }` selects by id and `pointId: null` clears it. An id that is
not in the live `points[]` clears rather than pointing at the neighbour.

`setPoints { layerId, points }` replaces the array — which is also how a point is deleted. Use it
rather than `updateLayer` with a `points` patch: `setPoints` is what runs the `state` → colour
resolution, and the patch route would leave a `state` unpainted.

### 6.4 `pick`

```js
send({ type: 'setPickEvents', enabled: true });
```

Off by default, and deliberately: a `pick` carries a whole `ProbeResult` and fires on every left
press, and a host that never asked for one must not pay for it.

One message per press, whatever it resolved to. `kind` is the field to branch on:

| `kind` | What it was | Carries |
|---|---|---|
| `'point'` | a point of a points layer, hit or placed | `layerId`, `pointId` |
| `'tri'` / `'tet'` / `'slice'` | §7.2.3's id pass answered | `layerId`, `elementId` (the Gmsh element number, or the plane index) |
| `'cursor'` | the click moved the crosshair and nothing owned the pixel | `world` |

Every one carries `world`, `modifiers: { shift, ctrl, alt, meta }` and `probe` — `ProbeResult` at
that point, so the region under a click arrives *with* the click. `label` (`{ id, name?, layerId }`)
and `tag` are the two rows lifted out of it: a label volume's value, which is what "click a region"
means, and a mesh's tissue tag.

**The mesh rows of `probe` are at most one round trip stale.** That is §4.7's standing rule and not a
property of this message — `probe` is synchronous while the point-in-tetrahedron search is a worker
call. The volume rows, `label` among them, are exact. If you need the settled mesh answer, send a
`probe` with the `world` the event carried.

### 6.5 The camera

```js
const { camera } = await send({ type: 'getCamera' }, true);
// …later
send({ type: 'setCamera', patch: { target: camera.target, distance: camera.distance,
                                   rotation: camera.rotation } });
send({ type: 'setCamera', preset: 'L' });     // 'A' 'P' 'L' 'R' 'S' 'I', or 1..6
```

A **patch**, not a whole `Camera3D`: `near` and `far` are derived from the fit radius (§7.2), so
restoring a saved pose by writing all seven fields carries a stale clip range back with it and can
clip the head away. Write `target`, `distance` and `rotation`; leave the rest to the engine. A
`setCamera` carrying both applies the preset first and then the patch, which is how "left, but pulled
back" is said.

The `camera` message is only ever a reply. Nothing announces a camera change: an orbit is a change
per frame, and a message per frame is a storm.

---

## 7. A minimal host

```html
<iframe id="v"></iframe>
<script type="module">
  const iframe = document.getElementById('v');
  const url = new URL('/tetravox/index.html', location.href);
  url.searchParams.set('embed', '1');
  url.searchParams.set('hostOrigin', location.origin);
  iframe.src = url.href;
  const EMBED_ORIGIN = new URL(iframe.src, location.href).origin;

  let n = 0;
  const pending = new Map();
  const send = (m, wantsReply = false) => {
    const id = wantsReply ? `h${n++}` : undefined;
    iframe.contentWindow.postMessage({ tvx: 1, ...m, ...(id ? { id } : {}) }, EMBED_ORIGIN);
    return wantsReply ? new Promise((r) => pending.set(id, r)) : Promise.resolve();
  };

  window.addEventListener('message', (event) => {
    if (event.origin !== EMBED_ORIGIN || event.source !== iframe.contentWindow) return;
    const m = event.data;
    if (m?.tvx !== 1) return;
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }

    if (m.type === 'ready' && !m.caps.webgl2) showYourOwnError();
    if (m.type === 'ready') send({ type: 'load', scene: SCENE }, true).then(console.log);
    if (m.type === 'cursor') readout.textContent = m.world.map((v) => v.toFixed(1)).join(' ');
  });
</script>
```

`packages/embed/example/host.html` in the repository is the fuller version — a layer list, a probe
readout, a screenshot button, and §6's tool/pick/camera controls — and it is what the E2E suite
drives, so it cannot rot.

---

## 8. What an embed does not have

No file dialogs, no drag-and-drop from the desktop, no `tetravox://`, no menus, no auto-update, no
extensions catalogue, no sample-data downloader, and no settings that survive a reload. All of them
are Electron main-process features reached over the preload bridge (§5), and a browser page has no
bridge — the calls answer "no preload bridge" and the chrome that would make them is hidden. A scene
arrives over `load`, and only over `load`.

The Settings gear stays, with Appearance and Capture: both are about the picture and both work.
