// User-facing extension config. Loaded once at extension registration from
// ~/.omp/agent/claude-bridge.json and the project OMP config directory, project
// overriding global. Missing or unparseable files are ignored (error to
// console.error, empty object returned) so the extension always starts.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";

export type AskClaudeMode = "full" | "read" | "none";

export interface Config {
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: AskClaudeMode;
		defaultIsolated?: boolean;
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		appendSystemPrompt?: boolean;
		settingSources?: SettingSource[];
		strictMcpConfig?: boolean;
		pathToClaudeCodeExecutable?: string;
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(join(homedir(), ".omp", "agent", "claude-bridge.json"));
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	const { pathToClaudeCodeExecutable: globalExecutable, ...globalProvider } = global.provider ?? {};
	const { pathToClaudeCodeExecutable: _projectExecutable, ...projectProvider } = project.provider ?? {};
	const { defaultMode: projectMode, ...projectAsk } = project.askClaude ?? {};
	const globalFull = global.askClaude?.allowFullMode;
	return {
		askClaude: {
			...global.askClaude,
			...projectAsk,
			defaultMode: projectMode && projectMode !== "full" ? projectMode : global.askClaude?.defaultMode,
			...(globalFull !== undefined && globalFull !== true ? { allowFullMode: false } : {}),
		},
		provider: {
			...globalProvider,
			...projectProvider,
			...(typeof globalExecutable === "string" && isAbsolute(globalExecutable) ? { pathToClaudeCodeExecutable: globalExecutable } : {}),
		},
	};
}

// Fail closed: config is hand-written JSON, so a typo in `defaultMode` or a non-boolean
// `allowFullMode` must never widen Claude Code's permissions.
export function resolveAskClaudeModes(askClaude: Config["askClaude"]): { allowFull: boolean; defaultMode: AskClaudeMode } {
	const allowFull = askClaude?.allowFullMode === undefined || askClaude.allowFullMode === true;
	const requested: unknown = askClaude?.defaultMode;
	if (requested === "none" || (requested === "full" && allowFull)) return { allowFull, defaultMode: requested };
	if (requested !== undefined && requested !== "read") {
		console.error(`claude-bridge: askClaude.defaultMode ${JSON.stringify(requested)} is not allowed; using "read"`);
	}
	return { allowFull, defaultMode: "read" };
}
