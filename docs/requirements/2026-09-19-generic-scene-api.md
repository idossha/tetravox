# Generic scene API requirements

This refines the native integration in architecture §5/§8 and supersedes the TI-specific PR proposal.
Behavior is checked with temporary-file tests, controller tests and hidden Electron tests.
These maintainer requirements take precedence over the previous integration design.

> Instead, we should just expand the API, the surface for other programs like the TA toolbox to be able to have more flexible handling of scene saving and scene loading

## R1 — Let callers load and save scenes without application-specific policy

Accept caller-selected scene paths, save the live viewer without requiring a previous API load, and return
completion/errors. Keep native Save/Save As behavior unchanged. Callers own directories, naming and project
conventions. An optional expected attached path protects callers from saving a different scene; overwrite
requires an explicit option.

* Gate test: generic folders unrelated to any project layout load/save successfully; saved edits match
  authored values, default saves leave existing files byte-identical, explicit overwrite replaces them,
  expected-path mismatch refuses a save, and native menu behavior retains its existing controller tests.
