# pi-graph-engineering

`pi-graph-engineering` 是一个面向 Pi 的可校验、可恢复智能体图工作流运行时。项目级定义和最新运行快照统一存入独立的 `.agent-graph/` 存储模块；访谈式图创建器会把用户目标拆成经过确认的声明式工作流，并安全保存为 `.agent-graph/graphs/<name>.json`。

包内置一个图：

- `research`：工作区盘点、纯模型拆解、两个只读子代理并行研究、路由和汇总。

自定义修改图直接操作当前工作目录，不创建独立工作树。任何 `bash/edit/write` 节点都必须位于可信项目中；默认不强制审批，也可以通过 `approvalNodeId` 显式增加审批门。

## 环境与安装

- Node.js `>=22.19`
- Pi `@earendil-works/pi-coding-agent ^0.84.1`

在仓库根目录执行：

```bash
npm ci
npm run check
pi install "$PWD"
```

启动 Pi 后运行：

```text
/graph-list
```

应看到 `research`。代码、技能、提示模板或手工编辑的项目图发生变化后，在 Pi 中执行 `/reload`。

## 创建工作流

推荐入口：

```text
/graph-create "创建一个并行检查项目质量并汇总报告的工作流"
```

也可以直接启动创建图技能：

```text
/skill:create-graph
```

创建器会按以下顺序工作：

1. 把目标建模为决策树，自动调查能够从仓库和工具获得的事实。
2. 按当前决策前沿分轮提问；每个产品决策都给出 2 到 3 个选项和推荐答案。
3. 决策前沿清空后展示共识摘要，等待用户明确确认。
4. 调用受控 `graph_create` 工具做完整模式、语义、权限和路径校验。
5. 终端界面再次展示文件路径、节点、每个 Subagent 的工具与 Skill 白名单、修改工具和审批节点，请求最终写入确认。
6. 使用排他写入创建 `.agent-graph/graphs/<name>.json`，不会覆盖已有文件，也不会自动运行新图。

保存成功后无需 `/reload`，新图会立即出现在 `/graph-list`、`graph_list`、命令补全和 `graph_run` 中。通过 `graph_delete` 删除后目录也会立即刷新。若手工修改或删除 JSON，则需要 `/reload` 重新加载图目录。

创建器为非只读 Subagent 优先保留 Pi 默认的 `read/bash/edit/write` 四个编码工具，再按节点任务追加 `grep/find/ls`。只读图和并行子节点不会为了凑齐默认工具而获得修改权限；它们只分配实际需要的只读工具。最终写入确认会逐个展示 Subagent 的工具与 Skill 白名单。

每个 Subagent 还可通过 `skills` 分配当前 Pi 会话中已经加载的 Skill 名称。创建器根据 `<available_skills>` 的名称和描述选择最小匹配集合；运行时使用 `--no-skills` 隔离默认发现结果，再按名称解析并加载选中的 Skill。未分配时使用空数组，未知或已经不可用的 Skill 会明确失败，不会静默回退到全部 Skill。

没有交互界面、项目未被信任、用户拒绝审批、图名冲突或校验失败时，不会创建目录或文件。项目可信状态由 Pi 管理；未信任时扩展完全不读取项目 Graph 定义，包括标记为只读的图。

## 命令与模型工具

```text
/graph-list
/graph-status
/graph <name> "<goal>"
/graph research "梳理检查点与恢复实现"
/graph-resume
/graph-resume <runId>
```

- `/graph-list` 动态列出内置图、当前可信项目图、版本、来源、修改策略、审批绑定和加载诊断。
- `/graph-status` 显示当前会话分支中最新的检查点。0.1 旧检查点可查看，但不可恢复。
- `/graph-resume` 恢复当前会话分支和工作目录中最近的 `paused/interrupted/failed` 运行，也可指定 `runId`。
- `graph_list` 向模型返回当前工作目录可用图的动态目录。模型应先调用它发现图名。
- `graph_create` 只负责验证、再次确认和创建新图，不支持覆盖、编辑或删除。
- `graph_delete` 只删除当前可信项目中已经加载的项目图；删除前展示名称和路径并再次确认。内置图、未知图、无交互界面或用户拒绝时不会删除。
- `graph_run` 接受动态字符串图名，在执行时查询图目录，并声明为顺序执行。图完成时，终止执行节点的输出会直接进入模型可见的工具正文，并同时保存在 `details.output` 和检查点的 `state.finalOutput` 中；`outputKey` 只决定该值在 `state.data` 中的名称。节点失败时，模型正文改为有效的精简 JSON，包含真实失败节点、错误、`runId` 和安全恢复参数；外层主 Agent 应先诊断并修复可验证的外部原因，再按原样调用返回的 `graph_resume` 参数，不能盲目重试。
- `graph_resume` 只供模型恢复当前会话分支、当前工作目录中的精确 `failed` 快照。它要求 `runId` 和预期 `resumeCount`，在执行队列内重新读取最新检查点并做 compare-and-swap 校验，避免重复或过期调用恢复了另一次失败。人工 `/graph-resume` 仍可恢复 `paused/interrupted/failed`。

## 声明式 JSON DSL

项目图使用 `schemaVersion: 1`：

```json
{
  "schemaVersion": 1,
  "name": "quality-check",
  "version": "1.0.0",
  "description": "并行检查项目质量并汇总报告。",
  "mutationPolicy": "read-only",
  "start": "inspect",
  "maxSteps": 6,
  "nodes": [
    {
      "id": "inspect",
      "type": "parallel",
      "concurrency": 2,
      "children": [
        {
          "id": "test_review",
          "type": "subagent",
          "agentName": "test_reviewer",
          "tools": ["read", "grep", "find", "ls"],
          "skills": [],
          "prompt": "检查 {{cwd}} 中与 {{goal}} 有关的测试覆盖。"
        },
        {
          "id": "code_review",
          "type": "subagent",
          "agentName": "code_reviewer",
          "tools": ["read", "grep", "find", "ls"],
          "skills": [],
          "prompt": "只读检查 {{goal}} 的实现风险。"
        }
      ],
      "next": "summarize"
    },
    {
      "id": "summarize",
      "type": "prompt",
      "prompt": "目标：{{goal}}\n\n并行结果：{{data.inspect}}\n\n汇总发现。",
      "outputKey": "finalSummary",
      "failure": {
        "maxAttempts": 2,
        "onError": "report_failure"
      }
    },
    {
      "id": "report_failure",
      "type": "prompt",
      "prompt": "汇总节点失败：{{data.__graphError.message}}。给出可执行的排查建议。",
      "outputKey": "finalSummary"
    }
  ]
}
```

顶层约束：

- 图名匹配 `^[a-z][a-z0-9-]{0,63}$`，文件固定为 `.agent-graph/graphs/<name>.json`。
- 节点 ID 匹配 `^[a-z][a-z0-9_]{0,63}$`，包括并行子节点在内全局唯一。
- `version` 省略时规范化为 `1.0.0`；`maxSteps` 为 `1..256`；全部节点最多 64 个。
- 单文件最多 256 KiB；单个提示或系统提示模板最多 32 KiB。
- 未知字段、文件名不匹配、路径穿越、符号链接和原型链路径都会被拒绝。

顶层 `prompt/subagent/tool` 可声明失败策略：

```json
"failure": {
  "maxAttempts": 3,
  "onError": "repair"
}
```

- `maxAttempts` 是包含首次执行的总尝试次数，默认为 1，范围为 `1..3`；每次实际尝试都计入 `maxSteps`。
- 自动重试只允许只读节点。修改型节点可声明 `onError`，但不能把 `maxAttempts` 设为 2 或 3，避免部分副作用被自动重复。
- 重试耗尽后，`onError` 把结构化错误写入 `data.__graphError` 并沿显式 `error` 边进入处理节点；没有 `onError` 时整图进入 `failed`。
- Abort、项目信任、审批、未知节点、非法跳转和 `maxSteps` 属于运行时控制错误，不会被重试或错误边吞掉。
- `onError` 不能和正常边指向同一节点；修改型节点的错误分支不能再回到该修改节点，避免借错误环重复副作用。
- `failure` 不适用于 `approval/router/parallel` 或并行子节点；`__graphError` 是运行时保留键，不能作为初始输入或 `outputKey`。

六种节点：

| 类型 | 行为 |
| --- | --- |
| `prompt` | 单次纯模型调用，不使用工具；可选 JSON 输出和提供商/模型覆盖。 |
| `subagent` | 隔离 Pi 子代理；`tools` 是工具白名单，`skills` 是 Skill 名称白名单；空数组分别禁用对应能力。 |
| `tool` | 直接调用 `read/bash/edit/write/grep/find/ls` 中的一个内置工具。 |
| `approval` | 使用交互界面确认；拒绝可跳转或结束，没有交互界面时暂停。 |
| `router` | 从固定 `data` path 读取 JSON 标量，按有序等值 cases 和显式 default 路由。 |
| `parallel` | 并行执行 1 到 8 个只读提示、子代理或工具子节点，并按子节点 ID 保持顺序汇总。首个失败后停止派发新子节点，并等待已经启动的子节点收敛后再发布父节点失败。 |

模板只允许：

```text
{{goal}}
{{cwd}}
{{data.path.to.value}}
```

工具参数中的精确占位符保留原 JSON 类型；字符串中的占位符转成文本。路径缺失会让节点明确失败，不会替换成空字符串。DSL 不支持表达式、脚本、`eval`、第三方扩展工具、嵌套并行节点或自定义归并器。

`capabilities`、`transitions` 和 `approvalBindings` 由编译器推导，JSON 不能自行声明。包含 `bash/edit/write` 的工具或子代理使用 `mutationPolicy: "mutating"` 时无需绑定审批节点；需要人工门禁时可显式设置 `approvalNodeId`，旧的 `approval-required` 策略仍要求所有修改节点绑定审批。并行子节点永远不能修改工作区。

完整字段和可复制示例见 `skills/create-graph/references/graph-spec.md`。

## 动态图目录与安全加载

每个工作目录都有独立的 `GraphCatalog`，用于合并不可变内置图与可信项目下的 `.agent-graph/graphs/*.json`：

- 只读取普通 `.json` 文件，不跟随图文件符号链接。
- 每个文件独立解析；损坏的 JSON 或无效图只产生诊断，不影响内置图和其他有效图。
- 内置图、项目图之间不能重名，项目图不能遮蔽内置图。
- `graph_create` 保存前完整编译，批准后使用排他写入，绝不覆盖现有路径。
- 手工改图后通过 `/reload` 刷新；通过 `graph_create` 创建则在当前会话立即激活。

旧版 `.pi/graphs/*.json` 在可信项目首次启动时会安全迁移到新目录。迁移前或发生目标冲突时仍可兼容读取旧目录；新建 Graph 只写入新目录，且绝不覆盖同名旧定义。

建议把 `.agent-graph/graphs/` 中的定义纳入版本控制，把 `.agent-graph/runs/` 视为可重建的本地运行数据并加入项目 `.gitignore`。`.agent-graph/catalog/` 预留给目录与晋升元数据，Graph Engine 不会改写其中其他工具管理的内容。

## 状态与恢复

运行状态为 `running`、`paused`、`interrupted`、`completed` 或 `failed`。每个检查点保存模式版本、图版本、工作目录、当前节点、截断后的节点结果、审批记录、历史摘要、结构化 `lastFailure` 和 `resumeCount`。节点状态还记录当前总尝试次数；每次失败和重试都有独立历史事件。最新快照原子写入 `.agent-graph/runs/<runId>.json`，同时保留 Pi session 的 `graph-run` entry 作为会话事件投影。

项目图还会保存规范化 JSON 的 SHA-256 `definitionHash` 和来源路径。恢复时，即使图名和版本相同，只要 JSON 内容改变也会被拒绝。

恢复保留原 `runId/data/history`，递增 `resumeCount`，并从 `currentNode` 重新执行。以下情况会拒绝恢复：

- 运行已经完成或仍处于 `running`；
- 检查点模式版本、图版本、项目图哈希或来源路径不匹配；
- 图或当前节点已经删除；
- 工作目录不一致；
- 运行来自 0.1 旧模式。

修改型节点在中断后恢复时会再次请求确认。没有交互界面时，审批和修改型恢复都保持 `paused`。`session_start` 会把遗留的 `running` 检查点标记为 `interrupted`。

失败恢复提供 checkpoint-safe retry，不承诺 exactly-once。修改型节点如果在产生部分外部副作用后抛错，再次确认恢复仍可能重复执行；这类节点应使用幂等写入、稳定业务键或显式补偿。项目图内容若在失败后被修改，恢复会因定义哈希变化而拒绝，应启动新运行。

## TypeScript 图与运行时节点

内置图仍可使用 TypeScript 节点工厂。所有副作用都通过 `GraphExecutionServices`：

- `completePrompt`：使用当前 `modelRegistry.complete` 做一次无工具模型调用。
- `runSubagent`：启动隔离的 `pi --mode json -p --no-session` 工具循环。
- `invokeBuiltinTool`：直接调用 Pi 的 `read/bash/edit/write/grep/find/ls` 工厂函数。

新增内置图时创建 `graphs/<name>.ts`，再把定义加入 `graphs/index.ts` 的定义数组。注册表会先拒绝重名，再生成映射和名称列表。扩展加载及每次执行前都会校验起始节点、节点键和 ID、静态跳转、路由候选目标、可达性、审批引用、并行约束和 `maxSteps`。

## 输出限制与边界

- 每个工作目录同时只运行一个活动图；`graph_run`、`graph_resume`、`graph_create` 和 `graph_delete` 都按顺序执行。
- 模型、子代理、工具和渲染器文本统一限制为 50KB/2000 行。
- 检查点不保存完整消息流，只保留截断后的最终文本、结构化结果、用量、模型和停止原因。
- 1.1 不支持覆盖、编辑或迁移已有项目图；项目图可通过 `graph_delete` 确认后删除。
- 1.1 不支持全局图、远程图仓库、跨会话恢复、后台调度、持久化子代理对话、修改型并行子节点或第三方扩展工具。

## 验证

```bash
npm run typecheck
npm test
npm run check
```

自动测试使用 Node 22 内置 `node:test`，不需要网络或模型凭据。

Pi 手工冒烟流程：

1. `/graph-list` 应显示 `research`。
2. `/graph-create "创建一个并行检查项目质量并汇总报告的工作流"` 应先调查事实，再按决策前沿分轮提问。
3. 确认共识摘要后，再批准文件写入；新图应立即出现在 `/graph-list` 中。
4. 运行只读新图，完成后 `git diff --exit-code` 应无变化。
5. 对修改图拒绝计划审批时应无修改，批准后才允许执行修改节点。
6. 修改已保存的 JSON 后，旧检查点应因哈希不匹配而拒绝恢复。
7. 让一个只读节点失败，`graph_run` 正文应是可解析 JSON；修复外部原因后用其中的 `graph_resume` 参数恢复，`runId` 应不变且 `resumeCount` 加一。
