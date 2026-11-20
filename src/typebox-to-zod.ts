// TypeBox (JSON Schema) → Zod conversion used by buildMcpServers.
//
// Pi tools declare their parameters as TypeBox objects (i.e. JSON Schema at
// runtime). The Agent SDK's createSdkMcpServer requires Zod — its internal
// `Z0()` detects Zod via the `~standard` marker or `_def`/`_zod` properties
// and silently downgrades unrecognized schemas to
// `{type: "object", properties: {}}`, which leaves the model with no
// parameter info. This module bridges the two so MCP-exposed OMP tools retain
// their schemas. If this breaks after an SDK update, check whether `Z0()`
// detection changed or createSdkMcpServer now accepts raw JSON Schema.

import { z } from "zod";

export function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	let base: z.ZodTypeAny;
	if (Array.isArray(prop.enum)) {
		const stringVals = prop.enum.filter((v): v is string => typeof v === "string");
		if (stringVals.length > 0 && stringVals.length === prop.enum.length) {
			base = z.enum(stringVals as [string, ...string[]]);
		} else if (prop.enum.length > 0) {
			const literals = prop.enum.map((v) => z.literal(v as string | number | boolean | null));
			base = literals.length === 1 ? literals[0] : z.union([literals[0], literals[1], ...literals.slice(2)]);
		} else {
			base = z.never();
		}
	} else switch (prop.type) {
		case "string": base = z.string(); break;
		case "number": case "integer": base = z.number(); break;
		case "boolean": base = z.boolean(); break;
		case "array": base = prop.items && typeof prop.items === "object"
			? z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>))
			: z.array(z.unknown()); break;
		case "object": base = prop.properties && typeof prop.properties === "object"
			? z.object(jsonSchemaToZodShape(prop))
			: z.record(z.string(), z.unknown()); break;
		default: base = z.unknown();
	}
	if (typeof prop.description === "string") base = base.describe(prop.description);
	return base;
}

export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
	const s = schema as Record<string, unknown>;
	if (!s || s.type !== "object" || !s.properties) return {};
	const props = s.properties as Record<string, Record<string, unknown>>;
	const required = new Set(Array.isArray(s.required) ? s.required as string[] : []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(props)) {
		const zodProp = jsonSchemaPropertyToZod(prop);
		shape[key] = required.has(key) ? zodProp : zodProp.optional();
	}
	return shape;
}
