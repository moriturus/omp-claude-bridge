// Pure pi→Anthropic message conversion helpers.
// Extracted so they can be tested without pulling in the full extension runtime.

import type { Message as PiMessage } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import type { Message as SessionMessage } from "cc-session-io";
import { pascalCase } from "change-case";

export const PROVIDER_ID = "claude-bridge";

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

type PiUserContent = string | Array<{ type: string; text?: string; data?: string; mimeType?: string }> | undefined;

function convertUserContent(content: PiUserContent): SessionMessage["content"] | null {
	if (typeof content === "string") return content || null;
	if (!Array.isArray(content)) return null;
	const parts = [];
	for (const block of content) {
		if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) {
			parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		}
	}
	return parts.length ? parts : null;
}

/** Convert OMP message array to Anthropic API format. */
export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk?: Map<string, string>,
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string> } {
	const anthropicMessages = [];
	const sanitizedIds = new Map();

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = convertUserContent(msg.content);
			anthropicMessages.push({ role: "user", content: content ?? (Array.isArray(msg.content) ? "[image]" : "[empty]") });
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const sig = block.thinkingSignature;
					const isAnthropicProvider = msg.provider === PROVIDER_ID || msg.api === "anthropic" || msg.api === "anthropic-messages";
					if (isAnthropicProvider && sig) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				}
			}
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			anthropicMessages.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			let content: string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;
			if (typeof msg.content === "string") {
				content = msg.content;
			} else if (Array.isArray(msg.content)) {
				const hasImage = msg.content.some((b) => b.type === "image" && b.data && b.mimeType);
				if (hasImage) {
					const parts = [];
					for (const b of msg.content) {
						if (b.type === "text" && b.text) parts.push({ type: "text" as const, text: b.text });
						else if (b.type === "image" && b.data && b.mimeType) {
							parts.push({ type: "image" as const, source: { type: "base64" as const, media_type: b.mimeType, data: b.data } });
						}
					}
					content = parts.length ? parts : "";
				} else {
					content = messageContentToText(msg.content) || "";
				}
			} else {
				content = "";
			}
			const toolResult = { type: "tool_result", tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds), content, is_error: msg.isError };
			// Parallel tool calls produce one pi toolResult message per call; Anthropic expects all
			// results for one assistant turn in a single user message, and repairToolPairing would
			// otherwise replace every result after the first with a synthetic error.
			const previous = anthropicMessages[anthropicMessages.length - 1];
			const previousIsToolResults = previous?.role === "user" && Array.isArray(previous.content)
				&& previous.content.length > 0 && previous.content.every((b) => b.type === "tool_result");
			if (previousIsToolResults) previous.content.push(toolResult);
			else anthropicMessages.push({ role: "user", content: [toolResult] });
		} else {
			// OMP injects context as other roles (e.g. "developer" for hidden custom
			// messages such as system notices). The Anthropic message format has no
			// such role, so forward any content as a user turn instead of dropping it.
			const content = convertUserContent((msg as { content?: PiUserContent }).content);
			if (content) anthropicMessages.push({ role: "user", content });
		}
	}

	return { anthropicMessages, sanitizedIds };
}
