# Phase 2 verification and remaining blockers

Status: **not ready to commit/sign off**. RPC authentication and focused checks
pass. Real Linux filesystem-isolation success and native Windows execution have
not been established on this host. No commit or remote CI run was performed.

## RPC approval fix

- `src/modes/rpc/rpc-auth.ts`: private-stdio client bootstrap and constant-time
  token validation for every later command and dialog response; no reauthentication.
- `src/modes/rpc/rpc-mode.ts`: authenticate before input becomes `rpc` or a pending
  dialog is resolved; malformed-record diagnostics never quote the credential.
- `src/modes/rpc/rpc-client.ts`: random per-process token kept in memory, automatic
  bootstrap and authenticated commands/dialog replies. No token in argv/env.
- `src/utils/rpc-environment.ts`: strip RPC/IPC, Node channel and socket-activation
  variables, including explicit environment overrides. Used by core exec, shell
  environment/backend, shared process spawning, RPC-client spawning and Tark argv
  execution. Delegation retains its existing runtime-environment allowlist.
- `test/suite/tark-rpc-auth.test.ts`: real faux-provider RPC process and real
  attacker subprocess. The test deliberately relays attacker output into the
  parent's actual RPC stdin, giving it more access than normal tools. Forged
  `/approve-plan`, editor replies and approval selections are rejected; genuine
  authenticated review succeeds. Child RPC environment is empty, stdin is EOF,
  and protocol/session output contains no token.

There is no RPC network listener/socket. Bootstrap trusts the sole parent's
inherited stdin capability. This is not protection against privileged debugging
or arbitrary same-user memory inspection. Background jobs are still Phase 5;
the shared execution helpers are protected, not a claim that a jobs tool shipped.

## Real sandbox tests

`test/tark-sandbox.test.ts` contains these strict Linux/WSL2 tests:

1. `runs reviewed run_checks configuration inside real isolation`
2. `blocks project writes outside allowed_paths and writes outside the project`
3. `blocks existing and temporary symlink escapes`
4. `blocks child-process source writes`
5. `allows dedicated temporary/home/cache outputs but exposes no RPC environment or parent PID`
6. `blocks execution when bubblewrap is actually hidden, without an unrestricted fallback`

They use real processes/mounts, no sandbox mocks, and never pass by catching an
unavailable sandbox. On Linux they fail rather than skip if isolation cannot start.
Phase 2 checks have **no writable project scope**: even plan-approved paths are
read-only. Writable builder `allowed_paths` mounts remain Phase 4 work.

Installed the official Debian bubblewrap **0.12.0** binary in `~/.local/bin/bwrap`
using the authenticated APT package download; no package lifecycle scripts ran.
The user is unprivileged, sudo/Docker/Podman are absent, and this host denies
bubblewrap's required mount setup:

```text
bwrap: Failed to make / slave: Permission denied
```

Latest strict run: **6 failed, 0 skipped**. Tests 1–5 fail before the isolated
command starts. Test 6 cannot start its outer sandbox to hide the inner backend.
These results do **not** prove successful write/symlink/descendant isolation.
A capable Linux/WSL2 host or CI is required before sign-off.

Reproduce from `packages/coding-agent`:

```sh
TARK_REQUIRE_SANDBOX=1 node ../../node_modules/vitest/dist/cli.js --run test/tark-sandbox.test.ts --reporter=verbose
```

The earlier test in `test/tark-command-policy.test.ts` did not skip or mock the
sandbox: with bubblewrap missing it passed the **fail-closed unavailable-backend
branch only**. It is now named `never executes an unrestricted fallback when the
real sandbox backend is unusable`. That test still passes against the real kernel
startup failure; it is not the strict isolation success proof.

Policy-only tests in `test/suite/tark-workflow.test.ts` mock `executeSafeGit` or
`executeReadOnlySandbox` to exercise authorization and command-change consent.
Those tests must not be presented as filesystem-isolation proof.

## Windows CI

`.github/workflows/tark-permissions.yml` defines a native `windows-latest` job
alongside Ubuntu. It installs dependencies with scripts disabled, builds, then
runs the command-policy, RPC-auth, environment and real RPC-subprocess tests.
Ubuntu additionally installs bubblewrap, enables the runner's user-namespace
policy, and runs the strict sandbox file as a separate failing gate.

Triggers: PR creation/update, pushes to `main`, and `workflow_dispatch` after the
workflow exists remotely. The file is currently uncommitted, so **no Windows run
has happened**. A local Linux run cannot replace this gate.

The one Windows-only test skipped in the Linux focused run is:

`requires native Windows session consent, labels every result, resets consent and reviews command changes`

It checks denial before consent, `unsandboxed` on every result, fresh consent for
a new session/reset, command-change approval, and no shell-isolation access after
Windows opt-in. Strict Linux tests are not part of the Windows command.

## Test-count reconciliation

Counts below come from actual tool-result summaries, not estimates. Historical
209/155 records were recovered by extracting only test commands/counts from the
same project's session records; no credentials or raw transcript were exported.
Every set lists full paths relative to `packages/coding-agent`.

### File sets

**A — historical 209 run (6 files)**

- `test/tark-workflow-state.test.ts`
- `test/suite/tark-workflow.test.ts`
- `test/tark-profile-shortcuts.test.ts`
- `test/suite/tark-runtime.test.ts`
- `test/tark.test.ts`
- `test/tark-cli.test.ts`

**B — historical 155 run (4 files)**

- `test/suite/tark-workflow.test.ts`
- `test/tark-workflow-state.test.ts`
- `test/tark-profile-shortcuts.test.ts`
- `test/suite/tark-runtime.test.ts`

**C — Phase 2 focused set (3 files)**

- `test/tark-command-policy.test.ts`
- `test/suite/tark-workflow.test.ts`
- `test/tark.test.ts`

**D — first Phase 2 run (2 files)**: C without `test/tark.test.ts`.

**E — RPC security follow-up (6 files)**

- `test/rpc-auth.test.ts`
- `test/rpc-environment.test.ts`
- `test/rpc-prompt-response-semantics.test.ts`
- `test/rpc-client-process-exit.test.ts`
- `test/suite/regressions/9068-user-bash-fail-closed.test.ts`
- `test/suite/tark-rpc-auth.test.ts`

**F — strict sandbox set (1 file)**: `test/tark-sandbox.test.ts`.

**G — latest focused compatibility/security set (17 files)**: C + E +

- `test/suite/regressions/5868-rpc-unknown-command-id.test.ts`
- `test/rpc-client-clear-queue.test.ts`
- `test/rpc-client-clone.test.ts`
- `test/rpc-jsonl.test.ts`
- `test/exec.test.ts`
- `test/exec-utf8-chunks.test.ts`
- `test/exec-runtime-limit.test.ts`
- `test/shell-path-exists.test.ts`

### Run history (2026-10-30, UTC)

| Time | Set | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: |
| 02:03:03 | A | 209 | 0 | 0 |
| 02:15:32 | B | 155 | 0 | 0 |
| 03:30:01 | D | 80 | 2 | 1 |
| 03:39:30 | C | 135 | 3 | 1 |
| 03:44:03 | C | 139 | 0 | 1 |
| 03:47:54 | C | 142 | 0 | 1 |
| 03:51:36 | C | 141 | 1 | 1 |
| 03:54:25 | C | 143 | 0 | 1 |
| 04:23:45 | E | 25 | 0 | 0 |
| 04:24:00 | F, before adding the full run_checks-path case | 0 | 5 | 0 |
| 04:35:34 | G | 206 | 0 | 1 |
| 04:35:49 | F | 0 | 6 | 0 |

209 → 155 → 143 compares **different selected file sets**, not a shrinking suite.
Existing test cases were not deleted by the Phase 2 changes. Windows-only gating
is explicit; new strict Linux tests do not skip on Linux. Source additions during
implementation explain increases within set C. Failed intermediate runs are kept
in the table rather than being described as successful verification.

Latest repository gates: `npm run check` passed with no fixes; `npm run build`
passed. The focused pass count does not override the six strict sandbox failures
or the missing native Windows CI result. No full test suite or real provider calls
were run. `TARK-TOOLS-PERMISSIONS-PLAN.md` now specifies the **600-second hard max**.
