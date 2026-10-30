# Tark tools, permissions, and agent workflows

Status: implementation plan only. Saving this document does not authorize implementation.

## Goal

Make tools safer, keep tool output compact, preserve task progress, and enforce clear Agent / Permission / View boundaries. Reuse existing repository patterns and preserve unrelated working-tree changes.

## 1. Todo and plan storage — first priority

- Add `todo` with stable IDs and `pending / in-progress / done` states.
- Bound item text, item count, and total stored size.
- Add `save_plan` for plan text in host-managed session storage outside the repository.
- Dedicated tools own storage paths and formats; agents cannot choose arbitrary destinations or save executable artifacts.
- Restore the active plan and todo state after resume, branching, and compaction.
- Bind user approval to the exact plan revision. Editing the plan invalidates approval.
- The approved plan defines each task's `allowed_paths`. Any scope change requires new user approval before execution; neither parent nor child can expand it automatically.
- The user explicitly chooses **Approve & start code** before `code · write` begins. The agent cannot switch itself.
- Code reads the approved plan and updates its todo progress.
- Phase 1 ships plan-revision approval and per-task `allowed_paths` binding, including rejection of unapproved execution or scope changes. These are foundational controls, not deferred UI work.
- A user-requested repository export is separate from runtime plan storage. This document is such an export.

Reuse the persistence pattern in `packages/coding-agent/examples/extensions/todo.ts`, adapting it to three states and bounded storage. Do not assume a configurable session directory is outside the repository; validate the actual storage location.

## 2. Permission enforcement and bash tiers

| Agent | Permission | Execution access |
| --- | --- | --- |
| ask | read | Validated Safe commands and `run_checks` |
| plan | read | Validated Safe commands and `run_checks` |
| orchestrator | read | `run_checks`; no general bash |
| code | write | Policy-controlled bash |
| debug | write | Policy-controlled bash |
| builder child | scoped write | Sandbox-controlled bash; dependency installation blocked |

Read permission means no project source changes. Dedicated host-managed plan/todo persistence is allowed. Verification may produce temporary output without granting general write permission.

### Command tiers

- **Safe:** validated read-only commands such as `ls`, `git diff`, and `tsc --noEmit` with safe arguments. A command name alone does not establish safety.
- **Normal:** commands such as `npm test` and `npm install` require write permission. Read agents use fixed `run_checks` instead of arbitrary test commands.
- **Dangerous:** commands such as `rm -rf` and force push require explicit user approval for every invocation, in addition to applicable permission and scope checks.
- Approval identifies the exact command and working directory; it is not a blanket permission upgrade.
- Read-permission commands run without a shell: parse input into argv, validate the executable and arguments against a platform-aware allowlist, then execute directly. Block any shell metacharacter rather than interpreting it.
- Prefer built-in `ls` and `find` tools over OS commands. Do not assume Unix command names, executable resolution, or argument semantics work on native Windows.
- Validate flags, wrappers, and command arguments. Unclassifiable commands are blocked in read permission. Write-permission shell execution still requires command-tier checks for chaining, redirects, and substitutions.
- Missing approval in non-interactive execution means blocked, not implicitly approved.
- Default command timeout: **120 seconds**; the hard maximum is **600 seconds**. The host default (`TARK_COMMAND_TIMEOUT_SECONDS`), trusted check configuration (`timeoutSeconds`), and per-call overrides must all be finite, positive, and at most 600 seconds; invalid host configuration is rejected even when an override is supplied. No unlimited timeout or override bypass.
- Timeout and cancellation terminate the process tree, not only the parent shell.
- Disable automatic Agent switching. Only the user changes Agent or Permission; the agent can suggest a change.
- Changing View never changes permissions.
- Before enabling command execution, authenticate the sole RPC client with a random per-process token bootstrapped over its private inherited stdin pipe. Require the token on every subsequent command and extension UI response; reject missing/wrong tokens before input provenance can become `rpc`. There is no public RPC endpoint/socket. Never place the token in argv, environment variables, session entries, responses, or logs. Spawned bash, checks, jobs, and delegated processes inherit neither RPC control variables nor RPC stdin/extra descriptors. Include a real spawned-process negative test that cannot submit `/approve-plan` or answer its approval dialogs.
- Enforce capabilities at execution boundaries, including indirect tool calls, rather than relying only on prompts or tool visibility.

Primary integration points:

- `packages/coding-agent/src/extensions/tark/agents.ts`
- `packages/coding-agent/src/extensions/tark/lib/agents.ts`
- `packages/coding-agent/src/extensions/tark/access-guard.ts`
- `packages/coding-agent/src/extensions/tark/lib/access-policy.ts`
- `packages/coding-agent/src/extensions/tark/ui.ts`

## 3. Fixed `run_checks`

- Accept only a check name: `typecheck | lint | test`.
- Resolve commands from trusted, preconfigured project settings. No agent-supplied command, shell suffix, or arbitrary arguments.
- Check-config files are protected paths, including `package.json` scripts, `tsconfig` files, and ESLint/Vitest configuration. Builders may change them only when the approved plan explicitly names those files; a broad directory scope alone does not authorize them.
- Approved config changes still cannot replace effective trusted check commands automatically. Revalidate the check configuration before executing changed scripts/configuration so verification cannot become a permission bypass.
- If effective check commands change, show the user the old versus new commands and require explicit approval before `run_checks` uses the new commands. File-edit approval does not substitute for command-change approval. Denial or missing approval blocks the changed commands.
- Make the tool available to ask, plan, and orchestrator as well as write agents.
- Return pass/fail, exit status, available test pass/fail counts, and a short error excerpt. Report unknown counts honestly.
- Fixed commands can still write files or execute project code. Use trusted configuration and sandboxing rather than treating command names as proof of safety.
- Phase 2 ships the filesystem sandbox used by `run_checks` on Linux/WSL2, with project source read-only and dedicated temporary outputs/cache writable. Phase 4 reuses this sandbox for builder shell with task-specific `allowed_paths`.
- Native Windows: allow `run_checks` without a sandbox only after explicit one-time per-session user opt-in. Mark every such result `unsandboxed`. Denial, missing consent, or a new session blocks execution until opt-in; this exception grants neither general bash nor builder shell access.
- Elsewhere, when isolation is unavailable, report the limitation clearly and block execution; do not silently execute an unrestricted fallback.
- After every builder task, orchestrator runs typecheck, lint, and tests itself through `run_checks` and inspects the results.
- v1 builders run sequentially in the shared tree. Finish each task's verification before starting the next builder, and pause other agent-owned writes during checks so results describe a stable code state.
- Parallel builders require per-task Git worktrees and are deferred to a later phase.
- Orchestrator never edits source to repair failures; it delegates a focused correction.

## 4. Safe edit and compact tool output

Relevant source files:

- `packages/coding-agent/src/core/tools/read.ts`
- `packages/coding-agent/src/core/tools/edit.ts`
- `packages/coding-agent/src/core/tools/edit-diff.ts`
- `packages/coding-agent/src/core/tools/grep.ts`
- `packages/coding-agent/src/core/tools/bash.ts`
- `packages/coding-agent/src/core/tools/truncate.ts`

### Edit semantics

1. Track the file hash and returned ranges from successful reads. A grep result or outline does not substitute for reading the target content.
2. Before editing, compare the current file to the read version. Reject stale or unread target content and require a new read.
3. Attempt exact matching first. Apply only a unique match by default.
4. Multiple exact matches are an error, not a reason to attempt normalization.
5. If there is no exact match, allow only CRLF/LF and trailing-whitespace normalization. Require a unique normalized match by default.
6. Never auto-apply similarity-based fuzzy matching or smart-quote/Unicode substitutions.
7. Allow multiple non-overlapping matches only with explicit `replace_all`. Reject overlapping occurrences even then.
8. On failure, provide bounded closest-match snippets and line numbers as hints only.
9. Preserve original encoding, BOM, and line endings on write. Reject unsupported encodings rather than silently converting them. For normalized matches, convert the replacement string (`newText` in the current API; `new_str` in this requirement) to the file's line endings and replace only the matched original range. Nothing outside that range changes; do not normalize or rewrite the whole file.
10. Validate all replacements against the original file before writing. Preserve the existing mutation queue and all-or-nothing validation behavior.

Current implementation already checks uniqueness and edit-range overlap, but has broad fuzzy normalization and an occurrence counter that misses overlapping starts. For example, `aa` has two starting positions in `aaa`; the default unique-match path must reject it.

Fresh-read validation must occur inside the mutation boundary, not only in an earlier tool-call hook. A preview read does not count as the agent reading the file.

### Output budgets

- Use separate budgets for source reads versus search/command output, not a single shared default.
- Proposed `read` default: **400 lines / 16 KiB**, whichever is reached first.
- Proposed `grep` / `bash` default: **200 lines / 8 KiB**, whichever is reached first. These values remain proposed; the separate-budget requirement is fixed.
- Compact `read`, `grep`, and `bash` output with shown/omitted counts and a continuation offset or log reference.
- Do not invent an exact remaining count when a grep scan stops early; report unknown or a known lower bound.
- Bound streaming updates and retained logs as well as final output.
- Reuse the existing shared truncation utilities rather than creating a second implementation.

## 5. Checkpoints and strict builders

### Checkpoint / undo

- Record task-owned before/after snapshots before mutations.
- Preserve pre-existing dirty files, staged work, and unrelated concurrent changes.
- One-step undo restores the latest owned change only when the current state still matches the recorded post-change state.
- Intervening changes produce a conflict instead of being overwritten.
- Do not use broad `git reset`, checkout, or stash-based rollback.
- Describe undo coverage honestly: local file rollback cannot reverse remote effects such as a push or arbitrary external command effects.

### Builder restrictions

- Require explicit `allowed_paths` from the approved plan for builder tasks and enforce them in guarded file tools and shell execution. Reject a task whose requested scope differs from its approved scope until the user approves the change.
- Run v1 builders sequentially in the shared tree, including verification between tasks. Do not enable parallel builders until a later phase supplies per-task Git worktrees.
- Support Linux and WSL2 first; treat WSL2 as Linux.
- Sandbox writes to allowed paths, dedicated temporary storage, and dedicated tool cache only. Descendant processes inherit the restrictions.
- Apply execution timeouts.
- If sandboxing is unavailable, block builder shell with a clear error. Keep guarded read/edit/write available and verify through orchestrator `run_checks`.
- Disable nested builder delegation, including indirect access to the subagent tool.
- Block `npm install` in builders. Builders request dependencies from orchestrator, which presents the need to the user rather than installing through its read-only authority.
- After each task, inspect `git diff --name-only`, staged changes, and untracked changes against the task-start baseline. Git diff alone does not cover every relevant change.
- Fail a task that makes out-of-scope changes and revert only changes proven to belong to that task.
- When ownership is ambiguous, stop and report instead of reverting user or parallel-agent work. Prevention through sandboxing is the primary boundary; post-task diff inspection is an additional check.
- Return only a bounded summary: changed files, verification results, and blockers. Explicitly flag changed test files in that summary. Keep full transcripts out of the parent context by default.
- Deleted test files/cases, skipped tests, and focused `.only` tests fail the task unless the approved plan explicitly permits the corresponding change. Check task-owned test changes against the starting baseline; do not blame the task for pre-existing test state.

Extend existing runner and scheduler mechanisms:

- `packages/coding-agent/src/extensions/tark/lib/subagent-runner.ts`
- `packages/coding-agent/src/extensions/tark/lib/subagent-scheduler.ts`

Network control and additional secrets blocking are outside v1 scope. Preserve existing protections; do not claim the filesystem sandbox is a network or credential boundary.

## 6. Background commands and documentation fetching

### Background jobs

- Add start, status, logs, and stop operations using session-owned job IDs.
- Starting a job uses the same command-tier, approval, scope, and sandbox policy as foreground execution.
- Return promptly for long-lived commands such as `npm run dev`.
- Bound logs and support cursor-based incremental reads with omitted-output information.
- Stop the entire process tree; clean up owned jobs on shutdown/session replacement.
- Background execution must not become a way to bypass foreground command restrictions.

### Documentation fetching

- Add a bounded documentation-fetch tool accepting a URL and requested library/version context.
- Return the source URL, retrieval time, and compact content with continuation support.
- Prefer official version-specific documentation when available and explicitly report mismatches or unavailable versions.
- Treat fetched content as untrusted reference data, not executable instructions.
- Version knowledge should come from retrieved evidence rather than assumptions from model training.

## 7. Debug workflow and user-facing names

### Debug

Require the sequence:

1. Reproduce the failure or establish concrete evidence.
2. Add a failing regression test, or document why one is not feasible.
3. Make the smallest justified fix.
4. Run the regression test and relevant verification.

If reproduction is unavailable, report the blocker. If a regression test is not feasible, document the reason, the alternative evidence/checks used, and any unexecuted checks. Do not claim regression-test coverage or successful verification that did not occur. Keep confirmed facts separate from hypotheses. Ship this workflow in phase 2; phase 6 only polishes its UI and adds end-to-end coverage.

### Agent / Permission / View

- Use **Agent** for ask, plan, orchestrator, code, and debug.
- Use **Permission** for read/write capability.
- Use **View** for presentation choices, separate from execution authority.
- Show status such as `code · write` and `plan · read`.
- Update relevant UI text, CLI/help, settings schemas, keybindings, tests, and documentation consistently.
- Ask and plan cannot delegate writes. Orchestrator can delegate only user-authorized builder scopes while remaining unable to edit source itself.

## Acceptance and verification

### Focused tests

- Fresh read required; stale hashes rejected, including changes between preflight and execution.
- Read ranges and truncation cannot authorize editing unseen target content.
- Exact and normalized uniqueness; overlapping occurrences; explicit `replace_all`.
- No similarity-based automatic replacement; bounded error hints.
- BOM, encoding, unchanged bytes, and line-ending preservation. For normalized matches, verify replacement line-ending conversion and byte-for-byte preservation outside the matched range.
- Atomic multi-edit validation and concurrent mutation behavior.
- Independent `read` and `grep`/`bash` budgets, omitted counts, Unicode boundaries, long lines, and incomplete search counts.
- Safe/Normal/Dangerous policy and bypass attempts through shell syntax, flags, wrappers, and indirect tools. Verify read-permission execution uses direct argv spawning, executable/argument allowlists, and rejects all shell metacharacters.
- Per-invocation approval, denial, cancellation, and non-interactive blocking.
- Default timeout is 120 seconds and the hard maximum is 600 seconds; valid configuration/overrides work, invalid or over-hard-max values are rejected, and timeout/cancellation terminate descendants.
- RPC bootstrap pins a per-process client token; subsequent commands and UI responses require authentication. Spawned processes receive no RPC credentials/discovery variables or parent RPC descriptors, cannot submit `/approve-plan`, and cannot answer approval dialogs. Missing/wrong tokens and reauthentication attempts fail closed; credentials never reach session/event output.
- `run_checks` rejects arbitrary commands and reports unavailable counts honestly.
- Native Windows `run_checks` is blocked before session opt-in, allowed after opt-in, marked `unsandboxed` on every result, and blocked again in a new session until new opt-in. No builder shell access follows from this consent. Run these tests on a native Windows CI runner; Linux-only mocks are not sufficient.
- Platform-aware read-command allowlists reject unsupported executable/argument forms; built-in `ls`/`find` remain the preferred cross-platform path.
- Read agents cannot modify project source through check configuration or output paths.
- Builders cannot change protected check-config files unless the approved plan explicitly names them; broad allowed directories are insufficient. Authorized changes cannot silently replace effective trusted check configuration.
- Effective check-command changes show old versus new commands and block execution until explicit user approval; file-edit approval alone is insufficient. Denial or unavailable approval never executes the changed commands.
- Phase-2 Linux/WSL2 checks enforce read-only source and writable dedicated temp/cache through the filesystem sandbox; phase-4 builder shell reuses that sandbox with approved task-specific write scopes.
- Plan/todo size and format limits; outside-repo storage; resume, branch, and compaction behavior.
- Plan revision approval invalidation and user-only Agent/Permission changes.
- Each task's `allowed_paths` matches the approved plan; attempted scope expansion is blocked until new user approval.
- Linux/WSL2 allowed-path enforcement for file tools and shell descendants, symlink/escape attempts, unavailable-sandbox behavior, and blocked installation.
- No nested builder delegation; bounded result summaries explicitly flag changed test files.
- Task-owned test deletions, skips, and `.only` changes fail without explicit approved-plan permission; approved exceptions pass the guard, and pre-existing test state is not attributed to the task.
- v1 builder tasks never overlap in the shared tree, and the next builder waits for the previous task's checks. Parallel builder support remains disabled until per-task Git worktrees ship.
- Post-task staged/unstaged/untracked inspection against a dirty baseline.
- Undo and failed-task rollback preserve unrelated and intervening changes.
- Background log bounds, incremental reads, permission enforcement, and process-tree cleanup.
- Docs version mismatch and unavailable/offline responses using local fixtures.
- Debug workflow evidence, a failing regression test or documented infeasibility with alternative verification, and truthful reporting of missing checks.

### Repository gates

- Use focused tests and faux-provider suite fixtures; no real provider calls or paid tokens.
- Run every added or modified test file and iterate until it passes.
- Reread changed files before completion.
- Run `npm run check` with full output after code changes.
- Run `npm run build` when selected tests need built package output.
- Do not run `npm test` or the full Vitest suite unless separately authorized.
- Preserve existing unrelated changes and do not commit unless requested.

## Phased delivery and PR acceptance

Each phase ships as a separate PR with its own acceptance criteria and focused tests. Do not combine phases into one implementation PR. Each PR must also satisfy the applicable repository gates above.

| Phase / PR | Scope | Acceptance criteria |
| --- | --- | --- |
| 1 | Todo/session-state foundation, plan approval, task-scope binding | Bounded three-state todos and dedicated plan storage work outside the repo; resume, branch, and compaction preserve the correct active state; arbitrary storage paths/artifacts are rejected; approval binds the exact plan revision and each task's `allowed_paths`; unapproved execution/scope changes are blocked and revision changes invalidate approval. |
| 2 | Permission policy, user-only transitions, fixed checks and their filesystem sandbox, debug workflow | Agent permissions are enforced at execution boundaries; platform-aware read commands use allowlisted argv without a shell and prefer built-in ls/find; metacharacters are blocked; dangerous commands require per-invocation approval; the 120-second default and configurable hard-max timeout are enforced and terminate descendants; fixed checks reject arbitrary commands; effective check-command changes show old versus new commands and require user approval before use; Linux/WSL2 checks run in the filesystem sandbox with source read-only and dedicated temp/cache writable; native Windows requires session opt-in, marks results `unsandboxed`, and has native Windows CI coverage; debug requires reproduce, failing regression test or documented infeasibility, minimal fix, and verification. |
| 3 | Safe edits and compact output | Fresh-read and range checks reject stale/unseen content; exact-first and limited-normalization matching enforce uniqueness and explicit `replace_all`; normalized replacements preserve bytes outside their range; separate read versus grep/bash budgets report truncation accurately. |
| 4 | Checkpoint ownership and Linux/WSL2 builder isolation using the phase-2 sandbox | Safe undo preserves unrelated/intervening changes; builder shell reuses the phase-2 filesystem sandbox with phase-1 approved task scopes applied to guarded file tools and shell descendants; scope changes require reapproval; unavailable sandbox blocks builder shell; installs and nested delegation are blocked; check-config changes require explicitly named approved files; summaries flag changed tests, and unauthorized test deletions/skips/.only fail; shared-tree builders execute sequentially with checks between tasks. |
| 5 | Background jobs and docs fetching | Jobs start promptly, obey shared permissions/sandbox rules, expose bounded incremental logs, and stop/clean up descendants; docs include source/version evidence, bounded output, and explicit mismatch/offline errors. |
| 6 | UI polish and end-to-end coverage only | Polish the already-shipped approval/debug/permission UI and make Agent / Permission / View labels and status consistent; end-to-end tests cover approval invalidation, task-scope binding, user-only transitions, debug evidence, and integrated execution boundaries. No foundational approval, scope, or debug enforcement is deferred to this phase. |

Intermediate phases must fail closed where a later phase has not yet supplied the required approval or isolation mechanism. Do not temporarily enable unrestricted builder execution.

### Later phase: parallel builders

- Parallel builders are not part of v1.
- Ship per-task Git worktrees in a separate later PR before enabling parallel builders.
- Acceptance must cover isolated task changes, scope enforcement, integration conflicts, task-owned rollback, and verification of the final integrated state.

No feature implementation or verification has been performed as part of saving this plan.
