# Phase 2: pending work

Status: **verification incomplete; not ready for sign-off or commit**.

## 1. Prove real Linux/WSL2 filesystem isolation

- [ ] Run all six strict tests in `packages/coding-agent/test/tark-sandbox.test.ts` on a host that permits bubblewrap isolation.
- [ ] Verify reviewed `run_checks` commands execute inside real isolation.
- [ ] Verify project writes outside `allowed_paths` and writes outside the project are blocked.
- [ ] Verify existing and temporary symlink escapes are blocked.
- [ ] Verify child processes cannot write project source.
- [ ] Verify dedicated temporary/home/cache locations are writable without exposing RPC environment variables or the parent PID.
- [ ] Verify execution is blocked when the sandbox backend is unavailable, without an unrestricted fallback.

Local result: bubblewrap 0.12.0 is installed, but the host denies mount setup:

```text
bwrap: Failed to make / slave: Permission denied
```

**Six strict tests failed; none were skipped.** The unavailable-backend test cannot start its outer sandbox either. These failures do not establish successful isolation.

Phase 2 provides no writable project scope, including plan-approved paths. Writable builder mounts remain Phase 4 work.

## 2. Obtain native Windows CI results

- [ ] Run the `windows-latest` job defined in `.github/workflows/tark-permissions.yml`.
- [ ] Verify explicit per-session consent and fresh consent after reset/new session.
- [ ] Verify every opted-in result is labeled `unsandboxed`.
- [ ] Verify changed check commands require renewed approval.
- [ ] Verify Windows check opt-in does not grant shell-isolation capabilities.
- [ ] Verify the RPC authentication, environment-filtering, and spawned-process approval-forgery tests pass on Windows.

No native Windows run has been established. The Linux focused run skips this Windows-only test:

`requires native Windows session consent, labels every result, resets consent and reviews command changes`

## 3. Complete fresh fixed-check verification

- [ ] Have the user configure and approve trusted `.tark/checks.json` commands.
- [ ] Run the configured typecheck, lint, and focused tests through `run_checks`.
- [ ] Record final results, keeping strict sandbox and native Windows results separate from policy-only tests.
- [ ] Resolve all verification blockers before declaring Phase 2 complete.

The fresh `run_checks` attempt was blocked because `.tark/checks.json` is absent. Do not bypass this with arbitrary shell commands.

## Already implemented, not pending

- RPC client-token authentication for commands and dialog responses.
- Real spawned-process `/approve-plan` and approval-dialog forgery regression tests.
- Spawn-boundary RPC environment filtering.
- Historical test-count reconciliation with selected file lists.
- The 600-second hard maximum documented in `TARK-TOOLS-PERMISSIONS-PLAN.md`.

Previous focused verification: **206 passed, 1 Windows-only skipped across 17 files**. Earlier `npm run check` and `npm run build` passed. These results do not override the six strict sandbox failures or missing Windows proof.

Detailed evidence and historical file lists: [Phase 2 verification](packages/coding-agent/tark/docs/phase-2-verification.md).

This documentation task does not authorize source changes, check-configuration changes, commits, or pushes.
