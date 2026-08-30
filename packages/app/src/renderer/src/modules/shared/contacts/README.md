# `shared/contacts` — the generic contact-set library

A **contact set** is a list of named 3D positions grouped into electrodes, leads or grids, read from
a table and written back to one. `tetravox.seeg` is the first module built on it; a `tetravox.dbs`
or a `tetravox.ecog` is meant to be the second and the third, and this directory exists so that the
second one is a geometry file and a panel rather than a fork.

`docs/ARCHITECTURE.md` §13 is the contract for modules; this is the note that says where the seam
between *any* contact editor and *this* kind of hardware is drawn, and why it is drawn there.

## What lives here (hardware-independent)

| File | What it owns |
|---|---|
| `model.ts` | `ContactSet` / `Contact` / `Group`, identity (`id`), provenance (`original`), `status`, name padding, group inference from a name |
| `tsv.ts` | the tolerant reader (delimiter, BOM, aliases, `R`/`A`/`S`, ragged rows, Slicer `.fcsv`) and the canonical BIDS writer, including Python-`repr` float formatting |
| `editlog.ts` | the `<stem>_editlog.json` schema, its counts and its per-contact diff |
| `geometry.ts` | PCA line fit (Jacobi), line RMS, spacing CV, median pitch, projection, even re-spacing, ordering along the line |
| `palette.ts` | the twelve-colour group palette |
| `layer.ts` | `ContactSet` ⇄ `PointsLayer`, the shaft polylines, the CT display preset, and the §13.2 rebuild-from-the-layer degradation path |
| `snap.ts` | scoping a snap over an injected `peakCentroid`, and applying its result |

Everything here is a **pure function of data**. Nothing in this directory imports the host, touches
React, or knows which module is using it — `snap.ts` takes a `PeakFn` rather than a `ModuleHost` for
exactly that reason. That is what lets each file be unit-tested against numpy-generated expectations
with no engine at all (`packages/app/src/renderer/src/modules/shared/contacts/*.test.ts` and
`modules/seeg-fixtures.test.ts`).

## What deliberately does **not** live here

Anything that is a fact about a *kind of hardware*:

* **which end is contact 1.** An sEEG shaft is numbered from the deepest contact, and the rule that
  decides which end that is (`modules/seeg/shaft.ts#tipEnd`) is a heuristic about a head. A DBS lead
  is numbered from the tip too, but the tip is known from the trajectory the surgeon planned; an
  ECoG grid is not numbered along a line at all.
* **re-fitting.** `refitShaft` — fit a line, project, re-space at the median gap, relabel — is right
  for a linear depth electrode and wrong for a 4×8 grid, whose fit is a plane and whose re-spacing is
  two pitches.
* **the contact template.** Pitch, contact count and diameter come from a manufacturer's catalogue.
* **file naming and BIDS siblings.** `sub-<id>_acq-bone_space-T1w_ct.nii.gz` beside
  `sub-<id>_space-T1w_electrodes.tsv` is the `seegprep` derivative layout, so the sibling patterns
  live in the sEEG module's manifest (`packages/app/src/modules/seeg/manifest.ts`).

## Adding a second contact module

1. A manifest under `packages/app/src/modules/<name>/` and a directory under
   `renderer/src/modules/<name>/`, per §13.7 — the ordinary module checklist.
2. Import `../shared/contacts/*` for the model, the reader, the writer, the editlog, the palette and
   the layer bridge. None of it needs changing; if it does, the change belongs here only when it is
   true of *every* contact set, and otherwise in your own directory.
3. Supply your geometry: a file like `seeg/shaft.ts` exporting the operations your hardware has.
   `geometry.ts`'s line primitives are there if your contacts are collinear.
4. Supply your panel. `seeg/Panel.tsx` is the worked example; it is chrome only, like every §8 panel,
   and every control on it is one command that a job file can also reach through `runOperation`.

The one thing to keep true: **a panel action and an operation are the same function**. §13.6's
"there is no automation-only code path" is what makes a module scriptable, and it is a property of
how the module is written, not of anything this library can enforce.
