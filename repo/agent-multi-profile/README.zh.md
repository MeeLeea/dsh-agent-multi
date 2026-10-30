---
description: "在一个实验性组合包中启用多智能体工作流画布、运行引擎与 Web 看板。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-multi-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-agent-multi-profile` 让 [Agent Multi](../agent-multi/README.zh.md) 的工作流服务与 [Web 画布](../client-ui-agent-multi/README.zh.md)通过一个组合包启用。在侧边栏画布编排多智能体工作流，从输入窗发起运行，并在运行看板上观察每个节点的重试、断点、人工介入暂停与 token 核算。运行日志记录在专属 run-root 会话上，失败修复后可断点续跑。本包随 dsh 安装提供，默认关闭，可在插件页开启或添加到已初始化的 profile。

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

### 安装到 profile

将本包添加到已初始化的 profile，然后打开 Web 并点击侧边栏的 Agent Multi 图标：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-multi-profile
```

profile 必须已经包含 `@deepseek-ai/dsh-base`，运行引擎会使用其中的 Subagent 服务与提供方配置行。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-agent-multi-profile` 移除本包时，bundle 也会从 profile 的有序层列表中移除。

### 获得的功能

本层会添加 Agent Multi domain：持久工作流定义、带错误分类重试与断点续跑的日志化运行引擎、触发器表，以及 Web 客户端消费的 Typert remote 表面。侧边栏面板提供编排 agent、router、join、loop 节点的 React Flow 画布、发起运行的输入窗，以及带每节点状态、尝试次数、耗时、token 用量、HITL 卡片与续跑控制的运行看板。插件页通过组合包的 `package.json.icon` 声明读取其[图标](icon.svg)，组合包禁用时也会显示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。在 `dsh-base` 之后应用时，patch 会以显式并发上限插入工作流服务与 Web UI 行。UI 插件的 Host 入口不执行逻辑；只有 Web 客户端加载器会挂载其浏览器入口，因此 headless 无需启动 Web 服务。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上的有序 patch |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 是运行时内容 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布规则。
- [Agent Multi 服务](../agent-multi/README.zh.md)——工作流 domain、运行引擎与 remote 表面。
- [Agent Multi 浏览器 UI](../client-ui-agent-multi/README.zh.md)——画布编辑器与运行看板。
- [Base bundle](../../bundle/base/README.zh.md)——本 patch 扩展的 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

### 工作流节点运行

#### 模型会看到什么

拼装的提示词与 HITL 工具 schema 由 [`@deepseek-ai/dsh-experimental-agent-multi`](../agent-multi/README.zh.md#model-experience) 所有。本 bundle 只改变 composition：每个节点作为 fresh 一次性 subagent 运行，其提示词由用户输入与直接前驱输出拼装；运行节点看不到其他上下文。

#### Token 影响

本 bundle 会加入 `@deepseek-ai/dsh-experimental-agent-multi` 描述的逐节点 subagent 请求；它自身不增加提示词文本。

#### KV Cache 影响

只要 bundle patch、工作流定义与配置的节点选项不变，本 bundle 的 composition 就保持前缀稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

本 bundle 继承其挂载的两个包的全部限制。

- **仅显式启用**——本包随安装提供但默认关闭；随附 CLI、Web、SDK、ACP 与 Python profile 都不会启用它。
- **内存态运行注册表**——运行历史与待处理断点存于 host 进程；重启进程即清空，尽管 run 会话仍留在日志中。
- **需要 base profile**——本 patch 依赖 `dsh-base` 提供的配置行 id 与 Subagent 提供方；它不是独立 profile。
- **实验性原型，无稳定性承诺。**

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
