---
name: create-graph
description: Create validated Pi graph workflow specs through an interactive shared-understanding interview. Use when the user invokes /graph-create or /skill:create-graph, or asks Codex to turn a workflow idea into a safe project graph JSON file via the graph_create tool.
---

# Create Graph

## Required Reference

Read `references/graph-spec.md` before asking questions, drafting a graph, or calling any tool. Use it as the source of truth for JSON fields, node types, safety rules, and examples.

## Language Contract

- Infer the graph's presentation language from the language the user uses for the initial workflow idea and subsequent answers. Ignore code, identifiers, quoted source text, and product names when inferring it.
- If the user explicitly requests a language, that choice wins. If the conversation is genuinely ambiguous, confirm the language before drafting; otherwise do not add a language question.
- Conduct the interview, shared-understanding summary, and confirmation in that presentation language.
- Write every user-visible graph field in that language: top-level `description`; every top-level and parallel-child `label`; approval `title` and `message`; human-facing `systemPrompt` and `prompt` text; `transitionLabels`; and every router case/default `label`.
- Require a `label` for every created node even though the schema keeps it optional for backward compatibility. This prevents the UI from falling back to machine ids.
- Set all five `transitionLabels` fields (`next`, `approved`, `declined`, `default`, and `error`) for every new graph. Give every router case and default an explicit localized `label` so the graph canvas never falls back to compiler-generated English text.
- When a prompt node produces the final answer or other user-facing prose, explicitly instruct it to answer in the presentation language unless the user requested a different output language.
- Keep machine-facing fields in their required portable form: `name` stays ASCII kebab-case; `id`, `agentName`, and `outputKey` stay ASCII lower snake_case; tool names, Skill names, provider/model ids, JSON keys, and required protocol enum values remain unchanged. Do not translate identifiers merely for display.

## Workflow

1. Restate the user's graph idea as a decision tree.
   - Separate facts from product decisions.
   - Resolve facts yourself with read-only environment inspection or read-only research.
   - Run independent fact investigations in parallel when useful, and delay only the downstream questions that depend on unresolved facts.
   - Treat graph behavior, safety policy, node boundaries, dependency choices, and UX tradeoffs as product decisions.
   - Treat retry count, recovery branches, and the idempotency risk of failed mutating nodes as product decisions.

2. Ask product-decision questions in rounds.
   - Ask the complete current decision frontier in each round.
   - Number every question.
   - Give each question 2-3 choices and mark one `Recommended`.
   - Do not hide open same-round decisions unless they depend on unresolved facts.
   - Ask dependency questions in later rounds after core graph behavior and safety are known.

3. Recompute the decision tree after every answer.
   - Remove answered branches.
   - Add newly exposed branches.
   - Split oversized scope into smaller graph proposals before continuing.
   - Pause and ask for a prototype, example, logs, or other evidence when conversation alone cannot decide a branch.

4. Draft the JSON graph spec.
   - Use only the DSL in `references/graph-spec.md`.
   - Apply the Language Contract to all human-readable fields and keep machine identifiers separate from display text.
   - Keep node ids lower snake_case.
   - Keep the graph name kebab-case and aligned with `.agent-graph/graphs/<kebab-name>.json`.
   - Make subagent `tools` explicit. Any tool the current Pi session exposes may be named if `graph_capabilities` confirms it can load in a child — the built-in coding tools plus whatever installed packages and extensions register. For a non-read-only subagent, start with Pi's four default coding tools: `read`, `bash`, `edit`, and `write`; add `grep`, `find`, or `ls` only when its task needs them, and add a custom tool only when that node's task actually calls for it.
   - For a read-only graph or parallel child, keep only the useful read-only tools (`read`, plus `grep`, `find`, or `ls` as needed); never add `bash`, `edit`, or `write` merely to satisfy the default baseline.
   - Never invent a tool name. Call `graph_capabilities` (discover it with `tool_search` if needed) and follow every `nextOffset` page before assigning nodes. This lists inactive tools without enabling them. Use exact names with `subagent: "available"`; never assign parent-only inline tools such as `tool_search`. For direct tool nodes require `toolNode: true`. `graph_create` checks registration and child loadability; the child checks its actual loaded tools before its first model request.
   - Custom tools count as read-only by default. Set `"mutates": true` on the node when a custom tool changes the workspace, so it obeys the same read-only, parallel, and approval rules as `bash`/`edit`/`write`.
   - Make every subagent `skills` allowlist explicit. Review the `graph_capabilities` skill entries and current Pi `<available_skills>` descriptions, assign only the smallest set that directly matches that node's task, and use `[]` when none match. Never invent a Skill name. Read each selected SKILL.md and relevant references to identify the tools its task needs; explicitly include them and all catalog `requiredTools`. A skill does not enable tools. Optional `graph-required-tools` frontmatter declares mandatory exact tool names; undeclared task-specific dependencies still need your review.
   - Any subagent with assigned Skills must include `read`, because it must load each selected `SKILL.md` before acting.
   - Use `mutationPolicy: "mutating"` when a graph includes `bash`, `edit`, `write`, or any node marked `"mutates": true`.
   - Add `approvalNodeId` only when the user explicitly wants that node gated by approval.
   - Keep every parallel child read-only.
   - Use router equality cases only.
   - Use `failure.maxAttempts` only for top-level read-only `prompt`, `subagent`, or `tool` nodes. Use `failure.onError` when the workflow needs an explicit recovery node; never place `failure` on parallel children or control nodes.
   - Reserve `data.__graphError` for the runtime failure object. Never use `__graphError` as initial input or an `outputKey`.
   - Use only safe template variables: `goal`, `cwd`, and `data.<path>`.
   - Do not include compiler-derived `capabilities`, `transitions`, or `approvalBindings`.

5. Confirm shared understanding before creation.
   - When the decision frontier is empty, show a concise graph summary in the presentation language: file path, purpose, safety policy, start node, nodes, localized transition labels, each subagent's tool and Skill allowlists, approval gates, failure/retry policy, router cases, parallel lanes, and any limits.
   - Ask for explicit shared-understanding confirmation.
   - Do not activate a graph until the user clearly confirms; `validateOnly: true` may run while drafting.

6. Create the graph through the tool.
   - Call `graph_create` with the confirmed draft’s `specFile`.
   - Do not write `.agent-graph/graphs` files yourself.
   - Do not submit without `validateOnly` before confirmation.

## Error Handling

- If `graph_create` returns a validation error, reopen only the affected decision branch.
- Fix only the invalid part of the spec.
- Recompute the summary. Reopen confirmation only if the correction changes the agreed behavior or permissions; routine syntax fixes keep the existing scope.
- If a validation error reveals a larger product decision, ask the next numbered question instead of guessing.

## Submitting the draft

Write the graph to a separate draft JSON file. Prefer `graph_create({specFile: "path/to/draft.json", validateOnly: true})` to validate before approval, then submit the same `specFile` without `validateOnly`. Do not retype large graphs as inline tool arguments. Preserve `next`, `outputKey`, `parseJson`, and `label`. On validation failure, edit the indicated fields in the draft; do not repeat unchanged JSON. Two identical validation errors stop the agent turn. Never use internal revision functions through bash to bypass the tool workflow.
