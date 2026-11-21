import type { Context } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import { createSession, repairToolPairing, type Session } from "cc-session-io";
import { convertPiMessages } from "./convert.js";

export interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	head?: string;
	tail?: string;
}

export function messageAnchor(message: Context["messages"][number] | undefined): string | undefined {
	return message && `${message.role}:${message.timestamp}`;
}

export interface SessionSyncHooks {
	debug?: (...args: unknown[]) => void;
	verifyWrittenSession?: (jsonlPath: string, expectedSessionId: string, expectedRecordCount: number, cwd: string) => void;
	debugSessionPaths?: (label: string, cwd: string, jsonlPath: string) => void;
}

function importConvertedMessages(
	session: Session,
	messages: Context["messages"],
	customToolNameToSdk: Map<string, string> | undefined,
	debug: (...args: unknown[]) => void,
): void {
	const { anthropicMessages, sanitizedIds } = convertPiMessages(messages, customToolNameToSdk);
	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(
		`convertAndImportMessages: imported roles:`,
		anthropicMessages.map((m, i) => {
			const c = m.content;
			if (typeof c === "string") return `[${i}]${m.role}:text`;
			if (Array.isArray(c)) return `[${i}]${m.role}:${c.map((b) => b.type).join("+")}`;
			return `[${i}]${m.role}:?`;
		}).join(" "),
	);
	if (sanitizedIds.size > 0) {
		debug(
			`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => (orig === clean ? orig : `${orig}→${clean}`)).join(", "),
		);
	}
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	if (repaired.length) session.importMessages(repaired);
}

export function prepareSession(
	previous: SessionState | undefined,
	history: Context["messages"],
	cwd: string,
	options: {
		customToolNameToSdk?: Map<string, string>;
		modelId?: string;
		hooks?: SessionSyncHooks;
	} = {},
): string | undefined {
	const debug = options.hooks?.debug ?? (() => {});
	const trailing = previous && history.length === previous.cursor + 1 ? history.at(-1) : undefined;
	if (previous?.cwd === cwd &&
		(history.length === previous.cursor || (trailing?.role === "assistant" && trailing.provider === "claude-bridge")) &&
		messageAnchor(history[0]) === previous.head &&
		messageAnchor(history[previous.cursor - 1]) === previous.tail) {
		debug(`syncResult: path=reuse sessionId=${previous.sessionId} cursor=${previous.cursor}`);
		return previous.sessionId;
	}
	if (!history.length) {
		debug("syncResult: path=clean-start");
		return undefined;
	}

	// Build a new transcript before publishing its ID. The previous JSONL and
	// the companion files it may reference continue to belong to that session.
	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(options.modelId ? { model: options.modelId } : {}),
	});
	importConvertedMessages(session, history, options.customToolNameToSdk, debug);
	if (!session.messages.length) {
		debug("syncResult: path=clean-start empty-rebuild");
		return undefined;
	}
	session.save();
	options.hooks?.verifyWrittenSession?.(session.jsonlPath, session.sessionId, session.messages.length, cwd);
	options.hooks?.debugSessionPaths?.(session.sessionId.slice(0, 8), cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${history.length}`);
	return session.sessionId;
}
