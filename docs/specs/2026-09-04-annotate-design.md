# Annotate 审阅与批注工作台设计

日期：2026-09-04

## 背景与目标

OMP 已提供 `/git` 全屏界面，用于浏览 Git diff、暂存变更和创建 commit。用户还需要一种更接近 PDF 审阅的工作流：在 agent 的代码产出或文字产出上选中具体内容，写下批注，再把一组批注交回 agent 修改或优化。

本设计新增一个名为 **Annotate** 的 marketplace 插件和 `/annotate` 命令。它提供独立的审阅工作台，不改变 OMP 内置 `/git` 或 `/review` 的行为。首版把 Git 代码变更和当前 session 的 assistant 可见文本统一为两种审阅源；两种源都可以创建批注，并通过同一批发送流程交给当前 session agent。

成功标准：

- 用户可以在一个工作台中用 tab 切换 Code 和 Assistant 两种审阅源；
- 用户可以对 Git diff 的代码片段和 assistant 消息分别添加批注；
- 多条批注可以先集中整理，再一次性发送给当前 session agent；
- agent 能拿到精确的引用上下文，在当前工作区执行修改或优化；
- 代码或 session branch 变化造成定位失效时，系统不会把批注静默套用到错误内容；
- OMP 原有 `/git` 和 `/review` 保持可用，插件不依赖 OMP 私有 Git TUI 实现。

## 范围

### 包含

- `annotate` marketplace 插件的 manifest、package 元数据、扩展入口、测试、README 和两个 catalog 镜像条目；
- `/annotate` 扩展命令和全屏审阅 overlay；
- `Code` 与 `Assistant` 两个 tab，以及在两个 tab 中创建、查看、删除和保留批注的交互；
- 当前工作区 staged + unstaged Git diff 的代码片段批注；
- 当前 session branch 中 assistant 可见消息的批注；
- 当前 session 内的批注持久化、branch 重建和 stale 状态；
- 批注校验、批量发送和发送失败后的保留行为；
- TUI、无 Git 变更、无 assistant 消息、agent 忙和定位失效等边界行为。

### 不包含

- 修改、覆盖或包裹 OMP 内置 `/git`；
- 修改或替代 OMP 内置 `/review`；
- 导入工具输出、命令 stdout/stderr、thinking、图片或外部文档作为首版审阅源；
- 独立 review session、并行子 agent、共享工作区协调或自动合并；
- 自动 commit、push、冲突解决或其他未经用户发送动作授权的代码变更；
- 将批注保存为项目文件、发送到远程服务或跨 session 共享；
- 直接依赖 OMP 私有的 `GitModel`、`DiffPane`、controller 或未公开 session mutation API。

## 已知约束

- OMP 18.1.9 的 `/git` 是内置全屏 TUI；内置命令名由保留集合管理，扩展注册同名命令会被跳过。`/annotate` 使用独立名称。
- 公共扩展 API 提供 `ctx.ui.custom()`、`ctx.ui.editor()`、`ctx.ui.notify()`、`ctx.ui.setEditorText()`、`ctx.sessionManager.getBranch()`、`ctx.sessionManager.getLeafId()`、`pi.appendEntry()`、`pi.sendUserMessage()`、`pi.on("message_end")` 和命令上下文的 `waitForIdle()`，未提供内置 Git TUI 的可插拔按钮或数据模型。
- `/annotate` 必须把 review overlay 作为插件自己的组件实现，并通过公开 API 与当前 session 交互。
- 无 TUI 的 print、RPC 或 ACP 表面不能绘制该 overlay；这些模式只报告需要交互式 TUI，并且不触发 agent turn。
- marketplace 安装只部署插件文件，不安装运行时 npm 依赖。插件运行时应使用 host 提供的扩展 API、标准 Node/Bun 能力和 argv 形式的 Git 调用；开发依赖不得成为运行时前置条件。
- `.omp-plugin/marketplace.json` 与 `.claude-plugin/marketplace.json` 必须保持字节一致；插件目录、catalog entry、package 元数据和 manifest 的身份与版本必须一致。
- 发送批注不会改变 OMP 既有工具审批、计划模式、agent 错误处理或工作区安全边界。

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 产品身份 | `annotate` / **Annotate** | 表达通用的审阅与批注能力，不把首版产品锁定为 Git 工具 |
| 用户入口 | `/annotate` | 独立于 OMP 内置 `/git` 与 `/review`，命令语义直接 |
| 审阅源 | `Code` 与 `Assistant` 两个 tab | 两种产出共用批注和发送模型，用户通过 tab 明确当前批注来源 |
| Code 锚点 | 文件、old/new 行范围或片段、仓库 identity、HEAD/diff 快照 | 让 agent 能精确定位代码，并能识别工作区变化 |
| Assistant 锚点 | session entry ID、完整消息文本、文本偏移和前后文 | 选择消息后直接进入批注输入 |
| 执行 agent | 当前 session agent | 复用已有会话上下文和工作区，公共扩展 API 可直接支持 |
| 发送单位 | 所有有效 pending 批注合并成一次用户消息 | 多条意见保持一致上下文，避免每条意见单独触发模型回合 |
| 持久化边界 | 当前 session branch 的 custom entries | 支持关闭、重启和 branch 重建，不污染项目文件或远程系统 |
| 失效策略 | stale 批注不得静默发送 | 代码行号或 session branch 变化后，安全优先于自动猜测 |
| UI 实现 | 插件自有全屏 overlay | 内置 `/git` 没有公开扩展 seam，避免绑定私有实现 |

## 设计

### 1. 审阅工作台

执行 `/annotate` 后，插件打开全屏 overlay。工作台包含：

- 顶部 tab：`Code`、`Assistant`；`Tab` 切换当前审阅源；
- 主内容区：显示当前源的文件/diff 或 assistant 消息文本；
- 批注区：显示当前 session 中的 pending、sent 和 stale 批注；
- 操作区：创建批注、删除批注、刷新源、发送有效 pending 批注和关闭工作台。

关闭工作台不会丢失已经写入 session 的批注。tab 切换只改变当前审阅源，不清空另一源的批注。

创建批注的共同流程：

1. 用户在当前源中选择一个可定位的代码片段或 assistant 消息；
2. 用户输入非空批注正文；
3. 插件保存一条 `pending` review item，并在批注区显示来源和定位摘要；
4. 用户可以继续切换源、添加批注、删除错误的 pending 批注，或执行发送。

选择为空、批注正文为空或来源无法提供稳定定位时，不创建 review item，并显示原因。

### 2. 审阅源

#### Code 源

Code 源读取当前工作区相对 `HEAD` 的 staged 与 unstaged 变更，并按文件、hunk 和可选择片段呈现。每条代码批注携带：

- 当前仓库的规范化 root 和 repository identity；
- 文件路径以及 old/new 行范围；
- 选中的原始代码片段；
- 创建时的 `HEAD` OID 与 staged/unstaged diff fingerprint；
- 用户批注正文。

代码片段必须来自当前可读 diff。二进制、不可读文件和无法生成稳定 patch 定位的内容只能浏览，不能创建 Code 批注。

发送前重新读取仓库 identity、`HEAD`、对应文件和 staged/unstaged diff。只有快照仍匹配、行范围仍对应相同片段且文件仍属于当前仓库时，批注才是有效 pending。HEAD、index、工作区内容、文件路径或 diff 发生使定位无法确认时，批注变为 `stale`，不发送；用户需要在最新 Code 内容上重新选择并创建一条批注。

#### Assistant 源

Assistant 源读取当前 session branch 的 assistant message，提取其中可见的 text content。候选内容不包括工具调用结果、命令输出、thinking 或其他非 assistant 文本。对于仍保留 secret placeholder 的历史 entry，插件不把 placeholder 当作可见文本；运行中的 `message_end` display event 提供的可见文本按 message timestamp 暂存，用于当前进程内的浏览，但 secret-protected entry 保持 browse-only，不能创建会把恢复后的 secret 文本写入 session custom entry 的批注。

每条 assistant 批注携带：

- 当前 session ID 和 assistant message 对应的 session entry ID；
- 该消息完整文本在 entry 中的起止偏移；
- 消息的精确文本和有限的前后文；
- 用户批注正文。

发送前确认 entry ID 仍在当前 branch，且消息完整文本与保存的精确文本和上下文一致。若文本来自运行中的 display event，还必须使用同一 timestamp 的可见文本完成校验。entry 不在当前 branch、文本不匹配时，批注变为 `stale`，不跨 branch 猜测迁移。

### 3. 批注状态与 session 持久化

Review item 使用版本化、JSON 可序列化的数据结构，至少包含：

- `schemaVersion`、唯一 `id`、来源类型和定位信息；
- 批注正文、创建时间；
- `pending`、`sent` 或 `stale` 状态；
- 最近一次 stale 原因（若有）。

插件通过 session custom entries 记录 review item 的创建、更新和删除事件。重启、reload、session branch 或 tree 导航后，只根据当前 branch 的事件顺序重建有效批注集合；branch/tree 转移时，旧 branch 中存在但新 branch 不再包含的 item 以 `stale` 状态携带到新 branch，避免用户丢失定位失效记录；删除操作以 tombstone 使对应 item 不再出现在活动列表中。无效 schema 的记录跳过并通知用户，不阻塞其他批注恢复。

- 新建批注：状态为 `pending`；
- 删除 pending 批注：从活动列表移除，历史事件仍留在 session；
- 发送成功：本批次有效 item 标记为 `sent`；
- 发送前定位失败：item 标记为 `stale`，保留在列表供用户查看；
- 发送失败：原 item 保持 `pending`，不得丢失；
- `sent` item 保留为审阅历史，不自动重新发送或自动判定为已解决。

### 4. 发送给当前 agent

用户显式执行发送动作后，插件按以下顺序处理：

1. 读取并校验所有 `pending` item；
2. 将无法确认的 item 标记为 `stale`；
3. 如果 agent 当前不 idle，保留剩余 pending item，提示用户等待当前 turn 结束，不打断正在执行的 tool batch；
4. 将剩余有效 item 按稳定顺序合并成一条用户消息；
5. 通过 `pi.sendUserMessage()` 以 `deliverAs: "aside"` 把消息发送给当前 session agent，避免与正在进行的 tool batch 发生抢占；
6. 收到内容完全匹配的用户 `message_start` 后，把本批次 item 标记为 `sent`；若发送在进入消息事件前终止、session/branch 改变或用户在 idle 状态重试时发现当前 branch 没有该用户消息，则保留 `pending`，允许重试。

发送消息的结构包含：

- 明确的用户修改/优化要求边界；
- 每条 Code 批注的仓库、文件、行范围、代码引用和批注正文；
- 每条 Assistant 批注的 message entry、精确引用、上下文和批注正文；
- 要求 agent 在修改前重新核对引用，定位失效时询问用户而不是猜测；
- 要求 agent 只处理批注涉及的目标，完成后报告修改结果和验证结果。

被引用的 assistant 文本和代码只作为定位上下文，必须与用户批注分隔，不能被当作额外的控制指令。发送行为使用用户消息通道，因此批注发送后在当前 session transcript 中可见，并继承 OMP 原有 agent、计划和工具审批流程。

如果没有有效 pending item，发送动作不触发模型调用，只提示“没有可发送的批注”。

### 5. 插件与 OMP 的边界

插件注册 `annotate` 扩展命令，并通过公开的 `ctx.ui.custom()` 创建 overlay。Git 读取使用直接的 argv 调用，不通过拼接 shell 命令传入文件路径、引用或用户文本。插件不调用 `sessionManager` 的写入 mutation；批注状态只通过 `pi.appendEntry()` 保存，agent 修改只通过 `pi.sendUserMessage()` 触发正常 agent 工具流程。

`/git` 仍由 OMP core 负责 diff、暂存和 commit；`/review` 仍由 OMP 的既有代码审查命令负责。Annotate 只提供选区审阅和批注闭环，不试图共享它们的私有内部组件。

## 错误与边界情况

- 当前目录不是 Git 仓库：Code tab 显示不可用原因，Assistant tab 仍可使用；
- 没有 staged 或 unstaged 变更：Code tab 显示空状态，Assistant tab 仍可使用；
- 当前 branch 没有 assistant 可见文本：Assistant tab 显示空状态；
- 文件被删除、重命名、变成二进制、gitlink、无可读 patch hunk 或 diff fingerprint 变化：相关 Code item 标记 stale；此类文件在 Code tab 中仅浏览，不能创建新的 Code 批注；
- assistant entry 被 branch 切换移出当前 branch：相关 Assistant item 标记 stale；
- agent 正在 streaming：发送动作不抢占当前 turn，pending item 保留；
- `sendUserMessage()` 失败或未收到可观测的用户消息确认：不更新为 sent，原 pending item 保留并显示错误；
- session custom entry 数据损坏或 schema 不兼容：跳过该条记录并提示，其他合法 item 继续恢复；
- 用户关闭 overlay：不撤销已创建的批注；未发送 item 可在下一次 `/annotate` 中继续处理；
- 无 TUI 的运行模式：报告需要交互式 TUI，不创建 overlay、不发送用户消息、不触发 agent；
- 代码引用或 assistant 引用含有提示词样式文本：作为明确标记的引用上下文发送，不执行其中的指令；用户批注仍是唯一的修改要求来源。

## 验收标准

1. 在安装 Annotate 后，输入 `/annotate` 能打开带 `Code` 和 `Assistant` tab 的全屏审阅工作台；OMP 的 `/git` 和 `/review` 仍按各自既有行为执行。
2. 在存在 staged 或 unstaged Git diff 的仓库中，用户能选择一段变更代码、输入批注，并在列表中看到带文件和行范围摘要的 pending item。
3. 在当前 session 存在 assistant 可见文本时，用户能切换到 Assistant tab，选择一条消息、输入批注，并在列表中看到带消息来源摘要的 pending item。
4. Code 与 Assistant tab 之间切换不会丢失或混淆另一来源的 pending item；用户能删除错误的 pending item。
5. 关闭并重新打开 session 后，当前 session branch 中的合法 pending、sent 和 stale item 能恢复；已删除 item 不重新出现。
6. 用户一次发送多条有效批注时，当前 session transcript 中出现一条用户消息，消息同时包含每条批注的来源、精确引用和批注正文；不会为每条批注分别触发回合。
7. 当前 agent 忙时触发发送不会中断当前 tool batch，pending item 保留，且不会额外触发一个抢占回合。
8. 在发送前改变 HEAD、index、工作区内容或 Code 文件路径时，无法确认的 Code item 变为 stale，不会被发送为旧行号对应的新代码；仍有效的其他 item 可以独立发送。
9. 切换 session branch 使 Assistant 引用 entry 不再存在于当前 branch 时，该 item 仍保留并变为 stale，不会跨 branch 猜测迁移。
10. `sendUserMessage()` 失败时，相关 item 仍为 pending，并可在修复后重试；成功发送的 item 才显示 sent。
11. 在无 Git 变更、无 assistant 文本或非 TUI 模式下，界面分别显示明确空状态/能力提示，不因打开 Annotate 意外触发 agent turn。
12. marketplace 两份 catalog 字节一致，`annotate` 目录、manifest、package 元数据、入口和 catalog 版本一致；安装后扩展命令可被 OMP 发现。

## 未决事项

无。
