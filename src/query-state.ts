import type { AssistantMessage, AssistantMessageEventStream, Context, Model } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import type { McpResult } from "./extract-tool-results.js";

type StreamedBlock = AssistantMessage["content"][number] & { index?: number; partialJson?: string };

export class QueryContext {
	currentPiStream: AssistantMessageEventStream | null = null;
	private readonly pendingToolCalls = new Map<string, (result: McpResult) => void>();
	private readonly pendingResults = new Map<string, McpResult>();
	private readonly approvedToolCalls = new Map<string, string>();
	turnToolCallIds = new Set<string>();
	deferredMessages: Context["messages"] = [];
	streamedMessageId?: string;
	usageBase?: AssistantMessage["usage"];
	abort: () => void = () => {};
	private abortSignal?: AbortSignal;

	approveToolCall(id: string, toolName: string): void {
		this.approvedToolCalls.set(id, toolName);
	}

	collectToolResult(id: unknown, toolName: string): McpResult | Promise<McpResult> {
		if (typeof id !== "string" || this.approvedToolCalls.get(id) !== toolName) {
			return { isError: true, content: [{ type: "text", text: "Missing bridge tool invocation ID" }] };
		}
		this.approvedToolCalls.delete(id);
		const result = this.pendingResults.get(id);
		if (result) {
			this.pendingResults.delete(id);
			return result;
		}
		const { promise, resolve } = Promise.withResolvers<McpResult>();
		this.pendingToolCalls.set(id, resolve);
		return promise;
	}

	deliverToolResults(results: McpResult[]): void {
		const delivered = new Map(results.map((result) => [result.toolCallId, result]));
		for (const id of this.turnToolCallIds) {
			const result = delivered.get(id) ?? { isError: true, content: [{ type: "text" as const, text: "Oh My Pi did not return a result for this call" }] };
			const resolve = this.pendingToolCalls.get(id);
			if (resolve) {
				this.pendingToolCalls.delete(id);
				resolve(result);
			} else {
				this.pendingResults.set(id, result);
			}
		}
		this.turnToolCallIds.clear();
	}

	releaseToolCalls(): void {
		for (const resolve of this.pendingToolCalls.values()) {
			resolve({ isError: true, content: [{ type: "text", text: "Claude Code query ended" }] });
		}
		this.pendingToolCalls.clear();
		this.pendingResults.clear();
		this.approvedToolCalls.clear();
	}

	setAbortSignal(signal?: AbortSignal): void {
		this.abortSignal?.removeEventListener("abort", this.abort);
		this.abortSignal = signal;
		if (signal?.aborted) this.abort();
		else signal?.addEventListener("abort", this.abort, { once: true });
	}

	constructor(public latestMessages: Context["messages"]) {}

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;

	get turnBlocks(): StreamedBlock[] {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	resetTurnState(model: Model): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.usageBase = undefined;
	}
}
