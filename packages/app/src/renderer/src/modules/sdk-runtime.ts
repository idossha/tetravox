/**
 * `globalThis.__tetravoxModuleSdk` — the app's half of `@tetravox/module-sdk` (§13.8, 2026-08-30).
 *
 * A downloaded module is **one ESM file with no imports at all**. Nothing resolves a bare specifier
 * under `tetravox://module/…` — there is no import map, no `node_modules`, and `script-src` grants
 * that host and nothing else — so the SDK's runtime shim (`scripts/module-sdk/sdk-runtime.ts`) is
 * *inlined* into every module bundle and reaches the host through one global instead. This file is
 * the other end of that global, and it is the only thing that puts it there.
 *
 * **Five members, and a sixth is a contract change.** The shim's header carries the assignment
 * verbatim, and `scripts/emit-module-sdk.test.mjs` reads `TetravoxModuleSdk` out of the shim and
 * pins the member list — so the two halves, which live in different processes' code and were built
 * in different waves, cannot drift apart unnoticed. Adding a member means editing the shim and its
 * test as well as this file.
 *
 * **Why every member is a value the host already owns.** A module's `Panel` renders inside the app's
 * own React tree (`ModuleSlot.tsx`), so a second React copy is an "invalid hook call", not a size
 * problem; `ModuleHostError` must be the same *class* or every `instanceof` across the boundary is
 * false; `stemOf` must be the same function or a module computes a different `{stem}` from the one
 * main admitted its sibling writes under; and `shared/contacts` stays in core (§13.3, "a module's
 * second module is a library, not a fork") so two contact modules share one TSV reader. The SDK adds
 * no behaviour of its own — it is a typed doorway onto this object.
 *
 * **It is installed at renderer boot, before the first commit** (`main.tsx`), not lazily inside
 * `activateModule`: a module's bundle executes its top level the moment `import()` resolves it, and
 * the shim reads the global at *that* moment, not when `activate` is called.
 */

import * as react from 'react';
import { MODULE_HOST_VERSION, stemOf } from '../../../modules/manifest-types';
import { ModuleHostError } from './host';
// The `shared/contacts` kit, module by module. `scripts/emit-module-sdk.mjs` generates the SDK's
// `types/contacts/index.ts` as `export * from './<name>'` over exactly these files, so the runtime
// object below and the declarations a module is typechecked against are the same shape. A name
// exported by two of them would be an ambiguous `export *` in the generated barrel and a silent
// last-wins here, which is why the kit has no duplicate export.
import * as editlog from './shared/contacts/editlog';
import * as geometry from './shared/contacts/geometry';
import * as layer from './shared/contacts/layer';
import * as model from './shared/contacts/model';
import * as palette from './shared/contacts/palette';
import * as snap from './shared/contacts/snap';
import * as tsv from './shared/contacts/tsv';

/** The `shared/contacts` kit as one namespace — the SDK's `contacts`. */
export type ContactsKit = typeof editlog &
  typeof geometry &
  typeof layer &
  typeof model &
  typeof palette &
  typeof snap &
  typeof tsv;

/**
 * What the renderer puts on `globalThis.__tetravoxModuleSdk`.
 *
 * Declared here rather than imported from the SDK because the SDK is *generated from this tree* and
 * lives outside every tsconfig the app compiles — the same reason `preload/index.ts` re-declares
 * `main/module-store.ts`'s types instead of importing them. `scripts/module-sdk/sdk-runtime.ts`'s
 * `TetravoxModuleSdk` is the other declaration, and its test is what keeps the two identical.
 */
export interface TetravoxModuleSdk {
  /** `MODULE_HOST_VERSION` of the running app. A module refuses a host it was not written for. */
  hostVersion: number;
  react: typeof react;
  ModuleHostError: typeof ModuleHostError;
  stemOf: typeof stemOf;
  contacts: ContactsKit;
}

declare global {
  var __tetravoxModuleSdk: TetravoxModuleSdk | undefined;
}

/** The kit, flattened exactly as the generated barrel's `export *` chain flattens it. */
export function contactsKit(): ContactsKit {
  return { ...editlog, ...geometry, ...layer, ...model, ...palette, ...snap, ...tsv };
}

/** The object the shim reads. Pure, so a test can assert its shape without touching `globalThis`. */
export function moduleSdk(): TetravoxModuleSdk {
  return {
    hostVersion: MODULE_HOST_VERSION,
    react,
    ModuleHostError,
    stemOf,
    contacts: contactsKit(),
  };
}

/**
 * Install the global. Idempotent, and called once from `main.tsx` before the first render.
 *
 * It is deliberately **not** a capability: everything on it is already reachable from any renderer
 * script, because a renderer script is first-party code by construction. What admits a *downloaded*
 * module is the `tetravox://module` map, which only main fills and only after consent — this object
 * is what such a module then finds when it looks for the host's React.
 */
export function installModuleSdk(): TetravoxModuleSdk {
  const sdk = moduleSdk();
  globalThis.__tetravoxModuleSdk = sdk;
  return sdk;
}
