// Provider-path regression tests. Runs under `bun test` because src/index.ts
// transitively imports Bun-only OMP runtime modules.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage, Context, Model, ProviderSessionState } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import { getSessionPath } from "cc-session-io";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, open: () => resolve() };
}

type QueryRequest = { prompt: string | AsyncIterable<SDKUserMessage>; options: Options };
type QueryPlan = (request: QueryRequest) => AsyncGenerator<{ type: string } & Record<string, unknown>>;
let queryPlan: QueryPlan | undefined;
const requests: QueryRequest[] = [];

const releaseParent = gate();

// Parent query: streams "Hel", waits, then streams "lo" and finishes.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	createSdkMcpServer: (definition: unknown) => ({ instance: definition }),
	query: (request: QueryRequest) => {
		requests.push(request);
		async function* run() {
			yield { type: "system", subtype: "init", session_id: "parent-session" };
			yield { type: "stream_event", event: { type: "message_start", message: { id: "m-parent", usage: {} } } };
			yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
			yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } };
			await releaseParent.promise;
			yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } };
			yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
			yield { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } };
			yield { type: "stream_event", event: { type: "message_stop" } };
			yield { type: "result", subtype: "success", is_error: false, result: "Hello" };
		}
		const iterator = queryPlan?.(request) ?? run();
		return Object.assign(iterator, { interrupt: async () => {}, close: () => {} });
	},
}));
// Dynamic import: the SDK mock above must be registered before index.ts loads.
const { __test, default: activate } = await import("../src/index.ts");

const model: Model = {
	id: "claude-sonnet-4-6", name: "Sonnet", api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000, maxTokens: 16_000,
};

const lateChildResultContext: Context = {
	messages: [
		{ role: "user", content: "child task", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "child_call", name: "read", arguments: {} }], timestamp: 2 } as AssistantMessage,
		{ role: "toolResult", toolCallId: "child_call", toolName: "read", content: [{ type: "text", text: "late" }], isError: false, timestamp: 3 },
	],
};

let claudeDir = "";
const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
beforeAll(() => {
	claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-provider-"));
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterAll(() => {
	if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
	rmSync(claudeDir, { recursive: true, force: true });
});

test("a child tool replay leaves the parent's active stream and transcript intact", async () => {
	const options = useProvider("parent");
	const first = user("hi");
	const parentStream = __test.streamClaudeAgentSdk(model, { messages: [first] }, options);

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

	await sawFirstDelta.promise;
	queryPlan = answer;
	try {
		const child = await __test.streamClaudeAgentSdk(model, lateChildResultContext, useProvider("child")).result();
		expect(textOf(child)).toBe("resumed");
		releaseParent.open();
		const parentMessage = await parentDone;
		expect(deltas).toEqual(["Hel", "lo"]);
		expect(textOf(parentMessage)).toBe("Hello");
		const next = await __test.streamClaudeAgentSdk(model, { messages: [first, parentMessage, user("again", 10)] }, options).result();
		expect(textOf(next)).toBe("resumed");
		expect(requests.at(-1)?.options.resume).toBe("parent-session");
	} finally {
		releaseParent.open();
		queryPlan = undefined;
	}
});

function user(content: string, timestamp = 0): Context["messages"][number] {
	return { role: "user", content, timestamp };
}

function textOf(output: AssistantMessage) {
	return output.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
}

function useProvider(sessionId: string, providerSessionState = new Map<string, ProviderSessionState>()) {
	return { cwd: join(claudeDir, "project"), sessionId, providerSessionState };
}

async function* answer(request: QueryRequest) {
	yield { type: "system", subtype: "init", session_id: "test-session" };
	yield { type: "result", subtype: "success", is_error: false, result: request.options.resume ? "resumed" : "answered" };
}

test("the active tool continuation observes its own cancellation signal", async () => {
	const waiting = gate();
	const initial = new AbortController();
	const continuation = new AbortController();
	const options = useProvider("cancel-continuation");
	const first = user("read a file");
	const tools = [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }] as Context["tools"];
	queryPlan = async function* () {
		yield { type: "assistant", message: { id: "tool", content: [
			{ type: "tool_use", id: "call", name: "mcp__custom-tools__read", input: {} },
		] } };
		await waiting.promise;
		yield { type: "result", subtype: "success", is_error: false, result: "finished" };
	};
	try {
		const call = await __test.streamClaudeAgentSdk(model, { messages: [first], tools }, { ...options, signal: initial.signal }).result();
		expect(call.stopReason).toBe("toolUse");
		const result = __test.streamClaudeAgentSdk(model, { tools, messages: [first, call, {
			role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 2,
		}] }, { ...options, signal: continuation.signal }).result();
		continuation.abort();
		waiting.open();
		expect((await result).stopReason).toBe("aborted");
	} finally {
		waiting.open();
		queryPlan = undefined;
	}
});

test("the SDK result supplies answer text when only thinking was streamed", async () => {
	queryPlan = async function* () {
		yield { type: "assistant", message: { id: "thinking", content: [
			{ type: "thinking", thinking: "reasoning", signature: "sig" },
		] } };
		yield { type: "result", subtype: "success", is_error: false, result: "visible answer" };
	};
	try {
		const output = await __test.streamClaudeAgentSdk(model, { messages: [user("answer")] }, useProvider("result-text")).result();
		expect(textOf(output)).toBe("visible answer");
	} finally {
		queryPlan = undefined;
	}
});

test("a replayed tool result makes a model call with its result in the imported history", async () => {
	queryPlan = answer;
	try {
		const options = useProvider("retry");
		const output = await __test.streamClaudeAgentSdk(model, lateChildResultContext, options).result();
		expect(textOf(output)).toBe("resumed");
		const resume = requests.at(-1)?.options.resume;
		expect(resume).toBeString();
		expect(readFileSync(getSessionPath(resume!, options.cwd, claudeDir), "utf8")).toContain("late");
	} finally {
		queryPlan = undefined;
	}
});

test("disposing a child session cannot invalidate the parent's Claude conversation", async () => {
	queryPlan = answer;
	try {
		const options = useProvider("parent");
		const child = useProvider("child");
		const first = user("initial");
		const output = await __test.streamClaudeAgentSdk(model, { messages: [first] }, options).result();
		await __test.streamClaudeAgentSdk(model, { messages: [user("child only")] }, child).result();
		for (const state of child.providerSessionState.values()) state.close();
		child.providerSessionState.clear();
		const next = await __test.streamClaudeAgentSdk(model, { messages: [first, output, user("again", 2)] }, options).result();
		expect(textOf(next)).toBe("resumed");
		expect(requests.at(-1)?.options.resume).toBe("test-session");
	} finally {
		queryPlan = undefined;
	}
});

test("AskClaude errors and early cancellation are tool failures", async () => {
	let tool: Parameters<ExtensionAPI["registerTool"]>[0];
	activate({ on() {}, registerProvider() {}, registerTool(definition: typeof tool) { tool = definition; } } as unknown as ExtensionAPI);
	const ctx = { cwd: join(claudeDir, "project"), getSystemPrompt: () => [] } as unknown as Parameters<typeof tool.execute>[4];
	queryPlan = async function* () {
		yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["provider rejected the query"] };
	};
	try {
		const result = await tool.execute("err", { prompt: "delegate", isolated: true }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		const before = requests.length;
		const cancelled = await tool.execute("abort", { prompt: "delegate", isolated: true }, AbortSignal.abort(), undefined, ctx);
		expect(cancelled.isError).toBe(true);
		expect(requests).toHaveLength(before);
	} finally {
		queryPlan = undefined;
	}
});

test("the native close boundary rebuilds /fresh history and does not resurrect /clear history", async () => {
	queryPlan = answer;
	try {
		const options = useProvider("original");
		const first = user("remember before reset");
		const reply = await __test.streamClaudeAgentSdk(model, { messages: [first] }, options).result();
		for (const state of options.providerSessionState.values()) state.close();
		options.providerSessionState.clear();
		const fresh = useProvider("fresh", options.providerSessionState);
		await __test.streamClaudeAgentSdk(model, { messages: [first, reply, user("after fresh", 3)] }, fresh).result();
		const resume = requests.at(-1)?.options.resume;
		expect(resume).toBeString();
		expect(resume).not.toBe("test-session");
		expect(readFileSync(getSessionPath(resume!, options.cwd, claudeDir), "utf8")).toContain("remember before reset");
		for (const state of options.providerSessionState.values()) state.close();
		options.providerSessionState.clear();
		const clear = useProvider("clear", options.providerSessionState);
		await __test.streamClaudeAgentSdk(model, { messages: [user("after clear", 4)] }, clear).result();
		expect(requests.at(-1)?.options.resume).toBeUndefined();
	} finally {
		queryPlan = undefined;
	}
});

test("a skipped MCP call cannot shift another result; external tools and steering stay on their own paths", async () => {
	const source = { name: "custom-tools", source: "sdk" };
	const local = "mcp__custom-tools__read";
	const input = { path: "example.txt" };
	const first = user("check both");
	const options = useProvider("tools");
	const tools = [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] as Context["tools"];
	const sent: SDKUserMessage[] = [];
	const observed = Promise.withResolvers<unknown>();
	queryPlan = async function* (request) {
		if (typeof request.prompt !== "string") {
			for await (const message of request.prompt) sent.push(message);
			yield { type: "result", subtype: "success", is_error: false, result: "steered" };
			return;
		}
		yield { type: "system", subtype: "init", session_id: "mcp-test-session" };
		yield { type: "stream_event", event: { type: "message_start", message: { id: "external", usage: {} } } };
		yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "mcp__remote__fetch", id: "external", input: {} } } };
		yield { type: "stream_event", event: { type: "message_stop" } };
		yield { type: "stream_event", event: { type: "message_start", message: { id: "bridge", usage: {} } } };
		for (const [index, id] of ["skipped", "accepted"].entries()) {
			yield { type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", name: local, id, input } } };
			yield { type: "stream_event", event: { type: "content_block_stop", index } };
		}
		yield { type: "stream_event", event: { type: "message_stop" } };
		const decision = await request.options.canUseTool!(local, input, {
			signal: new AbortController().signal, toolUseID: "accepted", mcpServer: source,
		});
		if (!decision || decision.behavior !== "allow") throw new Error("The bridge rejected its own tool");
		const server = request.options.mcpServers?.[source.name];
		if (!server || !("instance" in server)) throw new Error("Expected an SDK MCP server");
		const instance = server.instance as unknown as { tools: { handler(input: object): Promise<unknown> }[] };
		observed.resolve(await instance.tools[0].handler(decision.updatedInput ?? {}));
		yield { type: "result", subtype: "success", is_error: false, result: "original, " };
	};
	try {
		const toolTurn = await __test.streamClaudeAgentSdk(model, { messages: [first], tools }, options).result();
		expect(toolTurn.content.map((block) => block.type === "toolCall" && block.id)).toEqual(["skipped", "accepted"]);
		const messages: Context["messages"] = [
			first, toolTurn,
			{ role: "toolResult", toolCallId: "skipped", toolName: "read", content: [{ type: "text", text: "different result" }], isError: true, timestamp: 2 },
			{ role: "toolResult", toolCallId: "accepted", toolName: "read", content: [{ type: "text", text: "right result" }], isError: false, timestamp: 3 },
			user("first steer", 4),
			{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGk=" }, { type: "text", text: "second steer" }], timestamp: 5 },
		];
		const final = await __test.streamClaudeAgentSdk(model, { messages, tools }, options).result();
		expect(await observed.promise).toMatchObject({ content: [{ type: "text", text: "right result" }] });
		expect(textOf(final)).toBe("original, steered");
		expect(sent[0]?.message.content).toEqual([
			{ type: "text", text: "first steer" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
			{ type: "text", text: "second steer" },
		]);
	} finally {
		queryPlan = undefined;
	}
}, 2000);

test("AskClaude receives current compaction history and removes only its temporary copy", async () => {
	let tool: Parameters<ExtensionAPI["registerTool"]>[0];
	activate({ on() {}, registerProvider() {}, registerTool(definition: typeof tool) { tool = definition; } } as unknown as ExtensionAPI);
	const before = user("discarded verbatim context");
	const cwd = join(claudeDir, "project");
	const branch = [
		{ type: "message", id: "before", parentId: null, timestamp: "2026-07-01T00:00:00Z", message: before },
		{ type: "compaction", id: "compact", parentId: "before", timestamp: "2026-07-01T00:01:00Z", summary: "maintain the existing build contract", firstKeptEntryId: "", tokensBefore: 500 },
		{ type: "message", id: "latest", parentId: "compact", timestamp: "2026-07-01T00:02:00Z", message: user("latest decision", 12) },
	];
	const ctx = { cwd, getSystemPrompt: () => [], sessionManager: { getBranch: () => branch } } as unknown as Parameters<typeof tool.execute>[4];
	let temporaryFile: string | undefined;
	queryPlan = async function* ({ options }) {
		temporaryFile = getSessionPath(options.resume!, cwd, claudeDir);
		const transcript = readFileSync(temporaryFile, "utf8");
		expect(transcript).toContain("maintain the existing build contract");
		expect(transcript).toContain("latest decision");
		expect(transcript).not.toContain("discarded verbatim context");
		expect(options.thinking).toEqual({ type: "disabled" });
		yield { type: "result", subtype: "success", is_error: false, result: "review complete" };
	};
	try {
		const result = await tool.execute("history", { prompt: "review latest decision", thinking: "off" }, undefined, undefined, ctx);
		expect(result.content).toEqual([{ type: "text", text: "review complete" }]);
		expect(() => readFileSync(temporaryFile!)).toThrow("ENOENT");
	} finally {
		queryPlan = undefined;
	}
});
