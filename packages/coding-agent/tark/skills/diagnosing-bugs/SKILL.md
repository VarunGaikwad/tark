---
name: diagnosing-bugs
description: Diagnose unknown bugs, regressions, intermittent failures, slow paths, unexpected results, or server errors before changing code. Also use for a known-cause small fix when the user wants a narrow patch with regression proof. Do not use for new feature implementation.
---

# Diagnose and Patch Bugs

Use the lightest path that establishes enough evidence for the request. Redact secrets from commands, logs, traces, and captured artifacts.

## Choose a path

- **Unknown cause, intermittent failure, or performance regression:** investigate first.
- **Known cause and small requested fix:** use the narrow-patch path.
- **New behavior rather than incorrect behavior:** use `lean-build`.

## Investigation path

1. State the observed symptom separately from possible causes. Read relevant project context, ADRs, callers, tests, and failure output.
2. Build the strongest practical feedback loop: an existing failing test, focused new test, CLI fixture, HTTP request, browser automation, trace replay, timing harness, or bisection. Prefer a fast, deterministic signal that exercises the reported symptom.
3. If a tight repro is unavailable, gather the strongest available evidence and state the blocker. Do not present an inferred cause as confirmed.
4. Minimize a reproducible case when doing so will materially reduce the hypothesis space.
5. Rank plausible, falsifiable mechanisms. Test the cheapest discriminating probe first; change one variable at a time.
6. Fix the responsible mechanism, not a symptom at one caller. Add a regression test at the highest seam that reproduces the real failure when such a seam exists.
7. Re-run the original feedback loop, focused regression proof, and nearest affected check. Remove temporary instrumentation and report evidence, cause, fix, and remaining uncertainty.

For performance work, establish a comparable baseline and measure the affected path; do not substitute log volume for a performance measurement.

## Known-cause narrow-patch path

1. Confirm the reported cause against the affected code and callers.
2. Change the narrowest layer that owns the incorrect behavior. Preserve unrelated behavior, user changes, and public contracts.
3. Avoid cleanup, renaming, abstractions, and unrelated tests.
4. Add or update the smallest relevant regression proof when economical; otherwise state the evidence that substitutes for it.
5. Run the focused proof plus the nearest affected gate. Stop when the requested behavior is fixed.

## Completion

Report the observed symptom, evidence, confirmed or suspected cause, proof run, and any unresolved limitation. Do not claim diagnosis certainty without supporting evidence.
