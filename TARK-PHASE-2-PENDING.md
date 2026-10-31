# Phase 2: pending work

Status: **verification incomplete; not ready for sign-off or commit**.

## Resume here next session

Next goal: publish all four diagnostic/probe-fix files, then inspect a native Windows CI run containing them. Phase 2 is not complete. This handoff records progress; a new agent must check the saved plan and current permissions before editing.

Snapshot at handoff:

- Branch: `update`; HEAD and local `origin/update`: `affa168ff89bc198ddcbbfb33bf3336068bea911`. That commit contains only the earlier bash-test diagnostics.
- Not yet committed: the Git Bash probe fix, RPC diagnostics, and updates to both verification documents. Some files have both staged and unstaged changes; preserve both.
- `.tark/checks.json` is also staged and contains a machine-specific Node path. Do not include it in the diagnostic commit below.
- Latest CI: [41166370537](https://github.com/VarunGaikwad/tark/actions/runs/41166370537). Ubuntu native and strict-isolation steps passed; Windows reported 32 passed, 2 failed, 1 skipped. The new probe fix and RPC diagnostics were not in that run.
- Local typecheck/lint passed after the probe fix. Local focused tests remain 151 passed, 8 failed, 1 skipped: six nested-namespace denials and two fixture-cwd failures. Full `npm run check` has not been established for the latest edits.
- No agent commit or push was performed. This harness blocks project Git writes; the agent's isolated `gh` environment also lacks authentication.

### User terminal steps

1. From the repository root, run `npm run check`. If it fails, stop and share the output.
2. Commit these four files with this **single-line** command. `--only` includes their working-tree changes without committing other staged files:

```sh
git commit --only -m "fix(coding-agent): avoid Git Bash probe rewriting" -- packages/coding-agent/test/rpc-environment.test.ts packages/coding-agent/test/suite/tark-rpc-auth.test.ts TARK-PHASE-2-PENDING.md packages/coding-agent/tark/docs/phase-2-verification.md
```

3. Run `git show --stat --oneline HEAD`. Confirm the commit includes all four paths, especially `test/suite/tark-rpc-auth.test.ts`; the previous commit included only one file. If anything is missing or the commit failed, stop before pushing.
4. Run `git push origin update`.
5. Find the new run:

```sh
gh run list --repo VarunGaikwad/tark --workflow "Tark permissions" --branch update --limit 1
```

After completion, share its head SHA/job metadata and failed-step log using `gh run view` as before. Do not share tokens. The new RPC diagnostics should name the failing phase; the previous timeout was at the approval-editor wait, not the malformed-JSON assertion. Confirm the Git Bash probe fix on Windows before declaring it verified. Any required product-source fix needs an amended approved plan; keep security assertions and strict isolation unchanged.

Detailed evidence remains in the sections below and [phase-2-verification.md](packages/coding-agent/tark/docs/phase-2-verification.md).

## 1. Prove real Linux/WSL2 filesystem isolation

- [ ] Run all six strict tests in `packages/coding-agent/test/tark-sandbox.test.ts` on a host that permits bubblewrap isolation.
- [ ] Verify reviewed `run_checks` commands execute inside real isolation.
- [ ] Verify project writes outside `allowed_paths` and writes outside the project are blocked.
- [ ] Verify existing and temporary symlink escapes are blocked.
- [ ] Verify child processes cannot write project source.
- [ ] Verify dedicated temporary/home/cache locations are writable without exposing RPC environment variables or the parent PID.
- [ ] Verify execution is blocked when the sandbox backend is unavailable, without an unrestricted fallback.

Historical strict-run result: bubblewrap 0.12.0 was installed, but that host denied mount setup:

```text
bwrap: Failed to make / slave: Permission denied
```

**Six strict tests failed; none were skipped.** The unavailable-backend test could not start its outer sandbox either. These historical failures do not establish successful isolation.

Fresh fixed typecheck and lint commands finish with `sandboxed` results. After the user added `--configLoader runner --no-cache`, the local focused test run reached collection: **151 passed, 8 failed, 1 skipped** across seven files. All six strict tests failed because bubblewrap could not create a nested namespace. This local run does not establish the strict isolation guarantees.

The user supplied job metadata for [CI run 41166370537](https://github.com/VarunGaikwad/tark/actions/runs/41166370537), with head SHA `affa168ff89bc198ddcbbfb33bf3336068bea911` (matching local HEAD). Both Ubuntu native permission tests and the strict real bubblewrap step passed. Individual strict-test counts and the checkout merge-commit relationship have not been supplied. Local nested-sandbox failures are separate from that successful CI step.

Phase 2 provides no writable project scope, including plan-approved paths. Writable builder mounts remain Phase 4 work.

## 2. Obtain native Windows CI results

- [x] Run the `windows-latest` job defined in `.github/workflows/tark-permissions.yml` (latest run 41166370537; failed).
- [ ] Verify explicit per-session consent and fresh consent after reset/new session.
- [ ] Verify every opted-in result is labeled `unsandboxed`.
- [ ] Verify changed check commands require renewed approval.
- [ ] Verify Windows check opt-in does not grant shell-isolation capabilities.
- [ ] Verify the RPC authentication, environment-filtering, and spawned-process approval-forgery tests pass on Windows.

Latest native Windows CI result: **32 passed, 2 failed, 1 skipped** across four files in run 41166370537. Its failures are:

- `test/rpc-environment.test.ts:79`: Git Bash/MSYS converted the JavaScript regex literal into `C:/Program Files/Git/RPC|...`, causing a Node syntax error before environment inspection. The test probe now uses an equivalent `RegExp` constructor instead of a slash-delimited literal; native Windows confirmation of this fix is pending.
- `test/suite/tark-rpc-auth.test.ts:100`: timed out waiting for the approval editor, after the malformed-JSON assertion passed. Git inspection confirms the run's head commit contains only bash-test diagnostics; the RPC diagnostic changes are still staged locally and did not reach this run. Its cause remains unconfirmed.

Both failures must be resolved and Windows rerun; do not skip or weaken these security tests. The earlier Linux focused run skips this Windows-only test:

`requires native Windows session consent, labels every result, resets consent and reviews command changes`

## 3. Complete fresh fixed-check verification

- [x] Have the user configure and approve trusted `.tark/checks.json` commands.
- [x] Run configured typecheck and lint through `run_checks` (both passed, sandboxed).
- [ ] Pass configured focused tests through `run_checks` (latest run: 151 passed, 8 failed, 1 skipped).
- [ ] Record final results, keeping strict sandbox and native Windows results separate from policy-only tests.
- [ ] Resolve all verification blockers before declaring Phase 2 complete.

Fresh verification at source revision `839871037b340d2d4ec172297d259f8893e4c73a` used the user-created `.tark/checks.json`:

- `run_checks(typecheck)`: passed, exit 0, sandboxed (`tsc --noEmit`).
- `run_checks(lint)`: passed, exit 0, sandboxed; 1993 files checked, no fixes applied.
- Initial `run_checks(test)`: startup failed before collection; Vite could not create `packages/coding-agent/node_modules/.vite-temp` while loading `vitest.config.ts` (`ENOENT`).
- Retry after the user added `--configLoader runner --no-cache`: Vitest reported **151 passed, 8 failed, 1 skipped** (five files passed, two failed). Six failures were strict sandbox tests: nested bubblewrap reported `No permissions to create a new namespace`. Two RPC subprocess tests failed because their fixture resolved relative to the repository-root process working directory, not `packages/coding-agent`. The tool propagated an isolation error containing the test output rather than a structured check result; these counts come from the Vitest summary.

The loader change resolved the configuration-write blocker without granting project writes. The RPC test invocation still needs the package working directory; `--root` alone does not change it. The six strict tests require a host/execution context that permits their nested isolation. Do not bypass isolation to make them pass. These typecheck/lint commands are not the complete `npm run check` script; no fresh full repository check or build was run.

## Windows diagnostic follow-up

Approved diagnostic follow-up adds:

- Resolved shell configuration and a bounded, redacted probe-output excerpt to the bash exit-code assertion.
- Named RPC wait phases, stdin write completion/error counts, child exit/signal status, stream byte counts, and at most 12 allowlisted response summaries. RPC diagnostics expose no raw records, stdout/stderr text, or tokens. Security assertions and timeout limits remain unchanged.

After the initial diagnostic test changes, sandboxed typecheck and lint passed again (1993 files checked, no fixes). The configured seven-file test command still reported **151 passed, 8 failed, 1 skipped**: six nested-namespace failures and two repository-root fixture-path failures. The changed environment test file passed; the changed RPC test file could not progress past fixture startup. Its new diagnostic reported bootstrap exit 1, one completed stdin write, zero protocol records, and no credential content.

A native Windows rerun containing these diagnostics is needed before choosing a behavior fix. No product source was changed. The attempt to record reproduction through `debug_workflow` was blocked because that tool requires the debug Agent; no debug evidence was recorded by that call.

## Latest probe fix and CI handoff

The native Windows log establishes a test-command construction defect, not an environment-filtering failure. The probe now constructs the same case-insensitive regex without slash-delimited source, avoiding Git Bash argument path conversion. Environment seeds, real launches, and security assertions are unchanged.

After the probe fix, sandboxed typecheck and lint passed (1993 files checked, no fixes). The same focused command reported **151 passed, 8 failed, 1 skipped**, with the environment test file passing and the known local namespace/fixture-cwd blockers unchanged. No native Windows run contains the new probe yet.

Commit `affa168f` includes only `test/rpc-environment.test.ts` diagnostics. Before the next CI run, the new probe fix, staged RPC diagnostics, and both verification documents must all be included in the user's next commit. The agent has not staged, committed, or pushed anything.

## Already implemented, not pending

- RPC client-token authentication for commands and dialog responses.
- Real spawned-process `/approve-plan` and approval-dialog forgery regression tests.
- Spawn-boundary RPC environment filtering.
- Historical test-count reconciliation with selected file lists.
- The 600-second hard maximum documented in `TARK-TOOLS-PERMISSIONS-PLAN.md`.

Previous focused verification: **206 passed, 1 Windows-only skipped across 17 files**. Earlier `npm run check` and `npm run build` passed. These historical results do not override local strict sandbox failures or the two failing Windows CI tests. The latest Ubuntu strict CI step passed; individual strict-case counts are still not recorded here.

Detailed evidence and historical file lists: [Phase 2 verification](packages/coding-agent/tark/docs/phase-2-verification.md).

The approved follow-up permits diagnostics and evidence-driven test-harness fixes only in the two named test files, plus updates to the verification documents. Product-source changes, check-configuration changes, commits, and pushes remain outside the agent's authorization.
