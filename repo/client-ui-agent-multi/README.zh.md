---
description: "多智能体工作流的 Web 侧边栏面板：画布编辑器、运行看板与触发器管理（实验性）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-multi

[English](README.md) | 中文

## 概述

`dsh-experimental-client-ui-agent-multi` 在 Web 客户端渲染 agent-multi 工作流面板：带独立图标的侧边栏入口、工作流列表、拖拽画布编辑器（节点与连线配置热编辑）、带节点级状态/输出/token/时延视图与断点恢复控制的运行看板、智能体库与触发器管理。它经生成的 typert remote 与 `dsh-experimental-agent-multi` 通信。本包为实验性。

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

与宿主服务一同挂载即可获得完整侧边栏体验；本包没有独立用途。

```yaml
# smallest agent-multi setup — host service plus client panel
- name: '@deepseek-ai/dsh-experimental-agent-multi'
- name: '@deepseek-ai/dsh-experimental-client-ui-agent-multi'
```

### 工作流编辑器

画布是 React Flow 表面：从面板拖入节点（input、agent、router、join、loop、output、note），把 handle 连成边，选中任意节点或边即可内联编辑其配置 —— 智能体身份字段（名称、系统提示词、提供商、模型、工具允许/禁止列表、上下文预算、重试策略、超时、人工介入开关）、路由分支、汇聚策略、循环参数，以及每条边的中间层格式（`json`/`md`/`text`）、模板与上下文计入。校验按需运行且先于每次保存；徽章显示带定位的完整问题列表。保存走乐观并发并显式提示冲突。

### 运行看板

启动运行先打开输入窗，随后进入运行视图：带节点状态环的只读画布、含尝试次数/时长/token 汇总/输出预览的看板卡片、问题开放期间的人工介入卡片，以及下方的事件日志。失败的 run 显示失败节点的错误类别与消息及恢复按钮，恢复在同一日志上重启。运行历史按工作流列出过往 run。检查器中的单节点试运行可孤立执行一个智能体节点。

### 智能体库与触发器

面板的库区把已保存的智能体规格插入为新节点；检查器的存入库表单捕获当前节点。触发器面板管理绑定到工作流的 cron/daily/weekly 触发器，支持启停与删除。

### 本地化

全部面板文案经类型化字典走 locale（命名空间 `agent-multi`，中英双语）。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

客户端挂载时注册三个表面：Remote 命名空间 `agentMulti`（生成客户端）、键为 `agent-multi` 的主面板槽位，以及侧边栏行（order 30）。`WorkflowPage` 在列表、编辑器与运行视图间切换；`WorkflowEditor` 持有 React Flow 画布与节点/边检查器；`RunPanel` 在 run 执行期间以 1 秒间隔轮询 `getRun`，其余时间刷新历史。全部状态是本地 React 状态加 remote 调用 —— 除组件状态外没有客户端存储。

客户端 bundle 经仓库的 `clientBundle` 配置构建并带 `hostPhase: true`：host pass 产出 node 桩件，client pass 产出 `lib/client.js`。面板文案位于 `locales.ts` 的键联合类型之后；locale 命名空间经声明合并进 `LocaleNamespaceMap`。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [宿主服务](../agent-multi/README.zh.md) —— 工作流存储、运行引擎、触发器与事件日志。
- [客户端 UI 约定](../../../docs/development.zh.md) —— 槽位、locale 归属与打包。

<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器面板不注册面向模型的输入。

#### KV Cache 影响

无直接影响；工作流引擎的组装提示词与普通会话提交负责后续任何模型可见用途。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述该面板目前做不到的事或需要特别运维注意的事项。它们是本包当前的限制，不是与其他客户端表面的比较。
- **轮询刷新** —— 运行视图每秒轮询而非订阅日志事件。
- **状态环而非实时布局** —— 运行画布只读；节点位置来自已保存定义。
- **无离线编辑** —— 每次变更都是 remote 往返；草稿仅存在于组件状态。
- **实验性原型，无稳定性承诺** —— 包已公开，但孵化期间契约可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。

#### 提升

提升到 product 角色分组需要审查公开契约、限制、测试证据、发布载荷、运行时依赖方与具名稳定 owner，见[实验性子树规则](../AGENTS.md)。

</details>
