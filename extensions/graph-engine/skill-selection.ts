import { isAbsolute } from "node:path";

export interface AssignedSkill {
	name: string;
	path: string;
}

export const GRAPH_ASSIGNED_SKILL_REQUEST_CHANNEL = "pi-graph:assigned-skills:request";
export const GRAPH_ASSIGNED_SKILL_REGISTER_CHANNEL = "pi-graph:assigned-skills:register";

export function parseRegisteredAssignedSkill(value: unknown): AssignedSkill | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	if (
		source.schemaVersion !== 1
		|| source.disableModelInvocation !== true
		|| typeof source.name !== "string"
		|| !source.name.trim()
		|| typeof source.path !== "string"
		|| !isAbsolute(source.path)
	) return undefined;
	return { name: source.name.trim(), path: source.path };
}

function decodeXml(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

export function parseAvailableSkills(systemPrompt: string): AssignedSkill[] {
	const skills: AssignedSkill[] = [];
	const seen = new Set<string>();
	const blocks = systemPrompt.matchAll(/<skill>\s*([\s\S]*?)\s*<\/skill>/g);
	for (const block of blocks) {
		const body = block[1];
		const name = body.match(/<name>([\s\S]*?)<\/name>/)?.[1];
		const location = body.match(/<location>([\s\S]*?)<\/location>/)?.[1];
		if (!name || !location) continue;
		const decodedName = decodeXml(name.trim());
		if (!decodedName || seen.has(decodedName)) continue;
		seen.add(decodedName);
		skills.push({ name: decodedName, path: decodeXml(location.trim()) });
	}
	return skills;
}

export function resolveAssignedSkills(
	systemPrompt: string,
	names: string[],
	registered: Iterable<AssignedSkill> = [],
): AssignedSkill[] {
	if (names.length === 0) return [];
	const available = parseAvailableSkills(systemPrompt);
	const byName = new Map(available.map((skill) => [skill.name, skill]));
	for (const skill of registered) {
		if (!skill.name.trim() || !skill.path.trim()) continue;
		const existing = byName.get(skill.name);
		if (existing && existing.path !== skill.path) {
			throw new Error(`Assigned Skill ${skill.name} has conflicting registered paths.`);
		}
		byName.set(skill.name, skill);
	}
	const missing = names.filter((name) => !byName.has(name));
	if (missing.length > 0) {
		const availableNames = [...byName.keys()].sort();
		throw new Error(
			`Assigned skills are not available in the current Pi session: ${missing.join(", ")}. Available: ${availableNames.join(", ") || "none"}.`,
		);
	}
	return names.map((name) => byName.get(name)!);
}

export function buildSkillSelectionArgs(skills: AssignedSkill[]): string[] {
	return ["--no-skills", ...skills.flatMap((skill) => ["--skill", skill.path])];
}
