# Loop Engineering、Graph Engineering 与 Dynamic Workflow 调研

调研日期：2026-09-03

## 结论先行

这三个词不属于同一个分类层级，也不是一条严格的技术代际链：

- **Loop Engineering** 工程化的是“一个 Agent 或一套 Agent 系统如何反复推进、验证、记忆、停止和再次触发”。核心对象是反馈闭环。
- **Graph Engineering** 工程化的是“多个任务、Agent、资源和运行状态如何形成显式的依赖、分工、通信、同步、恢复与演化结构”。核心对象是系统级关系。
- **Dynamic Workflow** 通常不是一门统一的工程学科，而是某个产品或架构的动态能力：协调结构由谁、在什么时候、按什么输入生成、注册、修改或运行。

因此，一个系统可以同时具有三者：每个节点内部运行 Agent loop；节点之间由 graph 组织；graph 或脚本又按当前任务动态生成。但“实现了 Graph Engine”并不自动等于“完整实践了 Graph Engineering”，而“能在运行时创建工作流”也不自动说明拓扑会在执行中自我演化。

关于“Graph Engineering 是继 Loop Engineering 之后的新概念”：

- **作为 2026 年社区热词的传播顺序，基本成立。** Loop Engineering 在 6 月成型，7 月出现“loops → graphs”的传播浪潮。
- **作为技术发明顺序，不成立。** 图式工作流、多 Agent 编排、状态机和 flow engineering 更早就已存在；LangChain 官方也明确称 Graph Engineering 是成熟做法的新名称，而不是新发明。
- **作为精确术语起源，证据不足。** 2026-07-18 的触发帖只问是否已经从 loops 转向 graphs，没有提出定义、方法论或协议；更早的 2024 年公开讨论已经出现 `flow (/graph) engineering` 表述。

## 一、证据时间线

| 时间 | 一手来源 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 2024-01-16 | [AlphaCodium: From Prompt Engineering to Flow Engineering](https://arxiv.org/abs/2401.08500) | 多阶段、测试驱动、迭代式 LLM flow 早于 2026 年术语浪潮 | 不能证明当前广义 Graph Engineering 已有统一定义 |
| 2024-02-29 | [LangChain LinkedIn 原帖及 Itamar Friedman 回复](https://www.linkedin.com/posts/langchain_building-a-self-corrective-coding-assistant-activity-7168674088683589633-Zq-S) | 已出现“从 prompt engineering 转向 flow (/graph) engineering”的公开表述 | 它只是回复中的表述，不是完整方法论 |
| 2024-12-19 | [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | 已系统总结 chaining、routing、parallelization、orchestrator-workers、evaluator-optimizer 和自主 Agent loop | Anthropic 当时没有把这些统称为 Graph Engineering |
| 2026-05-28 | [Anthropic: Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) | Claude Code Dynamic Workflows 首发；模型按任务动态写编排脚本并运行大量子 Agent | Dynamic Workflow 并不晚于 Loop/Graph 两个热词 |
| 2026-06-07/08 | [Peter Steinberger 原帖](https://x.com/steipete/status/2063697162748260627)、[Addy Osmani: Loop Engineering](https://addyo.substack.com/p/loop-engineering) | “设计会替你 prompt Agent 的 loop”成为明确命名和定义 | 不能据此声称反馈循环是 2026 年才发明的 |
| 2026-06-16 | [LangChain: The Art of Loop Engineering](https://www.langchain.com/blog/the-art-of-loop-engineering) | Loop 可分为 Agent、验证、事件驱动和系统自改进等嵌套层级 | Loop Engineering 不应被误解成只能有一个 Agent |
| 2026-07-18 | [Peter Steinberger 原帖](https://x.com/steipete/status/2078277297791189132) | “Are we still talking loops or did we shift to graphs yet?”成为本轮传播触发点 | 原帖没有出现“Graph Engineering”完整术语，也没有给定义 |
| 2026-07-22 | [LangChain: 3 Years of Graph Engineering with LangGraph](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph) | 给出节点、边、状态机的工程解释，并明确“不是新想法” | 这是 LangChain 的框架视角，不等于全部 Graph Engineering |
| 2026-07-30 | [What makes prompts a graph](https://arxiv.org/abs/2607.27578) | 尝试定义较窄的 Prompt Graph Engineering | 其对象是 prompt-mediated computation，不等于广义多 Agent 系统工程 |
| 2026-08-12 | [Mastra: Introducing Dynamic Workflows](https://mastra.ai/blog/introducing-dynamic-workflows) | Dynamic Workflow 也可指运行中服务器对 JSON 工作流的增删改，无需重新部署 | 不能把 Mastra 的“dynamic”直接套到 Claude Code 或其他系统 |
| 2026-08-21（v1） | [Graph Engineering in the Era of LLM Agents](https://arxiv.org/abs/2608.21156) | 目前最完整的广义定义：任务组织、Agent 协调、运行状态管理和系统演化 | 这是新预印本提出的框架，不是业界标准、协议或已达成的共识 |

注：X 页面可能要求登录，但这里给出了原帖直链；两条原帖的文字分别被 Addy Osmani 原文和 LangChain 官方文章直接链接、引用。

## 二、Loop Engineering

### 2.1 术语来源与定义

Addy Osmani 在 2026-06-08 的原文中把 Loop Engineering 定义为：不再由人逐轮提示 Agent，而是由人设计一个会替自己提示 Agent 的系统；他把 loop 描述为一个有目标、持续迭代直到完成的 recursive goal，并明确说它位于“单次 Agent harness”之上一层。[来源](https://addyo.substack.com/p/loop-engineering)

他的构件清单包括：

1. 触发任务的自动化；
2. 隔离并行工作的 worktree；
3. 固化项目知识的 skill；
4. 接入真实系统的 plugin/connector；
5. 让执行者和检查者分离的 sub-agent；
6. 位于单次会话之外、能够跨运行保存进度的 memory。

这一定义的重点不是代码中有没有 `while`，而是人是否把以下责任工程化：**触发、目标、反馈、验证、状态、预算、停止条件和人工升级点**。

### 2.2 执行结构

一个最小闭环可表示为：

```text
触发 / 目标
  → Agent 观察环境并行动
  → 外部证据或独立检查者验证
  → 记录状态
  → 成功则停止；失败则带反馈重试；越界则升级给人
```

LangChain 的一手说明进一步把 loop 分成四层：模型调用工具的 Agent loop、失败后反馈重试的 verification loop、由 cron/webhook 等触发的 event-driven loop，以及根据生产 traces 修改 harness 的 hill-climbing loop。[来源](https://www.langchain.com/blog/the-art-of-loop-engineering)

所以“Loop Engineering = 单 Agent 串行运行”过于狭窄。Loop 可以包围多个 Agent，甚至修改内部 harness；它的辨识点是**反馈返回和重复推进的闭环**，而不是参与者数量。

### 2.3 适用场景与边界

适合：有持续或重复任务、结果可验证、失败可重试、停止条件明确、需要跨会话记忆的工作，例如 CI 修复、周期巡检、逐步迁移、持续研究与质量改进。

不适合：目标高度含糊、结果缺少可外部验证的标准、错误动作不可逆、人工判断成本高于自动化收益的任务。Loop 的主要工程风险是无限重试、奖励投机、验证器自欺、状态漂移和成本失控。

## 三、Graph Engineering

### 3.1 不能只按 LangGraph API 理解

2026 年当前至少存在三种相邻但不同的用法：

- **框架/工作流视角**：LangChain 将其解释为用节点、边和流转状态显式定义 Agent 工作流，节点可以是确定性代码、单次模型调用、工具或完整 Agent loop；边可以固定或按状态条件路由。[来源](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph)
- **Prompt Graph Engineering**：把包含模型调用和确定性变换的 prompt-mediated computation 做成显式、可执行、可版本化、可独立优化的图。[来源](https://arxiv.org/abs/2607.27578)
- **广义系统智能视角**：把任务、Agent/资源和运行状态之间的关系都变成显式、动态、可演化的系统结构。[来源](https://arxiv.org/abs/2608.21156)

用户所说“继 Loop Engineering 之后”的 Graph Engineering，更接近第三种广义定义，而不是某个框架的 Graph API。

### 3.2 广义 Graph Engineering 的工程对象

2026-08 的 Graph Engineering 预印本把它定义为面向 System Intelligence 的结构中心工程实践，包含三个相互关联的主要视图，以及一个跨运行的演化维度：[来源](https://arxiv.org/html/2608.21156)

1. **Task Organization / Work Organization**：目标如何分解；子任务依赖、顺序、并发和验证约束如何表示；语义任务如何编译为可执行工作流。
2. **Agent Coordination / Agent Team**：任务如何匹配异构 Agent 与资源；角色、能力、委派、通信、同步、冲突处理和结果汇总如何组织。
3. **Runtime State Management / State Evolution**：实际发生了什么；进度、共享结果、来源、外部副作用和失败如何记录；如何定位故障、从验证过的边界恢复。
4. **System Evolution**：一次次执行产生的证据，是否能被验证后持久地改进任务结构、团队结构或状态管理，并支持版本化与回滚。

这里的 graph 不是只有“节点和边的图形”。它是系统的**操作性组织基底**：结构变化必须真实改变调度、权限、通信、状态或恢复行为。

### 3.3 执行结构

```text
目标
  → Work Graph：拆什么、先后与并发、验证依赖
  → Agent Graph：谁负责、谁与谁通信、如何同步
  → State Graph：当前事实、来源、失败与恢复依赖
  → 执行证据反馈到上述结构
  → 可选：跨运行形成经验证、可回滚的结构演化
```

一个 Agent loop 可以是图中的节点，也可以表现为图中的 cycle。LangChain 也明确指出生产 Agent 图通常不是 DAG，loop 是一种简单的有向环图；真正新增的实践价值是，长时运行的完整 Agent 现在可以成为被更大系统组织的节点。[来源](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph)

### 3.4 适用场景与边界

适合：一个中心 Agent 的单一上下文无法可靠承载全部工作，且问题天然需要异构专长、显式依赖、并行、独立验证、共享状态、局部恢复、权限和审计的系统。

边界：只把固定步骤画成图，最多证明存在 graph-shaped workflow；要称为更完整的 Graph Engineering，还应检查任务组织、Agent 分工、运行状态是否都是一等工程对象。论文也承认当前系统大多只在预定义结构内做动态路由，能根据跨运行证据持久重写组织结构的系统仍很少。[来源](https://arxiv.org/html/2608.21156)

## 四、Dynamic Workflow

### 4.1 它没有一个统一定义

“Dynamic Workflow”当前更像产品能力名称，而不是类似 SQL、BPMN 的统一规范。至少两个一手产品定义就明显不同。

#### Claude Code：按当前任务生成定制编排

Anthropic 于 2026-05-28 发布 Dynamic Workflows。Claude 根据用户当前任务动态编写 JavaScript orchestration script，由独立 runtime 在后台运行，协调数十到数百个 sub-agent；进度可以保存和恢复。[发布说明](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) [当前文档](https://code.claude.com/docs/en/workflows)

Anthropic 后续把它描述为“为每个任务现场生成一个 custom multi-agent harness”，并明确对比：静态 workflow 必须为各种场景预先写得较通用，而 dynamic workflow 针对当前 use case 生成。常见结构包括 classify-and-act、fan-out-and-synthesize、adversarial verification、tournament 和 loop-until-done。[技术说明](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)

这里的 dynamic 主要包括：

- **生成时机动态**：由模型在任务到来后现场生成脚本；
- **任务结构动态**：根据输入决定子任务和 Agent 数量；
- **执行路径动态**：脚本可以包含条件、数组处理、并行和循环；
- **但控制仍代码化**：脚本一旦生成，runtime 而非主会话逐轮决定下一步，中间结果保存在脚本变量中。

#### Mastra：运行中服务器可注册和更新 JSON 工作流

Mastra 于 2026-08-12 把 Dynamic Workflow 定义为：用户、外部系统或 Agent 可把结构化 JSON graph 增加到正在运行的服务器，也可更新或删除，不需要修改和重新部署服务代码；JSON 通过 ID 引用预先注册的 Agent、Tool 和控制流 primitive。[来源](https://mastra.ai/blog/introducing-dynamic-workflows)

这里的 dynamic 主要是**控制面和部署生命周期动态**。某个已注册 JSON 工作流在一次运行中的拓扑仍可能是固定的。

### 4.2 必须拆开的四种“动态”

判断一个项目是不是 Dynamic Workflow，不能只看“可动态创建”这个词，至少要分别核实：

| 动态轴 | 问题 | 典型例子 |
| --- | --- | --- |
| Definition-time | 工作流是否按当前任务现场生成？ | Claude 生成 task-specific JS |
| Control-plane | 能否在服务运行中增删改定义而无需部署？ | Mastra JSON workflow CRUD |
| Run-time | 一次运行里能否根据数据改变分支、fan-out 数量、子任务或拓扑？ | 输入决定 N 个 worker；反馈触发 replan |
| Cross-run evolution | 执行证据能否持久改变以后使用的组织结构，并验证、版本化、回滚？ | Graph Engineering 论文所说 System Evolution |

同一个产品可能只实现其中一两项。运行时条件分支不等于永久改图；热更新定义不等于 Agent 会自主生成；一次任务生成脚本也不等于跨运行自我演化。

## 五、三者的关键差异

| 维度 | Loop Engineering | Graph Engineering | Dynamic Workflow |
| --- | --- | --- | --- |
| 类型 | 工程实践/设计视角 | 新兴、尚未统一的系统工程实践 | 产品能力或工作流架构模式 |
| 核心问题 | 如何持续推进、验证、记忆、停止 | 如何组织多任务、多 Agent、资源和状态关系 | 协调结构何时、由谁、按何输入动态产生或变更 |
| 首要对象 | 反馈闭环 | 系统级关系和结构 | 工作流定义、脚本或生命周期 |
| 时间尺度 | 单次内部循环到跨运行触发与改进 | 一次复杂运行到跨运行系统演化 | 定义时、部署时、运行时或跨运行，取决于产品 |
| 控制来源 | Agent/外层控制器结合反馈决定是否继续 | 节点、边、状态和治理规则共同决定 | 生成后的脚本/runtime，或热注册的 JSON 定义 |
| 并行与多 Agent | 可有，但不是定义必要条件 | 通常是核心动机之一 | 常见但不是术语必然条件 |
| 验证 | 决定是否重试/停止的关键闭环 | 可作为任务依赖、独立节点和状态证据 | 取决于生成或注册的 workflow 是否包含 verifier |
| 持久状态 | 用于跨轮、跨运行记忆 | 状态本身是一等图结构，支持来源、故障与恢复 | 取决于具体 runtime；并非名称自带保证 |
| 典型失败 | 无限循环、假验证、成本失控 | 图过度设计、状态不一致、边界/职责含糊 | 不可预测成本、生成脚本错误、动态变更缺少治理 |

## 六、如何理解它们的关系

更准确的关系不是：

```text
Loop Engineering → Graph Engineering → Dynamic Workflow
```

而是：

```text
Loop Engineering：时间上的反馈闭环
Graph Engineering：系统中的关系结构
Dynamic Workflow：这些结构的生成、注册或变化方式
```

一个常见组合是：

```text
用户目标
  → 动态生成 Work Graph / orchestration script
  → Graph runtime 调度多个 Agent 节点
  → 每个 Agent 节点内部通过 loop 使用工具并收敛
  → verifier / state / recovery 形成系统级反馈
  → 可选：证据跨运行更新下一版 graph
```

因此：

- Loop 不是被 Graph 淘汰，而是成为 Graph 的可组合执行单元或 cycle。
- Dynamic Workflow 不是 Graph Engineering 的竞争概念，而是 Graph Engineering 中“任务组织如何形成和变化”的一种实现能力。
- Graph Engine 是执行图的 runtime；Graph Engineering 是如何设计、治理和演化整个任务/团队/状态系统。前者是基础设施，后者是工程实践。

## 七、用于判定当前 pi-graph 项目的检查框架

结合仓库时，应逐项寻找代码和运行证据，而不是根据项目名判断：

1. **Loop 证据**：是否定义目标、验证器、反馈重试、停止条件、预算、跨运行记忆和人工升级？
2. **Work Graph 证据**：任务依赖、顺序、并发、验证关系是否是显式且可检查的对象？
3. **Agent Graph 证据**：角色、能力、分工、通信、同步和权限是否被显式建模，而非全部塞进一个中心 Agent 的 prompt？
4. **State Graph 证据**：是否记录来源、运行事实、失败边界、外部副作用和恢复依赖，而不只是保存 `currentNode`？
5. **Definition-time dynamic**：是否按一次用户目标生成新的 task-specific graph/workflow？
6. **Control-plane dynamic**：是否可在运行中的系统里创建、更新、删除、版本化、注册和撤销工作流？
7. **Run-time dynamic**：是否能按实际输入生成数量未知的任务/Agent，或在执行中重规划，而不只是选择预先声明的边？
8. **Cross-run evolution**：历史执行证据能否持久改进结构，并经过验证、版本和回滚治理？

最终分类建议采用分层表达，而不是三选一：

```text
底层 runtime 是什么？
工程实践主要优化什么？
工作流在哪些动态轴上是 dynamic？
尚未实现的 Graph Engineering 能力是什么？
```

这样才能区分“Graph Engine 产品”“使用图的工作流框架”“Dynamic Workflow 控制面”和“广义 Graph Engineering 实践”。

## 八、来源可信度与边界

- Loop Engineering 和 Graph Engineering 都是 2026 年仍在快速变化的术语，尚无标准组织发布统一规范。
- Addy Osmani 的文章是 Loop Engineering 当前最清晰的第一方成型定义，但不是对早期 Agent loop 的发明声明。
- Peter Steinberger 的两条帖子是传播触发点，不是规范或完整定义。
- LangChain 是 graph runtime 的框架作者，其文章是一手实践总结，但带有自身产品视角。
- 2026-08 的 Graph Engineering 论文是预印本提出的广义理论框架，适合作为本次分析的概念基准，但不能表述为学界已达成共识。
- Dynamic Workflow 必须标明供应商和版本语义；Claude Code 与 Mastra 已经证明同名概念可以指不同动态轴。
