import { createAssistantMessageEventStream as newAssistantMessageEventStream, StringEnum, Type, getModels, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool, type Usage } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import { type ExtensionAPI, type ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSecretsEnabled } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { compact, defaultConvertToLlm } from "@oh-my-pi/pi-agent-core/compaction";
import { createSdkMcpServer, query, type EffortLevel, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import * as tui from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";
import { deleteSession } from "cc-session-io";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { z } from "zod";
import { convertPiMessages, PROVIDER_ID } from "./convert.js";
import { buildModels, resolveModel as _resolveModel } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, extractSkillsBlock } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext } from "./query-state.js";
import { loadConfig, resolveAskClaudeModes } from "./config.js";
import { askClaudePolicy } from "./askclaude-policy.js";
import { extractAgentsAppend } from "./agents-md.js";
import { jsonSchemaToZodShape } from "./typebox-to-zod.js";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.js";
import { rateLimitNotice } from "./rate-limit.js";
import { messageAnchor, prepareSession, type SessionState } from "./session-sync.js";
import { claudeUsageProvider } from "./usage.js";

type AskClaudeTheme = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>>[2];
type AskClaudeSpan = { text: string; color: Parameters<AskClaudeTheme["fg"]>[0]; bold?: true };

function renderAskClaude(theme: AskClaudeTheme, spans: AskClaudeSpan[]): InstanceType<typeof tui.Text> {
	// OMP 19.2's host accepts nodes; the 19.1 development types still describe Text.
	if ("jsx" in tui && typeof tui.jsx === "function") {
		return tui.jsx("text", {
			wrap: "word",
			spans: spans.map(({ text, color, bold }) => ({ t: sanitizeText(text), s: bold ? `${color} strong` : color })),
		}) as InstanceType<typeof tui.Text>;
	}
	return new tui.Text(spans.map(({ text, color, bold }) => theme.fg(color, bold ? theme.bold(text) : text)).join(""), 0, 0);
}

function calculateCost(model: Model, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
	usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.omp/agent/claude-bridge.log

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".omp", "agent", "claude-bridge.log");
const DIAG_LOG_PATH = join(homedir(), ".omp", "agent", "claude-bridge-diag.log");

if (DEBUG) {
	try { mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true }); } catch {}
}

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	try {
		const ts = new Date().toISOString();
		const msg = args.map((arg) => arg instanceof Error ? arg.stack ?? arg.message : typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
		appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
	} catch {
		// Diagnostics must not affect provider execution or stream finalization.
	}
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { return {}; }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	try {
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
		appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
	} catch {
		// Never crash a provider turn over diagnostic log I/O
	}
	debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

// --- Constants ---


const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const ANTHROPIC_MODELS = getModels("anthropic");
const MODELS = buildModels(ANTHROPIC_MODELS);

function resolveModel(input: string) {
	return _resolveModel(MODELS, input);
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

type SDKPrompt = string | ContentBlockParam[];

function promptFromMessages(messages: Context["messages"]): SDKPrompt | undefined {
	const { anthropicMessages } = convertPiMessages(messages);
	const blocks: ContentBlockParam[] = [];
	for (const { role, content } of anthropicMessages) {
		if (role !== "user") continue;
		if (typeof content === "string") {
			blocks.push({ type: "text", text: content });
		} else {
			for (const block of content) {
				if (block.type === "text") blocks.push(block);
				else if (block.type === "image" && block.source.type === "base64") {
					blocks.push(block as Extract<ContentBlockParam, { type: "image" }>);
				}
			}
		}
	}
	if (!blocks.length) return undefined;
	const first = blocks[0];
	return blocks.length === 1 && first.type === "text" ? first.text : blocks;
}

async function* wrapPromptStream(blocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	yield {
		type: "user",
		message: { role: "user", content: blocks } satisfies MessageParam,
		parent_tool_use_id: null,
	};
}

function newAssistantOutput(model: Model, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function systemPromptText(systemPrompt: Context["systemPrompt"] | string | undefined): string | undefined {
	if (!systemPrompt) return undefined;
	return Array.isArray(systemPrompt) ? systemPrompt.join("\n\n") : systemPrompt;
}


function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = promptFromMessages(messages);
	if (typeof promptText !== "string" || !promptText.trim()) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

function resultErrorText(message: SDKMessage): string {
	const result = message as SDKMessage & { subtype?: string; errors?: unknown; error?: unknown; result?: unknown };
	if (Array.isArray(result.errors) && result.errors.length > 0) return result.errors.map(String).join("\n");
	if (typeof result.error === "string" && result.error) return result.error;
	if (typeof result.result === "string" && result.result) return result.result;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

async function runIsolatedSummary(
	model: Model,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
	cwd: string,
): Promise<void> {
	let sdkQuery: Query | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = extractIsolatedSummaryPrompt(context.messages);
		const claudeExecutable = loadConfig(cwd).provider?.pathToClaudeCodeExecutable;
		debug(`compact summary: spawn model=${model.id} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				tools: [],
				strictMcpConfig: true,
				settingSources: [],
				skills: [],
				verbatimPrompts: true,
				persistSession: false,
				systemPrompt: context.systemPrompt,
				model: model.id,
				maxTurns: 1,
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of message.message.content) {
					if (block.type === "text") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				if (message.subtype === "success" && !message.is_error) {
					finalText = message.result || assistantText;
				} else {
					errorText = resultErrorText(message);
				}
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
		stream.end();
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

function reinjectPriorCompactionFileOps(branchEntries: Array<{ type: string; details?: unknown }>, preparation: { fileOps: { read: Set<string>; edited: Set<string> } }): void {
	const prior = [...branchEntries]
		.reverse()
		.find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
	debug(`compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`);
}

function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
	ui?: ExtensionUIContext,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		ui?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
			`Please copy and paste this message into a new issue at https://github.com/DevVig/omp-claude-bridge/issues/new` +
			(DEBUG ? ` and attach ${DEBUG_LOG_PATH}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

// @internal
export const __test = { streamClaudeAgentSdk };
// --- Provider helpers: tool name mapping ---

function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// Pi bash has no default timeout; add a safety default
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}

// --- Provider helpers: tool resolution ---

class BridgeSession {
	transcript?: SessionState;
	current?: QueryContext;
	ui?: ExtensionUIContext;
	protectSecrets?: boolean;

	close(): void {
		this.current?.abort();
		this.current = undefined;
		this.transcript = undefined;
	}
}

// The host's onPayload callback dispatches to the extension runner for the
// requesting session, including after /fresh changes the provider-facing ID.
const payloadSessions = new WeakMap<object, BridgeSession>();

function secretsEnabled(cwd: string): boolean {
	return cfgSecretsEnabled.get(findScopedSettings(cwd) ?? Settings.isolated());
}

function bashDescription(tool: Tool, systemPrompt: Context["systemPrompt"]): string {
	// shortcut: read OMP's rendered command sections until the provider context exposes a structured catalog.
	const commands = /^# Tool Commands\nEach listed tool is also a command in `[^`\n]+`: ([\s\S]*?)\n⁂ /m.exec(systemPrompt?.[0] ?? "")?.[1];
	const project = systemPrompt?.findLast((block) => block.startsWith("<project-context>\n"));
	const end = project?.lastIndexOf("\n</project-context>\n") ?? -1;
	const routes = end < 0 ? undefined : /^## MCP Tool Commands\n+(?:Run each as a command with the bash tool\.[^\n]*\n+)?((?:- [^\n]+\n*)*(?:Additional mounted MCP tools omitted:[^\n]+)?)/m.exec(project?.slice(end) ?? "")?.[1].trim();
	if (!commands && !routes) return tool.description;
	return [
		tool.description,
		`Run these OMP tool commands with \`${MCP_TOOL_PREFIX}bash\`, not Claude Code's shell.`,
		commands?.trim(),
		routes && `## MCP Tool Commands\n${routes}`,
	].filter(Boolean).join("\n\n");
}

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool.name === "bash" ? { ...tool, description: bashDescription(tool, context.systemPrompt) } : tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

const OMP_TOOL_USE_ID = "__omp_tool_use_id";

function buildMcpServers(tools: Tool[], run: QueryContext): Options["mcpServers"] {
	if (!tools.length) return undefined;
	const server = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		version: "1.0.0",
		alwaysLoad: true,
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: { ...jsonSchemaToZodShape(tool.parameters), [OMP_TOOL_USE_ID]: z.string().optional() },
			handler: async (args): Promise<McpResult> => {
				const id = args[OMP_TOOL_USE_ID];
				if (typeof id !== "string" || run.approvedToolCalls.get(id) !== tool.name) {
					return { isError: true, content: [{ type: "text", text: "Missing bridge tool invocation ID" }] };
				}
				run.approvedToolCalls.delete(id);
				const result = run.pendingResults.get(id);
				if (result) {
					run.pendingResults.delete(id);
					return result;
				}
				const { promise, resolve } = Promise.withResolvers<McpResult>();
				run.pendingToolCalls.set(id, resolve);
				return promise;
			},
		})),
	});
	server.tools = tools.map(({ name }) => ({ name, permission_policy: "always_ask" }));
	return { [MCP_SERVER_NAME]: server };
}

// --- Usage helpers ---

function updateUsage(output: AssistantMessage, usage: {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	reasoning_tokens?: number;
	thinking_tokens?: number;
}, model: Model, base?: Usage): void {
	if (usage.input_tokens != null) output.usage.input = (base?.input ?? 0) + usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = (base?.output ?? 0) + usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = (base?.cacheRead ?? 0) + usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = (base?.cacheWrite ?? 0) + usage.cache_creation_input_tokens;
	// Claude Code may report reasoning/thinking tokens separately, while pi's Usage type does not model that field.
	const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
	if (reasoning != null) (output.usage as typeof output.usage & { reasoning?: number }).reasoning = reasoning;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
function logServedContextWindow(label: string, message: Extract<SDKMessage, { type: "result" }>, model: Model): void {
	const { modelUsage } = message;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

// --- Effort level mapping ---
// OMP reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
};

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


function startTurn(run: QueryContext, model: Model, stream: AssistantMessageEventStream): void {
	run.resetTurnState(model);
	run.currentPiStream = stream;
}

function ensureTurnStarted(run: QueryContext): void {
	if (!run.turnStarted && run.currentPiStream && run.turnOutput) {
		run.currentPiStream.push({ type: "start", partial: run.turnOutput });
		run.turnStarted = true;
	}
}

function finishTurn(run: QueryContext, reason: "stop" | "length" | "toolUse" | "error" | "aborted", error?: string): void {
	const stream = run.currentPiStream;
	const output = run.turnOutput;
	if (!stream || !output) return;
	ensureTurnStarted(run);
	run.currentPiStream = null;
	output.stopReason = reason;
	if (reason === "error" || reason === "aborted") {
		output.errorMessage = error;
		stream.push({ type: "error", reason, error: output });
	} else {
		stream.push({ type: "done", reason, message: output });
	}
	stream.end();
}

function appendText(run: QueryContext, text: string): void {
	const stream = run.currentPiStream;
	const output = run.turnOutput;
	if (!stream || !output || !text) return;
	ensureTurnStarted(run);
	const index = run.turnBlocks.length;
	run.turnBlocks.push({ type: "text", text });
	stream.push({ type: "text_start", contentIndex: index, partial: output });
	stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
	stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
}

function processStreamEvent(
	event: Extract<SDKMessage, { type: "stream_event" }>["event"],
	toolNames: Map<string, string>,
	model: Model,
	run: QueryContext,
): void {
	const stream = run.currentPiStream;
	const output = run.turnOutput;
	if (!stream || !output) return;
	if (event.type === "message_start") {
		run.streamedMessageId = event.message.id;
		run.usageBase = { ...output.usage };
		updateUsage(output, event.message.usage, model, run.usageBase);
		return;
	}
	if (event.type === "content_block_start") {
		const block = event.content_block;
		const contentIndex = run.turnBlocks.length;
		if (block.type === "text") {
			ensureTurnStarted(run);
			run.turnBlocks.push({ type: "text", text: block.text, index: event.index });
			stream.push({ type: "text_start", contentIndex, partial: output });
		} else if (block.type === "thinking") {
			ensureTurnStarted(run);
			run.turnBlocks.push({ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature, index: event.index });
			stream.push({ type: "thinking_start", contentIndex, partial: output });
		} else if (block.type === "tool_use") {
			// Claude executes non-bridge tools itself. They never enter the OMP tool loop.
			const name = toolNames.get(block.name);
			if (!name) return;
			ensureTurnStarted(run);
			run.turnToolCallIds.add(block.id);
			run.turnBlocks.push({
				type: "toolCall", id: block.id, name,
				arguments: block.input as Record<string, unknown>, index: event.index,
			});
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
		}
		return;
	}
	if (event.type === "content_block_delta" || event.type === "content_block_stop") {
		const contentIndex = run.turnBlocks.findIndex((block) => block.index === event.index);
		const block = run.turnBlocks[contentIndex];
		if (!block) return;
		if (event.type === "content_block_delta") {
			const delta = event.delta;
			if (delta.type === "text_delta" && block.type === "text") {
				block.text += delta.text;
				stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
			} else if (delta.type === "thinking_delta" && block.type === "thinking") {
				block.thinking += delta.thinking;
				stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: output });
			} else if (delta.type === "signature_delta" && block.type === "thinking") {
				block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
			} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
				block.partialJson = (block.partialJson ?? "") + delta.partial_json;
				stream.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: output });
			}
			return;
		}
		delete block.index;
		if (block.type === "text") {
			stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
		} else if (block.type === "thinking") {
			stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
		} else if (block.type === "toolCall") {
			block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson ?? "", block.arguments));
			delete block.partialJson;
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
		}
		return;
	}
	if (event.type === "message_delta") {
		output.stopReason = mapStopReason(event.delta.stop_reason ?? undefined);
		if (event.usage) updateUsage(output, event.usage, model, run.usageBase);
	} else if (event.type === "message_stop" && run.turnToolCallIds.size) {
		finishTurn(run, "toolUse");
	}
}

function processAssistantMessage(message: Extract<SDKMessage, { type: "assistant" }>, toolNames: Map<string, string>, run: QueryContext): void {
	const stream = run.currentPiStream;
	const output = run.turnOutput;
	if (!stream || !output || message.message.id === run.streamedMessageId) return;
	for (const block of message.message.content) {
		if (block.type === "text") {
			appendText(run, block.text);
		} else if (block.type === "thinking") {
			ensureTurnStarted(run);
			const contentIndex = run.turnBlocks.length;
			run.turnBlocks.push({ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature });
			stream.push({ type: "thinking_start", contentIndex, partial: output });
			stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: output });
			stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
		} else if (block.type === "tool_use") {
			const name = toolNames.get(block.name);
			if (!name) continue;
			ensureTurnStarted(run);
			const contentIndex = run.turnBlocks.length;
			const toolCall = { type: "toolCall" as const, id: block.id, name, arguments: mapToolArgs(name, block.input as Record<string, unknown>) };
			run.turnToolCallIds.add(block.id);
			run.turnBlocks.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex, partial: output });
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
		}
	}
	if (run.turnToolCallIds.size) finishTurn(run, "toolUse");
}

async function consumeQuery(
	sdkQuery: Query,
	toolNames: Map<string, string>,
	model: Model,
	run: QueryContext,
	session: BridgeSession,
): Promise<string | undefined> {
	let sessionId: string | undefined;
	let resultError: string | undefined;
	let sawResult = false;
	let assistantMessageId: string | undefined;
	let outputAtMessageStart = run.turnOutput;
	let blocksAtMessageStart = outputAtMessageStart?.content.length ?? 0;
	const markAssistantMessage = (id: string) => {
		if (assistantMessageId === id) return;
		assistantMessageId = id;
		outputAtMessageStart = run.turnOutput;
		blocksAtMessageStart = run.turnBlocks.length;
	};
	try {
		for await (const message of sdkQuery) {
			if (message.type === "system" && message.subtype === "init") {
				sessionId = message.session_id;
			} else if (message.type === "rate_limit_event") {
				const notice = rateLimitNotice(message.rate_limit_info);
				debug("provider: rate limit", message.rate_limit_info);
				if (notice) session.ui?.notify(notice.message, notice.level);
			} else if (message.type === "result") {
				sawResult = true;
				sessionId = message.session_id || sessionId;
				logServedContextWindow("result", message, model);
				if (message.subtype !== "success" || message.is_error) {
					resultError = resultErrorText(message);
				} else {
					const from = run.turnOutput === outputAtMessageStart ? blocksAtMessageStart : 0;
					if (!run.turnBlocks.some((block, index) => index >= from && block.type === "text" && block.text)) {
						appendText(run, message.result);
					}
				}
			} else if (message.type === "stream_event" && message.parent_tool_use_id == null) {
				if (message.event.type === "message_start") markAssistantMessage(message.event.message.id);
				processStreamEvent(message.event, toolNames, model, run);
			} else if (message.type === "assistant" && message.parent_tool_use_id == null) {
				markAssistantMessage(message.message.id);
				processAssistantMessage(message, toolNames, run);
			}
		}
	} catch (error) {
		if (!resultError) throw error;
	}
	if (resultError) throw new Error(resultError);
	if (!sawResult) throw new Error("Claude Code ended without a result");
	return sessionId;
}

function streamClaudeAgentSdk(model: Model, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();

	const states = options?.providerSessionState;
	const current = states?.get(PROVIDER_ID);
	const owner: BridgeSession = current instanceof BridgeSession ? current : new BridgeSession();
	const run = owner.current;
	if (run?.turnToolCallIds.size && !run.currentPiStream) {
		const { results, stopIdx } = _extractAllToolResults(context.messages);
		const matching = results.filter((r) => r.toolCallId && run.turnToolCallIds.has(r.toolCallId));
		if (matching.length) {
			startTurn(run, model, stream);
			run.setAbortSignal(options?.signal);
			if (!run.currentPiStream) return stream;
			run.latestMessages = context.messages;
			for (let i = stopIdx + 1; i < context.messages.length; i++) {
				const message = context.messages[i];
				if (message.role !== "toolResult") run.deferredMessages.push(message);
			}
			const delivered = new Map(matching.map((result) => [result.toolCallId, result]));
			for (const id of run.turnToolCallIds) {
				const result = delivered.get(id) ?? { isError: true, content: [{ type: "text" as const, text: "Oh My Pi did not return a result for this call" }] };
				const resolve = run.pendingToolCalls.get(id);
				if (resolve) {
					run.pendingToolCalls.delete(id);
					resolve(result);
				} else {
					run.pendingResults.set(id, result);
				}
			}
			run.turnToolCallIds.clear();
			return stream;
		}
	}

	if (options?.signal?.aborted) {
		stream.push({ type: "error", reason: "aborted", error: newAssistantOutput(model, "", "aborted", "Operation aborted") });
		stream.end();
		return stream;
	}
	if (owner !== current) states?.set(PROVIDER_ID, owner);

	// A side request without matching tool results must not replace a live query.
	const target = run ? new BridgeSession() : owner;
	const next = new QueryContext(context.messages);
	startTurn(next, model, stream);
	target.current = next;
	void runProvider(model, context, options, target, next, Boolean(states) && !run);
	return stream;
}

async function runProvider(
	model: Model,
	context: Context,
	options: SimpleStreamOptions | undefined,
	session: BridgeSession,
	run: QueryContext,
	bridgeTools: boolean,
): Promise<void> {
	let running: Query | undefined;
	let aborted = false;
	const release = () => {
		if (session.current === run) session.current = undefined;
		for (const resolve of run.pendingToolCalls.values()) {
			resolve({ isError: true, content: [{ type: "text", text: "Claude Code query ended" }] });
		}
		run.pendingToolCalls.clear();
		run.pendingResults.clear();
		run.approvedToolCalls.clear();
		run.setAbortSignal();
	};
	run.abort = () => {
		aborted = true;
		session.transcript = undefined;
		try { running?.close(); } catch (error) { debug("provider: close failed", error); }
		release();
		finishTurn(run, "aborted", "Operation aborted");
	};
	run.setAbortSignal(options?.signal);

	try {
		if (options?.onPayload) {
			const payload = { model: model.id };
			payloadSessions.set(payload, session);
			await options.onPayload(payload, model);
		}
		if (aborted) return;
		const cwd = options?.cwd ?? process.cwd();
		const config = loadConfig(cwd);
		const settings = config.provider;
		const protectSecrets = session.protectSecrets ?? secretsEnabled(cwd);
		const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(
			bridgeTools && options?.toolChoice !== "none" ? context : { ...context, tools: undefined },
			config.askClaude?.name ?? "AskClaude",
		);
		let priorCount = context.messages.length;
		while (priorCount > 0) {
			const role = context.messages[priorCount - 1].role;
			if (role === "assistant" || role === "toolResult") break;
			priorCount--;
		}
		let prompt = promptFromMessages(context.messages.slice(priorCount));
		if (!prompt) {
			priorCount = context.messages.length;
			prompt = "Continue from the conversation above.";
		}
		let sessionId = prepareSession(protectSecrets ? undefined : session.transcript, context.messages.slice(0, priorCount), cwd, {
			customToolNameToSdk,
			modelId: model.id,
			hooks: {
				debug, debugSessionPaths,
				verifyWrittenSession: (path, id, count, dir) => verifyWrittenSession(path, id, count, dir, session.ui),
			},
		});

		const append = settings?.appendSystemPrompt === false ? undefined : [
			protectSecrets ? undefined : extractAgentsAppend(cwd),
			extractSkillsBlock(systemPromptText(context.systemPrompt)),
		].filter(Boolean).join("\n\n") || undefined;
		const reasoningOff = options?.disableReasoning === true || options?.forceReasoningOff === true;
		const effort = !reasoningOff && options?.reasoning
			? (model.thinking?.effortMap?.[options.reasoning] as EffortLevel | undefined) ?? REASONING_TO_EFFORT[options.reasoning]
			: undefined;
		const queryOptions: Options = {
			cwd,
			model: model.id,
			tools: [],
			permissionMode: "default",
			includePartialMessages: true,
			verbatimPrompts: true,
			strictMcpConfig: settings?.strictMcpConfig !== false || options?.toolChoice === "none",
			settingSources: protectSecrets ? [] : settings?.appendSystemPrompt === false ? settings.settingSources ?? ["user", "project"] : undefined,
			pathToClaudeCodeExecutable: settings?.pathToClaudeCodeExecutable,
			systemPrompt: { type: "preset", preset: "claude_code", append, snapshot: false },
			...(reasoningOff ? { thinking: { type: "disabled" } } : {}),
			...(effort ? { effort, extraArgs: { "thinking-display": "summarized" } } : {}),
			canUseTool: async (name, input, { toolUseID, mcpServer }) => {
				const toolName = customToolNameToPi.get(name);
				if (!toolName || !toolUseID || mcpServer?.source !== "sdk" || mcpServer.name !== MCP_SERVER_NAME || aborted) {
					return { behavior: "deny", message: "This tool requires an explicit Claude Code permission rule." };
				}
				run.approvedToolCalls.set(toolUseID, toolName);
				return { behavior: "allow", updatedInput: { ...input, [OMP_TOOL_USE_ID]: toolUseID } };
			},
		};

		let tag = "provider";
		while (prompt && !aborted) {
			// Each SDK query owns its MCP transport, so re-create the server on continuation.
			running = query({
				prompt: typeof prompt === "string" ? prompt : wrapPromptStream(prompt),
				options: { ...queryOptions, resume: sessionId, mcpServers: buildMcpServers(mcpTools, run), ...makeCliDebugOptions(tag) },
			});
			run.streamedMessageId = undefined;
			try {
				sessionId = (await consumeQuery(running, customToolNameToPi, model, run, session)) ?? sessionId;
			} finally {
				try { running.close(); } catch (error) { debug("provider: close failed", error); }
				running = undefined;
			}
			if (aborted) return;
			prompt = promptFromMessages(run.deferredMessages);
			run.deferredMessages.length = 0;
			if (prompt && !sessionId) throw new Error("Claude Code did not return a session ID for continuing");
			tag = "continuation";
		}

		const history = run.latestMessages;
		session.transcript = !protectSecrets && sessionId && run.currentPiStream
			? { sessionId, cursor: history.length, cwd, head: messageAnchor(history[0]), tail: messageAnchor(history.at(-1)) }
			: undefined;
		release();
		finishTurn(run, run.turnOutput?.stopReason === "length" ? "length" : "stop");
	} catch (error) {
		if (aborted) return;
		session.transcript = undefined;
		debug("provider: query failed", error);
		release();
		finishTurn(run, "error", errorMessage(error));
	}
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal: AbortSignal | undefined,
	options: {
		cwd: string;
		systemPrompt?: string;
		appendSkills?: boolean;
		model?: string;
		thinking?: string;
		context?: Context["messages"];
	},
): Promise<string> {
	signal?.throwIfAborted();
	const { cwd } = options;
	const requestedModel = options.model ?? "opus";
	const modelId = resolveModel(requestedModel)?.id ?? requestedModel;
	const history = options.context ?? [];
	const resume = prepareSession(undefined, history, cwd, {
		modelId, hooks: { debug, verifyWrittenSession, debugSessionPaths },
	});
	const skills = options.appendSkills !== false ? extractSkillsBlock(options.systemPrompt) : undefined;
	const effort = options.thinking ? REASONING_TO_EFFORT[options.thinking] : undefined;
	let sdkQuery: Query | undefined;
	const onAbort = () => {
		try { sdkQuery?.close(); } catch (error) { debug("askClaude: close failed", error); }
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		sdkQuery = query({
			prompt,
			options: {
				cwd,
				model: modelId,
				includePartialMessages: true,
				persistSession: false,
				strictMcpConfig: true,
				...(mode === "full" ? {
					settingSources: ["user", "project"],
					permissionMode: "default",
					disallowedTools: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "ScheduleWakeup"],
				} : {}),
				...askClaudePolicy(mode),
				...(options.thinking === "off" ? { thinking: { type: "disabled" } } : {}),
				...(effort ? { effort } : {}),
				systemPrompt: skills ? { type: "preset", preset: "claude_code", append: skills } : undefined,
				resume,
				pathToClaudeCodeExecutable: loadConfig(cwd).provider?.pathToClaudeCodeExecutable,
				...makeCliDebugOptions("askclaude"),
			},
		});

		let response: string | undefined;
		let resultError: string | undefined;
		try {
			for await (const message of sdkQuery) {
				signal?.throwIfAborted();
				if (message.type === "stream_event") {
					const event = message.event;
					if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
						toolCalls.set(event.content_block.id, { name: mapToolName(event.content_block.name), status: "running" });
					}
				} else if (message.type === "assistant") {
					for (const block of message.message.content) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, { name: mapToolName(block.name), status: "complete", rawInput: block.input });
						}
					}
				} else if (message.type === "result") {
					if (message.subtype !== "success" || message.is_error) resultError = resultErrorText(message);
					else response = message.result;
				}
			}
		} catch (error) {
			if (!resultError) throw error;
		}
		signal?.throwIfAborted();
		if (resultError) throw new Error(resultError);
		if (response === undefined) throw new Error("Claude Code ended without a result");
		return response;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		onAbort();
		if (resume) {
			try { deleteSession(resume, cwd, process.env.CLAUDE_CONFIG_DIR); }
			catch (error) { debug("askClaude: temporary session cleanup failed", error); }
		}
	}
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

export default function (pi: ExtensionAPI) {
	// Keep OMP in sole control of compaction and prevent Claude.ai cloud MCP
	// auto-discovery. Set only non-credential controls in the inherited parent
	// environment; query() receives no env object or authentication material.
	// Essential-traffic-only mode also blocks the subscription usage endpoint.
	process.env.DISABLE_TELEMETRY = "1";
	process.env.DISABLE_AUTO_COMPACT = "1";
	process.env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";

	const config = loadConfig(process.cwd());
	let session: BridgeSession | undefined;
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		if (payload === null || typeof payload !== "object") return;
		const owner = payloadSessions.get(payload);
		if (!owner) return;
		owner.ui = ctx.ui;
		owner.protectSecrets = secretsEnabled(ctx.cwd);
		session = owner;
	});
	// OMP owns transport disposal on clear/fresh, switch and shutdown. Tree
	// navigation and compaction can rewrite history without disposing it.
	pi.on("session_compact", () => { if (session) session.transcript = undefined; });
	pi.on("session_tree", () => { if (session) session.transcript = undefined; });

	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		// The native path applies the session's secret obfuscator before sending the summary request.
		if (secretsEnabled(ctx.cwd)) return undefined;
		debug(
			`session_before_compact: takeover isSplitTurn=${event.preparation.isSplitTurn} ` +
			`messages=${event.preparation.messagesToSummarize.length} turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await compact(
				event.preparation,
				ctx.model,
				undefined,
				event.customInstructions,
				event.signal,
				{
					completeImpl: (model, context, options) => {
						const stream = newAssistantMessageEventStream();
						void runIsolatedSummary(model, context, options, stream, ctx.cwd);
						return stream.result();
					},
				},
			);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// Re-register on each extension binding. The stream itself owns no global
	// conversation state; OMP supplies the requesting session's transport store.
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: PROVIDER_ID, api: PROVIDER_ID, apiKey: "not-used",
		models: MODELS, streamSimple: streamClaudeAgentSdk,
		usage: claudeUsageProvider(config.provider?.pathToClaudeCodeExecutable),
	});

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const { allowFull, defaultMode } = resolveAskClaudeModes(askConf);
	const defaultIsolated = askConf?.defaultIsolated ?? false;
	const askClaudeToolName = askConf?.name ?? "AskClaude";

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	type AskClaudeToolParams = {
		prompt: string;
		mode?: "full" | "read" | "none";
		model?: string;
		thinking?: string;
		isolated?: boolean;
	};

	const readAskClaudeParams = (value: unknown, requirePrompt: boolean): AskClaudeToolParams => {
		if (!value || typeof value !== "object") {
			if (requirePrompt) throw new Error("AskClaude prompt must be a string");
			return { prompt: "" };
		}
		if (!("prompt" in value) || typeof value.prompt !== "string") {
			if (requirePrompt) throw new Error("AskClaude prompt must be a string");
			return { prompt: "" };
		}
		const parsed: AskClaudeToolParams = { prompt: value.prompt };
		if ("mode" in value && (value.mode === "full" || value.mode === "read" || value.mode === "none")) parsed.mode = value.mode;
		else if ("mode" in value && value.mode !== undefined && requirePrompt) throw new Error("Unknown AskClaude mode");
		if ("model" in value && typeof value.model === "string") parsed.model = value.model;
		if ("thinking" in value && typeof value.thinking === "string") parsed.thinking = value.thinking;
		if ("isolated" in value && typeof value.isolated === "boolean") parsed.isolated = value.isolated;
		return parsed;
	};

	let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

	if (askConf?.enabled !== false) {
		const askClaudeParams = Type.Object({
			prompt: Type.String({ description: "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
			mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
			model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
			isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
		});
		pi.registerTool<typeof askClaudeParams>({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: askClaudeParams,
			renderCall(args, _options, theme) {
				const params = readAskClaudeParams(args, false);
				const spans: AskClaudeSpan[] = [{ text: "AskClaude ", color: "mdLink", bold: true }];
				const mode = params.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== defaultMode) tags.push(`mode=${mode}`);
				if (params.model) tags.push(`model=${params.model}`);
				if (params.thinking) tags.push(`thinking=${params.thinking}`);
				if (params.isolated) tags.push("isolated");
				if (tags.length) spans.push({ text: `[${tags.join(", ")}] `, color: "accent" });
				const truncated = params.prompt.length > PREVIEW_MAX_CHARS ? params.prompt.substring(0, PREVIEW_MAX_CHARS) : params.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				spans.push({ text: `"${lines.join("\n")}"`, color: "muted" });
				if (params.prompt.length > PREVIEW_MAX_CHARS || params.prompt.split("\n").length > PREVIEW_MAX_LINES) spans.push({ text: " …", color: "dim" });
				return renderAskClaude(theme, spans);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return renderAskClaude(theme, [{ text: "◉ Claude Code ", color: "mdLink" }, { text: status, color: "muted" }]);
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				const spans: AskClaudeSpan[] = [details?.error
					? { text: "✗ Claude Code error", color: "error" }
					: { text: "✓ Claude Code", color: "mdLink" }];

				if (details?.executionTime) spans.push({ text: ` ${(details.executionTime / 1000).toFixed(1)}s`, color: "dim" });
				if (details?.actions) spans.push({ text: ` ${details.actions}`, color: "muted" });

				if (expanded) {
					if (details?.prompt) spans.push({ text: `\nPrompt: ${details.prompt}`, color: "dim" });
					if (details?.prompt && body) spans.push({ text: `\n${"─".repeat(40)}`, color: "dim" });
					if (body) spans.push({ text: `\n${body}`, color: "toolOutput" });
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) spans.push({ text: `\n${lines.join("\n")}`, color: "toolOutput" });
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) spans.push({ text: "\n… (expand to see more)", color: "dim" });
				}

				return renderAskClaude(theme, spans);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					debug("askClaude: blocked circular delegation (active provider is claude-bridge)");
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code." }],
						isError: true,
						details: { error: true },
					};
				}

				if (secretsEnabled(ctx.cwd)) {
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude is unavailable while OMP secret protection is enabled." }],
						isError: true,
						details: { error: true },
					};
				}

				const askParams = readAskClaudeParams(params, true);
				const mode = askParams.mode ?? defaultMode;
				if (mode === "full" && (!allowFull || !resolveAskClaudeModes(loadConfig(ctx.cwd).askClaude).allowFull)) {
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude full mode is disabled by configuration (allowFullMode: false)." }],
						isError: true,
						details: { prompt: askParams.prompt, error: true },
					};
				}
				const isolated = askParams.isolated ?? defaultIsolated;
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: askParams.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const response = await promptAndWait(askParams.prompt, mode, toolCalls, signal, {
						cwd: ctx.cwd,
						systemPrompt: systemPromptText(ctx.getSystemPrompt()),
						appendSkills: askConf?.appendSkills,
						model: askParams.model,
						thinking: askParams.thinking,
						context: isolated ? undefined : defaultConvertToLlm(
							// A Claude delegate cannot read provider-bound OpenAI compactions.
							buildSessionContext(ctx.sessionManager.getBranch(), undefined, undefined, { model: ANTHROPIC_MODELS[0] }).messages,
						),
					});
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls);

					const text = actions ? `${response}\n\n[Claude Code actions: ${actions}]` : response;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: askParams.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					debug(`askClaude error: mode=${mode}, model=${askParams.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						isError: true,
						details: { prompt: askParams.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}
}
