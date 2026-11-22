# Contributing to omp-claude-bridge

Thanks for your interest in improving **omp-claude-bridge**. Contributions of all
sizes are welcome — bug reports, docs fixes, and features alike.

## Getting set up

```bash
git clone https://github.com/DevVig/omp-claude-bridge.git
cd omp-claude-bridge
mise exec -- bun install --frozen-lockfile
```

Install the project toolchain with [mise](https://mise.jdx.dev). Use `mise exec -- bun …` for Bun commands without activation, or run `mise install` followed by your normal activation setup.

Requirements:
- Node.js >= 20
- Bun (required for the full test suite; npm is not a substitute)
- Oh My Pi 19.0.1 or newer for end-to-end testing ([omp.sh](https://omp.sh))

The development lockfiles use Oh My Pi 19.1.0. For a smoke test of Bash-mounted tool commands, use the 19.1.0 CLI or newer.

## Developing against a live Oh My Pi

Point Oh My Pi at your working copy so changes load on the next run:

```bash
omp plugin install /absolute/path/to/omp-claude-bridge
```

```bash
CLAUDE_BRIDGE_DEBUG=1 omp models claude-bridge
# logs -> ~/.omp/agent/claude-bridge.log
```

## Checks before opening a PR

```bash
mise exec -- bun run typecheck
mise exec -- bun run test
```

The full suite includes a Bun test, so running the Node unit tests through npm alone does not verify the suite. CI runs both checks on every pull request.

## Coding guidelines

- TypeScript, ESM, tabs for indentation (match the surrounding files).
- Keep model routing in `src/models.ts` and cover changes in `tests/unit-models.mjs`.
- Preserve the canonical OMP catalog metadata. To investigate a runtime mismatch,
  compare it with the `result: served contextWindow=...` debug line.

## Reporting bugs

Open an issue using the bug template. A `~/.omp/agent/claude-bridge.log` excerpt
(run with `CLAUDE_BRIDGE_DEBUG=1`) makes bugs far easier to reproduce.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
