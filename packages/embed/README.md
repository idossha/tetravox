# `@tetravox/embed`

The Tetravox renderer, built as a plain browser bundle a host application mounts in an `<iframe>`
and drives over `postMessage`.

**`docs/EMBED.md` is the contract** — the URL, the protocol, the headers a host must send, and three
complete `ViewSpec` examples. This file is about how the package is built and why it is shaped the
way it is.

```sh
pnpm run wasm                              # always first: the bundle carries tvx_wasm_bg.wasm
pnpm --filter @tetravox/embed build        # → dist/
pnpm --filter @tetravox/embed pack:embed   # → dist-pkg/tetravox-embed-<version>.tgz
pnpm --filter @tetravox/embed e2e          # headless Chromium against example/host.html
pnpm exec vitest run --project embed       # the protocol guards and the normaliser
```

## What this package is

Almost nothing: a Vite config, an `index.html`, an entry, and the host protocol. The viewer itself is
`packages/app/src/renderer`, imported by relative path — the same way `packages/engine`'s §11 test
pages import engine source. There is no second UI here.

```
index.html            the embed document
src/main.tsx          the entry: register the channel, then render <App/>
src/protocol.ts       host protocol v3 — types, unions, and the trust boundary
src/normalize.ts      a host's partial ViewSpec → the complete one Engine.load needs
src/points.ts         protocol 2's points vocabulary, spent before the engine sees a layer
src/host.ts           the channel: every message → one ShellController call
example/host.html     a working host page, and what the E2E drives
protocol.schema.json  the protocol as JSON Schema
viewspec.schema.json  the host-facing subset of ViewSpec v2
```

## The three things a host can open

`docs/EMBED.md` §4.0 is the contract; this is the one-paragraph version, because it is the
distinction the package exists to make and the one a host gets wrong.

A **volume** is a NIfTI or MGZ. A **mesh** is a *tetrahedral* FEM volume — a SimNIBS `.msh`, with an
interior, tissue tags, per-element fields and a clip plane that can be capped. A **surface** is a
*triangular* sheet — FreeSurfer `lh.pial` / `rh.white` / `lh.central`, GIfTI, STL/PLY/OBJ — with none
of that, and one colour source at a time: solid, a per-vertex `overlay`, or an `annotation`.

Surfaces are `kind: "surface"` and arrived with **protocol 3** (Tetravox 0.4.0). Nothing here
implements them: `SurfaceLayer` is `packages/engine`'s, added by PR #37, and the `.annot` / morph /
data-GIfTI attachment is PR #36's `Engine.attachSurfaceData` reached through §4.6's third sidecar
role, `sidecars.fields`. This package's whole contribution is the schema, the types, the URL
resolution for that sidecar role, and one guard — `normalize.ts` refuses a layer `kind` it does not
know, because `Engine.load` would otherwise drop the layer and still answer `loaded`.

That guard is why protocol 3 is a number and not another optional field. Everything protocol 2 added
was declinable; a layer *kind* is not, because an older build cannot half-understand one. A
protocol-2 host is unaffected in both directions — see `test/e2e/embed-compat.spec.ts`.

## Why the app renderer, and not a small UI on the engine

The obvious alternative was a purpose-built chrome on `@tetravox/engine` directly — a layer list, a
coordinate bar, a layout switcher. It was rejected after measuring, not on principle.

The app renderer looked like it would be hard to lift out of Electron and was not. The preload bridge
is reached from eight files, every one of them through `bridge()`, and `bridge()` has **always**
fallen through to `ABSENT` — a null object the app ships for, in its own words, "vitest, or a plain
browser tab". Pointing Vite at `packages/app/src/renderer` with a browser target produced, first
try, a bundle that boots headless, reports its GL renderer, and draws: no console error, and no
change to `packages/app` at all.

Against that, a second UI would have cost a second layer panel, a second set of property editors and
a second coordinate readout — the three places where two implementations drift in ways a user notices
and a test does not. The embed would have been a worse viewer *and* more code.

So the shape is: the app renderer, plus four seams, each of which reproduces the previous behaviour
exactly when `?embed=1` is absent.

| Seam | What it does |
|---|---|
| `app/…/embed/mode.ts` | `embedMode()`, and the single-slot `onShellReady` carrying the `{ controller, engine, store }` triple `Shell` already hands `maybeRunJob` |
| `app/…/toolbar/Toolbar.tsx` | hides the `Tetravox` menu — all six items end in a bridge call |
| `app/…/dialogs/SettingsDialog.tsx` | hides the Paths and Startup tabs, for the same reason |
| `app/…/store/controller.ts` | `loadSpecFromUrls` — `applyScene` with `scenePath: null` |

## Build notes

* **`base: './'` is mandatory.** A host serves `dist/` from a route this build cannot know. Every
  emitted URL — chunks, CSS, the two module workers, `tvx_wasm_bg-*.wasm` — is relative to
  `index.html`.
* **`assetsInlineLimit: 0`.** An inlined wasm or worker leaves Vite's asset graph and stops being a
  file a host can serve with a content type.
* **`src/index.css` exists only for one line.** Tailwind 4 discovers what to scan from the
  stylesheet's own directory, and every class this bundle needs is written in `packages/app`. Without
  the `@source` there the build emits the theme variables and none of the utilities that read them —
  an 8 kB stylesheet instead of 29 kB, silently, and a viewer whose chrome renders as unstyled text.
* **The Sample Data thumbnails are stubbed out at build time.** 1.5 MB of JPEG reached through
  `import.meta.glob`, behind a dialog whose catalogue comes from the preload bridge an embed does not
  have. Not tree-shakeable, because the module is reachable whether or not its branch can be taken.

## Tests

`src/*.test.ts` is the half that must be provable without a browser — above all `acceptMessage`, the
origin/source check. A security boundary exercised only by an end-to-end test that serves both pages
from one origin is a boundary whose failure modes are never exercised.

`test/e2e/embed.spec.ts` drives `example/host.html` itself, so the documented example cannot rot. It
needs `TETRAVOX_TESTDATA` for the scenes and skips them without it; the protocol half always runs.
Headless only — there is no headed project here and none may be added (AGENTS.md rule 8).

`test/e2e/embed-surface.spec.ts` is the exception that needs **no** `TETRAVOX_TESTDATA`: it runs
against the committed synthetic fixtures in `testdata/` — `lh.fixture.surf`, `lh.fixture.annot`,
`surf_ascii.surf.gii`, `mesh_tetonly.msh` — over Vite's `/@fs/` mount. The kind a file opens as is a
property of its bytes, so a four-vertex patch proves it exactly as a hemisphere would, and the part
of the contract a host is most likely to get wrong is not the part that skips on a machine with no
reference subject.
