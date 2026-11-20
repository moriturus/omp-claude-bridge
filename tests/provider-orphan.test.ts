// Provider-path regression tests. Runs under `bun test` because src/index.ts
// transitively imports Bun-only OMP runtime modules.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, open: () => resolve() };
}

const releaseParent = gate();

// Parent query: streams "Hel", waits, then streams "lo" and finishes.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	createSdkMcpServer: () => ({}),
	query: () => {
		async function* run() {
			yield { type: "system", subtype: "init", session_id: "parent-session" };
			yield { type: "stream_event", event: { type: "message_start", message: {} } };
			yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
			yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } };
			await releaseParent.promise;
			yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } };
			yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
			yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } };
			yield { type: "stream_event", event: { type: "message_stop" } };
			yield { type: "result", subtype: "success", is_error: false, result: "Hello" };
		}
		const iterator = run();
		return Object.assign(iterator, { interrupt: async () => {}, close: () => {} });
	},
}));
// Dynamic import: the SDK mock above must be registered before index.ts loads.
const { __test } = await import("../src/index.ts");

const model = {
	id: "claude-sonnet-4-6", name: "Sonnet", api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000, maxTokens: 16_000,
};

const lateChildResultContext = {
	messages: [
		{ role: "user", content: "child task", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "child_call", name: "read", arguments: {} }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "child_call", content: [{ type: "text", text: "late" }], isError: false, timestamp: 3 },
	],
};

let claudeDir = "";
beforeAll(() => {
	claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-orphan-"));
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	__test.resetSharedSession();
});
afterAll(() => {
	__test.resetSharedSession();
	rmSync(claudeDir, { recursive: true, force: true });
});

test("a late orphan toolResult neither wipes a streaming parent's output nor moves the shared cursor", async () => {
	const cwd = join(claudeDir, "project");
	const parentStream = __test.streamClaudeAgentSdk(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { cwd });

	const sawFirstDelta = gate();
	const deltas: string[] = [];
	const parentDone = (async () => {
		for await (const event of parentStream) {
			if (event.type === "text_delta") {
				deltas.push(event.delta);
				sawFirstDelta.open();
			}
		}
		return parentStream.result();
	})();

	// Parent is mid-stream when the unowned child result arrives.
	await sawFirstDelta.promise;
	const orphanWhileStreaming = await __test.streamClaudeAgentSdk(model, lateChildResultContext, { cwd }).result();
	expect(orphanWhileStreaming.stopReason).toBe("stop");
	expect(orphanWhileStreaming.content).toEqual([]);

	releaseParent.open();
	const parentMessage = await parentDone;
	expect(deltas).toEqual(["Hel", "lo"]);
	expect(parentMessage.content).toEqual([{ type: "text", text: "Hello" }]);

	// Parent finished: the shared cursor reflects the parent's history only.
	const sharedAfterParent = __test.getSharedSession();
	expect(sharedAfterParent).toEqual({ sessionId: "parent-session", cursor: 1, cwd });

	const orphanAfterParent = await __test.streamClaudeAgentSdk(model, lateChildResultContext, { cwd }).result();
	expect(orphanAfterParent.content).toEqual([]);
	expect(__test.getSharedSession()).toEqual(sharedAfterParent);
});
