---
name: create-graph
description: Create validated Pi graph workflow specs through an interactive shared-understanding interview. Use when the user invokes /graph-create or /skill:create-graph, or asks Codex to turn a workflow idea into a safe project graph JSON file via the graph_create tool.
---

# Create Graph

## Required Reference

Read `references/graph-spec.md` before asking questions, drafting a graph, or calling any tool. Use it as the source of truth for JSON fields, node types, safety rules, and examples.

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
   - Keep node ids lower snake_case.
   - Keep the graph name kebab-case and aligned with `.agent-graph/graphs/<kebab-name>.json`.
   - Make subagent `tools` explicit. For a non-read-only subagent, start with Pi's four default coding tools: `read`, `bash`, `edit`, and `write`; add `grep`, `find`, or `ls` only when its task needs them.
   - For a read-only graph or parallel child, keep only the useful read-only tools (`read`, plus `grep`, `find`, or `ls` as needed); never add `bash`, `edit`, or `write` merely to satisfy the default baseline.
   - Make every subagent `skills` allowlist explicit. Review the current Pi `<available_skills>` names and descriptions, assign only the smallest set that directly matches that node's task, and use `[]` when none match. Never invent a Skill name.
   - Any subagent with assigned Skills must include `read`, because it must load each selected `SKILL.md` before acting.
   - Use `mutationPolicy: "mutating"` when a graph includes `bash`, `edit`, or `write`.
   - Add `approvalNodeId` only when the user explicitly wants that node gated by approval.
   - Keep every parallel child read-only.
   - Use router equality cases only.
   - Use `failure.maxAttempts` only for top-level read-only `prompt`, `subagent`, or `tool` nodes. Use `failure.onError` when the workflow needs an explicit recovery node; never place `failure` on parallel children or control nodes.
   - Reserve `data.__graphError` for the runtime failure object. Never use `__graphError` as initial input or an `outputKey`.
   - Use only safe template variables: `goal`, `cwd`, and `data.<path>`.
   - Do not include compiler-derived `capabilities`, `transitions`, or `approvalBindings`.

5. Confirm shared understanding before creation.
   - When the decision frontier is empty, show a concise graph summary: file path, purpose, safety policy, start node, nodes, each subagent's tool and Skill allowlists, approval gates, failure/retry policy, router cases, parallel lanes, and any limits.
   - Ask for explicit shared-understanding confirmation.
   - Do not call `graph_create` until the user clearly confirms.

6. Create the graph through the tool.
   - Call `graph_create` with the confirmed JSON spec.
   - Do not write `.agent-graph/graphs` files yourself.
   - Do not call `graph_create` before confirmation.

## Error Handling

- If `graph_create` returns a validation error, reopen only the affected decision branch.
- Fix only the invalid part of the spec.
- Recompute the summary and get explicit shared-understanding confirmation again before retrying `graph_create`.
- If a validation error reveals a larger product decision, ask the next numbered question instead of guessing.
