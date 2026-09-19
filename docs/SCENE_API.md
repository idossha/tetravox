# Native scene API

External applications can load `.tetravox.json` files and save the current edited view without embedding
TetraVox. Callers choose locations and naming; TetraVox uses its normal scene loader and serializer.
The app package advertises support with `sceneApiProtocol: 1`.

## Requests

Create a private temporary directory and a JSON file inside it (0700 directory / 0600 file on POSIX;
current-user-only ACL on Windows). Invoke the native executable with `--scene-request=/absolute/request.json`.
The existing instance handles it, or a new one starts. Use a fresh file and a random 32-hex `id` per request.

Load a scene:

```json
{"protocol":1,"id":"0123456789abcdef0123456789abcdef","action":"open-scene","path":"/analysis/source.tetravox.json"}
```

Save the current live view, including edits:

```json
{"protocol":1,"id":"abcdef0123456789abcdef0123456789","action":"save-scene","path":"/analysis/views/edited.tetravox.json","expectedScenePath":"/analysis/source.tetravox.json"}
```

`expectedScenePath` is optional: omit it to save whichever scene is currently open, including one opened
manually. Loading through this API first is not required. `overwrite` defaults to false; pass true to
replace an existing regular output file atomically. Saving is an export: it does not change the current
attachment or native Save/Save As defaults. The caller creates the output directory before requesting a save.
Paths must be absolute; symlink output targets are rejected. Ordinary scene-loading guards still apply.

## Completion

Wait for `<request file>.receipt.json`, then validate its `protocol`, `id`, `ok` and `path`:

```json
{"protocol":1,"id":"abcdef0123456789abcdef0123456789","ok":true,"path":"/analysis/views/edited.tetravox.json"}
```

A failure receipt has `ok:false` and an `error` message. A successful process launch alone is not a scene
completion. Clean up the private request directory after receiving the reply. Bound the wait in the caller;
invalid/private-file checks may refuse a request without writing a receipt. Requests are limited to 16 KiB
and must be read within 60 seconds. Renderer replies time out after 25 seconds. A timeout is not permission
to overwrite or automatically repeat an action that may still be completing.

The transport is local and has no listening port. Native updates remain TetraVox's responsibility.
See [architecture](ARCHITECTURE.md) and [testing](TESTING.md) for the implementation contract and checks.
