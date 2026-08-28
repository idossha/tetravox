---
layout: page
title: Releasing
permalink: /RELEASING.html
nav_order: 10
---

# Releasing Tetravox

How a version becomes downloadable artefacts. The contract is `docs/ARCHITECTURE.md` §12; this is the
operator's manual for it, the way `docs/TESTING.md` is the operator's manual for §11.

| | |
|---|---|
| Bump versions, changelog, commit, tag | `scripts/release.sh <version>` — **never pushes** |
| Build every artefact, draft the Release | `.github/workflows/release.yml`, on a `v*` tag |
| Build the matrix without releasing | `ci.yml`'s `package` job, `workflow_dispatch` |
| macOS artefacts locally | `pnpm package` |
| Linux artefacts locally | `scripts/package-linux.sh` (Docker) |
| Prove a packaged artefact works | `node scripts/smoke-artefact.mjs` |

---

## 1. What gets built

`packages/app/electron-builder.yml`. Artefact names are `Tetravox-<version>-<os>-<arch>.<ext>` on
every platform and every target — set by an `artifactName` **inside each os block**, because the
top-level default is not inherited into the `dmg` / `nsis` / `appImage` blocks the way per-os ones
are, and a `.deb` otherwise arrives as `tetravox_0.2.0_amd64.deb`.

| Platform | Targets | Arch | Built on |
|---|---|---|---|
| macOS | `dmg`, `zip` | arm64 **and** x64 | `macos-latest` (arm64) + `macos-26-intel` (x64); both locally with `pnpm package` |
| Linux | `AppImage`, `deb`, `tar.gz` | x64 | `ubuntu-24.04`; locally via `scripts/package-linux.sh` |
| Windows | `nsis` | x64 | `windows-latest`; **also builds from macOS/Linux** — see §5 |

**`${arch}` resolves per target to that ecosystem's spelling**, which matters if you are writing a
download link by hand: macOS and `.tar.gz` get `arm64` / `x64`, the `.AppImage` gets `x86_64`, and the
`.deb` gets `amd64`. The *pattern* is uniform; the arch token inside it is native. Hard-coding `x64`
would look tidier and would silently misname the first arm64 Linux build.

**`linux.executableName: tetravox` is required, not cosmetic.** electron-builder derives the Linux
binary name from `package.json`'s `name` — here the scoped `@tetravox/app` — sanitises it to
`@tetravoxapp`, and then refuses it: *executableName contains characters that cannot be safely used in
file paths*. macOS and Windows name the binary after `productName` and never reach that code, so the
whole failure is invisible until the first Linux build. This is exactly the class of bug §12.1 means
by *Linux artefacts are never built on macOS*.

`zip` alongside `dmg` on macOS is not redundant: the `.dmg` is what a human downloads, the `.zip` is
what a script downloads, and the `.zip` is the only mac artefact that unpacks without a mount.
`tar.gz` on Linux is the escape hatch for every distro that is neither Debian nor FUSE-capable.

**Not `universal` on macOS.** It doubles the download for every user to save them a choice, and the
two slices are built on separate runners in CI anyway.

**File associations** (§8) are declared once and registered on all three platforms: `.nii`, `.nii.gz`,
`.msh`, `.gii`, `.geo`, `.pos`, `.tetravox.json`. `.nii.gz` and `.tetravox.json` are compound
extensions — macOS treats each as its own UTI and Linux as its own MIME type, which is why they are
separate entries rather than a `gz` entry with a qualifier. `.geo` is `rank: Default`, not `Owner`:
the extension is shared with Gmsh's geometry-script language, which this app does not open, so it must
not claim to be the machine-wide handler for every `.geo`.

**Two Linux association gaps, measured** (both are electron-builder warnings during the `.AppImage`
build, and neither is fatal):

* *`file extension contains unexpected characters and will be skipped — extension=nii.gz`*, and the
  same for `tetravox.json`. **Compound extensions get no Linux MIME glob.** macOS registers each as
  its own UTI and Windows as its own progid, but electron-builder's Linux path writes one
  shared-mime-info entry per simple extension and refuses a dotted one. `.nii`, `.msh`, `.gii`,
  `.geo` and `.pos` associate normally; a `.nii.gz` or a `*.tetravox.json` opens fine from the command
  line and from *Open With*, but double-clicking it does not reach Tetravox by default. Closing it
  means shipping a hand-written `*.xml` with `<glob pattern="*.nii.gz"/>` in the `.deb` and
  registering it with `xdg-mime`.
* *`desktopName is not set in package.json`* — without it a desktop environment may not link the
  running window to the launcher icon. The config sets `StartupWMClass: Tetravox`, which covers the
  common case; the upstream fix is `desktopName` plus `linux.syncDesktopName: true`.

**Icons** live in `packages/app/build/` — `icon.png` (1024²), `icon.icns`, `icon.ico`,
`icons/<n>x<n>.png` — and are named explicitly in the config rather than left to the `buildResources`
convention, because electron-builder falls back to the stock Electron logo in silence when they are
absent. `scripts/ensure-icons.sh` mirrors a repo-root `build/` into that directory and otherwise fails
loudly; both CI packaging workflows run it before electron-builder.

---

## 2. Before you cut

```sh
pnpm install && pnpm wasm
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e
```

Then the two things a source-only test run cannot tell you:

```sh
pnpm package                                  # macOS: 2 dmgs + 2 zips, ~2 min
node scripts/smoke-artefact.mjs               # launches the packaged binary with --job
TETRAVOX_REQUIRE_PACKAGED=1 pnpm --filter @tetravox/app run e2e:packaged
```

`TETRAVOX_REQUIRE_PACKAGED=1` turns the `packaged` Playwright project's self-skip into a failure. Its
default is to skip when nothing has been packaged, which is right for `pnpm e2e` and is a silent hole
here.

Optionally, the Linux half. On an Apple-silicon Mac budget **20–30 minutes** and expect
`WARNING: The requested image's platform (linux/amd64) does not match the detected host platform`:
`electronuserland/builder` publishes no arm64 image, so the whole thing runs under emulation, and the
`.deb` target's single-threaded `xz` over a ~250 MB tree is most of the wall clock. The `.AppImage`
and the `.tar.gz` land in about four minutes. On the `ubuntu-24.04` CI runner it is all native and the
leg is a few minutes end to end.

```sh
scripts/package-linux.sh
```

---

## 3. Cutting the release

```sh
git switch main && git pull
scripts/release.sh 0.2.0 --dry-run      # prints what would change
scripts/release.sh 0.2.0
```

That single command rewrites the version in **six places** — the root `package.json`, the four
workspace `package.json`s, and `[workspace.package] version` in `Cargo.toml`, which all five crates
inherit — regenerates `Cargo.lock`, dates the CHANGELOG section, runs prettier over what it touched,
commits `chore(release): 0.2.0` and creates the annotated tag `v0.2.0`.

A partial bump is the failure this exists to prevent: `packages/app/package.json` is the file
electron-builder reads for `${version}`, so a tree that is 0.2.0 everywhere except there ships
`Tetravox-0.1.0-mac-arm64.dmg` out of a 0.2.0 release.

**`release.sh` does not push, and neither should an agent.** Pushing the tag is what starts the
release workflow and therefore what creates a Release, so it is a deliberate act:

```sh
git push origin main
git push origin v0.2.0        # <- this builds the matrix and drafts the Release
```

Then, on the draft:

1. Four `build` jobs must be green — each one ends with its artefact smoke test, so a green matrix
   means every artefact was launched.
2. Download at least the `.dmg` for your own machine and open it. The smoke test proves the renderer
   starts; it does not prove the installer produced something a human can double-click.
3. Check the generated notes. The body is `CHANGELOG.md`'s section for this version (extracted by
   `scripts/changelog-section.mjs`) plus the unsigned-build instructions, with GitHub's commit/PR
   summary appended underneath.
4. Publish.

Nothing is public until step 4. `release.yml` creates the Release with `draft: true` and there is no
path in it that publishes.

To rehearse without a tag: run `ci.yml`'s `package` job, or `release.yml` itself, from the Actions tab
— `workflow_dispatch` builds the same matrix and uploads workflow artefacts, and the `release` job is
`if:`-gated on `refs/tags/v`, so it does not run.

---

## 4. The notarisation switch (macOS)

Everything ships **unsigned** today (§12.2), which costs users a Gatekeeper prompt and costs the
project nothing. `hardenedRuntime: false` is not a preference in that state, it is required:
notarisation demands the hardened runtime, the hardened runtime demands a valid signature, and an
ad-hoc-signed app with `hardenedRuntime: true` is killed by the kernel at launch rather than merely
warned about.

To turn it on, three lines in `packages/app/electron-builder.yml`:

```yaml
mac:
  identity: 'Developer ID Application: Your Org (TEAMID)' # was: null
  hardenedRuntime: true # was: false
  notarize: true # was: false
  entitlements: build/entitlements.mac.plist # new file, see below
  entitlementsInherit: build/entitlements.mac.plist
```

and five environment variables on the signing runner — as repository **secrets**, never in the file:

| Variable | What |
|---|---|
| `CSC_LINK` | base64 of the Developer ID `.p12`, or a path to it |
| `CSC_KEY_PASSWORD` | that `.p12`'s password |
| `APPLE_ID` | the Apple ID of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password, **not** the account password |
| `APPLE_TEAM_ID` | the 10-character team identifier |

`build/entitlements.mac.plist` needs `com.apple.security.cs.allow-jit` and
`allow-unsigned-executable-memory` — V8 needs both, and the hardened runtime denies them by default.

When it is on, drop the unsigned-build paragraph from `scripts/changelog-section.mjs` and the
`xattr` walkthrough from `docs/USER_GUIDE.md`. Auto-update stays out of scope regardless; it is a
separate decision with its own `docs/DECISIONS.md` line.

Windows signing is not planned. It needs a paid certificate whose reputation SmartScreen builds up
over downloads, which an unpopular installer never accumulates, so the warning would remain.

---

## 5. Windows, and what it actually is

**electron-builder produces the `nsis` installer from macOS and Linux, with no wine.** This was
tested, not assumed: `electron-builder --win --x64` on macOS arm64 downloads `nsis-3.0.4.1.7z` and a
darwin-arm64 7-zip, runs a native `makensis`, and writes a 107 MB `Tetravox-0.1.0-win-x64.exe`. Wine
is needed for *signing* a Windows binary from a non-Windows host, and this project signs nothing.

The matrix builds it on `windows-latest` anyway, for one reason: that is the only runner where the
result can be launched. An installer nobody has ever run is not evidence.

**The Windows smoke test is weaker than the other two, deliberately.** macOS and Linux run
`scripts/smoke-artefact.mjs`, which launches the packaged binary with `--job` on a committed synthetic
fixture and asserts `job-result.json` is `ok` with a real PNG on disk — a frame off the GPU. Windows
runs `--version-only`: launch, print a version, exit 0. A hosted `windows-latest` runner has no GPU
and no compositor, and rather than let the leg go green on a vacuously offscreen render, it claims
only what it can prove — *the installer produced a runnable exe*.

So: **Windows is built and launch-verified on every release, and rendering on Windows is not covered
by CI.** That is a real gap and it is stated here rather than papered over. Closing it needs a
self-hosted Windows runner with a GPU, or a user report.

---

## 6. Linux locally, and why `package-linux.sh` looks the way it does

§12.1: *Linux artefacts are never built on macOS.* The `.deb`'s `strip`, the AppImage runtime and the
desktop-file validation are Linux-native steps that fail or silently no-op on darwin. So the local
path is Docker:

```sh
scripts/package-linux.sh              # build + smoke-test the AppImage under Xvfb
scripts/package-linux.sh --no-smoke
```

Three arrangements were tried; the script's header records all three, and the one it uses is: **the
wasm is built on the host, and only electron-builder runs in the container**, on the plain
`electronuserland/builder` image. `packages/wasm/pkg` is `wasm32-unknown-unknown` output — the same
bytes everywhere — so carrying it in is correct rather than a shortcut, and it saves a `rustup`
install and a full release build per run. The `:wine` image is not used, for the §5 reason.

Three things that bite and are handled:

- **`--publish never` on every electron-builder invocation.** electron-builder reads `CI=true` as
  consent to publish; without the flag it builds every artefact and *then* dies with
  `⨯ GitHub Personal Access Token is not set`, at the very end of a twenty-minute run. Uploading is
  `release.yml`'s business — `actions/upload-artifact` and a draft Release — never
  electron-builder's. The flag is on the `pnpm package` script and on both workflows too.
- **The `.deb` target hard-fails without `homepage` in `packages/app/package.json`** — `⨯ Please
  specify project homepage` — and it does so *after* the `.AppImage` and the `.tar.gz` have already
  been written, so the run looks like it nearly worked. `linux.executableName` (§1) is the other
  metadata field only Linux reads. Both are now set; this is here so the next one is recognised.

- **No apostrophes in the in-container script, comments included.** The whole container body is one
  single-quoted argument to `bash -c`, so a lone `'` closes it. This is not a syntax error — it fails
  *silently*: the commands after the apostrophe never run, `docker` exits 0, and the script lists the
  **previous** run's artefacts as if it had just built them. A green run over stale files is the worst
  outcome a packaging script can have, so `package-linux.sh` now also stamps a marker file before the
  container starts and fails if any artefact is older than it. The comment block in the script says so
  in capitals; keep it that way.
- **The container must not write root-owned files into your checkout.** The `electronuserland`
  images run as root; the script `chown`s back to the invoking uid, and gives the container its own
  pnpm store and `node_modules` so a darwin `esbuild` and a linux one never overwrite each other.
- **The AppImage cannot self-mount in a container.** It needs libfuse2, which neither the builder
  image nor Ubuntu 24.04 ships, and the failure reads as `AppImages require FUSE to run` — an
  environment artefact, not a build defect. The smoke test uses `--appimage-extract` and runs the
  extracted `tetravox`.

`--no-sandbox` on every Linux launch, packaged or not: `chrome-sandbox` inside the AppImage is not
root-owned setuid, and Chromium aborts rather than drop the sandbox silently — even for `--version`
(§12.2).

---

## 7. The smoke test

`scripts/smoke-artefact.mjs` is what §12.1 means by *"launch the packaged binary with a CLI arg
pointing at a fixture and assert it exits 0 after rendering one frame"*.

```sh
node scripts/smoke-artefact.mjs                 # discover the artefact in packages/app/release
node scripts/smoke-artefact.mjs --exe <path>    # an explicit binary
node scripts/smoke-artefact.mjs --version-only  # launch-and-exit (Windows)
```

It writes a two-file job (`testdata/vol_asym.nii` + `testdata/mesh_v2_ascii.msh`, `plain` preset, one
screenshot) into a temp directory, runs the **packaged** binary against it, and asserts `ok: true`,
one output, and a `smoke.png` larger than a header. It does not compare a golden — that is §11's job
and hundreds of tests already do it on the dev build. What this asks is whether the *packaged* thing
can start a renderer at all, which is the failure mode packaging introduces and testing cannot see.

`--job` is what makes it CI-safe: `src/main/window.ts` forces offscreen for any argv carrying it, and
a `--job` run is exempt from the single-instance lock. It never takes a developer's focus and never
needs a display manager (AGENTS.md rule 9).

On Apple silicon after a two-arch build, discovery prefers `release/mac-arm64` over `release/mac`.
A plain readdir finds `mac` first, which smoke-tests the **x64** slice under Rosetta and never touches
the arm64 one — a leg that passes while proving the wrong thing.

---

## 8. Measured, on this hardware

macOS artefacts from `pnpm package` on an M-series Mac, at 0.1.0:

| Artefact | Size |
|---|---|
| `Tetravox-<v>-mac-arm64.dmg` | 123 MB |
| `Tetravox-<v>-mac-arm64.zip` | 123 MB |
| `Tetravox-<v>-mac-x64.dmg` | 126 MB |
| `Tetravox-<v>-mac-x64.zip` | 126 MB |
| `Tetravox-<v>-win-x64.exe` | 107 MB (built on macOS) |

The smoke test on the arm64 slice: `ok=true`, `smoke.png` 5,015 B, load 622 ms, 7.6 s wall. The same
test against the x64 slice on the same machine loads in 3,879 ms — Rosetta, and the reason §7's
discovery order matters.
