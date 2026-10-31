# Phase 2 verification and remaining blockers

Status: **not ready to commit/sign off**. Historical RPC authentication and focused
checks passed. Fresh fixed typecheck and lint checks passed with `sandboxed`
results. The latest focused test run reported **151 passed, 8 failed, 1 skipped**:
six strict sandbox tests failed at nested namespace creation, and two RPC tests
could not locate their fixture from the repository-root working directory.
Latest user-supplied CI run 41166370537 has head SHA
`affa168ff89bc198ddcbbfb33bf3336068bea911`, matching local HEAD. Its Ubuntu native
and strict-isolation steps passed; Windows still has two failures. Bash diagnostics
now identify Git Bash path conversion corrupting the probe. The RPC diagnostics
were not in that commit and remain staged locally. No commit or remote CI dispatch
was performed by the agent.

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
At that historical run, the user was unprivileged, sudo/Docker/Podman were absent,
and the host denied bubblewrap's required mount setup:

```text
bwrap: Failed to make / slave: Permission denied
```

The historical strict run had **6 failed, 0 skipped**. Tests 1–5 failed before the
isolated command started. Test 6 could not start its outer sandbox to hide the
inner backend. The latest collected strict run also had **6 failed, 0 skipped**:
inside the configured check sandbox, nested bubblewrap reported `No permissions
to create a new namespace`. Neither run proves successful write/symlink/descendant
isolation. Fresh fixed typecheck/lint commands execute with `sandboxed` results,
and the latest test command reaches collection (see below). A passing strict run
on a Linux/WSL2 host or execution context permitting the required namespaces is
still necessary before sign-off.

Reproduce from `packages/coding-agent`:

```sh
TARK_REQUIRE_SANDBOX=1 node ../../node_modules/vitest/dist/cli.js --run test/tark-sandbox.test.ts --reporter=verbose
```

The earlier test in `test/tark-command-policy.test.ts` did not skip or mock the
sandbox: with bubblewrap missing it passed the **fail-closed unavailable-backend
branch only**. It is now named `never executes an unrestricted fallback when the
real sandbox backend is unusable`. Its historical pass against the real kernel
startup failure is not strict isolation success proof.

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
workflow exists remotely. The user supplied `gh run view` output and failed-step
logs for [run 41132902256](https://github.com/VarunGaikwad/tark/actions/runs/41132902256),
on PR `VarunGaikwad/tark#1` from branch `update`:

| Job | Supplied result | Evidence limits |
| --- | --- | --- |
| `permissions (ubuntu-latest)` (124328114458) | Passed | Tested SHA and successful strict-step logs/counts not supplied |
| `permissions (windows-latest)` (124328114143) | Failed | Native test output: 32 passed, 2 failed, 1 skipped across four files |

Both jobs completed `npm ci --ignore-scripts` and `npm run build` according to the
supplied summary for Windows and the overall Ubuntu job success. These are remote
CI results, not fresh local build proof. The agent cannot independently query the
run because its isolated `gh` environment has no GitHub authentication.

Windows failures in the supplied log:

1. `test/rpc-environment.test.ts:74`, `scrubs real bash launches after spawn-hook
   environment overrides`: expected exit 0, got 1. The assertion output contains
   no child stderr; it does not establish whether bash launch, command quoting,
   or environment filtering caused the failure.
2. `test/suite/tark-rpc-auth.test.ts:100`, `rejects spawned prompt and dialog
   forgeries, but accepts the authenticated user's exact review`: an RPC wait
   timed out with empty captured stderr. Correction: in the inspected source,
   line 100 waits for the approval editor, after the malformed-JSON response
   assertion has passed. The earlier description of this as a parse-response
   timeout was incorrect for that source. The exact CI SHA is still needed to
   confirm the mapping. This differs from the local fixture-path failures.

That original log did not establish either root cause. The later run below
identifies the bash probe-construction defect; RPC still needs its diagnostic
changes included in CI. Do not skip these tests or weaken assertions.
The single skip is consistent with the Linux-only sandbox policy test's platform
gate, but its identity is not shown in the supplied dot-reporter output. No claim
is made that the Windows consent test was skipped.

The later run below supplies a head SHA and explicit successful Ubuntu strict-step
metadata. Raw strict-case counts and the checkout merge-commit relationship are
still not recorded. A passing Windows gate after resolving both failures remains
pending.

The one Windows-only test skipped in the Linux focused run is:

`requires native Windows session consent, labels every result, resets consent and reviews command changes`

It checks denial before consent, `unsandboxed` on every result, fresh consent for
a new session/reset, command-change approval, and no shell-isolation access after
Windows opt-in. Strict Linux tests are not part of the Windows command.

## Windows diagnostic follow-up

The approved follow-up added diagnostics only to:

- `test/rpc-environment.test.ts`: the bash exit-code assertion now includes the
  resolved shell configuration and at most 4096 characters of captured probe
  output, with the seeded dummy credential value redacted. It still performs
  the same real launch and asserts exit 0 and an empty reserved-environment list.
- `test/suite/tark-rpc-auth.test.ts`: each wait names its phase. Failure output
  includes stdin write/completion/error status, child exit/signal state, stdout
  and stderr byte counts, total record count, and at most 12 response summaries.
  Summaries contain only fixed boolean classifications, not raw protocol values,
  stdout/stderr text, tokens, or environment values. The existing security
  assertions remain, including token non-disclosure; the test also checks that
  the diagnostic summary does not contain the client token. Timeout limits and
  real subprocesses are unchanged.

These initial diagnostic edits were made against base revision
`839871037b340d2d4ec172297d259f8893e4c73a`. Git inspection later confirmed that only
the bash test was included in commit `affa168ff`; RPC diagnostics and these
documents remain staged locally. After the initial test edits:

| Configured check | Result |
| --- | --- |
| `typecheck` | Passed, exit 0, sandboxed |
| `lint` | Passed, exit 0, sandboxed; 1993 files checked, no fixes |
| `test` | Vitest output: 151 passed, 8 failed, 1 skipped across seven files |

The changed environment test file passed. The RPC test file still failed both
cases because the configured process cwd resolves its fixture from the repository
root; the first test's new safe output identified `bootstrap`, exit 1, one
completed stdin write, zero stdout bytes/records, and 775 stderr bytes. This
exercises the early-exit diagnostic, not the native Windows approval-editor path.
The other six failures remain nested namespace denial in the strict sandbox tests.
The tool again propagated an isolation error containing test output rather than
structured counts. No new native Windows run containing these edits is available.

An attempted `debug_workflow(reproduce)` call was rejected because that tool
requires the debug Agent. It did not record reproduction evidence. No product
source fix was attempted. Native Windows diagnostic results, and an amended plan
if product source changes are necessary, remain prerequisites to a behavior fix.
No commits, pushes, check-configuration edits, or isolation bypasses were made.

## Latest native CI and probe-construction fix

User-supplied metadata and failed logs for
[run 41166370537](https://github.com/VarunGaikwad/tark/actions/runs/41166370537)
report head SHA `affa168ff89bc198ddcbbfb33bf3336068bea911`, which matches local HEAD:

| Job | Result |
| --- | --- |
| Ubuntu (124434714297) | Install, build, native permission tests, and strict real bubblewrap isolation step passed |
| Windows (124434714091) | Install/build passed; native permission tests: 32 passed, 2 failed, 1 skipped |

Individual Ubuntu strict-case counts and the checkout merge-commit relationship
were not supplied. Step success is recorded as such, not as an invented count.
The local nested-namespace failures are separate from this successful remote step.

The Windows bash probe failed before inspecting its environment. Git Bash/MSYS
changed the regex literal inside the native Node `-e` argument into a path:

```text
filter(k=>C:/Program Files/Git/RPC|IPC|NODE_CHANNEL|LISTEN_/i.test(k))
SyntaxError: missing ) after argument list
```

The approved test-harness fix replaces the slash-delimited literal with an
equivalent case-insensitive `RegExp` constructor. This avoids argument path
conversion without disabling conversion globally, modifying product filtering,
or weakening the environment assertions. Native Windows validation of the fix
is still pending.

The same run's RPC failure still shows the old `RPC fixture response timeout`
helper. `git show --stat affa168ff` confirms that commit contains only
`test/rpc-environment.test.ts` diagnostics; the RPC diagnostics and both evidence
documents are still staged locally and did not reach CI. The user must include
those files, plus the new probe fix, in the next diagnostic commit.

After the probe fix, configured sandboxed typecheck and lint passed again (1993
files checked, no fixes). The focused command still produced **151 passed, 8
failed, 1 skipped**: the environment test file passed, six failures were nested
namespace denial, and two were the known repository-root RPC fixture lookup.
The tool propagated the nested isolation error, so these are Vitest-output counts.
The Windows RPC cause is not established, and Phase 2 is not complete. The agent
has not staged, committed, pushed, or changed product source.

## Initial fixed-check verification

Source revision: `839871037b340d2d4ec172297d259f8893e4c73a`, before these
evidence-only documentation edits. The user created `.tark/checks.json`; checks
ran from the repository root through `run_checks`, using
`/home/preapexis/.nvm/versions/node/v24.22.1/bin/node` with a 600-second timeout.
The initial argv arrays were:

```json
{
  "typecheck": ["node_modules/typescript/bin/tsc", "--noEmit"],
  "lint": ["scripts/biome-check.mjs"],
  "test": [
    "node_modules/vitest/dist/cli.js",
    "--root", "packages/coding-agent",
    "--run",
    "test/tark-command-policy.test.ts",
    "test/suite/tark-workflow.test.ts",
    "test/tark.test.ts",
    "test/rpc-auth.test.ts",
    "test/rpc-environment.test.ts",
    "test/suite/tark-rpc-auth.test.ts",
    "test/tark-sandbox.test.ts",
    "--reporter=verbose"
  ]
}
```

| Fixed check | Result | Isolation | Evidence |
| --- | --- | --- | --- |
| `typecheck` | Passed, exit 0 | sandboxed | `tsc --noEmit` completed |
| `lint` | Passed, exit 0 | sandboxed | 1993 files checked; no fixes applied |
| Initial `test` | Startup failed, exit 1 | sandboxed | Vite configuration loading failed before collection |
| Retried `test` | 151 passed, 8 failed, 1 skipped | Tool propagated a nested isolation error | Five files passed, two failed; counts from Vitest output |

The initial test launcher reported:

```text
failed to load config from /home/preapexis/Projects/tark/packages/coding-agent/vitest.config.ts
Error: ENOENT: no such file or directory, mkdir '/home/preapexis/Projects/tark/packages/coding-agent/node_modules/.vite-temp'
```

Vite attempted to create a configuration-bundling directory under the read-only
project. No tests were collected in that initial attempt. The user then temporarily
configured `test` to run Vitest `--help`; its sandboxed exit 0 established CLI option
support, not a test pass. The user restored the same seven-file command with
`--configLoader runner --no-cache` added before `--run`.

That retry reached test execution without granting project writes. Vitest output
reported **151 passed, 8 failed, 1 skipped** (160 tests; five files passed, two
failed). The Windows-only consent test was skipped. Failures were:

- All six tests in `test/tark-sandbox.test.ts`: nested bubblewrap reported
  `No permissions to create a new namespace`. The unavailable-backend test also
  failed before it could establish its outer sandbox. These failures do not prove
  the six isolation guarantees.
- Both tests in `test/suite/tark-rpc-auth.test.ts`: the fixture was resolved as
  `/home/preapexis/Projects/tark/test/fixtures/tark-rpc-auth.ts`, which does not
  exist. The source uses `resolve("test/fixtures/tark-rpc-auth.ts")`, requiring the
  package process working directory. Vitest `--root packages/coding-agent` does
  not change that working directory. The invocation needs correction before
  these tests can provide fresh RPC subprocess proof; neither failure establishes
  a product authentication regression.

`run_checks` propagated `Filesystem isolation failed; no unrestricted fallback`
containing the nested failure output instead of returning a structured check
result. Counts above are copied from the actual Vitest summary, not tool-reported
structured counts. No unrestricted retry, source edits, or check-configuration
edits were made by the agent.

The successful fixed checks establish sandboxed command execution, not all strict
isolation guarantees. They are also not the complete `npm run check` script,
which includes write-mode formatting and additional repository gates. No fresh
full local repository check or build was run. The subsequent user-supplied native
Windows CI failures are recorded separately above; its gate is not yet passing.

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

Historical repository gates: `npm run check` passed with no fixes; `npm run build`
passed. The historical focused pass count does not override the local strict
sandbox failures or the two native Windows CI failures. The latest supplied Ubuntu CI
metadata confirms native/strict-step success at the reported head SHA; raw
strict-case counts and the checkout merge relationship are still not recorded. No full test
suite or real provider calls were run by the agent. `TARK-TOOLS-PERMISSIONS-PLAN.md` now specifies the **600-second hard max**.
