---
name: lean-build
description: Implement a new feature, product slice, integration, or work described by a ticket or spec. Use when acceptance criteria, scope control, repository reuse, and a focused proof matter. Do not use for unknown bug diagnosis or behavior-preserving refactors.
---

# Lean Build

Deliver the smallest coherent end-to-end outcome that satisfies the requested acceptance criteria.

## Work

1. Derive observable acceptance criteria, explicit non-goals, and the required proof from the request and repository. Ask only for decisions the codebase cannot answer.
2. Trace the entry point and the layers that own invariants. Reuse an existing seam, type, helper, or pattern when it fits.
3. Prefer this order: omit unnecessary work; reuse repository code; use the standard library; use platform features; use an installed dependency; then add the smallest owned code.
4. Build a coherent vertical slice across the responsible layers. Refactor only when the direct change would duplicate behavior, obscure ownership, or weaken correctness.
5. Do not add providers, configuration, extensibility, dependencies, or polish unless acceptance or lifecycle ownership requires them. State any material trade-off.
6. Run focused checks while working and the relevant final gate. Use `tdd` only when the user requests test-first work or a red/green loop.
7. Stop when acceptance passes. Do not commit, run a review, or expand scope unless requested.

## Completion

Report what changed, the proof run, and only material omissions with the condition that would justify them later.
