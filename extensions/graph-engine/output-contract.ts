import { GraphExecutionError } from "./execution-policy.ts";
import type { JsonObject } from "./types.ts";

/** A bounded JSON Schema subset. No remote references, executable keywords or patterns. */
export function outputSchemaIssues(schema: unknown, depth = 0): string[] {
	if (depth > 12 || !schema || typeof schema !== "object" || Array.isArray(schema)) return ["invalid or excessively deep output schema"];
	const value = schema as JsonObject;
	const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "description"]);
	const issues = Object.keys(value).filter((key) => !allowed.has(key)).map((key) => `unsupported output schema keyword: ${key}`);
	const types = Array.isArray(value.type) ? value.type : [value.type];
	if (!types.length || types.some((type) => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type)))) issues.push("output schema requires supported type");
	for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
		if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) issues.push(`invalid ${key}`);
	}
	for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
		if (typeof value[key] === "number" && (!Number.isInteger(value[key]) || value[key] < 0)) issues.push(`invalid ${key}`);
	}
	for (const [min, max] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"]]) {
		if (typeof value[min] === "number" && typeof value[max] === "number" && value[min] > value[max]) issues.push(`${min} exceeds ${max}`);
	}
	if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") issues.push("additionalProperties must be boolean");
	if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) issues.push("enum must be a nonempty array");
	if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((key) => typeof key !== "string"))) issues.push("required must contain strings");
	if (value.properties !== undefined) {
		if (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties)) issues.push("properties must be an object");
		else for (const child of Object.values(value.properties)) issues.push(...outputSchemaIssues(child, depth + 1));
	}
	if (value.items !== undefined) issues.push(...outputSchemaIssues(value.items, depth + 1));
	if (value.additionalProperties === false && Array.isArray(value.required)) {
		for (const key of value.required) if (typeof key === "string" && !Object.hasOwn(value.properties ?? {}, key)) issues.push(`required property ${key} is forbidden`);
	}
	return issues;
}

/** Durable values must remain exact. Large artifacts belong in workspace files. */
export function boundedExecutionValue<T>(value: T): T {
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4 * 1024 * 1024) {
		throw new GraphExecutionError("Durable execution value exceeds 4 MiB; store large artifacts in workspace files.", "budget");
	}
	return value;
}
