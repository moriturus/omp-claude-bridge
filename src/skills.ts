// Skills block extraction + MCP naming constants.
// Extracted from index.ts so tests can import without activating the extension.

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Extract skills block from OMP's system prompt for forwarding to Claude Code.
export function extractSkillsBlock(systemPrompt?: string, debug?: (message: string) => void): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "Matching skill → MUST read skill://<name> first.";
	const start = systemPrompt.indexOf(startMarker);
	if (start < 0) {
		if (debug && /^<skills>[ \t]*$/m.test(systemPrompt)) debug("prompt extraction: malformed OMP skills section (missing lead-in)");
		return undefined;
	}
	const endMarker = "</skills>";
	const end = systemPrompt.indexOf(endMarker, start);
	if (end < 0) {
		debug?.("prompt extraction: malformed OMP skills section (missing closing tag)");
		return undefined;
	}
	return rewriteSkillsBlock(systemPrompt.slice(start, end + endMarker.length).trim());
}

export function rewriteSkillsBlock(skillsBlock: string): string {
	return skillsBlock.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`,
	);
}
