/**
 * argv → the files to open (`main/cli.ts`, §8: `tetravox file1.nii.gz mesh.msh`).
 *
 * Two things this has to get right, and both were bugs before they were tests: a switch's **value** is
 * not a file, and an absolute path is not necessarily a *normalised* one.
 */

import { describe, expect, it } from 'vitest';
import { collectCliPaths } from './cli';

const APP = '/repo/packages/app';

describe('collectCliPaths', () => {
  it('takes the paths and drops argv[0]', () => {
    expect(collectCliPaths(['electron', '/data/T1.nii.gz', '/data/e.msh'], APP, '/cwd')).toEqual([
      '/data/T1.nii.gz',
      '/data/e.msh',
    ]);
  });

  it('resolves a relative path against the cwd', () => {
    expect(collectCliPaths(['electron', 'T1.nii.gz'], APP, '/cwd')).toEqual(['/cwd/T1.nii.gz']);
  });

  it('drops switches, `.`, and the app path itself', () => {
    expect(
      collectCliPaths(['electron', '.', APP, '--enable-foo', '/data/a.nii'], APP, '/cwd')
    ).toEqual(['/data/a.nii']);
  });

  it('normalises an absolute path before comparing it with the app path', () => {
    // `electron /repo/python/../packages/app` is how a `TETRAVOX_APP_ARGS` launch spells the app
    // directory. Electron's own `getAppPath()` is normalised, so an un-normalised comparison missed —
    // and the app directory was then opened as a dataset, surfacing as a 404 from the loader with
    // nothing to connect it to argv.
    expect(collectCliPaths(['electron', '/repo/python/../packages/app'], APP, '/cwd')).toEqual([]);
    expect(collectCliPaths(['electron', '/data/./sub/../T1.nii.gz'], APP, '/cwd')).toEqual([
      '/data/T1.nii.gz',
    ]);
  });

  it('does not mistake a switch’s value for a file', () => {
    // `--job` and `--out` are dropped for starting with `-`; their values are not, and `job.json`
    // was being opened as a dataset on top of running the job.
    expect(
      collectCliPaths(
        ['Tetravox', '--job', '/j/job.json', '--out', '/j/frames', '/data/a.nii'],
        APP,
        '/cwd'
      )
    ).toEqual(['/data/a.nii']);
  });

  it('leaves the `--switch=value` form alone, since it is one argument', () => {
    expect(
      collectCliPaths(['Tetravox', '--job=/j/job.json', '--out=/j/frames'], APP, '/cwd')
    ).toEqual([]);
  });
});
