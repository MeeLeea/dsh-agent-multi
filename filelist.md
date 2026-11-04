# dsh-agent-multi 目录结构与文件说明

DSH 多智能体工作流插件（独立仓库，不在 deepseek-harness monorepo 内）。通过 npm 依赖 + 独立构建管线产出 `lib/` 预构建产物；profile 以 junction/link 方式直接从本目录加载 `lib/`。测试分两层：`test/*.spec.ts`（vitest，直连 src 源码）与 `test/*.test.js`（契约测试，`npm test` 运行）。

## 根目录文件

| 文件 | 说明 |
| --- | --- |
| `package.json` | 包定义。name `dsh-agent-multi`，`private: true`；exports：`.` → `lib/index.js`（宿主入口）、`./client` → `lib/client.js`、`./typert` → `lib/typert.host.js`、`./remote` → `lib/typert.remote-client.js`、`./types` → `lib/types`、`./locale/*.json`；`files` 仅发布 lib/locale/icon/cordis.patch.yml/README；scripts：`clean`、`typert`、`build`（clean-build → build.mjs → 契约测试）、`test`；`dsh` 清单：`bundle.patch` 指向 cordis.patch.yml，`client.inject` 声明三个客户端宿主包（api-remotes/client-locale/ui-renderer）+ `platform: web`；peerDependencies 即运行时由宿主 dsh 提供的服务包（cordis、dsh-llm、dsh-session、dsh-storage-domain、dsh-typert-protocol、schemastery、react、zod 等） |
| `package-lock.json` | npm 锁定文件（standalone 依赖，全部指向 npm 上 0.2.1-rc.4 的 `@deepseek-ai/*` 包） |
| `cordis.patch.yml` | bundle 装配补丁（`dsh plugin --profile <name> add` 或 `dsh.profile.bundles` 时叠加到所选 profile）：插入插件行 `id: agent-multi` / name `dsh-agent-multi`；`config` 覆盖 `runRootProvider: bingxing`、`runRootModel: GLM-5.3-Flash`、`maxActive: 8`。注释说明这是本机部署默认——profile 的 provider 只有 yunlan/bingxing，代码默认 deepseek/deepseek-chat 在此起不了 run；profile-patch 的 config 行会被 composition 忽略，bundle 行才是有效覆盖点 |
| `icon.svg` | 插件图标（侧边栏/插件管理展示用） |
| `README.md` | 插件说明：功能、安装、配置表（runRootProvider/runRootModel/maxActive/tokenBudget）、构建管线、已知限制 |
| `dump-config.txt` | 调试期导出的宿主配置快照（本地参考文件，已被 .gitignore 忽略） |
| `tsconfig.base.json` | host/client 共享 tsconfig 基底（strict、ESM、装饰器等） |
| `tsconfig.host.json` | 宿主侧编译配置：`src/host/**` + `src/index.ts` → `lib/types/**`（tsc 声明 + JS 镜像） |
| `tsconfig.client.json` | 客户端编译配置：`src/client/**` → `lib/types/client/**` |
| `vitest.config.mjs` | vitest 配置：`test/**/*.spec.ts`、node 环境；内置 `agent-multi-lower-decorators` 预转换插件——oxc 不降 TC39 装饰器，对含 `@Remote` 的源文件用 esbuild（es2022 target）降级后才能被 Node 解析 |
| `.gitignore` | 忽略 `node_modules/`、`.npm-cache/`、`.typert-work/`、`.typert-probe/`、`lib/`、`dump-config.txt`、`*.tsbuildinfo`、coverage、日志、编辑器状态等；`lib/` 为构建产物不跟踪——本机 junction 直接加载磁盘上的产物不受影响，新克隆需先 `npm run build` |

## `src/` — 源码（唯一权威来源）

| 文件 | 说明 |
| --- | --- |
| `src/index.ts` | 包入口：导出宿主侧 `AgentMultiController` 及公共类型 |
| `src/css-modules.d.ts` | CSS Modules 的 `*.module.css` 类型声明 |

### `src/host/` — 宿主侧（Node，Cordis 插件）

| 文件 | 说明 |
| --- | --- |
| `src/host/index.ts` | 核心：`AgentMultiController extends TypertRemoteService`。`static inject` 声明依赖服务（storageDomain/agentLoop/sessions/subagents/userQuestions/sessionProjections/llm——llm 必须显式 inject，否则运行时报错）；`static Config` zod 配置（runRootProvider/runRootModel/maxActive/tokenBudget）；全部 `@Remote(...)` RPC 方法：ping、listModelCatalog（读 ctx.llm 目录供客户端下拉）、工作流 CRUD、智能体库 CRUD、运行控制（startRun/resumeRun/cancelRun/getRun/listRuns/dryRunNode）、触发器 CRUD |
| `src/host/contract.ts` | 全部 RPC 方法的请求/结果接口（纯类型契约）：WorkflowSpec/RunRecord/TriggerRecord、ModelCatalog 等 |
| `src/host/types.ts` | 领域类型：`AgentNodeSpec`（provider/model/systemPrompt/retry/toolFilter/permissionPreset/contextBudgetTokens/timeoutMs/hitlEnabled）、节点/边/图定义 |
| `src/host/domain.ts` | 领域逻辑 + zod schema：workflowRecord/agentLibraryRecord/triggerRecord 三张表的 schema 与 `domainTable(...)` 表定义 |
| `src/host/validation.ts` | 工作流图校验（节点引用、环、输入映射等） |
| `src/host/projection.ts` | SessionProjection 投影：把运行状态发布到 GUI（SessionProjectionMap.agentMulti） |
| `src/host/trigger-views.ts` | 触发器展示视图数据组装 |
| `src/host/engine/run.ts` | 运行记录生命周期（创建/推进/完成/失败） |
| `src/host/engine/scheduler.ts` | 图调度器：按依赖拓扑推进节点，并发上限 maxActive |
| `src/host/engine/executor.ts` | 节点执行器：为 agent 节点创建子会话/子代理（应用 model、permissionPreset），执行并回收 |
| `src/host/engine/hitl.ts` | 人工介入（HITL）节点：userQuestions 交互与恢复 |
| `src/host/engine/events.ts` | 运行事件类型与发射 |
| `src/host/engine/format.ts` | 运行结果/日志格式化 |
| `src/host/engine/trigger-runtime.ts` | 触发器运行时（cron/周期触发 startRun 并重臂） |

### `src/client/` — 客户端（浏览器，React）

| 文件 | 说明 |
| --- | --- |
| `src/client/index.ts` | 客户端入口：`apply(ctx)` → `mount(ctx, agentMultiRemote)` |
| `src/client/mount.ts` | 挂载：`bindActions` 把 `ctx.reflect.get('remote.agentMulti')` 的每个 RPC 包成注入动作；注册 `main` 槽位视图与侧边栏面板（order 30，"多智能体工作流"） |
| `src/client/WorkflowPage.tsx` | 页面路由：列表/编辑/运行三视图；`AgentMultiInjected` 接口（全部远程动作类型，含 listModelCatalog）；数据刷新模式 |
| `src/client/WorkflowEditor.tsx` | React Flow 画布编辑器：7 种节点增删连边、库智能体插入；挂载时 fetch-once `listModelCatalog`（含失败态 catalogFailed），把 catalog 传给 NodeInspector |
| `src/client/NodeInspector.tsx` | 右侧节点属性面板。模型=目录下拉（provider · name，空值=继承会话默认；目录失败回退手填）；权限=下拉（继承宿主默认/只读/可写工作区/完全访问）；另有 DryRunSection、SaveToLibrarySection |
| `src/client/RunPanel.tsx` | 运行监控面板（看板）：节点状态、日志、HITL 交互、恢复/取消 |
| `src/client/AgentMultiIcon.tsx` | 侧边栏面板图标组件 |
| `src/client/locales.ts` | 中英双语字典（typed keys） |
| `src/client/WorkflowPage.module.css` / `WorkflowEditor.module.css` | 两个视图的 CSS Modules 样式 |

## `lib/` — 构建产物（被 git 跟踪，宿主直接加载）

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | 宿主 bundle（tsdown，ESM，入口 `lib/types/index.js`；依赖/peer 全部 external，运行时由宿主 dsh 解析） |
| `lib/client.js`(+`.map`) | 客户端 bundle（tsdown CJS 工厂，注册进 `window.__ModuleLoader__`；仅平台 externals（react/cordis/zod/客户端 UI 包等）外部化，CSS Modules/全局样式/图片内联，带 sourcemap） |
| `lib/typert.host.js`(+`.d.ts`) | typert 宿主清单：zod 结果校验工厂 + 方法描述符（`agentMulti/<method>`，含 jsonSchema、sourceLocation）+ 模型清单 |
| `lib/typert.remote-client.js`(+`.d.ts`、`.d.ts.map`) | typert 远程客户端：同名描述符映射 + 远程命名空间类型（构建时内联进 client.js） |
| `lib/types/**` | tsc 直出的 `.d.ts` + `.js` 镜像（host 在根、client 在 `client/`，共 22 个 .d.ts）；既是 exports 的 types 解析面，也是两个 bundle 的编译入口 |
| `lib/.probe` | 构建/诊断临时产物 |

## `tools/` — 构建与诊断脚本

| 文件 | 说明 |
| --- | --- |
| `tools/build.mjs` | 构建编排，单进程内用 TypeScript/tsdown/lightningcss 的 API 完成：tsc host → typert 生成 → tsc client → tsdown host bundle → tsdown client bundle（沙箱禁子进程 spawn，故不走 CLI）。内含客户端 bundle 纯度 gate（非平台 external 的 `@deepseek-ai` 值导入直接报错）、CSS Modules/全局 CSS/图片内联、tsc sourcemap 链接插件 |
| `tools/clean-build.mjs` | 清理构建输出（lib 产物、tsbuildinfo、staging 等） |
| `tools/generate-typert.mjs` | 从源码生成 typert 工件：搭建一次性 staging 工作区（拷贝 src/host 与 node_modules 内相关包）运行 typert 分析器，把 emit 的 `lib/typert.*` 拷回；产物禁止手改 |
| `tools/apply-standalone-identity.mjs` | 一次性迁移脚本：把 in-repo 包名身份改为 standalone（历史用途） |
| `tools/run-tests.mjs` | 契约测试入口：in-process 逐个 import `test/*.test.js`（沙箱下 `node --test` 每 file spawn 一个子进程会 EPERM） |

## `test/` — 测试

vitest 单测（`*.spec.ts`，直接 import `../src/host/*.ts`；`npm test` = 契约测试 + vitest，`npm run test:spec` 只跑 vitest；`npm run build` 末尾两者都跑）：

| 文件 | 说明 |
| --- | --- |
| `test/scheduler.spec.ts` | 图调度器：线性链推进、拓扑就绪集、router/join/loop 分支语义 |
| `test/engine.spec.ts` | 运行引擎（节点执行/失败恢复 resume 路径） |
| `test/run-controller.spec.ts` | 运行控制（start/resume/cancel 生命周期） |
| `test/workflow-store.spec.ts` | 工作流存储（domain 层 CRUD/CAS；含"已移除字段创建时剥离"行为） |
| `test/validation.spec.ts` | 工作流图校验 |
| `test/format.spec.ts` | 运行结果/日志格式化 |
| `test/projection.spec.ts` | SessionProjection 投影 |
| `test/spike.spec.ts` | 技术验证（agentOptions 覆盖子模型、typert Remote 发现、HITL 经纪前提） |
| `test/mount.client.spec.ts` | 客户端挂载（动作绑定/面板注册；FakeLocale/FakeSlots 自包含替身） |
| `test/profile.spec.ts` | profile 装配（cordis.patch.yml 加载） |

契约测试（`npm test` = `tools/run-tests.mjs`，in-process node:test）：

| 文件 | 说明 |
| --- | --- |
| `test/manifest.test.js` | 清单/产物校验：typert 包名、方法集合、bundle externals ⊆ peerDependencies 等 |
| `test/typert-offline.test.js` | typert 工件离线校验（无需宿主） |

测试基座（`test/helpers/`，spec 共用）：

| 文件 | 说明 |
| --- | --- |
| `helpers/memory-backend.ts` | 全量 KvUnit 语义的内存 `StorageBackend` 替身：版本戳/`version-mismatch`/`closed`/幂等删除，媒体跨后端共享可模拟进程重启 |
| `helpers/mount-storage.ts` | 测试挂载：真实 storage 插件 + 共享内存池 + 控制器注入的全部引擎服务（agentLoop/subagents/userQuestions 等），供双 harness 模拟重启 |
| `helpers/local-activation.ts` | 生产激活生命周期上的本地后端 fixture：JSONL 会话持久化挂到临时目录，测后清理 |
| `helpers/working-directory-fixture.ts` | `workingDirectory` 服务替身（符号路径、按 Session 记忆） |
| `helpers/mock-adapter.ts` | 脚本化 `LlmAdapter`：`textResponse`/`maxTokensResponse` 等流式响应构造器 |

> `test/` 下的 spec 移植自已删除的 `repo/` in-repo 存档（2026-11-03 完成移植后删除，历史见 git）；helpers 中 memory-backend/mock-adapter/local-activation/working-directory-fixture/mount-storage 为 standalone 化时从 monorepo 逐字 vendor 或新增。

## 关于已删除的 `repo/` 目录

本插件最初在 deepseek-harness monorepo 的 `packages/experimental/agent-multi*` 内开发，迁出时曾保留存档（in-repo-changes.patch、复活 README、三个旧包的 package.json/tsconfig/tsdown/README/tests）。独立构建管线落地、测试移植完成后（2026-11-03）已删除；如需并回 monorepo，从 git 历史恢复参考。

## 其他目录

| 目录 | 说明 |
| --- | --- |
| `locale/en.json` / `locale/zh.json` | 插件市场/管理界面用的包级展示文案（与 `src/client/locales.ts` 的运行时 UI 文案不同） |
| `docs/plan.md` | 早期设计/规划文档 |
| `node_modules/` | npm 依赖（React、zod、@xyflow/react、vitest、@deepseek-ai/* 0.2.1-rc.4 等） |
| `.npm-cache/` | 本地 npm 缓存（离线/加速重装） |
| `.typert-probe/` | 开发期 typert 探针工作区残留（现行构建 staging 为 `.typert-work/`），已忽略不跟踪 |
| `.git/` | 独立 git 仓库 |
