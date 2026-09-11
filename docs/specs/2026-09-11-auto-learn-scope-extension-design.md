# OMP 兼容式 Auto-Learn 项目作用域扩展设计

日期：2026-09-11

## 背景与目标

OMP 18.1.16 已内置 experimental auto-learn。内置实现由三部分组成：

- `AutoLearnController` 在顶层 session 的 `agent_end` 后按工具调用数、abort、plan 和 goal 状态决定是否启动 capture；
- `learn` 将 durable lesson 写入当前 memory backend，并可创建或更新 managed skill；
- `manage_skill` 直接管理全局 managed skill。

内置 managed skill 的写入位置固定为 `~/.omp/agent/managed-skills/<name>/SKILL.md`。OMP 原生 project skill discovery 使用 `<repoRoot>/.omp/skills/<name>/SKILL.md`。

本设计增加一个兼容式 Extension：保留内置 controller、memory backend、hidden capture 和 global 行为，通过同名重注册包装 `learn` 与 `manage_skill`，为 skill 写入增加显式 global/project 作用域，并让 project skill 复用 OMP 已有的 project discovery。

成功标准：

- 原有 `learn` 和 `manage_skill` 调用在省略作用域时保持 native 行为；
- `scope: "project"` 可以把 skill 写入当前 repository 的 `.omp/skills`；
- `learn` 的 memory 部分始终由 native memory backend 完成；
- hidden auto-learn capture 可以使用 wrapper，且未指定作用域时仍写入 global managed skill；
- project 写入具有与 native managed writer 等价的路径、内容和文件安全边界；
- 扩展不要求修改 OMP 核心 skill loader，也不建立第二套 auto-learn 调度器。

## 范围

### 包含

- 一个 OMP Extension，对 `learn` 和 `manage_skill` 做同名重注册；
- 两个工具的可选 `scope: "global" | "project"` 参数；
- global 调用通过 `ctx.invokeTool` 委托同名 native 工具；
- project `manage_skill` 的 create、update、delete；
- project `learn` 的 memory 委托与 skill 写入；
- project skill 的安全写入、存在性检查和原子文件更新；
- Extension 的 auto-learn prompt guidance；
- auto-capture 对同名 wrapper 的兼容；
- 项目 skill 写入后的刷新和发现说明；
- 错误、partial outcome、路径安全和并发边界；
- Extension 的安装、加载和行为验证。

### 不包含

- 修改 OMP `AutoLearnController` 的触发条件、阈值、goal/plan/abort 排除、capture 并发或 pending 策略；
- 修改 capture prompt、capture model、memory backend 或 native retention 语义；
- 将 project skill 写入 native global managed-skill 目录；
- 增加新的 project managed provider 或修改核心 skill loader；
- hidden capture 的自动 project 路由；
- 模糊相似度合并、自动人工审批流程或自动 commit；
- 修改用户 authored skill、插件自带 skill 或其他 provider 的优先级规则；
- 对当前已构建的模型 prompt 执行回溯式 skill inventory 更新。

## 已知约束

- `autolearn.enabled` 默认关闭；`autolearn.autoContinue` 默认关闭；`autolearn.minToolCalls` 默认值为 5。
- `learn` 只有在 memory backend 为 `local`、`hindsight` 或 `mnemopi` 时才由 native registry 创建；`manage_skill` 只受 `autolearn.enabled` 控制。
- native managed skill provider 的目录是 `~/.omp/agent/managed-skills`，优先级低于 authored skills；同名 authored skill 会优先显示。
- native project skill loader 从当前目录及其祖先目录的 `.omp/skills` 扫描 project skills，并要求非空 description。
- `<repoRoot>/.omp/managed-skills` 没有 native project provider。`skills.customDirectories` 扫描结果会标记为 `custom:user`，不能提供本设计所需的 project scope 语义和稳定的 session-root 绑定。
- OMP SDK 会在 extension 替换 registry 前保存 native tool，并向同名工具提供 `ctx.invokeTool(params)`。该委托只允许调用注册工具对应的同名 native tool，并有递归深度保护。
- `before_agent_start` 可以修改 system prompt，但只提供模型指导；实际 scope 路由必须由工具 wrapper 强制执行。
- tool context 没有公开的 `refreshSkills()` 或 `reload()` 操作。`manage_skill` native 实现会刷新其自身的 skill 状态；project wrapper 不依赖私有 session API。
- OMP marketplace 插件只安装文件和 Extension 入口，不安装运行时 npm 依赖。Extension 必须使用 host 提供的 API、标准 Node/Bun 能力和已经存在的插件运行时约定。
- 该设计依赖公开 Extension API，不调用 OMP 私有 `src/autolearn` writer、私有 session mutation 或内置 TUI 对象。

## 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 扩展边界 | 兼容增强 | 保留内置 controller 和 native memory，降低升级漂移与行为变化 |
| 工具扩展方式 | `learn` / `manage_skill` 同名重注册 | OMP SDK 已提供同名 native 委托，模型继续使用原工具名 |
| global 委托 | `ctx.invokeTool`，去除 wrapper-only 的 `scope` | 保持 native schema 之外的执行、approval、memory 和错误语义 |
| 默认作用域 | `global` | 现有调用和 hidden capture 不改变写入位置 |
| project 目录 | `<repoRoot>/.omp/skills/<name>/SKILL.md` | 复用 native project discovery，不增加 provider |
| `learn` 的 memory | 始终委托 native backend | 避免复制 memory backend 或改变 durable memory 的数据语义 |
| project 写入触发 | 仅显式 `scope: "project"` | 防止后台 hidden capture 静默修改仓库 |
| 重复处理 | 保留 action 的确定性存在性语义 | 避免相似度误判、隐式合并和额外模型成本 |
| provider 身份 | project 输出作为普通 project skill | 文件可被用户审阅、编辑和提交，加载路径与 authored project skills 一致 |
| skill 刷新 | 依赖后续 turn、刷新或新 session | 公共 tool context 没有稳定的即时 reload API |

## 设计

### 1. 工具注册与激活

Extension 注册两个与 native 工具同名的 tool definition。SDK 在构建 session 时先创建并保存 native tool，再将 extension tool 放入有效 registry；同名 extension tool 成为模型实际调用的实现。

wrapper 必须：

- 保留 native 工具的 essential/load、strict、approval 和可观察描述语义；
- 在 schema 中增加可选 `scope`；
- 标记为 default-inactive，避免 native tool 不存在时扩展工具泄漏到普通 session；
- 执行时再次确认 native 能力和 `autolearn.enabled` 边界；
- native tool 不可用时 fail closed，不自行构造 global memory 或 managed skill 替代路径。

`scope` 的缺省值为 `global`。wrapper-only 字段在委托前必须移除，不能传入 native schema。

### 2. `learn` 路由

`learn` 的 native 参数保持不变：

- `memory`；
- 可选 `context`；
- 可选 `skill`，包括 `action`、`name`、`description`、`body`。

#### Global

未传 `scope` 或传入 `scope: "global"` 时：

1. 移除 `scope`；
2. 通过 `ctx.invokeTool` 调用 native `learn`；
3. 原样返回 native result。

该路径不增加自定义 memory 写入、不改变 native skill 路径，也不重复执行 approval 或副作用。

#### Project

传入 `scope: "project"` 且包含 `skill` 时：

1. 校验当前 session 能调用 native `learn`；
2. 从参数中移除 `skill`，通过 `ctx.invokeTool` 保存 memory；
3. memory 成功后，把 skill 写入 `<repoRoot>/.omp/skills/<name>/SKILL.md`；
4. 返回 memory 与 project skill 的组合结果。

`scope` 只作用于 skill。`memory` 仍使用当前 native backend 的既有 scope、metadata、importance 和 retention 行为。

当 `scope: "project"` 没有 `skill` 时，调用按 native memory-only `learn` 执行；不会伪造 project memory。

native memory 失败时不写 project skill。memory 已成功但 project skill 写入失败时，保留 memory 结果，并返回明确的 partial outcome、目标路径和失败原因。

如果 native `learn` 不存在，即使请求携带 project skill，也返回可操作错误并建议使用 `manage_skill(scope: "project")`；不能绕过 native memory gate。

### 3. `manage_skill` 路由

native 参数保持：

- `action: "create" | "update" | "delete"`；
- `name`；
- create/update 所需的 `description` 和 `body`。

#### Global

未传 `scope` 或传入 `scope: "global"` 时：

1. 移除 `scope`；
2. 通过 `ctx.invokeTool` 调用 native `manage_skill`；
3. 原样返回 native result。

#### Project

传入 `scope: "project"` 时，直接操作当前 repository 的：

```text
<repoRoot>/.omp/skills/<safe-name>/SKILL.md
```

- `create`：目标文件不存在时创建；目标已存在时失败；
- `update`：目标文件存在且为合法普通文件时覆盖；不存在时失败；
- `delete`：删除目标 skill 目录；不存在时失败。

project skill 的 frontmatter 只生成标准的 `name` 和 `description`，`body` 不包含 frontmatter。写入结果不得使用 global managed provider 的路径或标识。

### 4. Project writer 安全边界

project writer 的行为与 native managed writer 对齐：

- 名称 trim 后转为小写，只允许 `[a-z0-9][a-z0-9-]{0,63}`；
- 从 `ctx.cwd` 解析真实 repository root；无法解析时拒绝写入；
- 目标必须位于该 root 下的 `.omp/skills/<name>/SKILL.md`；
- `.omp`、`skills`、skill 目录和目标文件的符号链接逃逸必须被拒绝；
- description 和 body 必须非空；
- description 中的控制/格式字符、尖括号、反引号和 fence 必须经过 prompt-safe 清理；
- 最终 UTF-8 文件不得超过 64 KB；
- create 使用排他创建，避免 check-then-write 竞态；
- update 只允许覆盖普通文件，拒绝可能共享 inode 的硬链接，并通过同目录临时文件与原子替换写回；替换前后都必须重新确认目标仍属于安全路径；
- delete 不跟随符号链接递归删除；
- 同一进程内同名 mutation 按提交顺序串行化；
- 不自动修改其他 skill、不自动 commit、不自动 push。

跨进程并发不扩展 native writer 的一致性承诺；原子 create 和文件类型检查仍必须成立。

### 5. Prompt guidance

Extension 通过 `before_agent_start` 追加简短 guidance：

- `scope` 缺省为 global；
- durable fact 或 convention 仍使用 native memory；
- 可复用流程才创建或更新 skill；
- 只有明确需要保存到当前 repository 时才使用 `scope: "project"`；
- 创建前优先判断是否已有对应 skill；
- 不把 secrets、tokens 或不可复用的一次性细节写入 skill。

guidance 不改变 native auto-learn controller，也不作为安全边界。工具执行时的 wrapper 路由和 writer 校验才是强制边界。

### 6. Hidden auto-capture

内置 `AutoLearnController` 保持启用方式和触发条件不变。当前 SDK 的 capture tools 从 extension 替换后的最终 tool registry 选择，因此 hidden capture 中的 `learn` 和 `manage_skill` 会进入同名 wrapper。

capture prompt 没有显式 scope 时：

- `learn` 走 global；
- `manage_skill` 走 global；
- 不写入项目目录。

本设计不把后台 capture 自动改成 project scope，也不通过 prompt 推断 repository 级默认写入。

### 7. Skill discovery 与刷新

project 文件使用 native project skill loader：

```text
<repoRoot>/.omp/skills/<name>/SKILL.md
```

它进入普通 project skill inventory，不使用 `omp-managed` provider，也不需要新增 discovery provider。

写入发生在一个已经构建的模型回合内时，当前回合的 `<skills>` inventory 不回溯更新。后续 turn 在系统 prompt 刷新后，或新 session / `/reload-plugins` 后，native loader 会重新发现该文件。

如果项目中存在更近路径或更高优先级的同名 authored skill，结果遵循 native discovery 的 first-wins 规则；wrapper 不强制覆盖其他 provider。

### 8. Extension 安装边界

Extension 作为 marketplace 插件发布，包含：

- Extension 入口；
- 与 OMP host API 兼容的 tool schema；
- project writer 与安全校验；
- 行为验证用例；
- 使用说明。

插件的 global/project wrapper 只拥有当前 session 的 `ctx.cwd`、`ctx.invokeTool` 和公开 Extension API，不读取或写入 OMP 私有 controller 状态。

## 错误与边界情况

- `autolearn.enabled=false`：wrapper 不成为 active writable tool；显式绕过时也拒绝执行。
- native `learn` 不存在：global/project `learn` 均拒绝，不能自行写入 memory 或 skill。
- native `manage_skill` 不存在：global `manage_skill` 拒绝；project `manage_skill` 也遵守同一 master gate。
- `scope` 不是 `global` 或 `project`：schema 校验失败，不产生写入。
- global 委托失败：保留 native 错误和结果语义。
- project 缺少 repository root：拒绝，不退回当前工作目录或 home 目录。
- 名称非法、description/body 为空或最终文件超限：拒绝，不创建目标文件。
- project create 已存在：失败并提示使用 update。
- project update/delete 不存在：失败并提示对应 action。
- project 目标路径任一中间目录为符号链接，或目标为符号链接/不安全硬链接：拒绝。
- `learn(scope=project)` memory 失败：不写 skill。
- `learn(scope=project)` memory 成功但 skill 写入失败：memory 保留，返回 partial outcome，不能报告完整成功。
- 项目文件在写入后未立即进入当前 prompt：保持文件和结果，等待后续刷新；不重复写入或伪造当前 inventory。
- 多个 wrapper 调用同时修改同名 project skill：按进程内提交顺序执行；不同名称可以并行。
- auto-capture 未指定 scope：只走 global，不产生后台 repository change。
- project skill 与其他 provider 同名：遵循 native discovery 优先级，不通过 wrapper 强行覆盖。
- `.omp/managed-skills` 中的文件：不作为本设计的 project skill 入口，也不向用户报告为 native project managed skill。

## 验收标准

1. 在 `autolearn.enabled=false` 时，OMP 不向模型暴露可执行的 wrapper 写入能力；显式调用也 fail closed。
2. 在 native `learn` 和 `manage_skill` 均可用时，未传 `scope` 的调用结果、路径、memory、approval 和错误与 native 调用一致。
3. `scope: "global"` 去除 wrapper 字段后只调用同名 native 工具，不发生递归或重复 memory 写入。
4. `manage_skill(scope="project", action="create")` 在 repository root 下创建标准 `.omp/skills/<name>/SKILL.md`，不创建 global managed skill。
5. `manage_skill(scope="project", action="update")` 只更新已存在的目标文件；缺失目标返回错误。
6. `manage_skill(scope="project", action="delete")` 只删除目标 project skill 目录；缺失目标返回错误。
7. `learn(scope="project")` 保存 memory 一次，并把可选 skill 写入 project `.omp/skills`。
8. `learn(scope="project")` 在 memory 失败时不创建 skill；在 skill 写入失败时返回 partial outcome。
9. project skill 的 frontmatter、description、body 和 UTF-8 大小满足 writer 安全约束。
10. 非法名称、路径穿越、符号链接、硬链接、空内容和超限内容都不会导致目标外写入。
11. hidden auto-capture 使用同名 wrapper；未指定 scope 时仍只写 global managed skill。
12. 写入的 project skill 在后续 refresh、新 session 或 `/reload-plugins` 后进入 native project skill inventory。
13. 当前回合中刚创建的 project skill 不会被错误宣称为已经存在于该回合的 `<skills>` inventory。
14. project skill 与 native authored skill 的同名冲突遵循既有 discovery 优先级，wrapper 不越权覆盖。
15. marketplace 插件能被 OMP 加载，且其 wrapper 不依赖 OMP 私有模块或运行时 npm 依赖。

## 未决事项

无。
