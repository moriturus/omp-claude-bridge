// Session sync helpers extracted so unit tests can exercise reentrant isolation
// without importing the full OMP extension runtime.

import type { Context } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import { createSession, deleteSession, repairToolPairing, type Session } from "cc-session-io";
import { convertPiMessages } from "./convert.js";

export interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	needsRebuild?: boolean;
	forceRotate?: boolean;
}

export interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
}

export interface SessionSyncHooks {
	debug?: (...args: unknown[]) => void;
	verifyWrittenSession?: (jsonlPath: string, expectedSessionId: string, expectedRecordCount: number, cwd: string) => void;
	debugSessionPaths?: (label: string, cwd: string, jsonlPath: string) => void;
}

export interface SessionStore {
	get(): SessionState | null;
	set(state: SessionState | null): void;
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

export function syncSessionForQuery(
	store: SessionStore,
	messages: Context["messages"],
	cwd: string,
	options: {
		isReentrant: boolean;
		customToolNameToSdk?: Map<string, string>;
		modelId?: string;
		hooks?: SessionSyncHooks;
	},
): SyncResult {
	const debug = options.hooks?.debug ?? (() => {});
	const verifyWrittenSession = options.hooks?.verifyWrittenSession ?? (() => {});
	const debugSessionPaths = options.hooks?.debugSessionPaths ?? (() => {});
	const priorMessages = messages.slice(0, -1);

	// Reentrant child queries must never touch the parent's sharedSession state or JSONL.
	if (options.isReentrant) {
		if (priorMessages.length === 0) {
			debug(`syncIsolatedSession: clean start, ${messages.length} total messages`);
			return { sessionId: null, preserveSharedSession: true };
		}
		const session = createSession({
			projectPath: cwd,
			claudeDir: process.env.CLAUDE_CONFIG_DIR,
			...(options.modelId ? { model: options.modelId } : {}),
		});
		importConvertedMessages(session, priorMessages, options.customToolNameToSdk, debug);
		if (session.messages.length === 0) {
			debug(`syncIsolatedSession: ${priorMessages.length} prior messages converted to 0 records, clean start`);
			return { sessionId: null, preserveSharedSession: true };
		}
		session.save();
		verifyWrittenSession(session.jsonlPath, session.sessionId, session.messages.length, cwd);
		debug(`syncIsolatedSession: isolated session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
		return { sessionId: session.sessionId, preserveSharedSession: true };
	}

	const sharedSession = store.get();

	// REUSE path
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length >= sharedSession.cursor) {
		const missed = priorMessages.slice(sharedSession.cursor);
		const missedFirst = missed[0];
		const trailingAssistantOnly =
			missed.length === 1 && missedFirst != null && "role" in missedFirst && missedFirst.role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
			const updated = trailingAssistantOnly
				? { ...sharedSession, cursor: priorMessages.length, cwd }
				: sharedSession;
			if (trailingAssistantOnly) store.set(updated);
			debug(`Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${updated.sessionId.slice(0, 8)}, cursor=${updated.cursor}`);
			debug(`syncResult: path=reuse sessionId=${updated.sessionId} cursor=${updated.cursor}`);
			return { sessionId: updated.sessionId };
		}
	}

	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor) {
		debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		debug(`syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
		return { sessionId: null, preserveSharedSession: true };
	}

	// REBUILD path
	if (priorMessages.length === 0) {
		debug(`Case 1: clean start, ${messages.length} total messages`);
		debug(`syncResult: path=clean-start`);
		return { sessionId: null };
	}

	const previousSessionId = sharedSession?.sessionId;
	const previousCursor = sharedSession?.cursor ?? 0;
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	if (preserveId) {
		deleteSession(previousSessionId!, cwd, process.env.CLAUDE_CONFIG_DIR);
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(options.modelId ? { model: options.modelId } : {}),
	});
	importConvertedMessages(session, priorMessages, options.customToolNameToSdk, debug);
	if (session.messages.length === 0) {
		store.set(null);
		debug(`Case 2 empty: ${priorMessages.length} prior messages converted to 0 records, clean start`);
		debug(`syncResult: path=clean-start empty-rebuild priors=${priorMessages.length}`);
		return { sessionId: null };
	}
	session.save();
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.messages.length, cwd);
	store.set({ sessionId: session.sessionId, cursor: priorMessages.length, cwd });
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.messages.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.messages.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId };
}

export function advanceSharedSessionCursor(
	store: SessionStore,
	isParentContext: boolean,
	messageCount: number,
): void {
	if (!isParentContext) return;
	const current = store.get();
	if (current) current.cursor = messageCount;
}

export function cleanupReentrantSession(
	store: SessionStore,
	isReentrant: boolean,
	sessionIds: Array<string | null | undefined>,
	cwd: string,
	debug: (...args: unknown[]) => void = () => {},
): void {
	if (!isReentrant) return;
	const parentSessionId = store.get()?.sessionId;
	const uniqueIds = new Set(sessionIds.filter((id): id is string => Boolean(id) && id !== parentSessionId));
	for (const id of uniqueIds) {
		deleteSession(id, cwd, process.env.CLAUDE_CONFIG_DIR);
		debug(`provider: cleaned up isolated reentrant session ${id.slice(0, 8)}`);
	}
}
