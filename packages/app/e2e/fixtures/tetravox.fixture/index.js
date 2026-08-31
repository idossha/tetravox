/**
 * `tetravox.fixture` — a downloadable module, hand-built the way a real one is bundled.
 *
 * This is the *emitted artefact*, not source: it is what `rollup -c` produces for a module repository
 * that follows `scripts/module-sdk/README.md`, and it is checked in rather than built because
 * `extensions.spec.ts` has to install something and no module repository exists yet.
 *
 * Three properties are the whole point, and each one is asserted somewhere:
 *
 *  1. **Zero imports.** No `import`, no `export … from`. Nothing resolves a bare specifier under
 *     `tetravox://module/…` — there is no import map and no `node_modules` — so a bundle that still
 *     carried `import { createElement } from 'react'` would fail at load with a specifier error. The
 *     module repository's CI asserts this with five lines; `extensions.spec.ts` asserts it here.
 *  2. **The SDK shim is inlined, not external.** The block below is
 *     `scripts/module-sdk/sdk-runtime.ts` compiled down to what it is at runtime: one read of
 *     `globalThis.__tetravoxModuleSdk`, which the renderer sets at boot
 *     (`renderer/src/modules/sdk-runtime.ts`). That is how a downloaded module gets the **host's**
 *     React — a second copy would be an "invalid hook call" the first time this panel rendered.
 *  3. **It uses the shared contacts kit through the SDK**, which is what makes `contacts` a real
 *     member of the doorway rather than a declaration nothing exercises. `paletteColor` is the
 *     cheapest honest consumer: a pure function with a value the spec can read off the DOM.
 *
 * It does nothing useful, exactly like `tetravox.hello` — what it does is *arrive from outside the
 * build* and still work.
 */

// -- the inlined @tetravox/module-sdk shim ---------------------------------------------------------
const sdk = globalThis.__tetravoxModuleSdk;
if (sdk === undefined) {
  throw new Error(
    'Tetravox SDK: globalThis.__tetravoxModuleSdk is not set. This bundle is not running inside a ' +
      'Tetravox module host.'
  );
}
const createElement = sdk.react.createElement;
const contacts = sdk.contacts;
const MODULE_HOST_VERSION = sdk.hostVersion;

// -- the module ------------------------------------------------------------------------------------

const SWATCHES = 3;

function FixturePanel() {
  return createElement(
    'div',
    { 'data-testid': 'fixture-panel' },
    createElement(
      'p',
      { 'data-testid': 'fixture-host-version' },
      `host API ${String(MODULE_HOST_VERSION)}`
    ),
    createElement(
      'ul',
      { 'data-testid': 'fixture-swatches' },
      ...Array.from({ length: SWATCHES }, (_unused, index) =>
        createElement(
          'li',
          { key: String(index), 'data-testid': `fixture-swatch-${String(index)}` },
          contacts.cssColor(contacts.paletteColor(index))
        )
      )
    )
  );
}

export function activate(host) {
  host.ui.status('fixture');
  return {
    Panel: FixturePanel,
    runCommand(id) {
      if (id === 'ping') {
        host.ui.toast('info', 'fixture ping');
        return;
      }
      host.ui.toast('warn', `fixture has no command "${id}"`);
    },
    dirty: () => false,
    dispose() {
      host.ui.status(null);
    },
  };
}
