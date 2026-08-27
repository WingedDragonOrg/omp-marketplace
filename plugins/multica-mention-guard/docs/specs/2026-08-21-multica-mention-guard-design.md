# OMP Multica Mention Guard 设计

日期：2026-08-21

## 背景与目标

Multica 正常完成一个 OMP issue task 时，会把该 task 的最终 assistant output 收集为 issue comment。OMP `session_stop` hook 一旦返回 continuation，原 final 不再是 task 的最后输出，Multica 也就不能按正常路径收集它。

插件的原设计要求 agent 在 hidden continuation 中带 mention 重述完整 final，再由插件发布修正版。这个设计有两个已验证的问题：

1. 重述会浪费 token、增加延迟，并且不能保证与原 final 完全一致；
2. 插件强制补出的 peer-agent mention 会启动对方的新 task。SWO-1615 中技术负责人与开发专员各自在自然关闭回复后被插件补发一次 reciprocal mention，最终形成跨 task ping-pong。

本设计把“原 final 交付”和“mention 决策提醒”彻底分开：

- 正常 stop 路径不由插件发布 comment，Multica 原生收集 final；
- 只有 hook 确实要中断 stop 时，插件才先原样持久化被中断的 final；
- hidden continuation 只做一次 coordination 决策提醒，不重述 final；
- agent 有具体后续工作时才另发最小 agent mention comment；没有后续动作时不 mention agent，也不再发 comment；只需人知晓时可选择 member mention；
- 同一 `MULTICA_TASK_ID` 的第二次及后续 stop 无条件放行。

## 范围

### 包含

- 独立、用户级 OMP ExtensionAPI 插件。
- 仅在 Multica 启动的 OMP task 中启用。
- 在第一次 `session_stop` 检查当前 task 已持久化 comments、原 final 的 mention 和实时 roster。
- 正常合规路径零 comment POST，直接交还 Multica completion。
- Hook 中断路径先原样发布原 final，再发出一次 coordination reminder。
- Hook 发布前按 issue、task、agent、parent 和完整正文回读，避免重复发布同一 final。
- Agent 自主决定是否另发最小 coordination comment，以及使用 agent mention、member mention或不 mention。
- 同一 task 最多一次 hidden continuation。
- 成功的 squad-leader `no_action` activity 继续豁免提醒和 comment。

### 不包含

- 要求 agent 在 continuation 中重述、改写或补 mention 到原 final。
- 插件自动选择 mention 目标或自动给原 final 添加 mention。
- 插件自动发布 coordination comment。
- 对第二次 stop 再检查、再提醒或再发布原 final。
- 用自然语言分类器判断“确认”“关闭线程”“无后续动作”。
- 跨 task 持久 causal graph 或 reciprocal-mention 拦截。
- 修改 Multica server、daemon 或 comment routing。
- 保证 member mention 一定产生人类通知；Multica 当前只保证它不启动 agent run。
- 突破 OMP extension handler 超时和进程异常边界。

## 已知约束

### OMP

设计基于 OMP 17.4.0：

- `session_stop` 只对主 session 触发，并会 await extension handler。
- Handler 返回 `{ continue: true, additionalContext }` 后，OMP 创建隐藏 continuation turn。
- `event.stop_hook_active` 表示当前 stop 已位于 stop-hook continuation 链。
- 连续 continuation 平台上限是 8；本设计主动限制为每 task 最多 1 次。
- Handler 默认预算为 30 秒；超时或未处理异常会 fail-open。
- `event.last_assistant_message` 提供即将被 stop 的原 final。
- `tool_result` 可观察 `multica squad activity ... no_action`。

### Multica

设计基于 Multica CLI `v0.4.30-110-g1c166c895`：

- Task env 提供 `MULTICA_TASK_ID`、`MULTICA_AGENT_ID`、`MULTICA_WORKSPACE_ID` 和 task-scoped token，但不提供 issue ID。
- Workdir 的 `.multica/daemon_task_context.json` 提供 daemon-owned `issue_id` 与 `agent_id`。
- `multica issue comment list <issue-id> --output json` 返回 `source_task_id`、author、parent 和完整正文。
- `multica issue runs <issue-id> --output json` 可按 task ID 取得 `trigger_comment_id`。
- `multica agent list --output json` 提供 agent ID、archive 和 runtime binding。
- `multica workspace member list --output json` 的 member mention ID 是 `user_id`。
- `[@Name](mention://agent/<uuid>)` 会参与 agent routing；`member` mention 不启动 agent run。
- 正常 completion 在没有 agent comment 时把最终 output 合成为 comment；hook continuation 会改变该最终 output。
- `comment add` 没有幂等键。
- `--content-file` 位于 workdir 外时必须显式传 `--allow-external-file`。
- Multica 每个 task 启动独立 OMP OS process；extension state 不跨 task 共享。

## 术语

| 术语 | 定义 |
| --- | --- |
| 原 final | 第一次 `session_stop` 的 `event.last_assistant_message` 文本，尚未被 hook continuation 替换。 |
| 正常 stop | Plugin 返回 `undefined`，由 Multica 按原生 completion 路径收集 final。 |
| Hook 中断路径 | Mention 需要 agent 决策且原 final 已确认持久化后，plugin 返回一次 continuation。 |
| Coordination comment | Agent 根据 reminder 自主发布的短评论；只描述目标和具体后续动作，不复制原 final。 |
| Reminder issued | 当前 task 已使用过唯一一次 continuation；后续 stop 必须无条件放行。 |
| 合法 agent mention | Canonical agent URI，目标存在、未归档、runtime-bound 且不是当前 agent。 |
| 合法 member mention | Canonical member URI，目标 ID 是当前 workspace member 的 `user_id`。 |

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 无既有 task comment、mention 合规 | 插件零 POST，直接 stop | Multica fallback 可收集 final，插件不得重复。 |
| 已有完全相同 final comment | 插件零 POST | 原 final 已交付。 |
| 已有不同 task comment | 插件原样发布 final | Multica 会因已有 comment 抑制 fallback；完整 final 优先。 |
| Hook 前的原 final | 原样、条件式手动发布 | Hook 会夺走原 final 的 completion 位置，必须先补偿交付。 |
| 原 final 标量 | 按 Multica OMP JSON-mode output 序列化 | Text blocks 原序无分隔拼接，仅应用服务端同等 NUL 清理；不 trim、不改换行。 |
| Reminder 次数 | 每 `MULTICA_TASK_ID` 最多一次 | 防止单 session 内重复 continuation。 |
| Reminder 后第二次 stop | 无条件放行 | Agent 已获得一次决策机会；插件不继续施压。 |
| Agent mention | 仅用于明确、具体的后续工作 | 禁止为确认、致谢或关闭线程 reciprocal mention。 |
| 无后续工作 | 不 mention agent、不另发 comment | 这是合法结果，不需要伪造 handoff。 |
| 人类可见性 | 可选 member mention | 不启动 agent，但也不作为强制替代。 |
| Coordination 发布 | Agent 自主使用 Multica CLI | Plugin 不知道真实业务目标，不能代选或代发。 |
| Publication attempt | `none/in_flight/confirmed/dispatch_unknown` 独立于 reminder | 子进程可能 dispatch 后，任何后续 stop 都不得再次 POST。 |
| 模糊 POST 取舍 | At-most-once，承认无幂等键边界 | Bounded readback；fallback 可用时回到正常 stop。Fallback 已被既有 comment 抑制时无法同时保证零重复与绝不丢失，作为明确残余风险。 |
| Foreign stop hook | 本插件不叠加 continuation | 原-final 保证要求本插件是唯一/首个 custom continuation owner；`stop_hook_active && !reminderIssued` 时 no-op。 |
| `no_action` | 零提醒、零 comment | 服务端已有明确 activity，且会拒绝该 task 随后评论。 |

## 设计

### 1. 激活与任务上下文

插件读取三项 task identity env。三项全空时完全 no-op；部分存在时注册一次 fail-closed context reminder，但第二次 stop仍放行。

三项完整时读取 daemon marker，并要求：

- `managed_by == "multica-daemon-task"`；
- marker agent 与 `MULTICA_AGENT_ID` 相同；
- issue ID 是合法 UUID。

插件状态只属于当前 OMP process 的 `MULTICA_TASK_ID`。

### 2. 一次性 stop gate

每次 handler 入口先检查：

1. 已观察到 `no_action`：立即放行；

2. `reminderIssued == true`：立即放行，不执行 CLI；

3. `publicationAttempt` 是 `in_flight`、`confirmed` 或 `dispatch_unknown`：不得启动新的 POST；仅允许当前 owner 完成回读；

4. `event.stop_hook_active == true && reminderIssued == false`：视为 foreign continuation，插件 no-op，不把它误认为自己的 reminder。

并发 `session_stop` 必须串行化。`publicationAttempt = in_flight` 必须在启动 comment-add child 之前原子写入，保证每个 task 最多一个 publication child 和一个 reminder。

原-final 交付保证的部署前提：本插件是唯一或最先取得当前 stop continuation ownership 的 custom `session_stop` handler。OMP 17.4.0 没有 extension hook priority；若前置 hook 已替换原 final，本插件不会叠加第二个 continuation。
### 3. 第一次 stop 的输入与 final 序列化

插件从 `event.last_assistant_message.content` 取全部 `type=text` blocks，按原顺序直接拼接，blocks 之间不添加分隔符。这个算法与 Multica `piBackend` 消费 OMP JSON `text_delta` 时的连续拼接一致。

用于写入和回读比较的标量只移除 U+0000，以匹配 Multica comment 持久化的 NUL 清理；不得：

- trim 开头缩进或末尾空白；

- 把 CR/CRLF 改写为 LF；

- 添加尾换行；

- 改写 ANSI/control 文本或 Markdown。

插件并发读取：

- 当前 issue comments；

- agents roster；

- members roster；

- 当前 issue runs，以恢复预期 parent。

只把 issue、`source_task_id`、author agent 与当前 context 相符且 type 为普通 comment 的记录视为当前 task comment。

从这些数据派生：

- `exactFinalDelivered`：provenance、parent 和完整标量都与原 final 相同；

- `fallbackAvailable`：当前 task 尚无任何 agent comment；

- `mentionSatisfied`：当前 task comments 或原 final 至少有一个合法 participant mention，且没有非法 canonical participant mention；

- `needsReminder`：mention 未满足、roster 无法验证，或 final 需要 agent 做一次明确收尾决策。
### 4. 分支选择：交付与 reminder 解耦

先决定原 final 如何交付，再决定是否需要 reminder。

#### A. `exactFinalDelivered == true`

- 不发布 final；

- `needsReminder == false`：正常 stop；

- `needsReminder == true`：直接进入唯一一次 reminder。

#### B. `exactFinalDelivered == false && fallbackAvailable == true && needsReminder == false`

- 插件零 POST；

- 正常 stop，由 Multica fallback 收集原 final。

#### C. `exactFinalDelivered == false && fallbackAvailable == false && needsReminder == false`

- 既有不同 comment 会抑制 Multica fallback；

- 插件必须原样发布 final；

- 确认后正常 stop，不启动 reminder。

#### D. `exactFinalDelivered == false && needsReminder == true`

- Hook 即将中断正常 completion；

- 插件必须先原样发布 final；

- 确认后进入唯一一次 reminder。

“当前 task 已有合法 mention comment”只能满足 coordination，不能证明不同正文的原 final 已交付。
### 5. 条件式原 final publication

仅分支 C/D 进入本节。

命令：

```text
multica issue comment add <issue-id> \\
  [--parent <trigger-comment-id>] \\
  --allow-external-file \\
  --content-file <private-temp-file> \\
  --output json
```

要求：

- `publicationAttempt = in_flight` 在 child 启动前写入；

- 写入 §3 定义的原 final 标量，不增删 mention；

- temp file 为当前用户私有，正文不进入 argv、日志或 continuation；

- POST 前回读；成功后再次回读；

- `in_flight/confirmed/dispatch_unknown` 在同一 task 后续入口都永久禁止新的 POST。

Publication 结果：

- 回读确认：状态 `confirmed`，分支 C 正常 stop，分支 D 进入 reminder；

- 明确在 child 启动前失败：状态回到 `none`。Fallback 可用时正常 stop；fallback 已被不同 comment 抑制时进入一次 delivery-recovery reminder，要求 agent用 CLI 原样发布冻结 final，不得重述；

- Child 可能 dispatch 但回读仍未知：状态 `dispatch_unknown`，绝不重 POST。Fallback 可用时回到正常 stop，最终 feed允许同正文 1–2 条但不得为 0；fallback 已被既有 comment 抑制时无法同时保证零重复与绝不丢失，必须在 reminder 中报告 delivery unconfirmed，并把这一点作为外部检查项。
### 6. 唯一一次 coordination reminder

确认原 final 已持久化后，设置 `reminderIssued = true`，返回一次 continuation。文案必须表达：

```text
原始完整 final 已由 hook 原样发布，不要重述、改写或再次发布它。

只有需要把具体后续工作交给某个 agent 时，才另发一条最小
coordination comment。使用 canonical agent mention，并明确写出该
agent 要执行的动作。不得仅为确认、致谢或关闭线程 mention 触发者。

如果只是确认、线程关闭或确实没有后续动作，不要 mention 任何
agent，也不要再发 comment。

只有确实需要让人知晓时，才可另发最小 member mention comment；
member mention 不启动 agent run。

本 hook 在当前 MULTICA_TASK_ID 只提醒一次；下一次 stop 无条件放行。
```

Reminder 不要求模型输出原 final，也不把“无 mention”视为第二次违规。

### 7. Agent 自主 coordination

Agent 收到 reminder 后有三种合法行为：

1. **具体 agent 工作**：显式调用 Multica CLI，发布一条短 coordination comment，包含合法 agent mention和具体动作；
2. **无后续动作**：不调用 comment-add，不 mention agent；
3. **只需人知晓**：可选发布一条短 member mention comment。

Plugin 不拦截、不改写也不替 agent执行这个决定。

### 8. 第二次及后续 stop

只有 `reminderIssued == true` 才代表本插件拥有并已经使用过一次 continuation。此时：

```text
return undefined
```

不得再查 comments/roster/runs，不得再发布 final，不得再验证 coordination，不得再启动 hidden continuation。

`stop_hook_active == true && reminderIssued == false` 属于 foreign hook chain。本插件 no-op并记录兼容性诊断；它不声称保存了前置 hook 已替换的原 final。
### 9. `no_action` 观察

保留现有 tool-result 观察：

- 只有 Bash effective command 中存在命令位的 `multica squad activity ... no_action` 调用，才评估 success marker 或 JSON activity；
- `echo multica ...`、comment/list/log 输出中出现相同文字都不能形成证据；
- 命令候选 + 明确成功输出 → confirmed；
- 命令候选 + 整体成功且无明确结果 → permissive；
- 明确失败优先于宽松成功。

任一 no-action 证据都让 stop 直接放行且不创建 comment。

### 10. 防环边界

本设计结构性消除插件自动 reciprocal mention：

- Plugin 永不选择 agent；
- Plugin 永不把 mention 加到 final；
- Plugin 永不发布 coordination comment；
- 每 task 最多一次 reminder。

但它不能绝对阻止 agent 自己违反 reminder，并在每个新 task 中继续 reciprocal mention。真正的跨 task hard guard 需要 Multica server 记录 causal chain 并拒绝没有新具体动作的往返 mention，属于独立后续设计。

## 错误与边界情况

- 原 final 合法、无既有 task comment：正常 stop，零 plugin POST。

- 原 final 合法、已有完全相同 comment：正常 stop，零 plugin POST。

- 原 final 合法、已有不同 progress/coordination comment：原样发布 final，正常 stop，不 reminder。

- 当前 task 早先 comment 已有合法 mention但正文不同：mention 已满足，但仍须单独保证 final 交付。

- 原 final 无 mention：先保证原样交付，再提醒一次；agent可选择不 mention。

- 原 final mention 无效：原样交付，再提醒 agent自行决定 coordination。

- 原 final 已由 agent 手动发布：完整标量与 parent 回读命中，不重复 POST。

- 第二次 final 与原 final 不同：不检查、不发布；第一次原 final 已持久化或 delivery uncertainty 已明确。

- Agent continuation 只回复“无后续动作”：正常 stop，不产生 plugin coordination comment。

- Agent continuation 自主发布 agent mention：按 Multica 路由启动目标 agent，这是 agent 显式业务决定。

- Roster 查询失败：最多一次保守 reminder，不能进入重复 stop 链。

- Publication child 启动前失败且 fallback 可用：正常 stop，让 Multica收集原 final。

- Publication child 启动前失败且已有不同 comment：一次 recovery reminder，要求用 CLI 发布冻结原文。

- Publication dispatch unknown：不重试；后续 stop 不得再次 POST。Fallback 可用时最终 feed必须至少一条原 final；fallback 被抑制时是无幂等键下的明确残余风险。

- Foreign `stop_hook_active`：不叠加 reminder；原-final保证不覆盖前置 custom hook。

- OMP handler abort/timeout：fail-open；不宣称绝对交付或 exactly-once。
## 验收标准

1. 非 Multica OMP session 不执行 Multica CLI。

2. `no_action` task 不提醒、不发布 comment。

3. 原 final mention 合规、当前 task 无 comment时，handler 返回 `undefined`，plugin POST 为 0。

4. 当前 task 已有与原 final 完全相同 comment时，plugin POST 为 0。

5. 当前 task 已有合法 mention但正文不同的 comment时，final仍原样发布一次；不 reminder。

6. 原 final 无 mention且没有同正文 comment时，plugin先原样发布，再返回一次 continuation。

7. 原 final 已有同正文 comment但无合法 mention时，不重复 POST，但返回一次 reminder。

8. Final 标量按 text blocks 无分隔拼接、仅移除 U+0000；不 trim、不改 CR/LF、不加尾换行。

9. Plugin 发布使用正确 provenance、parent、`--allow-external-file` 和 `--content-file`。

10. Reminder 明确说明原 final 已发布且禁止重述。

11. Reminder 只有具体后续工作才允许 agent mention，并要求具体动作。

12. Reminder 禁止为确认、致谢或线程关闭 mention agent。

13. Reminder 允许无动作时不 mention、不发 comment；member mention仅是可选人类可见性动作。

14. 同一 task 第二次 stop 无条件返回 `undefined`。

15. 同一 task 最多一个 `session-stop-continuation`。

16. `reminderIssued` 后第二次 stop执行 0 次 comments/roster/runs/comment-add CLI。

17. `publicationAttempt` 在 child 启动前设置；并发 stop至多启动一个 child。

18. `dispatch_unknown` 后即使 `stop_hook_active=false` 再次进入，也不得 POST。

19. Pre-dispatch failure且 fallback 可用时返回正常 stop。

20. Foreign `stop_hook_active` 且本插件未 reminder时，plugin零 POST、零 continuation，并报告不覆盖前置 hook保证。

21. 自动化覆盖 SWO-1615：自然关闭 final原样交付 → 一次 reminder → agent选择无动作 → 第二次 stop；无 plugin-generated peer mention、无新 agent wake。

22. 正常 smoke读取最终 issue feed，断言原 final恰好 1 条，正文、parent、task/agent provenance正确。

23. Hook smoke读取最终 feed，断言原 final恰好 1 条、2 个 LLM turns、0 个 plugin peer mention、第二次 stop结束。

24. 已有不同 comment + 合规 final smoke断言最终 feed中既有 comment保留，原 final新增恰好 1 条。

25. Pre-dispatch failure fallback结果必须恰好 1 条原 final；dispatch-unknown + fallback可用允许 1–2 条但不得为 0。

26. 多 text-block、CR、CRLF、尾换行、NUL和控制字符 fixture覆盖正常 completion与手工 publication的标量一致性。
## 验证策略

- 纯逻辑：mention parser、roster、one-shot gate、no-action、final scalar serializer、publication state。

- Guard 集成：正常 stop零 POST；既有不同 comment时补 final；hook分支先发原 final；第二次 stop零 CLI。

- CLI fake：comments/runs/rosters、parent、external-file flag、pre-dispatch failure、dispatch-unknown。

- 实际 OMP smoke：三个确定性场景——正常分支、一次 hook 分支、既有不同 comment分支；全部读取最终 feed而不只看 handler/LLM 输出。

- 竞争 hook smoke：前置 handler先 continuation时，本插件不误认 ownership、不叠加 continuation。

- Live Multica 不用于自动测试；重新启用前确认 SWO-1615 无 running/pending task。
## 反证检查

- 若 Multica 改为已有 agent comment后仍合成 final，分支 C 会重复；升级时必须重验 `HasAgentCommentedSince` 契约。

- 若 comment-add 获得 idempotency key，可消除 dispatch-unknown 的 duplicate-vs-loss边界。

- 若 agent无视 reminder，跨 task reciprocal loop仍可能发生；插件只保证自己不制造 peer mention且每 task最多提醒一次。

- 若前置 custom stop hook抢先 continuation，本插件不拥有原 final；当前版本明确不叠加，部署保证要求本插件是唯一/首个 continuation owner。

- 只验证 handler返回或 LLM turns而不读取最终 issue feed，无法证明 final未丢失/重复；所有 smoke必须断言最终 comment计数与 provenance。

## 未决事项

无。
