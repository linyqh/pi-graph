# Agent graph / workflow 产品与开源项目调研

> 调研日期：2026-08-26
> 比较基线：`@viccydev/pi-graph` 1.3.0，仓库提交 `2905346`
> 证据范围：只使用各项目的官方仓库、官方文档和官方产品页；没有使用博客、媒体文章或二手榜单。

## 结论先行

市场上有很多“graph”产品，但它们并不是同一种产品：

1. **执行语义最接近**：LangGraph、Microsoft Agent Framework、CrewAI Flows、Mastra。它们都有路由、并行、持久化/恢复和 human-in-the-loop（HITL），但通常是通用 Python/TypeScript SDK 或服务平台，不是 Pi 内嵌、项目目录原生的图运行时。
2. **产品哲学最接近**：**GitHub Agentic Workflows（`gh-aw`）**。它同样强调 repository-native 定义、编译期校验、显式工具/权限 allowlist、默认只读和安全输出。它却不是节点状态图：实际执行载体是 GitHub Actions 的事件、定时任务和 job/run，而不是本地 Pi 会话中的逐节点 checkpoint/resume。
3. **可视化平台最接近**：Dify、Flowise、n8n。它们的画布、连接器和托管能力明显更成熟，但定义与运行主要属于服务端 workspace，不以仓库内可审查 JSON 为第一边界。Flowise 还已进入停止维护/归档/EOL 流程，不适合作为新产品技术底座。
4. **耐久执行基础设施**：Temporal 的可靠性最强，但它是工作流基础设施，不是 agent graph authoring 产品；更适合作为未来远程/长任务执行后端，而非替换 pi-graph。
5. **coding agent 相邻产品**：OpenHands 的 sandbox、workspace 和权限模型值得参考，但它解决的是“安全运行编码代理”，不是“定义和恢复确定性的多节点图”。

因此，pi-graph 不应把差异化押在“也有节点和连线”上。更清晰的位置是：

> **面向 Pi coding agent 的本地、repository-scoped、可审查、可恢复、安全约束型 agent graph runtime。**

## pi-graph 比较基线

当前仓库确认的能力如下：

- 项目图保存为可信 cwd 内的 `.agent-graph/graphs/*.json`；读取时检查显式项目信任、realpath、符号链接、文件类型、大小、名称和 schema，并编译为运行时图。
- 节点类型包括 `prompt`、`subagent`、`tool`、`approval`、`router`、`parallel`；并行子节点限制为只读，最大并发 4。
- 图级 `mutationPolicy` 与节点级 `mutates` / `approvalNodeId` 联合约束修改行为；subagent 的工具和 Skill 都是显式 allowlist。
- 每个节点保存 checkpoint；运行可 `paused/interrupted/failed` 后恢复。恢复校验 cwd、图名、版本、定义哈希、源路径和不可变上下文，保留 runId，并以 `resumeCount` 做 compare-and-swap。
- 失败恢复提供 checkpoint-safe retry，但不承诺 exactly-once；外部副作用需幂等键或补偿。
- subagent 在隔离的 `pi --mode json -p --no-session` 子会话运行；当前 cwd 同时只允许一个活动图。
- 运行状态投影到 Pi session，可在 TUI 中查看图、节点状态、边遍历、审批和恢复信息；目前不是拖拽式图编辑器。

基线证据：[README](../../README.md)、[类型与 capability 模型](../../extensions/graph-engine/types.ts)、[声明式 schema/compiler](../../extensions/graph-engine/declarative.ts)、[项目图信任与路径边界](../../extensions/graph-engine/project-graphs.ts)、[runtime](../../extensions/graph-engine/runtime.ts)。

## 一览矩阵

### 直接或高度相近的 graph runtime

| 项目 | 开源/商业状态 | 核心抽象 | checkpoint / resume | HITL | 并行 / 路由 | 可视化 | 项目级定义与安全边界 | 与 pi-graph 的关系 |
|---|---|---|---|---|---|---|---|---|
| **LangGraph + LangSmith Deployment/Studio** | LangGraph 为 MIT；LangSmith 托管、部署和企业能力为商业产品 | `StateGraph`、共享 state、node、edge、thread、run | 每一步持久化到 thread；支持故障恢复、pending writes、time travel/fork | `interrupt()` 可无限期暂停，恢复时注入值；支持审批/编辑 | 条件边、循环、并行分支和子图 | Studio 可看图、逐步状态、breakpoint、re-run/fork | 图通常是应用代码；tool 由应用显式传入，但 OSS runtime 不替宿主做 workspace 隔离或修改声明 | **执行语义最完整的直接参照**；生产 infra/观测更强，pi-graph 的 Pi、本地项目文件和编译期修改约束更专用 |
| **Microsoft Agent Framework（MAF）** | MIT；微软当前主推的 agent/workflow SDK | executor、typed message、edge、superstep、request port、sub-workflow | superstep checkpoint 包含 executor state、待投递消息和 pending request；内存/文件/Cosmos provider 可恢复 | RequestPort 与 tool approval；请求随 checkpoint 保留并在恢复后重发 | 条件边、fan-out/fan-in、并发、handoff/group chat/Magentic | Mermaid、DOT、Graphviz 导出；不是交互式 Studio | Python/.NET/Go 代码定义；工具与宿主权限由应用配置 | **图运行时语义很近**；生态/语言面更广，但没有 Pi 项目 JSON、cwd 信任和 mutation policy |
| **AutoGen GraphFlow** | MIT，但官方仓库已进入 maintenance mode；新用户被引导到 MAF | `DiGraphBuilder`、AgentChat agent、directed edge | GraphFlow 文档重点不是耐久 checkpoint；不应视为 MAF checkpoint 的等价能力 | 可借 AgentChat 交互模式实现，但 GraphFlow 本身不是强 HITL runtime | 顺序、并行、条件、循环；仍标为 experimental | 无同等级官方交互画布 | Python 代码；工具权限由 agent 配置 | 历史上相近，但 2026 年不应作为首选基准或新依赖 |
| **CrewAI Flows** | CrewAI 核心 MIT；CrewAI AMP/Studio/托管为商业产品 | Python `Flow`、`@start`、`@listen`、`@router`、typed/unstructured state | 2026 checkpoint 系统可保存 Flow/Crew/Agent/任务状态，跳过已完成工作，JSON/SQLite 存储，支持 resume/fork 和 checkpoint tree | `@human_feedback` 暂停并等待自由文本/结构化反馈，可接自定义 provider | 多 start 可并行；router、循环、branch；可组合 Crew | `flow.plot()` 输出 HTML；AMP 有 Crew Studio | Python 代码/AMP 项目；agent 显式取得 tools，但无 pi-graph 同类项目 realpath/只读并行/mutation contract | **2026 年功能面已很接近**；更偏 autonomous multi-agent/crew，pi-graph 更偏可约束、可审查的本地编排 |
| **LlamaIndex Workflows** | MIT；可独立使用 `llama-index-workflows` | typed Event、`@step`、Context；事件类型形成控制流 | 默认是 ephemeral；应用需序列化 Context，并监听 step state 自行快照；in-flight step 恢复后可能重跑；可接 DBOS | `InputRequiredEvent` / `HumanResponseEvent`；跨请求需应用保存/恢复 Context | 事件分支、循环、并发事件、fan-in | 可绘制 HTML/Mermaid；WorkflowServer debugger 可看事件并发送 HITL | Python 代码；官方安全政策明确由宿主负责认证、授权、输入校验与可信执行环境 | 核心语义相近但默认耐久性较弱；pi-graph 的 checkpoint、恢复身份校验和项目边界更“开箱即用” |
| **Mastra Workflows** | 核心 Apache-2.0；`ee` 目录为商业许可 | TypeScript typed workflow，`.then/.branch/.parallel/.loop`，可引用 agent/tool | snapshot 包含完成输出、执行路径、暂停步骤和 retry 状态；存储后可 resume | workflow step 可 suspend/resume | 顺序、分支、并行、循环；支持动态 JSON workflow | Mastra Studio 显示图与逐步执行 | TS 代码或存储中的动态 JSON；工具需注册，但无 pi-graph 同等 cwd/trust/mutation 编译约束 | **TypeScript 生态中很接近**；平台栈更广，pi-graph 对 Pi 和项目安全语义更深 |

### 可视化平台、耐久执行和 coding-agent 相邻产品

| 项目 | 开源/商业状态 | 关键能力 | 与 pi-graph 的核心差异 |
|---|---|---|---|
| **GitHub Agentic Workflows (`gh-aw`)** | MIT；由 GitHub 官方维护 | 仓库内 Markdown + YAML frontmatter 编译为 Actions lock workflow；事件/cron/手动触发；默认只读、显式 permissions/tools、沙箱/网络策略、safe outputs、环境审批 | **安全与 repository-native 哲学最接近，但不是节点图 runtime**。恢复单位是 Actions job/run 的 retry/re-run，不是本地 Pi 节点 checkpoint；运行发生在 GitHub-hosted/self-hosted runner，不在交互式 Pi TUI |
| **Dify** | 自托管源码可用，但许可证是带额外限制的 modified Apache 2.0，**不是标准 OSI Apache-2.0 开源许可**；另有 Dify Cloud | 可视化 Workflow/Chatflow、模型/RAG/tool/plugin、IF/ELSE、iteration、有限并行、逐节点调试、运行日志 | 平台 workspace + 服务端运行；公开文档未把“任意中间节点 durable pause 后的人类恢复”呈现为核心能力。产品面更广，但 repository-first 审查、Pi 会话和 mutation contract 更弱 |
| **Flowise Agentflow V2** | 社区部分 Apache-2.0，enterprise 路径商业许可；官方已公告 2026-08-13 归档、2026-08-31 EOL | 可视化 Agentflow、条件/循环/并行、checkpoint 持久化、重启后恢复、逐 tool “Require Human Input” | 功能上是最接近的 no-code 画布之一，但它是 server platform，且已停止维护，**不应作为新底座** |
| **n8n** | Sustainable Use License / fair-code source-available，**不是 OSI 开源许可**；云和企业能力商业化 | 成熟连接器画布、DB 执行记录、Wait node、webhook/form resume、AI tool 审批、RBAC | 面向通用业务自动化。v1 同一 execution 中多分支按顺序执行，不是 agent graph 原生并行；项目/权限主要属于 n8n server，而非仓库内 Pi 定义 |
| **Temporal** | 各 SDK/server 核心开源；TypeScript SDK MIT；Temporal Cloud 商业 | Workflow/Activity、event history、deterministic replay、Signal、retry、heartbeat、Saga、长任务耐久性 | 是基础设施而非 graph authoring/UI。可靠性与分布式伸缩远强，但开发和部署成本最高；适合作为未来后端，不是直接产品替代 |
| **OpenHands** | agent server/SDK 核心 MIT；enterprise 路径另有商业限制 | coding agent、workspace、Docker sandbox、tools、conversation/event stream、confirmation/security analyzer、Agent Canvas | 是 coding-agent harness 和控制面，不提供用户定义的确定性 DAG/checkpoint graph；安全 sandbox 值得借鉴，产品类别相邻而非直接竞品 |

## 重点产品分析

### 1. GitHub Agentic Workflows (`gh-aw`)：哲学上最近

`gh-aw` 的源文件放在仓库中，以 Markdown 写 agent 指令、以 YAML frontmatter 声明 trigger、permission、tool 和执行参数，再编译为不可手改的 GitHub Actions lock workflow。Actions 提供事件触发、cron、runner、日志、并发和 job orchestration。

它与 pi-graph 的重叠非常具体：

- **repository-native**：定义跟代码一起 review、version、branch；默认分支是信任边界。
- **先编译后执行**：编译阶段做 schema/配置校验，生成可审计的运行文件。
- **默认低权限**：GitHub token 默认只读，权限需要显式声明；tools/MCP 也是显式选择。
- **将不可信模型输出与真实写操作分离**：safe outputs 先产生结构化、可验证意图，再由单独、窄权限 job 创建 issue/PR/comment 等。
- **多 agent engine**：官方文档列出 Copilot、Claude、Codex、Gemini 和 Pi 等执行引擎。
- **人类门禁**：可以借 GitHub Environment protection 在执行敏感 job 前等待审批。

但不要把它误判为 pi-graph 的 hosted 版本：

- `gh-aw` 的核心拓扑是 GitHub Actions workflow/job；agentic Markdown 描述“一次 agent 工作”，不是 `prompt → router → parallel → approval` 的持久化节点图。
- 触发是 GitHub event、schedule、dispatch、slash command 等，运行于 hosted/self-hosted runner；pi-graph 是当前 cwd 和 Pi session 内的本地交互运行。
- `gh-aw` 可使用 Actions 的 retry/re-run/concurrency/queue，但官方模型不是从一个 graph node checkpoint 恢复。pi-graph 会保存 `currentNode/data/history/approvals/resumeCount`，并验证图哈希与 cwd 后从节点继续。
- `gh-aw` 的 credential isolation、网络控制、safe output job 和审计面明显更强；pi-graph 则有更精细的本地节点状态、路由、并行只读约束和 TUI 恢复体验。

第一方来源：[Overview](https://github.github.com/gh-aw/introduction/overview/)、[How agentic workflows work](https://github.github.com/gh-aw/introduction/how-they-work/)、[Permissions](https://github.github.com/gh-aw/reference/permissions/)、[Safe outputs](https://github.github.com/gh-aw/reference/safe-outputs/)、[Security FAQ](https://github.github.com/gh-aw/reference/faq/)、[Concurrency](https://github.github.com/gh-aw/reference/concurrency/)、[Actions/default-branch 信任边界](https://github.github.com/gh-aw/guides/github-actions-primer/)、[MIT License](https://github.com/github/gh-aw/blob/main/LICENSE)。

### 2. LangGraph / LangSmith：执行语义和生产观测的上限参照

LangGraph 的 checkpoint 以 thread 为单位，每个 super-step 保存 state；这同时支撑 durable execution、HITL、memory、time travel/fork 和故障恢复。`interrupt()` 在任意节点中暂停，恢复时继续该节点；因此副作用要满足幂等或放在 task/node 边界中。并行节点成功写入的 pending writes 可以保留，失败恢复时不用重复已成功分支。

Studio 不只是静态画图：它能显示节点遍历与中间 state、设置 breakpoint、管理 assistant/thread、re-run 和 fork。生产侧 Agent Server 把 assistant/thread/run/cron、task queue、数据库 checkpoint 和 worker 恢复包装为部署运行时；LangSmith Deployment/Cloud/Enterprise 则是商业产品。

对 pi-graph 最重要的差异不是功能缺口，而是责任边界：LangGraph 允许应用把任意 Python/JS 函数和 tool 放入节点，宿主自己承担文件系统、网络、秘密和副作用治理；pi-graph 在 schema/compiler/runtime 中直接表达 read-only、mutation、approval 和项目路径信任。

第一方来源：[LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)、[Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)、[Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)、[Tools/ToolNode](https://docs.langchain.com/oss/python/langchain/tools)、[Studio](https://docs.langchain.com/langsmith/studio)、[Agent Server](https://docs.langchain.com/langsmith/agent-server)、[Deployment options](https://docs.langchain.com/langsmith/deployment)、[OSS 与 LangSmith 边界](https://docs.langchain.com/langsmith/faq)、[MIT License](https://github.com/langchain-ai/langgraph/blob/main/LICENSE)。

### 3. Microsoft Agent Framework / AutoGen：应以 MAF 为主，不再以 GraphFlow 为主

MAF workflow 以 executor 和 typed message 为基本单元，按 superstep 执行，支持条件 edge、fan-out/fan-in、sub-workflow 和多种 agent orchestration。checkpoint 保存 executor state、下一 superstep 的消息、request/response 和共享状态；RequestPort 则把人类输入与 tool approval 变成可持久化请求。可视化以 Mermaid/DOT/Graphviz 导出为主。

AutoGen GraphFlow 仍能表达顺序、并行、条件和循环图，但官方明确标为 experimental；AutoGen 仓库也处于 maintenance mode，并引导新用户使用 MAF。因此市场比较中可以保留 AutoGen 作为历史参照，但不能把它当作微软 2026 年的主线产品。

第一方来源：[MAF workflows](https://learn.microsoft.com/en-us/agent-framework/concepts/workflows/)、[Checkpointing](https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints)、[HITL](https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop)、[Visualization](https://learn.microsoft.com/en-us/agent-framework/workflows/visualization)、[Orchestrations](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/)、[MAF MIT License](https://github.com/microsoft/agent-framework/blob/main/LICENSE)、[AutoGen GraphFlow](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/graph-flow.html)、[AutoGen repo/status](https://github.com/microsoft/autogen)。

### 4. CrewAI Flows：2026 checkpoint 能力使它成为真正的直接参照

Flows 是事件驱动的 Python 编排：method 通过 `@start`、`@listen` 和 `@router` 连接，共享 typed/unstructured state。新 checkpoint 系统会保存 Flow、Crew、Agent、task、memory/knowledge、intermediate output 和事件 lineage；恢复会跳过已经完成的工作，并支持 JSON/SQLite、fork 与 TUI checkpoint tree。`@human_feedback` 支持自由文本反馈、结果路由和自定义 provider。

它比 pi-graph 更偏向 Crew/Agent 自治协作和商业 AMP 控制面；pi-graph 的优势是单个声明式文件即可看清节点、工具、修改权限和审批边界，不需要引入一个新的 Python agent 平台。

第一方来源：[Flows](https://docs.crewai.com/en/concepts/flows)、[Checkpointing](https://docs.crewai.com/v1.15.17/en/concepts/checkpointing)、[Human feedback](https://docs.crewai.com/v1.15.17/en/learn/human-feedback-in-flows)、[CrewAI AMP](https://docs.crewai.com/enterprise/introduction)、[MIT License](https://github.com/crewaiinc/crewai/blob/main/LICENSE)。

### 5. LlamaIndex Workflows：事件模型强，默认 durable 责任更靠近应用

LlamaIndex 通过函数参数和返回值中的 typed Event 隐式形成边；普通条件语句可以分支，发送多个 event 可并发，再由 `collect_events` 一类模式 fan-in。HITL 也是 event：发出 `InputRequiredEvent`，外部收到后再发送 `HumanResponseEvent`。

官方 durable workflow 文档明确：Workflow 默认是 ephemeral；Context 可序列化，但应用要监听状态并写存储。已经完成的 step 可以避免重跑，但 checkpoint 时仍在执行的 step 恢复后可能再次执行，语义接近 at-least-once。若要更强保证，可接 DBOS 等持久执行集成。

第一方来源：[Workflows introduction](https://developers.llamaindex.ai/python/llamaagents/workflows/)、[Durable workflows](https://developers.llamaindex.ai/python/llamaagents/workflows/durable_workflows/)、[HITL](https://developers.llamaindex.ai/python/llamaagents/workflows/human_in_the_loop/)、[Drawing/debugger](https://developers.llamaindex.ai/python/llamaagents/workflows/drawing/)、[Security policy](https://github.com/run-llama/llama_index/blob/main/SECURITY.md)、[MIT License](https://github.com/run-llama/llama_index/blob/main/LICENSE)。

### 6. Dify：产品化画布强，但许可和运行边界不同

Dify 把 Workflow/Chatflow、model、RAG、tool/plugin、trigger 和发布 API 集成在一个服务端 Studio 中。画布支持 IF/ELSE、iteration、并行、单节点运行和缓存变量；节点可以配置 stop/default/failure branch 等错误策略。

两点需要谨慎表达：

- Dify 的 LICENSE 以 Apache 2.0 为基础，但增加多租户服务商业许可、前端 logo/版权信息等附加条件。它不是原样 Apache-2.0，也不应在矩阵中标成标准 OSI 开源项目。
- 当前官方公开文档能确认运行日志、错误分支和触发器，却没有把类似 LangGraph/pi-graph 的“任意中间节点 checkpoint + 长期 HITL + 精确节点恢复”呈现为核心 runtime contract。因此表中标为“未由当前公开文档确认”，而不是武断断言绝对没有。

第一方来源：[Dify repo](https://github.com/langgenius/dify)、[Modified license](https://github.com/langgenius/dify/blob/main/LICENSE)、[Studio/workflow creation](https://docs.dify.ai/en/guides/application-orchestrate/creating-an-application)、[Error handling](https://docs.dify.ai/zh/use-dify/build/predefined-error-handling-logic)、[Plugin permissions](https://docs.dify.ai/en/develop-plugin/features-and-specs/plugin-types/plugin-info-by-manifest)、[Trigger plugin](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/trigger-plugin)。

### 7. Flowise：功能接近，但已 EOL

Agentflow V2 有条件、LLM router、循环、并行、agent supervisor/worker、持久 checkpoint 和逐 tool HITL。带相同 `sessionId` 的 prediction 可发送 `humanInput`，从停下的 checkpoint 继续；应用重启后也可以恢复。这确实是最接近 pi-graph 的可视化产品之一。

但官方维护者已公告停止 core development、2026-08-13 归档仓库并于 2026-08-31 EOL。以本调研日期看，它适合做功能参考，不适合成为依赖或迁移目标。许可也应精确写成“社区目录 Apache-2.0、enterprise 目录及指定文件商业许可”，而不是把整个仓库笼统称为纯 Apache。

第一方来源：[Flowise docs](https://docs.flowiseai.com/)、[Agentflow V2](https://docs.flowiseai.com/using-flowise/agentflowv2)、[Prediction/resume](https://docs.flowiseai.com/using-flowise/prediction)、[HITL](https://docs.flowiseai.com/tutorials/human-in-the-loop)、[Mixed license](https://github.com/FlowiseAI/Flowise/blob/main/LICENSE.md)、[官方 EOL 公告](https://github.com/FlowiseAI/Flowise/discussions/6727)。

### 8. n8n：成熟 durable automation，不是原生 agent graph runtime

n8n 的 Wait node 会暂停 execution，把执行数据卸载到数据库，并可按时间、webhook 或 form 恢复；resume URL 可设 Basic/Header/JWT/IP allowlist。AI tool HITL 会在高风险 tool 调用前通过聊天等渠道要求批准，也适用于 subagent。

但 n8n v1 的多输出分支在同一个 execution 内按既定顺序执行，而不是像 pi-graph `parallel` 一样原生并发。它的优势是连接器、运营、执行数据库和团队 RBAC，不是 agent state graph 的细粒度语义。

n8n 的 Sustainable Use License 是 fair-code/source-available 许可，允许内部业务和非商业使用，但限制将其作为商业服务提供；它不是 OSI-approved open-source license。

第一方来源：[Sustainable Use License 文档](https://github.com/n8n-io/n8n-docs/blob/main/docs/privacy-and-security/sustainable-use-license.md)、[Repo license](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)、[Wait node](https://github.com/n8n-io/n8n-docs/blob/main/docs/integrations/builtin/core-nodes/n8n-nodes-base.wait.md)、[HITL for AI tools](https://github.com/n8n-io/n8n-docs/blob/main/docs/build/integrate-ai/ai-examples/human-in-the-loop-for-tools.md)、[Execution order](https://github.com/n8n-io/n8n-docs/blob/main/docs/build/flow-logic/understand-execution-order.md)、[Sub-workflow](https://github.com/n8n-io/n8n-docs/blob/main/docs/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow.md)、[RBAC](https://github.com/n8n-io/n8n-docs/blob/main/docs/administer/manage-users-and-access/set-permissions-and-roles-rbac/README.md)。

### 9. Temporal：若需要 server-grade durability，应作为下层能力评估

Temporal 通过 event history 和 deterministic replay 保证 Workflow 的耐久运行，把网络、LLM、文件等不确定副作用放到 Activity。Activity 默认 retry；长任务可 heartbeat，并从 heartbeat details 继续；Human approval 通常由 Signal 唤醒 Workflow，失败补偿使用 Saga。

这比 pi-graph 当前本地 JSON checkpoint 更适合多 worker、高可用和数天/月级任务，但 Temporal UI 是运行观测器，不是 agent graph 编辑器；Workflow 仍要用代码定义，并且需要 server/worker/storage 运维。若 pi-graph 将来增加远程执行，它是 storage/runtime adapter 候选，而不是前端产品替代。

第一方来源：[TypeScript SDK](https://github.com/temporalio/sdk-typescript)、[MIT License](https://github.com/temporalio/sdk-typescript/blob/main/LICENSE)、[Retry policies](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/retry-policies.mdx)、[AI durability patterns](https://github.com/temporalio/documentation/blob/main/docs/ai/index.mdx)、[Temporal UI](https://github.com/temporalio/ui)。

### 10. OpenHands：安全 sandbox 参照，不是 graph 竞品

OpenHands 的 Agent SDK/Agent Server 把 agent、conversation、tool、workspace、event 和 security 组合起来。本地可运行，远程模式可放到 sandbox；OpenHands 应用默认用 Docker runtime 隔离任意代码，并提供 confirmation mode 与 security analyzer。Agent Canvas 是 conversation/files/terminal/backends/automation 的控制面。

这与 pi-graph 的交集是 coding agent、项目 workspace、tool 权限和运行历史；差异是 OpenHands 围绕一个编码代理的持续循环与安全环境展开，没有让用户定义、编译、checkpoint 和恢复多节点 DAG。可以借鉴其 sandbox/secret/confirmation 边界，但不宜放在“直接 graph runtime”象限。

第一方来源：[OpenHands repo/license boundary](https://github.com/OpenHands/OpenHands)、[SDK architecture](https://docs.openhands.dev/sdk/arch/overview)、[Sandbox runtime](https://docs.openhands.dev/openhands/usage/architecture/runtime)、[Agent Canvas](https://github.com/OpenHands/docs/blob/main/openhands/usage/agent-canvas/overview.mdx)、[Confirmation/security config](https://docs.openhands.dev/openhands/usage/environment-variables)。

### 11. Mastra：值得补充的 TypeScript 直接参照

Mastra workflow 支持 typed state、顺序、branch、parallel、loop、suspend/resume 和 retry。snapshot 会保存已经完成的输出、当前路径、暂停步骤和 retry 状态；Studio 可以查看图和步骤执行。2026 年的 dynamic workflows 还允许把引用已注册 agent/tool/control-flow step 的 JSON graph 存在数据库中，无需重新部署即可修改。

它与 pi-graph 同属 TypeScript，并同时覆盖代码图与动态 JSON，是除 LangGraph/MAF/CrewAI 外最值得持续观察的 runtime。差异仍在安全与宿主：Mastra 是通用 agent application framework，pi-graph 把 Pi tools/Skills、可信 cwd、只读并行与审批绑定直接纳入 schema/compiler。

第一方来源：[Mastra repo](https://github.com/mastra-ai/mastra)、[Core/enterprise license](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md)、[Workflow snapshots](https://mastra.ai/en/reference/workflows/snapshots)、[AI workflows/Studio](https://mastra.ai/ai-workflows)、[Dynamic workflows](https://mastra.ai/blog/introducing-dynamic-workflows)。

## 能力判断的几个边界

### “有执行记录”不等于“有 checkpoint resume”

- LangGraph、MAF、CrewAI、Flowise、Mastra 和 Temporal 都有明确的中间状态持久化与恢复 contract。
- LlamaIndex 能实现，但默认由应用负责快照 Context，且 in-flight step 是 at-least-once。
- Dify 文档中的运行日志/重试/错误分支不能自动推导为任意节点 durable resume。
- GitHub Actions 和 n8n 都能保留 execution/run，但其恢复粒度和 graph node checkpoint 并不相同。

### “有审批”也分三类

1. **运行中断模型**：LangGraph interrupt、MAF RequestPort、CrewAI human feedback、Flowise checkpoint HITL、Mastra suspend。
2. **业务自动化等待模型**：n8n Wait/HITL、Temporal Signal。
3. **权限分离模型**：`gh-aw` safe outputs + GitHub Environment protection。它最强调真实写操作与模型输出隔离，但不是在 agent 节点内部继续一个 graph state。

### “开源”必须按真实许可证表达

- 标准宽松开源：LangGraph MIT、MAF MIT、AutoGen MIT、CrewAI core MIT、LlamaIndex MIT、Mastra core Apache-2.0、Flowise community Apache-2.0、Temporal TS SDK MIT、OpenHands core MIT。
- 混合仓库：Mastra/Flowise/OpenHands 的企业目录或文件另有商业条款。
- 非标准 OSI 开源：Dify modified Apache 2.0；n8n Sustainable Use License。两者都可以自托管和查看源码，但不应简写为“Apache 开源”或“OSI 开源”。

## 对 pi-graph 的产品建议

### 应保持的差异化

- **保持 repository-scoped JSON 为第一等定义**：能 code review、版本化、迁移和离线运行，而不是把图锁进一个 server workspace。
- **保持 Pi-native**：直接复用当前 Pi session 暴露的 tools、Skills、模型、TUI 和项目 cwd；不要为了“看起来像平台”先引入独立控制面。
- **保持编译期安全语义**：`mutationPolicy`、`mutates`、`approvalNodeId`、只读并行、显式工具/Skill allowlist 和可信路径是比通用 graph SDK 更有辨识度的能力。
- **把 checkpoint contract 写得比竞品更诚实**：继续明确 checkpoint-safe retry 与 exactly-once 的边界，要求修改型节点幂等或补偿。

### 最值得吸收的能力

1. **从 `gh-aw` 吸收安全输出分离**：让修改型 node 先输出受 schema 约束的 intent/artifact，再由窄权限 executor 应用；未来再加入 network/domain allowlist 和 secret exposure policy。
2. **从 LangGraph/MAF 吸收 checkpoint adapter 与 time travel**：保留当前文件存储，同时定义 pluggable checkpointer；增加从某 checkpoint fork 新 run，而不是改写原 run。
3. **从 CrewAI/Mastra 吸收 checkpoint tree 与 provider 化 HITL**：TUI 之外允许 webhook/IM/UI provider 恢复，并显示 fork lineage。
4. **从 OpenHands 吸收 sandbox profile**：对含 shell/code 的修改型子代理提供可选 Docker/remote sandbox，而不只依赖工具 allowlist。
5. **只把 Dify/n8n 当作产品交互参考**：可以学习节点调试、run history 和连接器浏览，但不建议扩张成通用 low-code integration platform。

## 最终定位判断

若只问“有没有类似项目”，答案是肯定的；若问“有没有完全相同的产品”，当前调研没有发现。

- LangGraph/MAF/CrewAI/Mastra 覆盖了 graph runtime 大部分通用能力。
- Dify/Flowise/n8n 覆盖了可视化画布与运营平台。
- Temporal 覆盖了 server-grade durability。
- OpenHands 覆盖了 coding-agent sandbox。
- **只有 `gh-aw` 与 pi-graph 同时把仓库内定义、编译校验、显式权限和 agent 工具治理放在产品中心，但它用 GitHub Actions run 取代本地节点图。**

pi-graph 的可守位置不是“又一个 graph framework”，而是把这些能力压缩到 Pi 的本地 coding-agent 场景中，并把项目边界、修改权限和恢复身份做成 runtime contract。
