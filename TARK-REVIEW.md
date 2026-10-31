# Tark source review and decisions

## Baseline

Reviewed PieXis 0.3.2 from https://github.com/VarunGaikwad/piexis,
revision `eee741fa53c0f71890e349c1a4d34ecad19b0112` (the supplied `tmp/` checkout).
Its package metadata declares MIT. The supplied checkout has no top-level
LICENSE file; the declaration and source attribution are retained in
`packages/coding-agent/tark/NOTICE.md`. Pi's original MIT license remains intact.

## Reuse and integration

Reuse Pi's provider connections, authentication, trust, sessions, tools, extension
runtime, discovery, themes, and terminal ownership. Compile adapted PieXis
features as built-in modules, not separately installed extensions. Keep individual
features configurable with Pi's existing `builtin:` selection mechanism.

Adapted: profiles/routing, subprocess delegation and scheduler, question model
and screen, setup, header/footer, sound state machine, access policy, health
analysis/Ruff adapter, repository outlines, prompts, and permissive skills.
The Web UI, web dependencies, and audio assets are not included.

## Changes beyond a direct port

- Use `~/.tark` and project `.tark/`; no automatic copying of Pi credentials.
- Resolve child processes through this Tark installation, never an unrelated
  `pi` executable on PATH. Do not explicitly load the agent module a second time.
- Keep HOME/platform runtime paths in child environments so saved authentication
  and configuration resolve consistently. Do not inherit arbitrary host secrets.
- Use configurable question/profile keys instead of fixed key tests.
- Fix new-file symlink escapes; use the existing `ignore` package rather than a
  partial hand-written glob parser. Nested ignore handling is conservative.
- Allow normal shell variables and `set -e`; block obvious environment dumps.
  This remains a bypassable tool policy, not a sandbox.
- Disable health AI review by default: no hidden extra paid model calls.
- Keep the footer busy through retries; use the final settled lifecycle event.
- Correct outdated tips and omit advertisements for excluded skills.
- Preserve existing configuration, explicit tool selections, and project trust.

## Excluded resources

With the user's approval, exclude these bundled skills entirely:

| Skill | Reason | Alternative now |
| --- | --- | --- |
| `docx` | Proprietary terms prohibit copying, modification, and redistribution | None bundled |
| `xlsx` | Same restrictions | None bundled |
| `pptx` | Same restrictions | None bundled |
| `pdf` | Same restrictions | None bundled |

Do not derive alternatives from those implementations. Original, independently
written document skills can be added later. The exclusion also removes their
scripts and supporting assets. No claim is made that document workflows are
implemented.

Retain license and provenance files beside permissive third-party skills:
agent-browser (Apache-2.0), caveman (included MIT/Apache notices), ponytail (MIT),
ui-ux-pro-max (MIT), frontend-design/webapp-testing/mcp-builder (Apache-2.0).
Other PieXis-authored skills fall under its declared package MIT license.
Mixkit audio is excluded: users must supply their own WAV files.

## External requirements and boundaries

- Browser automation: separately installed `agent-browser` CLI and browser binaries.
- UI/UX search: Python 3; scripts/data are included, Python is not.
- Ruff checks/formatting: separately installed Ruff, explicitly enabled.
- Sound: user WAV files and an available OS audio player.
- Child agents share the workspace and OS permissions. Scopes coordinate writes;
  they are not containment. Read jobs do not see isolated filesystem snapshots.
- Delegation uses saved authentication. Runtime-only SDK providers/credentials
  and arbitrary environment credentials are not forwarded.
- Publishing requires an explicitly chosen available npm scope and credentials;
  local packaging must not publish or overwrite upstream Pi releases.
