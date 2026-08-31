---
layout: page
title: Testing
permalink: /TESTING.html
nav_order: 6
---

# Testing Tetravox

The contract is `docs/ARCHITECTURE.md` §11 (rendering verification) and §12 (CI). This is the operator's
manual for both.

Rule 0, from §11: **an agent cannot judge a PNG; it can judge a number.** Every rendering feature ships an
*analytic* pixel assertion — expected RGBA computed from first principles on a synthetic fixture — **plus** a
golden PNG for regression. Never "verify" a rendering change by looking at a picture and declaring it fine.

## 1. Running it

| Command | What it does |
|---|---|
| `pnpm install` | workspace install; both lockfiles are frozen (§12.3) |
| `pnpm wasm` | builds `crates/tvx-wasm` → `packages/wasm/pkg`. **Prerequisite of build / test / typecheck** |
| `cargo test --workspace` | Rust unit + real-data tests (235 today) |
| `cargo clippy --workspace --all-targets -- -D warnings` · `cargo fmt --all --check` | Rust lint |
| `pnpm test` | `cargo test --workspace` + `pnpm wasm` + `vitest run` (1,128 vitest tests over 78 files) |
| `pnpm exec vitest run --project engine` | one vitest project (`protocol`, `wasm`, `engine`) |
| `pnpm typecheck` · `pnpm lint` | `tsc --noEmit` per package · `eslint .` + `prettier --check .` |
| `pnpm e2e` | every package's Playwright suite |
| `pnpm --filter @tetravox/engine run e2e` | the engine suite — **two projects**: `chromium-swiftshader` (everything, goldens included) and `chromium-angle` (`@angle` only, on the real GPU) |
| `pnpm --filter @tetravox/app run e2e` | the Playwright-Electron suite — **two projects**: `dev` and `packaged` |
| `scripts/e2e-quiet-check.sh` | runs `pnpm e2e` and proves it took neither the screen nor the focus (§2.2) |
| `node --test scripts/sync-module-docs.test.mjs` · `node scripts/sync-module-docs.mjs --check` | the module-docs generator's own fixtures, then the check that `docs/AUTOMATION.md` §2.7 still matches the manifests (the `docs-guard` job) |
| `python -m unittest discover -s python/tests` | the Python client's document tests — standard library only, no install (the `python` job) |

Prettier does **not** format `docs/` — keep it that way; a reflowed contract makes every diff unreadable.

Before the first `pnpm e2e` on a cold machine:

```sh
pnpm exec electron --version            # electron ≥ 42 downloads its ~100 MB binary on first LAUNCH (§12.2)
pnpm exec playwright install chromium   # the version-pinned Chromium
```

Real-data tests are gated on an environment variable and **skip, never fail, when it is unset**. CI leaves
both unset on purpose and asserts so. Locally:

```sh
export TETRAVOX_TESTDATA=/path/to/derivatives/SimNIBS/sub-ernie
export TETRAVOX_SEEG_TESTDATA=/path/to/derivatives/seegprep/sub-P076   # §13's contact editor
```

`TETRAVOX_SEEG_TESTDATA` is a **subject directory inside a `seegprep` derivative tree** —
`<dir>/ct/sub-<id>_acq-bone_space-T1w_ct.nii.gz` and `<dir>/ieeg/sub-<id>_space-T1w_electrodes.tsv`. There is
no such subject on the development machine, so `modules/seeg-realdata.test.ts` asserts **properties, not
numbers**: a real table's contact count, columns and coordinates belong to the site that produced it, and a
test pinning those could only ever be run by whoever generated them. Its synthetic half —
`modules/seeg-fixtures.test.ts` — is where the numbers live, and they come from numpy
(`scripts/gen-fixtures.py`, the `seeg` block).

### Where each kind of test lives

```
crates/*/src/**, crates/*/tests/**    #[test] — synthetic + TETRAVOX_TESTDATA-gated real data
packages/*/src/**/*.test.ts           vitest, unit
packages/engine/test/unit/*.test.ts   vitest, unit (engine logic with no GL)
packages/engine/test/e2e/*.spec.ts    Playwright — analytic pixels and goldens
packages/engine/test/pages/*          the pages those specs drive (HTML + a small TS bundle each)
packages/engine/test/helpers/*        expectPixel / expectGolden
packages/engine/test/golden/<class>/  the goldens, one directory per renderer class
packages/app/e2e/*.spec.ts            Playwright-Electron
scripts/reference/                    the Python reference renderer and its 117 self-tests
```

`*.test.ts` is vitest; `*.spec.ts` is Playwright. Nothing collects both.

### Testing something that persists

`e2e/fixtures.ts` gives every launch a **fresh** `--user-data-dir`, so two runs cannot collide over the
single-instance lock — which also means `settings.json` and every other per-profile artefact is thrown away
between launches. Anything that has to survive a relaunch is tested by launching twice against **one**
directory:

```ts
const profile = mkdtempSync(join(tmpdir(), 'tetravox-e2e-theme-'));
const first = await launchApp(target, { userDataDir: profile });   // set it, wait for main, close
const second = await launchApp(target, { userDataDir: profile });  // assert it came back
```

The two launches must not overlap: the second would find the lock held and quit. `e2e/theme.spec.ts` is the
worked example.

### Module tests (§13.4)

The extension surface is tested at three levels, and the split is not a matter of taste:

| Level | Where | What it can assert |
|---|---|---|
| Manifests and keys | `renderer/src/modules/modules.test.ts` | Every manifest in `MANIFESTS`, without naming one: ids, semver, `hostApi`, the `docs` heading, §13.5 pool membership, and every pool key probed through the **live `resolveKey`** so a module key that shadowed a §7.5 binding fails here. It also reads `src/modules/**` and `renderer/src/modules/<id>/**` off disk and fails an import the wall forbids — a lint rule can be disabled inline, a test cannot. |
| The host | `renderer/src/modules/hostImpl.test.ts` | `NoGlEngine` + `createUiStore` + `ShellController.attach()` (the `panels.test.ts` idiom): activation, commands, the status cell, the dirty flag, the scene block's round trip through a saved file, the confirm dialog and the discard guard. **State and calls, never pixels.** |
| The window | `packages/app/e2e/modules.spec.ts` | Everything §13.3 says about *layout*: the slot's height cap, the toolbar's height unchanged after an activation at 1440×900, the status cell left of the dataset cells, the aside in flow at 960 px, the rendered confirm dialog. vitest runs under `environment: 'node'`, so none of this can be asserted anywhere else. |
| A module end to end | `renderer/src/modules/seeg.test.ts`, `seeg-fixtures.test.ts`, `packages/app/e2e/module-seeg.spec.ts` | The three levels again, for the first *product* module. The harness drives every command through the controller against `NoGlEngine`; the fixtures replay numpy's own answers for the line fit, the re-fit, the tip rule, the snap and the float formatting; the e2e opens a real `seegprep` tree in a temp directory and reads the table, its `.bak` and its `_editlog.json` back off disk. |
| A **downloadable** extension | `main/module-store.test.ts`, `renderer/src/modules/installed.test.ts`, `packages/app/e2e/extensions.spec.ts`, `packages/app/e2e/csp.spec.ts`, `scripts/check-module-loader.mjs` | §13.8. Main's store (download, hash, consent, serve, revoke) and the renderer's loader are unit-tested; the e2e drives the whole round trip through a real Electron; the CSP spec proves the `script-src` grant from both sides; the loader guard reads the **built chunk**. See below. |

### Downloadable extensions (§13.8)

The seams, all of them environment variables, so nothing here touches a real `~/.tetravox` or the network:

| Variable | What it redirects |
|---|---|
| `TETRAVOX_MODULE_DIR` | where extensions are installed (default `<TETRAVOX_HOME>/modules`) |
| `TETRAVOX_EXT_INDEX` | the catalogue JSON, instead of the shipped `src/shared/extensions-index.json` |
| `TETRAVOX_HOME` | `configHome()`, so `settings.json` — and with it the **consent record** — is a temp file |

`e2e/fixtures/tetravox.fixture/` is a checked-in **emitted module bundle**: zero imports, the SDK shim
inlined, reading the host's React and the contacts kit off `globalThis.__tetravoxModuleSdk`. It is what a
module repository's `rollup -c` produces, checked in because no module repository exists yet, and
`extensions.spec.ts` runs the same five-line "no imports at all" check on it that
`scripts/module-sdk/README.md` tells a module repository to run in its own CI.
`e2e/fixtures/tetravox.future/` is a manifest alone, at `hostApi: 2`, for the greyed-card case.

`extensions.spec.ts` stages that bundle as a **release store** — each asset named by its own sha256, the
`scripts/sample-data/publish.sh` layout — and installs it over a `file://` URL, so the download path runs for
real with no server. Then: catalogue → install → consent sheet with the derived permissions → enable →
the switcher row → the module's own panel → disable → remove, with a `fetch('tetravox://module/…')` before
and after each consent change, because *consent gates execution* is the claim and a 404 is how it is visible.

Two claims live in `csp.spec.ts` instead, because a policy can only be proved from inside the page it governs
and **the dev server carries no CSP**:

```sh
pnpm --filter @tetravox/app run e2e                            # dev: everything above
pnpm package && TETRAVOX_REQUIRE_PACKAGED=1 \
  pnpm --filter @tetravox/app run e2e:packaged                 # the shipped bundle
```

The packaged leg is the gate for the `script-src 'self' 'wasm-unsafe-eval' tetravox://module` **host source**:
it enables a pre-seeded fixture through the preload bridge and then `import()`s its URL, asserting **both**
that no `securitypolicyviolation` fired *and* that `activate` came back a function. "It loaded" and "the policy
let it" are different facts, and only the pair is the claim.

`scripts/check-module-loader.mjs` is the third kind of test, and the only one that can catch its failure: the
loader's variable dynamic import is rewritten by Vite into an **empty** glob helper if the `@vite-ignore`
comment is ever lost, with no build warning and no failing unit test. It reads
`packages/app/out/renderer/assets/*.js`:

```sh
pnpm --filter @tetravox/app run build && node scripts/check-module-loader.mjs
node --test scripts/check-module-loader.test.mjs   # its own fixtures, driven red
```

The fixture module is the subject throughout, driven with `?modules=hello` — the same seam `?engine=mock`
uses. It is compiled into every build and listed only behind that parameter, because `pnpm e2e` drives the
production bundle: a fixture excluded from it would prove nothing about the bundle users get.

The **docs guard** has its own fixtures and does not run under vitest:

```sh
node --test scripts/check-frozen-docs.test.mjs   # its own rules, driven red
node scripts/check-frozen-docs.mjs --base origin/main
node --test scripts/sync-module-docs.test.mjs    # the generator's own fixtures, same idiom
node scripts/sync-module-docs.mjs --check        # §2.7 still says what the manifests say
node --test scripts/check-module-loader.test.mjs # §13.8's loader guard, driven red
```

CI runs all of these in the `docs-guard` job — the *self-tests* of the loader guard included, because they
need neither an install nor a toolchain; the loader guard's real run needs a build and is a step of `test`,
right after `pnpm e2e`, which is what builds `out/`. `docs-guard` checks out with `fetch-depth: 0` because
rule one is a merge-base diff. Locally, without `--base`, the script says it has nothing to diff and checks only the rule
that needs no diff — a guard that failed when it could not do half its job would be switched off within a
week. The middle two are §13.6's half of the same idea: §2.7 is *generated* from the manifests
(`node scripts/sync-module-docs.mjs` rewrites it), so a table that drifted would promise a user a job the
validator refuses.

The Python client's tests are the `python` job and need nothing installed — the client is standard library
only:

```sh
python -m unittest discover -s python/tests
```

### The test page server

`packages/engine/playwright.config.ts` starts Vite over `packages/engine` as the root, so a page can import
engine source with a plain relative path. Pages are at `http://127.0.0.1:<port>/test/pages/<name>.html`.
The port is **5199 plus a hash of the checkout's own path**, not 5199 flat: `reuseExistingServer: !CI` is
what makes a second local run fast, and on a fixed port it also reuses a Vite belonging to a *different
clone* — which once served one clean-clone gate run another tree's pages. Two clones get two ports; one clone
gets the same port every time. `TETRAVOX_TEST_PORT` overrides.

To poke at a page by hand:

```sh
pnpm --filter @tetravox/app exec vite --config "$PWD/packages/engine/test/vite.config.ts"
open http://127.0.0.1:5199/test/pages/triangle.html
```

`--filter @tetravox/app` is not a typo: `vite` is a devDependency of `packages/app` only and the lockfile is
frozen, so the engine harness borrows that binary rather than adding an importer edge.

## 2. Headless Chromium, SwiftShader, and the two renderer legs

§11 requires goldens to be captured under headless Chromium/SwiftShader with `@playwright/test` pinned to an
**exact** version, because that version pins the Chromium build and therefore the SwiftShader build. Do not
widen it to a range.

**Which launch flag matters.** Chromium M137 removed the *automatic* SwiftShader WebGL fallback, so on a
GPU-less runner `getContext('webgl2')` can return `null`.

* **`--enable-unsafe-swiftshader` *permits* the fallback.** It does not choose a renderer, so a machine with
  a working GPU still gets ANGLE/Metal. This is what §11 mandates and what `playwright.config.ts` passes.
* `--use-gl=angle --use-angle=swiftshader` *selects* the backend. It works, but it forces software
  **everywhere**, which would erase the ANGLE/Metal half of §11's two-renderer strategy. Rejected for that,
  not because it fails.

The remaining args exist to make the image a function of the scene only: `--force-device-scale-factor=1`,
`--disable-lcd-text`, `--font-render-hinting=none`, `--hide-scrollbars`.

**The two legs, and why there are two:**

| Project | Renderer | Runs | `caps.norm16` |
|---|---|---|---|
| `chromium-swiftshader` | `ANGLE (Google, Vulkan … SwiftShader …)` | everything, goldens included | false ⇒ the R16 test **skips with its reason** |
| `chromium-angle` | the platform GPU, e.g. `ANGLE (Apple, ANGLE Metal Renderer …)` | `@angle` only, no goldens | true ⇒ the R16 test **runs** |

`chromium-angle` runs the **full** Chromium (`channel: 'chromium'`, not Playwright's headless *shell*) with
`--enable-unsafe-swiftshader` deliberately *absent*, so it reaches the platform GPU. It captures no golden:
§11 stores goldens per renderer class, `test/golden/angle-metal/` does not exist, and a golden test running
there would demand a capture rather than a comparison.

**The leg asserts that it is still the GPU leg.** `caps.spec.ts` ends with a test that runs only on
`chromium-angle`, logs and attaches that leg's own capabilities, and **fails if the renderer is software**
(`isSoftware false`, `norm16 true`). A silent fallback to SwiftShader otherwise reports green while covering
nothing: every `@angle` test either self-skips or passes vacuously on software.
`TETRAVOX_ALLOW_SOFTWARE_ANGLE=1` is how to say *this runner really has no GPU* — the assertion becomes a
skip with its reason, and the leg is then honestly empty rather than silently missing. CI sets it on the
Linux runner, which has none; macOS stays strict.

**On Linux the project is not registered at all** (`ANGLE_LEG` in `playwright.config.ts`). A GitHub
`ubuntu-24.04` runner has no GPU, and headed Chromium under Xvfb there intermittently hands the page a
context that is already gone — the first shader compile fails with an **empty** info log, which is what a
lost context looks like and what a real GLSL error never does. Two runs of the same commit failed *different*
subsets. Since the leg exists to reach a platform GPU and a GPU-less runner cannot give it one, on Linux CI
it would only be SwiftShader a second time plus the flake. `TETRAVOX_ANGLE_LEG=1` turns it back on for a
Linux workstation that really has a GPU.

### 2.1 Windowless by default on macOS

**A test run must not hijack the monitor.** `pnpm e2e` launches a browser or an Electron app about twenty
times. Both suites are windowless by default on macOS, and neither gave up a single GPU capability for it:

| Leg | How |
|---|---|
| engine `chromium-swiftshader` | headless — unchanged; the golden authority was never visible |
| engine `chromium-angle` | `headless: !HEADED` in `playwright.config.ts`. Headless `channel: 'chromium'` still reports ANGLE/Metal with `norm16`, the timer query, `maxTextureSize 16384` and 36 extensions — identical to headed, and unchanged by `--use-angle=metal` / `--enable-gpu` / an explicit `--headless=new` |
| app `dev` / `packaged` | `TETRAVOX_E2E_OFFSCREEN=1`, set by `e2e/fixtures.ts` on darwin: the `BrowserWindow` is built and **never shown**, with no dock icon |

`TETRAVOX_E2E_HEADED=1` turns every window back on for debugging — one variable for both suites, and in the
app it outranks `TETRAVOX_E2E_OFFSCREEN`. A **user** launch sets neither and is unaffected: the only line the
app runs differently is the one that would have called `win.show()`. Linux keeps the visible path, since CI
runs under Xvfb where there is no monitor to hijack and the shown-window branch is then the one under test.

Two alternatives were measured and rejected. `--window-position=-10000,-10000` — the window still appeared
on screen (a tiling WM re-tiled it into view). Electron's **OSR** (`webPreferences.offscreen`) — it passes
everything, but it replaces the compositor with a CPU-side `paint`: `gpuMs` median 3.52 ms against 2.02 for a
never-shown window, `cpuMs` doubling, the frame loop pinned to `setFrameRate`, and `Page.captureScreenshot`
disagreeing with `capturePage()` on the same frame. The benchmark exists to record what the shipping renderer
costs, so the mode that runs it must not be the mode that inflates it.

### 2.2 Proving it: `scripts/e2e-quiet-check.sh`

```sh
export TETRAVOX_TESTDATA=/path/to/sub-ernie
scripts/e2e-quiet-check.sh                                  # runs `pnpm e2e`
scripts/e2e-quiet-check.sh pnpm --filter @tetravox/app run e2e
```

It samples two things every 0.5 s: the frontmost application (`osascript` → System Events) and the on-screen
window list (`CGWindowListCopyWindowInfo`, via ~30 lines of CoreGraphics it compiles with `clang`). It fails
if the frontmost app differs at the end, if a test binary was ever frontmost, or if any Electron / Tetravox /
Chromium window appeared at layer 0. The window list, not `win.getBounds()`, is what makes it a proof:
`getBounds()` reports what Electron *asked* for, and macOS clamps it.

**Export `TETRAVOX_TESTDATA` first, and repackage first.** The check proves the run took no screen; it says
nothing about what the run *covered*. Without the testdata root the R16 gate, the timings and the benchmarks
all skip and the script still prints `PASS`. Likewise the `packaged` project needs `pnpm package` to have run
more recently than `packages/app/src` (`TETRAVOX_REQUIRE_PACKAGED=1` turns its self-skip into a failure).

**An unreadable focus is exit 2, never agreement.** `osascript` needs Automation permission for "System
Events"; without it it prints nothing. Read as an empty string that would be a check passing *vacuously* — a
window-only check wearing the badge of a focus check, on exactly the fresh machine or CI runner that runs it.
So an empty reading exits 2 with the permission instructions. **Exit 0 is quiet, exit 1 is a window or the
focus, exit 2 is *this check could not tell you*.** A sample where some *other* app held the focus is a
*note*, not a failure — a chat client stealing focus mid-run is not this repo's doing.

## 3. The golden policy

Verbatim from §11, enforced by `playwright.config.ts` + `test/helpers/pixels.ts`:

* **Captured only** under headless Chromium/SwiftShader, fixed canvas size, `deviceScaleFactor: 1`,
  `aa: 'off'`, `deterministic: true`, with the launch args above.
* **Stored per renderer class** at `test/golden/<swiftshader|angle-metal>/<name>.png`. The class comes from
  the live context (`isSoftware`), never from `process.platform` and never from `headless`: the same machine,
  headless throughout, produces SwiftShader pixels on the bundled Chromium and ANGLE pixels on
  `channel: 'chromium'`.
* **Compared** at `maxDiffPixelRatio: 0.002`, `threshold: 0.15` — never byte equality. SwiftShader's LLVM JIT
  is not bit-identical across arm64 macOS and x86_64 Linux.
* **`ubuntu-24.04` is the golden authority.** macOS runs the same tests at a looser ratio (0.01), applied by
  `goldenMaxDiffPixelRatio()`. A golden that passes on macOS and fails on ubuntu must be **regenerated on
  ubuntu** — the authority wins.
* Every golden includes the §8 2D chrome (orientation letters, corner info, RAD/NEU badge) and the colour
  bars, so a regression that drops them fails CI.

**The golden authority has no `EXT_texture_norm16`**, so every golden pins the R32F branch of §6.1's payload
ladder: a float32 T1 is R32F in every captured PNG and R16 in the shipping renderer. Goldens therefore cannot
cover the primary format path. That coverage comes from analytic `expectPixel` tests run **twice** on the
`chromium-angle` leg — once with `forceCaps` unset (R16) and once with `forceCaps: { norm16: false }` (R32F)
— asserting the same physical value within each format's own tolerance. Same pattern as `forceDiscardClip`.

### Regenerating a golden

```sh
TETRAVOX_UPDATE_GOLDENS=1 pnpm --filter @tetravox/engine run e2e
# or: pnpm --filter @tetravox/engine run e2e:update-goldens
```

Two locks, both deliberate: `updateSnapshots: 'none'` unless that variable is set, so a **missing** golden is
a failure and not a silent capture; and `expectGolden()` refuses to run in any update mode without it, so
`playwright test -u` alone cannot re-bless a rendering change.

**§11 requires the commit body to state what changed visually.** "Regenerate goldens" is not a commit
message; "the GM surface is now lit by a headlight rather than a fixed light, so every mesh golden shifts
~8 % brighter on the upper hemisphere" is.

`*-actual.png` and `*-diff.png` are git-ignored; on a failure the whole `playwright-report/` and
`test-results/` tree is uploaded as a CI artefact.

### Blessing a golden from ubuntu — the loop the command above does *not* complete

The command above captures on **your** machine, and `ubuntu-24.04` is the authority (§11). Its SwiftShader is
a different build on a different architecture, so a picture that is right locally can still be over
`maxDiffPixelRatio` there. Both cases end at the same place — a PNG in the CI artefact — and neither is fixed
by running Playwright with `-u` again:

1. **Add the golden locally.** Write the spec, capture with `TETRAVOX_UPDATE_GOLDENS=1`, **look at the file**
   (it is evidence, not proof — §11 rule 0 still wants the analytic assertion beside it), and commit it with a
   body saying what it shows. Pushing without it is worse than pushing a wrong one: `updateSnapshots: 'none'`
   makes a *missing* golden a failure, so CI reports `A snapshot doesn't exist at …` and captures nothing.
2. **Let CI render it.** If ubuntu agrees within the ratio, that is the end of it. If it does not, the `engine`
   job fails on that one test and uploads `playwright-report/` + `test-results/`.
3. **Download the artefact and take ubuntu's picture.** Inside it,
   `test-results/<spec>-<test>-chromium-swiftshader/<name>-actual.png` is what the authority rendered, beside
   the `-diff.png` that says how it differs. Copy the **`-actual.png`** over
   `packages/engine/test/golden/swiftshader/<name>.png` and commit it — replacing your local capture, in its
   own commit, with a body stating what changed visually and that the picture came from ubuntu CI.
4. **Never make it pass by re-running.** `playwright test -u` on the failing leg would overwrite the
   authority's picture with the local one, which is the failure the two locks in the previous section exist to
   prevent. If the diff is a real regression, fix the code; if it is a legitimate visual change, step 3 is how
   it lands.

The same three steps re-bless an **existing** golden that a deliberate rendering change moved — `186ff51`
re-blessed five of them from ubuntu's renders on 2026-08-29 — and the only difference is that §11 then also
requires the commit body to say what changed and why.

### Where a spec's screenshots go

Two different things, and they never share a directory:

* **Evidence** — the picture a passing app spec takes as a side effect of proving something with
  numbers (§11 rule 0 / AGENTS rule 1). It goes to `SHOTS_DIR` from `packages/app/e2e/fixtures.ts`,
  which is `packages/app/test-results/shots/`: inside Playwright's own `outputDir`, so it is already
  covered by the `test-results/` line in `.gitignore` and by the CI artefact upload above. Playwright
  clears `outputDir` at the start of every run — these are per-run artefacts, nothing more. Every
  such spec (`theme`, `measure`, `cube-scalebar`, `layer-collapse`, `coordinates-realdata`,
  `fsaverage-realdata`, and the `TETRAVOX_SHOTS=1` captures `iso3d-screenshots`,
  `glyph-screenshots`, `surface-contours-screenshot`) writes there. **Do not add a second output
  directory**, and do not point a spec at `docs/`.
* **Documentation** — the committed capture set, `docs/screenshots/2026-08-29/`
  (`docs/reports/2026-08-29-visual-refresh/PLAN.md`). Its engine stills come from `--job` capture
  jobs; the UI states a job cannot reach come from `e2e/ui-tour-gallery.spec.ts`. The motion clips
  are `docs/media/` (`docs/media/SHOWCASE.md`, `examples/capture/showcase.py`).

`e2e/catalogue.spec.ts` is the one deliberate exception: it *is* the report it writes, into
`docs/reports/2026-08-28-visualization-scenarios/`, which `scripts/build-plates-report.py` then
assembles into a single HTML page.

## 4. Adding an analytic pixel test

The harness is two functions in `packages/engine/test/helpers/pixels.ts`:

```ts
expectPixel(target, x, y, [r, g, b, a], tol = 1)   // reads back with gl.readPixels, IN THE PAGE
expectGolden(target, name)                          // the regression PNG, §11 policy applied
```

**Coordinates are top-left origin** — canvas pixel `(0, 0)` is the top-left one, the same pixel a golden PNG
and a human call `(0, 0)`. `readPixels` is bottom-left; the flip happens inside the helper exactly once.
`readCanvasPixels(target, points)` reads many pixels in one round trip. There is **no PNG round-trip**:
`expectPixel` asserts the drawing buffer itself, calling the render and `gl.readPixels` in the *same task*,
so a compositor pass can never get between the draw and the read.

The recipe:

1. **Add a page.** `test/pages/<name>.html` with a single `<canvas id="gl">` sized to its backing store and
   no CSS scaling, plus `test/pages/<name>.ts` that draws and assigns `window.__tvxRender`.
2. **Put the scene's numbers in a side-effect-free module** — `test/pages/<name>-scene.ts` — imported by
   *both* the page and the spec. A test that re-types its fixture's constants asserts a transcription.
3. **Derive the expectation, don't remember it.** `triangle-scene.ts` exports `insideTriangle(x, y)`, a
   half-plane test over the same clip-space vertices the page draws. For a volume, compute the expected RGBA
   from the colormap and `Scale` by hand — §11's worked example is a 4×4×4 volume with `v = i` under `gray`
   and `{kind:'linear', lo:0, hi:3}`, giving exactly `rgb(85,85,85)` ± 1.
4. **Choose pixels far from edges** — every asserted pixel in `triangle.spec.ts` sits ≥ 25 px from an edge,
   so no rasteriser fill-rule tie-break can reach it.
5. **Make the colours exact 8-bit values.** `k / 255` round-trips exactly; `0.1` does not, and then the
   tolerance is arguing about the driver's rounding instead of about the rendering.
6. **Add the golden last**, once the analytic assertions pass. A golden captured before the numbers are right
   just freezes the bug.

`test/e2e/triangle.spec.ts` is the worked example of all six.

## 5. The reference renderer

`expectPixel` proves one pixel from first principles. It does not scale to a *pane*: nobody hand-computes
147,456 of them, and a golden only says "the same as last time". `scripts/reference/` is a second **rendering
path** for §7.3's slice compositing, in pure Python, that a test can point at the **same scene** the engine
drew and diff against.

```sh
python3 scripts/reference/render_slice.py <scene.json> -o /tmp/out [--stats]
python3 scripts/reference/make_ct.py [--spacing 0.7] [--out testdata/generated]
python3 -m unittest discover -s scripts/reference/tests        # 117 self-tests, ~9 s
```

Only numpy, nibabel and scipy. No Pillow (the PNG writer is 60 lines of `zlib`), no pytest, and **no import
from `packages/`**.

**What it shares, and what it does not** — worth stating precisely, because "independent implementation"
claims more than it delivers. *Independent*: the §3 affine, §6.1's raw samples and 65536-bin statistics,
§4.5's anchor, pane → world → voxel, trilinear and nearest sampling in NumPy with no texture unit and no R16
ladder, the screen-pixel derivative taken analytically instead of from a 2×2 quad, the compositing loop, and
everything under the shader. *Shared*: the display model, ported rather than re-derived — `value_gate`
follows `shaders/chunks/ladder.ts` branch for branch, and `colormaps.py` **parses `colormaps.ts` and lifts
its tables out verbatim**, so a stop edited in the TypeScript moves the reference on the next run and a
hand-transcribed table cannot drift by an 8-bit level. The consequence: a logic error inside `bakeScale`
would be reproduced here, not caught. What guards those is §4's analytic tests and the self-tests that check
the ported functions against the *prose* of §4.2 and §7.6. A pane diff guards everything else.

It renders **2D slice panes of volume layers only** — no meshes, no 3D pane, no §8 chrome — so a comparison
must be made with `setAnnotations` off, or restricted to the chrome-free region.

**Tolerances**, against the `.npy` float composite and the `.mask.npy` footprint it writes beside the PNG:

* mean `|Δ| ≤ 2/255` over the footprint. Two levels absorbs the R16 ladder's quantisation, the LUT's
  rounding, and SwiftShader's non-bit-identical JIT, and is far below anything visible.
* **≤ 1 % of footprint pixels above 8/255** on any channel. The mean alone would forgive a thin, badly wrong
  edge; this bounds the tail.
* **outlines by dilation-tolerant IoU ≥ 0.9**: `min(|A ∩ D(B)|, |B ∩ D(A)|) / |A ∪ B|` with `D` a one-pixel
  8-neighbour dilation. A plain IoU on a 2 px band punishes a half-pixel disagreement about where a boundary
  sits — an analytic derivative against a 2×2-quad estimate, not a defect — while a band drawn at the wrong
  *width* still fails, because dilation moves a boundary and does not thicken a band by 2×.

Outside the footprint the reference paints `background` exactly; compare it or don't, but don't average it
in — a pane that is 30 % black would dilute every tolerance by a third.

Three things the scene JSON needs that a `Scene` does not: the **window is explicit** (there is no
auto-`defaultWindow`, and §6.1 fixes the percentile estimator as a 65536-bin histogram reporting the bin's
lower edge, which is *not* what `np.percentile` says); **`label` presence selects the label path** and forces
nearest interpolation; and **`threshold.lo/hi: null`** means ±∞. `view.center` is §4.5's `camera.center`
verbatim — but the engine's anchor spans every **loaded dataset** while the reference's spans only the layers
the JSON *names*, so for a partial scene write `view.centerFromCursor` instead. Naming both keys is an error
rather than a silent winner.

`make_ct.py` builds a synthetic CT for `sub-ernie`, which has none: a volume whose affine disagrees with
`T1.nii.gz`'s, signed values carried by `scl_inter`, and thin very-bright metal, none of which the reference
dataset otherwise exercises. It writes **two encodings of the same volume** — `scl_slope 1 / scl_inter −1024`
and plain int16 — so a reader that folds slope/inter, or ignores it, makes the two disagree. That is the test.

## 6. CI (§12)

`.github/workflows/ci.yml`. **`test`** on `ubuntu-24.04` (golden authority, every event) and `macos-latest`
(push to `main` and `workflow_dispatch` only — macOS bills 10× on a private repo): pinned Rust toolchain →
`cargo fmt` / `clippy -D warnings` / `cargo test` → `pnpm wasm` → `pnpm typecheck` / `pnpm lint` /
`pnpm test` → `pnpm e2e`. Caches: cargo, the pnpm store, `~/.cache/electron`, `~/.cache/ms-playwright`, with
`ELECTRON_CACHE` and `PLAYWRIGHT_BROWSERS_PATH` pinned to those paths on both runners (macOS would otherwise
use `~/Library/Caches` and the keys would not match).

Three steps that exist for a specific past failure:

* **`pnpm exec electron --version` is its own step**, before the e2e — a failed ~100 MB download is then a red
  step with an obvious name. On Linux it is `electron --no-sandbox --version`: the `chrome-sandbox` helper in
  the npm tarball is not root-owned setuid and Chromium aborts rather than run unsandboxed, even for
  `--version`.
* **Xvfb** is started and exported as `DISPLAY`, with the step waiting on `xdpyinfo` first, so a display that
  never came up is a red Xvfb step rather than an unexplained Electron crash three steps later.
* **`timeout-minutes: 45`.** A green leg is ~8 min on ubuntu and ~5 min on macOS. This suite's characteristic
  failure is not a hang but a slow-motion pile of timeouts — an engine page that never publishes
  `window.__tvxEngine` fails ~120 tests at 30 s each, per project. One such run spent 3 h 14 m of macOS runner
  time at the 10× rate for a defect visible in its first minute.

**`TETRAVOX_TESTDATA` is unset in CI**, and a step asserts it. The §12.2 gate — *a clean clone with an empty
pnpm store reaches `pnpm e2e` green* — is what the cold-cache path exercises on every first run of a new
cache key.
