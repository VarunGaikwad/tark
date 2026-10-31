---
name: codebase-design
description: "Design or improve module and service architecture: interfaces, ownership, seams, dependencies, testability, domain vocabulary, and ADR-worthy decisions. Also use for an explicit architecture audit or deepening review. Do not use for implementation, generic code review, or requirement interviews."
---

# Codebase Design

Design modules that give callers useful behavior through a small, understandable interface while keeping ownership and verification local.

## Core ideas

- A **module** may be a function, package, component, service, or vertical slice.
- Its **interface** includes types plus invariants, errors, ordering, configuration, and performance facts callers need.
- A **seam** is where behavior can vary without changing callers. Add one only for a real variation, typically production and test adapters.
- **Depth** is leverage: useful behavior behind an interface simpler than the implementation it hides.
- The interface is normally the highest-value test surface.

Use this vocabulary when it clarifies a decision; do not police ordinary engineering language.

## Design workflow

1. Read the relevant code, tests, project terminology, and existing decisions. Separate observed constraints from assumptions.
2. Identify ownership, callers, data flow, invariants, and the change pressure motivating the design.
3. Prefer a small interface with clear responsibility. Apply the deletion test: if removing a module merely removes indirection, collapse it; if complexity would spread across callers, it earns its place.
4. For external dependencies, inject an adapter only when a real boundary varies. Keep internal testing seams private when possible.
5. Test behavior through the interface rather than internal collaboration. Replace obsolete shallow-module tests when a higher seam makes them redundant.
6. Record domain terms only when they are project-specific and contested. Record an ADR only for a hard-to-reverse, non-obvious trade-off with real alternatives.

## Architecture-audit mode

When explicitly asked to audit architecture:

1. Scope the review to a named subsystem or recent change hotspots.
2. Identify a small ranked set of concrete ownership, interface, coupling, or testability problems.
3. For each, state current friction, evidence, proposed seam or consolidation, expected leverage/locality, risks, and the smallest next experiment.
4. Do not require an HTML report, subagents, or a refactor proposal before the user chooses a candidate.

## Completion

Present the recommended design, alternatives only where they are materially different, invariants, test strategy, migration/compatibility implications, and unresolved decisions.
