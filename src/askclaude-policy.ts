import type { AskClaudeMode } from "./config.js";

export function askClaudePolicy(mode: AskClaudeMode) {
	if (mode === "full") return {};
	return {
		tools: mode === "read" ? ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] : [],
		allowedTools: mode === "read" ? ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] : [],
		settingSources: [],
		permissionMode: "dontAsk" as const,
		verbatimPrompts: true,
		strictMcpConfig: true,
	};
}
