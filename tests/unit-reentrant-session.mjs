import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getSessionPath } from "cc-session-io";
import { prepareSession } from "../src/session-sync.ts";

test("rebuilding a diverged transcript leaves the old transcript and its companion data intact", (t) => {
	const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-rebuild-"));
	t.after(() => rmSync(claudeDir, { recursive: true, force: true }));
	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	t.after(() => {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
	});

	const cwd = join(claudeDir, "project");
	const original = [{ role: "user", content: "original", timestamp: 1 }];
	const first = prepareSession(undefined, original, cwd);
	const oldPath = getSessionPath(first, cwd, claudeDir);
	const previousHistory = readFileSync(oldPath, "utf8");
	const artifact = join(oldPath.slice(0, -".jsonl".length), "tool-results", "output.txt");
	mkdirSync(dirname(artifact), { recursive: true });
	writeFileSync(artifact, "original result");

	const current = { sessionId: first, cursor: 1, cwd, head: "user:1", tail: "user:1" };
	const next = prepareSession(current, [{ role: "user", content: "different", timestamp: 4 }], cwd);
	assert.notEqual(next, first);
	assert.equal(readFileSync(oldPath, "utf8"), previousHistory);
	assert.equal(readFileSync(artifact, "utf8"), "original result");
	assert.match(readFileSync(getSessionPath(next, cwd, claudeDir), "utf8"), /different/);
});
