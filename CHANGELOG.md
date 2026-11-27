# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.13.1]

### Fixed
- Keep OMP side turns such as input prediction and idle recap from replacing the main Claude session. Fork compatible history so the side prompt does not modify the main transcript.

## [0.13.0]

### Changed
- Disable Claude Code's background session-title generation by default without changing OMP titles or subagent labels.

### Fixed
- Preserve the system instructions OMP supplies for standalone completions such as subagent label generation.

## [0.12.0]

### Fixed
- Load the bridge and render AskClaude tool calls and results on OMP 19.2.0 using the host's new TUI nodes. OMP 19.0.1 remains the minimum.

## [0.12.0-beta.3]

### Fixed
- Fetch live Claude subscription usage without first opening Claude Code. The bridge still disables telemetry, but no longer forces essential-traffic-only mode.

## [0.12.0-beta.2]

### Added
- Show Claude Extra Usage and its reported USD spend and monthly cap in OMP's usage views.

### Fixed
- Pass quota status to OMP so interactive `/usage` bars use the theme's normal, warning, and exhausted colors.

## [0.12.0-beta.1]

### Added
- Display Claude subscription usage and reset times through OMP's `/usage` and `omp usage --provider claude-bridge` when the experimental SDK method is available.

## [0.11.1]

### Fixed
- Preserve discovery of OMP 19.1.0's Bash-mounted tools, including OMP-managed MCP tools, through the bridged Bash tool. OMP 19.0.1 remains supported.
- Read secret protection from OMP's scoped settings without loading the legacy settings shim, which imports unavailable browser-relay code in the 19.1.0 npm package.

## [0.11.0]

### Fixed
- Honor cancellation on the active OMP request when Claude continues after tool results, including requests already cancelled at dispatch.
- Preserve the answer when the final Claude message streams only thinking and the text arrives in the SDK result, even if earlier text was streamed before a tool call.
- Keep AskClaude from using full mode in a worktree that forbids it, and retain Claude-readable history after an OpenAI-native compaction.
- Respect OMP secret protection: use standard compaction, rebuild protected history, skip raw filesystem instructions and settings, and block direct AskClaude requests that cannot use the session's obfuscator.

## [0.10.0]

### Changed
- Require Oh My Pi 19.0.1 or newer. Run the development and CI commands through mise.
  Include the example configuration in the npm package.
- Dependencies updated to the newest releases at least one day old (pnpm's default
  `minimumReleaseAge`, now also set for bun in `bunfig.toml` so both lockfiles
  resolve the same versions): `@anthropic-ai/claude-agent-sdk` 0.3.329,
  `@anthropic-ai/sdk` 1.11.0, `@modelcontextprotocol/sdk` 1.32.2, `cc-session-io`
  0.4.1, `typebox` 1.4.7, `zod` 4.6.7, `tsx` 4.23.15, `typescript` 7.0.2, and
  `@types/node` 26.6.6. Excluded as under one day old at update time:
  `@anthropic-ai/claude-agent-sdk` 0.3.330 and `@anthropic-ai/sdk` 1.12.0.

### Fixed
- The `max` thinking level sent no effort to Claude Code, and
  `xhigh` was sent as `max`. Both now map to the matching Claude Code effort, and
  AskClaude accepts `thinking: "max"`.
- Parallel tool calls lost every result after the first when a session was rebuilt;
  `repairToolPairing` replaced them with synthetic `[no tool result recorded]` errors.
  Consecutive tool results are now persisted in one user message.
- Claude transport and transcript state now belong to the requesting OMP session.
  Child sessions cannot reset parent state; `/clear` starts without old history and
  `/fresh` rebuilds from the retained history. Rebuilds leave prior JSONL and companion files intact.
- Tool results are correlated by invocation ID. Replayed tool results without a
  live query are imported and answered. External MCP calls run only in Claude Code.
- Deferred steering preserves all text and images, and subsequent answers no longer
  overwrite the responses or usage already streamed in the same OMP turn.
- SDK error results (`is_error`, `error_*` subtypes) were reported as empty successful
  turns in the provider, AskClaude, and compaction summaries.
- Aborting during a deferred steer/follow-up replay did not stop the running query.
- AskClaude `read` and `none` use strict tool sets without user or project settings.
  Only the user configuration can choose the Claude executable or default to `full`.
  AskClaude copies current OMP history, including summaries, and reports cancellation
  and SDK failures as tool errors.
- Explicit model IDs take precedence over aliases. Explicitly disabling thinking
  reaches the SDK. Forward OMP 19's skills format and use the session cwd for compaction.
- Read rate-limit utilization as a fraction and reset times as Unix seconds.
- `usage.cost.total` was always `0`.
- Thinking signatures from `anthropic-messages` models and images in tool results were
  dropped during session rebuild.
- Tool schemas with empty or non-string enums, or nested object properties, converted
  to invalid or lossy Zod schemas.
- AGENTS.md was read from `process.cwd()` instead of the session cwd, and `.omp`
  rewriting missed standalone `.omp` while corrupting names such as `file.omp`.
- Failures to write diagnostic logs no longer interrupt provider turns.

## [0.9.0]

### Fixed
- Extension fails to load on Oh My Pi 18, which made `omp plugin install` abort with
  `Cannot find package '@oh-my-pi/pi-coding-agent'` (issue #5). The `keyHint` import
  moved to `@oh-my-pi/pi-tui/chrome/keybinding-hints`; the old
  `@oh-my-pi/pi-coding-agent/modes/components/keybinding-hints` subpath is no longer in
  the host-package map, and Bun reports a missing subpath as a missing package.
- First turn failing with `Claude Code returned an error result: No conversation found
  with session ID` when OMP injected a hidden notice (e.g. the `xd://` device inventory
  notice after an MCP tool change) before the first user prompt. Messages with roles
  other than `user` / `assistant` / `toolResult` were dropped during session rebuild,
  so no session file was written but its id was still resumed. Such messages are now
  forwarded as user turns, and a rebuild that yields no records starts a fresh session
  instead of resuming a missing one.

### Added
- Latest Claude Code models: `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`,
  `claude-haiku-5-5`, and `claude-fable-5-1`, each registered as one canonical catalog
  entry. `opus` / `sonnet` / `haiku` / `fable` short names now resolve to the newest
  model in each family.

### Changed
- `@oh-my-pi/pi-tui` dev dependency raised to `^18.13.3`, the first line that
  ships `chrome/keybinding-hints`, so `tsc --noEmit` resolves the new subpath.
- `claude-opus-5-5` needs a Claude Code ≥2.1.280 binary and `claude-fable-5-1` ≥2.1.251.
  If the CLI bundled with your `@anthropic-ai/claude-agent-sdk` install is older (see
  `claudeCodeVersion` in its `package.json`), set `provider.pathToClaudeCodeExecutable`
  to a newer `claude` binary for those ids.

## [0.8.1] - 2026-07-07

### Fixed
- Spurious "Claude rate limit warning" toasts at trivial utilization. The Claude
  Agent SDK emits `allowed_warning` rate-limit events even at ~1% of the
  `seven_day` (weekly) limit; these are now surfaced only at ≥80% utilization.
  Hard-limit (`rejected`) notifications and the debug log are unchanged.

## [0.8.0] - 2026-07-07

### Added
- On-demand context-window variants in the `/model` picker: each model is now
  registered once per window it supports (1M and/or 200K) as a distinct,
  clearly-labeled entry (e.g. `Opus 4.8 (1M)` and `Opus 4.8 (200K)`). Switching
  a model's context window is a picker selection instead of a config edit plus
  reload.
- Suffixed model ids (`<model>-1m` / `<model>-200k`) that force a specific
  window regardless of the global default — usable from `modelRoles` and
  AskClaude short names. The unsuffixed id remains the config default, so
  existing `config.yml` roles keep working.

### Changed
- `provider.contextWindow` now sets the **default** window (which window the
  unsuffixed model id maps to) instead of hiding models that don't match it.
  Both windows stay pickable wherever a runtime exists.
- Each variant reports its true `contextWindow`, keeping the status bar and
  auto-compaction accurate for the selected window.

## [0.7.0] - 2026-07-06

First public release of the Oh My Pi port.

### Added
- `provider.contextWindow` setting with three modes:
  - `"auto"` (default) — per-model context policy based on measured SDK behavior.
  - `"1m"` — force the 1M context window; only 1M-capable models are registered.
  - `"200k"` — force the 200K context window; only 200K-capable models are registered.
- Models without a runtime for the selected forced window are hidden from the
  model picker instead of being misreported.
- `thinkingLevelMap` fallback so Sonnet 5 / Sonnet 4.6 expose `xhigh` (mapped to `max`).

### Changed
- Ported from Pi (`@earendil-works/*`) to Oh My Pi (`@oh-my-pi/*`): extension
  manifest (`omp.extensions`), provider registration, message conversion, and
  config directory resolution (`~/.omp/agent/claude-bridge.json`).
- Corrected the `claude-fable-5` context policy: the bare `claude-fable-5`
  runtime serves 200K (verified), while `claude-fable-5[1m]` serves 1M. In
  `"auto"` mode Fable 5 now registers at 200K.

### Credits
- Original `pi-claude-bridge` by [Eli Dickinson](https://github.com/elidickinson).
- Oh My Pi port and context-window controls by [Jonathan Borgwing](https://github.com/DevVig).
