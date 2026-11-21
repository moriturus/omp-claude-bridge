import type { AssistantMessage, AssistantMessageEventStream, Context, Model } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import type { McpResult } from "./extract-tool-results.js";

type StreamedBlock = AssistantMessage["content"][number] & { index?: number; partialJson?: string };

export class QueryContext {
	currentPiStream: AssistantMessageEventStream | null = null;
	pendingToolCalls = new Map<string, (result: McpResult) => void>();
	pendingResults = new Map<string, McpResult>();
	approvedToolCalls = new Map<string, string>();
	turnToolCallIds = new Set<string>();
	deferredMessages: Context["messages"] = [];
	streamedMessageId?: string;
	usageBase?: AssistantMessage["usage"];
	abort: () => void = () => {};

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
