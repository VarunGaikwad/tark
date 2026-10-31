# Agent permissions and fixed checks

Agent selection is user-only: `/profile ask|plan|orchestrator|code|debug`.
Automatic routing is disabled, including when old `auto_profile` settings are present.
Injected extension messages cannot select an Agent. View changes grant no capabilities.
Selecting code/debug does not grant write permission: `/approve-plan` must approve
the exact saved plan revision and task paths. Editing that plan revokes approval.

## RPC approval boundary

RPC uses only a private inherited stdin/stdout pipe, not a listening endpoint or
socket. The sole parent client bootstraps a fresh 256-bit token; every later command
and dialog response must authenticate before it can become user input or answer
an approval dialog. Reauthentication is rejected. Tokens stay in client/server
memory, never argv, environment, protocol output, or session entries. Raw clients
must follow [RPC authentication](../../docs/rpc.md#client-authentication);
`RpcClient` performs bootstrap and authenticates dialog replies automatically.

Tool/check/shared job-spawn helpers strip RPC/IPC, Node channel and socket-activation
variables even from explicit caller environments. Normal launches forward neither
RPC stdin nor additional parent descriptors. Delegated agents retain their existing
environment allowlist. Background jobs themselves remain Phase 5 work. This does
not claim protection against privileged debuggers or same-user memory inspection.

## Commands

Prefer built-in `ls`, `find`, `read`, and `grep` over OS commands. `bash` accepts a
small literal argv language, not shell programs: quotes group literal arguments;
escapes, metacharacters, expansion, pipes, redirection and chaining are rejected,
even in quoted text. Execution uses direct spawning without a shell.

Ask/plan can execute these Safe system-Git forms only:

- `git status` with `--short`, `--branch`, `--untracked-files=no`.
- `git diff` with `--stat`, `--name-only`, `--name-status`, `--cached`, `--staged`.
- `git log` with `--oneline`, `-1`, `-5`, `-10`.

Git comes from fixed OS installation locations, never project/PATH lookup. Hooks,
external diff, text conversion, pagers, optional index writes and filesystem-monitor
hooks are disabled where applicable. Safe Git ignores submodules and uses a fixed
log format without signature verification. Repositories declaring Git filters are
blocked because clean/process filters can execute project code even during a read.
Unsupported forms are not Safe. Native Windows
uses Git for Windows in Program Files; Unix uses `/usr/bin/git` or `/bin/git`.

Orchestrator has no general bash. Normal commands (`npm run/test/install/ci`)
require approved write permission. Unknown commands, wrappers, removals and force
pushes are Dangerous and additionally require explicit approval of **each exact
command and working directory**. Missing/denied/cancelled consent blocks execution.
This conservative classification intentionally prompts for more than just known
destructive commands; approval is never an upgrade to general write authority.

In this intermediate phase, Normal/Dangerous argv runs only inside Linux/WSL2
**read-only filesystem isolation**. Project writes through commands remain blocked
until Phase 4 supplies task-specific shell write mounts. Builders remain disabled.
Native Windows consent for checks never enables general write bash or builder shell.
PowerShell and unclassified extension/MCP tools remain blocked.

Commands default to **120 seconds**, with a finite **600-second hard maximum**.
The host environment `TARK_COMMAND_TIMEOUT_SECONDS` configures the default; bash's
`timeout` argument overrides it within the same bounds. Invalid host configuration
is rejected even when an override is supplied. Timeout/cancellation kills the
process tree. Command output retains at most 200 lines/8 KiB, reports omitted bytes,
and does not retain an unlimited log or stream unlimited updates.

## Fixed `run_checks`

A trusted project owner configures `.tark/checks.json`. Example on Linux:

```json
{
  "typecheck": {
    "executable": "/usr/bin/node",
    "args": ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"]
  },
  "lint": {
    "executable": "/usr/bin/node",
    "args": ["node_modules/@biomejs/biome/bin/biome", "check", "."]
  },
  "test": {
    "executable": "/usr/bin/node",
    "args": ["node_modules/vitest/vitest.mjs", "run", "test/specific.test.ts"]
  },
  "timeoutSeconds": 120
}
```

Use actual absolute executable paths on the host. No shell or PATH resolution is
performed. Each check is optional; missing checks are blocked, not silently passed.
The tool accepts only `{ "check": "typecheck" | "lint" | "test" }`.

Before first execution, review commands, package scripts and the configuration
revision. Changes to check definitions, package scripts, lockfiles, tsconfig,
ESLint/Biome/Vite/Vitest/Jest configuration require fresh command/config approval.
Old versus new commands and package scripts are shown. File-edit/plan approval is
not command approval. Configuration is revalidated immediately before execution;
non-interactive changes are blocked. Project configuration traversal is bounded;
symlinked project entries and oversized reviews fail closed. Runtime dependencies
and arbitrary project code remain trusted code, not a security-proof test oracle.

Check configuration files require explicitly named approved file paths for guarded
edits; a broad directory scope is insufficient. Local agent-owned file edits and
checks share a serial execution boundary. Builders remain unavailable, so no next
builder can race a verification run.

Linux/WSL2 requires bubblewrap in `/usr/bin/bwrap`, `/usr/local/bin/bwrap`, or
`~/.local/bin/bwrap`, plus usable unprivileged user and mount namespaces. These are
host-controlled install paths; tools cannot supply a sandbox executable. A binary
being installed is not proof that the kernel permits its isolation setup. The filesystem is mounted read-only, including project source; only
a fresh outside-project temporary directory and its home/cache are writable.
Descendants inherit these restrictions. Checks must direct generated outputs and
caches there or run without emitting files. Unsupported isolation blocks execution:
there is **no unrestricted fallback**. This is not network or credential isolation.

Native Windows requires a separate one-time **per-session unsandboxed opt-in**.
Every result is labelled `unsandboxed`. Denial or missing consent blocks execution;
a new/replaced session requires consent again. Unsupported non-Linux/non-Windows
platforms block checks. Native Windows CI covers the real opt-in path; Linux mocks
are not a substitute.

Results report pass/fail, exit code, termination reason, isolation and a short output
excerpt. Framework test counts are reported as unknown rather than guessed from text.

## Debug workflow

1. Establish concrete reproduction evidence using `debug_workflow` with action
   `reproduce`. If unavailable, stop and report the blocker.
2. Add a regression test and run a failing configured check, then record
   `regression` with the test and failure evidence. Before this decision, only
   test-path edits are allowed.
3. If a test is infeasible, record `infeasible`, explicitly naming the reason,
   alternative evidence/checks, and unexecuted checks. This is not regression coverage.
4. Make the smallest justified source fix. Run the regression and relevant checks.
   A successful post-fix `run_checks` result is required before marking todos done.

`debug_workflow status` reports progression. Evidence text is agent-reported;
check outcomes come from the host runner. Any later edit invalidates successful
verification. Plan revisions, branch changes, compaction and session replacement
reset debug evidence, requiring it to be re-established rather than trusting a
summary as authority. Incomplete debug runs emit a visible host warning in all modes on settlement; never
claim missing checks or regression coverage succeeded.
