# auto-learn-scope

`auto-learn-scope` 是 OMP experimental auto-learn 的兼容式 Extension。它保留原生
`learn`、`manage_skill`、memory backend 和 hidden auto-capture 行为，只为 skill 写入增加显式的
`global` / `project` 作用域。

## 安装

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install auto-learn-scope@winged-dragon-org
```

Extension module 在创建 session 时加载；安装后请重启 `omp` 或开启新 session。
插件没有运行时 npm 依赖。

## 使用前提

请先在 OMP 配置中将 `autolearn.enabled` 设为 `true`（默认关闭）。未启用时，Extension
不会提供可执行的写入能力，显式调用也会 fail closed。`learn` 的 memory 仍必须由 OMP
原生 memory backend 提供；本插件不会自行实现或替代 memory 存储。

## 作用域

`learn` 和 `manage_skill` 仍使用原来的工具名，并新增可选的 `scope`：

- **默认 `global`**：省略 `scope` 或明确传入 `"global"` 时，wrapper 移除这个扩展字段，
  只委托同名 native tool。原生 global managed skill 路径和结果语义保持不变；hidden
  auto-capture 未指定作用域时也仍然写入 global。
- **显式 `project`**：只有传入 `"project"` 才会写当前 repository。目标固定为
  `<repoRoot>/.omp/skills/<name>/SKILL.md`，使用普通 project skill 的标准 `name`、
  `description` frontmatter 和正文。

`manage_skill(scope="project")` 支持 `create`、`update`、`delete`，按目标是否存在执行确定性
操作，不会写入 global managed-skill 目录。`learn(scope="project")` 始终先把 memory
委托给 native `learn`；有可选 `skill` 时，memory 成功后再写入 project skill，没有 `skill`
时则只是 native memory-only learn。memory 失败不会创建 skill；skill 写入失败会明确报告
partial/error，而不会把整个操作报告为成功。

最小的 project skill 示例：

```json
{
  "scope": "project",
  "action": "create",
  "name": "release-check",
  "description": "发布前检查流程",
  "body": "1. 运行检查。\n2. 确认结果。"
}
```

这是传给 `manage_skill` 的参数。需要同时保存 memory 和流程时，可在 `learn` 中附带
`skill`：

```json
{
  "scope": "project",
  "memory": "本项目发布前要先完成检查。",
  "skill": {
    "action": "create",
    "name": "release-check",
    "description": "发布前检查流程",
    "body": "1. 运行检查。"
  }
}
```

名称、路径、符号链接、硬链接、空内容和文件大小等 project writer 安全边界会在写入时
校验；project skill 不会自动 commit 或 push。

## 发现与刷新

project skill 使用 OMP 原生 project skill discovery，不建立第二套 loader。文件在当前回合
写入后，不会回溯修改已经构建的 `<skills>` inventory；在后续 turn 的 system prompt 刷新、
执行 `/reload-plugins`，或开启新 session 后，native loader 会从
`<repoRoot>/.omp/skills/<name>/SKILL.md` 重新发现它。同名 skill 仍遵循 OMP 原有的 discovery
优先级。
