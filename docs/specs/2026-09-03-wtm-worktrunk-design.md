# WTM Worktrunk 集成与会话迁移设计

日期：2026-09-03

## 背景与目标

OMP 18.1.5 已内置 `/wt`，并把 `/wt` 与别名 `/worktree` 设为保留命令。同名扩展命令会在注册列表中被过滤，因此原 `wt` 插件即使成功加载，用户执行 `/wt` 时仍会进入 OMP 内置实现。

原插件在创建、`rm self` 和 cleanup-enabled merge 中直接调用 `sessionManager.moveTo()`，随后调用 `ctx.reload()`。这只能迁移 session 文件及其记录的 cwd；`ctx.reload()` 只重载 session、transcript 和 todos，不会执行 OMP 内置 `/move` 的 cwd 重定域。实际结果可能是命令执行目录已经改变，但 footer 仍显示旧路径和旧分支，项目 settings、provider globals、plugin roots、capabilities、title prompt、skills 和 slash commands 也未统一切换。

本设计把插件统一改名为 `wtm`，使用 `/wtm` 承载 Worktrunk 生命周期和 merge 能力，并把所有 session cwd 切换交给 OMP 内置 `/move`。Create/reuse 与 cleanup-enabled merge 采用预填 `/move` 的续执行流程；`rm self` 在同一次命令中先删除当前 worktree，再预填迁移到 primary 的 `/move`。用户按 Enter 后由 OMP 完成 session、进程 cwd、项目级状态和 UI 的原子重定域。

成功标准：

- OMP 内置 `/wt` 与 `/worktree` 不受插件影响，插件通过唯一入口 `/wtm` 可达；
- `/wtm` 无 branch 参数时自动生成默认 branch name，有显式参数时使用指定 branch；
- Worktrunk create/reuse、list、remove、prune、hooks、approvals 和 merge 能力继续可用；
- 插件不再直接迁移 session，也不把 transcript reload 表述成 cwd 切换完成；
- cleanup-enabled merge 必须先由内置 `/move` 把 session 移到 live safe landing；`rm self` 在删除当前 worktree 后准备迁移 handoff；
- 需要续执行的操作不把仓库状态缓存为授权，执行阶段重新验证 identity、dirty state、approvals 和 Git 状态。

## 范围

### 包含

- marketplace、package、plugin manifest、目录、入口文件和 slash command 从 `wt` 统一迁移到 `wtm`；
- `/wtm` 无参数默认 branch、显式 branch 和 `--base` 行为；
- Worktrunk 与原生 Git 后端选择；
- Worktrunk create/reuse、list、remove、remove-all 和 remove-self；其中 remove-self 直接删除 source 并准备 move handoff；
- 保持原有语义的 `git worktree prune`；
- Worktrunk lifecycle hooks、项目命令审批和后台 hook 日志提示；
- Worktrunk 完整 merge pipeline 及其原生 flags；
- cleanup-enabled merge 的显式 `--source <path>` 续执行契约；
- TUI 中预填 `/move`，以及无 TUI 时输出可复制的后续命令；
- README、命令帮助、补全、测试和既有规格同步更新。

### 不包含

- 修改 OMP 核心或依赖未发布的 OMP 扩展 API；
- 从扩展中调用 OMP 私有模块、内部 TUI 对象或未公开的 session mutation 方法；
- 自动提交预填的 `/move`、模拟 Enter，或在后台继续 merge/remove；
- PR/MR picker、CI 状态或 LLM branch summary；
- merge 前自动 fetch 或 merge 后自动 push；
- Worktrunk 配置编辑器；
- 自定义 merge message 参数；
- 原生 Git 版 merge pipeline；
- 自动安装或升级 Worktrunk；
- 搬迁既有 worktree；
- 将 prune 改成删除已合并 worktree。

## 已知约束

- OMP 18.1.5 的 built-in registry 保留 `/wt` 和 `/worktree`，扩展不能覆盖它们。
- `ExtensionCommandContext.sessionManager` 的公开类型是只读视图；完整 session relocation 不是扩展 API。
- `ctx.reload()` 会 reload 当前 session 并重绘 transcript/todos，但不会调用 `applyCwdChange()`。
- OMP 内置 `/move` 会保存 settings/回滚 session relocation，并重载进程 cwd、项目 settings、provider globals、plugin roots、capabilities、title prompt、skills、slash commands、terminal title、status line、editor border 和 todos。
- `ctx.ui.setEditorText()` 只在 TUI 提供后续命令输入面；print/RPC 等无 TUI surface 必须输出完整 `/move` 命令并保持 session 不动，`rm self` 则在删除 source 后输出该 handoff；
- Move handoff 是单行 slash command 协议：目标 path 含 CR、LF 或 NUL 时不能自动预填；其他 path 必须按下文规定可逆序列化。
- marketplace 安装只部署插件文件，不安装 `wt` 二进制；Worktrunk 必须由用户独立安装。
- Worktrunk 仍是 1.0 之前的 CLI；兼容 allowlist 固定为已实测的稳定版 v0.76.x，prerelease 和其他版本需完成同一组行为探针后才能加入。
- `wt switch --no-cd --format=json` 可返回目标 worktree 路径；`wt list --format=json` 可返回仓库、分支、worktree 和 dirty 状态。
- `wt merge --format=json` 返回 source、target 和 pipeline 结果，但 v0.76.0 不返回 target worktree 路径；插件需要通过 list 结果解析安全落点。
- Worktrunk 的 merge cleanup 可以在后台完成。命令成功只证明 merge 已完成且 cleanup 已调度，不证明源目录已从磁盘删除。
- Worktrunk project hooks 和 project commit prompt fragment 可能执行命令或向外部 LLM 发送内容，必须保留其审批边界。

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 插件身份 | marketplace、package、目录和命令统一为 `wtm` | 避开 OMP 保留命令，并保持安装身份与用户入口一致 |
| 版本 | `1.3.0` | 直接 self removal 后预填 `/move` 的用户可见行为变化 |
| 默认 branch | `/wtm` 无参数生成 `wt-<YYYYMMDDHHMM>` | 保留原插件的 branch/path 兼容规则，同时补齐无参数体验 |
| Session 所有权 | `/move` 独占 session cwd 切换 | 只有 OMP core 能原子更新 session、进程和全部 cwd-scoped surfaces |
| 移动交互 | TUI 预填 `/move <absolute-path>`，用户确认提交 | 在 18.1.5 支持范围内复用 core 迁移，不伪造输入或调用私有 API |
| Merge 两步状态 | 不保存 pending operation；后续命令显式携带 source 并重新验证 | 避免取消、重启或仓库变化后误执行 |
| Merge source | 新增 `--source <path>` | session 移出 source 后仍能从安全目录对原 worktree 执行 merge |
| Merge 续命令编码 | `/move` 使用 raw outer quotes；`/wtm` 续命令使用 JSON string token | 分别匹配 OMP 18.1.5 的 freeform `/move` 参数和插件自己的 tokenizer，覆盖空格、引号与反斜杠 |
| 后端承诺 | Worktrunk 可选增强，原生命令可回退 | marketplace 无法提供外部二进制，同时现有 lifecycle 用户需要继续可用 |
| Merge 后端 | merge 只使用 Worktrunk | 复制其 commit、squash、rebase、hooks 和 cleanup pipeline 会形成第二套实现 |
| Hook 审批 | 未永久批准时取消操作，要求通过 Worktrunk 原生流程审批后重试 | 插件不能把只读预检当成可转移或可持久化的授权 |
| 失败回退 | 只允许在变更启动前选择原生后端 | 变更后重试可能重复创建、重复 hooks 或扩大部分删除 |
| 路径优先级 | 显式 `OMP_WORKTREE_DIR` 优先，否则采用 Worktrunk 配置 | 保留既有环境变量契约，同时采用 Worktrunk 默认路径策略 |

## 设计

### 插件身份与发布

最终发布面统一为：

```text
plugins/wtm/
  package.json              name: wtm, version: 1.3.0
  .omp-plugin/plugin.json   name: wtm, version: 1.3.0
  wtm.ts                    omp.extensions entry
  wtm.test.ts
  README.md
```

两份 marketplace catalog 保持字节一致，entry 使用：

```text
name: wtm
source: ./wtm
version: 1.3.0
```

根 README 和插件 README 只把 `/wtm` 作为本插件入口。外部 Worktrunk CLI 仍叫 `wt`；`OMP_WORKTREE_DIR` 和既有 worktree 路径不改名。

这是 marketplace identity 迁移，不保留 `wt` catalog entry、package alias 或 `/wt` 扩展命令。已安装用户需要先卸载旧 entry，再安装：

```sh
omp plugin uninstall wt@winged-dragon-org
omp plugin install wtm@winged-dragon-org
```

### 命令面

```text
/wtm [branch] [--base <ref>]                 create/reuse worktree
/wtm list                                    list this repository's worktrees
/wtm rm <branch|path> [-f] [-y]              remove one worktree; retain its branch
/wtm rm self [-f] [-y]                       remove current worktree, then prepare /move
/wtm rm --all [-f] [-y]                      remove eligible worktrees except primary/current
/wtm prune                                   prune stale Git worktree metadata
/wtm merge [target] [flags] [--source <path>] run Worktrunk's local merge pipeline
```

`/wtm` 与 `/wtm --base <ref>` 都是 create：没有 positional branch 时生成 `wt-<YYYYMMDDHHMM>`。显式 branch 继续经过既有 slug 规范化。新分支默认从当前 `HEAD` 创建；指定 `--base` 时使用该 ref。

### 后端选择

插件在每次 `/wtm` 命令开始时解析 Git 仓库，然后检查 PATH 中的 `wt`：

1. `wt` 不存在：create/reuse/list/remove/prune 使用原生 Git 后端；merge 返回 Worktrunk 安装要求。
2. `wt` 存在：解析为绝对可执行文件路径，读取版本，并在该次命令的所有子进程中固定使用同一路径。
3. 版本不属于稳定版 v0.76.x allowlist：lifecycle 命令在任何变更前告警并使用原生 Git；merge 拒绝执行。
4. 版本受支持：用固定路径执行本次命令需要的 list 和 approvals 只读探针。
5. 只读探针通过：本次命令固定使用 Worktrunk 后端。

Worktrunk 变更命令一旦启动，不再切换到原生 Git。退出码非零、JSON 缺字段、JSON 与对账后的 Git 状态不一致，都按 Worktrunk 操作失败或部分成功处理。

### Move handoff
插件以一个共同的 move handoff 行为替代所有直接 session mutation：

1. 生成 handoff 时，目标必须是 canonical path 与 Git metadata 一致、属于当前 repository identity 的 live registered worktree。
2. 目标绝对路径含 CR、LF 或 NUL 时不生成单行命令；create 结果保留，cleanup merge 的准备阶段保持仓库不变，`rm self` 在删除前停止；
3. TUI 调用 `ctx.ui.setEditorText()` 预填 `/move "<raw-absolute-path>"`；outer quotes 只包住完整 raw path，不对其中的空格、引号或反斜杠做 shell/JSON 转义，以匹配 OMP 18.1.5 对 `/move` 整段参数只去除最外层双引号的行为。
4. 无 TUI 时输出同一条完整命令；只输出，不提交。
5. 插件不直接迁移 session：create/reuse 与 merge 准备阶段保持原目录，`rm self` 在 source 删除后保持原 cwd，直到用户提交 `/move`。
6. 对 create/reuse 与 merge handoff，live registration 与 repository identity 的保证截止到 handoff 生成时。用户提交前目标若消失，采用内置 `/move` 的失败与回滚结果；目标若被替换，`/move` 只保证进入当时存在的目录，后续 `/wtm` 命令会重新执行 Git/repository identity 校验。`rm self` 的 source 已在 handoff 前删除，primary 失效时保留删除结果并报告 handoff 问题。
7. 用户提交 `/move` 后，成功/失败、回滚和所有 cwd-scoped refresh 由 OMP core 报告。

插件通知只声明已经发生的 Git/Worktrunk 结果和“move command 已准备”；只有内置 `/move` 成功后才算 session 迁移完成。

插件生成的 merge 续命令使用 JSON string literal 表示 path、target 和 ref 等自由文本 token。命令 parser 必须把未加引号 token 与 JSON string token 解析为同一 argv 模型，拒绝无效转义和未闭合字符串；不得再用空白 `split` 解析命令。这样 `--source`、remove selector 和重放的 merge options 可以无损覆盖空格、双引号、反斜杠及以 `-` 开头的值。

### Create 与 reuse

Worktrunk 后端：

- 分支不存在时调用 `wt switch --create <branch> --base=<ref> --no-cd --format=json`；
- 未传 `--base` 时显式传 `--base=@`，保持从当前 HEAD 创建；
- 分支或 worktree 已存在时调用 `wt switch <branch> --no-cd --format=json`；
- hooks 默认启用；
- 成功后用 JSON path、Git metadata、branch 和 repository identity 对账；
- 对账通过后执行 move handoff，不调用 `sessionManager.moveTo()` 或 `ctx.reload()`。

原生 Git 后端保持现有 add/reuse 语义，成功后进入同一 move handoff。

Worktree 已创建但用户取消、未提交或执行 `/move` 失败时，worktree 保留。再次运行 `/wtm <branch>` 复用它并重新提供 move handoff。

### List

`/wtm list` 使用 `wt list --format=json`，并对本次调用关闭 `list.full` 和 `list.summary`，避免用户级默认值触发 forge 网络请求或 LLM 生成。JSON 解析失败发生在非变更操作中，可以告警并使用原生 `git worktree list --porcelain`。

列表显示路径、branch 或 detached HEAD，以及根据当前 session cwd 计算的 current 标记。它不尝试纠正由外部工具造成的 cwd 不一致。

### Remove、remove-all 与 remove-self

普通 remove 固定使用：

- Worktrunk `--no-delete-branch`；
- Worktrunk `--foreground`；
- Worktrunk `--format=json`；
- 仅在用户提供 `-f` 时传 `--force`。

插件保留 dirty 检查、删除摘要和确认 UI。`-y` 只跳过插件删除确认，不能改变 project command approval。

`rm --all` 继续排除 primary、当前 session worktree、bare、prunable 和被普通目录占据的 stale path。各目标按确定顺序删除；单项失败不回滚已完成项，最终逐项报告并执行 `git worktree prune`。

`rm self` 在同一次调用中完成删除和 move handoff：

1. 验证当前目录是 linked live worktree，并解析同 repository identity 的 live primary；
2. 在删除前验证 primary 可表示为单行 `/move` 命令；
3. 按普通 remove 流程检查 dirty state、project approvals，并根据 `-y` 显示确认；
4. 使用 Worktrunk 或原生 Git 在 foreground 删除当前 worktree，成功后执行 `git worktree prune`；
5. 仅在 source worktree 已不再登记且目录已删除后，预填 primary 的 `/move`。用户完成 `/move` 后不需要再次输入 `/wtm rm`。

如果删除失败，不准备 move handoff。删除成功但 primary 在 handoff 前失效时，保留已发生的删除结果并报告 `/move` 无法生成；`rm self` 不保存 pending operation，也不把删除授权转移到后续命令。

### Project hooks 与审批

在会触发 Worktrunk project hooks 或 project commit prompt fragment 的执行阶段前，插件调用：

```text
wt config approvals list --format=json
```

相关未批准命令或 stale approval 会取消该阶段，并提示用户通过原生 `wt config approvals add` 审批后重试。插件不写 approvals，不传用于绕过审批的 `--yes` 或 `--no-hooks`。

Create/reuse 的审批在 Worktrunk switch 前执行；`rm self` 在删除前执行 remove approval 检查；Merge 准备阶段不执行 hook，因此 approval 在携带 `--source` 的执行阶段重新读取。

Blocking hook 失败停止 pipeline。Background hook 失败不回滚已完成的 Git 操作；通知提供 `wt config state logs`。

### Merge

命令接受：

```text
/wtm merge [target]
  [--source <absolute-worktree-path>]
  [--no-squash]
  [--no-commit]
  [--no-rebase]
  [--no-remove]
  [--no-ff]
  [--stage all|tracked|none]
  [-y]
```

未传 `--source` 时，source 是当前 session worktree。传入时，source 必须解析为同一 repository identity 下的 live registered branch-backed worktree。

Target 默认由 Worktrunk 的 `repo.default_branch` 解析。插件不 fetch、不 push。

#### 无需迁移的执行

以下情况可以直接从当前 session 执行：

- `--no-remove`；
- source 是 primary；
- source branch 等于 target；
- 显式 `--source` 与当前 session cwd 不同，且当前 cwd 是同仓库的 live registered worktree。

执行前重新读取 source/target refs、dirty state、approvals 和 Worktrunk list，显示 merge 摘要并按 flags 运行 `wt merge ... -C <source-path> --format=json`。

#### Cleanup-enabled 两步执行

未传 `--source`、source 是当前 linked worktree且 cleanup 可能删除 source 时：

1. 记录规范化 source path、source branch、source HEAD、repository identity 和用户原始 merge options；
2. 优先选择不同于 source 的 live target worktree，否则选择不同于 source 的 live primary；
3. 找不到 safe landing 或 path 不能按 move handoff 协议序列化时，在 Git 变更前停止；
4. 不读取可转移的 approval 结论、不显示最终 merge 确认、不启动 Worktrunk；
5. 预填 safe landing 的 `/move`；
6. 输出迁移后完整的 `/wtm merge ... --source <json-source-path>`；保留 target 与所有 operation flags，但移除准备阶段的 `-y`，确保执行阶段基于实时摘要重新确认。

用户完成 `/move` 后运行续执行命令。执行阶段必须重新验证：

- 当前 session cwd 与 source 不同；
- 当前 cwd 与 source 都是同一 repository identity 的 live registered worktree；
- source path 仍对应 branch-backed worktree，并读取实时 source branch/HEAD；
- target ref 仍存在，cleanup 仍只可能删除 source；
- source 中不存在未解决的 rebase、merge、cherry-pick 或 revert sequencer；
- approvals、dirty state 和确认摘要反映当前状态。

Source branch/HEAD 与准备阶段不同时不沿用任何确认；由于后续命令不携带 `-y`，执行阶段展示实时差异并要求用户重新决定。任何验证失败都不启动 Worktrunk。插件不持久化 pending merge，也不因看到相同 source 自动继续。

#### Pipeline 与对账

Worktrunk 默认 pipeline 保持：

1. 处理未提交改动；
2. squash source 相对 target 的提交；
3. rebase 到本地 target；
4. 执行 pre-merge 验证；
5. fast-forward target；
6. cleanup 启用且 source 可清理时运行 remove hooks 并调度 source worktree 与 branch 清理；
7. 启动后台 post hooks。

命令返回后，插件从当前安全 worktree 对账 target ref、source registration、source branch 和 source path：

- target OID 变化时报告 updated，未变化时报告 unchanged；缺失或不可读时明确报告；
- 只有有效 Worktrunk 成功 JSON 的 `removed=true` 才报告 cleanup 已调度；
- source 是否仍登记、branch 是否仍存在、目录是否仍存在均按实时结果报告；
- 非零退出码或无效 JSON 不触发原生 Git 重试，也不自动建议重放同一 merge。

Rebase 冲突时保留冲突现场。Pre-remove hook 在 target 更新后失败时不回滚 target。Background cleanup 最终错误以 Worktrunk 日志为准。Session 始终留在用户通过 `/move` 选择的安全 worktree，插件不自动返回 source。

后续再次调用 merge 时先检查实时 Git 状态：

- source 存在未解决 sequencer/conflict 时拒绝启动新 pipeline，要求先在 source 中解决或 abort；
- target 已包含当前 source OID、但 source worktree 或 branch 仍存在时，不重放 commit/rebase/fast-forward 阶段；报告“integration 已完成、cleanup 未完成”，并指向 Worktrunk 日志和原生 cleanup 恢复；
- 其他情况按一次新的 merge 请求重新执行完整 preflight、approvals 和确认。

Create 在 Worktrunk error/JSON incompatibility 后再次调用时，必须先以 list/Git metadata 对账；匹配的 live branch worktree 已存在则只进入 reuse 路径，不再次执行 create。Reuse 可以按 Worktrunk 契约重新运行 switch hooks，但不得重放 create/start hooks。

### 输出与诊断

- stdout 只按命令对应的 JSON schema 解析；stderr 用于人类诊断和 hook 状态。
- 所有外部命令使用 argv 数组，不通过 shell 拼接 branch、path 或 ref。
- Worktrunk 的 shell-integration/cd 提示不展示，因为 OMP `/move` 承担 session 迁移；其他 warning、hook 输出和错误保留。
- Move handoff 显示目标路径；需要续执行的 merge 同时显示后续命令。路径来自经过 repository identity 对账的绝对路径。
- 操作完成通知只声明已经发生的 Git/Worktrunk 结果，不提前声明 session 已迁移。

## 错误与边界情况

| 情况 | 行为 |
| --- | --- |
| 用户执行 `/wt` | 由 OMP 内置命令处理，插件不拦截 |
| `/wtm` 无 branch | 生成 `wt-<YYYYMMDDHHMM>` 并进入 create 流程 |
| `wt` 不在 PATH | lifecycle 使用原生 Git；merge 给出安装要求 |
| Worktrunk 版本或只读 JSON 不兼容 | 变更前按命令类型回退或拒绝 |
| create 已建 worktree，hook/JSON 失败 | session 不动；重试先对账，已存在则进入 reuse 而非再次 create |
| create/reuse 成功后用户不执行 `/move` | worktree 保留，session 和 UI 保持原目录 |
| handoff path 含 CR、LF 或 NUL | 不预填；create 结果保留，cleanup merge 和 `rm self` 在变更前保持仓库不变 |
| handoff 后目标被删除 | 采用内置 `/move` 的失败/回滚结果，要求重新生成 handoff |
| handoff 后目标被替换 | `/move` 可能进入替换目录；后续 `/wtm` 重新验证 Git/repository identity 后才允许操作 |
| TUI editor 不可用 | 输出完整 `/move`；cleanup merge 另外输出续执行命令，不自动迁移 |
| `rm self` 删除失败 | 不准备 `/move`，保留 source 现场 |
| `rm self` 删除成功 | 预填 primary 的 `/move`，不输出 remove 续命令 |
| `rm self` primary 在删除后失效 | 保留 source 删除结果，报告 `/move` handoff 问题 |
| cleanup merge 找不到 safe landing | 不启动 Worktrunk，仓库不变 |
| cleanup merge 未带 `--source` 且当前仍是 source | 只生成 move handoff，不启动 Worktrunk |
| cleanup merge 准备时传 `-y` | 后续命令移除 `-y`，执行阶段显示实时摘要并确认 |
| `--source` 指向 stale、普通目录或其他仓库 | 拒绝且不启动 Worktrunk |
| `--source` 等于当前 cwd 且 cleanup 可删除 source | 拒绝执行并重新提供安全移动步骤 |
| source 存在未解决 Git sequencer/conflict | 拒绝启动新的 merge pipeline |
| target 已包含 source、cleanup 未完成 | 不重放 merge pipeline；报告部分完成并给出 Worktrunk 恢复入口 |
| Worktrunk 变更后返回错误 | 不执行原生 Git 重试；按 refs、worktree 和路径对账 |
| merge pre-remove/background cleanup 失败 | target 结果保留，报告 source 状态并提示 Worktrunk 日志 |
| `OMP_WORKTREE_DIR` 含空格、引号或反斜杠 | Move handoff 与 JSON string token round-trip 到完全相同的 path |

## 验收标准

1. 安装插件后 `/wt` 与 `/worktree` 仍执行 OMP 18.1.5 内置行为；插件不注册这两个名字。
2. `/wtm help`、autocomplete 和 command inventory 只展示 WTM 命令面，且实际 dispatch 到插件。
3. `plugins/wtm/`、package、plugin manifest、入口文件、测试文件和两份 marketplace catalog 的 name/source/version 一致，两份 catalog 字节一致。
4. `/wtm` 无参数时创建或复用 `wt-<YYYYMMDDHHMM>` branch；`/wtm <branch>` 使用规范化后的显式 branch。
5. `/wtm --base <ref>` 在没有 positional branch 时仍生成默认 branch，并从该 ref 创建。
6. 兼容 Worktrunk 可用时，新 worktree 使用 Worktrunk 路径配置；设置 `OMP_WORKTREE_DIR` 后使用既有路径规则。
7. Create/reuse 只有在 JSON path、branch、live registration 和 repository identity 对账成功后才提供 move handoff。
8. Create/reuse 成功后、用户提交 `/move` 前，session cwd 与 footer 保持原目录，编辑器包含目标绝对路径的 `/move` 命令，通知不声称已经移动。
9. 目标从 handoff 到用户提交期间保持不变时，提交预填 `/move` 后的真实 TUI 探针显示目标路径和目标 branch；后续 `!pwd`、commands、skills 和 todos 使用目标项目 scope。
10. Handoff 后删除目标时，内置 `/move` 失败且 source session 保持可用；把目标替换为普通目录或其他仓库时，后续 `/wtm` 在任何 Git/Worktrunk 变更前拒绝。
11. 无 TUI 时 create/reuse 输出可复制的完整 `/move` 命令，且进程不退出到不存在或未验证的目录。
12. Worktrunk create 未指定 `--base` 时从当前 HEAD 创建，不采用默认 branch 基点。
13. `/wtm list` 不因用户的 `list.full` 或 `list.summary` 配置触发 forge 请求或 LLM 生成。
14. Worktrunk remove 默认拒绝 dirty worktree；`-f` 才允许强制；成功删除后 branch 仍存在。
15. `rm self` 验证当前 live worktree、同仓库 primary、dirty state 和 project approvals，并遵守 `-y` 确认语义。
16. `rm self` 删除 source 后预填 primary 的 `/move`；成功删除后不需要第二个 `/wtm rm` 命令，branch 仍保留。
17. `rm self` 在 primary handoff 不可表示或删除结果未确认时不生成 `/move`；删除已发生但 handoff 失败时准确报告已发生的删除。
18. `rm --all` 不触碰 primary、当前 session worktree、bare、prunable 或被普通目录占据的 stale path，并准确报告部分失败。
19. Prune 只清 stale metadata；已合并但有效的 worktree 和 branch 保持存在。
20. Cleanup-enabled merge 从当前 linked source 首次调用时不改变 refs、不运行 hooks、不启动 Worktrunk，并预填 live target/primary safe landing 的 `/move`。
21. Merge 准备阶段输出的续执行命令包含原 target、除 `-y` 外的全部 flags 和 canonical `--source <source-path>`。
22. 用户完成 `/move` 并运行续执行命令后，插件从安全 worktree 对原 source 执行 Worktrunk pipeline；当前 session cwd 不被 cleanup 删除。
23. `--source` 为 stale path、普通目录、其他仓库、非 branch worktree，或仍等于可清理的当前 cwd 时，merge 在任何变更前拒绝。
24. `--no-remove`、source 为 primary、source branch 等于 target 时，merge 无需 move handoff即可直接执行。
25. `rm self` 与 merge 续执行命令中的 path、target 和 ref 经 JSON string token 编解码后逐字节 round-trip；覆盖空格、双引号、反斜杠和以 `-` 开头的 token。
26. Move handoff 对含空格、双引号和反斜杠的绝对路径 round-trip 到同一目录；含 CR、LF 或 NUL 时不生成可误解析的命令。
27. 相关 project command 未永久批准或 approval stale 时，执行阶段展示 phase/name/template 并取消；准备阶段的 `-y` 不能越过执行阶段确认或 approval。
28. 默认 merge 可处理未提交改动、squash/rebase/fast-forward，并在 source 可清理时调度 cleanup；message 来源保持 Worktrunk 现有规则。
29. Merge 后 target/source/worktree/path 报告与执行前后的 Git 对账一致；只有有效成功 JSON 才声明 cleanup 已调度。
30. Source 存在 rebase/merge/cherry-pick/revert sequencer 时，再次调用 merge 不启动新 pipeline。
31. Target 已包含当前 source OID、但 cleanup 未完成时，再次调用 merge 不重放 commit/rebase/fast-forward，并报告 Worktrunk 恢复入口。
32. Create hook/JSON 部分失败后再次调用时，匹配的 live worktree 只走 reuse，不再次执行 create/start hooks。
33. Rebase 冲突、验证失败、message 生成失败或 pre-remove hook 失败时，不自动回滚或清理可恢复的 source 状态。
34. 首轮只有稳定版 Worktrunk v0.76.x 进入增强后端，一次命令始终调用同一绝对可执行文件。
35. 源码中不再通过扩展 context 调用 `sessionManager.moveTo()` 完成 cwd 切换，也不以 `ctx.reload()` 代替 `/move`。
36. README 和命令帮助准确说明插件身份、默认 branch、两步移动、`--source`、参数编码、审批、merge pipeline 和 marketplace 迁移步骤。

## 未决事项

无。
