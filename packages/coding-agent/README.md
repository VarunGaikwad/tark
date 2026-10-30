# Tark

Tark is a coding agent built on Pi, with profiles, subagents, interactive questions,
and coding workflows included. No separate PieXis installation is required.
Node.js 22.19+ is required. The Web UI is intentionally excluded.

## Run from source

From the repository root:

```sh
npm install --ignore-scripts
./pi-test.sh
```

The source runner now launches Tark. After building, use:

```sh
npm run build
node packages/coding-agent/dist/bundle/cli.js
```

Run `/login` to configure a provider, then submit a task. Existing Pi model
connections and coding tools are retained; credentials are not automatically
copied from Pi's configuration.

## Configuration

- Global: `~/.tark/` (settings, auth, models, sessions, skills, and extensions).
- Project: `.tark/`; project settings/resources require trust.
- Override the global directory with `TARK_CODING_AGENT_DIR`.
- Agent models/profiles and setup preferences live under `tark` in
  `~/.tark/settings.json` and trusted `.tark/settings.json`. No separate agent file is needed.
- Sound preferences live under `tark.sound` in user `settings.json` only;
  project settings cannot enable or override sound. `/sound` saves them there.
  See the [settings reference](docs/settings.md#tark-profiles-setup-and-sound)
  and bundled [editor schema](schemas/settings.schema.json).
- Use `/setup-agents` to choose a model for each profile in a terminal menu.
  Use `/setup-agents defaults` to fill missing project agent settings, preserving
  existing values. Recommended-tool setup is opt-in and project-only.

Pi's retained reference documentation still uses upstream names and paths.
For this distribution, substitute `tark`, `~/.tark`, `.tark`, and
`TARK_CODING_AGENT_DIR` for the corresponding Pi CLI/configuration names.
The workspace SDK retains its upstream import identity; local distribution
packaging uses Tark's own package name.

## Built-in workflows

| Feature | Usage |
| --- | --- |
| Profiles | `/profile plan`, `orchestrator`, `debug`, `ask`, or `code`; Alt+A cycles by default |
| Automatic routing | Disabled; only the user changes Agent through `/profile` or its shortcut |
| Plans and progress | `save_plan` saves/gets a plan; `todo` lists/adds/updates/removes/clears three-state progress |
| Approval | `/approve-plan` reviews and approves every task in the exact revision, then offers **Approve & start code** |
| Delegation | `subagent` runs read-only tasks; Phase 1 blocks builders |
| Questions | `askquestions`: single choice, multiple choices, text, validation, review, cancellation |
| Setup | `/setup-agents`; startup offers optional native grep/find/ls activation |
| Repository outlines | `get_workspace_changes`, `get_file_outline`, `/repo-cache-status` |
| Prompts | `/init`, `/commit` (message only), `/summary` |
| Themes | Orange and midnight in `/settings` |
| Sounds | `/sound`; off by default; supply WAV files in `~/.tark/sounds/` |

Per-profile model and reasoning settings use `tark.subagent_variant_overrides` in
settings.json. For example:

```json
{
  "tark": {
    "model": "provider/model-id",
    "small_model": "provider/small-model-id",
    "subagent_model": "provider/model-id",
    "auto_profile": false,
    "subagent_variant_overrides": {
      "code": { "model": "provider/model-id", "effort": "medium" }
    },
    "sound": { "enabled": false }
  }
}
```

Use exact `provider/model-id` values. Project values override user values; profile
model/effort fields merge individually. Lists replace inherited
lists. `/setup-agents` shows each profile's configured or inherited model, then
opens a searchable list of authenticated models. Selecting a model saves only
that profile's model in trusted `.tark/settings.json`, preserving effort and other
settings. Escape at either menu cancels without writing. Setup requires an idle
session with no running or queued subagents. Use `/profile <name>` to apply the
saved model to the current session; future subagents use it automatically.
`/setup-agents defaults` fills missing values without replacing other settings or
setup preferences. Old `agent.json`, `agents.json`, and `tark-sound.json` files
are not read. Move agent fields under `tark` and the sound object's `enabled`,
`events`, and `minimumDurationMs` fields under `tark.sound` in user settings.
Sound defaults to off; omitted event toggles default to on and the completion
minimum defaults to 5000 ms.

Read-only codebase exploration is always available through `subagent` with
`agent: "ask"` and `purpose: "explore"`. It uses `small_model` when configured,
otherwise the current model, with low effort; profile overrides do not apply.
Exploration children cannot delegate further, and all delegation stops at depth 2.

Subagents share the workspace, not the conversation. Orchestrators run at most two
read-only jobs; other profiles run children sequentially. Write requests require
`task_id` and explicit `paths` exactly matching the approved task's `allowed_paths`,
then remain blocked until sandboxed checks and builder isolation are implemented.
Cancellation terminates active children and removes queued work.
Delegation uses saved authentication; runtime-only SDK providers/credentials and
arbitrary environment secrets are not forwarded.

Readability guides coding directly in the main agent and subagents: reuse repository
patterns, keep files cohesive and functions focused, and separate unrelated
responsibilities rather than enforce a line cap. Avoid tiny-file fragmentation and
unneeded abstractions. Agents are instructed to reread changed code and run relevant
checks before finishing; this is guidance, not an automatic reviewer or a guarantee
of code quality.

### Saved plans, todos, and Phase-1 permissions

`save_plan` accepts `action: "get"` or `action: "save"`; saving requires `text` and
`tasks: [{ id, text, allowed_paths }]`. Paths are literal repository-relative files
or directories, not globs or root scopes. The tool cannot choose a storage path,
format, executable artifact, approval, or Agent. `todo` accepts `list`, `add`,
`update`, `remove`, and `clear`, with `pending`, `in-progress`, or `done` states.
Removed and cleared todo IDs are never reused within the active branch history.

Private immutable JSON snapshots live under `<agent-dir>/workflows/`, outside the
actual repository (or outside cwd in a nongit project). Repository-local agent
storage is rejected, even if the session directory is configured elsewhere.
Session entries store only snapshot references. Snapshots bind to the canonical
project directory; moving a session cannot transfer approval to another project.
Resume, branching, and compaction restore the latest reference on the active branch; a missing/corrupt snapshot
blocks execution rather than borrowing state from another branch. Current plan
and todo data are injected freshly into each model request, not appended forever.

Limits: 100 todos, 100 tasks, 100 paths per task; item/task text and task IDs are
at most 1,000 Unicode code points; paths at most 1,024 UTF-8 bytes; plan text at
most 64 KiB and the complete serialized state at most 256 KiB.

`/approve-plan` is accepted only from direct interactive/RPC user input; assistant
text, tool output, file content, and extension-injected user-like input cannot
approve. It requires an idle main TUI/RPC session with no subagents or model setup
in progress. Review the complete text, revision, tasks, and scopes without changing
the review, then explicitly choose **Approve & start code**. Approval binds the
whole exact plan revision; each task remains confined to its own `allowed_paths`.
Saving identical plan content preserves approval; a changed content hash clears it.
Print/JSON runs and children cannot approve. `/profile code`, `debug`, or CLI
`--agent` alone never grant writes: status remains `code · read` until approval.
Ask, plan, and orchestrator always remain read-only.

Approved code/debug can use guarded `edit` and `write` only within the active task
scope; protected environment/ignored paths remain blocked. Both direct and nested
tool calls are checked, and edits recheck authority inside the mutation queue.
Phase 1 blocks **all model shell commands** (`bash`/`powershell`), checks, builders,
and unclassified extension/MCP/codemode tools until their later permission and
isolation mechanisms exist. `auto_profile` remains parseable but does not route
requests; `/profile auto` explains that automatic routing is disabled.

These execution gates are **not an OS security sandbox**. Trusted extensions run
with the OS user's permissions, and user-run commands are not model tool calls.
Use isolation for untrusted work. Disabling `tark-agents` also disables its workflow
gates. Repository caches contain source-derived declaration snippets.

Built-in features can be disabled through `extensions`, for example:

```json
{
  "extensions": ["-builtin:tark-cache", "-builtin:tark-sound"]
}
```

Other names: `tark-resources`, `tark-agents`, `tark-questions`, `tark-ui`,
`tark-setup`, `tark-access`. `/reload` applies changes.
`--no-extensions` disables built-ins too. Keybindings are configurable in
`~/.tark/keybindings.json`, including `app.profile.cycle` and `app.question.*`.

## Interactive questions

`askquestions` supports terminal and RPC dialogs. Print/JSON modes return
`requires_interaction`; terminal mode requires TTY input and output. Questions
can use stable option IDs, `defaultSelection` for choices, and `defaultValue`
for editable text (including newlines). `defaultValue` is text-only and must fit
`maxLength`, which counts Unicode code points. Text does not accept
`defaultSelection`. Optional questions may submit an empty answer.

In the terminal, prompts, options, descriptions, and review answers wrap. Use
PageUp/PageDown to scroll long content; moving between choices reveals the
focused choice. Text uses the native multiline Editor: Enter confirms,
Shift+Enter or Ctrl+J inserts a newline (the native backslash-Enter fallback also
works). Up on the first custom-answer line returns to choices. Tab/Shift+Tab
switch grouped questions and review; drafts remain editable until submission.
All these actions respect configured `tui.*` and `app.question.*` keybindings.

RPC uses existing select/editor/confirm requests: indexed option displays keep
duplicate labels distinct, single-choice defaults appear first, multi-choice
dialogs toggle selections and show counts, and review offers editing before
explicit submission. Cancelling a
dialog cancels the interaction. Abort/session shutdown settles the tool and
prevents further dialogs. The current RPC editor API cannot dismiss an already
open client editor on abort; its eventual response is ignored. Client-side
wrapping and multiline editing depend on the RPC client's UI implementation.

## Skills and external tools

Eighteen skills are bundled, including debugging, review, TDD, refactoring,
planning, migration, browser automation, and UI/UX guidance. Read the matching
`SKILL.md` before use; `/skill:name` explicitly invokes one.

- Browser automation requires a separately installed `agent-browser` CLI and
  browser binaries (`agent-browser install`).
- UI/UX data search requires Python 3.
- Sound requires user-provided `attention.wav`, `finished.wav`, and `failure.wav`
  and an OS audio player. No third-party audio is redistributed.
- Proprietary `docx`, `xlsx`, `pptx`, and `pdf` skills are excluded, with no bundled
  replacement. See [third-party notices](tark/NOTICE.md).

See [cache details](tark/docs/repo-cache.md) and the retained
[Pi reference documentation](docs/index.md).

## Package locally

After `npm run build`, from the repository root:

```sh
node scripts/pack-tark.mjs --name @your-scope/tark --out /tmp/tark-packages
npm install -g --ignore-scripts /tmp/tark-packages/your-scope-tark-1.4.0.tgz
tark
```

The packer stages a separate distribution identity, includes resources and
licenses, and never publishes. Choose an available npm name you own before
publishing; do not publish this fork over upstream Pi. No registry publication
has been performed.

## Verify

From the repository root:

```sh
npm run check
npm run build
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/tark.test.ts test/tark-cli.test.ts test/suite/tark-runtime.test.ts
```

Tests use local fixtures and the faux provider, not paid model calls.

## License

Pi's MIT license is preserved in [LICENSE](LICENSE). Adapted PieXis code is
attributed in [NOTICE](tark/NOTICE.md); individual skills retain their licenses.
