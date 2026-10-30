# dsh-agent-multi — 多智能体工作流插件设计与实施计划（草案 v1）

- 日期：2026-10-15
- 状态：待评审（三个开放决策已由用户确认，见 §3）
- 目标读者：实现者 / 评审者
- 命名：仓库内目录 `packages/experimental/agent-multi/`，profile bundle 展示名 `dsh-agent-multi`

---

## 1. 一句话目标

在 DSH Web 侧边栏增加一个可视化多智能体工作流插件：拖拽画布编排 agent 节点、每条边选择中间层表示格式，运行时以「全局上下文账本」为记忆（agent 无独立记忆），由 host 侧 durable 图引擎驱动，带错误分类重试、断点/重启、HITL 中断，以及实时运行看板。

## 2. 需求清单

### 2.1 用户原始需求

| # | 需求 |
|---|---|
| R1 | 侧边栏入口：图标、可点击、展开插件面板 |
| R2 | 创建 agent；前端热编辑配置：名字、模型、提供商、prompts、工具/skill 可用目录、读写权限、上下文限制 |
| R3 | 前端拖拽画布控制节点连接关系（参考 dsh-node-flow，从简） |
| R4 | 创建连接时可选中间层表示：`.json` / `.md` / `str` 等 |
| R5 | agent 具备 DSH agent 基础功能与生命周期（会话、工具、权限、中断、可追溯） |
| R6 | 工作流建好后，前端以「创建对话」方式弹出输入窗发起运行 |
| R7 | 运行过程带看板：观察每个 node 的执行情况 |
| R8 | 全局上下文机制作为记忆；每个 agent 无独立记忆，上下文 = 上级节点输出 + 用户输入 |
| R9 | 节点失败（LLM 调用、工具调用）→ 重试机制 |
| R10 | 重试均失败且属代码 bug 类 → 报错返回前端显示；记录断点、保留中间层、提供重启按钮 |
| R11 | 节点可发起 HITL（human-in-the-loop）中断 |

### 2.2 主流框架差距补充（对照 LangGraph / AutoGen / CrewAI / Swarm / Dify / LangSmith）

| # | 补充项 | 级别 |
|---|---|---|
| G1 | 条件路由（router 节点，运行时分支） | P0 |
| G2 | 循环 + 终止守卫（maxIters + 收敛条件） | P0（已确认 v1 做） |
| G3 | 并行 fan-out / fan-in 与 join 策略（all / any / quorum） | P0 |
| G4 | 四类错误分类学 + 取消/超时传播 | P0 |
| G5 | 每节点 token/成本/时延统计 + 流式中间输出 | P0 |
| G6 | 断点三模式重启（原样续跑 / 编辑中间层后续跑 / 放弃） | P0 |
| G7 | 类型化 HITL（结构化问题 + 选项） | P0 |
| G8 | 上下文膨胀控制（边级继承默认只传直接前驱；超限裁剪/摘要） | P0 |
| G9 | 运行历史；版本管理（定义版本化、导入/导出） | P1 |
| G10 | 单节点试跑（mock-LLM dry-run） | P1 |
| G11 | 触发器扩展（schedule/cron 复用 DSH schedule 子系统） | P1 |
| G12 | run 级资源熔断（总 token / 总时长 / 总步数） | P1 |
| G13 | 子工作流节点；跨 run 记忆；动态 handoff；保存的 workflow 注册为模型工具 | P2（后排期） |

## 3. 已确认决策

| # | 决策 | 说明 |
|---|---|---|
| D1 | 参考实现 = 本地 `scratch-plugin/dsh-node-flow` | 画布从简，复用其成熟交互模式（见 §4） |
| D2 | v1 支持受控循环 | loop 节点 + `maxIters` 守卫 + 步数熔断，非 DAG-only |
| D3 | 包位置 = `packages/experimental/` | 按 agent-team 四包先例（experimental 组 opt-in，不进默认 web bundle） |
| D4 | 不用 `ctx.workflowEngine` 跑图 | 其 Known Limitations 明确无 journaling/resume，与 R10 断点重启冲突；自建图调度器，复用其事件词汇与错误纪律 |
| D5 | 节点执行原语 = `ctx.subagent.startActivation()` | spawn in-process、`delivery: 'caller'`；agent 生命周期（durable 子会话、可中断、权限继承、agentOptions 覆盖模型）全部白得 |
| D6 | Run 锚定一个专属会话（run root session） | 类比 agent-team 的 TeamId=根 SessionId；满足 R6「对话式输入」、`userQuestions` 的 live-root 约束、运行历史 |

## 4. 参考实现评估（scratch-plugin/dsh-node-flow）

dsh-node-flow 是一个完整的外置 DSH 插件（React Flow 12 + zustand；Trigger/Schedule/Agent/Code/If/Switch/Loop/While/Output/Note 十种节点；cron 定时；导入导出）。对本项目的价值与处置：

### 4.1 直接复用（模式级，代码按仓库规范重写进 in-repo 包）

| 内容 | 来源文件 | 说明 |
|---|---|---|
| 画布组件骨架 | `src/components/{Canvas,NodePalette,Inspector,Toolbar,Overlay}.tsx` | React Flow + zustand 的成熟分区；我们从简（无全屏代码编辑器等） |
| 工作流 JSON 文档骨架 | `src/model.ts` `WorkflowDocument {version, name, nodes, edges}` | 在其上扩展节点 data 与边 data（R4 中间层格式） |
| 循环节点的 handle 语义 | `src/model.ts` 示例 + `src/index.ts` runLoopOrWhile | `iterate` / `back` / `done` 三 handle 的环回连线 UX，已验证可用 |
| 模型路由解析 | `src/index.ts` `parseAgentOptions()` | `"provider\|modelId"` → agentOptions；改成结构化字段 |
| stopReason → 错误映射 | `src/index.ts` `stopReasonError()` | completed/aborted/error/max-tokens/refusal 分类，并入错误分类学 |
| 超时信号构造 | `src/index.ts` `makeTimeoutSignal()` | 可超时 AbortController + isTimeout 判别 |

### 4.2 必须重做（本项目核心增量）

| dsh-node-flow 现状 | 问题 | 本项目做法 |
|---|---|---|
| 手动运行由**浏览器驱动**图（调 HTTP 路由逐节点执行） | 关标签页运行即死 | 全部执行移到 host 侧引擎；客户端只是视图（D6） |
| 持久化 = `$DSH_HOME/workflow-canvas/*.json`，best-effort，runs 截 50 条 | 无断点、无恢复、无审计 | 定义存 `dsh-storage`；运行过程写 **run 会话事件流**（journal），支撑断点/重启/历史 |
| agent 节点父挂 `agents.roots()[0]`（第一个活根） | 脆弱、多 run 抢同一根 | 每 run 创建专属 root 会话，节点 activation 全部挂其下 |
| sidebar 注入 = MutationObserver 自愈 DOM hack | 非official、无 i18n | 官方 `sidebar.panellist` 列表槽 + 根级 `main` keyed 槽（ui-sidebar README 契约） |
| 失败策略仅 stop/continue | 无重试（R9） | 四类错误分类学 + 重试/断点（§5.5） |
| 自研 cron + 单 timer 调度器 | 重复造轮子 | v1 不做定时；P1 接 DSH `schedule` 子系统（G11） |
| 客户端/宿主两份图求值逻辑（eval+walker） | 漂移风险 | 求值只在 host 引擎一处 |
| 条件求值 = `new Function` eval | 安全/一致性 | v1 用受限表达式求值器（见 §5.4，Phase 2 定稿） |

## 5. 架构设计

### 5.1 包结构（agent-team 四包先例）

```
packages/experimental/agent-multi/                  @deepseek-ai/dsh-experimental-agent-multi
  Host 服务：WorkflowDefinition 存储 + 图运行引擎 + Remote 控制器 + HITL 中继 + Session 事件
packages/experimental/client-ui-agent-multi/        @deepseek-ai/dsh-experimental-client-ui-agent-multi
  Web 客户端：sidebar 面板 + 画布 + agent 检查器 + 运行看板 + 输入窗（dsh.client manifest，./client 导出）
packages/experimental/agent-multi-profile/          @deepseek-ai/dsh-experimental-agent-multi-profile
  bundle：cordis.patch.yml 组装（host + client-ui + 依赖）、icon.svg、locale/
packages/experimental/tool-agent-multi/             （P1，后排期）
  把保存的工作流注册为主 agent 可调用的模型工具
```

依赖方向：client-ui →（slots/import type）→ 无跨包运行时依赖；agent-multi → subagent / user-questions / storage / llm（均为 release 包，方向合法：experimental 依赖 release，反之禁止）。

### 5.2 数据模型（核心类型草图，Phase 1 定稿）

```ts
/** 节点种类：v1 共 7 种（画布从简，D1）。 */
type NodeKind = 'input' | 'agent' | 'router' | 'join' | 'loop' | 'output' | 'note'

type WorkflowDefinition = {
  version: 1
  id: WorkflowId            // branded
  name: string
  revision: number          // 乐观并发 + 变更历史
  nodes: NodeSpec[]
  edges: EdgeSpec[]
}

/** agent 节点 = R2 全部热编辑字段的宿主。 */
type AgentNodeSpec = {
  kind: 'agent'
  id: string
  name: string
  provider?: string                     // 空 = 继承
  model?: string
  systemPrompt: string
  toolFilter?: { allow?: string[]; deny?: string[] }  // S1=A → SubagentStartRequest.toolFilter（in-process provider）
  permissionPreset?: string              // S1=A v1：继承 run root，此字段记录意图但不逐节点下放
  // 注：skillDirs（R2）v1 不支持每节点作用域——SubagentStartRequest 无该字段；靠 run-root profile 暴露 skill + prompt 声明约束，列 v1 限制
  contextBudgetTokens?: number           // R2 上下文限制（组装时裁剪/摘要）
  retry: { maxAttempts: number; backoffMs: number; fallbackModel?: string }
  timeoutMs?: number
  hitlEnabled: boolean                    // R11
}

/** 边 = R4：创建连接时规定中间层表示。 */
type EdgeSpec = {
  id: string
  from: string; fromHandle?: string      // router: case 名；loop: iterate|done
  to: string;   toHandle?: string        // loop: back
  format: 'json' | 'md' | 'text'         // 中间层格式
  template?: string                       // {{user}} {{input}} {{nodes.<id>}}
  inContext: boolean                      // 是否进入下游上下文（默认 true）
}

type LoopNodeSpec = { kind: 'loop'; mode: 'items' | 'count' | 'while';
  itemsExpr?: string; count?: number; condition?: string
  maxIters: number; collect: boolean }    // D2 受控循环

type JoinNodeSpec = { kind: 'join'; strategy: 'all' | 'any' | 'quorum'; quorum?: number }

type RouterNodeSpec = { kind: 'router'; cases: string[] }   // + default
```

- v1 不做 code 节点（用户未要求；dsh-node-flow 已覆盖该场景），排 P2 备选。
- 「创建 agent」（R2）：v1 = 画布上创建 agent 节点 + 检查器全量配置；跨工作流复用的**命名 agent 库**排 P1（G9 版本管理一并做）。

### 5.3 运行引擎（agent-multi 包）

**调度器**：事件驱动 ready-set 图调度。ready = 所有入边满足（join 按 strategy；router 按 case 命中；loop 按 iterate/back/done）。并行 fan-out 由引擎并发执行，受 `maxActiveSubagents`（默认 8）约束，超出排队（不报 ACTIVATION_LIMIT_REACHED）。run 级熔断：总步数 / 总时长 / 总 token（G12，v1 做前两项，token 随 G5 统计到位后加上）。

**节点执行**（agent 节点）：
1. `startActivation({provider:'spawn', delivery:'caller', label:node.name, agentOptions})` —— 每 run 每节点**全新 activation**（严格无记忆，R8 的「无独立记忆」由此保证）。
2. 上下文组装（§5.4）→ prompt。
3. `result` 汇聚 output/structured/stopReason；stopReason 映射进错误分类学。
4. 引擎把 stopReason 异常 / 工具失败交给重试策略。

**重试**（R9）：同一 activation `sendMessage` 注入失败上下文要求修正（spawn 子会话可继续，天然支持「带反馈重试」）；子会话已死则 fresh activation。重试次数内可切 `fallbackModel`。

**Journal（断点的载体，R10）**：run 会话事件流（声明合并进 `SessionEventMap`，前缀 `agent-multi/`）：
`run-start / node-start / node-input / node-delta(流式) / node-end(含 output、tokens、时长、attempts) / node-error(含错误类) / hitl-asked / hitl-answered / run-paused(断点) / run-resumed / run-end / run-cancelled`。
- 断点 = run-paused 事件 + 已完成节点的 node-end payload（中间层天然保留在 journal，R10「保留中间层」）。
- **重启三模式**：`resume`（从 journal 回放已完成节点输出，跳过它们，从断点节点续跑）/ `resume-edited`（允许前端改某个已完成节点的 payload 后，其下游全部重算）/ `discard`。
- 进程重启恢复：journal 持久于会话，引擎启动时扫描未终结 run 并标为 paused，用户可 resume —— 这是 D4 抛弃 workflowEngine 的核心理由。

**取消**：run 级 AbortSignal 传播到各 activation `interrupt()` + `dispose()`；超时由节点 `timeoutMs`（复用 makeTimeoutSignal 模式）。

### 5.4 记忆与上下文组装（R8 + G8）

> 核心区别：**全局账本是全局的（记忆），但喂给每个 agent 的上下文默认只是「直接前驱 + 用户输入」，不是整图。** 这对应需求里「全局上下文作为记忆」与「根据上级节点 + 用户输入作为上下文」两层——它们不是一回事。默认克制是抑制深层节点上下文指数膨胀（G8）的关键。

#### 记忆层 —— 全局账本（数据源，不是输入）

run 级维护一个 `Map<nodeId, payload>` 账本：每个节点的最新中间层都写入，**整个 run 共享一份**，并随 `agent-multi/*` 事件持久化进 journal。作用：

- 撑起断点/重启（已完成节点输出可回放，见 §5.3）
- 给模板引用提供数据源（下一层）
- 满足「全局上下文机制作为记忆」「agent 无独立记忆」（fresh activation 不自带历史）

账本是**数据源**，不等于每个 agent 的输入。

#### 输入层 —— per-agent prompt（默认只传直接前驱）

每个 agent 实际收到的 prompt 默认**只包含**：

- 用户输入（`{{user}}`）
- **直接前驱节点**的输出，按各入边 format 渲染

不递归携带祖先链。`A→B→C→D` 链里，D 只看到「用户输入 + C 的输出」，看不到 A、B 的历史。

- **边 format 转换**：`json`（对象↔JSON 文本，跨边保结构）、`md`（套 markdown 包装）、`text`（原样/模板渲染）。
- **显式 opt-in 取更多**：节点 `template` 写 `{{nodes.<id>}}` 可从账本拉任意指定节点的输出进当前上下文。默认克制、按需索取，而非无差别全量灌入。
- **contextBudgetTokens 裁剪**：超预算时按「用户输入 > 直接前驱 > 模板引用」优先级截断，模板引用最先被裁；必要时对超长 payload 请求引擎侧摘要（v1 截断 + 明确标记，P1 接 compaction 做摘要）。

### 5.5 错误分类学（G4）

| 类 | 判据（stopReason/异常映射） | 策略 |
|---|---|---|
| transient | 网络 / 429 / 5xx / provider 抖动 | 重试 + 退避 + 可选 fallbackModel |
| timeout | 节点超时信号 | 重试（计入 maxAttempts） |
| deterministic | schema/参数/代码 bug、refusal | **不重试，直接断点**（R10） |
| auth/permission | 鉴权失败、权限拒绝 | 不重试，断点 + 明确提示 |

重试耗尽 → 断点：`node-error`（错误类 + 报错原文）→ 前端显示；`run-paused` + 中间层在 journal；前端提供重启按钮（三模式）。

### 5.6 HITL 中继（R11 + G7）

- 硬约束：`userQuestions.ask()` 要求 `agent` 为**活跃 runtime 根**（DELEGATED_CALLER）；子 activation 不能直接问。中继路径：节点 agent 调用插件注册的模型工具 `agent-multi-ask-user` → 工具实现运行在引擎内 → 引擎以 **run root**（D6）身份 `ctx.userQuestions.ask()`（结构化问题/选项，复用 AskUserQuestionItem）→ 前端卡片作答 → 答案作为工具结果回注节点。
- 工具对非 run 内 caller 报错「仅在 agent-multi 运行中可用」（按 caller 会话归属判别）。
- `hitlEnabled=false` 的节点注册时排除该工具（Phase 0 S1 确认工具下放通道；fallback：解析 activation 的 structured output 中的 HITL 请求标记）。
- 等待 HITL 的节点状态 `waiting-hitl` 进看板与断点语义（run-paused 可被 hitl-answered 唤醒续跑）。

### 5.7 前端（client-ui-agent-multi）

**挂载**（官方接缝，替换 dsh-node-flow 的 DOM hack）：
- `sidebar.panellist` 根作用域列表槽注册图标行 `{id:'agent-multi', order, label}`；同 id 注册根级 `main` keyed 槽面板组件。
- 客户端 `inject = ['sessions','uiWorkspace','slots','locale']`（agent-team client-ui 同款）。
- 读侧：`useSessions(state => state.projectionsBySession[runSessionId]?.values.agentMulti)` —— 新增 `SessionProjectionMap.agentMulti`（run 看板投影：节点状态/流式 delta/tokens/断点/HITL 待答）。写侧：Remote 控制器（§5.8）。
- i18n：typed locale dictionaries（zh/en），全部文案走字典（verify-client-ui-i18n 门）。

**画布（从简，D1）**：React Flow + zustand。单一 `WorkflowNodeView` 卡片（kind 图标 + 名称 + 状态角标），左侧 palette 7 种节点，右侧 Inspector。loop 用 iterate/back/done handle 环回连线。不做 minimap 以外的花活。

**Agent 检查器 = R2 热编辑**：name / provider / model（下拉来自 llm 目录，Remote 提供）/ systemPrompt / 工具作用域（S1=A：`toolFilter` 允许/封禁清单）/ 权限（S1=A v1：只读显示「继承 run root」）/ contextBudgetTokens / retry / timeoutMs / hitlEnabled。保存 → `revision++` 持久化，**对下一次 run 生效**；进行中 run 持启动时定义快照（可复现性，也符合「热」语义：无需重启进程）。

**v1 限制（S1=A）**：R2 的「skill 可用目录」与「逐节点读写权限」v1 不支持——前者 SubagentStartRequest 无字段，后者仅继承 run root；检查器对应字段标灰提示，列入 README Known Limitations。

**运行输入窗（R6）**：面板内「运行」→ 弹出对话式输入窗（模态）→ 首条消息即 run 的 `{{user}}` 输入 → 创建 run 会话并启动。run 会话出现在会话列表，可 `uiWorkspace.openSession` 打开查看 journal。

**看板（R7 + G5）**：
- 画布节点实时状态环：queued / running / retrying / waiting-hitl / succeeded / failed / skipped / breakpoint。
- 运行抽屉：每节点卡片（状态、流式输出、attempts、token/时延）；run 汇总条（总 token、总时长、熔断余量）。
- 失败视图（R10）：错误详情 + 分类徽章 + 中间层 payload 检查器 + **重启按钮**（三模式菜单；resume-edited 弹 payload 编辑器）。
- 运行历史列表（G9 v1 部分：列出 + 检视；diff/回放 P1）。

### 5.8 Remote 控制器（UI 写通道，S2=A）

`agent-multi` 包内 `extends TypertRemoteService`（`@deepseek-ai/dsh-typert-protocol`，对照 `api/job-controller`/`settings-controller`），backing 生成的 `ctx.remote.agentMulti`；client `inject:['remote','remote.agentMulti']`。方法：`workflow.{create,update,delete,list}`（带 revision 乐观并发）、`run.{start,stop,restart(resume|resume-edited|discard)}`、`hitl.answer`、`catalog.{models,permissionPresets,toolFilter}`。
**实现首步验证（原 S2 探针）**：experimental 包能否接入 typert protocol 代码生成流程产出 client face；若生成器拒绝 experimental 或需 release 依赖，降级为 profile bundle 内 `webServer` 路由（dsh-node-flow 模式），接口保持 Remote 形状便于日后迁移。

## 6. 阶段计划

> 单人全职估算；Phase 0 结论可能微调 2/5。

| Phase | 内容 | 交付物与验收 | 估时 |
|---|---|---|---|
| **0 验证** | S1/S2/S3 选项已拍板（A/A/A，见附录）；本阶段把原探针折叠为各 Phase 首步的最小验证：① S1 — in-process spawn 传 `toolFilter`+`agentOptions` 断言子 agent 工具/模型被替换；② S2 — scratch 包 `extends TypertRemoteService` 看生成器是否产出 `ctx.remote.<ns>`；③ S3 — 新建会话后 `ctx.agents.get(id)` 是否 live（可作 `userQuestions.ask` 的 agent） | 三份验证结论回填附录「Spike 结论」；不通过的项落其 fallback | 1–2 天 |
| **1 模型与存储** | §5.2 类型定稿 + 图校验（入度/出度合法、join/router/loop handle 完整、环必须过 loop 节点、contextBudget>0 等拒绝路径）+ dsh-storage CRUD + revision 乐观并发 + Remote workflow 方法 | 单测：校验拒绝矩阵、CRUD、并发冲突；HMR 安全（fiber dispose 注册回卷） | 2–3 天 |
| **2 引擎** | 调度器（ready-set / join 策略 / router / loop 守卫）、activation 执行、上下文组装与边 format 转换、错误分类学、重试、journal、断点/重启三模式、取消/超时、`agent-multi/*` 事件 | 单测（调度器、重试矩阵、重启回放）+ REAL 组合测试（Loader boot cordis.yml + mock LLM adapter + 假 subagent provider：成功/失败/重试/断点/重启/取消全路径） | 5 天 |
| **3 HITL** | `agent-multi-ask-user` 工具 + 引擎中继 + hitl 事件/投影 + 等待-唤醒续跑 | 组合测试：HITL 提问→作答→续跑；未启用节点无此工具 | 2 天 |

**进度实记（2026-10-16）**：Phase 0–3 已完成并通过全量测试（7 spec 文件 68/68，`tsc --noEmit` 干净）。实现要点与计划的差异：① 重试为 fresh-activation-per-attempt（每次重试把失败反馈拼进 prompt），未走 sendMessage 续话 —— sendMessage 的第二轮无 result 观察面，v1 避开（计划 §5.3 的 sendMessage 优化推迟到 Phase 6+）；② systemPrompt 直接前置拼进用户 prompt（未走 persona capability）；③ HITL 工具经 pre-assigned `childId`（SubagentActivationSpec.childId）+ `agent/created` 监听对命中子 agent 装载（own-layer 注册天然豁免 restrict），而非 FIFO 假设；④ 运行控制器 start/cancel/resume/get 全走 TypertRemoteService `@Remote`，resume 复用同一 runId + journal 回放跳过已完成节点、重载当前 definition（resume-edited 语义）。HITL 等待-唤醒（tool 挂起、前端作答后续跑）由 userQuestions.ask 的 answerer 侧承担 —— v1 引擎内 ask 是阻塞等待，前端作答面在 Phase 5 看板补齐。

**进度实记（2026-10-17，Phase 4 完成）**：Phase 0–4 全绿（8 spec 文件 70/70；host/client typecheck 干净；lib/index.js + typert.* + lib/client.js 均产出）。关键落地事实：① tsdown `-F` 过滤器对 `clientBundle` 函数形 workspace 配置不可用（成员配置全部被丢弃 → "No valid configuration found"）；client 面产物只能靠全仓 client pass（`npx tsdown --config-loader native --env.DSH_BUILD_FACE client`，勿加 `-F`）产出 `lib/client.js`。② `tsdown.config.ts` 用 `{ hostPhase: true }` —— host pass 产 node 件，client pass 只产 client 件。③ Typert 分析器拒绝 remote 边界上的 `unknown`：`RunEventView.data` 收敛为递归 `AgentMultiJsonValue`。④ `@Remote` 标签必须用 JS 方法名（createWorkflow 而非 create-workflow），生成器对 kebab 名会产出带引号成员。⑤ 客户端 `StoredEntry` 形状：`key`/`id`/`order`/`label` 嵌套在 `options` 下，`locale` 顶层；`resolveSlotLabel` 从 `@deepseek-ai/dsh-client-ui-slots` 导入；`LocaleRuntime` 默认 `en`，测试断言中文前先 `ctx.locale.setLocale('zh')`。⑥ React Flow `Edge.targetHandle` 是 `string | null` —— exactOptionalPropertyTypes 下必须条件展开而非直赋 `undefined`。

**进度实记（2026-10-17，Phase 6 进行中）**：画布状态环 + 单节点试运行（G10）落地。① RunPanel 运行视图新增 RunCanvas：只读 ReactFlow（nodesDraggable/nodesConnectable/elementsSelectable 全 false，仅 Background），节点状态环 = css 类 ringrunning/ringcompleted/ringfailed（琥珀/绿/红边框+光晕），状态由 run.nodes 构建 Map；definition 经 getWorkflow 拉取后渲染；hitlNodeId 条件展开（exactOptionalPropertyTypes：不可 `hitlNodeId={run.hitl?.nodeId}`，须 `{...(run.hitl !== undefined ? { hitlNodeId: run.hitl.nodeId } : {})}`）。② dryRunNode @Remote：临时 runRoot + RunJournal + NodeExecutionDeps（ledger 空、inEdges 空），executeAgentNode 单节点执行；结果从 runRoot.session.snapshotEvents() 最后一条 node-end 取 durationMs/usage；不注册进 runs（运行历史不可见）；finally 仅 controller.abort()（SessionStore 无 dispose 方法）。**关键引擎语义**：executor 重试仅对 transient/timeout 且 attempt < maxAttempts；max-tokens → deterministic 直接终态（attempts=1 不重试）。③ Typert 远端边界约束（新教训）：@Remote 方法参数/返回类型必须从 public 非 root 类型子路径导出 —— contract.ts 定义 DryRunNodeRequest/Result 后，必须同时加入 src/types.ts 与 src/index.ts 的 re-export 链，否则 TypertAnalysisError "must be exported from a public non-root type subpath"。④ 客户端：NodeInspector 仅 agent 节点显示 DryRunSection（textarea 输入 + outline 按钮触发 + 结果视图：completed 显示耗时/token 汇总/pre 输出，failed 显示 message+attempts）；DryRunActions 接口经 WorkflowEditor 的 actions 透传（actions 即 AgentMultiInjected，含 dryRunNode）；WorkflowPage AgentMultiInjected 增 dryRunNode；mount.ts 接线。⑤ ButtonVariant 只有 'primary'|'ghost'|'outline'|'toolbar'（无 secondary）。locales 增 dryRunTitle/InputPlaceholder/Start/Running/Duration/Failed（zh/en）。⑥ tsdown host pass 在类型导出补齐后须重跑（typert.remote-client 重新生成含 dryRunNode）。全套 9 文件 90/90。**Phase 6 残余**：import/export + agent 库（G9）、schedule 触发（G11）、run token 熔断（G12）、client bundle 重构建（后台任务 pwsh-278 进行中）。：Phase 5 的投影/看板主体落地（9 spec 文件 87/87；tsc 干净；host+client bundle 重产出）。要点：① `src/projection.ts` 新增 —— key `'agentMulti'`、stateVersion 1、strict zod 逐事件解析 + `parsePersisted` 语义（失败信息 `'persisted agent-multi ${type} payload is invalid'`）；fold 终态化：第二 run、run-start 前事件、未知 node 事件、完成后再启动、无开放问题作答、并发第二 HITL、版本≠1 均 → `state.failure` 终态（后续事件保留原状态引用）；`streaming` 预览截尾 20 000 字符；view 经 WeakMap 记忆化保证引用稳定。声明合并在 projection.ts（SessionProjectionStateMap）与 types.ts（SessionProjectionMap）两处；controller inject 增加 `sessionProjections` 并 `ctx.effect` 注册（agent-loop-testkit 已默认挂 SessionProjectionRegistry，测试 harness 勿重复挂载）。② `RunId` 是 Branded 类型非函数 —— 测试用 `brandString<RunId>('run-1')`。③ token 计量：`SubagentResult` 无 usage；TokenUsage 挂在子会话 `assistant/message` 事件（inputTokens 仅未命中部分）。executor 里 `observeChildUsage(ctx, childId, activation)` 在 controller ctx 监听 `session/event`（controller 监听器看得见所有会话事件，Scoped 过滤只作用于 agent 作用域监听），按 childId 过滤累加四桶；`node-end` 携带可选 `usage`；投影 NodeView 与 contract `RunNodeView.usage` 同步透出。注意观察者在 `startActivation` resolve 后才挂 —— LLM 结算才发 assistant/message，理论风险可忽略。④ `getRun` 合并投影：`RunView` 扩展为 `{runId, workflowId, status, output?, failure?, pausedReason?, nodes: RunNodeView[], hitl?: RunHitlView, events}`（events 保留用于执行记录控制台）；`RunNodeView`/`RunHitlView` 从 `/types` 导出（该入口指向 lib/types 构建产物，改类型后必须先 `tsc -b packages/experimental/agent-multi` 再 typecheck client）。⑤ RunPanel 升级为看板：每节点卡片（状态色左边框/attempt/durationMs/token 汇总 in+out/错误类/重试次数/流式预览或最终输出），HITL 卡片（开放问题/已回答），失败视图 + 重启按钮保留。HITL 作答走 runRoot 的 `userQuestions.ask` 标准作答面，面板只展示状态。⑥ RunPanel 轮询仍为 1s `getRun`。**Phase 5 步骤 5（运行历史）**：新增 `@Remote('listRuns')`（`ListRunsRequest{workflowId?}` → `ListRunsResult{runs: RunSummary[]}`，RunSummary{runId,workflowId,status,failure?}，newest-first，in-memory registry 仅本进程）；mount.ts actions 接线 `listRuns`；RunPanel 展示 run history 段（点击历史行切到该 run 视图）。⑦ remote 方法增删后必须先 host pass（tsdown `-F` 重建 typert.remote-client 生成器类型），client `ctx.remote.agentMulti.*` 才有新方法名。全套 9 文件 88/88。**Phase 5 残余**：画布状态环（canvas node rings 直接读 run.nodes，当前看板卡片已覆盖观察需求，环可作 Phase 6 打磨项）。
**进度实记（2026-10-17，Phase 6 完成）**：G9/G11/G12 全部落地，全套 10 spec 文件 100/100（agent-multi 8 文件 98 + client-ui 1 文件 2；tsc host+client 干净；lib/index.js 297KB + lib/client.js 731KB 重产出）。要点：① **G12 run token 熔断**：executeRun 增 totalUsage 累计器（node-end.usage 求和，billed input = inputTokens+cacheRead+cacheWrite），超 config.tokenBudget（默认 2_000_000）→ abort 所有 in-flight + run-paused{reason:'breakpoint'}；触发器路径 budget = trigger.tokenBudget ?? config.tokenBudget。② **G11 schedule 触发器**：不用 DSH ScheduleService（其投递模型只向 session 收件箱注入 followup 消息，与我们 promise 驱动的 run 不匹配）—— 自建 TriggerRuntime（ScheduleRuntime 模式：单 timer + requestDrive 循环 + stopping/running 标志 + MAX_TIMER_DELAY_MS 2_147_483_647 本地重声明 + unref）；触发器表存 agent-multi 自有 domain 第三表 `triggers`（single-layout 单元新增表无需版本提升，format.ts:79-83）；cron/daily/weekly 数学全部委托 dsh-schedule 导出（resolveRecurringOccurrence / createCron/Daily/WeeklyScheduleRecord —— 注意 SNAKE_CASE 输入 {expression,time_zone}/{time,time_zone}/{time,time_zone,weekdays}）。@Remote：createTrigger（initialTargetOf 计算严格未来首目标）/setTriggerEnabled（重启用 recompute 严格未来；禁用保 target）/deleteTrigger/listTriggers；fireTrigger → startRun + lastRunId 回写 + commit 重臂。domain triggerRecordSchema 含 required scheduledAt（已提交未接受最早 UTC 目标，每次 fire 重算）。**测试教训**：模拟过期 target 走存储后门 + setTriggerEnabled({enabled:true}) 无效 —— 重启用会重算覆盖；用真实近未来 target（daily time=now+5s）让真 timer 走完整 fire 路径（测试 ~5s）。③ **G9 导入/导出 + agent 库**：exportWorkflow（WorkflowExportDocument{definition,agents?} → Blob 下载）/importWorkflow（JSON 文档 → 新建 workflow，keepId 可选）；agent 库存 domain 第二表 `agents`（AgentLibraryRecord{name,spec:AgentLibrarySpec,hitlEnabled 必填}）；@Remote createLibraryAgent/saveLibraryAgent/listLibraryAgents/deleteLibraryAgent；画布 palette 库区一键插入（libraryNodeFields 把库 spec 复制为画布 node，readonly 数组转 mutable）；NodeInspector "存入库" 表单（librarySpecOf 复制，hitlEnabled: spec.hitlEnabled ?? false —— 库必填而节点可选）。④ **客户端类型教训（本阶段新）**：exactOptionalPropertyTypes 下 readonly→mutable 数组跨界必须 [...arr] 复制；局部变量名 `document` 会遮蔽 DOM 全局（用 window.document.createElement）；AgentLibrarySpec.hitlEnabled 必填 vs AgentNodeSpec.hitlEnabled 可选。⑤ TriggerPanel（RunPanel 内）：workflow 域触发器列表（timing 标签/enabled/scheduledAt/lastRunId 截断显示/启停/删除）+ 创建表单（cron/daily/weekly 三形态字段 + 时区默认 UTC + input 文本域）。计划表 G9-G12 行关闭。**Phase 6 关闭。残余 → Phase 7**：README、coverage 门、doc-sync、profile bundle 发布、快照 + 双 SDK expected outputs。

| **5 运行与看板** | 输入窗（R6）、`agentMulti` 投影、画布状态环、运行抽屉、流式输出、token/时延、失败视图 + 重启三模式 UI（R7/R10）、运行历史 | test:gui + 手动验收 §8 场景 1–7 | 3–4 天 |

| **6 P1 扩展** | 导入/导出 + agent 库（G9）、单节点 dry-run（G10）、schedule 触发（G11，接 DSH schedule）、run token 熔断（G12） | 各自验收场景 | 3–4 天 |
| **7 质量与发布** | README（Model Experience 段 + Known Limitations：无 code 节点、单输入窗、上下文裁剪为截断等）、coverage 门补齐、doc-sync、profile bundle 发布（`dsh plugin add` 可装；experimental opt-in 组装）、snapshot + 双 SDK expected outputs 同步 | 仓库门全绿；验收 §8 全过 | 2 天 |

**进度实记（2026-10-17，Phase 7 完成）**：README 与文档门收尾完成。① 双语 README 对（agent-multi + client-ui-agent-multi 各 4 文件，package-reference 模板：frontmatter description+kind、Summary ≤100 词、Use this package、Understand the implementation、Model Experience、Known Limitations、Dev Note）；packages/experimental/README.md + .zh.md 增两行表（ctx.agentMultiController / —）；docs/config-catalog.md/.zh.md 经 gen-config-catalog.ts 再生（anchor deepseek-aidsh-experimental-agent-multi）。② Model Experience 门（结构性三 H4 What the model sees/Token effect/KV Cache effect）：host README 两个 H3 条目（Assembled node prompts / Human-in-the-loop tool schema；后者链接 tool-catalog 的 ask_user_question H2 anchor，因 HITL 工具是条件性子层注册不属 ambient 目录）；client README 用 'None, as ...' 句式 + SENTENCE_MODEL_EXPERIENCE 审计表（scripts/verify-package-readme-model-experience.ts 增 client-ui-agent-multi {kind:'none'}）。③ 翻译配对：README.i18n.yaml sidecar 用 --write 写齐（3 对一致）；**corpus 级 translation-pairing 门仍红 —— 全部来自用户自己的 scratch-plugin/dsh-node-flow、dsh-quick-invoke、dsh-quick-shell 无中文对（预存问题，非本项目引入，不动用户 scratch 目录，最终报告注明）**。④ test:docs 21 门 20 过 1 失败（即上述 corpus pairing）。⑤ 全仓 typecheck 收敛至 0（修严格模式测试错：spike.spec setup 签名 ReadonlyArray<ScriptTurn|'hang'> + new MockAdapter([...script]）；run-controller settle() outcome 窄化 + runs[0]?.；engine.spec brandString<WorkflowId> + EdgeFixture 接口（exactOptionalPropertyTypes 条件赋 fromHandle/toHandle）；format.spec 去重 'from' + prompt[0]?.；projection.spec 经 widened ProjectionDefinition 引用调用 init(header, SessionLogOffset(0))（literal export 把 init 窄化为零参形）；src/projection.ts 曾试显式类型标注会破坏 register() 重载匹配（wire 可选性），已回滚为 satisfies 原形）。⑥ vitest 9 文件 100/100 复跑通过；README 无运行时代码变更故 bundle 无需重产出。⑦ **遗留缺口（明确记录）**：DEEPSEEK_API_KEY 不可用 → keyless recorded-session 快照与双 SDK expected outputs 无法录制（test:snapshot 无 key 自跳过是仓库许可行为）；snapshot 场景（cordis.yml 组合 + session.jsonl + system-prompt/tool-schemas expected 文件，参考 snapshots/sdk/subagent-activation-limit 结构）与 SDK 投影更新留待有 key 环境补做。coverage 门 per-file 100%（src）未单独跑（vitest 覆盖未配置在包内）；profile bundle 发布（dsh plugin add 可装）未做 —— experimental opt-in 组装属发布流程，见 Known Limitations。

**进度实记（2026-10-17，goal round 补完：agent-multi-profile 组合包）**：goal 复核发现计划 §5.1 的第三包 `agent-multi-profile`（目标原文也点名）此前未建 —— 本轮补齐，至此计划三包（host / client-ui / profile bundle）全部落地。① 结构照抄 agent-team-profile 先例：package.json（name @deepseek-ai/dsh-experimental-agent-multi-profile 0.1.0-alpha.0，icon ./icon.svg，dsh.bundle.patch ./cordis.patch.yml，deps = experimental-agent-multi + experimental-client-ui-agent-multi workspace:*，peer cordis，publishConfig.access public，files 含 cordis.patch.yml/icon/locale/lib）；cordis.patch.yml（insert agent-multi 配 maxActive 8 + ui-agent-multi，无任何 disabled 项 —— 与 agent-team 不同，本插件不替换 base 工具行）；src/index.ts 空 export（运行时内容即 patch 文档）；icon.svg 三节点连线图（自绘，对应多智能体拓扑意象）；locale/en.json+zh.json（meta.title/description，插件页显示名「多智能体工作流」）；tsconfig.json 引用 vendor/cordis + ../agent-multi（bundle 测试只需 host 面 dep，client-ui 是 browser 面 peer）。② tsconfig.base.json 双处新增 alias（client paths 段 index.ts 形 + host paths 段 src 目录形）+ tsconfig.host.json references 增一行。③ tests/profile.spec.ts：manifest 断言（public/dsh.bundle.patch/deps 两包）+ entryListSchema 解析 cordis.patch.yml 断言两 insert 行（agent-multi config maxActive 8；ui-agent-multi）—— 1/1 过。④ 双语 README 对（package-bundle 模板，Model Experience 单 H3 'Workflow node runs' 三 H4，注明组合包只改 composition、模型可见内容归属 agent-multi 包；Known Limitations：仅显式启用/内存态运行注册表/需 base profile/实验性原型）+ packages/experimental/README.md + .zh.md 表增第三行 + README.i18n.yaml sidecar --write 落盘。⑤ 验证：三包 vitest 10 文件 101/101；全仓 typecheck EXIT=0；profile 包 tsc 产 lib（index.js + types）；test:docs 20/21（唯一失败仍是用户 scratch-plugin 预存缺中文对，与本项目无关）；lint（oxlint）agent-multi 系 ~217 条 @stylistic 提示（semi/indent/eol-last 等）—— **全仓 lint 基线本就 3325 错（主要是各类 .d.ts 生成物，如 session-controller types.d.ts 612 条），agent-multi 占比小且同类，属仓库级 lint 债务而非本包新风险；如需可另开 PR 统一修**。⑥ `dsh plugin add` 安装路径即 `dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-multi-profile`（README 已写明用法）。

**合计：约 3.5 周（v1 + P1）。**

## 7. 测试与质量策略

- **单测**：调度器（拓扑/join/router/loop 守卫/熔断）、校验、上下文组装与 format 转换、错误分类、重试矩阵、journal 重启回放。coverage 门 per-file 100%（src）。
- **组合测试（REAL）**：Loader 启动 cordis.yml（host + profile）+ mock LLM adapter + 假 subagent provider；覆盖成功 / 瞬态重试恢复 / 确定性断点 / 三模式重启 / HITL / 取消 / 进程重启恢复。
- **test:gui**：面板挂载、画布连线、检查器编辑、看板状态。
- **快照义务**：`agent-multi/*` 是新模型可见会话事件 → 同 PR 内更新 keyless recorded-session 快照 **和 TS/Python 双 SDK expected outputs**（仓库铁律）。
- **事件规范**：SessionEventMap 声明合并 + `@mode`/`@param` JSDoc；逐事件评估 `ignorable`；错误结构化（dsh-error-handling）。
- **Windows**：开发环境即 Windows；路径用例进组合测试。

## 8. 端到端验收场景

1. 安装 profile bundle → 重启 Web → sidebar 出现 dsh-agent-multi 图标 → 点击展开面板。
2. 画布拖 3 节点 2 边（边选 `json`）→ 保存 → 重新打开面板定义仍在（storage）。
3. 输入窗启动 run → 看板并行 fan-out → router 命中正确分支 → join 汇聚 → output 渲染。
4. 断网制造瞬态 LLM 失败 → 看板 retrying → 退避后自动恢复（attempts 计数正确）。
5. 构造确定性 bug 节点 → 重试被跳过直接断点 → 前端显示错误分类 + 报错原文 + 各节点中间层 → 修改节点配置 → resume → 已完成节点跳过（秒回放）→ run 完成。
6. resume-edited：编辑某已完成节点 payload → 其下游重算，上游不动。
7. HITL：agent 节点提问（带选项）→ 前端卡片作答 → 节点继续 → run 完成。
8. loop：maxIters 超限熔断；运行中关闭浏览器标签 → run 继续（host 侧）→ 重开面板看板恢复状态。
9. 取消：运行中点停止 → 全部节点 interrupt → run-cancelled。
10. 运行历史：历史 run 列表 + 任一节点中间层检视。

## 9. 风险与开放问题

| # | 风险 | 缓解 |
|---|---|---|
| V1 | S1=A：skill 目录（R2）v1 无下放通道、读写权限仅继承 run root | v1 列为 Known Limitations；工具用 `toolFilter` 封禁；skill 靠 run-root profile + prompt 声明；P2 评估扩展 SubagentStartRequest（pre-stable 破坏性，需全消费者更新+双 SDK 快照） |
| V2 | S2=A：typert 代码生成器可能拒接 experimental 包 | 实现首步验证；不通过则降级 webServer 路由（接口保持 Remote 形状，dsh-node-flow 模式） |
| V3 | 每 run 每节点 fresh activation 冷启动开销 | v1 接受（正确性优先）；后续可测 activation 复用池 |
| V4 | 并行受 maxActiveSubagents=8 上限 | 引擎排队 + 可配置并发上限暴露 |
| V5 | 流式 delta 投影量级（长输出） | 投影节流 + 截断标记（全文在 journal） |
| V6 | loop×retry×断点交互粒度 | v1：断点记录迭代索引，恢复从该迭代重跑；整体步数熔断兜底 |
| V7 | 表达式求值安全（router/loop 条件） | v1 受限表达式子集（白名单操作符 + `{{nodes.*}}`/`result` 变量），不 eval 任意代码 |

## 10. 仓库规范合规清单（实现时逐条过）

- ESM；`@deepseek-ai/dsh-experimental-*` 命名；`workspace:*` 依赖；注册一律 `ctx.effect()`。
- 新客户端包 checklist：tsconfig.client.json 聚合引用、bundle/web-app 组装行、package.json 依赖（experimental 走 profile bundle 组装，对照 agent-multi-profile 与 agent-team-profile 实际接线）。
- 插槽纪律：`ctx.slots.register/inject` + children 声明；跨包仅 `import type`。
- i18n typed 字典（zh/en）；`verify-client-ui-i18n` 零硬编码文案。
- 模型可见 ⟺ session log：节点输入、HITL 答案、重试反馈全部有对应事件。
- 文案/README 过 dsh-prose-standard；新包 README 含 Known Limitations。
- PR：`kind/*` + `area/*` 标签；快照与 SDK 同 PR；测试描述行为而非正确性。

---

## 附：Phase 0 Spike 选项清单（查证后，待跑探针定稿）

> 已基于源码查证（types.ts:136-193、child-agent.ts、api/\* controller、agent-team roster.ts）。
> 下列为**实现前可选项**，Spike 实跑后在各选项下填结论与选定项。

### S1 — 每节点 agent 配置如何下放到 child（工具/skill/权限通道）

**查证事实**：`SubagentStartRequest`（`packages/subagent/subagent/src/types.ts:136-193`）字段 = `cwd / label / prompt / agentOptions / outputSchema / maxDepth / toolFilter / persona`，各由 `SubagentCapabilities`（types.ts:123-129）开关；外部 provider（acp/codex/claude-code）`agentOptions:false, toolFilter:false`。**无** skill 目录字段；`permissionPreset` 非请求字段，从 parent 捕获（`child-agent.ts:248`）+ override 通道（`child-agent.ts:275`）。

节点配置字段映射 → 选项机制：

| 选项 | 覆盖字段 | 代价 | 评级 |
|---|---|---|---|
| **A. 纯 SubagentStartRequest 现有字段** | name(label)、provider/model(agentOptions)、prompts(prompt)、tools(toolFilter)、persona、context(maxTokens 引擎截断) | skill 目录无法表达；权限仅继承 run root | ★ 推荐基线 |
| **B. A + permissionPreset override 通道** | + 读写权限两档（auto/danger-full-access） | spike 验证 `child-agent.ts:275` override 是否可从 startActivation 请求触达；非任意细粒度 | ★ 若可达则采 |
| **C. skill 目录用 toolFilter 封禁 skill 工具 + prompt 声明** | skill 目录（间接） | 无强制 enforcement（模型可绕过），仅 v1 务实 | △ v1 可接受 |
| **D. 扩展 SubagentStartRequest 加 skillScope/permissionRoots** | skill 目录 + 细粒度权限 | pre-stable API 破坏性变更，需全消费者更新 + 双 SDK 快照，重 | △ 仅当 A/B 不足 |
| **E. per-node agent-preset** | skill 插件清单 | 粒度粗（preset 影响后续所有 agent 创建），不适合热改 | ✗ 放弃 |

**探针**：跑一个 in-process spawn activation，传 `toolFilter`（禁某工具）+ `agentOptions`（换 provider/model），断言子 agent 工具列表与模型确实被替换；再试 `permissionPreset` override 路径，记录是否报错或静默忽略。

### S2 — 前端↔引擎写通道（remote 注册模式）

**查证事实**：正规 remote = `TypertRemoteService` 子类（`@deepseek-ai/dsh-typert-protocol`），`api/job-controller`、`settings-controller`、`account-controller`、`workspace-controller` 均此模式，backing 生成的 `ctx.remote.<ns>`，client `inject:['remote','remote.<ns>']`。

| 选项 | 机制 | 代价 | 评级 |
|---|---|---|---|
| **A. TypertRemoteService 子类 → ctx.remote.agentMulti** | 正规 remote controller，复用权限/投影/stream 体系 | 需 typert protocol 代码生成流程接入；spike 验证 experimental 包能否进该生成管线 | ★ 推荐 |
| **B. webServer 同源 HTTP 路由** | dsh-node-flow 已验证可行 | 绕过 remote 体系，双份类型，权限自管 | △ fallback |
| **C. 纯 session-events 投影只读** | 前端只读 projections | 无写通道，无法承载"新建/编辑/启动 run" | ✗ 仅读侧 |

**探针**：在 scratch 包写一个 `extends TypertRemoteService` 的空 controller，看 typert 生成器能否产出 `ctx.remote.<ns>` client face；若生成器对 experimental 包报错或需 release 依赖，落 B。

### S3 — run root 会话创建 + userQuestions.ask(agent=runRoot) 兼容性

**查证事实**：`TeamService`（`agent-team/src/index.ts:56`）"backed by the exact live Lead Session log"，**不新建会话**；`roster.membership(agent)`（`roster.ts:94-112`）沿 `parentSession` 链找 caller 顶层会话作隐式 root，journal 直接 `root.session.append`。`userQuestions.ask` 要求 `agent` = 精确 live runtime root，子 agent 报 `DELEGATED_CALLER`。

| 选项 | run root 来源 | HITL | 代价 | 评级 |
|---|---|---|---|---|
| **A. per-run 专用会话**（前端为每次 run 新建会话） | 显式新建会话（R5 "工作流对话" UX 直接映射） | ask(agent=该会话 root) | journal 全在 run 会话，隔离好；需验证 root 是否 live | ★ 推荐 |
| **B. 借用发起会话作 run root**（agent-team 隐式 root 先例） | caller 顶层会话 | ask(agent=发起会话 root，天然 live) | 多 run 共享 journal，会话混入大量 run 事件 | △ fallback |
| **C. run 无会话 + journal 落 storage + HITL 自建通道** | 无 | 自建 widget | 违反 model-visible⟺logged + 丢弃 userQuestions answerer waterfall | ✗ 放弃 |

**探针**：前端/工具创建一个新会话 → `ctx.agents.get(newSessionId)` 是否返回 live agent（可作 `userQuestions.ask` 的 `agent`）；若需 resume/materialize（对照 `roster.ts:375 reconcileProvisioning` 冷恢复模式），确认恢复后 agent 可作 ask 参数。A 成立则采 A，否则采 B。

---

### Spike 结论

用户拍板（m00185）：**S1=A / S2=A / S3=A**。

- **S1 = A**（纯 SubagentStartRequest 现有字段）：name→label、provider/model→agentOptions、prompts→prompt、tools→toolFilter、persona→persona、context→maxTokens+引擎截断。**v1 限制**：skill 目录（R2）无字段不下放、读写权限仅继承 run root——列入 Known Limitations。验证项：in-process spawn 传 toolFilter+agentOptions 断言生效（Phase 1 首步）。
- **S2 = A**（TypertRemoteService 子类 → ctx.remote.agentMulti）：对照 api/job-controller。验证项：experimental 包能否进 typert 代码生成流程（Phase 1 首步）；不通过降级 webServer 路由。
- **S3 = A**（per-run 专用会话）：前端为每次 run 新建会话，R5「工作流对话」UX 直接映射；journal 全在 run 会话；HITL `ask(agent=runRoot)`。验证项：新建会话 root 是否 live（Phase 2 首步）；不 live 则采 reconcileProvisioning 冷恢复模式 materialize，仍不行降级 S3=B（借用发起会话）。

### Spike 实跑结果（Phase 0 已完成，2026-10-16）

脚手架 `packages/experimental/agent-multi/`（package.json + tsconfig.json + tsdown.config.ts + src/index.ts + tests/spike.spec.ts），8 个探针全部通过（`vitest run …/spike.spec.ts` → 8 passed）。

- **S1 ✅** `toolFilter.deny` 把工具从子 agent 模型请求里移除且运行时拒绝执行（child session `tool/result` 含 'unknown tool'）；`agentOptions:{provider,model}` 覆盖子 agent 模型。→ R2 工具作用域通道确认；v1 限制（skill/权限）不变。
- **S2 ✅** `AgentMultiController extends TypertRemoteService`（super namespace `'agentMulti'`），`new AgentMultiController(ctx)` 后 `remoteMethods()` 发现 `@Remote('ping')`；对照 `typert/protocol/tests/protocol.spec.ts` 子类一致。→ HOST 侧确认。**残留验证**：client face（`ctx.remote.agentMulti` 代码生成）仍需 build spike——确认 tsdown generator 接入 experimental 包或降级 webServer 路由（Phase 4 首步）。
- **S3 ✅** `ctx.agentLoop.create(SessionId,…)` 产出的 root ∈ `agents.roots()`（assertLiveRoot 前置通过）；`ask({agent:root})` 经全局 answerer 解析（scoped waterfall 命中全局监听）；owned child（spawn，'hang' 保活）∉ roots → `ask({agent:child})` 抛 `DELEGATED_CALLER`。→ HITL 必须由 run root broker（children 不能自 HITL），设计成立。
  - **关键发现**：child 在 `await run.result` 后已被拆除 → `agents.get(child.id)` 返回非同对象 → `CALLER_NOT_LIVE` 而非 `DELEGATED_CALLER`。验证「子 agent 不能自 HITL」须在 child 仍 live 时 ask（用 `'hang'` 脚本保活，不 await result）。引擎 HITL broker 发生在节点运行中（child live），不受此约束。
