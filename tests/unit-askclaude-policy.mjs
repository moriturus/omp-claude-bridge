import test from "node:test";
import assert from "node:assert/strict";

import { askClaudePolicy } from "../src/askclaude-policy.ts";
import { extractSkillsBlock } from "../src/skills.ts";

test("AskClaude none mode exposes no tools and disables filesystem settings and hooks", () => {
	assert.deepEqual(askClaudePolicy("none"), {
		tools: [],
		allowedTools: [],
		settingSources: [],
		permissionMode: "dontAsk",
		verbatimPrompts: true,
		strictMcpConfig: true,
	});
});

test("AskClaude read mode permits only the explicit read tool set without settings or hooks", () => {
	const tools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
	assert.deepEqual(askClaudePolicy("read"), {
		tools,
		allowedTools: tools,
		settingSources: [],
		permissionMode: "dontAsk",
		verbatimPrompts: true,
		strictMcpConfig: true,
	});
});

test("AskClaude full mode leaves normal SDK settings and tool behavior enabled", () => {
	assert.deepEqual(askClaudePolicy("full"), {});
});

test("extractSkillsBlock accepts modern OMP skills wrapper and renames MCP read tool", () => {
	const prompt = "before\nMatching skill → MUST read skill://<name> first.\n<skills>\n- test: Use the read tool to load a skill's file\n</skills>\nafter";
	assert.equal(extractSkillsBlock(prompt), "Matching skill → MUST read skill://<name> first.\n<skills>\n- test: Use the read tool (mcp__custom-tools__read) to load a skill's file\n</skills>");
});

test("extractSkillsBlock ignores obsolete available_skills format", () => {
	assert.equal(
		extractSkillsBlock("The following skills provide specialized instructions for specific tasks.<available_skills>- old skill</available_skills>"),
		undefined,
	);
});
