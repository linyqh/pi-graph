import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSkillSelectionArgs,
	parseAvailableSkills,
	resolveAssignedSkills,
} from "../extensions/graph-engine/skill-selection.ts";

const systemPrompt = `<available_skills>
  <skill>
    <name>code-review</name>
    <description>Review code.</description>
    <location>/tmp/skills/code-review/SKILL.md</location>
  </skill>
  <skill>
    <name>docs</name>
    <description>Write docs.</description>
    <location>/tmp/A&amp;B/docs/SKILL.md</location>
  </skill>
</available_skills>`;

test("available Skill parsing preserves Pi names and decodes paths", () => {
	assert.deepEqual(parseAvailableSkills(systemPrompt), [
		{ name: "code-review", path: "/tmp/skills/code-review/SKILL.md" },
		{ name: "docs", path: "/tmp/A&B/docs/SKILL.md" },
	]);
});

test("assigned Skills resolve by requested name and reject unavailable names", () => {
	assert.deepEqual(resolveAssignedSkills(systemPrompt, ["docs", "code-review"]), [
		{ name: "docs", path: "/tmp/A&B/docs/SKILL.md" },
		{ name: "code-review", path: "/tmp/skills/code-review/SKILL.md" },
	]);
	assert.deepEqual(resolveAssignedSkills("", []), []);
	assert.throws(() => resolveAssignedSkills(systemPrompt, ["missing"]), /not available.*missing.*code-review, docs/);
});

test("Graph can explicitly resolve a registered hidden Skill without exposing it in the system prompt", () => {
	const hiddenPath = "/tmp/skills/execution-guard/SKILL.md";

	assert.deepEqual(resolveAssignedSkills(systemPrompt, ["execution-guard"], [
		{ name: "execution-guard", path: hiddenPath },
	]), [
		{ name: "execution-guard", path: hiddenPath },
	]);
});

test("Skill CLI selection disables discovery and loads only assigned paths", () => {
	assert.deepEqual(buildSkillSelectionArgs([]), ["--no-skills"]);
	assert.deepEqual(buildSkillSelectionArgs([
		{ name: "docs", path: "/tmp/A&B/docs/SKILL.md" },
	]), ["--no-skills", "--skill", "/tmp/A&B/docs/SKILL.md"]);
});
