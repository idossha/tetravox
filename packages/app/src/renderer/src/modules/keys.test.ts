/**
 * The module key resolver (§13.5) and the sibling instantiator (§13.1), both pure.
 *
 * The resolver's interesting cases are all *refusals*: a text field, a platform modifier, a key
 * outside the pool, a `when` gate that is not satisfied. A resolver that answered any of those would
 * put a module's key in front of the native menu, or fire a destructive command with nothing
 * selected — §13.5's exception is "may act on an **explicit** selection", and it is the gate that
 * makes the word explicit true.
 *
 * The instantiator's are all *rejections*: an escape out of the subject directory, a token the
 * anchor's name never captured, a substitution that is not a filename.
 */

import { describe, expect, it } from 'vitest';
import type { ModuleManifest, ModuleSibling } from '../../../modules/manifest-types';
import { moduleChordLabel, resolveModuleKey } from './keys';
import { instantiateSiblings, stemOf } from './siblings';

const MANIFEST: ModuleManifest = {
  id: 'tetravox.probe',
  title: 'Probe',
  version: '0.1.0',
  hostApi: 1,
  docs: 'Modules',
  activation: ['onToggle'],
  commands: [
    { id: 'add', title: 'Add', key: 'a' },
    { id: 'snap', title: 'Snap', key: 's' },
    { id: 'snap-all', title: 'Snap all', key: 's', shift: true },
    { id: 'drop', title: 'Delete', key: 'Delete', when: 'selection' },
    { id: 'nudge', title: 'Nudge', key: 'n', when: 'toolArmed' },
    { id: 'quiet', title: 'No key at all' },
  ],
};

function press(key: string, over: Partial<Parameters<typeof resolveModuleKey>[1]> = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    editable: false,
    ...over,
  };
}

const ANY = { hasSelection: true, toolArmed: true };
const NONE = { hasSelection: false, toolArmed: false };

describe('resolveModuleKey', () => {
  it('runs the command bound to a pool key', () => {
    expect(resolveModuleKey(MANIFEST, press('a'), NONE)?.id).toBe('add');
  });

  it('tells a shifted binding from its unshifted twin', () => {
    expect(resolveModuleKey(MANIFEST, press('s'), NONE)?.id).toBe('snap');
    // The browser reports the shifted character, which is why the resolver normalises the case.
    expect(resolveModuleKey(MANIFEST, press('S', { shiftKey: true }), NONE)?.id).toBe('snap-all');
  });

  it('is suppressed in a text field, like every other binding', () => {
    expect(resolveModuleKey(MANIFEST, press('a', { editable: true }), ANY)).toBeNull();
  });

  it('never claims a chord with a platform modifier or Alt', () => {
    expect(resolveModuleKey(MANIFEST, press('a', { ctrlKey: true }), ANY)).toBeNull();
    expect(resolveModuleKey(MANIFEST, press('a', { metaKey: true }), ANY)).toBeNull();
    expect(resolveModuleKey(MANIFEST, press('a', { altKey: true }), ANY)).toBeNull();
  });

  it('never claims a key outside the §13.5 pool, Escape included', () => {
    for (const key of ['Escape', ' ', 'r', 'x', 'c', 'm', '1', '+', '-', 'ArrowUp']) {
      expect(resolveModuleKey(MANIFEST, press(key), ANY), key).toBeNull();
    }
  });

  it('gates `when: "selection"` on there actually being one', () => {
    expect(resolveModuleKey(MANIFEST, press('Delete'), NONE)).toBeNull();
    expect(resolveModuleKey(MANIFEST, press('Delete'), ANY)?.id).toBe('drop');
  });

  it('gates `when: "toolArmed"` on the tool being armed', () => {
    expect(resolveModuleKey(MANIFEST, press('n'), NONE)).toBeNull();
    expect(
      resolveModuleKey(MANIFEST, press('n'), { hasSelection: false, toolArmed: true })?.id
    ).toBe('nudge');
  });

  it('ignores a command with no key at all', () => {
    expect(MANIFEST.commands.some((c) => c.id === 'quiet' && c.key === undefined)).toBe(true);
    expect(resolveModuleKey(MANIFEST, press('q'), ANY)).toBeNull();
  });

  it('labels a chord the way the help sheet writes it', () => {
    expect(moduleChordLabel({ id: 'a', title: 'A', key: 'a' })).toBe('a');
    expect(moduleChordLabel({ id: 'b', title: 'B', key: 's', shift: true })).toBe('⇧S');
    expect(moduleChordLabel({ id: 'c', title: 'C', key: 'Backspace' })).toBe('⌫');
    expect(moduleChordLabel({ id: 'd', title: 'D' })).toBe('');
  });
});

describe('instantiateSiblings', () => {
  const spec: ModuleSibling = {
    from: '^(?<sub>sub-[A-Za-z0-9]+)_(?:acq-[A-Za-z0-9]+_)?space-(?<space>[A-Za-z0-9]+)_ct\\.nii\\.gz$',
    candidates: [
      '../ieeg/{sub}_space-{space}_electrodes.tsv',
      '../ieeg/{sub}_space-{space}_coordsystem.json',
      '{stem}_editlog.json',
    ],
  };
  const anchor = '/data/sub-P076/ct/sub-P076_acq-bone_space-T1w_ct.nii.gz';

  it('substitutes named groups and resolves against the anchor’s directory', () => {
    const out = instantiateSiblings(spec, anchor);
    expect(out.map((c) => c.path)).toEqual([
      '/data/sub-P076/ieeg/sub-P076_space-T1w_electrodes.tsv',
      '/data/sub-P076/ieeg/sub-P076_space-T1w_coordsystem.json',
      '/data/sub-P076/ct/sub-P076_acq-bone_space-T1w_ct_editlog.json',
    ]);
    // The keys `onSibling` receives are the manifest's own templates, verbatim.
    expect(out[0]?.template).toBe('../ieeg/{sub}_space-{space}_electrodes.tsv');
  });

  it('answers nothing for an anchor the pattern does not match', () => {
    expect(instantiateSiblings(spec, '/data/T1.nii.gz')).toEqual([]);
  });

  it('drops a candidate that ascends more than three directories', () => {
    const out = instantiateSiblings(
      { from: spec.from, candidates: ['../../../../etc/passwd', '{stem}.json'] },
      anchor
    );
    expect(out.map((c) => c.template)).toEqual(['{stem}.json']);
  });

  it('drops an absolute candidate', () => {
    const out = instantiateSiblings(
      { from: spec.from, candidates: ['/etc/passwd', 'C:\\Windows\\hosts', '{stem}.json'] },
      anchor
    );
    expect(out.map((c) => c.template)).toEqual(['{stem}.json']);
  });

  it('drops a candidate naming a token the match never captured', () => {
    const out = instantiateSiblings(
      { from: spec.from, candidates: ['{session}/x.tsv', '{stem}.json'] },
      anchor
    );
    expect(out.map((c) => c.template)).toEqual(['{stem}.json']);
  });

  it('drops a substitution that is not a filename', () => {
    // A greedy group can capture anything the basename contains; the segment rule is what keeps a
    // captured oddity out of a path that is about to be handed to `allowPath`.
    const greedy: ModuleSibling = {
      from: '^(?<sub>.+)_ct\\.nii\\.gz$',
      candidates: ['{sub}.tsv'],
    };
    expect(instantiateSiblings(greedy, '/data/sub 01_ct.nii.gz')).toEqual([]);
    expect(instantiateSiblings(greedy, '/data/sub-01_ct.nii.gz').map((c) => c.path)).toEqual([
      '/data/sub-01.tsv',
    ]);
  });

  it('refuses a pattern that is not a regexp rather than throwing', () => {
    expect(instantiateSiblings({ from: '(', candidates: ['{stem}.json'] }, anchor)).toEqual([]);
  });

  it('takes one suffix for `{stem}`, and two off a compressed volume', () => {
    expect(stemOf('sub-01_ct.nii.gz')).toBe('sub-01_ct');
    expect(stemOf('sub-01_electrodes.tsv')).toBe('sub-01_electrodes');
    expect(stemOf('no-extension')).toBe('no-extension');
  });

  /**
   * The renderer half of the one `{stem}` (`src/modules/manifest-types.ts`).
   *
   * `main/module-io.ts` admits `{stem}_editlog.json` beside the file a module saves; this is what
   * the module *asks* for. While the two were separate functions they agreed on `.tsv` and
   * `.nii.gz` and parted over a dotted name — main admitted `sub-P076_electrodes.v2_editlog.json`,
   * the module instantiated `sub-P076_electrodes_editlog.json`, and the editlog write was then
   * refused by the write list the save had just filled. `module-io.test.ts` pins the admission
   * side; this pins the instantiation side, on the same name.
   */
  it('instantiates a dotted anchor’s `{stem}` the way main admits it', () => {
    const dotted: ModuleSibling = {
      from: '^(?<sub>sub-[A-Za-z0-9]+)_electrodes\\.v2\\.tsv$',
      candidates: ['{stem}_editlog.json'],
    };
    expect(
      instantiateSiblings(dotted, '/data/sub-P076/ieeg/sub-P076_electrodes.v2.tsv').map(
        (c) => c.path
      )
    ).toEqual(['/data/sub-P076/ieeg/sub-P076_electrodes.v2_editlog.json']);
  });
});
