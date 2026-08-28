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
| `TETRAVOX_ALLOW_SOFTWARE_ANGLE=1 pnpm e2e` | lets `chromium-angle` fall back to software instead of failing — a runner with no GPU (§2.2) |
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
export TETRAVOX_TESTDATA=/Users/idohaber/datasets/000/derivatives/SimNIBS/sub-ernie
scripts/e2e-quiet-check.sh                                  # runs `pnpm e2e`
scripts/e2e-quiet-check.sh pnpm --filter @tetravox/app run e2e
```

**Export `TETRAVOX_TESTDATA` first, and repackage first.** The check proves the run took no screen; it
says nothing about what the run covered. Without the testdata root the engine reports 19 passed / 11
skipped instead of 28/2 — the R16 gate, the phase-1 gate timings and the benchmarks all skip — and the
script still prints `PASS`. Likewise the `packaged` project needs `pnpm package` to have run more
recently than `packages/app/src` (`TETRAVOX_REQUIRE_PACKAGED=1` turns its self-skip into a failure).
A windowless run is only evidence of GPU coverage together with those two.

It samples two things every 0.5 s while the command runs: the frontmost application (`osascript` →
`System Events`) and the on-screen window list (`CGWindowListCopyWindowInfo`, via ~30 lines of
CoreGraphics it compiles with `clang` into a temp dir). It fails if the frontmost app is different at
the end than at the start, if a test binary was ever frontmost, or if any window owned by
Electron / Tetravox / Chromium appeared at layer 0.

**An unreadable focus is exit 2, never agreement.** `osascript` needs Automation permission for
"System Events" (System Settings → Privacy & Security → Automation), and without it it prints nothing
and fails. Read as an empty string that would be a check that passes *vacuously*: before and after
compare equal, the two focus greps run over an empty file, and the script prints `PASS` as a
window-only check wearing the badge of a focus check — on a fresh machine or a CI runner, which is
exactly who runs it. So an empty reading — first sample, last sample, or any sample in between — exits
2 with the permission instructions, as does a command that ends before the first 0.5 s tick. Exit 0 is
quiet, exit 1 is a window or the focus, exit 2 is *this check could not tell you*.

The window list, not `win.getBounds()`, is what makes it a proof: `getBounds()` reports what Electron
*asked* for, and macOS clamps it — the rejected off-screen candidate above asked for `x: -10000`, got
`x: -1240` back, and was on screen the whole time.

Measured on `main`'s successor with this change, 2026-08-27:

```
e2e-quiet-check: frontmost before = ghostty
e2e-quiet-check: running pnpm e2e
packages/wasm   e2e: 51 passed,  1 skipped (14.5s)
packages/engine e2e: 28 passed,  2 skipped (22.2s)   # both on chromium-swiftshader: gate 6's R16 branch
packages/app    e2e: 58 passed             (19.8s)   #   and the @angle GPU assertion, neither of which
                                                     #   applies to the golden authority
e2e-quiet-check: frontmost after  = ghostty   (87 samples)
e2e-quiet-check: command exited 0
e2e-quiet-check: no Electron/Chromium window reached the screen.
e2e-quiet-check: PASS
```

with `TETRAVOX_TESTDATA` exported, `TETRAVOX_REQUIRE_PACKAGED=1`, and `pnpm package` run first
(app: dev 29 + packaged 29).

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

Phase 1 shipped the R16 test without the project, so that branch executed in **no** environment at all
while the gate table recorded it as covered; that is the hole this project closes.

**The leg asserts that it is still the GPU leg.** `caps.spec.ts` ends with `@angle the second leg
reaches the platform GPU, and records which one`, which runs *only* on `chromium-angle` (it skips by
project name elsewhere) and does two things the leg previously had no way to do:

* it **logs and attaches this leg's own capabilities**, as `[caps chromium-angle]` and
  `capabilities-angle.json`. The other two caps tests are untagged, so `grep: /@angle/` excludes them:
  before this, the `[caps]` block printed by an `--project=chromium-angle` run was the *SwiftShader*
  leg's, and the ANGLE renderer string was never printed or asserted on anywhere.
* it **fails if the renderer is software** — `isSoftware false`, `rendererClass 'angle-metal'`,
  `norm16 true`. A fallback to SwiftShader fails nothing on its own: every `@angle` test either
  self-skips (gate 6's R16 branch) or passes vacuously on software, so the leg reports green while
  covering nothing. That is the failure mode §11 was written against, and until this change the only
  signal against it was a *skip* — plus, before §2.1, the incidental sight of a window on screen.

Measured on the leg itself (2026-08-27, M2 Max): `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max,
Unspecified Version)` / `Google Inc. (Apple)`, `isSoftware false`, `norm16 true`, `timerQuery true`,
`maxDrawBuffers 8`, `maxTextureSize 16384`. Forcing that same leg onto software with
`--use-gl=angle --use-angle=swiftshader` turns it **red**, with the renderer string in the failure
message — and in that same run gate 6's R16 branch skipped itself, which is the empty-leg shape this
now catches.

`TETRAVOX_ALLOW_SOFTWARE_ANGLE=1` is how to say *this runner really has no GPU*: the assertion becomes
a skip with its reason, `caps.norm16` is false, the R16 test skips too, and the leg is then honestly
empty rather than silently missing. It is the mirror of `TETRAVOX_REQUIRE_PACKAGED=1` — same idea,
opposite default, because the machine this leg was written for always has a GPU.
`.github/workflows/ci.yml` sets it on the **Linux** runner, which has none; macOS stays strict, so a
hosted macOS runner that cannot reach Metal is a red leg naming the variable rather than a green empty
one.

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

---

## 6. Reference renderer

`expectPixel` (§4) proves one pixel from first principles. It does not scale to a *pane*: nobody
hand-computes 147,456 of them, and a golden PNG only says "the same as last time", never "right".
`scripts/reference/` closes that gap — a second **rendering path** for §7.3's slice compositing, in
pure Python, which a Phase-2b test can point at the **same scene** the engine drew and diff against.

```
python3 scripts/reference/render_slice.py <scene.json> -o /tmp/out [--stats]
python3 scripts/reference/make_ct.py [--spacing 0.7] [--out testdata/generated]
python3 -m unittest discover -s scripts/reference/tests        # 117 self-tests
```

Only numpy, nibabel and scipy — the stack `AGENTS.md` already assumes. No Pillow (the PNG writer is
60 lines of `zlib`), no pytest (`unittest`), and **no import from `packages/`**.

### What it shares with the engine, and what it does not

Say what this is precisely, because "independent implementation" claims more than it delivers and
would make the tolerance policy below read as stronger evidence than it is. It is an independent
**rendering path** over a **shared display model**.

*Independent* — written from the prose of §3, §4.4, §4.5, §6.1 and §7.3, and where the bugs a second
path can actually catch live: the §3 affine (sform, else qform with `qfac` on the third column only),
§6.1's raw samples and 65536-bin statistics, §4.5's anchor, pane → world → voxel, `tc = (voxel +
0.5)/dims`, trilinear and nearest sampling done in NumPy with no texture unit and no R16 ladder, the
screen-pixel derivative taken analytically instead of from a 2×2 quad, the compositing loop, and
everything under the shader — upload, format choice, DPR, the driver, the JIT.

*Shared* — the display model, ported rather than re-derived: `value_gate` follows
`shaders/chunks/ladder.ts`'s `VALUE_GATE` branch for branch; `colormaps.py`'s `scale_position` /
`bake_scale` / `lut_texel_of` follow `color/colormaps.ts`'s `scalePosition` / `bakeScale` /
`lutTexelOf`; the label branch follows `chunks/lut.ts`'s `LABEL_BODY`, whose branch order decides
which of outline, selection and `labelOpacity` wins. The colour tables are shared outright:
`colormaps.py` parses `colormaps.ts` and lifts `TABLES` / `POSITIONS` out of it verbatim, so a stop
edited in the TypeScript moves the reference on the next run and a hand-transcribed table cannot
drift by an 8-bit level.

The consequence for §11 rule 0: a logic error inside `bakeScale` or the value gate would be
reproduced here, not caught — the two would agree and both be wrong. What guards those is the
analytic pixel tests (§4) and the cases in `scripts/reference/tests/` that check the ported
functions against the *prose* of §4.2 and §7.6 rather than against the engine. A pane diff guards
everything else.

It renders **2D slice panes of volume layers only**: no meshes, no 3D pane, no §8 chrome
(orientation letters, badge, corner info, colour bars, crosshair). A comparison must therefore be
made against a pane rendered with `setAnnotations` off, or restricted to the chrome-free region.

### The scene JSON

```json
{
  "layers": [{
    "path": "testdata/vol_ramp4.nii", "kind": "volume",
    "colormap": "gray", "colormapNegative": "blue-cyan",
    "scale":     { "kind": "linear", "lo": 0, "hi": 3 },
    "threshold": { "lo": null, "hi": null, "symmetric": false, "mode": "clamp", "softEdge": 0 },
    "opacity": 1.0, "interpolation": "linear", "volumeIndex": 0,
    "label": { "lut": "…_LUT.txt", "mode": "outline", "outlineWidthPx": 2,
               "visibleLabels": [10], "labelOpacity": {"3": 0.5}, "selectedLabels": [] }
  }],
  "view": { "mode": "axial", "normal": null, "up": null, "cursor": [0, 0, 0], "mmPerPx": 0.5,
            "widthPx": 512, "heightPx": 512, "radiological": false, "center": [0, 0] },
  "background": [0, 0, 0, 1]
}
```

Three things a harness has to get right, because the scene file is not a `Scene`:

* **The window is explicit.** There is no auto-`defaultWindow` here: write `scale.lo/hi` out. For
  `m2m_ernie/T1.nii.gz` the engine's default is `p2 .. p98` = `-0.782 .. 20353.88` — the numbers on
  the colour bar of `golden/swiftshader/slice-ernie-2x2.png`, and **not** what `np.percentile` says
  (`0 .. 20354`), because §6.1 fixes the estimator as a 65536-bin histogram reporting the bin's lower
  edge. `niftiref.default_window()` reproduces it.
* **`label` presence selects the label path**, and forces `interpolation: 'nearest'` (§4.4). The
  reference works in raw ids where the engine works in dense indices; the remap is a bijection, so
  fill, `visibleLabels`, `labelOpacity` and the outline test all agree.
* **`threshold.lo/hi: null`** means ±∞, matching `scene/defaults.ts`'s `NO_THRESHOLD`; the finite
  ±1e30 sentinel is applied internally exactly as `render/passes/slice.ts` sends it.

`view.center` is §4.5's `camera.center` **verbatim** — the pan offset from the scene-bounds anchor —
so a harness copies `slice.camera.center` straight out of the `Scene`. The anchor is not asked for:
`plane_anchor` derives it exactly as `planeAnchor(store.bounds())` does, as the centre of
`volumeBounds(dims, affine)` unioned over the scene's datasets, all of whose inputs the reference
already has from loading them. One caveat, and it is the reason the alternative exists: the engine's
anchor spans every **loaded dataset**, while the reference's can only span the layers the scene JSON
*names*. Rendering one layer of a two-dataset scene on its own therefore moves the pane here and
would not move it there. Two ways out — list every loaded dataset in the JSON, or write
`view.centerFromCursor` instead, which is the same offset measured from the cursor
(`effectiveSliceView`'s number, with the anchor already folded in) and makes the anchor irrelevant.
Naming both keys is an error rather than a silent winner. They coincide when the cursor sits on the
bounding-box centre, which is where `#onFirstDataset` puts it.

### Outputs, and the tolerance policy

`render_slice.py` writes three files per scene:

| File | Contents |
|---|---|
| `<out>.png` | RGBA8, `round(255 · composite)` — for eyeballing |
| `<out>.npy` | float32 `(H, W, 4)` in 0..1, the composite **before** 8-bit quantisation |
| `<out>.mask.npy` | bool `(H, W)`, true where any layer drew — §11's **volume footprint** |

A Phase-2b comparison is: build the scene, screenshot the engine pane, load the `.npy`, and assert

* **mean `|Δ|` ≤ 2/255** over the footprint mask (`mask.npy`), where `Δ = engine/255 − reference`
  per RGB channel. Two levels absorbs the R16 ladder's 1/65535 quantisation, the LUT's own
  rounding, and SwiftShader's non-bit-identical JIT, and is far below anything visible;
* **≤ 1 % of footprint pixels above 8/255** on any channel. The mean alone would forgive a thin,
  badly wrong edge; this bounds the tail. Anything worse than 8/255 on more than a hundredth of the
  pane is a rendering disagreement, not a rounding one;
* **outlines by dilation-tolerant IoU ≥ 0.9.** Compare boolean masks (engine outline pixels `A`,
  reference `B`) as `min(|A ∩ D(B)|, |B ∩ D(A)|) / |A ∪ B| ≥ 0.9`, where `D` is a one-pixel
  8-neighbour dilation. A plain IoU on a 2 px band punishes a half-pixel disagreement about where a
  boundary sits — which is a `dFdx` derivative estimated on a 2×2 quad against one computed
  analytically, not a defect — while a band drawn at the wrong *width* still fails, because
  dilation moves a boundary and does not thicken a band by 2×.

Outside the footprint the reference paints `background` exactly; compare it or don't, but don't
average it in — a pane that is 30 % black would otherwise dilute every tolerance by a third.

### Self-tests

`scripts/reference/tests/` — 117 `unittest` cases, ~9 s, no network, no GPU:

| File | Covers |
|---|---|
| `test_colormaps.py` (25) | the tables really came from the TypeScript; §11's `rgb(85,85,85)`; texel centres; `heat`'s two-segment ramp, dead band, `inverse`, `truncate`→`clipMax`, all three `negative` modes; the SimNIBS/FreeSurfer LUT rules and the dense palette |
| `test_render_slice.py` (59) | §11's worked example end to end; the **three mandatory orientation tests** on `vol_asym.nii` in both conventions; `right = cross(up, normal)` per preset; §4.5's anchor — `volumeBounds` over voxel centres, the union over datasets, and `center` vs `centerFromCursor` differing by exactly `effectiveSliceView`'s fold; trilinear vs nearest; the AABB discard at ±0.5 voxel; `scl_slope`/`scl_inter` and the NaN guard; every `Threshold` branch including the `softEdge` ramp value; layer order, opacity and the blend's alpha channel; the label palette, the outline width at three zooms, `fill`/`outline`/`both`, `visibleLabels`, `labelOpacity`, R5's selection rim; §3's `qfac`; the PNG round-trip |
| `test_make_ct.py` (21) | the HU table, the rotated grid, the contact rasteriser's partial volume, the two encodings, and one coarse end-to-end build on ernie |
| `test_real_data.py` (12) | `TETRAVOX_TESTDATA`-gated: the float32 T1, the default window against the golden's colour bar, laterality on the two thalami, the overlay-independence property, and §11's label-outline-zoom test |

Real-data cases **skip, never fail**, when `sub-ernie` is absent (`TETRAVOX_TESTDATA=/nonexistent`
leaves 17 skipped — the 12 above plus the 5 `make_ct.py` cases that need `m2m_ernie`), and write
their PNGs to the session scratchpad for eyeballing. The assertions are the test (§11 rule 0).

Two things the real data taught the tests, recorded so they are not rediscovered as bugs:
`segmentation/labeling_LUT.txt` gives id 517 (`Background`) **alpha 255**, so that atlas legitimately
paints the air around the head and its `outline` mode draws a box where the labelled field of view
ends — §7.3's "background is decided by alpha, not by index", in the wild. And
`Thalamus_TI_subject_TI_max.nii.gz` peaks at 3.152 near the electrodes but reaches only ~0.13 in the
thalamus it is aimed at, so a heat scale windowed on its global range paints the whole head one
colour.

### `make_ct.py` — a synthetic CT for `sub-ernie`

The reference dataset has no CT, and three things go untested without one: a volume whose affine
disagrees with `T1.nii.gz`'s, signed values carried by `scl_inter`, and thin very-bright metal.
`make_ct.py` builds one from `m2m_ernie/final_tissues.nii.gz` — HU per tissue (air −1000, WM 30,
GM 37, CSF 15, scalp 40, eyes 20, compact bone 1200, spongy 300, blood 45, muscle 50), σ = 15 HU
Gaussian noise, two SEEG leads of ten 1.3 mm × 2 mm ~3000 HU contacts each whose entry point is
found by marching outward until the segmentation reads air (so the skull crossing is geometry, not
an assumption), resampled to 0.7 mm isotropic on a grid rotated 5° about an oblique axis with a
sub-voxel origin offset.

It writes **two encodings of the same volume** to `testdata/generated/` (git-ignored, ~40 MB each):
`ct_hu_uint16.nii.gz` with `scl_slope = 1, scl_inter = −1024` (the scanner convention) and
`ct_hu_int16.nii.gz` with no scaling. A reader that folds slope/inter, or ignores it, makes the two
disagree — that is the test. Both carry `descrip = "synthetic CT (HU)"`. The run is deterministic
(fixed seed, `mtime = 0`): rerunning reproduces every byte. `ct_report.json` beside them records the
grid, the per-tissue HU means and each lead's tissue sequence, and the same is printed on stdout.

### One ambiguity the contract left open

**§7.3's `dFdx`/`dFdy` on a 2D pane.** The formula is written for a GLSL derivative; on an
orthographic pane it is exactly `right · mmPerPx` and `up · mmPerPx`, which is what the reference
computes. The sign of `dFdy` is irrelevant — the taps are symmetric — and this is *analytically*
what a driver's 2×2-quad estimate approximates, so a half-pixel disagreement at a boundary is
expected and is why outlines are compared by tolerant IoU rather than by equality.

### Measuring a band, so §11's thickness bound means something

§11's "Label outline zoom" asserts a thickness in **[0.8, 2.9] px** at 0.05, 1.0 and 5.0 mm/px, and
§7.3 says what thickness means: *perpendicular* ("2.00 px axis-aligned / 2.69 px at 45°"). A run
length along a screen axis is not that measure — it reads the band's oblique crossing, so it grows
with whatever angle the boundary makes with the pane, and it fuses the runs of two boundaries that
come within a pixel of each other. On `labeling.nii.gz` at 5.0 mm/px the row-run median reads 4 px
and the column-run median 9 px for one and the same band.

`test_real_data.thickness` therefore measures twice the median Euclidean distance transform on the
band's **ridge** (the pixels where the distance to background is a local maximum), which has no
preferred direction: **2.00 px at 0.05 / 0.25 / 1.0 / 2.0 mm/px and 2.83 px at 5.0** — inside §11's
bound at every zoom, with the 2.83 being `2·√2/2`, a 2 px band whose ridge runs diagonally in pane
pixels. Coverage of the fill boundary is asserted separately at 0.05, 1.0 and 5.0 mm/px and is
**100 %** at each, matching §7.3's "0 of … fill-boundary pixels were uncovered (0.0 % gaps)". If a
future measure disagrees with the bound, check the measure against §7.3's word before touching §11.
