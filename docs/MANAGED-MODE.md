# Managed mode — shipping and updating your own TetraVox copy

**Managed mode is a public, versioned API.** An application (the *host*) can download a TetraVox
release into its own directory, launch that private copy, and own every version change of it, while
the user still sees TetraVox's native "an update is available" window and can accept it there. This
page is the whole contract: a host can implement it without reading TetraVox's source.

The current protocol is **v1**. Everything below marked *v1* is frozen: it changes only additively
(see [Stability](#stability-and-versioning)). TI-Toolbox is one real-world adopter.

## At a glance

| What | Value |
|---|---|
| Host name (display text) | `TETRAVOX_MANAGED_BY` environment variable |
| Update-request file | `TETRAVOX_MANAGED_UPDATE_REQUEST` environment variable, an absolute path |
| Receipt file | `<request path>.receipt.json` |
| Protocol number | `1` |
| Receipt deadline | 15 s after the request appears |
| Recommended isolation | `--user-data-dir=<a directory the host owns>` |
| Available since | `TETRAVOX_MANAGED_BY`: 0.5.0 · `TETRAVOX_MANAGED_UPDATE_REQUEST`: the first release after 0.6.1 |

## 1. What the host sets

### Environment variables (v1)

- **`TETRAVOX_MANAGED_BY`** — the host's name as the user knows it, e.g. `ExampleHost`. It is
  **display text only**: TetraVox trims surrounding whitespace, shows it in the Software Update
  window ("Updates are managed by ExampleHost…", "ExampleHost installed this copy and installs its
  updates…") and prefixes a refusal with it. It grants nothing and selects no behaviour beyond
  "this copy is managed". Keep it short.
- **`TETRAVOX_MANAGED_UPDATE_REQUEST`** — an absolute path, in a directory the host owns and has
  already created, where TetraVox writes an update request when the user accepts an update.
  Setting it is how a host says "I implement the protocol below". Surrounding whitespace is trimmed.

Pass both in the environment of the process you launch. Build that environment deliberately (copy
your own and add the two variables) rather than relying on a shell profile.

### Command-line flags

- **`--user-data-dir=<dir>`** (Chromium's standard switch; recommended). Give your copy a profile
  directory of its own. It isolates, from any TetraVox the user installed themselves:
  - `settings.json` — including the update preferences `checkForUpdates` and
    `skippedUpdateVersion`, recent scenes and the rest of the Settings window;
  - the single-instance lock — without a separate profile, launching your copy while the user's own
    TetraVox runs hands your arguments (files, `--scene-request=`) to *their* window and your
    process exits; your environment variables never take effect;
  - the cached extension catalogue, downloaded sample data and Chromium's own storage and caches.

  It does **not** isolate the hand-editable config home (`~/.tetravox`: the `tetravoxrc` file and
  installed extensions). Both copies share those unless you also set **`TETRAVOX_HOME`** to a
  directory of your own. Sharing them is usually what a user expects; isolate them if your copy
  must not see the user's extensions.
- **`--scene-request=<absolute path>`** and a positional `<scene>.tetravox.json` open scenes; they are
  the [Native scene API](AUTOMATION.md#native-scene-api), independent of managed mode.
- **`--no-sandbox`** on Linux for a copy unpacked from the `.tar.gz` (see §6).

## 2. When managed mode is active (v1)

TetraVox decides its update mode once, at launch, from these facts:

| Packaged build | `--job` run | `TETRAVOX_MANAGED_BY` (trimmed) | `TETRAVOX_MANAGED_UPDATE_REQUEST` (trimmed) | Mode |
|---|---|---|---|---|
| no (a source checkout) | any | any | any | **off** — never checks |
| yes | yes | any | any | **off** — a batch job never checks |
| yes | no | empty or unset | any (ignored) | standalone: TetraVox updates itself |
| yes | no | non-empty | absolute path | **managed** — the protocol below |
| yes | no | non-empty | unset, empty or relative | **managed, updates off** |

"Absolute" is the running platform's rule (`/…` on macOS and Linux, `C:\…` or `\\server\…` on
Windows).

### What each mode does

- **Standalone** (not managed): TetraVox's own updater (macOS, Windows installer, Linux AppImage)
  or a Releases-page link (Linux `.deb`/`.tar.gz`). Not your concern as a host.
- **Managed, updates off**: nothing is checked, downloaded or installed. **File ▸ Check for
  Updates…** says "Updates are managed by `<name>`. Update this installation through that
  application." This is also exactly how every release from 0.5.0 behaves when a host sets only
  `TETRAVOX_MANAGED_BY`, so a host that predates the handshake keeps working.
- **Managed**: TetraVox never loads its self-updater and never writes into its own install
  directory. It checks its published release feed a few seconds after launch (honouring the user's
  `checkForUpdates` setting and a skipped version) and on **File ▸ Check for Updates…**. When a
  newer release exists it shows its Software Update window with **Update to X**, **Skip This
  Version** and **Later**, and explains that `<name>` installs the update. Only **Update to X**
  involves the host, through the protocol in §3.

## 3. The update-request protocol (v1)

### Sequence

1. The user clicks **Update to X**. If an extension has unsaved edits, TetraVox asks first; if the
   user keeps them, nothing is written.
2. TetraVox deletes any old `<path>.receipt.json`, writes the request to `<path>.tmp` (mode `0600`
   on POSIX) and renames it to `<path>`. The request therefore appears whole; never read
   `<path>.tmp`.
3. TetraVox polls for `<path>.receipt.json` for up to **15 seconds**.
4. The host reads the request, **deletes it**, validates it, and writes a receipt — atomically
   (write a temporary file in the same directory, then rename it to `<path>.receipt.json`).
5. TetraVox ignores any receipt whose `protocol` is not `1` or whose `id` differs from the
   request's, and keeps waiting. On a matching receipt it deletes the receipt and:
   - `ok: true` → quits (the user already answered the unsaved-edits question);
   - anything else → shows `<name>: <error>` (or `<name>: the update was refused` when `error` is
     not a string) and stays open.
6. No matching receipt within 15 s → TetraVox **deletes the request** (withdrawn, so a host started
   later never acts on a click nobody answered), shows that `<name>` did not answer, and stays open.
7. After an `ok: true` receipt the host waits for the TetraVox process to exit, installs, and
   relaunches its copy (§4).

A receipt that cannot be parsed yet is retried on the next poll, so a torn write costs a poll, not
the request — but write atomically anyway.

### Request schema (v1)

TetraVox writes exactly these fields today. The `version` is what TetraVox's release feed offered
the user; treat the request as **consent**, not an instruction (see §5).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "tetravox:managed-update-request/v1",
  "title": "TetraVox managed update request, protocol 1",
  "type": "object",
  "required": ["protocol", "action", "id", "version", "current"],
  "properties": {
    "protocol": { "const": 1 },
    "action": { "const": "update" },
    "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,100}$" },
    "version": { "type": "string", "description": "the release the user accepted, e.g. 0.7.0" },
    "current": { "type": "string", "description": "the running copy's version, e.g. 0.6.1" }
  }
}
```

Example:

```json
{"protocol":1,"action":"update","id":"9b2f6c1e-4d3a-4f0e-8a51-2c7d9e0b1a34","version":"0.7.0","current":"0.6.1"}
```

`id` is a fresh random value per request (a lowercase UUID today); rely only on the pattern.

### Receipt schema (v1)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "tetravox:managed-update-receipt/v1",
  "title": "TetraVox managed update receipt, protocol 1",
  "type": "object",
  "required": ["protocol", "id", "ok"],
  "properties": {
    "protocol": { "const": 1 },
    "id": { "type": "string", "description": "the request's id, copied exactly" },
    "ok": { "type": "boolean", "description": "true accepts: TetraVox quits so the host can install" },
    "error": { "type": "string", "description": "with ok false: one short plain-text sentence shown to the user" }
  }
}
```

Accept:

```json
{"protocol":1,"id":"9b2f6c1e-4d3a-4f0e-8a51-2c7d9e0b1a34","ok":true}
```

Refuse (TetraVox shows "ExampleHost: No update is available for this platform yet."):

```json
{"protocol":1,"id":"9b2f6c1e-4d3a-4f0e-8a51-2c7d9e0b1a34","ok":false,"error":"No update is available for this platform yet."}
```

### What the host must do

- **Watch** `<path>` while the host runs (polling once a second is plenty; `fs.watchFile` works on
  every platform for a file that does not exist yet). Also check once at start-up: a request may be
  waiting from just before the host started.
- **Validate** the request: `protocol === 1`, `id` matches the pattern, `action === "update"`,
  `version` is a string. A request that is not JSON, not protocol 1 or has a bad `id` gets **no
  receipt** (you cannot address one); an unknown `action` or a version you cannot install gets an
  `ok: false` receipt.
- **Answer within 15 s.** Refuse early, with a reason, rather than accept something you cannot do.
- **After `ok: true`**: wait for the TetraVox process to exit — bound the wait (a minute is
  reasonable) and, if it does not exit, tell the user rather than killing it; then download the
  release **you** choose from **your** trusted source, verify it (checksum, signature, bundle
  identity), replace your copy, and relaunch it with the same environment and flags. Relaunch even
  after a failed install, so the user gets their viewer back, and report the failure in your own UI.

## 4. Minimal host (Node.js)

A sketch; error handling, your own installer and your own UI are yours.

```js
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { watchFile } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const HOST = 'ExampleHost';
const home = '/path/the/host/owns';                     // created by the host, not world-writable
const request = join(home, 'tetravox-update-request.json');
const profile = join(home, 'tetravox-profile');

function launch(executable) {
  return spawn(executable, [`--user-data-dir=${profile}`], {
    env: { ...process.env, TETRAVOX_MANAGED_BY: HOST, TETRAVOX_MANAGED_UPDATE_REQUEST: request },
    detached: true,
    stdio: 'ignore',
  });
}

async function answer(installAndRelaunch) {
  let text;
  try { text = await readFile(request, 'utf8'); } catch { return; }   // nothing waiting
  await rm(request, { force: true });                                  // consume it
  let r;
  try { r = JSON.parse(text); } catch { return; }
  if (r?.protocol !== 1 || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(r.id)) return;
  const receipt = async (body) => {
    await writeFile(`${request}.receipt.tmp`, JSON.stringify({ protocol: 1, id: r.id, ...body }), { mode: 0o600 });
    await rename(`${request}.receipt.tmp`, `${request}.receipt.json`);
  };
  if (r.action !== 'update' || typeof r.version !== 'string') {
    return receipt({ ok: false, error: `${HOST} cannot install that update.` });
  }
  await receipt({ ok: true });
  await installAndRelaunch();   // wait for exit (bounded) → fetch + verify → replace → launch()
}

watchFile(request, { interval: 1000 }, (s) => { if (s.isFile()) void answer(/* … */); });
void answer(/* … */);           // a request left from before start-up
```

## 5. Security notes

- **The request carries no URL, path or command.** It records that the user said yes to a version
  TetraVox saw. The host decides what to install, fetches it from a source it trusts and verifies it
  (checksum pinned from the release, code signature, bundle identifier) — exactly as it would for
  its own first install. Never download or execute something because a request named it.
- **Put the request path in a directory only the host's user can write** (the host's per-user data
  directory; `0700` on POSIX). Anyone who can write there can forge a request (at worst: an
  unwanted update of your own verified release) or a receipt (at worst: a TetraVox that quits).
- The path must be **absolute**; a relative one leaves the copy in "managed, updates off".
- The receipt's `error` is shown as plain text, never HTML. Keep it to one sentence.
- TetraVox never installs anything in managed mode, so it never needs write access to its own
  install directory.

## 6. Platform notes

- **macOS.** Launch by path, never by bundle identifier: every copy has the same identifier
  (`dev.tetravox.viewer`), so LaunchServices file associations (double-clicking a
  `.tetravox.json`) may open *either* copy. `open -a /path/to/Tetravox.app --args
  --user-data-dir=<dir>` targets that bundle, passes the calling process's environment to a new
  instance and delivers `--args` to it; spawning `Tetravox.app/Contents/MacOS/Tetravox` directly also
  works. Unpack the official ZIP, then check the bundle identifier (and the code signature, when
  your release carries one) before the first launch.
- **Linux.** Unpack the `.tar.gz`. Its `chrome-sandbox` is not root-owned setuid in a per-user
  unpack, so launch with `--no-sandbox` (the copy only reads local files). The managed mode table
  above applies whether or not `APPIMAGE` is set.
- **Windows.** Use the portable x64 ZIP and launch `Tetravox.exe`; never the NSIS installer, whose
  registry lookup can uninstall the user's own installation. Wait for the process to exit before
  replacing files — Windows keeps the running executable and `app.asar` locked. Paths are absolute
  Windows paths (`C:\…`).

## Stability and versioning

- **Frozen in v1:** the two environment-variable names and their activation rule (§2), the request
  and receipt fields and meanings (§3), `protocol: 1`, the `<path>.receipt.json` name, the
  atomic-rename write, id matching, the 15-second receipt deadline, and "no receipt withdraws the
  request".
- **Additive changes only within v1.** TetraVox may add optional request fields and optional
  environment variables; a host must ignore request fields it does not know. A host may add receipt
  fields; TetraVox ignores them. A new `action` may appear only as something a v1 host already
  answers correctly — with `ok: false` — so hosts must refuse actions they do not recognise.
- **A breaking change is a new protocol number**, offered only to hosts that opt in through a new,
  optional environment variable. TetraVox keeps speaking v1 to every host that does not opt in, and
  keeps v1 for at least two minor releases after a deprecation is announced in the changelog.
- The contract is pinned by the "managed mode public contract v1" tests in
  `packages/app/src/main/updater.test.ts`, which read the schemas on this page; changing either
  side alone fails CI. Implementation notes live in [Architecture](ARCHITECTURE.md) §12.4.
