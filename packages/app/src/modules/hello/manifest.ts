/**
 * `tetravox.hello` — the fixture module (§13.4).
 *
 * It exists so the extension surface has a consumer in every build: the slot, the switcher, the
 * status cell, the key fallthrough, the confirm dialog, the scene block and the job envelope are all
 * exercised by a module that ships, rather than by a mock a test builds and the product never runs.
 *
 * It is **compiled into every build and listed only behind `?modules=hello`** — the `?engine=mock`
 * seam in `engine/factory.ts` — because `pnpm e2e` drives the production bundle, so a fixture that
 * was excluded from it would prove nothing about the bundle users get.
 *
 * Data only: this file imports its types and nothing else.
 */

import type { ModuleManifest } from '../manifest-types';

export const helloManifest: ModuleManifest = {
  id: 'tetravox.hello',
  title: 'Hello',
  version: '1.0.0',
  hostApi: 1,
  // The `## Modules` section of docs/USER_GUIDE.md — the fixture documents the *surface*, since it
  // has no domain of its own. The docs-guard job checks the heading exists and is in GUIDE_PAGES.
  docs: 'Modules',
  activation: ['onToggle'],
  commands: [
    { id: 'ping', title: 'Ping', key: 'g' },
    // `when: 'selection'` is §13.5's exception, and the fixture is where it is tested: with no point
    // selection the key resolves to nothing at all, so the pool key stays harmless.
    { id: 'select-demo', title: 'Report the selection', key: 's', when: 'selection' },
  ],
  // §13.6's envelope: `{ "type": "module", "module": "tetravox.hello", "op": "echo",
  // "args": { "text": "…" } }`. P5 validates and runs it against exactly this declaration.
  operations: [{ id: 'echo', args: { text: 'string' } }],
  // The counter the panel increments lives here, so save → load → reopen is a real round trip.
  sceneBlock: { version: 1 },
};
