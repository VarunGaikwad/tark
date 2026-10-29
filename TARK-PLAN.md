# Tark development plan

## Goal

Turn this Pi codebase into Tark: our own coding agent with the features described in the PieXis README, built in without a separate extension installation.

## 1. Review PieXis

- [ ] Get its source code and check licenses.
- [ ] Compare its features with this codebase.
- [ ] Decide which code to reuse and which parts need adapting.

## 2. Make Tark run

- [ ] Add the `tark` command and Tark branding.
- [ ] Choose Tark's configuration and session locations.
- [ ] Keep existing model connections and coding tools working.
- [ ] Preserve required upstream licenses and attribution.

## 3. Add agents

- [ ] Add plan, orchestrator, debug, ask, and code profiles.
- [ ] Add profile switching and optional automatic routing.
- [ ] Support model and reasoning settings for each profile.
- [ ] Add subagents with read/write scopes, limited concurrency, cancellation, and usage tracking.

## 4. Add questions and terminal UI

- [ ] Add interactive single-choice, multiple-choice, and text questions.
- [ ] Add the header, tips, themes, and compact footer.
- [ ] Show context usage, costs, Git status, and agent status.
- [ ] Add optional sound notifications using user-provided audio.

## 5. Add coding workflows

- [ ] Bundle the skills and init, commit, and summary prompts.
- [ ] Add recommended-tool and agent-configuration setup.
- [ ] Add file-access guards and code-health checks.
- [ ] Add repository summary caching.
- [ ] Document external requirements for browser and design skills.

## 6. Add the Web UI

- [ ] Add a local browser interface with token authentication.
- [ ] Support streaming, tools, questions, cancellation, and sessions.
- [ ] Add read-only Git status and diffs.

## 7. Test and package

- [ ] Test each feature as it is added.
- [ ] Verify terminal and non-interactive modes still work.
- [ ] Check configuration safety, cancellation, and error handling.
- [ ] Document installation and publish Tark's own package.

## Working rules

- Finish and verify one stage before starting the next.
- Reuse working Pi infrastructure instead of rewriting it.
- Keep optional features opt-in where appropriate.
- File guards and subagent scopes are not a security sandbox.
- Match the described PieXis features first; planned upstream features are not part of this baseline.
