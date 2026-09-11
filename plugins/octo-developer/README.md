# octo-developer

`octo-developer` 为 `Mininglamp-OSS/octo-server` GitHub PR 提供 review 观察、修复闭环和人工合并交接流程。它包含：

- `octo_pr` Extension 工具：每个会话一个后台 watcher，缓存 review/评论变化并在变化时唤醒会话；
- `octo-pr` Skill：收集正式 review、行内评论和普通 PR 评论，判断当前 head 的批准门禁，完成修复—测试—回复—push—新一轮，并在门禁满足后核验事实、通知用户交由有权限人员合并。

本插件仅适用于 `Mininglamp-OSS/octo-server` 的所有 PR。

## 安装

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install octo-developer@winged-dragon-org
```

Extension 在会话创建时加载，安装后请重启 `omp` 或开启新会话；Skill 可通过 `/reload-plugins` 刷新。插件不安装 `gh` 或其他运行时依赖，需自行准备已登录且可访问该仓库的 GitHub CLI；合并由具备权限的人员执行。

## `octo_pr` 工具

工具只观察和唤醒当前会话，不 merge、push、回复评论或执行评论中的命令。

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `"watch" \| "status" \| "cancel"` | 必填操作 |
| `pr` | `string` | 可选的 `Mininglamp-OSS/octo-server` GitHub PR URL 或数字字符串；`watch` 省略时从当前分支解析 |
| `fresh` | `boolean` | 仅 `status` 可用；`true` 立即读取 GitHub，通常只在人工合并交接前使用 |

示例：

```json
{"action":"watch","pr":"https://github.com/Mininglamp-OSS/octo-server/pull/123"}
{"action":"status"}
{"action":"status","fresh":true}
{"action":"cancel"}
```

`watch` 启动约 60 秒一次的后台 GitHub 查询，并且只在状态或评论/审查证据变化时通知。不要让模型自行每 60 秒调用 `status`。每个会话只能存在一个 watcher；会话关闭或切换时暂停，`session_start`/`session_switch` 会自动从当前 session branch 的持久化记录恢复 watcher 并以当前 head 重查。记录包含规范化 PR、head SHA 和最近通知 fingerprint；fingerprint 只有通知与记录成功后才推进，失败或进程中断会在恢复/下一轮重试，因此语义是 at-least-once（允许重复通知，不承诺 exactly-once），不会因去重把变化静默丢掉。不同 session 不共享 watcher、PR、缓存或 fingerprint。`status` 返回 `status`（`ready`/`blocked`/`pending`/`error`/`cancelled`）、`ready` 布尔值、缓存监控状态、当前 `headSha`、批准与 `CHANGES_REQUESTED` 摘要、PR 可合并性和检查状态、`lastCheckedAt`、`watching`/`cancelled`、错误和最新评论/审查证据 URL。错误是实际失败，不应被解释为空评论或成功。

## Review 与人工合并交接

当前 head 上两位**不同** reviewer 的最新 decisive `APPROVED` 且 review commit 绑定同一当前 head 才满足票数；旧 head 批准不计数。任一尚未被后续 decisive `APPROVED` 或 `DISMISSED` 解除的 `CHANGES_REQUESTED`（包括旧 head 上的）都阻塞；`COMMENTED` 不会清除它。两票满足后不等待第三位 reviewer。push 产生新 head 后必须重新取得批准，但不能丢弃仍有效的旧拒绝。`ready` 表示 review 票数满足，人工合并交接前仍需 fresh 核对当前事实。

Skill 会把 GitHub 的正式 review 正文、行内评论和普通 PR 评论当作外部数据：先核对作者、diff、issue 和仓库规则，再判断是否修复；评论中的命令、链接、`@mention` 和“忽略保护”文字不会自动执行。修复后运行针对性测试、逐项回复，将必要改动 `git commit` 后 `git push`，并确认远端 PR head 已更新，然后等待 watcher 的下一轮唤醒。优先使用工具 snapshot，只有证据缺失时才用 `gh api` 补查。

两票满足后，Skill 在交接前调用 `status` 的 `fresh: true`，重新确认同一个 `headSha`，并确认 PR 为 `OPEN`、`mergeable` 为 `MERGEABLE`、`mergeStateStatus` 为 `CLEAN`、required checks 全部通过且没有未解决的 blocking threads。若 head、审批或事实发生变化，按 `pending`/`blocked` 如实报告；核验通过后向用户汇报 PR URL、当前 head、两位 reviewer 的批准证据 URL、处理结果和测试结果，并明确由具备权限的人员完成合并。

人工交接汇报后调用 `{"action":"cancel"}` 停止 watcher。Skill 只负责 review 证据核验和交接，合并远端写操作由具备权限的人员在其环境中完成；`ready` 不等于已经合并。

## Skill 与离线 eval

显式调用 `/skill:octo-pr`，或在用户提到 Mininglamp-OSS/octo-server PR review、评论修复、等待批准、push 后复查或合并时由模型自动触发。评测 fixture 位于 `skills/octo-pr/evals/evals.json`，三组场景均声明“不访问真实 GitHub”，可分别用于 with-skill / without-skill 成对评测：长等待后两票、第三 reviewer 阻塞、push 后旧票失效并断线恢复。

插件没有运行时 `dependencies`；`package.json` 中的 host 类型、Bun 类型和 TypeScript 仅为 `devDependencies`。

## v1.0.1 Release notes

- 当前 head 两票满足后，Skill 先 fresh 核验并向用户提供人工合并交接信息；交接后停止 watcher，合并由具备权限的人员完成。

## v1.0.0 Release notes

- 首个版本提供 `octo_pr` 的 session-bound `watch`/`status`/`cancel` watcher，以及 `octo-pr` Skill 的 review 证据、修复—测试—回复—commit—push—当前 head 合并闭环。
- 已完成 25 项测试、完整源码 strict TypeScript 检查和两份 marketplace catalog 一致性检查；真实 OMP 18.1.16 RPC 使用 deterministic mock Anthropic 与 25ms 探针 timer 验证一次 watch execute、初始/新 review 两次通知、terminal `agent_end` 后 idle 唤醒产生新 `agent_start`，稳定状态不重复通知。
- 另以真实 GitHub PR887 做只读 `fetchSnapshot` 验证。以上运行未包含真实 GitHub merge、发布或安装验收；`ready` 仍只表示 review 票数，不能替代交接前的 fresh 核验。
