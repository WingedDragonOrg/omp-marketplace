# `/wt` Worktrunk 集成设计

日期：2026-09-02

## 背景与目标

当前 `plugins/wt/` 直接调用 `git worktree`，自行处理 worktree 路径、列表解析、脏状态检查、删除以及 OMP session 迁移。Worktrunk 已提供可机器读取的 worktree 生命周期接口、可配置路径、项目 hooks、审批机制和完整的本地 merge pipeline。

本设计让 `/wt` 在兼容 Worktrunk 可用时委托它管理 Git 生命周期，由插件继续负责 OMP 特有的 `sessionManager.moveTo()` 与 `ctx.reload()`。未安装 Worktrunk 的用户继续使用现有原生 Git 能力。

成功标准：

- 现有 create、reuse、list、remove、remove-all、remove-self 和 metadata prune 的外部语义不因后端变化而改变；
- Worktrunk 后端采用其路径配置、结构化状态和 lifecycle hooks；
- `/wt merge` 提供 Worktrunk 的完整本地集成 pipeline；
- 插件不绕过 Worktrunk 的项目命令审批，也不在失败后重复执行 Git 变更；
- worktree 操作完成后，OMP session 位于仍然有效且符合命令结果的目录。

## 范围

### 包含

- 运行时选择 Worktrunk 或原生 Git 后端；
- Worktrunk create/reuse、list、remove、remove-all 和 remove-self；
- 保持原有语义的 `git worktree prune`；
- Worktrunk lifecycle hooks、项目命令审批和后台 hook 日志提示；
- Worktrunk 完整 `/wt merge` pipeline 及其原生 flags；
- 操作后的 OMP session 迁移和 cwd-scoped surface reload；
- README、命令帮助和补全中与后端、merge、依赖和失败行为有关的说明。

### 不包含

- PR/MR picker、CI 状态或 LLM branch summary；
- merge 后自动 fetch 或 push；
- Worktrunk 配置编辑器；
- 自定义 `/wt merge --message` 参数；
- 原生 Git 版 merge pipeline；
- 自动安装或升级 Worktrunk；
- 搬迁既有 worktree；
- 将 `/wt prune` 改成删除已合并 worktree。

## 已知约束

- marketplace 安装只部署插件文件，不安装 `wt` 二进制；Worktrunk 必须由用户独立安装。
- Worktrunk 仍是 1.0 之前的 CLI；首轮兼容 allowlist 固定为已实测的稳定版 v0.76.x，prerelease 和其他版本需完成同一组行为探针后才能加入。
- `wt switch --no-cd --format=json` 可返回目标 worktree 路径；`wt list --format=json` 可返回仓库、分支、worktree 和 dirty 状态。
- `wt merge --format=json` 返回 source、target 和 pipeline 结果，但 v0.76.0 不返回 target worktree 路径；插件需要通过 list 结果解析目标目录。
- Worktrunk 的 merge cleanup 可以在后台完成。命令成功只证明 merge 已完成且 cleanup 已调度，不证明源目录已从磁盘删除。
- `ctx.reload()` 对命令处理器是终止操作；凡 session 路径发生迁移，需要 reload 时都必须把它作为最后一步。
- Worktrunk project hooks 和 project commit prompt fragment 可能执行命令或向外部 LLM 发送内容，必须保留其审批边界。

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 后端承诺 | Worktrunk 可选增强，原生命令可回退 | marketplace 无法提供外部二进制，同时现有用户需要继续可用 |
| 后端语义 | 两种后端保持现有 `/wt` create/remove/prune 契约 | 安装一个工具不应静默改变分支基点、分支删除或 prune 含义 |
| Merge 后端 | `/wt merge` 只使用 Worktrunk | 复制其 commit、squash、rebase、hooks 和 cleanup pipeline 会形成第二套不可靠实现 |
| Merge 默认值 | 采用完整 Worktrunk 默认 pipeline | 这是 agent worktree 完成后最有价值的一步式收尾能力 |
| Message | 采用 Worktrunk 的已有提交、配置生成器或确定性 fallback | 保持单一 message 规则，不在插件中建立旁路生成机制 |
| Hook 审批 | 未永久批准时取消操作，要求通过 Worktrunk 原生流程审批后重试 | Worktrunk 没有把一次预检结果绑定到后续 `--yes` 执行的原子授权 token |
| 兼容边界 | 首轮只允许稳定版 v0.76.x，并固定本次操作的绝对可执行文件路径 | 只读探针无法证明任意未来版本的 mutating JSON 契约 |
| 失败回退 | 只允许在变更启动前选择原生后端 | 变更后重试可能重复创建、重复 hooks 或扩大部分删除 |
| 路径优先级 | 显式 `OMP_WORKTREE_DIR` 优先，否则采用 Worktrunk 配置 | 保留已有环境变量契约，同时让 Worktrunk 成为默认路径策略来源 |
| Session 所有权 | Worktrunk 管理 Git，OMP 管理 session cwd | Worktrunk shell integration 无法迁移 OMP session |

## 设计

### 后端选择

插件在每次 `/wt` 命令开始时解析 Git 仓库，然后检查 PATH 中的 `wt`：

1. `wt` 不存在：现有命令使用原生 Git 后端；`merge` 返回 Worktrunk 安装要求。
2. `wt` 存在：解析为绝对可执行文件路径，读取版本，并在该次命令的所有子进程中固定使用同一路径。
3. 版本不属于稳定版 v0.76.x allowlist：现有命令在任何变更前告警并使用原生 Git；`merge` 拒绝执行并说明当前支持范围。
4. 版本受支持：用该绝对路径执行本次命令需要的只读探针，包括确定 schema 的 `list` 和需要时的 approvals JSON。
5. 只读探针通过：本次命令固定使用 Worktrunk 后端。mutating 命令的参数和返回 schema 由版本 allowlist 保证，不用变更命令充当 capability probe。

新增 Worktrunk minor 或 major 版本前，必须用真实 CLI 覆盖 switch、remove、merge 的成功、失败和部分成功输出，再扩大 allowlist。PATH、symlink 或安装状态在一次命令执行期间发生变化，不得改变已固定的绝对可执行文件。

Worktrunk 变更命令一旦启动，不再切换到原生 Git。退出码非零、JSON 缺字段、JSON 与对账后的 Git 状态不一致或 session 迁移失败，都按 Worktrunk 操作失败或部分成功处理。

原生后端继续是自包含实现，不调用 Worktrunk 配置或 hooks。后端选择不写入插件状态。

### 路径解析

未设置 `OMP_WORKTREE_DIR` 时，新 worktree 使用 Worktrunk 的 `worktree-path`，包括用户配置和按项目覆盖。

设置 `OMP_WORKTREE_DIR` 时，插件把展开后的绝对路径安全序列化为本次 Worktrunk 调用的 TOML override，生成与现有 `<repo>-<name>` 约定等价的路径模板。不得通过字符串拼接形成可注入的 TOML 或 shell 文本。

Git metadata 中已有的 worktree 无需搬迁。Worktrunk 按已登记路径复用；只有新建 worktree 使用当前路径策略。

### Create 与 reuse

命令保持：

```text
/wt [name] [--base <ref>]
```

- name 继续使用现有 slug 和默认时间戳规则。
- 本地分支不存在时调用 `wt switch --create <name> --base=<ref> --no-cd --format=json`。
- 未传 `--base` 时显式传 `--base=@`，保持“从当前 HEAD 创建”，不采用 Worktrunk 的默认分支基点。
- 分支或 worktree 已存在时调用 `wt switch <name> --no-cd --format=json`。
- hooks 默认启用。
- 成功后解析 JSON 的绝对 `path`，再用 Git metadata 和该目录内的 `rev-parse --show-toplevel` 确认它是 branch/name 一致的 live registered worktree；只有通过对账才迁移 session，不解析面向人的 stderr 路径。
- `moveTo(path)` 成功后通知并以 `ctx.reload()` 结束处理器。

Worktrunk 创建成功但 blocking hook 或 session 迁移失败时，不删除新 worktree。错误必须包含 worktree 路径和可重试动作；再次执行 `/wt <name>` 应复用该 worktree。

### List

`/wt list` 使用 `wt list --format=json`，并对本次调用关闭 `list.full` 和 `list.summary`，避免用户级默认值让列表触发 forge 网络请求或 LLM 生成。插件要求并解析确定的 JSON schema，同时保留当前紧凑展示：路径、分支或 detached HEAD，以及 current 标记。

JSON 解析失败发生在非变更操作中，因此可以告警并使用原生 `git worktree list --porcelain` 结果。

### Remove、remove-all 与 remove-self

Worktrunk 后端调用 `wt remove` 时固定使用：

- `--no-delete-branch`：删除 worktree 后保留分支；
- `--foreground`：命令返回前完成该次 remove；
- `--format=json`：按结构化结果报告；
- 仅在用户提供 `-f` 时传 `--force`。

插件保留现有 dirty 检查、删除摘要和确认 UI。Worktrunk 自身的检查仍是最终守卫。`-y` 只跳过插件的删除确认，不代表项目命令审批。

`rm --all` 继续排除 primary worktree、当前 session worktree、bare entry、prunable entry 和被普通目录占据的 stale path。各目标按确定顺序删除；单项失败不回滚已完成项，最终逐项报告成功和失败。每次 Worktrunk JSON 的 path/branch 必须与请求目标一致，并对账前后 live worktree 集合以报告 collateral removal。尾部仍执行原生 `git worktree prune` 清理 stale metadata。

`rm self` 的顺序保持：

1. 优先从验证后的 Worktrunk `worktree.main=true` metadata 确定 live primary worktree；原生后端兼容 `core.worktree` 和常规 `<primary>/.git`；
2. 完成 dirty 检查、hook 审批和用户确认；
3. `sessionManager.moveTo(primary)`；
4. 从 primary 路径调用 Worktrunk 删除原 worktree；
5. 删除成功后 `ctx.reload()`。

删除失败时 session 留在 primary，源 worktree保留并明确报告。

### Prune

`/wt prune` 始终调用 `git worktree prune`。它只清理 Git 的 stale worktree metadata，不调用 `wt step prune`，也不删除已合并 worktree或分支。

### Project hooks 与审批

在会触发 Worktrunk project hooks 或 project commit prompt fragment 的操作前，插件调用：

```text
wt config approvals list --format=json
```

插件根据本次 pipeline 过滤相关且尚未永久批准的项目命令：

- 新建 worktree（无论分支是否已存在）：pre-switch、pre-start、post-start、post-switch；
- 复用已登记 worktree：pre-switch、post-switch；
- remove：pre-remove、post-remove；
- merge：始终检查 pre-merge 和 post-merge；未传 `--no-commit` 时检查 pre-commit、post-commit 和可能使用的 project prompt fragment；cleanup 启用且 source 不在 target 分支时检查 pre-remove、post-remove 和 post-switch。

如果存在相关未批准命令或相关 stale approval，OMP 列出 phase、name 和完整 command template，然后取消操作。提示用户在同一仓库的原生终端中运行 `wt config approvals add`，阅读 Worktrunk 展示的完整审批范围并由 Worktrunk 持久化；用户随后重新执行 `/wt`。插件不调用 approvals add，也不以 `--yes`、`--no-hooks` 或原生 Git fallback 继续。

没有相关未批准项时，插件正常调用 Worktrunk且不传用于绕过审批的 `--yes`。纯用户配置命令不需要项目审批。`-y` 只能跳过插件自己的删除或 merge 摘要确认，不能改变审批结果。

blocking hook 失败时停止 pipeline。background hook 失败不回滚已完成的 Git 或 session 操作；通知中提供 `wt config state logs` 的查询方向。

### `/wt merge`

命令为：

```text
/wt merge [target]
  [--no-squash]
  [--no-commit]
  [--no-rebase]
  [--no-remove]
  [--no-ff]
  [--stage all|tracked|none]
  [-y]
```

插件只接受并逐项转发上述 Worktrunk 原生参数。target 默认由 Worktrunk 解析为默认分支。

默认 pipeline 由 Worktrunk 完整执行：

1. 处理未提交改动；
2. squash 当前分支相对 target 的提交；
3. rebase 到本地 target；
4. 执行 pre-merge 验证；
5. fast-forward target；
6. 在 cleanup 启用且 source 可清理时执行 remove hooks并调度 source worktree 与分支清理；
7. 执行后台 post hooks。

插件不在 merge 前 fetch，也不在 merge 后 push。

#### Merge 确认

除 `-y` 外，执行前显示：

- source 与 target；
- staged、unstaged、untracked 状态；
- source 相对 target 的提交数量；
- stage 策略；
- 是否 commit、squash、rebase、创建 merge commit；
- cleanup 启用且 source 可清理时，成功后是否删除 source worktree 和分支；
- commit message 的预计来源。

此摘要描述将请求的 pipeline，不承诺某一步一定发生；Worktrunk 可以在无需 commit、squash 或 rebase 时跳过该步。用户拒绝后不运行 Worktrunk merge。

#### Commit message

- 只有一个干净提交且无需 squash 时，保留已有 message。
- 需要 commit 或 squash且用户配置了 `[commit.generation].command` 时，由该外部命令根据 Worktrunk prompt 生成 message。
- squash prompt 可以使用 diff、diff stat、branch、recent commits、原提交列表和 target。
- 未配置生成命令时，采用 Worktrunk 的确定性文件名 fallback。
- `--no-squash` 保留已有提交 message；仍有未提交改动时，新提交的 message 继续由 Worktrunk 生成。
- 插件不从当前 OMP 对话生成或注入 message。需要精确 message 时，用户或 agent 先正常 commit，再使用 `--no-squash`。

#### Merge 与 session

执行前通过用户参数或 `wt list` 的 `repo.default_branch` 确定 target，并记录规范化的 source worktree identity/path、source repository 的 canonical `--git-common-dir` identity、source ref OID、target ref OID、target worktree，以及 `wt list` 中 `worktree.main=true` 的 primary worktree。候选目录还必须从目录内部通过 `rev-parse --show-toplevel`，与规范化路径一致、canonical common-dir 与 source 相同，且对应 metadata 不是 bare 或 prunable。插件据此选择不会被本次 cleanup 删除的 live 安全落点：

- source 是可能被清理的 linked worktree：优先使用与 source 不同的 live target worktree，否则使用与 source 不同的 live primary worktree；两者都不可用时，在任何 Git 变更前终止。
- source 是 primary worktree或 source branch 就是 target：Worktrunk 不清理该 worktree，无需预迁移。
- 使用 `--no-remove`：无需预迁移，session 始终留在 source。

需要预迁移时，插件在启动 Worktrunk merge 前先 `moveTo(安全落点)`，但尚不 reload；预迁移失败则不启动 merge。Worktrunk 仍通过 `-C <source>` 执行，因此 session 位置不改变 hook、commit 或 rebase 的仓库上下文。

发生预迁移后，cleanup-enabled merge 一旦启动，插件不再自动把 session 移回 source；后台 cleanup 与 source 存在性检查之间无法建立原子保证。无论命令成功、失败或 JSON 无效，session 都停在预先验证的安全落点并 reload。错误提示提供 source 路径，用户可在确认 worktree 仍存在后显式切回。`--no-remove`、source 为 primary 或 source branch 等于 target 时不发生预迁移，session 保持原路径，也不因 session 原因 reload。

命令返回后，插件从安全目录重新读取 target ref OID、source ref、`git worktree list --porcelain` 和相关路径状态，与执行前快照对账：

- target OID 变化时报告已更新，未变化时报告 unchanged；ref 缺失或不可读取时明确报告 absent/unreadable；
- 只有有效 Worktrunk 成功 JSON 的 `removed=true` 才报告 cleanup 已调度；
- source 是否仍登记、分支是否仍存在和目录是否仍存在，均按对账结果报告；
- 无效 JSON 或非零退出码本身不能证明 target 未更新，也不能证明 cleanup 已启动或完成。

target 没有独立 worktree 时，primary 只是安全 session 落点，不表述为已进入 target branch。Worktrunk 的后台 cleanup 最终错误以日志为准。

rebase 冲突时，Worktrunk 保留冲突现场；插件不 abort、不 reset、不删除 source。target 本地分支分叉或不能 fast-forward 时，merge 拒绝。pre-remove hook 可能在 target 更新后失败；插件根据 OID 和 worktree 对账报告“target 已更新、source 保留”，不得回滚 target。

### 输出与诊断

- stdout 只按命令对应的 JSON schema 解析；stderr 用于人类诊断和 hook 状态。
- 插件以 argv 数组启动 `wt`，不通过 shell 拼接 branch、path 或 ref。
- Worktrunk 因嵌入式调用产生的 shell-integration/cd 提示不展示，因为 OMP 已承担 session 迁移；不得过滤其他 warning、hook 输出或错误。
- Worktrunk 操作失败时报告退出码、简洁错误和日志查询位置；不得把 stderr 当作 JSON fallback。
- help 和 README 明确区分：现有命令可回退，`merge` 需要 Worktrunk。

## 错误与边界情况

| 情况 | 行为 |
| --- | --- |
| `wt` 不在 PATH | 现有命令使用原生 Git；merge 给出安装要求 |
| Worktrunk 版本不在 allowlist 或只读 JSON 不兼容 | 变更前对现有命令回退；merge 说明当前支持范围 |
| Worktrunk 变更后返回错误 | 不执行原生 Git 重试；按 ref、worktree 和路径对账报告实际状态 |
| create 已建 worktree，hook 失败 | session 不动，worktree 保留，可按路径诊断和重试 |
| create/reuse 成功后 `moveTo` 失败 | worktree 结果保留，旧 session 路径仍有效，报告目标路径和重试方式 |
| merge 预迁移 `moveTo` 失败 | 不启动 Worktrunk merge，仓库和 source session 保持不变 |
| 存在未永久批准项目命令 | 展示相关命令并取消，要求完成 Worktrunk 原生审批后重试 |
| remove-all 部分失败 | 保留已删除结果，逐项报告，不回滚 |
| merge message 生成失败 | source 保留；session 停在预先验证的安全目录 |
| merge rebase 冲突 | 保留 rebase 状态和 source；session 停在安全目录 |
| merge target 本地分叉 | Worktrunk 拒绝，不 fetch、不 reset target；session 停在安全目录 |
| merge pre-remove hook 失败 | 对账 target 和 source 后报告，不回滚已更新的 target |
| merge cleanup 后台失败 | target 合入结果保留，按对账和日志报告 cleanup 状态 |
| stale target path 或路径冲突 | 保留 Worktrunk 错误；不自动 clobber 或删除目录 |
| `OMP_WORKTREE_DIR` 含空格或特殊字符 | 作为 argv/TOML 数据安全传递，不经 shell 解释 |

## 验收标准

1. PATH 中无 `wt` 时，create、reuse、list、remove、remove-all、remove-self 和 prune 的既有行为通过真实 OMP 命令探针。
2. PATH 中无 `wt` 时，`/wt merge` 不修改仓库并给出明确安装要求。
3. 兼容 Worktrunk 可用时，新 worktree 使用 Worktrunk 路径配置；设置 `OMP_WORKTREE_DIR` 后改用该目录且路径命名保持现有约定。
4. Worktrunk create 未指定 `--base` 时从当前 HEAD 创建，而不是从默认分支创建。
5. create/reuse 成功后，只有 JSON path 与 Git 中 branch/name 一致、且 canonical common-dir 与 source repository 相同的 live registered worktree 对账成功，OMP session 才移到该路径并 reload cwd-scoped surfaces。
6. 既有旧路径 worktree 可被 list、reuse 和 remove，无需迁移。
7. `/wt list` 不因用户的 Worktrunk `list.full` 或 `list.summary` 配置触发 forge 请求或 LLM 生成。
8. Worktrunk remove 在默认情况下拒绝 dirty worktree；`-f` 才允许强制删除；成功删除 worktree 后原分支仍存在。
9. `rm self` 在删除前把 session 移到从 live primary metadata 解析的目录；删除失败时 session 仍位于 primary 且源 worktree仍存在。
10. `rm --all` 不触碰 primary、当前 session worktree、bare entry、prunable entry 或被普通目录占据的 stale path，并准确报告部分失败和意外消失的其他 live worktree。
11. `/wt prune` 只清 stale metadata；已合并但有效的 worktree和分支保持存在。
12. 相关 project command 未永久批准或 approval 已 stale 时，OMP 展示准确 phase/name/template 并取消；不运行 hook、不创建、不删除、不 merge，也不回退原生 Git。
13. 用户通过原生 `wt config approvals add` 完成审批并重试后，插件只在 approvals JSON 显示相关命令已批准时继续；插件本身不写 approval、不传 `--yes`。
14. `/wt rm -y` 和 `/wt merge -y` 仍不能越过未批准 project command。
15. blocking hook 失败停止对应 pipeline；background hook 失败不回滚已完成操作并可从提示位置找到日志。
16. 默认 `/wt merge` 可把含未提交改动和多个提交的 source squash/rebase/fast-forward 到本地 target，并在 cleanup 启用且 source 可清理时调度 worktree 与分支清理。
17. 未配置 message 生成器时，merge 使用 Worktrunk 确定性 fallback；配置生成器时使用其输出；`--no-squash` 保留已有提交 message。
18. `/wt merge --no-remove` 更新 target 后保留 source worktree，并让 OMP session 始终位于 source。
19. cleanup-enabled merge 在启动 Git 变更前把 session 预迁移到与 source 不同、canonical common-dir identity 相同且从 live target 或 Worktrunk primary metadata 验证出的安全落点；找不到落点或预迁移失败时仓库不变。
20. cleanup-enabled merge 启动后，无论成功、失败、二进制消失或 JSON 无效，session 都不自动返回可能被后台删除的 source；reload 后 cwd 始终指向已验证安全目录。
21. merge 后报告的 target updated/unchanged/absent、source 登记、source 分支和 source 路径状态与执行前后的 Git/ref/path 对账一致；只有有效成功 JSON 才能声明 cleanup 已调度。
22. merge 遇到 rebase 冲突、验证失败或 message 生成失败时，source 状态保留用于恢复，插件不自动回滚或清理。
23. merge 的 pre-remove hook 在 target 更新后失败时，target 保持已合入；对账结果准确显示 source 是否保留。
24. target 没有独立 worktree 时，session 可落在 primary，但通知不得声称当前 checkout 是 target。
25. Worktrunk 变更命令成功后若 JSON identity/schema 解析或 session 迁移失败，不发生原生 Git 的第二次变更；remove 还会报告返回目标不一致和 collateral removal。
26. 首轮只有稳定版 v0.76.x 会进入 Worktrunk 后端，且一次命令始终调用同一绝对可执行文件；prerelease 和其他版本在变更前按命令类型回退或拒绝。
27. 嵌入式调用不展示无关 shell-integration/cd 提示，但保留其他 Worktrunk warning、hook 输出和错误。
28. README 和 `/wt help` 准确说明后端选择、v0.76.x 支持范围、原生审批要求、merge 默认 pipeline、message 来源、分支清理和失败恢复。

## 未决事项

无。
