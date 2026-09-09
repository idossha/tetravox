/**
 * One version for the whole tree (`docs/RELEASING.md` §embed).
 *
 * The embed carries the *repository* version, not a version of its own, because the tarball
 * `pack.mjs` writes is named from `packages/embed/package.json` and that name is what a host
 * downloads off a Release page. A second number would mean an asset called
 * `tetravox-embed-0.4.0.tgz` hanging under a Release called `v0.3.11`, which is exactly the
 * reconciliation a host should never have to do — and it is what this branch shipped for a few days.
 *
 * `scripts/release.sh` bumps all six package.jsons together and reads them back, so this test does
 * not restate that; it fails when someone edits one of the two by hand.
 */

import { describe, expect, it } from 'vitest';
import embedPkg from '../package.json' with { type: 'json' };
import rootPkg from '../../../package.json' with { type: 'json' };

describe('the embed version', () => {
  it('is the repository version', () => {
    expect(embedPkg.version).toBe(rootPkg.version);
  });

  it('is what names the tarball a host installs', () => {
    // `pack.mjs`'s `const name = \`tetravox-embed-${version}\``, asserted here rather than by
    // running tar: the string is the contract with every host that resolves an asset by name.
    expect(`tetravox-embed-${embedPkg.version}.tgz`).toBe(`tetravox-embed-${rootPkg.version}.tgz`);
  });
});
