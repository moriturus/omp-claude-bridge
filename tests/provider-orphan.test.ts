// Provider-path regression tests. Runs under `bun test` because src/index.ts
// transitively imports Bun-only OMP runtime modules.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSecretsEnabled } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import type { AssistantMessage, Context, Model, ProviderSessionState } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import { getSessionPath } from "cc-session-io";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, open: () => resolve() };
}

type QueryRequest = { prompt: string | AsyncIterable<SDKUserMessage>; options: Options };
type QueryPlan = (request: QueryRequest) => AsyncGenerator<{ type: string } & Record<string, unknown>>;
let queryPlan: QueryPlan | undefined;
let sdkHasUsage = false;
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
		return Object.assign(iterator, {
			interrupt: async () => {},
			close: () => {},
			...(sdkHasUsage ? {
				async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
					// Claude Code rejects live usage in essential-traffic-only mode.
					const env = request.options.env ?? process.env;
					return {
						rate_limits_available: true,
						rate_limits: env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ? null : {
							five_hour: { utilization: 42, resets_at: null },
						},
					};
				},
			} : {}),
		});
	},
}));
// Dynamic import: the SDK mock above must be registered before index.ts loads.
const debugDir = mkdtempSync(join(tmpdir(), "claude-bridge-debug-"));
const debugPath = join(debugDir, "bridge.log");
const debugEnv = { CLAUDE_BRIDGE_DEBUG: "1", CLAUDE_BRIDGE_DEBUG_PATH: debugPath };
const previousDebugEnv = Object.fromEntries(Object.keys(debugEnv).map((key) => [key, process.env[key]]));
Object.assign(process.env, debugEnv);
const { __test, default: activate } = await import("../src/index.ts");
for (const [key, value] of Object.entries(previousDebugEnv)) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

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
	rmSync(debugDir, { recursive: true, force: true });
});

test.each([
	["an SDK without the experimental usage method reports no quota", false, undefined, null],
	["subscription usage works without a cached report", true, undefined, 42],
	["an explicit essential-traffic-only setting is respected", true, "1", null],
] as const)("%s", async (_name, supported, traffic, expectedUsed) => {
	const previous = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
	if (traffic === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
	else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = traffic;
	sdkHasUsage = supported;
	try {
		let usage: NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["usage"]>;
		activate({
			on() {},
			registerProvider(_name, config) { usage = config.usage!; },
			registerTool() {},
		} satisfies Pick<ExtensionAPI, "on" | "registerProvider" | "registerTool"> as ExtensionAPI);

		const report = await usage!.fetchUsage({ provider: "claude-bridge", credential: { type: "api_key" } }, { fetch });
		expect(report?.limits[0]?.amount.used ?? null).toBe(expectedUsed);
	} finally {
		sdkHasUsage = false;
		if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		else process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = previous;
	}
});

test.each([
	["standalone completions use the caller's prompt", false, false],
	["session turns keep the Claude Code preset", true, false],
	["standalone completions do not forward a custom prompt under secret protection", false, true],
] as const)("%s", async (_name, stateful, protectSecrets) => {
	const systemPrompt = ["Write a short label for this task.", "Return only the label."];
	const options = useProvider("label");
	const settings = Settings.isolated();
	cfgSecretsEnabled.set(settings, protectSecrets);
	queryPlan = answer;
	try {
		await withActiveSettings(settings, () => __test.streamClaudeAgentSdk(
			model, { systemPrompt, messages: [user("review the release notes")] },
			{ ...options, providerSessionState: stateful ? options.providerSessionState : undefined, disableReasoning: true },
		).result());
		const sent = requests.at(-1)?.options.systemPrompt;
		if (stateful || protectSecrets) expect(sent).toMatchObject({ type: "preset", preset: "claude_code" });
		else expect(sent).toEqual(systemPrompt);
	} finally {
		queryPlan = undefined;
	}
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

test("prediction and recap fork without replacing the main Claude conversation", async () => {
	const options = useProvider("main");
	const first = user("initial", 1);
	queryPlan = async function* ({ options: request }) {
		const id = request.forkSession ? "side-claude" : request.resume ?? "main-claude";
		yield { type: "result", subtype: "success", is_error: false, result: id, session_id: id };
	};
	try {
		const reply = await __test.streamClaudeAgentSdk(model, { messages: [first] }, options).result();
		const history = [first, reply];
		for (const [index, prompt] of ["predict the next input", "recap the session"].entries()) {
			const side = await __test.streamClaudeAgentSdk(model, { messages: [...history, user(prompt, index + 2)] }, {
				...options, sessionId: `main:side:${index}`, parentSessionId: options.sessionId,
			}).result();
			expect(textOf(side)).toBe("side-claude");
			expect(requests.at(-1)?.options.resume).toBe("main-claude");
		}
		const next = await __test.streamClaudeAgentSdk(model, { messages: [...history, user("continue", 4)] }, options).result();
		expect(textOf(next)).toBe("main-claude");
		expect(requests.at(-1)?.options.resume).toBe("main-claude");
	} finally {
		queryPlan = undefined;
	}
});

test.each([false, true])("tool continuation cancels before or after dispatch (already aborted: %s)", async (alreadyAborted) => {
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
		if (alreadyAborted) continuation.abort();
		const result = __test.streamClaudeAgentSdk(model, { tools, messages: [first, call, {
			role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 2,
		}] }, { ...options, signal: continuation.signal }).result();
		if (!alreadyAborted) continuation.abort();
		const outcome = await Promise.race([
			result.then((output) => output.stopReason),
			setImmediate("still waiting for SDK"),
		]);
		expect(outcome).toBe("aborted");

		queryPlan = async function* ({ options }) {
			const result = options.mcpServers?.["custom-tools"] ? "read available" : "read unavailable";
			yield { type: "result", subtype: "success", is_error: false, result };
		};
		const next = await __test.streamClaudeAgentSdk(model, { messages: [user("try again")], tools }, options).result();
		expect(textOf(next)).toBe("read available");
	} finally {
		waiting.open();
		queryPlan = undefined;
	}
});

test("a compacted tool turn imports its result without feeding the old Claude query", async () => {
	const options = useProvider("compact-continuation");
	const tools = [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }] as Context["tools"];
	const intro: Context["messages"][number] = { role: "developer", content: [{ type: "text", text: "persistent instructions" }], timestamp: 1 };
	const waiting = gate();
	const oldResult = Promise.withResolvers<unknown>();
	queryPlan = async function* ({ options: sdk }) {
		if (sdk.resume) {
			const transcript = readFileSync(getSessionPath(sdk.resume, options.cwd, claudeDir), "utf8");
			expect(transcript).toContain("summary of the earlier conversation");
			expect(transcript).not.toContain("discarded full history");
			expect(transcript).toContain('"type":"tool_result"');
			expect(transcript.match(/the actual file contents/g)).toHaveLength(1);
			expect(sdk.mcpServers?.["custom-tools"]).toBeDefined();
			const events = [
				{ id: "first", usage: { input_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 7 } },
				{ id: "second", usage: { input_tokens: 2, cache_read_input_tokens: 40, cache_creation_input_tokens: 8 } },
			];
			for (const message of events) yield { type: "stream_event", event: { type: "message_start", message } };
			yield { type: "result", subtype: "success", is_error: false, result: "answered from compacted history" };
			return;
		}
		yield { type: "system", subtype: "init", session_id: "old-uncompacted-session" };
		yield { type: "assistant", message: { id: "call", content: [
			{ type: "tool_use", id: "call_compact", name: "mcp__custom-tools__read", input: {} },
		] } };
		const decision = await sdk.canUseTool!("mcp__custom-tools__read", {}, {
			signal: new AbortController().signal, toolUseID: "call_compact", mcpServer: { name: "custom-tools", source: "sdk" },
		});
		if (decision.behavior !== "allow") throw new Error("The bridge rejected its own tool");
		const server = sdk.mcpServers?.["custom-tools"];
		if (!server || !("instance" in server)) throw new Error("Expected an SDK MCP server");
		const instance = server.instance as unknown as { tools: { handler(input: object): Promise<unknown> }[] };
		const result = instance.tools[0].handler(decision.updatedInput ?? {});
		waiting.open();
		oldResult.resolve(await result);
		yield { type: "result", subtype: "success", is_error: false, result: "answered from the old history" };
	};
	try {
		const call = await __test.streamClaudeAgentSdk(model, { messages: [intro, user("discarded full history", 2)], tools }, options).result();
		expect(call.stopReason).toBe("toolUse");
		await waiting.promise;
		const logOffset = readFileSync(debugPath, "utf8").length;
		const summary = { ...user("summary of the earlier conversation", 3), role: "user" as const, historyRewriteAt: 3 };
		const outcome = await __test.streamClaudeAgentSdk(model, { tools, messages: [intro, summary, call, {
			role: "toolResult", toolCallId: "call_compact", toolName: "read", content: [{ type: "text", text: "the actual file contents" }], isError: false, timestamp: 4,
		}] }, options).result();
		expect(textOf(outcome)).toBe("answered from compacted history");
		expect(await oldResult.promise).toMatchObject({ isError: true });
		expect(outcome.usage.totalTokens).toBe(80);
		const log = readFileSync(debugPath, "utf8").slice(logOffset);
		expect(log).toContain("syncResult: path=rebuild");
		expect(log).toMatch(/usage: requestInput=30\b[^\n]*cumulativeTotal=30\b/);
		expect(log).toMatch(/usage: requestInput=50\b[^\n]*cumulativeTotal=80\b/);
	} finally {
		queryPlan = undefined;
	}
});

test.each(["assistant", "stream_event"])("the SDK result supplies missing final answer text after an external tool (%s)", async (kind) => {
	queryPlan = async function* () {
		yield { type: "assistant", message: { id: "external", content: [
			{ type: "text", text: "Looking up. " },
			{ type: "tool_use", name: "mcp__remote__fetch", id: "lookup", input: {} },
		] } };
		const thinking = { type: "thinking", thinking: "reasoning", signature: "sig" };
		if (kind === "stream_event") {
			yield { type: "stream_event", event: { type: "message_start", message: { id: "final", usage: {} } } };
			yield { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: thinking } };
			yield { type: "stream_event", event: { type: "content_block_stop", index: 0 } };
		}
		yield { type: "assistant", message: { id: "final", content: [thinking] } };
		yield { type: "result", subtype: "success", is_error: false, result: "visible answer" };
	};
	try {
		const output = await __test.streamClaudeAgentSdk(model, { messages: [user("answer")] }, useProvider("result-text")).result();
		expect(textOf(output)).toBe("Looking up. visible answer");
	} finally {
		queryPlan = undefined;
	}
});

test("the provider does not send raw project instructions with secret protection active", async () => {
	const cwd = join(claudeDir, "protected-project");
	mkdirSync(cwd);
	const marker = "RAW_PROJECT_SECRET_FIXTURE";
	writeFileSync(join(cwd, "AGENTS.md"), `Synthetic instruction containing ${marker}`);
	const settings = Settings.isolated();
	cfgSecretsEnabled.set(settings, true);
	queryPlan = async function* ({ options }) {
		const prompt = options.systemPrompt;
		const result = typeof prompt === "object" && prompt.append?.includes(marker) ? "raw instructions received" : "no raw instructions";
		yield { type: "result", subtype: "success", is_error: false, result };
	};
	try {
		const output = await withActiveSettings(settings, () =>
			__test.streamClaudeAgentSdk(model, { messages: [user("answer")] }, { cwd }).result());
		expect(textOf(output)).toBe("no raw instructions");
	} finally {
		queryPlan = undefined;
	}
});

test("secret protection rebuilds previously unprotected Claude history", async () => {
	const options = useProvider("protected-resume");
	const original = user("original secret fixture", 1);
	queryPlan = answer;
	try {
		const previous = await __test.streamClaudeAgentSdk(model, { messages: [original] }, options).result();
		const settings = Settings.isolated();
		cfgSecretsEnabled.set(settings, true);
		queryPlan = async function* (request) {
			const id = request.options.resume;
			const transcript = id && id !== "test-session" ? readFileSync(getSessionPath(id, options.cwd, claudeDir), "utf8") : "";
			const result = transcript.includes("protected placeholder") && !transcript.includes("original secret fixture") ? "protected" : "stale history";
			yield { type: "result", subtype: "success", is_error: false, result };
		};
		const messages = [{ ...original, content: "protected placeholder" }, previous, user("again", 2)];
		const output = await withActiveSettings(settings, () => __test.streamClaudeAgentSdk(model, { messages }, options).result());
		expect(textOf(output)).toBe("protected");
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

test("Claude can discover OMP tool commands through its bridged bash tool", async () => {
	const options = useProvider("tool-commands");
	const context: Context = {
		messages: [user("find the mounted tools")],
		tools: [{ name: "bash", description: "Run a shell command", parameters: { type: "object", properties: {} } }] as Context["tools"],
		systemPrompt: [
			"# Tool Commands\nEach listed tool is also a command in `bash`: run `<tool> --help`.\n\n## More commands (help on demand)\n- `ast` — Search syntax trees\n\n⁂ Tool Policy\nUnrelated host policy",
			"<project-context>\nUnrelated project context\n</project-context>\n\n## MCP Tool Commands\n\nRun each as a command with the bash tool.\n- fixture search → `mcp__fixture__search` — Search fixtures\n\n## MCP Server Instructions\nUnrelated server instructions",
		],
	};
	queryPlan = answer;
	try {
		const output = await __test.streamClaudeAgentSdk(model, context, options).result();
		expect(textOf(output)).toBe("answered");
		const server = requests.at(-1)?.options.mcpServers?.["custom-tools"];
		expect(server).toHaveProperty("instance");
		if (!server || !("instance" in server)) throw new Error("Expected an SDK MCP server");
		// The SDK mock above stores its original tool definitions as the instance.
		const instance = server.instance as unknown as { tools: { name: string; description: string }[] };
		const bash = instance.tools.find((tool) => tool.name === "bash");
		expect(bash?.description).toContain("`mcp__custom-tools__bash`");
		expect(bash?.description).toContain("`ast` — Search syntax trees");
		expect(bash?.description).toContain("`mcp__fixture__search` — Search fixtures");
		expect(bash?.description).not.toContain("Unrelated");
		await __test.streamClaudeAgentSdk(model, context, { ...options, toolChoice: "none" }).result();
		expect(requests.at(-1)?.options.mcpServers).toBeUndefined();
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

test("AskClaude does not bypass active secret protection", async () => {
	let tool: Parameters<ExtensionAPI["registerTool"]>[0];
	activate({ on() {}, registerProvider() {}, registerTool(definition: typeof tool) { tool = definition; } } as unknown as ExtensionAPI);
	const settings = Settings.isolated();
	cfgSecretsEnabled.set(settings, true);
	const ctx = { cwd: join(claudeDir, "protected-worktree"), getSystemPrompt: () => [] } as unknown as Parameters<typeof tool.execute>[4];
	queryPlan = answer;
	try {
		const result = await withActiveSettings(settings, () => tool.execute(
			"protected", { prompt: "delegate", mode: "none", isolated: true }, undefined, undefined, ctx,
		));
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("secret protection") }]);
	} finally {
		queryPlan = undefined;
	}
});

test("AskClaude cannot run full mode in a worktree that forbids it", async () => {
	const previousHome = process.env.HOME;
	process.env.HOME = claudeDir;
	const cwd = join(claudeDir, "restricted-worktree");
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	writeFileSync(join(cwd, ".omp", "claude-bridge.json"), JSON.stringify({ askClaude: { allowFullMode: false } }));
	let tool: Parameters<ExtensionAPI["registerTool"]>[0];
	queryPlan = answer;
	try {
		activate({ on() {}, registerProvider() {}, registerTool(definition: typeof tool) { tool = definition; } } as unknown as ExtensionAPI);
		const ctx = { cwd, getSystemPrompt: () => [] } as unknown as Parameters<typeof tool.execute>[4];
		const result = await tool.execute("restricted", { prompt: "delegate", mode: "full", isolated: true }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("full mode is disabled") }]);
	} finally {
		queryPlan = undefined;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});

test("AskClaude receives current compaction history and removes only its temporary copy", async () => {
	let tool: Parameters<ExtensionAPI["registerTool"]>[0];
	activate({ on() {}, registerProvider() {}, registerTool(definition: typeof tool) { tool = definition; } } as unknown as ExtensionAPI);
	const before = user("discarded verbatim context");
	const cwd = join(claudeDir, "project");
	const branch = [
		{ type: "message", id: "before", parentId: null, timestamp: "2026-07-01T00:00:00Z", message: before },
		{ type: "compaction", id: "compact", parentId: "before", timestamp: "2026-07-01T00:01:00Z", summary: "maintain the existing build contract", firstKeptEntryId: "", tokensBefore: 500 },
		{ type: "message", id: "prior-decision", parentId: "compact", timestamp: "2026-07-01T00:02:00Z", message: user("preserve this cross-provider decision", 12) },
		{ type: "compaction", id: "remote", parentId: "prior-decision", timestamp: "2026-07-01T00:03:00Z", summary: "provider-only summary", firstKeptEntryId: "", tokensBefore: 600, preserveData: {
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [],
				compactionItem: { type: "compaction", encrypted_content: "opaque fixture" },
			},
		} },
		{ type: "message", id: "latest", parentId: "remote", timestamp: "2026-07-01T00:04:00Z", message: user("latest decision", 13) },
	];
	const ctx = { cwd, getSystemPrompt: () => [], sessionManager: { getBranch: () => branch } } as unknown as Parameters<typeof tool.execute>[4];
	let temporaryFile: string | undefined;
	queryPlan = async function* ({ options }) {
		temporaryFile = getSessionPath(options.resume!, cwd, claudeDir);
		const transcript = readFileSync(temporaryFile, "utf8");
		expect(transcript).toContain("maintain the existing build contract");
		expect(transcript).toContain("latest decision");
		expect(transcript).toContain("preserve this cross-provider decision");
		expect(transcript).not.toContain("provider-only summary");
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
