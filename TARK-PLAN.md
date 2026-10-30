# Tark development plan

## Goal

Turn this Pi codebase into Tark, with the permitted PieXis terminal features
built in rather than requiring a separate extension installation.

Configuration: `~/.tark` globally and `.tark/` per project.
Source review and exclusions: [TARK-REVIEW.md](TARK-REVIEW.md).
Verification and remaining limits: [TARK-VERIFY.md](TARK-VERIFY.md).

## 1. Review PieXis

- [x] Review the supplied `tmp/` source and license declarations.
- [x] Compare its features with Pi's existing infrastructure.
- [x] Decide which code to reuse and adapt.
- [x] Exclude proprietary docx, xlsx, pptx, and pdf skills, with the user's approval.
- [x] Preserve source attribution and permissive skill licenses.
- [x] Remove the temporary source checkout after integration.

## 2. Make Tark run

- [x] Add the `tark` command and Tark branding.
- [x] Use Tark's own configuration/session locations.
- [x] Keep existing model connections and coding tools.
- [x] Preserve upstream licenses and attribution.
- [x] Package the distribution under its own identity without renaming Pi's workspace SDK.

## 3. Add agents

- [x] Add plan, orchestrator, debug, ask, and code profiles.
- [x] Add switching and opt-in automatic routing.
- [x] Support per-profile models and reasoning settings.
- [x] Add scoped subagents, limited concurrency, cancellation, and usage tracking.
- [x] Verify real parent/child CLI processes using an offline faux provider.

## 4. Add questions and terminal UI

- [x] Add single-choice, multiple-choice, and text questions.
- [x] Add header, tips, themes, and compact footer.
- [x] Show context, costs, Git status, and agent/subagent status.
- [x] Add opt-in sound notifications using user-provided audio only.
- [x] Make profile/question keys configurable.
- [x] Verify the installed TUI, a question answer, and narrow-terminal resize.

## 5. Add coding workflows

- [x] Bundle 18 permitted skills and init, commit, and summary prompts.
- [x] Add opt-in recommended-tool and agent-configuration setup.
- [x] Add file guards and conservative code-health checks.
- [x] Add repository outline caching.
- [x] Document browser/design/Ruff/audio prerequisites and privacy limits.
- [x] Keep paid AI health review and Ruff disabled by default.

## 6. Web UI

Deferred as requested. No Web UI implementation or web dependencies were imported.

## 7. Test and package

- [x] Add focused tests and run related upstream regression tests.
- [x] Verify terminal, print, and JSON modes without paid model calls.
- [x] Check configuration preservation, trust, cancellation, and errors.
- [x] Run the full repository check and build commands.
- [x] Build and install-test Tark's own local npm tarball.
- [x] Document installation and limitations.
- [ ] Publish to npm only after choosing an available package name/scope and credentials. No registry publication was attempted.

## Working rules

- Finish and verify stages; report only at completion or when blocked.
- Reuse working Pi infrastructure instead of rewriting it.
- Keep optional features opt-in where appropriate.
- File guards and scopes are not a security sandbox.
- Do not redistribute restricted skills or audio.
- Match the permitted PieXis baseline; do not claim deferred document workflows,
  Web UI, semantic analysis, or OS containment are implemented.
