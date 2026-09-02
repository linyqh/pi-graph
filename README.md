# pi-graph

`pi-graph` 是一个面向 Pi 的可校验、可恢复智能体图工作流运行时。项目级定义和最新运行快照统一存入独立的 `.agent-graph/` 存储模块；访谈式图创建器会把用户目标拆成经过确认的声明式工作流，并安全保存为 `.agent-graph/graphs/<name>.json`。

包内置一个图：

- `research`：工作区盘点、纯模型拆解、两个只读子代理并行研究、路由和汇总。

自定义修改图直接操作当前工作目录，不创建独立工作树。任何 `bash/edit/write` 节点都必须位于可信项目中；默认不强制审批，也可以通过 `approvalNodeId` 显式增加审批门。

## 环境与安装

- Node.js `>=22.19`
- Pi `@earendil-works/pi-coding-agent ^0.84.1`

从 npm 安装正式版本：

```bash
pi install npm:@viccydev/pi-graph
```

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

更新已有项目图使用 `/graph-update <name> <变更要求>` 或 `update-graph` Skill。它先通过 `graph_history` 读取当前哈希和历史版本，再把完整新 spec 与 `expectedDefinitionHash` 交给 `graph_update`。更新前会展示版本、节点、权限、Tool/Skill 和路由差异并再次确认；禁止直接覆盖 JSON。`graph_rollback` 可在确认后精确重新激活一个历史哈希。

Subagent 与 `tool` 节点的工具名不再受固定白名单限制：当前 Pi 会话注册了哪些工具，图就能声明哪些工具，包括已安装包和扩展提供的自定义工具（例如 `fpa_query`）。`graph_create` 会用 `pi.getAllTools()` 校验，写错或写了不存在的工具名会明确失败并列出可用名称。创建器为非只读 Subagent 优先保留 Pi 默认的 `read/bash/edit/write` 四个编码工具，再按节点任务追加 `grep/find/ls` 或所需的自定义工具。只读图和并行子节点不会为了凑齐默认工具而获得修改权限；它们只分配实际需要的只读工具。最终写入确认会逐个展示 Subagent 的工具与 Skill 白名单。

引擎无法判断自定义工具做了什么，因此它们默认按只读处理——这正是 `fpa_query` 这类查询工具能出现在只读图和并行子节点里的原因。会改动工作区的自定义工具，需要节点显式声明 `"mutates": true`，此后它与 `bash/edit/write` 受同样约束：只读图拒绝、并行子节点拒绝、`approval-required` 策略下必须绑定审批节点。

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
- `graph_history` 列出项目图不可变 revision；指定哈希时同时返回该版本的完整 spec 及其与当前版本的语义差异。
- `graph_update` 接受完整新 spec 和当前 `expectedDefinitionHash`，通过 compare-and-swap、交互确认和原子替换激活新版本；名称不能改变，内容变化时版本必须改变。
- `graph_rollback` 接受目标哈希和当前预期哈希，重新激活目标的精确内容与版本，不制造新的版本号。
- `graph_delete` 只删除当前可信项目中已经加载的项目图；删除前展示名称和路径并再次确认，同时删除该图的受管 revision 历史。内置图、未知图、无交互界面或用户拒绝时不会删除。
- `graph_run` 接受动态字符串图名，在执行时查询图目录，并声明为顺序执行。图完成时，终止执行节点的输出会直接进入模型可见的工具正文，并同时保存在 `details.output` 和检查点的 `state.finalOutput` 中；`outputKey` 只决定该值在 `state.data` 中的名称。节点失败时，模型正文改为有效的精简 JSON，包含真实失败节点、错误、`runId` 和安全恢复参数；外层主 Agent 应先诊断并修复可验证的外部原因，再按原样调用返回的 `graph_resume` 参数，不能盲目重试。
- `graph_run.context` 可携带最多 16 个不可变运行标识，键必须匹配 `^[A-Za-z][A-Za-z0-9_-]{0,63}$`，值必须是最多 256 UTF-8 字节的字符串。Context 独立于可变 `data`，会随检查点持久化并投影到 UI；声明式模板通过 `{{context.<key>}}` 只读访问，恢复时不得替换。
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
  "transitionLabels": {
    "next": "继续",
    "approved": "已批准",
    "declined": "已拒绝",
    "default": "其他情况",
    "error": "失败"
  },
  "start": "inspect",
  "maxSteps": 6,
  "nodes": [
    {
      "id": "inspect",
      "type": "parallel",
      "label": "并行检查",
      "concurrency": 2,
      "children": [
        {
          "id": "test_review",
          "type": "subagent",
          "label": "检查测试覆盖",
          "agentName": "test_reviewer",
          "tools": ["read", "grep", "find", "ls"],
          "skills": [],
          "prompt": "检查 {{cwd}} 中与 {{goal}} 有关的测试覆盖。"
        },
        {
          "id": "code_review",
          "type": "subagent",
          "label": "检查实现风险",
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
      "label": "汇总发现",
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
      "label": "说明失败原因",
      "prompt": "汇总节点失败：{{data.__graphError.message}}。给出可执行的排查建议。",
      "outputKey": "finalSummary"
    }
  ]
}
```

顶层约束：

- 图名匹配 `^[a-z][a-z0-9-]{0,63}$`，文件固定为 `.agent-graph/graphs/<name>.json`。
- 节点 ID 匹配 `^[a-z][a-z0-9_]{0,63}$`，包括并行子节点在内全局唯一。
- 创建器会根据用户对话语言生成 `description`、全部节点 `label`、审批文案、提示词和分支标签；机器字段仍使用规定的 ASCII 格式。`transitionLabels` 可本地化编译器生成的继续、审批、默认和失败连线，旧图省略时仍使用英文回退。
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
| `tool` | 直接调用会话中的一个工具。内置的 `read/bash/edit/write/grep/find/ls` 由引擎自行构造；其他已注册工具需要宿主安装工具解析器（见下文），否则请改用 `subagent` 节点。 |
| `approval` | 使用交互界面确认；拒绝可跳转或结束，没有交互界面时暂停。 |
| `router` | 从固定 `data` path 读取 JSON 标量，按有序等值 cases 和显式 default 路由。 |
| `parallel` | 并行执行 1 到 8 个只读提示、子代理或工具子节点，并按子节点 ID 保持顺序汇总。首个失败后停止派发新子节点，并等待已经启动的子节点收敛后再发布父节点失败。 |

模板只允许：

```text
{{goal}}
{{cwd}}
{{context.cycle_id}}
{{data.path.to.value}}
```

`context` 是 `graph_run` 提供并随检查点持久化的不可变运行标识；工具参数中的精确占位符保留原 JSON 类型，字符串中的占位符转成文本。路径缺失会让节点明确失败，不会替换成空字符串。DSL 不支持表达式、脚本、`eval`、第三方扩展工具、嵌套并行节点或自定义归并器。

`capabilities`、`transitions` 和 `approvalBindings` 由编译器推导，JSON 不能自行声明。包含 `bash/edit/write` 的工具或子代理使用 `mutationPolicy: "mutating"` 时无需绑定审批节点；需要人工门禁时可显式设置 `approvalNodeId`，旧的 `approval-required` 策略仍要求所有修改节点绑定审批。并行子节点永远不能修改工作区。

完整字段和可复制示例见 `skills/create-graph/references/graph-spec.md`。

## 动态图目录与安全加载

每个工作目录都有独立的 `GraphCatalog`，用于合并不可变内置图与可信项目下的 `.agent-graph/graphs/*.json`：

- 只读取普通 `.json` 文件，不跟随图文件符号链接。
- 每个文件独立解析；损坏的 JSON 或无效图只产生诊断，不影响内置图和其他有效图。
- 内置图、项目图之间不能重名，项目图不能遮蔽内置图。
- `graph_create` 保存前完整编译，批准后使用排他写入，绝不覆盖现有路径。
- `graph_update` 与 `graph_rollback` 只操作项目图，使用预期哈希拒绝过期请求，并通过事务日志和原子重命名切换激活版本。
- 手工改图后通过 `/reload` 刷新；通过 `graph_create` 创建则在当前会话立即激活。

旧版 `.pi/graphs/*.json` 在可信项目首次启动时会安全迁移到新目录。迁移前或发生目标冲突时仍可兼容读取旧目录；新建 Graph 只写入新目录，且绝不覆盖同名旧定义。

建议把 `.agent-graph/graphs/` 中的激活定义纳入版本控制，把 `.agent-graph/runs/` 视为可重建的本地运行数据并加入项目 `.gitignore`。受管历史位于 `.agent-graph/catalog/graph-revisions/<name>/`：`revisions/<definitionHash>.json` 保存规范化不可变定义，`history.json` 保存 create/update/rollback/observed 激活记录，`transaction.json` 只在未完成的切换中存在。Graph Engine 不会改写 `.agent-graph/catalog/` 下其他工具管理的目录。

## 状态与恢复

运行状态为 `running`、`paused`、`interrupted`、`completed` 或 `failed`。每个检查点保存模式版本、图版本、工作目录、当前节点、截断后的节点结果、审批记录、历史摘要、结构化 `lastFailure` 和 `resumeCount`。节点状态还记录当前总尝试次数；每次失败和重试都有独立历史事件。最新快照原子写入 `.agent-graph/runs/<runId>.json`，同时保留 Pi session 的 `graph-run` entry 作为会话事件投影。

项目图还会保存规范化 JSON 的 SHA-256 `definitionHash` 和来源路径。每个项目图运行开始前，当前定义都会确保写入不可变 revision。恢复时优先匹配激活定义；若 Graph 已受控更新，则按检查点的名称、版本和哈希加载历史 revision，仍由运行时执行完整身份校验。历史缺失、损坏或哈希不匹配时明确失败，不会退回当前版本。

恢复保留原 `runId/data/history`，递增 `resumeCount`，并从 `currentNode` 重新执行。以下情况会拒绝恢复：

- 运行已经完成或仍处于 `running`；
- 检查点模式版本、图版本、项目图哈希或来源路径不匹配；
- 图或当前节点已经删除；
- 工作目录不一致；
- 运行来自 0.1 旧模式。

修改型节点在中断后恢复时会再次请求确认。没有交互界面时，审批和修改型恢复都保持 `paused`。`session_start` 会把遗留的 `running` 检查点标记为 `interrupted`。

失败恢复提供 checkpoint-safe retry，不承诺 exactly-once。修改型节点如果在产生部分外部副作用后抛错，再次确认恢复仍可能重复执行；这类节点应使用幂等写入、稳定业务键或显式补偿。受控更新不会改变已经启动的运行；手工编辑仍应先 `/reload`，随后新的运行会归档并绑定编辑后的哈希。

## TypeScript 图与运行时节点

内置图仍可使用 TypeScript 节点工厂。所有副作用都通过 `GraphExecutionServices`：

- `completePrompt`：使用当前 `modelRegistry.complete` 做一次无工具模型调用。
- `runSubagent`：启动隔离的 `pi --mode json -p --no-session` 工具循环。
- `invokeTool`：直接调用 Pi 的 `read/bash/edit/write/grep/find/ls` 工厂函数；其他工具名交给宿主安装的工具解析器。

### 宿主接入点

`tool` 节点在进程内执行工具定义，但 Pi 的 `ExtensionAPI` 只暴露工具元数据（`getAllTools()`），拿不到执行器——`getToolDefinition()` 在 `AgentSession` 上，扩展永远收不到它。另外 Subagent 是独立 `pi` 子进程，它需要知道宿主用的 agent 目录，否则会去读默认的 `~/.pi/agent`，那里既没有宿主的凭证也没有宿主安装的包。

因此持有会话的宿主（例如 Pi Web）通过 `extensions/graph-engine/host-bridge.ts` 注册这两项：

```ts
import { registerGraphHostEnvironment, registerGraphToolResolver } from "@viccydev/pi-graph/extensions/graph-engine/host-bridge.ts";

registerGraphToolResolver((name, ctx) => findSessionFor(ctx)?.getToolDefinition(name));
registerGraphHostEnvironment({ agentDir: sharedAgentDir });
```

两个注册表都挂在 `globalThis` 的约定符号上（`Symbol.for("pi-graph.tool-resolver")`、`Symbol.for("pi-graph.host-environment")`），而不是模块作用域：宿主的打包器与 Pi 的扩展加载器会各自实例化该模块，模块级单例无法共享。因此宿主也可以完全不导入本包，直接写这两个键。

agent 目录只在派生子进程的 `env` 里生效，不会写进宿主的 `process.env`——多租户宿主在同一个进程里交错处理请求，而 SDK 每次调用都现读这个变量。

未注册解析器时，`tool` 节点仍能跑内置的 7 个编码工具；遇到自定义工具会明确报错并提示改用 `subagent` 节点，而 `subagent` 节点本身不依赖解析器——它通过 `pi --tools` 起子进程，任何已注册工具都能用。

新增内置图时创建 `graphs/<name>.ts`，再把定义加入 `graphs/index.ts` 的定义数组。注册表会先拒绝重名，再生成映射和名称列表。扩展加载及每次执行前都会校验起始节点、节点键和 ID、静态跳转、路由候选目标、可达性、审批引用、并行约束和 `maxSteps`。

## 输出限制与边界

- 每个工作目录同时只运行一个活动图；`graph_run`、`graph_resume`、`graph_create`、`graph_update`、`graph_rollback` 和 `graph_delete` 都按顺序执行。
- 模型、子代理、工具和渲染器文本统一限制为 50KB/2000 行。
- 检查点不保存完整消息流，只保留截断后的最终文本、结构化结果、用量、模型和停止原因。
- 项目图支持受控版本更新、历史查询和精确回滚；不允许修改正在执行的 Graph 定义。
- 1.1 不支持全局图、远程图仓库、跨会话恢复、后台调度、持久化子代理对话、修改型并行子节点或第三方扩展工具。

## 验证

```bash
npm run typecheck
npm test
npm run check
```

自动测试使用 Node 22 内置 `node:test`，不需要网络或模型凭据。

## 发布到 npm

发布动作由 GitHub Release 触发。Release 标签必须严格使用 `v<package.json version>`，例如版本 `1.3.0` 对应 `v1.3.0`。工作流会检出该标签、执行 `npm ci`、`npm run check` 和包内容预检，全部通过后发布公开包 `@viccydev/pi-graph`。普通 Release 发布到 `latest`，Prerelease 发布到 `next`。

发布认证使用 npm Trusted Publishing / OIDC，不使用长期 npm Token。Trusted Publisher 必须精确配置为 GitHub 用户 `linyqh`、仓库 `pi-graph`、工作流文件 `publish.yml`，Allowed action 为 `npm publish`。工作流必须保留 `permissions.id-token: write`，不得重新加入 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`。

Pi 手工冒烟流程：

1. `/graph-list` 应显示 `research`。
2. `/graph-create "创建一个并行检查项目质量并汇总报告的工作流"` 应先调查事实，再按决策前沿分轮提问。
3. 确认共识摘要后，再批准文件写入；新图应立即出现在 `/graph-list` 中。
4. 运行只读新图，完成后 `git diff --exit-code` 应无变化。
5. 对修改图拒绝计划审批时应无修改，批准后才允许执行修改节点。
6. 修改已保存的 JSON 后，旧检查点应因哈希不匹配而拒绝恢复。
7. 让一个只读节点失败，`graph_run` 正文应是可解析 JSON；修复外部原因后用其中的 `graph_resume` 参数恢复，`runId` 应不变且 `resumeCount` 加一。
