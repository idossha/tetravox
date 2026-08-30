"""Typed wrappers for the operations a **module** declares (ARCHITECTURE §13.6).

`Job.module(module_id, op, **args)` can run any operation of any module, and it is deliberately
literal: the argument names it sends are the manifest's, because the manifest is the schema the app
validates against. That leaves camelCase in a Python script and no help at all with an argument a
module spells one particular way.

These wrappers are where a module's vocabulary is written down once, in Python's: snake_case
parameters, a real signature per operation, and the handful of checks worth making before an app
launch costs a second. They are **data only** — nothing here imports or inspects the module, which
is TypeScript compiled into the app — so a wrapper is as installable on a machine with no Tetravox
as the rest of this client is.

    from tetravox import Job
    from tetravox.modules import seeg

Each function takes the job first and returns it, so a script reads in the order the app runs it.
"""

from . import seeg

__all__ = ["seeg"]
