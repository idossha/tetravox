/**
 * `main/surface-spaces.ts` — which four files an fsaverage read-out needs, and every way there is
 * for one of them to be absent (directed task 8).
 *
 * Real directories in a temp tree rather than a mocked `fs`: the whole module is `existsSync` and
 * `statSync`, so a mock would only assert that the mock was called. The files are empty — nothing
 * here reads a surface, it returns paths for the workers to fetch (§5 rule 3).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverSurfaceSpaces, hemisphereOf, subjectSphereFor } from './surface-spaces';

let root: string;
let m2mSurfaces: string;
let subjects: string;
let fsavgSurf: string;

function touch(path: string): void {
  writeFileSync(path, '');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tvx-surface-spaces-'));
  m2mSurfaces = join(root, 'm2m_ernie', 'surfaces');
  subjects = join(root, 'freesurfer', 'subjects');
  fsavgSurf = join(subjects, 'fsaverage', 'surf');
  mkdirSync(m2mSurfaces, { recursive: true });
  mkdirSync(fsavgSurf, { recursive: true });
  touch(join(m2mSurfaces, 'lh.central.gii'));
  touch(join(m2mSurfaces, 'lh.sphere.reg.gii'));
  touch(join(fsavgSurf, 'lh.sphere'));
  touch(join(fsavgSurf, 'lh.pial'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('hemisphereOf', () => {
  it('reads the hemisphere off the file name, which is the only place it is written', () => {
    // A SimNIBS GIfTI pointset carries no `AnatomicalStructurePrimary`, so the prefix is it.
    expect(hemisphereOf('/a/b/lh.central.gii')).toBe('lh');
    expect(hemisphereOf('/a/b/rh.pial')).toBe('rh');
    expect(hemisphereOf('/a/b/LH.Central.gii')).toBe('lh');
  });

  it('is null for a file that declares none — a head model has no hemisphere', () => {
    expect(hemisphereOf('/a/b/ernie.msh')).toBeNull();
    expect(hemisphereOf('/a/b/lh_central.gii')).toBeNull();
    expect(hemisphereOf('/a/b/left.gii')).toBeNull();
  });
});

describe('subjectSphereFor', () => {
  it('finds SimNIBS’s `lh.sphere.reg.gii` beside the surface', () => {
    expect(subjectSphereFor(join(m2mSurfaces, 'lh.central.gii'), 'lh')).toBe(
      join(m2mSurfaces, 'lh.sphere.reg.gii')
    );
  });

  it('also finds FreeSurfer’s extensionless `lh.sphere.reg` — the reader sniffs either', () => {
    rmSync(join(m2mSurfaces, 'lh.sphere.reg.gii'));
    touch(join(m2mSurfaces, 'lh.sphere.reg'));
    expect(subjectSphereFor(join(m2mSurfaces, 'lh.central.gii'), 'lh')).toBe(
      join(m2mSurfaces, 'lh.sphere.reg')
    );
  });

  it('is null for the other hemisphere, which is not the same registration', () => {
    expect(subjectSphereFor(join(m2mSurfaces, 'lh.central.gii'), 'rh')).toBeNull();
  });
});

describe('discoverSurfaceSpaces', () => {
  const surface = (): string => join(m2mSurfaces, 'lh.central.gii');

  it('finds all four files and names the target it will quote', () => {
    const found = discoverSurfaceSpaces(surface(), subjects);
    expect(found).not.toBeNull();
    expect(found?.hemisphere).toBe('lh');
    expect(found?.subjectSphere).toBe(join(m2mSurfaces, 'lh.sphere.reg.gii'));
    expect(found?.fsavgSphere).toBe(join(fsavgSurf, 'lh.sphere'));
    expect(found?.fsavgSurface).toBe(join(fsavgSurf, 'lh.pial'));
    // The label the info panel prints, so a reader knows which surface the coordinate is on.
    expect(found?.targetName).toBe('fsaverage lh.pial');
  });

  it('accepts an fsaverage subject directly, not only the subjects directory above it', () => {
    const found = discoverSurfaceSpaces(surface(), join(subjects, 'fsaverage'));
    expect(found?.fsavgSphere).toBe(join(fsavgSurf, 'lh.sphere'));
  });

  it('falls back to `lh.white` when there is no pial, and says so', () => {
    rmSync(join(fsavgSurf, 'lh.pial'));
    touch(join(fsavgSurf, 'lh.white'));
    const found = discoverSurfaceSpaces(surface(), subjects);
    expect(found?.fsavgSurface).toBe(join(fsavgSurf, 'lh.white'));
    expect(found?.targetName).toBe('fsaverage lh.white');
  });

  it('still answers with the sphere alone when no fsaverage surface is there', () => {
    // The vertex index is the useful half; the coordinate is the nicety. Losing the second must not
    // lose the first.
    rmSync(join(fsavgSurf, 'lh.pial'));
    const found = discoverSurfaceSpaces(surface(), subjects);
    expect(found).not.toBeNull();
    expect(found?.fsavgSurface).toBeUndefined();
    expect(found?.targetName).toBe('fsaverage lh.sphere');
  });

  it.each([
    ['the setting is unset', (): string => ''],
    ['the subjects directory has no fsaverage', (): string => root],
  ])('is null when %s', (_name, dir) => {
    expect(discoverSurfaceSpaces(surface(), dir())).toBeNull();
  });

  it('is null when the surface declares no hemisphere', () => {
    const mesh = join(root, 'm2m_ernie', 'ernie.msh');
    touch(mesh);
    expect(discoverSurfaceSpaces(mesh, subjects)).toBeNull();
  });

  it('is null when the subject has no sphere.reg — nothing to register through', () => {
    rmSync(join(m2mSurfaces, 'lh.sphere.reg.gii'));
    expect(discoverSurfaceSpaces(surface(), subjects)).toBeNull();
  });

  it('is null when fsaverage has no sphere for that hemisphere', () => {
    touch(join(m2mSurfaces, 'rh.central.gii'));
    touch(join(m2mSurfaces, 'rh.sphere.reg.gii'));
    expect(discoverSurfaceSpaces(join(m2mSurfaces, 'rh.central.gii'), subjects)).toBeNull();
  });

  it('is null for the sphere.reg itself — it would map to its own vertices', () => {
    expect(discoverSurfaceSpaces(join(m2mSurfaces, 'lh.sphere.reg.gii'), subjects)).toBeNull();
  });
});
