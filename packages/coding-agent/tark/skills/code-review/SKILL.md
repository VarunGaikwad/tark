---
name: code-review
description: Review a diff, branch, pull request, or repository. Default to correctness, repository standards, and any supplied spec; use simplicity mode when asked about complexity or over-engineering; use repository-audit mode when asked to review the whole codebase. Do not use for implementation or architecture design.
---

# Code Review

Review evidence, not intentions. Report actionable findings with file and line references. Do not modify code unless the user asks.

## Select scope and mode

- **Diff review:** use the user-supplied ref, PR diff, working tree, or merge-base. If no scope is available, ask for one.
- **Correctness mode:** find behavior, error handling, compatibility, security, and test gaps.
- **Standards/spec mode:** compare the diff with repository instructions and a user-supplied, linked, or discoverable spec. If no spec exists, say so; do not require an issue tracker or setup workflow.
- **Simplicity mode:** find dead code, speculative abstraction, unnecessary dependencies, hand-rolled platform/standard-library behavior, and avoidable indirection.
- **Repository-audit mode:** inspect the whole repository for the highest-value architecture or simplification findings. Keep correctness and security out of scope unless requested.

## Process

1. Establish the exact files and baseline. Read relevant repository standards, tests, and spec material.
2. Inspect the changed behavior and its callers, not only individual lines.
3. Separate confirmed defects from risks, judgement calls, and missing context. A repository convention overrides a generic heuristic.
4. In simplicity mode, use one of: `delete`, `stdlib`, `native`, `yagni`, or `shrink`. Do not flag requested validation, error handling, or meaningful regression tests as bloat.
5. Prioritize findings by impact. Omit praise, restatement, and speculative nits.

## Output

Use this concise format unless the user requests a narrative:

```text
path:line[-line] [severity] problem. Consequence. Concrete fix.
```

Use `bug`, `risk`, `nit`, or `question` as the severity. For a clean review, state what scope and modes were checked. Summarize findings by mode without inventing a global pass/fail verdict.
