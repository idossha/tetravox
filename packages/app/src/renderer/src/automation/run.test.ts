/**
 * The two decisions a `{ "type": "module" }` action needs before it reaches a module (§13.6).
 *
 * The rest of `run.ts` is asserted where it can be: the frame arithmetic in `frames.test.ts`, the
 * presets in `presets.test.ts`, and the whole executor — a real launch, a real load, a real module —
 * in `e2e/module-job.spec.ts`, because a `JobRunner` needs a window's worth of engine and a
 * filesystem to say anything at all. These two are pure, so they are asserted here, where a case
 * costs a millisecond rather than a process.
 */

import { describe, expect, it } from 'vitest';
import { moduleOperationArgs, moduleSearchFor, modulesNamedBy } from './run';
import type { ModuleManifest } from '../../../modules/manifest-types';

describe('modulesNamedBy', () => {
  it('lists each module once, in the order the job first names it', () => {
    expect(
      modulesNamedBy([
        { type: 'screenshot', out: 'a.png' },
        { type: 'module', module: 'tetravox.seeg', op: 'load' },
        { type: 'module', module: 'tetravox.hello', op: 'echo' },
        { type: 'module', module: 'tetravox.seeg', op: 'save' },
      ])
    ).toEqual(['tetravox.seeg', 'tetravox.hello']);
  });

  it('is empty for a job with no module action, which is every job written before this', () => {
    expect(modulesNamedBy([{ type: 'set', cursor: [0, 0, 0] }])).toEqual([]);
  });
});

describe('moduleSearchFor', () => {
  it('offers the modules the job names to a window whose URL asks for none', () => {
    // A `--job` window's URL carries no query at all, and main has already accepted the action
    // against `MANIFESTS` — so a fixture the job names has to be reachable here.
    expect(moduleSearchFor('', ['tetravox.hello'])).toBe('?modules=tetravox.hello');
  });

  it('keeps the launch query it was given, including an existing `modules`', () => {
    // `?engine=mock` still has to mean what it meant: this adds a module, it does not relaunch.
    expect(moduleSearchFor('?engine=mock&mockStepMs=0', ['tetravox.seeg'])).toBe(
      '?engine=mock&mockStepMs=0&modules=tetravox.seeg'
    );
    expect(moduleSearchFor('?modules=hello', ['tetravox.seeg'])).toBe(
      '?modules=hello%2Ctetravox.seeg'
    );
  });
});

describe('moduleOperationArgs', () => {
  it('passes an operation`s own arguments through untouched', () => {
    const { args, files } = moduleOperationArgs(
      { type: 'module', module: 'tetravox.hello', op: 'echo', args: { text: 'hi' } },
      '/out'
    );
    expect(args).toEqual({ text: 'hi' });
    expect(files).toEqual([]);
  });

  it('survives an operation this build does not know, rather than dropping the arguments', () => {
    // Main validated the action, so this cannot happen in a real run; if it ever did, handing the
    // module the arguments it was given is a better failure than handing it none.
    const { args, files } = moduleOperationArgs(
      { type: 'module', module: 'tetravox.nope', op: 'x', args: { a: 1 } },
      '/out'
    );
    expect(args).toEqual({ a: 1 });
    expect(files).toEqual([]);
  });

  it('leaves `args` absent as an empty bag rather than undefined', () => {
    expect(
      moduleOperationArgs({ type: 'module', module: 'tetravox.hello', op: 'echo' }, '/out')
    ).toEqual({ args: {}, files: [] });
  });

  it('does not mutate the action it was given', () => {
    const action = { type: 'module', module: 'tetravox.hello', op: 'echo', args: { text: 'a' } };
    moduleOperationArgs(action, '/out');
    expect(action.args).toEqual({ text: 'a' });
  });
});

/**
 * `out` needs a manifest that declares one, and no shipped module does yet — so the lookup takes
 * the manifest list as a defaulted argument, the seam `main/job.ts`'s validator takes for the same
 * reason. The cases above run against the real barrel, so the default binding is proven too.
 */
describe('moduleOperationArgs — an `out` argument', () => {
  const FIXTURES: readonly ModuleManifest[] = [
    {
      id: 'test.saver',
      title: 'Saves things',
      version: '1.0.0',
      hostApi: 1,
      docs: 'Modules',
      activation: ['onToggle'],
      commands: [],
      operations: [{ id: 'save', args: { out: 'out', pretty: 'boolean?' } }],
    },
  ];

  const save = (out: string): Record<string, unknown> => ({
    type: 'module',
    module: 'test.saver',
    op: 'save',
    args: { out, pretty: true },
  });

  it('resolves the name under --out and reports it as the action`s file', () => {
    // The module is handed a path it can write; the *result file* records the relative name, which
    // is what every other action's `files` are.
    expect(moduleOperationArgs(save('contacts.tsv'), '/figures', FIXTURES)).toEqual({
      args: { out: '/figures/contacts.tsv', pretty: true },
      files: ['contacts.tsv'],
    });
  });

  it('keeps a nested name intact — `outName` already refused anything that escapes', () => {
    expect(moduleOperationArgs(save('tables/contacts.tsv'), '/figures', FIXTURES)).toEqual({
      args: { out: '/figures/tables/contacts.tsv', pretty: true },
      files: ['tables/contacts.tsv'],
    });
  });
});
