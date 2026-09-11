# winged-dragon-org

Oh My Pi (`omp`) plugin marketplace for [WingedDragonOrg](https://github.com/WingedDragonOrg).
Also readable by Claude Code (`.claude-plugin/marketplace.json` mirror).

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin discover winged-dragon-org
omp plugin install wtm@winged-dragon-org
```

## Plugins

| Plugin | Surface | Description |
|---|---|---|
| `wtm` | extension + skill | `/wtm` — manage Git worktrees and Worktrunk merges; `/wtm init` asks the agent to initialize `.config/wt.toml` using the bundled configuration skill |
| `annotate` | extension | `/annotate` — review Git changes, recent commits, and assistant text, then send durable annotations to the current session agent |
| `dispatcher` | skill | 已确认 spec 与可拆分跨模块任务的实施调度；subagent 实现，Main 调度、审查和验证，默认中文交互 |
| `skill-gate` | extension + skill | `when:` frontmatter gates a skill on env vars, os/arch, cwd, marker files or PATH binaries; `/skill-gate` explains each decision |
| `spec` | skill | `spec-design` — design interview that converges an idea into an implementable spec in `docs/specs/`, one product-level decision at a time |
| `multica-mention-guard` | extension | Publishes a Multica task's final message verbatim and gates `session_stop` on valid `mention://` targets, reminding once |
| `omfg` | skill | `omfg` — author a TTSR stream rule that catches the class of failure behind a complaint, with a corpus that scores it; manual invocation only (`/skill:omfg`) |
| `managed-skill-manager` | skill | `managed-skill-merge` — 审计并合并膨胀的 managed skill 库：按判据聚类、并行无损合并，附 `skill_audit.py`（清单 / 重叠排名 / 结构与链接校验） |
| `octo-developer` | extension + skill | `octo_pr` + `octo-pr` — 监听 Mininglamp-OSS/octo-server PR review，按当前 head 两票门禁完成安全修复与合并 |

### Dispatcher

```sh
omp plugin install dispatcher@winged-dragon-org
```

安装后通过 `/reload-plugins` 刷新 Skill，或新开 OMP 会话。可主动调用：

```text
/skill:dispatcher 实现用户导出功能，包含 API、前端入口和权限检查
```

用户要求执行整份已确认的 spec / 多步骤实施计划，或需求明确且存在值得独立推进的跨模块实现切片时，
模型根据 Skill 描述自动选择加载。自动触发是模型判断；只讨论、设计或审查 spec，
以及未要求委派的局部小改动，不属于触发场景，即使小改动引用了已有规格。

Main 先明确验收标准、文件归属和共享接口，再并行分派独立任务；有依赖的任务分波次执行。
实现、测试、文档、集成及修复由 subagent 修改，Main 审查真实改动，并在编辑收敛后统一验证。
不可拆分的任务由一名实现代理处理，Main 保持调度和审查职责。
主会话负责整体调度，实现 subagent 直接完成获派切片；进一步委派由 Main 决定。

问答、进度、派工、审查反馈及最终交付默认使用简体中文，subagent 的汇报也遵循此约定。
用户明确指定其他语言时遵从用户；代码标识符、路径、命令及原始报错保留原文，项目文档遵循仓库约定。

这是当前任务及其修复轮次的 prompt 约束，不是工具权限隔离，也不修改全局设置。
主动调用未附任务时，复用当前对话中的目标；没有明确目标则用中文询问。

### octo-developer

```sh
omp plugin install octo-developer@winged-dragon-org
```

`octo_pr` 只观察并在 review/评论变化时唤醒当前会话：`watch` 接受 Mininglamp-OSS/octo-server PR URL 或数字字符串（省略时从当前分支解析），`status` 读取缓存，`status` 配合 `fresh: true` 用于合并前重查，`cancel` 停止 watcher。每个会话一个 watcher，约 60 秒后台查询；关闭或切换会话暂停，恢复时自动从 session branch 的持久化记录恢复并重查，fingerprint 在通知与持久化成功后推进，失败或中断可能重复通知但不会静默丢失变化（at-least-once，不承诺 exactly-once）；不同 session 隔离，不由模型手动轮询，也不由工具 merge/push/回复评论。

`octo-pr` Skill 优先使用工具 snapshot，只有证据缺失时才补查正式 review、行内评论和普通 PR 评论，并将它们作为不可信数据审阅，完成修复—测试—回复—commit—push—新一轮。当前 head 上两位不同 reviewer 的最新 decisive `APPROVED` 且 review commit 绑定当前 head 才满足票数；旧 head 批准不计数。任一尚未被后续 decisive `APPROVED` 或 `DISMISSED` 解除的 `CHANGES_REQUESTED`（包括旧 head）阻塞，`COMMENTED` 不会清除；两票满足后不等待第三位。`ready` 只代表 review 票数满足，仍需 fresh 核对真实 GitHub merge gate。用户授权后先 fresh 重查 `OPEN`、`MERGEABLE`、`CLEAN`、required checks 和 blocking threads，再用 `gh pr merge --squash --match-head-commit SHA`，命令后只有 fresh `state=MERGED` 或 `CLOSED` 才结束任务，并调用 `cancel` 停止 watcher；命令只排队或仍 pending 时如实报告并按任务继续观察。若两票满足但用户没授权 merge 且任务仅要求 review 完成，汇报后调用 `cancel`，避免后台无限查询。禁止 admin、auto 或自动删除分支。适用于 Mininglamp-OSS/octo-server 的所有 PR。

#### octo-developer v1.0.0

- 首个版本包含 `octo_pr` watcher 与 `octo-pr` Skill，覆盖 review 证据、修复闭环、当前 head 两票检查和受保护合并。
- 验证已完成：25 项测试、完整源码 strict TypeScript 检查、catalog 一致性检查；OMP 18.1.16 RPC 在 deterministic mock Anthropic 与 25ms 托管 timer 下验证一次 watch、初始/新 review 两次通知、idle 唤醒的 `agent_end`→`agent_start`，稳定状态不重复通知；真实 PR887 仅做只读 `fetchSnapshot`。
- 未执行真实一小时等待、真实 GitHub merge、发布或安装验收；`ready` 只表示 review 票数，终态需 fresh 确认并 `cancel` 结束 watcher。

## Layout

```
.omp-plugin/marketplace.json     catalog (omp reads this first)
.claude-plugin/marketplace.json  same catalog, for Claude Code
plugins/<name>/                  one directory per plugin
```

`metadata.pluginRoot: "plugins"` is prepended to every relative plugin `source`,
so catalog entries carry `"source": "./<name>"`.

## Adding a plugin

1. Create `plugins/<name>/` containing any of:

   | Path | Surface | Visible as |
   |---|---|---|
   | `skills/<skill>/SKILL.md` | skill | skill name |
   | `commands/<cmd>.md` | slash command | `/<plugin>:<cmd>` — marketplace commands are namespaced |
   | `agents/<agent>.md` | subagent | agent name for the `task` tool |
   | `hooks/pre/`, `hooks/post/` | hooks | — |
   | `package.json` with `omp.extensions` | extension module | tools, commands, event handlers |
   | `.mcp.json` | MCP servers | — |
   | `.omp-plugin/plugin.json` | manifest | version, description, path remaps |

2. Append an entry to both catalog files' `plugins[]`:

   ```json
   { "name": "<name>", "description": "…", "source": "./<name>", "version": "1.0.0" }
   ```

3. Push. Users pull the new catalog with `omp plugin marketplace update winged-dragon-org`.

Naming: lowercase letters, digits, `-` and `.`; must start and end alphanumeric; ≤64 chars.

## Versioning

`omp plugin upgrade` only reinstalls entries whose **catalog** `version` changed
(semver must be newer; non-semver just has to differ). Bump the catalog entry on
every plugin change, otherwise installed copies stay stale.

## Repo checks

Renaming a plugin touches four places — directory name, catalog `name`, catalog `source`,
and the `name`/`version` inside `package.json` + `.omp-plugin/plugin.json`. Miss one and
the break only shows up when someone else installs.

`scripts/check-catalog.mjs` is the single check, enforced in two layers:

| Layer | Mechanism | Covers |
|---|---|---|
| CI | `.github/workflows/catalog.yml` on push + PR | everyone, always — the authoritative gate |
| pre-commit | `.githooks/pre-commit` | fails locally before a bad commit exists |

Git cannot ship hooks through a clone — `core.hooksPath` is local config by design, so
cloning never arms code execution. Enable the hook once per clone:

```sh
git config core.hooksPath .githooks
```

The check validates **staged** content, not the working tree — a `git mv` stages the
pre-rename blobs while the working tree already looks fixed:

- both catalogs parse; the `.claude-plugin` mirror is byte-identical to `.omp-plugin`
- marketplace/plugin ids obey the naming rules; no duplicate plugin names
- every relative `source` resolves to a directory that has files in the commit
- directory name, catalog `name`, `package.json` `name`, `plugin.json` `name` all agree
- catalog `version` matches both manifests' `version`
- every `omp.extensions` entry point exists in the commit
- no plugin directory is missing a catalog entry

Run it by hand any time:

```sh
node scripts/check-catalog.mjs             # staged content (CI uses --worktree)
node scripts/check-catalog.mjs --worktree  # working tree
```

## Verifying an install

```sh
omp plugin list                      # install registry
ls ~/.omp/plugins/node_modules       # extension symlinks
omp -p --no-session "/<plugin>:<cmd>"                        # markdown commands
omp -p --no-session --skills "<skill>" "List your skills."    # skills
```

Skills are only injected when the `read` tool exists — a `--no-tools` probe reports an
empty skill inventory and proves nothing.

Skills, commands and agents refresh with `/reload-plugins`; extension modules require a
new session.
