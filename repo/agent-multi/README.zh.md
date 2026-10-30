---
description: "在拖拽画布上编排并运行多智能体工作流：节点级模型配置、重试、断点、人工介入与定时触发（实验性）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-multi

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-multi` 运行在拖拽画布上编排的多智能体工作流：输入流经各智能体节点 —— 每个都是拥有独立模型、提供商、提示词与工具过滤的真实 subagent —— 由路由、汇聚与循环节点塑形。run 把 `agent-multi/*` 事件写入会话日志，并投影为带 token 与时延核算的节点级看板。节点失败在断点处暂停供恢复；可选的人工介入问题经 run root 转发。实验性；Web 面板为 `dsh-experimental-client-ui-agent-multi`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当组合需要结构化的多智能体流水线 —— 评审链、扇出汇总、路由升级 —— 并由 Web 侧边栏编排而非临时委派提示词时，加入本包。客户端包依赖本包，正常安装会同时挂载两者。

### 何时选择

适用于需要可声明、可检视的智能体流水线：持久定义、运行间隙热编辑节点配置、带 token 与时延核算的看板、失败后断点恢复。不适用于同一共享会话中的非结构化协作（那是 `dsh-experimental-agent-team`），也不适用于单个 agent 发起的扇出研究委派（内置 `subagent` 工具）。

### 最小工作配置

<a id="smallest-working-setup"></a>

挂载宿主服务与客户端面板：

```yaml
# smallest agent-multi setup — host service plus client panel
- name: '@deepseek-ai/dsh-experimental-agent-multi'
- name: '@deepseek-ai/dsh-experimental-client-ui-agent-multi'
```

服务在启动时校验配置：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `runRootProvider` | `deepseek` | 休眠 run-root agent 的提供商（它从不发起模型调用） |
| `runRootModel` | `deepseek-chat` | 休眠 run-root agent 的模型 |
| `maxActive` | `8` | 每个 run 内并发激活的节点上限 |
| `tokenBudget` | 未设置 | 每个 run 的默认计费 token 预算；请求与触发器可覆盖 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-multi)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 工作流

工作流是七种节点构成的有向图：`input`、`agent`、`router`、`join`、`loop`、`output` 与 `note`（永不执行）。智能体节点携带完整节点级配置：系统提示词、提供商、模型、工具允许/禁止过滤、上下文预算、重试策略（`maxAttempts`、`backoffMs`、可选 `fallbackModel`）、超时，以及该节点是否可向用户提问。连线携带中间层契约：`format`（`json`/`md`/`text`）渲染上游输出，`template` 用 `{{output}}` 与 `{{nodes.<id>}}` 引用重排内容，`inContext` 决定该边是否进入下游提示词。

定义经乐观并发持久存储：基于过期修订的保存返回 `conflict` 并附当前定义。完整工作流可导出为可移植 JSON 文档，再导入为新定义。

### 运行

run 在专属会话中执行当前存储定义。引擎调度智能体节点，并发不超过 `maxActive`；确定性关键词匹配路由、all/any/quorum 汇聚与计数模式循环塑形流程。每个智能体节点作为全新 subagent 激活运行，其提示词由用户输入、节点系统提示词与直接前驱的渲染输出组装 —— 智能体没有独立记忆，run 的全局账本加输入窗即上下文。

每次状态变化都写入一条 `agent-multi/*` 事件（run/节点生命周期、增量、错误、人工介入、暂停）。`agentMulti` 投影把日志折叠为节点级视图 —— 状态、尝试次数、裁剪后的输出预览、失败分类、时长与 token 用量 —— Web 面板轮询该视图渲染看板。

失败即暂停：临时与超时失败按配置策略重试（每次尝试全新激活、失败反馈拼入提示词、第二次尝试起可切换备用模型）；确定性失败如非法工具调用不消耗重试。重试耗尽后 run 停在断点 —— 失败节点的错误类别与消息显示在面板，恢复按钮在同一日志上重启 run，跳过已完成节点并重新加载当前存储定义，因此修复或节点编辑立即生效。

计费 token 预算（未缓存输入 + 缓存读 + 缓存写 + 输出）超限时中止在途激活并将 run 暂停为断点。

### 人工介入

开启 `hitlEnabled` 的智能体节点获得 `agent-multi-ask-user` 工具。其问题经 run root 的标准问答面转发，以 `hitl-asked`/`hitl-answered` 事件入日志，并在得到回答前阻塞该节点。未开启的节点看不到该工具。

### 触发器

触发器把工作流绑定到 `cron`、`daily` 或 `weekly` 时间规则并携带固定运行输入。服务运行自有定时器：到期触发器启动一个 run、记录 `lastRunId` 并重臂已提交目标。停用保留已提交目标；重新启用重算严格未来目标，因此停用期间的错失触发不会补发。触发器持久化走存储域而非 ScheduleService，只有持久存储才能让触发器跨重启存活。

### 成功与失败的形态

成功返回存储定义、run 标识、投影节点视图或已保存触发器。非法图返回带节点/连线定位的完整拒绝列表；修订冲突返回当前定义；重试耗尽返回失败节点的错误类别、消息与尝试次数供恢复。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

本节解释服务背后的设计决策并指向落地代码；可观察行为已在[使用本包](#use-this-package)完整覆盖。

### 设计哲学

服务建立在一个分离与三个承诺之上：

- **持久定义，日志化运行。** 存储域持有工作流、智能体库与触发器；每个 run 向专属会话写 `agent-multi/*` 事件，全部状态由投影派生。
- **真实 subagent，无私有记忆。** 每个智能体节点是全新激活加组装提示词；上下文是过滤到直接前驱的全局 run 账本。
- **失败是暂停而非丢失。** 确定性中断写入断点并保留会话，恢复时回放日志继续。
- **越界即响亮失败。** 图校验以带定位的错误码拒绝非法结构；token 预算中止并暂停而非静默超支。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 模式、工作流/run/触发器/库远端方法、run 注册表、触发器接线 |
| [`src/domain.ts`](src/domain.ts) | 节点、连线、定义、智能体库与触发器的 zod 模式；`agent_multi` 存储域 |
| [`src/contract.ts`](src/contract.ts) | 线上请求/结果接口、校验错误码与 run 视图类型 |
| [`src/validation.ts`](src/validation.ts) | 纯语义图校验（度数、handle、router/join/loop 规则、Kahn 环检测） |
| [`src/engine/run.ts`](src/engine/run.ts) | run 编排：调度循环、并发上限、token 熔断、日志、回放 |
| [`src/engine/scheduler.ts`](src/engine/scheduler.ts) | 边状态调度、路由解析、汇聚策略、循环控制 |
| [`src/engine/executor.ts`](src/engine/executor.ts) | 节点级 subagent 激活、带反馈重试、错误分类、用量观测 |
| [`src/engine/format.ts`](src/engine/format.ts) | 中间层渲染、连线模板、提示词组装、上下文裁剪 |
| [`src/engine/hitl.ts`](src/engine/hitl.ts) | 子 agent 上的人工介入工具装载 |
| [`src/engine/trigger-runtime.ts`](src/engine/trigger-runtime.ts) | 单定时器触发驱动，提交-重臂语义 |
| [`src/engine/events.ts`](src/engine/events.ts) | 12 个 `agent-multi/*` 会话事件载荷类型 |
| [`src/projection.ts`](src/projection.ts) | 严格日志回放投影，发布 `agentMulti` 客户端视图 |
| [`src/trigger-views.ts`](src/trigger-views.ts) | 把触发器记录桥接到时间规则解析的辅助函数 |

### 运行与日志

`startRun` 经 agent loop 创建休眠 run-root agent，随后在该会话内执行工作流。引擎为每次状态变化追加并刷新一条事件；投影（`agentMulti` 键）把它们折叠为节点级视图。`getRun` 把投影状态与内存注册表合并，看板反映日志真源而非仅存活内存。恢复复用同一 run id：`replayJournal` 依据 `node-end` 事件标记已完成节点，随后按新加载的存储定义继续执行。

### 重试与错误分类

每次尝试都是全新 subagent 激活，前次失败作为提示词反馈拼入 —— 续话投递没有结果观察面，重试激活即观察契约。`classifyStopReason` 把停止原因映射为错误类别：错误为临时（可重试）、超时可重试、`max-tokens` 与 `refusal` 为确定性（不重试）。重试策略可自第二次尝试切换 `fallbackModel`。

### token 核算

subagent 结果不携带用量，因此 executor 观测子会话的 `assistant/message` 事件并将其 `TokenUsage` 折入每次尝试的累计器；`node-end` 携带总和。run 级熔断对计费 token（未缓存输入 + 缓存读 + 缓存写 + 输出）求和，超预算即暂停。

### 触发器

触发器运行时持有单个 `setTimeout`，按最早已提交目标重臂（钳制到定时器上限）。循环数学委托给 `dsh-schedule` 的 `resolveRecurringOccurrence` 家族：用触发器的时间规则构造临时 schedule 记录。刻意不用 ScheduleService：它向会话收件箱投递 followup 消息，而 agent-multi 的 run 由控制器以 promise 驱动。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [客户端 UI 包](../client-ui-agent-multi/README.zh.md) —— 侧边栏面板、画布编辑器与运行看板。
- [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-agent-multi) —— 每个受支持的配置字段。
- [会话事件](../../core/session/README.zh.md) —— 每个 run 写入的日志。

<a id="model-experience"></a>
## 模型体验

### 组装的节点提示词

#### 模型看到什么

每次智能体节点激活收到一条用户角色提示词，由运行输入、节点系统提示词与直接前驱的渲染输出（每条边的 `format`、`template`、`inContext`）组装。重试尝试把前次失败追加为 `## Retry feedback` 一节。

#### Token 影响

按激活与数据而定：提示词长度即组装节总量，仅在设置 `contextBudgetTokens` 时从尾部裁剪前驱节。

#### KV Cache 影响

每次尝试为独立模型请求；每次激活都开启全新子会话，run 内更早的请求不留下可复用前缀。

### 人工介入工具模式

#### 模型看到什么

开启 `hitlEnabled` 的智能体节点获得一个额外工具 `agent-multi-ask-user`，其单一 `question` 字符串参数由子模型填写。模式与 `ask_user_question` 的[question 字段](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ask-user)一致；仅工具名与单字段包装不同。

#### Token 影响

条件性且很小：工具模式仅追加到开启人工介入节点的子工具列表。

#### KV Cache 影响

按节点激活独立请求；开关只改变该激活自身的请求，不影响任何其他前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述工作流引擎目前做不到的事或需要特别运维注意的事项。它们是本包当前的限制，不是与其他协调机制的比较。

- **内存 run 注册表** —— 宿主重启丢失在途 run；run-root 会话恢复已在计划中。
- **确定性路由** —— 关键词匹配，非模型驱动路由。
- **计数模式循环** —— items/while 模式已校验但未执行。
- **完成时增量** —— `node-delta` 在完成时一次性发出，非逐 token 流式。
- **截断式上下文裁剪** —— `contextBudgetTokens` 从尾部丢弃前驱节而非摘要压缩。
- **无节点级 skill 目录或读写权限** —— 节点继承 run root 的；subagent 启动请求没有这些字段。
- **单一输入窗** —— 每次 run 启动一个输入；运行中用户输入仅经 HITL。
- **触发器投递为进程内** —— 触发器需持久存储才能跨重启，停机期间错失的触发永不补发。
- **实验性原型，无稳定性承诺** —— 包已公开，但孵化期间契约可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

#### 提升

提升到 product 角色分组需要审查公开契约、限制、测试证据、发布载荷、运行时依赖方与具名稳定 owner，见[实验性子树规则](../AGENTS.md)。

#### 未来方向

未定方向包括模型驱动路由、subagent 投递的流式增量、从持久会话恢复 run、节点级工作区绑定；均未承诺。

</details>
