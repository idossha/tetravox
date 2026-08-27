# Testing Tetravox

The contract is `docs/ARCHITECTURE.md` §11 (rendering verification) and §12 (CI). This file is the
operator's manual for both: how to run everything locally, what the golden policy actually is, and how to
add a test that asserts a rendered pixel.

Rule 0, from §11: **an agent cannot judge a PNG; it can judge a number.** Every rendering feature ships an
*analytic* pixel assertion — expected RGBA computed from first principles on a synthetic fixture — **plus**
a golden PNG for regression. Never "verify" a rendering change by looking at a picture and declaring it
fine.

---

## 1. Running it

| Command | What it does |
|---|---|
| `pnpm install` | workspace install. The lockfile is frozen after Phase 0 (§12.3) |
| `pnpm wasm` | builds `crates/tvx-wasm` → `packages/wasm/pkg`. **Prerequisite of build / test / typecheck** |
| `cargo test --workspace` | Rust unit + real-data tests |
| `cargo clippy --workspace --all-targets -- -D warnings` · `cargo fmt --all --check` | Rust lint |
| `pnpm test` | `cargo test --workspace` + `pnpm wasm` + `vitest run` |
| `pnpm exec vitest run` | the vitest half alone (three projects: `protocol`, `wasm`, `engine`) |
| `pnpm exec vitest run --project engine` | one project |
| `pnpm typecheck` | `pnpm wasm`, then `tsc --noEmit` per package |
| `pnpm lint` | `eslint .` + `prettier --check .` |
| `pnpm e2e` | every package's `e2e` script — today the engine's Playwright suite |
| `pnpm --filter @tetravox/engine run e2e` | the engine suite alone — **two projects**: `chromium-swiftshader` (everything) and `chromium-angle` (`@angle` only, on the real GPU) |
| `pnpm --filter @tetravox/engine exec playwright test --project=chromium-angle` | just the ANGLE leg — where the R16 branch of the §6.1 ladder executes |
| `pnpm --filter @tetravox/app run e2e` | the Playwright-Electron suite — **two projects**: `dev` and `packaged` |
| `TETRAVOX_E2E_HEADED=1 pnpm e2e` | the same runs with **visible windows**, for debugging (§2.1) |
| `scripts/e2e-quiet-check.sh` | runs `pnpm e2e` and proves it took neither the screen nor the focus (§2.2) |

Before the first `pnpm e2e` on a cold machine:

```sh
pnpm exec electron --version            # electron ≥ 42 downloads its ~100 MB binary on first LAUNCH (§12.2)
pnpm exec playwright install chromium   # the version-pinned Chromium
```

Real-data tests are gated on `TETRAVOX_TESTDATA` and **skip, never fail, when it is unset**. CI leaves it
unset on purpose and asserts so. Locally:

```sh
export TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie
```

### Where each kind of test lives

```
crates/*/src/**                       #[test] — synthetic + TETRAVOX_TESTDATA-gated real data
packages/*/src/**/*.test.ts           vitest, unit
packages/engine/test/unit/*.test.ts   vitest, unit (engine logic with no GL)
packages/engine/test/e2e/*.spec.ts    Playwright — analytic pixels and goldens
packages/engine/test/pages/*          the pages those specs drive (HTML + a small TS bundle each)
packages/engine/test/helpers/*        expectPixel / expectGolden
packages/engine/test/golden/<class>/  the goldens, one directory per renderer class
```

`*.test.ts` is vitest; `*.spec.ts` is Playwright. Nothing collects both.

### The test page server

`packages/engine/playwright.config.ts` starts Vite over `packages/engine` as the root, so a page can
import engine source with a plain relative path and get TypeScript transpiled on the way to the browser.
Pages are at `http://127.0.0.1:5199/test/pages/<name>.html` (`TETRAVOX_TEST_PORT` overrides the port).

To poke at a page by hand:

```sh
pnpm --filter @tetravox/app exec vite --config "$PWD/packages/engine/test/vite.config.ts"
open http://127.0.0.1:5199/test/pages/triangle.html
```

That `--filter @tetravox/app` is not a typo: `vite` is a devDependency of `packages/app` only, and the
Phase-0 lockfile is frozen, so the engine harness borrows that binary rather than adding an importer edge
(recorded in `docs/DECISIONS.md`). When `packages/engine` gains its own `vite` devDependency, this becomes
plain `pnpm --filter @tetravox/engine exec vite`.

---

## 2. Headless Chromium and SwiftShader

§11 requires goldens to be captured under headless Chromium/SwiftShader with `@playwright/test` pinned to
an **exact** version, because that version pins the Chromium build and therefore the SwiftShader build.
It is `1.62.1`; do not widen it to a range.

**Which launch flag actually matters.** Chromium M137 removed the *automatic* SwiftShader WebGL fallback
(§1), so on a GPU-less runner `getContext('webgl2')` can return `null`. Measured 2026-08-27 with
Playwright 1.62.1 / Chromium 151 on macOS 15.7 arm64, using `--disable-gpu` on the full Chromium build to
simulate a runner with no usable GPU:

| Launch | `getContext('webgl2')` |
|---|---|
| `--disable-gpu`, neither flag | **`null`** — this is the §1 claim, reproduced |
| `--disable-gpu --enable-unsafe-swiftshader` | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)` |
| `--use-gl=angle --use-angle=swiftshader` (with or without the unsafe flag) | SwiftShader |
| no flags, GPU available | `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)` |

Both flags produce SwiftShader, and they are not interchangeable:

* **`--enable-unsafe-swiftshader` *permits the fallback*.** It does not choose a renderer, so a machine
  with a working GPU still gets ANGLE/Metal and still produces `angle-metal` pixels. This is what §11
  mandates and what `playwright.config.ts` passes.
* `--use-gl=angle --use-angle=swiftshader` *selects* the backend — explicitly choosing it is its own
  consent, so it works even with the unsafe flag suppressed. But it forces software **everywhere**, which
  would erase the ANGLE/Metal half of §11's two-renderer-class strategy. Rejected for that reason, not
  because it fails.

Note that Playwright 1.62 already appends `--enable-unsafe-swiftshader` on its own launch path, and its
default `chromium` is the *headless shell*, which has no GPU access at all — so a bare `chromium.launch()`
gives SwiftShader today regardless. Passing the flag explicitly is a harmless duplicate that keeps the
requirement visible and survives a Playwright default changing under us.

The remaining args are §11 verbatim and exist to make the image a function of the scene only:
`--force-device-scale-factor=1`, `--disable-lcd-text`, `--font-render-hinting=none`, `--hide-scrollbars`.

### 2.1 Windowless by default on macOS

**A test run must not hijack the monitor.** `pnpm e2e` launches a browser or an Electron app about
twenty times; each launch used to raise a window, take the keyboard focus off whatever the developer
was doing, and — under a tiling window manager — re-tile the whole workspace. Both suites are now
windowless by default on macOS, and neither gave up a single GPU capability to get there.

| Leg | Was | Is | How |
|---|---|---|---|
| engine `chromium-swiftshader` | headless | headless | unchanged — the golden authority was never visible |
| engine `chromium-angle` | **headed**, `channel: 'chromium'` | **headless**, `channel: 'chromium'` | `headless: !HEADED` in `playwright.config.ts` |
| app `dev` / `packaged` | a shown `BrowserWindow` | a `BrowserWindow` that is **never shown**, no dock icon | `TETRAVOX_E2E_OFFSCREEN=1`, set by `e2e/fixtures.ts` on darwin, read by `src/main/window.ts` |

`TETRAVOX_E2E_HEADED=1` turns every window back on — one variable for both suites, and in the app it
outranks `TETRAVOX_E2E_OFFSCREEN`. A **user** launch sets neither and is completely unaffected: the
only line the app runs differently is the one that would have called `win.show()`.

Linux keeps the visible path: CI runs under Xvfb, where there is no monitor to hijack, and the
shown-window branch is then the one under test. `fixtures.ts` defaults the variable on `darwin` only.

**Headless Chromium still reaches ANGLE/Metal — measured, not assumed.** This is the claim the
`chromium-angle` project stands on, so here is the whole probe (Playwright 1.62.1 / Chromium
151.0.7922.34, M2 Max, macOS 15.7, 2026-08-27; the launch differs from the table in §2 only in
`headless`):

| Launch | `UNMASKED_RENDERER_WEBGL` | `norm16` | timer query | max tex | max draw bufs | exts |
|---|---|---|---|---|---|---|
| bundled chromium, `headless: true` (the golden authority) | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))` | **false** | false | 8192 | 6 | 29 |
| `channel: 'chromium'`, `headless: false` (what the leg used to do) | `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)` | **true** | true | 16384 | 8 | 36 |
| `channel: 'chromium'`, `headless: true` (**what it does now**) | `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)` | **true** | true | 16384 | 8 | 36 |
| …plus `--use-angle=metal --enable-gpu --ignore-gpu-blocklist` | identical to the row above | true | true | 16384 | 8 | 36 |
| …plus an explicit `--headless=new` | identical to the row above | true | true | 16384 | 8 | 36 |

The last two rows are why **no GPU switch is passed**: the flags one would reach for change nothing.
What matters is `channel: 'chromium'` — the *full* browser rather than Playwright's headless shell —
and headless mode does not cost it the GPU. The R16 branch of the §6.1 ladder runs and passes on this
leg (`@angle gate 6`, 0.6 s), which is the assertion that would fail first if `norm16` had gone away.

`--window-position=-10000,-10000` was measured as an alternative and **rejected**: the window still
appeared on screen (`CGWindowListCopyWindowInfo` listed `Google Chrome for Testing` at
`2057,35,525x1874` — the developer's tiling WM re-tiled it into view).

**The Electron app: a window that is never shown.** Three candidates were built and measured; all
three keep `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)`, `EXT_texture_norm16`,
`EXT_disjoint_timer_query_webgl2`, `MAX_TEXTURE_SIZE 16384` and 36 extensions.

| Candidate | Window on screen? | App E2E | Orbit `gpuMs` median @1x / @2x | Verdict |
|---|---|---|---|---|
| `show: false`, never shown, `app.dock.hide()` | **no** | 29/29 | **2.02 / 3.32 ms** | **shipped** |
| `webPreferences.offscreen` (Electron OSR) | no | 29/29 | 3.52 / 4.07 ms | rejected — see below |
| shown, `setBounds({ x: -10000 })` | **yes** — clamped to `x: -1240`, listed at `761,48,741x864` | — | — | rejected: macOS clamps it |

Electron's OSR is not wrong — it passes everything — but it replaces the compositor with a CPU-side
`paint` event and the §12.1 benchmark test measured the cost: `gpuMs` median 3.52 ms @1x against
2.02 for a never-shown window, `cpuMs` median doubling from 0.10 to 0.20 ms. The benchmark exists to
record what the shipping renderer costs, so the mode that runs it must not be the mode that inflates
it. OSR also pins the frame loop to `setFrameRate` (61 Hz measured, against 122 Hz for a never-shown
window on a 120 Hz display) and routes `Page.captureScreenshot` down a path that disagreed with
`capturePage()` on the same frame (5,188 B vs 17,065 B). Never shown is less machinery for the same
outcome, so that is what ships; `packages/app/src/main/window.ts` carries the same reasoning next to
the code.

Nothing in the app suite had to be adapted. `page.screenshot()` still returns the real frame (the
analytic `phase0` screenshot assertion passes unchanged), in-page `gl.readPixels` is unaffected,
`app.evaluate` + `setContentSize` still resize the window, `rAF` is not throttled, and the two
timing-sensitive gate assertions are nowhere near their budgets: first progress **12.8 ms** (< 200 ms)
and cancel **4.9 ms** (< 500 ms) on the 492 MB `ernie_seeg.msh`, dev and packaged alike.

### 2.2 Proving it: `scripts/e2e-quiet-check.sh`

```sh
scripts/e2e-quiet-check.sh                                  # runs `pnpm e2e`
scripts/e2e-quiet-check.sh pnpm --filter @tetravox/app run e2e
```

It samples two things every 0.5 s while the command runs: the frontmost application (`osascript` →
`System Events`) and the on-screen window list (`CGWindowListCopyWindowInfo`, via ~30 lines of
CoreGraphics it compiles with `clang` into a temp dir). It fails if the frontmost app is different at
the end than at the start, if a test binary was ever frontmost, or if any window owned by
Electron / Tetravox / Chromium appeared at layer 0.

The window list, not `win.getBounds()`, is what makes it a proof: `getBounds()` reports what Electron
*asked* for, and macOS clamps it — the rejected off-screen candidate above asked for `x: -10000`, got
`x: -1240` back, and was on screen the whole time.

Measured on `main`'s successor with this change, 2026-08-27:

```
e2e-quiet-check: frontmost before = ghostty
e2e-quiet-check: running pnpm e2e
packages/wasm   e2e: 51 passed,  1 skipped (15.0s)
packages/engine e2e: 27 passed,  1 skipped (22.9s)
packages/app    e2e: 58 passed             (18.3s)   # TETRAVOX_REQUIRE_PACKAGED=1: dev 29 + packaged 29
e2e-quiet-check: frontmost after  = ghostty   (88 samples)
e2e-quiet-check: no Electron/Chromium window reached the screen.
e2e-quiet-check: PASS
```

A *note* line (not a failure) reports any sample where some **other** app held the focus — a chat
client stealing it mid-run is not this repo's doing, and the script says so rather than blaming the
suite.

### Capabilities under SwiftShader

`test/e2e/caps.spec.ts` logs the full `Capabilities` on every run and attaches it as
`capabilities.json`, so each CI run records which renderer produced its goldens (§11). Measured on
Playwright 1.62.1's Chromium, macOS arm64, 2026-08-27:

```
renderer  ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)
vendor    Google Inc. (Google)
isSoftware true   floatLinear true   norm16 FALSE   clipDistance true (maxClipDistances 8)
colorBufferFloat true   colorBufferHalfFloat true   floatBlend true   drawBuffersIndexed true
timerQuery FALSE (no EXT_disjoint_timer_query_webgl2 ⇒ wall-clock frame time only, §7.1)
max3d 2048   maxSamples 4   maxDrawBuffers 6   maxTextureImageUnits 32   maxVaryingVectors 31
maxTextureSize 8192   maxArrayTextureLayers 2048   maxRenderbufferSize 8192
```

`norm16: false` is the consequential row and the reason §11 exists in the shape it does: **the golden
authority cannot take the R16 branch of the §6.1 payload ladder.** `T1.nii.gz` is R32F in every golden and
R16 in the shipping renderer. Goldens therefore cannot cover the primary format path; that coverage comes
from analytic `expectPixel` tests run twice on the macOS/ANGLE leg — once with `forceCaps` unset (R16) and
once with `forceCaps: { norm16: false }` (R32F) — asserting the same physical value within each format's
own tolerance. Same pattern as `forceDiscardClip`.

**That second leg is a Playwright project, `chromium-angle`**, and it is what makes the sentence above
true rather than aspirational. It runs the **full** Chromium (`channel: 'chromium'`, as opposed to
Playwright's headless *shell*) with `--enable-unsafe-swiftshader` deliberately *absent*, so it reaches
the platform GPU, and it is filtered to `grep: /@angle/` — the analytic tests. It runs **headless**;
§2.1 has the measurement showing that costs it nothing. No golden is captured on it:
§11 stores goldens per renderer class, `test/golden/angle-metal/` does not exist, and a golden test
running there would demand a capture rather than a comparison.

| Project | Renderer here `[M2Max]` | Runs | `caps.norm16` |
|---|---|---|---|
| `chromium-swiftshader` | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))` | everything, goldens included | false ⇒ the R16 test **skips with its reason** |
| `chromium-angle` | `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)` | `@angle` only | true ⇒ the R16 test **runs** (0.6 s) |

On a runner with no GPU the `chromium-angle` project falls back to software, `caps.norm16` is false and
the R16 test skips there too — the leg is then honestly empty rather than silently missing. Phase 1
shipped the test without the project, so the R16 branch executed in **no** environment at all while the
gate table recorded it as covered; that is the hole this project closes.

---

## 3. The golden policy

Verbatim from §11, and enforced by `playwright.config.ts` + `test/helpers/pixels.ts`:

* **Captured only** under headless Chromium/SwiftShader, fixed canvas size, `deviceScaleFactor: 1`,
  `EngineOptions.aa = 'off'`, `deterministic: true`, with the launch args above.
* **Stored per renderer class** at `packages/engine/test/golden/<swiftshader|angle-metal>/<name>.png`.
  The class comes from the live context (`isSoftware` ⇒ `swiftshader`), never from `process.platform`
  and never from `headless`: the same machine, headless throughout, produces SwiftShader pixels on the
  bundled Chromium and ANGLE pixels on `channel: 'chromium'` (§2.1).
* **Compared** at `maxDiffPixelRatio: 0.002`, `threshold: 0.15` — never byte equality. SwiftShader's LLVM
  JIT is not bit-identical across arm64 macOS and x86_64 Linux.
* **`ubuntu-24.04` is the golden authority.** The macOS job runs the same tests at a looser ratio (0.01),
  applied automatically by `goldenMaxDiffPixelRatio()`. A golden that passes on macOS and fails on ubuntu
  is a golden that must be **regenerated on ubuntu** — the authority wins.
* From Phase 1 every golden includes the §8 2D chrome (orientation letters, corner info, RAD/NEU badge),
  and from Phase 2 the colour bars.

### Regenerating a golden

Two locks, both deliberate:

```sh
TETRAVOX_UPDATE_GOLDENS=1 pnpm --filter @tetravox/engine run e2e
# or, equivalently
pnpm --filter @tetravox/engine run e2e:update-goldens
```

1. `playwright.config.ts` sets `updateSnapshots: 'none'` unless `TETRAVOX_UPDATE_GOLDENS` is set, so a
   **missing** golden is a failure, not a silent capture.
2. `expectGolden()` refuses to run in any update mode without that env var, so `playwright test -u` alone
   cannot re-bless a rendering change.

**§11 also requires the commit body to state what changed visually.** "Regenerate goldens" is not a
commit message; "the GM surface is now lit by a headlight rather than a fixed light, so every mesh golden
shifts ~8 % brighter on the upper hemisphere" is.

`*-actual.png` and `*-diff.png` next to a golden are git-ignored; on a failure the whole
`playwright-report/` and `test-results/` tree is uploaded as a CI artefact.

---

## 4. Adding an analytic pixel test

The harness is two functions in `packages/engine/test/helpers/pixels.ts`:

```ts
expectPixel(target, x, y, [r, g, b, a], tol = 1)   // reads back with gl.readPixels, IN THE PAGE
expectGolden(target, name)                          // the regression PNG, §11 policy applied
```

**Coordinates are top-left origin** — canvas pixel `(0, 0)` is the top-left pixel, the same one a golden
PNG and a human call `(0, 0)`. `readPixels` is bottom-left; the flip happens inside the helper exactly
once so no test has to remember it. `readCanvasPixels(target, points)` reads many pixels in one round
trip, for coverage-style assertions.

There is **no PNG round-trip**: `expectPixel` asserts the drawing buffer itself. It calls the page's
`window.__tvxRender()` and `gl.readPixels` in the *same task*, so a compositor pass can never get between
the draw and the read. In Phase 1 the same assertions move onto `engine.readPixel(viewId, x, y)` (§4.7)
with no change of shape.

### The recipe

1. **Add a page.** `test/pages/<name>.html` with a single `<canvas id="gl">` sized to its backing store
   and no CSS scaling, plus `test/pages/<name>.ts` that draws and assigns `window.__tvxRender`.
2. **Put the scene's numbers in a side-effect-free module** — `test/pages/<name>-scene.ts` — and import
   it from *both* the page and the spec. A test that re-types its fixture's constants is asserting a
   transcription, not a rendering.
3. **Derive the expectation, don't remember it.** `triangle-scene.ts` exports `insideTriangle(x, y)`, a
   half-plane test over the same clip-space vertices the page draws, so every expected pixel is computed.
   For a volume, compute the expected RGBA from the colormap and `Scale` by hand — §11's worked example
   is a 4×4×4 volume with `v = i` under `gray` and `{kind:'linear', lo:0, hi:3}`, giving exactly
   `rgb(85,85,85)` ± 1.
4. **Choose pixels far from edges.** Every asserted pixel in `triangle.spec.ts` sits ≥ 25 px from the
   nearest triangle edge, so no rasteriser fill-rule tie-break can reach it.
5. **Make the colours exact 8-bit values.** `k / 255` round-trips exactly; `0.1` does not, and then the
   tolerance is arguing about the driver's rounding instead of about the rendering.
6. **Add the golden last**, once the analytic assertions pass. A golden captured before the numbers are
   right just freezes the bug.

`test/e2e/triangle.spec.ts` is the worked example of all six.

---

## 5. CI (§12)

`.github/workflows/ci.yml`.

* **`test`** on `ubuntu-24.04` (**golden authority**) and `macos-latest`: pinned Rust toolchain from
  `rust-toolchain.toml` → `cargo fmt` / `clippy -D warnings` / `cargo test` → `pnpm wasm` → `pnpm
  typecheck` / `pnpm lint` / `pnpm test` → `pnpm e2e`. Caches: cargo (registry, git, `~/.cargo/bin`,
  `target`), the pnpm store, `~/.cache/electron`, `~/.cache/ms-playwright`. `ELECTRON_CACHE` and
  `PLAYWRIGHT_BROWSERS_PATH` are pinned to those paths on both runners, because macOS would otherwise use
  `~/Library/Caches` and the cache keys would not match.
* **`pnpm exec electron --version` is its own step**, before the e2e, exactly as §12.2 requires: a failed
  ~100 MB download is then a red step with an obvious name, not a mysterious e2e failure.
* **`TETRAVOX_TESTDATA` is unset**, and a step asserts it — real-data tests skip in CI by design.
* An **Xvfb** is started on the Linux runner and exported as `DISPLAY`, because Electron needs an X server
  and the Phase-1 app E2E will run there.
* **Packaging in Phase 0 is the macOS `.dmg` step only**, inside the `test` job, without
  `continue-on-error`: `pnpm package` builds this platform's artefacts only (§12.1), and Linux artefacts
  are never built on macOS. Until `packages/app` has a `package` script the step is a documented no-op;
  the moment it has one, a broken `.dmg` is a red build.
* The full §12.1 **`package` matrix** (`.dmg` arm64/x64, `.AppImage`, `.deb`) is carried in the workflow
  from day one, as ROADMAP Phase 0 requires, but it is `workflow_dispatch`-only and **Phase 3's to make
  green**, including the artefact smoke test each leg ends with.

The §12.2 gate — *a clean clone with an empty pnpm store reaches `pnpm e2e` green* — is what the cold-cache
path of this workflow exercises on every first run of a new cache key.
