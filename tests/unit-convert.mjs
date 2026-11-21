import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, getSessionPath } from "cc-session-io";
import { convertPiMessages } from "../src/convert.ts";
import { prepareSession } from "../src/session-sync.ts";

const NOTICE = "<system-notice>xd:// device inventory changed</system-notice>";

test("developer messages are forwarded as user turns", () => {
	const { anthropicMessages } = convertPiMessages([
		{ role: "developer", content: [{ type: "text", text: NOTICE }], timestamp: 0 },
		{ role: "developer", content: "plain string notice", timestamp: 1 },
	]);

	assert.deepEqual(anthropicMessages, [
		{ role: "user", content: [{ type: "text", text: NOTICE }] },
		{ role: "user", content: "plain string notice" },
	]);
});

test("non-user messages without content are dropped", () => {
	const { anthropicMessages } = convertPiMessages([
		{ role: "developer", content: [], timestamp: 0 },
		{ role: "custom", content: "", timestamp: 1 },
		{ role: "custom", timestamp: 2 },
	]);

	assert.deepEqual(anthropicMessages, []);
});

test("user messages keep their placeholders for empty content", () => {
	const { anthropicMessages } = convertPiMessages([
		{ role: "user", content: "", timestamp: 0 },
		{ role: "user", content: [], timestamp: 1 },
		{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 2 },
	]);

	assert.deepEqual(anthropicMessages, [
		{ role: "user", content: "[empty]" },
		{ role: "user", content: "[image]" },
		{ role: "user", content: [{ type: "text", text: "hi" }] },
	]);
});

// Regression: a hidden notice before the first user prompt used to convert to
// zero records, so save() wrote no JSONL and Claude Code's --resume failed with
// "No conversation found with session ID".
test("a developer-only history produces a resumable session file", (t) => {
	const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-convert-"));
	t.after(() => rmSync(claudeDir, { recursive: true, force: true }));

	const { anthropicMessages } = convertPiMessages([
		{ role: "developer", content: [{ type: "text", text: NOTICE }], timestamp: 0 },
	]);
	const session = createSession({ projectPath: join(claudeDir, "project"), claudeDir });
	session.importMessages(anthropicMessages);
	session.save();

	assert.equal(session.messages.length, 1);
	assert.ok(existsSync(session.jsonlPath));
});

test("assistant thinking signatures are preserved for anthropic-messages api", () => {
	const { anthropicMessages } = convertPiMessages([
		{
			role: "assistant",
			provider: "anthropic",
			api: "anthropic-messages",
			content: [
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig-123" },
				{ type: "text", text: "done" },
			],
			timestamp: 0,
		},
	]);

	assert.deepEqual(anthropicMessages, [
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan", signature: "sig-123" },
				{ type: "text", text: "done" },
			],
		},
	]);
});

test("toolResult preserves image blocks alongside text", () => {
	const { anthropicMessages } = convertPiMessages([
		{
			role: "toolResult",
			toolCallId: "call_1",
			isError: false,
			content: [
				{ type: "text", text: "screenshot" },
				{ type: "image", mimeType: "image/png", data: "AAAA" },
			],
			timestamp: 0,
		},
	]);

	assert.deepEqual(anthropicMessages, [
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "call_1",
					is_error: false,
					content: [
						{ type: "text", text: "screenshot" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
					],
				},
			],
		},
	]);
});

test("parallel tool results are persisted once each instead of being replaced by synthetic errors", (t) => {
	const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-parallel-"));
	const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	t.after(() => {
		if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
		rmSync(claudeDir, { recursive: true, force: true });
	});

	const projectDir = join(claudeDir, "project");
	const sessionId = prepareSession(undefined, [
		{ role: "user", content: "read both", timestamp: 0 },
		{
			role: "assistant",
			provider: "claude-bridge",
			api: "claude-bridge",
			content: [
				{ type: "toolCall", id: "call_A", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "call_B", name: "read", arguments: { path: "b" } },
			],
			timestamp: 1,
		},
		{ role: "toolResult", toolCallId: "call_A", content: [{ type: "text", text: "result A" }], isError: false, timestamp: 2 },
		{ role: "toolResult", toolCallId: "call_B", content: [{ type: "text", text: "result B" }], isError: false, timestamp: 3 },
	], projectDir);

	const records = readFileSync(getSessionPath(sessionId, projectDir, claudeDir), "utf8")
		.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const toolResults = records.flatMap((r) => Array.isArray(r.message?.content) ? r.message.content : [])
		.filter((b) => b.type === "tool_result");

	assert.deepEqual(toolResults.map((b) => [b.tool_use_id, b.content, b.is_error ?? false]), [
		["call_A", "result A", false],
		["call_B", "result B", false],
	]);
});
