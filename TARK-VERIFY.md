# Tark verification

## Results

- `npm run check`: passed, including formatting/lint, TypeScript, dependency pins,
  runtime dependencies, import graphs, install-lock validation, and browser smoke.
- `npm run build`: passed for the full workspace and Node CLI bundle.
- Targeted Vitest runs: **231 tests passed across 10 files**.
- `node --test scripts/pack-tark.test.mjs`: **2 tests passed**.
- Own-name tarball built at
  `.artifacts/tark/tark-ai-coding-agent-1.4.0.tgz`.
- Installed that tarball into a separate `/tmp` prefix with
  `npm install --ignore-scripts`: succeeded; that install reported **0 vulnerabilities**.
- Installed CLI: version/help, offline print reply, and real parent/child
  delegation succeeded. Delegation returned completed/read mode, child output,
  exit code, requested model/effort, and usage.
- Installed TUI: midnight theme, 18 skills, init/commit/summary prompts,
  single-choice question submission, final faux-provider response, and resize
  from 80 to 40 columns succeeded in a controlled pseudo-terminal.
  `tmux` was unavailable, so this was a PTY check rather than a tmux check.
- Supplied temporary PieXis source checkout removed after integration.

No real model API requests or paid tokens were used for behavior tests. Model
catalog generation during the standard build fetched provider metadata only.

## Reproduce the automated tests

From the repository root, build first, then:

```sh
npm run check
npm run build
node --test scripts/pack-tark.test.mjs
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run \
  test/config.test.ts test/args.test.ts test/keybindings.test.ts \
  test/config-schemas.test.ts test/trust-manager.test.ts \
  test/resource-loader.test.ts test/resource-loader-theme.test.ts \
  test/tark.test.ts test/tark-cli.test.ts test/suite/tark-runtime.test.ts
```

Coverage includes config merge/trust/scaffolding, routing, scopes/conflicts,
queued/active cancellation, subprocess JSON/usage, source and bundled CLI child
launches, noninteractive question behavior, remapped cancellation, file guards
(including dangling/new-file symlink escapes), ignore patterns, setup preservation,
cache freshness/exclusions, conservative health defaults, and settled sound events.

## Try it

After building, from the repository root:

```sh
./node_modules/.bin/tark
```

For an isolated local installation:

```sh
npm install -g --ignore-scripts ./.artifacts/tark/tark-ai-coding-agent-1.4.0.tgz
tark
```

Use `/login`, `/profile`, `/setup-agents`, and `/settings`. Tark does not silently
copy credentials from `~/.pi/agent`; authenticate again or intentionally migrate
only the settings you want into `~/.tark`.

## Not established or not included

- The full repository test suite was not run; the counts above are targeted tests,
  not a claim that every upstream test fixture has been migrated to Tark paths.
- No public npm publication, Bun standalone build, Windows/macOS execution,
  real-provider delegation, or actual audio playback was tested.
- Sounds, browser binaries/CLI, Python, and Ruff remain user prerequisites.
- Proprietary document skills and the Web UI are excluded.
- Health analysis is heuristic; structural refactors are proposal-only. Optional
  AI-health usage is recorded separately, not added to the ordinary subagent totals.
- Scopes/guards are cooperative and bypassable, not OS isolation. Nested ignore
  handling is conservative. Caches contain private source-derived snippets.
- The workspace's existing sandbox/example dependency tree still reports npm
  audit advisories. Tark pins its added Zod dependency to patched **4.6.7**;
  the independently installed Tark tarball reported no vulnerabilities.
- The default tarball scope is a local distribution identity, not a claim that
  the name is available or that it has been published. Choose a scope you own.
