---
name: wtm
description: This skill should be used when initializing, reviewing, or repairing Worktrunk configuration for an OMP project. It explains `.config/wt.toml`, user and project settings, lifecycle hooks, template variables, approvals, worktree paths, and practical Node, Python, and Rust examples.
---

# WTM / Worktrunk 配置指南

## 先记住

- `wt` 是单独安装的 Worktrunk CLI；`/wtm` 是 OMP 的 worktree 管理入口。
- 本文所说的项目级 `wt.toml`，准确路径是 **`.config/wt.toml`**，不是仓库根目录下的 `wt.toml`。
- WTM 当前只把稳定的 Worktrunk `v0.76.x` 当作增强后端。先用 `wt --version` 确认版本。
- WTM 负责 worktree 生命周期和 merge handoff；Worktrunk 负责 hooks、路径模板、审批和 merge pipeline。
- 没有兼容的 `wt` 时，创建、列表、删除、prune 仍可使用原生 Git；`/wtm merge` 需要 Worktrunk。

## 快速开始

在仓库中按以下顺序操作：

```sh
# 1. 检查 Worktrunk
wt --version

# 2. 可选：安装 shell integration；直接使用 `wt` 时它负责自动 cd 和补全
wt config shell install
# 安装后重启 shell，或重新加载对应的 shell 配置

# 3. 查看当前加载的配置和文件位置
wt config show

# 4. 生成项目配置模板；生成后按项目实际命令修改
wt config create --project

# 5. 让 Worktrunk 预览 hook，不执行命令
wt hook pre-start --dry-run
wt hook post-start --dry-run
```

也可以在 OMP 中执行：

```text
/wtm init
```

`/wtm init` 会把一份初始化 prompt 发送给当前 agent。agent 会先读取本技能，再检查仓库实际存在的依赖、构建、测试和开发服务器命令，然后创建或最小化更新 `.config/wt.toml`。该命令本身不代替 agent 编辑配置，也不安装软件、启动长期运行的服务或提交变更。

## 配置文件与优先级

| 层级 | 路径 | 适合放什么 | 是否提交 |
| --- | --- | --- | --- |
| system | 平台系统配置；macOS 通常是 `/Library/Application Support/worktrunk/config.toml`，Linux 位置以 `wt config show` 为准 | 组织级默认值 | 否 |
| user | `~/.config/worktrunk/config.toml`；受 `$XDG_CONFIG_HOME` 影响 | 个人 worktree 路径、个人列表偏好、个人 LLM commit 设置 | 否 |
| project | `.config/wt.toml` | 团队共享的项目 hooks、开发服务器 URL 等 | 是 |

系统配置、用户配置和项目配置不是同一用途。不要把个人路径或凭据写进项目文件；项目 hook 会在每个开发者的 worktree 中执行。

查看最终解析结果：

```sh
wt config show
```

项目配置由命令运行时所在的 worktree 读取。WTM 的 `OMP_WORKTREE_DIR` 是 OMP 侧的显式路径覆盖：设置后，WTM 创建新 worktree 时会把计算出的路径传给 Worktrunk；未设置时使用 Worktrunk 的 `worktree-path` 配置。已经登记的 worktree 会复用它当前的路径。

## User 配置：worktree 路径

`worktree-path` 属于 user/system 配置，不要放在团队共享的 `.config/wt.toml` 中。相对路径以 repository root 为基准，模板在创建新 worktree 时展开。

```toml
# ~/.config/worktrunk/config.toml
worktree-path = "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}"
```

常用路径方案：

```toml
# 放在仓库内的 .worktrees/ 目录
worktree-path = "{{ repo_path }}/.worktrees/{{ branch | sanitize }}"

# 集中放在 ~/worktrees/<repo>/<branch>
worktree-path = "~/worktrees/{{ repo }}/{{ branch | sanitize }}"

# 按远端 owner 分组
worktree-path = "~/development/{{ owner }}/{{ repo }}/{{ branch | sanitize }}"

# 用稳定的友好名称作为目录名
worktree-path = "{{ repo_path }}/../{{ repo }}.{{ branch | codename(2) }}"
```

常用路径变量：

- `{{ repo_path }}`：仓库根目录的绝对路径。
- `{{ repo }}`：磁盘上的仓库目录名。
- `{{ owner }}`：主远端 owner 路径，可能包含 subgroup。
- `{{ remote_repo }}`：主远端 URL 中的仓库名，不含 `.git`。
- `{{ branch }}`：原始分支名，例如 `feature/auth`。
- `{{ branch | sanitize }}`：把 `/` 和 `\\` 转成 `-`，适合文件系统路径。
- `{{ branch | sanitize_db }}`：适合数据库标识符的安全名称。
- `{{ branch | codename(2) }}`：根据分支确定性生成友好名称。

Worktrunk 会对模板变量做 shell escaping。通常不要再给单个 `{{ ... }}` 加一层 shell 引号。分支可能包含 `/`、空格或特殊字符时，优先使用 `sanitize` 或 `sanitize_hash`。

### User 配置：单项目个人覆盖

不想把个人 worktree 路径或列表偏好提交给团队时，可以在 user config 的 `[projects]` 中按项目限定覆盖。项目标识可通过 `wt config show --format=json` 的 `project.identifier` 查看：

```toml
# ~/.config/worktrunk/config.toml
[projects."github.com/WingedDragonOrg/omp-marketplace"]
worktree-path = ".worktrees/{{ branch | sanitize }}"

[projects."github.com/WingedDragonOrg/omp-marketplace".list]
full = true
```

`[projects]` 是 user config 的个人设置，不会写入仓库。匹配项目的设置优先于同一 user config 中的全局值；团队共享的 hooks 和开发服务器 URL 仍放在 `.config/wt.toml`。

## Project 配置：生命周期 hooks

项目 hooks 放在 `.config/wt.toml`，并随仓库共享。hook 名称对应 Worktrunk 生命周期：

- `pre-switch`：切换前的阻塞步骤。
- `post-switch`：切换后的后台步骤。
- `pre-start`：新 worktree 创建时的阻塞初始化。
- `post-start`：新 worktree 创建后的后台任务，例如 dev server。
- `pre-commit`：Worktrunk commit、squash 或 merge commit 前的格式化、lint、类型检查。
- `post-commit`：提交后的通知或后台任务。
- `pre-merge`：rebase 后、合并到目标分支前的测试和验证。
- `post-merge`：合并完成后的部署或通知。
- `pre-remove`：删除 worktree 前的备份或清理。
- `post-remove`：删除后的服务停止和外部通知。

### 单条命令

```toml
pre-start = "npm ci"
pre-merge = "npm test"
```

### 同一阶段并发命令

同一个表中的键会并发运行。键名只是诊断和审批时的命令名称：

```toml
[post-start]
server = "wt step tether -- npm run dev -- --port {{ branch | hash_port }}"
watch = "wt step tether -- npm run watch"
```

### 按顺序运行的 pipeline

多个 `[[post-start]]` 等 hook 表块按出现顺序执行；每个块内的命令并发。前一步失败时，后续步骤不会开始：

```toml
[[post-start]]
install = "npm ci"

[[post-start]]
build = "npm run build"
server = "wt step tether -- npm run dev -- --port {{ branch | hash_port }}"
```

如果后续步骤必须等依赖安装完成，优先使用 `pre-start`；`post-start` 适合不阻塞 worktree 创建的开发服务器、watcher 和长任务。

### Hook 的执行目录

大多数 hook 在目标 worktree 根目录执行，但 `pre-switch` 可能运行在切换前的 source worktree，`post-remove` 发生时被删除的 worktree 已不存在。需要在“新 worktree 内”执行的初始化放进 `pre-start`，不要假设 `pre-switch` 已经位于新目录。

### 长驻进程与 tether

Worktrunk 的 `post-*` hook 在后台运行。Worktrunk `v0.76.0` 提供实验性的 `wt step tether`，可以把开发服务器或 watcher 的整个进程树绑定到当前 worktree；worktree 被移除时，Worktrunk 会终止这棵进程树。长驻的 `post-start` 命令优先写成：

```toml
[post-start]
server = "wt step tether -- npm run dev -- --port {{ branch | hash_port }}"
```

若命令包含 pipe、redirect、环境变量或 glob，用 `sh -c` 包起来：

```toml
[post-start]
server = "wt step tether -- sh -c 'PORT={{ branch | hash_port }} npm run dev | tee dev.log'"
```

`tether` 在当前版本标记为 experimental；初始化前先用 `wt step --help` 确认。若项目不能使用它，应为服务增加明确的 `pre-remove`/`post-remove` 清理方案，并在文档中说明手动停止方式。

## 模板变量与端口

Hooks 可以使用当前操作的上下文变量：

- active：`branch`、`worktree_path`、`worktree_name`、`commit`、`short_commit`、`upstream`。
- operation：`base`、`base_worktree_path`、`target`、`target_worktree_path`、`pr_number`、`pr_url`。
- repository：`repo`、`repo_path`、`owner`、`remote_repo`、`primary_worktree_path`、`default_branch`、`remote`、`remote_url`。
- execution：`cwd`、`hook_type`、`hook_name`、`args`。
- state：`vars.<key>`，读取 `wt config state vars` 保存的每分支变量。

常用 filters：

- `sanitize`：文件系统安全的分支名。
- `sanitize_db`：数据库安全标识符。
- `sanitize_hash`：变化后追加短 hash，降低碰撞风险。
- `hash`：三字符 base36 hash。
- `hash_port`：把输入稳定映射到 `10000`–`19999` 端口。
- `dirname`、`basename`：处理路径。
- `codename(n)`：生成确定性的友好名称。

例如，列表 URL 和 dev server 使用同一个分支端口：

```toml
[list]
url = "http://localhost:{{ branch | hash_port }}"

[post-start]
server = "wt step tether -- npm run dev -- --host 127.0.0.1 --port {{ branch | hash_port }}"
```

分支处于 detached HEAD 时，`branch` 可能未定义。需要兼容 detached worktree 的 hook 应使用条件模板或默认值：

```toml
[pre-start]
sync = "{% if branch %}printf 'starting {{ branch }}\\n'{% endif %}"
```

## 审批与安全边界

项目 hooks 是仓库提供的可执行命令，Worktrunk 会要求对项目命令进行原生审批。第一次遇到审批时，从仓库终端查看并保存审批：

```sh
wt config approvals add
```

然后重试 `/wtm`。WTM 在会触发 hooks 或 commit prompt fragment 的阶段重新检查审批；未批准命令或 stale approval 会在变更前停止。WTM 不替项目写 approvals，也不使用 Worktrunk 的绕过审批参数。

`/wtm ... -y` 只跳过 WTM 自己的确认窗口，不能跳过项目命令审批。审批按命令内容保存；修改 hook 命令后需要重新批准。

验证和诊断：

```sh
# 只预览展开后的命令
wt hook pre-start --dry-run
wt hook pre-merge --dry-run

# 查看 hook / background 输出
wt config state logs
```

项目配置中不要放 API key、密码、个人绝对路径或会把源码上传到外部服务的命令。需要个人行为时放在 user config；需要团队共享的 hook 才放在 `.config/wt.toml`。

## 可直接采用的项目案例

### Node.js / TypeScript

适用于仓库已有 `npm ci`、`npm run dev`、`npm test` 和可传入端口的开发服务器：

```toml
# .config/wt.toml
[pre-start]
deps = "npm ci"

[post-start]
server = "wt step tether -- npm run dev -- --host 127.0.0.1 --port {{ branch | hash_port }}"

[pre-merge]
test = "npm test"

[list]
url = "http://localhost:{{ branch | hash_port }}"
```

如果 `npm run dev` 不接受 `--port`，应根据 `package.json` 中实际脚本改写命令；不要凭经验添加不存在的参数。

### Python

适用于仓库已有 `uv sync`、pytest 和 uvicorn：

```toml
# .config/wt.toml
[pre-start]
deps = "uv sync"

[post-start]
server = "wt step tether -- uv run uvicorn app.main:app --host 127.0.0.1 --port {{ branch | hash_port }}"

[pre-merge]
test = "uv run pytest"

[list]
url = "http://localhost:{{ branch | hash_port }}"
```

将 `app.main:app` 替换为项目实际入口；若项目使用 `poetry`、`pdm` 或 Makefile，使用仓库已有的命令。

### Rust

适用于仓库已有 Cargo 工作流，且不需要 WTM 自动启动开发服务器：

```toml
# .config/wt.toml
[pre-start]
check = "cargo check"

[pre-merge]
test = "cargo test"
```

需要顺序构建时：

```toml
[[post-start]]
build = "cargo build"

[[post-start]]
serve = "wt step tether -- cargo run -- --port {{ branch | hash_port }}"
```

### 安装、构建、启动的顺序依赖

当 build 和 dev server 都必须等待依赖安装完成，可将阶段写成：

```toml
[[post-start]]
install = "npm ci"

[[post-start]]
build = "npm run build"
server = "wt step tether -- npm run dev -- --port {{ branch | hash_port }}"
```

如果安装失败时不应创建出“未准备好”的 worktree，把 `install` 放到 `[pre-start]`，让它成为阻塞初始化。

## WTM 中的实际使用

```text
/wtm init                         让当前 agent 按本文初始化 .config/wt.toml
/wtm feature/login                创建或复用 worktree，并准备 OMP /move
/wtm list                         查看当前仓库 worktrees
/wtm merge                       执行 Worktrunk merge pipeline
/wtm rm feature/login             删除 worktree，保留 branch
```

典型流程：

1. 在主仓库运行 `/wtm init`，让 agent 基于真实项目命令生成或整理 `.config/wt.toml`。
2. 通过 `wt config show` 检查最终配置，通过 `wt hook <type> --dry-run` 检查展开结果。
3. 使用 `wt config approvals add` 审批项目 hooks。
4. 运行 `/wtm <branch>` 创建或复用 worktree。
5. 在 TUI 中提交 WTM 准备好的 `/move`，进入新 worktree。
6. 开发完成后运行 `/wtm merge`；清理型 merge 会先准备安全落点和后续命令。

WTM 的 `/move` handoff 是 OMP session 迁移的一部分。创建 worktree 成功不等于当前 session 已经移动；必须提交生成的 `/move` 命令。

## 常见问题

- **找不到 `.config/wt.toml`**：用 `wt config create --project` 创建，并确认当前命令运行在目标 worktree。
- **hook 没执行**：检查 hook 名称、`wt hook <type> --dry-run` 输出和 `wt config approvals add` 的审批状态。
- **多个 worktree 端口冲突**：使用 `{{ branch | hash_port }}`，并让 `[list].url` 与启动命令使用同一表达式。
- **路径中的分支斜杠导致目录异常**：路径模板使用 `{{ branch | sanitize }}`，不要直接把原始 `{{ branch }}` 作为目录名。
- **`/wtm -y` 仍然要求审批**：这是预期行为；`-y` 只影响 WTM 确认，不是 Worktrunk project approval。
- **Worktrunk 版本不兼容**：查看 `wt --version`。WTM 的增强后端要求稳定 `v0.76.x`；不兼容时生命周期操作会使用原生 Git fallback，merge 需要安装兼容版本。
- **dev server 变成阻塞创建**：把长时间运行的命令放在 `[post-start]`，不要放在 `[pre-start]`。

## 官方参考

- [Worktrunk 配置](https://worktrunk.dev/config/)
- [Worktrunk hooks](https://worktrunk.dev/hook/)
- [Worktrunk 0.76.0 配置 API](https://docs.rs/worktrunk/0.76.0/worktrunk/config/index.html)
