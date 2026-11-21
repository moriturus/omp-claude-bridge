# Security Policy

## Supported versions

Only the latest published `0.x` release receives security fixes. Older releases
are not supported.

## Reporting a vulnerability

Please **do not** open a public issue for security reports.

Instead, use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on
<https://github.com/DevVig/omp-claude-bridge>, or email the maintainer at
`jon@learnvig.com`.

Include:
- A description of the issue and its impact.
- Steps to reproduce (a redacted `~/.omp/agent/claude-bridge.log` excerpt helps).
- The version / commit you are running.

You can expect an initial acknowledgement within a few days. Please give a
reasonable window for a fix before any public disclosure.

## Scope notes

This extension bridges to the Claude Code CLI through the official
[`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript).
Authentication and billing are handled by Claude Code / your Anthropic
subscription — this project never stores credentials. Issues in the underlying
SDK or CLI should be reported to their respective upstream projects.
