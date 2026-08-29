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
| Downloadable builds of `main` | `ci.yml`'s `package` job, every push to `main` |
| macOS artefacts locally | `pnpm package` |
| Linux artefacts locally | `scripts/package-linux.sh` (Docker) |
| Prove a packaged artefact works | `node scripts/smoke-artefact.mjs` |

---

## 1. What gets built

`packages/app/electron-builder.yml`. Artefact names are `Tetravox-<version>-<os>-<arch>.<ext>` on
every platform and every target — set by an `artifactName` **inside each os block**, because the
top-level default is not inherited into the `dmg` / `nsis` / `appImage` blocks the way per-os ones
are, and a `.deb` otherwise arrives as `tetravox_0.2.0_amd64.deb`.

| Platform | Targets | Arch | Built on | Required |
|---|---|---|---|---|
| macOS | `dmg`, `zip` | arm64 **and** x64 | `macos-latest` — **one** runner builds and smoke-tests both slices (§7); also `pnpm package` locally | **yes** |
| Linux | `AppImage`, `deb`, `tar.gz` | x64 | `ubuntu-24.04`; locally via `scripts/package-linux.sh` | **yes** |
| Windows | `nsis` | x64 | `windows-latest`; also builds from macOS/Linux — see §5 | no (§5) |

**macOS and Linux are the priority platforms.** Both workflows mark the Windows leg
`continue-on-error`, and `release.yml`'s `verify` job treats a missing `.exe` as an absence to report
rather than a failure. A Windows problem never blocks a macOS/Linux release.

The exact asset names at version `<v>`:

```
Tetravox-<v>-mac-arm64.dmg        Tetravox-<v>-mac-arm64.zip
Tetravox-<v>-mac-x64.dmg          Tetravox-<v>-mac-x64.zip
Tetravox-<v>-linux-x86_64.AppImage
Tetravox-<v>-linux-amd64.deb
Tetravox-<v>-linux-x64.tar.gz
Tetravox-<v>-win-x64.exe          (optional)
```

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

### What the tag push does

`release.yml` runs three stages, in the shape of the maintainer's `release-build.yml`:

1. **`create-release`** — makes the GitHub Release for the tag immediately, as a **draft**, with the
   body taken from `CHANGELOG.md`'s section for this version (`scripts/changelog-section.mjs`) plus
   the unsigned-build instructions, and GitHub's generated commit/PR summary appended underneath.
2. **`build`** — four parallel jobs (macOS arm64, macOS x64, Linux x64, Windows x64). Each installs
   the pinned toolchains, builds, runs its artefact smoke test, uploads a workflow artefact, and then
   **attaches its own files to that Release**. Creating the Release first is what lets each platform
   publish as soon as it is ready instead of waiting for the slowest.
3. **`verify`** — reads the assets actually attached and fails if any *required* one is missing. This
   is the check that a green matrix does not give you: a leg can succeed and still upload nothing.

Then, on the draft:

1. `verify` must be green. It names every required asset it found.
2. Download at least the `.dmg` for your own machine and open it. The smoke test proves the renderer
   starts; it does not prove the installer produced something a human can double-click.
3. Read the notes.
4. Press Publish.

Nothing is public until step 4. `release.yml` creates the Release with `draft: true` and no path in it
publishes. **This is the one deliberate difference from the reference workflow**, which publishes
straight away: a draft missing a `.dmg` is a fixable morning, a published one is not.

If `verify` fails, do not publish. Re-run the failed `build` leg, or delete the draft and the tag
(`git push origin :refs/tags/v0.2.0`) and cut it again.

To rehearse without a tag: run `release.yml` from the Actions tab. `workflow_dispatch` builds the same
matrix and uploads workflow artefacts, while `create-release`, the attach step and `verify` are all
`if:`-gated on `refs/tags/v` and do not run. Every push to `main` also runs `ci.yml`'s `package` job,
so `main` always has downloadable builds without any tag at all.

---

## 4. Signing and notarisation (macOS)

`packages/app/electron-builder.yml` describes the **signed** build — `hardenedRuntime: true`,
`gatekeeperAssess: false`, `entitlements` / `entitlementsInherit: build/entitlements.mac.plist`,
`notarize: true`, and deliberately **no** `identity:` key (with one, electron-builder never looks at
`CSC_LINK`). electron-builder 26 signs from `CSC_LINK` and notarises through the `APPLE_*` variables
by itself; `@electron/notarize` is its own dependency, not one of ours.

**Whether that config is used is decided in one place: `scripts/electron-builder.sh`.** Every
packaging path goes through it — `pnpm package`, ci.yml's package legs, release.yml's build step:

| `CSC_LINK` | What happens |
|---|---|
| set | signed with the Developer ID, hardened, notarised, stapled |
| empty | `CSC_IDENTITY_AUTO_DISCOVERY=false`, plus `--config.mac.hardenedRuntime=false --config.mac.notarize=false` — an ordinary unsigned build, no error |

The script **unsets** the five variables on that path rather than leaving them empty. A workflow
writes `CSC_LINK: ${{ secrets.CSC_LINK }}` unconditionally, so on a runner without the secret the
variable exists and is `""` — and electron-builder tests it for *defined*, not for non-empty. It then
resolves `""` as a certificate path and dies with `⨯ /…/packages/app not a file`, an error that names
neither signing nor the empty variable (release run 33220659986).

The unsigned fallback is not politeness towards forks, it is a correctness rule: electron-builder
ad-hoc-signs the arm64 slice whether or not you have a certificate, and an ad-hoc signature plus
`hardenedRuntime: true` is an app the kernel kills at launch. Turning auto-discovery off also keeps
`pnpm package` deterministic between two developers, one of whom happens to have a Developer ID in
their login keychain.

### The four secrets

`release.yml`'s build step passes these on every leg and tolerates all of them being empty. Only the
first four are secrets; `APPLE_TEAM_ID` is public and is written in the workflow (`3BMY24SA43`).

| Secret | What it is | Where it comes from |
|---|---|---|
| `CSC_LINK` | the Developer ID **Application** certificate, as a base64 `.p12` | Xcode → Settings → Accounts → Manage Certificates, or developer.apple.com; export from Keychain Access as `.p12`, then `base64 -i cert.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | the password set when exporting that `.p12` | you chose it during the export |
| `APPLE_ID` | the Apple ID of the developer-programme account | — |
| `APPLE_APP_SPECIFIC_PASSWORD` | an **app-specific** password, never the account password | appleid.apple.com → Sign-In and Security → App-Specific Passwords |

The maintainer adds them once:

```sh
gh secret set CSC_LINK --repo idossha/tetravox < cert.p12.base64
gh secret set CSC_KEY_PASSWORD --repo idossha/tetravox
gh secret set APPLE_ID --repo idossha/tetravox
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo idossha/tetravox
```

Until they exist the mac artefacts are unsigned, the release still builds, and the release-run log
says so: the `Signature, Gatekeeper and staple` step runs `codesign -dv`, `spctl -a -t install` and
`xcrun stapler validate` on the built `.app` and prints what they say without gating on it. Once the
secrets are in place, `stapler validate` reporting `The validate action worked!` is what proves the
notarisation ticket is stapled — and the smoke test still runs against the signed, stapled app, so a
signature that breaks the launch is caught in the same job that made it.

The mac leg checks these credentials with `xcrun notarytool history` *before* it builds. If that step
fails, fix the secret first and only then re-run — do not just press re-run.

#### 4.1 "Your Apple ID has been locked" (HTTP 401)

Every failed notarytool sign-in counts as a failed login on the Apple ID; a few in a row (a stale or
mistyped app-specific password, re-run three times) lock the account, and after that *every* run
fails with `HTTP status code: 401. Your Apple ID has been locked` no matter what the secret holds.
This happened on the v0.2.0 runs of 2026-08-29. Recovery is entirely outside CI:

1. Unlock the account at <https://iforgot.apple.com> (or appleid.apple.com → Sign-In and Security).
2. Generate a **new** app-specific password — the old one is invalidated by the lock.
3. `gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo idossha/tetravox`
4. Re-run only the failed mac leg of the release run (`gh run rerun <id> --failed`), then the
   `Verify the Release assets` job runs again on its own.

Notarisation is slow (minutes, occasionally tens of minutes on a first submission); the mac leg's
`timeout-minutes: 60` covers it. When signing is live, drop the unsigned-build paragraph from
`scripts/changelog-section.mjs` and the `xattr -dr com.apple.quarantine` walkthrough from
`docs/USER_GUIDE.md`. Auto-update stays out of scope regardless.

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
node scripts/smoke-artefact.mjs --all           # every slice this platform built (both mac slices)
node scripts/smoke-artefact.mjs --software-gl   # force ANGLE/SwiftShader (a runner with no GPU)
node scripts/smoke-artefact.mjs --version-only  # launch-and-exit (Windows)
```

**What each leg passes, and why it is not the same everywhere.** A hosted runner is not a desktop:
three of the four have no GPU, and the v0.2.0 release run failed on exactly that (run 33217830015).

| Leg | Flags | Renderer it proves |
|---|---|---|
| macOS `macos-latest` | `--all` | Apple Metal, **both** slices — arm64 natively, x64 under Rosetta 2 |
| Linux `ubuntu-24.04` | `--software-gl` | ANGLE/SwiftShader under Xvfb, asserted to be software |
| Windows `windows-latest` | `--version-only` | launch-and-exit only (§5) |

`--software-gl` adds `--use-gl=angle --use-angle=swiftshader --disable-gpu-compositing` to the launch
(`packages/app/src/main/index.ts` §2), on top of the `--enable-unsafe-swiftshader` every launch
carries and the `--no-sandbox` Linux always needs. The distinction matters: `enable-unsafe-swiftshader`
only *permits* a fallback, and on a runner where the GPU process cannot bring up a display at all
there is nothing to fall back from — the Linux leg died with `vertex shader failed to compile:
(no log)` from a context that was already gone. The job then logs which renderer answered
(`gl: <renderer> (software|hardware)`) and the smoke test asserts on it, so a leg cannot quietly make
a different claim than its name.

**There is no software-GL path on macOS, and that is measured, not assumed.** macOS ANGLE allows only
`metal` and `swiftshader`; SwiftShader's Vulkan backend fails to initialise (`Internal Vulkan error
(-3) … Exiting GPU process`) — reproduced identically on an M2 Mac against eight flag combinations
(`--disable-gpu-sandbox`, `--in-process-gpu`, `--ignore-gpu-blocklist`, `--use-vulkan=swiftshader`,
`VK_ICD_FILENAMES`, …) and on the `macos-26-intel` runner, which has no Metal device either. That is
why the Intel leg is gone rather than fixed: `electron-builder.yml` declares `arch: [arm64, x64]`, so
the arm64 runner already emits **all six** mac assets — during the failed v0.2.0 run it filled the
draft Release on its own — and `--all` smoke-tests the x64 slice there, on a real GPU under Rosetta 2.
Measured on an M2 Max: arm64 2.6 s, x64 under Rosetta 39 s.

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

Every artefact below was built and verified locally at `0.1.0` — macOS with `pnpm package` on an
M-series Mac, Linux with `scripts/package-linux.sh` (Docker), Windows with
`electron-builder --win --x64` **from macOS**.

| Artefact | Size | How it was verified |
|---|---|---|
| `Tetravox-<v>-mac-arm64.dmg` | 123 MB | built; the `.app` inside is what the two checks below run |
| `Tetravox-<v>-mac-arm64.zip` | 123 MB | built |
| `Tetravox-<v>-mac-x64.dmg` | 127 MB | built; smoke test passes under Rosetta |
| `Tetravox-<v>-mac-x64.zip` | 127 MB | built |
| `Tetravox-<v>-linux-x86_64.AppImage` | 120 MB | built in Docker; smoke test runs the unpacked payload under Xvfb (see §6) |
| `Tetravox-<v>-linux-amd64.deb` | 95 MB | built in Docker |
| `Tetravox-<v>-linux-x64.tar.gz` | 114 MB | built in Docker |
| `Tetravox-<v>-win-x64.exe` | 107 MB | built from macOS with no wine; **not launched** — that is `windows-latest`'s job |

The two macOS checks, both on the arm64 slice:

* `node scripts/smoke-artefact.mjs` → `ok=true`, `smoke.png` 5,015 B, load **354 ms**, 7.2 s wall.
* `TETRAVOX_REQUIRE_PACKAGED=1 pnpm --filter @tetravox/app run e2e:packaged` → **130 passed, 70
  skipped, 26.1 s**.

The Linux check, inside the container under Xvfb: `ok=true`, `smoke.png` 3,427 B, load 1,373 ms.

**The Rosetta number is the reason §7's discovery order exists.** The same packaged e2e against the
x64 slice on this arm64 Mac took **4.9 minutes** instead of 26.1 seconds, and the same smoke test took
3,879 ms to load instead of 354 ms. Before the fix, both ran against `release/mac` — the x64 build —
and passed, so the leg was green and the arm64 artefact had never been launched.
