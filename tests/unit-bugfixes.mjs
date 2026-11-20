import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { jsonSchemaPropertyToZod, jsonSchemaToZodShape } from "../src/typebox-to-zod.ts";
import { sanitizeAgentsContent, extractAgentsAppend } from "../src/agents-md.ts";
import { verifyWrittenSession } from "../src/session-verify.ts";
import { resolveAskClaudeModes, tryParseJson } from "../src/config.ts";

test("jsonSchemaPropertyToZod handles empty enum, non-string enum, and nested object properties", () => {
	assert.equal(jsonSchemaPropertyToZod({ enum: [] }).safeParse("a").success, false);
	assert.equal(jsonSchemaPropertyToZod({ enum: [1, 2] }).safeParse(1).success, true);
	assert.equal(jsonSchemaPropertyToZod({ enum: [1, 2] }).safeParse(3).success, false);

	const shape = jsonSchemaToZodShape({
		type: "object",
		properties: {
			nested: {
				type: "object",
				properties: {
					flag: { type: "boolean" },
				},
				required: ["flag"],
			},
		},
		required: ["nested"],
	});
	const schema = z.object(shape);
	assert.equal(schema.safeParse({ nested: { flag: true } }).success, true);
	assert.equal(schema.safeParse({ nested: {} }).success, false);
});

test("sanitizeAgentsContent rewrites standalone .omp tokens without corrupting identifiers", () => {
	assert.equal(sanitizeAgentsContent("See .omp and (.omp) and ~/.omp/agent"), "See .claude and (.claude) and ~/.claude/agent");
	assert.equal(sanitizeAgentsContent("file.omp"), "file.omp");
});

test("extractAgentsAppend honors explicit cwd argument", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-agents-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "AGENTS.md"), "Use .omp/settings.json");

	assert.equal(extractAgentsAppend(dir), "# CLAUDE.md\n\nUse .claude/settings.json");
});

test("verifyWrittenSession handles expectedRecordCount === 0 without throwing", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-verify-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "empty.jsonl");
	writeFileSync(file, "");

	assert.deepEqual(verifyWrittenSession(file, "sid-1", 0), []);
});

test("tryParseJson returns empty object for valid non-object JSON", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-cfg-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const nullFile = join(dir, "null.json");
	const arrFile = join(dir, "arr.json");
	writeFileSync(nullFile, "null");
	writeFileSync(arrFile, "[]");

	assert.deepEqual(tryParseJson(nullFile), {});
	assert.deepEqual(tryParseJson(arrFile), {});
});

test("resolveAskClaudeModes never widens permissions on typos or disabled full mode", (t) => {
	t.mock.method(console, "error", () => {});

	assert.deepEqual(resolveAskClaudeModes({ allowFullMode: false, defaultMode: "ful" }), { allowFull: false, defaultMode: "read" });
	assert.deepEqual(resolveAskClaudeModes({ allowFullMode: false, defaultMode: "full" }), { allowFull: false, defaultMode: "read" });
	assert.deepEqual(resolveAskClaudeModes({ defaultMode: "constructor" }), { allowFull: true, defaultMode: "read" });
	assert.deepEqual(resolveAskClaudeModes({ allowFullMode: "false", defaultMode: "full" }), { allowFull: false, defaultMode: "read" });
	assert.deepEqual(resolveAskClaudeModes({ defaultMode: "full" }), { allowFull: true, defaultMode: "full" });
	assert.deepEqual(resolveAskClaudeModes({ defaultMode: "none" }), { allowFull: true, defaultMode: "none" });
	assert.deepEqual(resolveAskClaudeModes(undefined), { allowFull: true, defaultMode: "read" });
});
