# Pi Graph JSON Spec

Use this reference when creating a graph through the `create-graph` skill. The user-facing DSL is JSON stored by the graph creator as `.agent-graph/graphs/<kebab-name>.json`. Do not write that file directly; submit the confirmed spec to `graph_create`.

## Rules

- Use only JSON values: objects, arrays, strings, numbers, booleans, and null.
- Set top-level `schemaVersion` to `1`.
- Set `version` to `1.0.0` for a new graph.
- Set `maxSteps`; it is required.
- Name graph files with kebab-case: `.agent-graph/graphs/code-review-loop.json`.
- Use lower snake_case for node ids: `approve_plan`, `route_review`.
- Define `nodes` as an array. Every node must include an explicit `id`.
- Define only six node types: `prompt`, `subagent`, `tool`, `approval`, `router`, and `parallel`.
- Omit compiler-derived fields: `capabilities`, `transitions`, and `approvalBindings`.
- Treat `bash`, `edit`, and `write` as mutating tools. Use `mutationPolicy: "mutating"` to run them in a trusted project without mandatory approval.
- Set `approvalNodeId` only when the workflow intentionally requires approval before a specific mutating node.
- Keep `parallel` children read-only. Parallel children must not use `bash`, `edit`, or `write`.
- Allow only `prompt`, `subagent`, and `tool` children inside `parallel`. Do not nest `parallel`, `router`, or `approval` nodes inside `parallel`.
- Declare subagent tools explicitly. For non-read-only subagents, prefer Pi's default coding baseline `['read', 'bash', 'edit', 'write']`, then add `grep`, `find`, or `ls` only when the task needs them.
- The default coding baseline is a creation preference, not an automatic permission escalation. Read-only graphs and parallel children must omit `bash`, `edit`, and `write`; give them `read` plus only the read-only search tools they need.
- Declare every subagent's `skills` explicitly by Skill name. Select only names present in the current Pi `<available_skills>` list whose descriptions directly match the node task; use `[]` when none match and never invent names.
- A subagent with one or more assigned Skills must include `read`. At runtime the graph engine disables automatic Skill discovery and loads only the selected Skills.
- Use router equality cases only. Do not use arbitrary expressions or model-generated routing code.
- Use only safe template variables: `{{goal}}`, `{{cwd}}`, and `{{data.<path>}}`.
- Decide failure behavior explicitly for fallible top-level `prompt`, `subagent`, and `tool` nodes. Use `failure.maxAttempts` only for read-only retries and `failure.onError` for a declared recovery branch.

## Template Values

Templates appear in prompt text, system prompts, approval text, and tool args. They support only these variables:

| Variable | Meaning |
| --- | --- |
| `{{goal}}` | The goal passed to `/graph <name> <goal>`. |
| `{{cwd}}` | The trusted project working directory for the run. |
| `{{data.<path>}}` | Output stored by a previous node, addressed by `outputKey` or node id plus optional nested fields. After a declared error transition, `{{data.__graphError.message}}` contains the latest node failure message. |

Examples: `{{data.findings}}`, `{{data.review.status}}`, `{{data.parallel_findings.lane_a}}`.

Do not use bare `{{data}}`, environment variables, shell expansion, filesystem globs, network URLs, or arbitrary code inside templates. Put safety instructions in prompts instead of relying on template logic.

## Top-Level Fields

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `schemaVersion` | Yes | number | Must be `1`. |
| `name` | Yes | string | Kebab-case graph name. Must match `<kebab-name>` in `.agent-graph/graphs/<kebab-name>.json`. |
| `version` | Yes | string | Use `1.0.0` for a new graph. |
| `description` | Yes | string | Short description shown by `/graph-list`. |
| `mutationPolicy` | Yes | string | `read-only`, `mutating`, or legacy `approval-required`. Use `mutating` when nodes may change the workspace; `approval-required` remains available when every mutating node must be gated. |
| `start` | Yes | string | Node id where execution begins. |
| `maxSteps` | Yes | positive integer | Maximum actual node attempts before the runtime stops. Include room for retries and loops. |
| `nodes` | Yes | array | Ordered node definitions. Every node must include an explicit `id`. |

Do not include `capabilities`, `transitions`, or `approvalBindings`. The compiler derives them from node type, `next`, `approvalNodeId`, router cases, and parallel children.

## Common Node Fields

Every node supports these identity fields; flow and output fields are listed per node type below:

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | Yes | string | Lower snake_case node id. Must be unique in the graph. |
| `type` | Yes | string | One of the six node types. |
| `label` | No | string | Human-readable label for UI/status output. |

Mutating `subagent` and `tool` nodes may also declare:

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `approvalNodeId` | No | string | Id of an `approval` node that must approve before this node runs. Omit for ungated execution under `mutationPolicy: "mutating"`. |

Top-level `prompt`, `subagent`, and `tool` nodes may declare:

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `failure` | No | object | Failure policy with `maxAttempts` and/or `onError`. It is not allowed on parallel children or control nodes. |
| `failure.maxAttempts` | No | integer | Total attempts including the first, from 1 to 3. Values above 1 are allowed only on read-only nodes. Defaults to 1. |
| `failure.onError` | No | string | Top-level node id entered after the final failed attempt. The compiler creates a labeled `error` edge. |

The runtime writes the final node failure to `data.__graphError` before following `onError`:

```json
{
  "kind": "node",
  "nodeId": "review",
  "message": "invalid response payload",
  "attempt": 2,
  "maxAttempts": 2,
  "occurredAt": 1786500000000,
  "handled": true,
  "onError": "repair",
  "resumable": false
}
```

`__graphError` is reserved and cannot be used as initial input or an `outputKey`. Abort, trust/approval failures, invalid transitions, missing nodes, and `maxSteps` exhaustion are runtime control failures: they do not retry and do not follow `onError`. `onError` cannot duplicate a normal transition target. Workspace-mutating nodes may use `onError`, but cannot automatically retry or route back to themselves through the recovery branch because a failed attempt may already have produced partial side effects.

## Prompt Nodes

Use `prompt` nodes for model-only reasoning. They are read-only and cannot use tools.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | Yes | string | Node id. |
| `type` | Yes | string | Must be `prompt`. |
| `systemPrompt` | No | string | System instruction template. |
| `prompt` | Yes | string | User prompt template. |
| `parseJson` | No | boolean | Parse model output as JSON. Use when downstream routers or prompts need structured fields. |
| `outputKey` | No | string | Key under `data` where output is stored. Defaults to the node id. |
| `next` | No | string | Next node id after successful completion. Omit to finish. |
| `provider` | No | string | Provider override. Omit unless required. |
| `model` | No | string | Model override. Omit unless required. |

When a prompt node omits `next` and completes the graph, its model output becomes the `graph_run` final output regardless of `outputKey`. String outputs are returned directly to the calling model; structured outputs are returned as formatted JSON.

## Subagent Nodes

Use `subagent` nodes for isolated Pi child agents. Tools must be explicit.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | Yes | string | Node id. |
| `type` | Yes | string | Must be `subagent`. |
| `agentName` | Yes | string | Child agent name. Use lower snake_case. |
| `tools` | Yes | string[] | Explicit allowlist. Prefer `read`, `bash`, `edit`, `write` for non-read-only subagents, then add `grep`, `find`, or `ls` as needed. |
| `skills` | No | string[] | Explicit allowlist of current Pi Skill names. New graphs should always include it; use `[]` when no available Skill matches. Omission is accepted only for backward compatibility and behaves as `[]`. |
| `systemPrompt` | No | string | System instruction template. |
| `prompt` | Yes | string | User prompt template. |
| `parseJson` | No | boolean | Parse child output as JSON. |
| `outputKey` | No | string | Key under `data` where output is stored. Defaults to the node id. |
| `next` | No | string | Next node id after successful completion. Omit to finish. |
| `provider` | No | string | Provider override. Omit unless required. |
| `model` | No | string | Model override. Omit unless required. |
| `approvalNodeId` | No | string | Optional approval node id. |

Use the following allocation policy:

- Implementation-capable subagent: begin with `["read", "bash", "edit", "write"]` so it retains Pi's normal coding capabilities.
- Add `grep`, `find`, and `ls` only when repository search or navigation materially helps that node.
- Read-only or parallel subagent: use `["read"]` as the baseline and add only `grep`, `find`, or `ls` as needed. It cannot receive `bash`, `edit`, or `write`.

For Skills, compare the node's responsibility with the names and descriptions in Pi's current `<available_skills>` block. Assign the smallest directly relevant set. Skill names are resolved to their current paths when the graph runs, so Graph JSON remains portable and does not store machine-specific absolute paths. Unknown or unavailable Skill names make creation or execution fail explicitly.

Mutating tools run directly under `mutationPolicy: "mutating"` unless the node explicitly declares `approvalNodeId`.

## Tool Nodes

Use `tool` nodes for built-in tool calls with deterministic arguments.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | Yes | string | Node id. |
| `type` | Yes | string | Must be `tool`. |
| `tool` | Yes | string | One of `read`, `grep`, `find`, `ls`, `bash`, `edit`, or `write`. |
| `args` | Yes | object | Tool arguments. Values may use safe templates. |
| `outputKey` | No | string | Key under `data` where output is stored. Defaults to the node id. |
| `next` | No | string | Next node id after successful completion. Omit to finish. |
| `approvalNodeId` | No | string | Optional approval node id. |

Prefer read-only tools for discovery. Avoid `bash` when a narrower read-only tool can answer the same question.

## Approval Nodes

Use `approval` nodes to ask the human to approve a plan, mutation boundary, or continuation decision.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | Yes | string | Node id. |
| `type` | Yes | string | Must be `approval`. |
| `title` | Yes | string | Short confirmation title. |
| `message` | Yes | string | Approval body. Include the plan, scope, and mutation boundary. |
| `yes` | Yes | string | Node id to run when approved. |
| `no` | No | string | Node id to run when declined. Omit to stop when declined. |
| `outputKey` | No | string | Key under `data` for the approval result. Defaults to the node id. |

Approval nodes are read-only. They gate later mutating nodes only when those nodes explicitly reference them through `approvalNodeId`.

## Router Nodes

Use `router` nodes for deterministic equality routing.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | Yes | string | Node id. |
| `type` | Yes | string | Must be `router`. |
| `path` | Yes | string | Safe data path to inspect, such as `data.review.status`. |
| `cases` | Yes | array | Ordered cases. Each case is `{ "equals": value, "to": "node_id" }` or `{ "equals": value, "done": true }`. |
| `default` | Yes | object | Explicit fallback, either `{ "to": "node_id" }` or `{ "done": true }`. |

Router cases compare primitive values exactly and in array order. Do not use regular expressions, JavaScript, natural-language conditions, or model calls.

## Parallel Nodes

Use `parallel` nodes for independent read-only lanes.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | Yes | string | Node id. |
| `type` | Yes | string | Must be `parallel`. |
| `children` | Yes | array | One to eight inline read-only `prompt`, `subagent`, or `tool` child nodes. Each child must include `id`. |
| `concurrency` | No | integer | 1 to 4. Defaults to 4. |
| `next` | No | string | Next node id after all children complete. |

Parallel results are always stored under the parallel node id and keyed by child id. Do not put `parallel`, `router`, `approval`, or any mutating child inside `parallel`. Parallel children must be independent and read-only.

When a child fails, the parallel node stops assigning queued children and waits for every already-started child to settle before it reports failure. It does not publish a partial reducer result. This prevents graph resume or a new run from racing with late child checkpoint writes.

## Copyable Example

```json
{
  "schemaVersion": 1,
  "name": "review-then-implement",
  "version": "1.0.0",
  "description": "Scout the repo, plan a change, request approval, implement, review, and fix once.",
  "mutationPolicy": "approval-required",
  "start": "scout",
  "maxSteps": 10,
  "nodes": [
    {
      "id": "scout",
      "type": "subagent",
      "label": "Scout",
      "agentName": "scout",
      "tools": ["read", "grep", "find", "ls"],
      "skills": [],
      "systemPrompt": "Inspect the workspace without modifying files. Return concise findings with file references.",
      "prompt": "Goal: {{goal}}\n\nFind the relevant files, existing patterns, risks, and tests to run. Do not edit files.",
      "outputKey": "findings",
      "next": "plan"
    },
    {
      "id": "plan",
      "type": "prompt",
      "label": "Plan",
      "systemPrompt": "Create a concise implementation plan with files to edit, verification, and risks.",
      "prompt": "Goal: {{goal}}\n\nScout findings:\n{{data.findings}}\n\nDraft the implementation plan.",
      "outputKey": "plan",
      "next": "approve_plan"
    },
    {
      "id": "approve_plan",
      "type": "approval",
      "label": "Approve Plan",
      "title": "Approve graph implementation plan?",
      "message": "{{data.plan}}",
      "yes": "implement",
      "no": "revise_plan"
    },
    {
      "id": "revise_plan",
      "type": "prompt",
      "label": "Revise Plan",
      "systemPrompt": "Revise a declined implementation plan. Make it more conservative and explicit.",
      "prompt": "Goal: {{goal}}\n\nDeclined plan:\n{{data.plan}}\n\nScout findings:\n{{data.findings}}\n\nProduce a revised plan.",
      "outputKey": "plan",
      "next": "approve_plan"
    },
    {
      "id": "implement",
      "type": "subagent",
      "label": "Implement",
      "agentName": "implement",
      "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
      "skills": [],
      "systemPrompt": "Make only the approved workspace changes. Follow existing project patterns. Run focused verification when practical.",
      "prompt": "Goal: {{goal}}\n\nApproved plan:\n{{data.plan}}\n\nScout findings:\n{{data.findings}}\n\nImplement the approved plan.",
      "outputKey": "implementation",
      "approvalNodeId": "approve_plan",
      "next": "review"
    },
    {
      "id": "review",
      "type": "subagent",
      "label": "Review",
      "agentName": "review",
      "tools": ["read", "grep", "find", "ls"],
      "skills": [],
      "parseJson": true,
      "systemPrompt": "Review the changed workspace. Return only JSON: {\"status\":\"pass|needs_fix\",\"summary\":\"short summary\",\"requiredFixes\":[\"fix\"]}.",
      "prompt": "Goal: {{goal}}\n\nImplementation report:\n{{data.implementation}}\n\nReview the work using read-only checks.",
      "outputKey": "review",
      "failure": { "maxAttempts": 2 },
      "next": "route_review"
    },
    {
      "id": "route_review",
      "type": "router",
      "label": "Route Review",
      "path": "data.review.status",
      "cases": [
        { "equals": "needs_fix", "to": "fix" },
        { "equals": "pass", "done": true }
      ],
      "default": { "done": true }
    },
    {
      "id": "fix",
      "type": "subagent",
      "label": "Fix",
      "agentName": "fix",
      "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
      "skills": [],
      "systemPrompt": "Apply only the review-requested fixes. Keep the patch minimal and run focused verification.",
      "prompt": "Goal: {{goal}}\n\nReview feedback:\n{{data.review}}\n\nPrevious implementation report:\n{{data.implementation}}\n\nApply the required fixes.",
      "outputKey": "implementation",
      "approvalNodeId": "approve_plan",
      "next": "review"
    }
  ]
}
```
