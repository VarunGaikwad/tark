---
name: tdd
description: Use for test-first feature or bug work, explicit red-green-refactor requests, or when the user asks to design tests before implementation. Do not use merely because a change needs ordinary regression coverage.
---

# Test-Driven Development

Use short vertical slices: one observable behavior, one failing test, the minimum implementation, then the next behavior.

1. Read relevant project terminology, ADRs, and existing test conventions.
2. Choose the highest practical public seam. Confirm the seam with the user only when it is consequential or ambiguous; otherwise state the choice and proceed.
3. Write a test that fails for the requested behavior and derives expected values from the spec or a known-good example.
4. Add only enough implementation to make that test pass.
5. Repeat for the next behavior. Refactor separately once behavior is covered.

Tests should verify externally observable behavior, survive internal refactors, and avoid tautological expectations. Mock only true system boundaries; prefer real local implementations or test databases when practical.

Do not write a broad speculative test suite before learning from the first slice. Run focused tests after each slice and the relevant wider gate before completion.
