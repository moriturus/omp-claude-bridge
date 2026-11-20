import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSessionPath } from "cc-session-io";
import {
	cleanupReentrantSession,
	syncSessionForQuery,
} from "../src/session-sync.ts";

test("reentrant child query syncs with an isolated session ID and keeps parent JSONL and cursor immutable end-to-end", (t) => {
	const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-reentrant-"));
	const projectDir = join(claudeDir, "project");
	const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;

	t.after(() => {
		if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
		rmSync(claudeDir, { recursive: true, force: true });
	});

	let sharedSession = null;
	const store = {
		get: () => sharedSession,
		set: (state) => { sharedSession = state; },
	};

	// 1. Parent establishes sharedSession with persisted JSONL (cursor = 2)
	const parentMessages = [
		{ role: "user", content: "parent turn 1", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "parent reply 1" }], provider: "claude-bridge", api: "claude-bridge", timestamp: 2 },
		{ role: "user", content: "parent turn 2", timestamp: 3 },
	];
	const parentSync = syncSessionForQuery(store, parentMessages, projectDir, {
		isReentrant: false,
		modelId: "claude-sonnet-4-6",
	});
	assert.ok(parentSync.sessionId, "parent should create a shared session");
	const parentSessionId = parentSync.sessionId;
	const parentJsonlPath = getSessionPath(parentSessionId, projectDir, claudeDir);
	assert.ok(existsSync(parentJsonlPath), "parent JSONL should exist");
	const parentJsonlBefore = readFileSync(parentJsonlPath, "utf8");
	assert.equal(sharedSession?.cursor, 2);

	// 2. Reentrant child starts with a longer diverging history (5 messages, 4 priors > parent cursor 2)
	//    that would previously trigger Case 4 REBUILD and delete the parent JSONL.
	const childMessages = [
		{ role: "user", content: "child u1", timestamp: 10 },
		{ role: "assistant", content: [{ type: "text", text: "child a1" }], timestamp: 11 },
		{ role: "user", content: "child u2", timestamp: 12 },
		{ role: "assistant", content: [{ type: "text", text: "child a2" }], timestamp: 13 },
		{ role: "user", content: "child u3", timestamp: 14 },
	];
	const childSync = syncSessionForQuery(store, childMessages, projectDir, {
		isReentrant: true,
		modelId: "claude-sonnet-4-6",
	});

	assert.ok(childSync.sessionId, "reentrant child with prior messages should sync to its own session");
	assert.equal(childSync.preserveSharedSession, true);
	assert.notEqual(childSync.sessionId, parentSessionId, "child session ID must differ from parent");
	const childJsonlPath = getSessionPath(childSync.sessionId, projectDir, claudeDir);
	assert.ok(existsSync(childJsonlPath), "child isolated JSONL should exist");

	// Parent JSONL and sharedSession must be untouched right after child start
	assert.equal(readFileSync(parentJsonlPath, "utf8"), parentJsonlBefore);
	assert.deepEqual(sharedSession, { sessionId: parentSessionId, cursor: 2, cwd: projectDir });

	// 3. Child completes and cleans up its isolated session — parent JSONL and cursor stay intact
	cleanupReentrantSession(store, true, [childSync.sessionId, parentSessionId], projectDir);
	assert.equal(existsSync(childJsonlPath), false, "child isolated JSONL should be deleted on cleanup");
	assert.ok(existsSync(parentJsonlPath), "parent JSONL must remain intact");
	assert.equal(readFileSync(parentJsonlPath, "utf8"), parentJsonlBefore);
	assert.deepEqual(sharedSession, { sessionId: parentSessionId, cursor: 2, cwd: projectDir });
});
