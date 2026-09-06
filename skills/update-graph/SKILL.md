---
name: update-graph
description: Inspect, update, or roll back a trusted project Pi graph through immutable revision history and explicit approval. Use when the user invokes /graph-update or asks to edit, version, inspect history for, or roll back an existing project graph.
---

# Update Graph

## Required Reference

Read `../create-graph/references/graph-spec.md` completely before drafting a changed graph. It remains the source of truth for the declarative JSON fields and safety rules.

## Workflow

1. Call `graph_list` to identify the active project graph and copy its exact `definitionHash`.
2. Call `graph_history` for that graph. When inspecting or rolling back a particular revision, pass its exact hash.
3. For an update, treat the selected active spec as immutable input and interview the user only about decisions that affect the changed behavior, permissions, failure policy, or presentation language.
4. Copy the active graph into a separate draft JSON file and edit only the intended fields with `edit` or a script. Keep `name` unchanged, choose a new version, and preserve unrelated fields, especially `next`, `outputKey`, `parseJson`, and `label`. Do not retype the complete graph in a tool call.
5. Call `graph_capabilities` (discover with `tool_search` if needed), follow all `nextOffset` pages, and resolve every Tool and Skill name from this full catalog, including inactive tools. Require `subagent: "available"` for subagent tools and `toolNode: true` for direct tool nodes. Read assigned SKILL.md files, include task-specific dependencies and catalog `requiredTools` explicitly; skills never enable tools. Never invent a name or widen a Tool/Skill allowlist without explaining it.
6. Show the intended version change, node additions/removals, changed fields, permission changes, Tool/Skill changes, approvals, retries, and routing changes. Obtain explicit shared-understanding confirmation.
7. Call `graph_update` with `specFile` pointing to the draft, `expectedDefinitionHash`, and `validateOnly: true`. Fix any errors in that same draft; inspect the specific reported fields. After validation, call again with the same `specFile` and hash, omitting `validateOnly`, to use the normal diff, approval, revision, and cache-refresh flow. Never edit `.agent-graph/graphs/*.json` directly.
8. A second identical validation error stops the current agent turn. Do not repeat unchanged arguments or call internal revision functions through bash. Explain the remaining error; continue from the corrected draft on the next user turn. `graph_list` reloads project files, so use it to verify the active version.

## Rollback

1. Call `graph_history` without a revision hash to list immutable revisions.
2. Call it again with the chosen `definitionHash` to inspect the exact spec and its diff from active.
3. Show the target version/hash and behavior or permission changes, then obtain explicit confirmation.
4. Call `graph_rollback` with `graph`, `targetDefinitionHash`, and the current active `expectedDefinitionHash`.

A rollback reactivates the exact historical version and hash. It does not manufacture a new version. If any tool reports `stale`, reload history and reopen only the decisions affected by the concurrent change.

## Safety

- Built-in graphs cannot be updated or rolled back.
- Never bypass interactive approval by writing graph or history files yourself.
- Never change an in-flight run. New runs use the active revision; old resumable runs remain bound to their recorded revision.
- If history is missing, corrupt, or does not match the requested hash, stop and report the failure instead of falling back to the active definition.
