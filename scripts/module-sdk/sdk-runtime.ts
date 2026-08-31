/**
 * `@tetravox/module-sdk` — the runtime half of the SDK, and the only file in it that executes.
 *
 * **Zero imports, by construction.** A downloadable module is one ESM file that the renderer loads
 * over `tetravox://module/<id>/<version>/index.js` (ARCHITECTURE.md §13.8). Nothing resolves bare
 * specifiers there — there is no import map, no node_modules and no `script-src` grant for anything
 * else — so a module bundle that still carries `import { createElement } from 'react'` fails at load
 * with a specifier error, not with a diagnosis. The module repo's CI therefore asserts the bundle
 * has **no imports at all**, and this file is what makes that possible: it is *inlined* by the
 * module build (never marked external), and it reaches the host through one global instead.
 *
 * **Why a global rather than an import map or a served URL.** A module's `Panel` renders inside the
 * app's own React tree, so a second React copy is an "invalid hook call", not a size problem. The
 * three ways to hand a downloaded bundle the host's React are an inline `<script type="importmap">`
 * (which needs `script-src 'unsafe-inline'` or a nonce and undoes the policy the module host exists
 * to keep), a rollup `output.paths` rewrite onto a second non-hashed renderer entry (which needs a
 * new `entryFileNames` rule in `electron.vite.config.ts`), and this one — which needs no build
 * configuration at all and leaves `script-src 'self' 'wasm-unsafe-eval' tetravox://module` as the
 * single CSP change. `docs/DECISIONS.md` records the choice and names the rollup rewrite as the
 * fallback if the global ever has to be scoped per module.
 *
 * **The app half is one assignment**, made by the renderer before any module is activated:
 *
 * ```ts
 * globalThis.__tetravoxModuleSdk = {
 *   hostVersion: MODULE_HOST_VERSION,
 *   react,                       // the app's own copy — the whole namespace
 *   ModuleHostError,             // the class, so `instanceof` holds across the boundary
 *   stemOf,                      // `src/modules/manifest-types.ts`, the one definition
 *   contacts,                    // `renderer/src/modules/shared/contacts/**`, as one namespace
 * };
 * ```
 *
 * Every member is a *value the host already owns*. The SDK adds no behaviour of its own: it is a
 * typed doorway, so a module written against it is typechecked against the same declarations the
 * app is built from.
 */

// Type-only, all three — the shim is inlined by every module build and must emit no import at all.
import type * as ReactModule from 'react';
import type * as ContactsKit from './contacts/index';
import type { ModuleHostError as ModuleHostErrorClass } from './host';

/** The host's React, as the module sees it. The app's copy — never a second one. */
type ReactNamespace = typeof ReactModule;

/** What the renderer puts on `globalThis.__tetravoxModuleSdk`. */
export interface TetravoxModuleSdk {
  /** `MODULE_HOST_VERSION` of the running app. A module refuses a host it was not written for. */
  hostVersion: number;
  react: ReactNamespace;
  ModuleHostError: typeof ModuleHostErrorClass;
  stemOf: (name: string) => string;
  contacts: typeof ContactsKit;
}

declare global {
  var __tetravoxModuleSdk: TetravoxModuleSdk | undefined;
}

const sdk: TetravoxModuleSdk | undefined = globalThis.__tetravoxModuleSdk;
if (sdk === undefined) {
  throw new Error(
    'Tetravox SDK: globalThis.__tetravoxModuleSdk is not set. This bundle is not running inside a ' +
      'Tetravox module host — check that the app is at least the core version this SDK was emitted ' +
      'from, and that the bundle was loaded through tetravox://module/.'
  );
}

/**
 * The whole React namespace, for anything the named exports below do not cover.
 *
 * The named ones exist because they are what a panel actually writes, and because a named import is
 * what tree-shaking and a reader both understand.
 */
export const react: ReactNamespace = sdk.react;

export const createElement: ReactNamespace['createElement'] = sdk.react.createElement;
export const useSyncExternalStore: ReactNamespace['useSyncExternalStore'] =
  sdk.react.useSyncExternalStore;
export const useState: ReactNamespace['useState'] = sdk.react.useState;
export const useEffect: ReactNamespace['useEffect'] = sdk.react.useEffect;
export const useMemo: ReactNamespace['useMemo'] = sdk.react.useMemo;
export const useRef: ReactNamespace['useRef'] = sdk.react.useRef;
export const useCallback: ReactNamespace['useCallback'] = sdk.react.useCallback;

/**
 * The host's `ModuleHostError` **class**, not a copy of it.
 *
 * A module throws it and the host catches it; a second class declaration would make every
 * `instanceof` across that boundary false, which is exactly the failure the class exists to prevent.
 */
export const ModuleHostError: TetravoxModuleSdk['ModuleHostError'] = sdk.ModuleHostError;

/** `{stem}` — the one definition (`src/modules/manifest-types.ts`), shared with main. */
export const stemOf: TetravoxModuleSdk['stemOf'] = sdk.stemOf;

/**
 * The `shared/contacts` kit, as one namespace.
 *
 * It stays in core (ARCHITECTURE.md §13.3: "a module's second module is a library, not a fork"), so
 * two contact modules share one implementation of a TSV reader, an editlog and a shaft fit rather
 * than forking it. Reached through the host for the same reason React is: one instance.
 */
export const contacts: TetravoxModuleSdk['contacts'] = sdk.contacts;

/** The host API version this app implements. Compare it with your manifest's `hostApi`. */
export const MODULE_HOST_VERSION: number = sdk.hostVersion;
