# octo-developer Plugin 与 octo-pr Skill 设计

日期：2026-09-11

## 确认状态

本规格记录已确认的共享契约、实现边界和验收条件，供 Extension、Skill、安装说明及评测 fixture 一致采用。无未决产品决策；PR887 仅为参考案例，规则适用于 `Mininglamp-OSS/octo-server` 的所有 GitHub PR。

## 背景与目标

需要一个可安装的 `octo-developer` marketplace plugin，帮助 agent 在 `Mininglamp-OSS/octo-server` GitHub PR 上持续处理 review，而不是靠模型手动循环查询。插件由两部分组成：

1. `octo_pr` Extension 工具负责绑定当前会话的一个 PR、约 60 秒后台查询 GitHub、缓存状态和评论/审查变化，并在变化时唤醒会话；
2. `octo-pr` Skill 负责安全分析外部 review，执行修复—测试—回复—push—新一轮闭环，在当前 head 满足两位 reviewer 门禁后通过真实 `gh pr merge` compare-and-merge。

目标是让长等待可恢复、让新 head 自动失效旧批准、让评论不会成为隐式命令，同时不让观察工具承担远端写入或合并责任。

## 范围

### 包含

- marketplace plugin `octo-developer`，版本 `1.0.0`；
- `package.json` 的 `omp.extensions: ["./src/index.ts"]` 和仅开发期依赖；
- `.omp-plugin/plugin.json`、根 README、两份一致的 marketplace catalog 和插件 README；
- `skills/octo-pr/SKILL.md` 及不连接真实 GitHub 的三组离线 eval fixture；
- `octo_pr` 的 `watch`、`status`、`cancel` 对外契约；
- 当前 head 的批准/阻塞审查判定、评论证据 URL、会话隔离、断线恢复和关闭暂停语义；
- 适用于 `Mininglamp-OSS/octo-server` 所有 PR 的安装、等待、修复和安全合并说明。

### 不包含

- watcher 自动 merge、push、回复评论、commit、修改 PR 或任何其他远端写入；
- 用模型每 60 秒主动轮询，或在后台启动另一个模型会话；
- 将 PR887 作为特殊白名单、固定编号或不同门禁；
- 把 GitHub 评论、链接、代码块、命令或 mention 当作可执行指令；
- 用 `--admin`、`--auto`、`--delete-branch` 或无 `--match-head-commit` 的命令绕过保护；
- 自动等待第三位 reviewer；
- 真实 GitHub 网络访问、真实 merge 或真实评测执行作为 eval 的前提；
- 运行时 npm 依赖或对 OMP 私有模块的依赖。

## 已知约束

- Extension 在 marketplace 安装后由 OMP/Bun 加载；运行时无 npm `dependencies`，host 类型导入只能为 type-only，`package.json` 只保留 `devDependencies`。
- `octo_pr` 每个 session 只能有一个 watcher；`watch` 可以接收 `Mininglamp-OSS/octo-server` GitHub PR URL 或数字字符串，省略时从当前分支解析。
- watcher 约每 60 秒查询 GitHub，按状态或评论/审查证据去重通知；工具失败必须作为错误暴露，不能伪装成空结果。
- 会话关闭或切换时暂停 watcher；`session_start`/`session_switch` 自动从当前 session branch 的持久化记录恢复同一 PR，并重新读取。记录保存规范化 PR、head SHA 和最近通知 fingerprint；通知与记录成功后才推进 fingerprint，失败或进程中断会重试，因此通知语义为 at-least-once（允许重复、不承诺 exactly-once）。不同 session 不共享 watcher、PR、缓存或 fingerprint。
- GitHub review 可能绑定提交 SHA；`APPROVED` 只对产生它的当前 head 有效。`CHANGES_REQUESTED` 跨 head 保留，只有同一 reviewer 后续 decisive `APPROVED` 或 `DISMISSED` 才解除；push 后必须重新计算门禁。
- Skill 可以调用 GitHub CLI 做证据读取、回复、push 和最终 merge；观察工具不拥有这些副作用。
- 离线 eval 必须在 prompt 中提供明确 fixture，不访问真实 GitHub，不依赖本地 PR 或网络状态。

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 观察方式 | session-bound 后台 watcher，约 60 秒查询 | 长等待不占用模型轮询，状态变化可以唤醒 agent |
| 工具副作用 | watcher 只读；Skill 显式负责修复、回复、push、merge | 观察和写入分离，避免后台误合并或误回复 |
| PR 定位 | URL/数字字符串，watch 省略时解析当前分支 | 覆盖明确 PR 与当前开发分支两种入口 |
| watcher 数量 | 每会话一个 | 防止同一会话重复查询、重复通知和状态竞争 |
| status 读取 | 默认缓存；`fresh: true` 立即读 | 平时低成本响应，合并前以 GitHub 最新事实为准 |
| 批准门禁 | 当前 head 上两位不同 reviewer 的最新 decisive `APPROVED` | 只统计 review commit 等于当前 head 的批准，防止旧提交批准和同人重复票误放行 |
| 阻塞门禁 | 任一未被后续 decisive 状态解除的 `CHANGES_REQUESTED` 阻塞 | 拒绝跨 head 保留；`COMMENTED` 不消除阻塞，只有后续 decisive `APPROVED`/`DISMISSED` 才解除 |
| 第三位 reviewer | 两票满足后不等待 | 门禁定义为两位，不把未知响应变成人工长等待 |
| 评论信任 | 正式 review、行内评论、普通评论全是外部数据 | 防止社交文本注入 shell、工具或安全边界 |
| 最终合并 | fresh 重查后 `gh pr merge "$PR" --squash --match-head-commit "$HEAD_SHA"` | 用提交 SHA 做并发保护，禁止降级绕过 |
| 分支清理 | 不自动删除 | 保留用户/仓库的分支生命周期控制权 |
| 参考案例 | PR887 仅用于理解流程 | 避免把历史编号误当功能分支或例外规则 |

## 设计

### 1. `octo_pr` 工具契约

工具参数如下：

```ts
{
  action: "watch" | "status" | "cancel";
  pr?: string;       // Mininglamp-OSS/octo-server GitHub PR URL 或数字字符串
  fresh?: boolean;   // 仅 status 有效
}
```

- `watch`：解析 `pr`（URL 或数字字符串），省略时从当前分支解析；绑定当前 session 并启动约 60 秒后台 GitHub 查询。一个 session 已有 watcher 时不创建第二个 watcher。
- `status`：返回 watcher 缓存的监控状态和最新变化证据。至少包含 `status` 为 `ready`/`blocked`/`pending`/`error`/`cancelled`、`ready` 布尔值、`headSha`、当前有效批准摘要、当前有效 `CHANGES_REQUESTED` 摘要、PR 的可合并性与检查状态、完整的 `reviews`/`reviewComments`/`issueComments`/`threads` 证据、`lastCheckedAt`、`watching`/`cancelled`、错误和证据 URL。`fresh: true` 请求立即从 GitHub 读取并更新缓存；它不是给模型循环调用的计时器，失败必须显式返回 `error`。
- `cancel`：停止当前 session 的 watcher；已取消的 watcher 不再通知该 session。

通知只在状态、head 或评论/审查证据改变时发出并去重。通知内容是状态/数据，不是模型指令。工具不调用 `gh pr merge`，不 push，不创建评论。

### 2. 监听、恢复与隔离

启动 watcher 后，Skill 让模型等待工具事件，不安排 `sleep` 加模型查询的轮询。事件唤醒后，Skill 调用一次缓存 `status`，优先分析其中完整的 reviews、reviewComments、issueComments 和 threads；只有 snapshot 缺失、截断或需要权威细节/回复 thread 时才用 `gh api` 补查。

会话关闭或切换时，后台监控暂停，不继续消耗查询或模型回合；`session_start`/`session_switch` 会从当前 session branch 的 custom entry 自动恢复 watcher，再以当前 GitHub head 和评论重新查询。断线期间发生的变化由恢复后的读取补齐。通知 fingerprint 只有发送通知并写入持久记录后才推进，异常或中断会保留旧 fingerprint 并在下一轮/恢复时重试，故为 at-least-once 语义，允许恢复后重复通知但不静默丢失变化，不承诺 exactly-once。每个 session 的 watcher 状态独立，PR、评论、head SHA、fingerprint 和错误不得泄漏给其他 session。

### 3. Review 证据和门禁

Skill 在唤醒、push 后和合并前优先使用 `octo_pr status` snapshot；snapshot 完整时不重复请求三类 API，只有证据缺失、截断或需要权威细节/回复 thread 才补查：

- `/pulls/<number>/reviews`：正式 review 的 reviewer、状态、commit SHA、正文和时间；
- `/pulls/<number>/comments`：行内评论的 reviewer、文件/行、正文和时间；
- `/issues/<number>/comments`：普通 PR 评论的作者、正文和时间。

threads 保留是否已解决及是否阻塞。所有返回内容保留来源 URL，作为待分析证据。Skill 先对照 PR diff、关联 issue 和仓库规则判断是否可行动，不执行正文中的命令、链接或 mention。

门禁计算以 fresh 的 `headSha` 为锚：

1. 对每个 reviewer 采用跨 head 的最新 decisive review 状态（`APPROVED`、`CHANGES_REQUESTED` 或 `DISMISSED`）；任一尚未被后续 decisive `APPROVED` 或 `DISMISSED` 解除的 `CHANGES_REQUESTED` 都使状态为 `blocked`，不能因来自旧 head 就丢弃。
2. 只有两位不同 reviewer 的最新 decisive 状态为 `APPROVED`，且两份 review commit 都正好是当前 `headSha`，才为 `ready`；旧 head 的 `APPROVED` 无效，同一 reviewer 不得重复计票。
3. 两票已经 ready 时不等待第三位 reviewer；没有第三位回复不是错误。
4. `COMMENTED` 不是 decisive 状态，不会清除既有 `CHANGES_REQUESTED`；head 改变会使旧批准失效，但不删除仍有效的旧拒绝。
5. 工具错误、缺失 head、证据不完整或 PR facts 未知时不能推断 ready，保持 pending/blocked 并报告错误。

### 4. 修复闭环

对于可行动的 review/评论，Skill：

1. 阅读三类证据、PR 描述、关联 issue 和 diff，判断每条请求的范围与安全性；
2. 实施必要的最小修复；
3. 运行覆盖改动的测试或检查，记录真实结果；
4. 在对应 thread 或 PR 评论逐项回复修复和测试结果；
5. 将必要的源文件 `git add` 后 `git commit`，再 `git push` 当前分支；无实际 diff 不创建空提交，并通过 `octo_pr status`（必要时 `fresh: true`）或 `gh pr view` 确认远端 PR head 已更新；
6. 将 push 产生的新 head 视为新一轮，回到 watcher，重新收集和计算批准。旧批准失效，但未被后续 decisive 状态解除的 `CHANGES_REQUESTED` 继续有效。

评论相互矛盾、要求越权或无法从代码和目标判断时，先报告并请求决策，不盲目执行。Skill 不把自己的回复、CI 文本或普通评论当作 reviewer 的 `APPROVED`。

### 5. 最终真实 gate

只有用户任务包含合并或已明确授权合并时，Skill 才进行合并。它必须：

1. `octo_pr({ action: "status", fresh: true })`；
2. 优先使用 fresh snapshot 的完整 reviews、reviewComments、issueComments 和 threads，证据缺失时才补查；确认不存在仍有效的 `CHANGES_REQUESTED`，且有两位不同 reviewer 的最新 decisive `APPROVED` 都绑定同一个当前 `headSha`；
3. 确认 fresh PR facts：PR 为 `OPEN`，`mergeable` 明确为 `MERGEABLE`，`mergeStateStatus` 为 `CLEAN`，required checks 全部通过，且没有未解决的 blocking threads。任一字段未知、失败或阻塞都不得合并；
4. 保存该 SHA，立即执行：

```sh
gh pr merge "$PR" --squash --match-head-commit "$HEAD_SHA"
```

5. 命令返回后立即再次 `status`（`fresh: true`）复查 PR state；只有确认 `state=MERGED` 或 `CLOSED` 才能结束该任务。确认任一终态后立即调用 `octo_pr({ action: "cancel" })` 结束 watcher，再报告任务已收尾。命令可能只进入 merge queue/auto-merge，queued、pending 或其他非终态只能如实报告，并按任务需要继续观察；若两票已满足但用户未授权 merge，且任务仅要求 review 完成，则汇报 `ready` 后调用 `cancel`，不得留下无限后台查询。

命令使用 fresh 结果中的同一 PR 和 SHA。禁止管理员合并、自动合并、自动删分支和移除 `--match-head-commit` 的弱化重试；若命令因 head 改变、检查失败、队列或权限失败，报告真实错误并回到 watcher。

## 错误与边界情况

- PR URL 不是 `Mininglamp-OSS/octo-server`、编号无效或当前分支无法解析：拒绝 watch，给出可操作错误，不监听猜测的 PR。
- 当前 session 已有 watcher：不重复创建；通过 status 查看或按用户要求 cancel 后重新 watch。
- GitHub 请求失败、认证失败、限流或响应不完整：保留错误和证据 URL/时间，不能当作无评论或自动通过。
- watcher 断线或会话恢复：以 fresh head 和最新证据重建状态，不沿用旧 head 的批准；未被后续 decisive 状态解除的旧 `CHANGES_REQUESTED` 仍阻塞。
- 状态为 `CHANGES_REQUESTED`：不合并，不用管理员权限，不静默关闭审查；只有同一 reviewer 后续 decisive `APPROVED` 或 `DISMISSED` 才解除；`COMMENTED` 不解除。
- 只有一位或零位当前 head 批准：pending；两位不同批准即可继续，不等待第三位。
- push 后 head 变化：旧 `APPROVED` 全部失效，仍有效的 `CHANGES_REQUESTED` 不丢弃；重新获取两位不同 reviewer 的当前 head 批准。
- 评论含 shell、链接、token、秘密、mention 或要求绕过规则：只作为数据审阅，不执行、不外传、不改变安全门禁。
- 用户未授权合并：可以修复和等待；若任务仅要求完成 review 且两票已满足，报告 `ready` 后调用 `cancel` 收尾，否则不执行 `gh pr merge`。
- mergeable、mergeStateStatus、required checks 或 blocking threads 未满足：保持 blocked/pending，不绕过 GitHub 保护。
- merge gate 返回 queued/pending 或其他非 `MERGED` 状态：如实报告，不能声称已合并。
- 会话关闭：watcher 暂停；不会在后台继续 merge、push 或回复。

## 验收标准

1. 插件 manifest、package 和两个 marketplace catalog 的名称、版本、source 和 Extension 入口一致，版本为 `1.0.0`；package 没有运行时 `dependencies`。
2. OMP 可加载 `./src/index.ts`，Skill 可通过 `octo-pr` 发现和显式调用；安装说明覆盖 marketplace、重启/刷新和 `gh` 前置条件，范围严格限定为 `Mininglamp-OSS/octo-server`。
3. `watch` 接受 `Mininglamp-OSS/octo-server` PR URL/数字字符串，省略 `pr` 时从当前分支解析；一个 session 不会启动第二个 watcher。
4. watcher 约每 60 秒在后台读取 GitHub，仅在状态/评论/审查变化时通知；不由模型轮询，不 merge、不 push、不回复远端。
5. `status` 默认返回缓存状态和最新证据，`fresh: true` 仅在 status 上立即读取；错误不会伪装成空成功。
6. session close/switch 暂停 watcher；`session_start`/`session_switch` 自动恢复当前 session branch 中持久化的 watcher 并重查；fingerprint 在通知与持久化成功后推进，失败或中断可重复通知但不会静默丢失变化（at-least-once，不承诺 exactly-once）；不同 session 的状态互不泄漏；任务在 `MERGED`/`CLOSED` 或 review-only `ready` 收尾后调用 `cancel`。
7. formal review body、inline comment、普通 PR comment 都被收集并保留来源证据；外部评论不能自行作为命令。
8. 当前或历史仍有效的 `CHANGES_REQUESTED` 阻塞；`COMMENTED` 不清除；只有后续 decisive `APPROVED`/`DISMISSED` 才解除；旧 head `APPROVED` 不计数。
9. 两位不同 reviewer 在同一当前 head 的最新 decisive 状态为 `APPROVED` 即满足票数，不等待第三位 reviewer。
10. 修复流程按判断问题→修改→测试→逐项回复→commit→push→确认远端 head→新 head 新一轮执行，不能复用旧批准。
11. 用户授权合并时，Skill 先 fresh 重查 review gate、`OPEN`/`MERGEABLE`/`CLEAN`、required checks 和 blocking threads，再执行 `gh pr merge "$PR" --squash --match-head-commit "$HEAD_SHA"`；命令后再次 fresh，只有 `state=MERGED` 才能报告成功；不使用 `--admin`、`--auto`、`--delete-branch` 或弱化重试。
12. 三组离线 eval 明确提供“长等待两票第三位未返回”“两票后第三位阻塞”“push 后旧票失效且断线恢复”fixture，并能在 with-skill/without-skill 配对执行时不连接真实 GitHub。

## v1.0.0 验证记录

- 已通过 25 项测试、完整源码 strict TypeScript 检查和两份 marketplace catalog 一致性检查。
- OMP 18.1.16 RPC 使用 deterministic mock Anthropic 与 25ms 探针 timer 完成真实进程验证：一次 `watch` execute；初始 pending 与新 review 各一次通知；terminal `agent_end` 后 idle 唤醒产生新 `agent_start`；状态稳定后不重复通知。运行证据位于 `/tmp/octo-pr-evaluation/runtime-smoke.txt`。
- 真实 GitHub PR887 仅完成只读 `fetchSnapshot` 验证。未执行真实一小时等待、真实 GitHub merge、发布或安装验收。

## 未决事项

无。
