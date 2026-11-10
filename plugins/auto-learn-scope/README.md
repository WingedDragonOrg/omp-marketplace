# auto-learn-scope

`auto-learn-scope` 为 OMP experimental auto-learn 提供分组 managed skill 和项目作用域。
全局分组按需展开，`learn` 的 memory 仍由 OMP 原生 backend 保存。

## 安装

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install auto-learn-scope@winged-dragon-org
```

Extension module 在创建 session 时加载；安装后请重启 `omp` 或开启新 session。
插件没有运行时 npm 依赖。

## 使用前提

Skill 写入需要在 OMP 配置中将 `autolearn.enabled` 设为 `true`（默认关闭）；关闭时
`learn` / `manage_skill` 不执行写入。组索引维护随 Skill 发现运行，与此开关独立。
`learn` 的 memory 由 OMP 原生 memory backend 提供。

## 作用域

`learn` 和 `manage_skill` 使用原来的工具名，并支持 `scope`：

- **默认 `global`**：Skill 操作必须指定 `group`，支持 `/` 分隔的多层组路径。目标是
  `<agentDir>/managed-skills/<group>/<name>/SKILL.md`；创建 Skill 时复用已有组并逐级创建缺失的组。
  `learn` 中的 `group` 位于 `skill` 对象内；`manage_skill` 的 `group` 位于顶层。
- **显式 `project`**：写入 `<repoRoot>/.omp/skills/<name>/SKILL.md`，不要求 `group`。

两个作用域的 `learn` 都先委托 native `learn` 保存 memory，再写入可选 Skill；
仅保存 memory 时不需要 `group`。`manage_skill` 支持 `create`、`update` 和 `delete`。
memory 已保存而 Skill 或组索引写入失败时，结果分别报告各部分状态和路径；`indexes` 按目标组到顶层组列出每级索引的提交状态和是否需要重建。

全局分组示例，以下是传给 `manage_skill` 的参数：

```json
{
  "action": "create",
  "group": "engineering/database/postgresql",
  "name": "space-audit",
  "description": "排查 PostgreSQL 磁盘占用",
  "body": "1. 检查数据库和表的磁盘占用。"
}
```

对应的 `learn` 写法是在 `skill` 对象中添加 `"group": "engineering/database/postgresql"`。

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

## 分组与发现

每级分组的 `SKILL.md` 由插件生成，列出直接子组和直属 Skill 的名称、description 和读取路径。
模型初始只看到顶层组的名称和简短 description，随后按索引逐层读取，最后读取 Skill 正文。
成员 frontmatter 使用 OMP 的解析器；无法解析的内容会报错，生成索引时不修改成员文件。
组 description 由宿主配置的小型模型生成，最多 200 个 Unicode 字符；索引正文保留
各成员的完整 description。生成和 judge 只接收组名、现有摘要及直接成员的名称和
description；使用远程模型时，这些信息会发送给模型服务。

新增 Skill 或通过工具修改成员的 `description` 后，插件会自动检查所属组和祖先组的摘要；
judge 高置信度确认已有模型摘要覆盖当前成员时保留原摘要，否则重新生成。只修改正文或
删除成员不自动调用模型。外部直接编辑的文件在读取或刷新时更新索引；需要重新检查摘要时
运行 `/refresh-managed-skills`。模型任务在后台运行；结果会区分 Skill/索引写入与摘要待检查，
模型失败时保留上次成功的摘要并报告。

用户可手动创建组目录并将 Skill 目录移入。执行 `/refresh-managed-skills` 扫描
并检查所有组；`/refresh-managed-skills --force` 跳过 judge 并强制重建全部摘要。
刷新不会重载 OMP 插件；当前会话已发现组可按需读取最新索引，顶层摘要和运行中新建
的顶层组在新会话发现时生效。
已有平铺 Skill 保持原状。移动后旧的 `skill://<name>` 引用需要由用户自行更新为
`skill://<顶层组>/<相对路径>/SKILL.md`。

组路径的每段及成员名称采用小写字母、数字和连字符；普通 Skill、组目录链接和共享硬链接
不会被插件覆盖。直属 Skill 目录符号链接可供读取和索引，插件不会通过链接修改其目标。
managed 根目录可以是指向目录的符号链接；插件在会话启动时解析并固定其目标。
同名 authored Skill 的优先级高于 managed 分组，创建新组时须避免名称冲突。
同一顶层组下的索引更新跨进程串行，其他顶层组可并行；OMP 命名空间遮蔽组内路径时，读取受影响索引会报告冲突。
插件通过宿主注册表核对调用会话的 Skill 清单；自定义 SDK 注册表或远程会话若未暴露
本地会话快照，无法确认的 managed 读取和新组创建会报错，不会使用其他会话的清单代替。

project skill 继续使用 OMP 原生 project discovery；写入后通过 `/reload-plugins` 或新会话
重新发现。两类 Skill 的发现均受 OMP 宿主版本与配置影响。

## 验收记录

在 OMP 18.18.3 的隔离会话中，以数据库和网络各两个示例 Skill 比较真实 provider 请求。
保留相同的其他 Skill 时，初始 Skill 清单从 6,274 降至 6,140 字节；`omp toks` 的
o200k 计数从 1,509 降至 1,478，Claude v5 计数从 2,399 降至 2,339。

使用生成的组 description 和当前默认模型选择分组：PostgreSQL 锁等待、PostgreSQL
catalog 膨胀均命中 database；macOS DNS 缓存、Tailscale 路由均命中 network，4 次
中 0 次未命中。该样本不能代表更大分组或真实 Skill 库的召回率。

OMP 18.18.6 隔离验收中，将五个不同主题的示例 Skill 放入同一个组，实际 provider 请求的
Skill 清单从 598 字节、224 个 Claude V5 Sonnet token 降至 114 字节、36 个 token。
该请求中的组摘要只保留了 incident postmortem 相关内容。以实际摘要和当前默认模型测试五项
代表性任务，incident postmortem 命中；Kubernetes、PostgreSQL、Python CSV 和发布签名
四项未命中。该结果来自合成样本，说明大型混合主题组的摘要可能无法召回靠后的成员；
应按主题拆分组，实际召回仍取决于宿主摘要和模型。

模型摘要的离线对照使用 18 个真实分组的名称和 description 快照、12 个独立正例及
6 个近似负例。用 eval 的 `smol` 模型按插件提示生成摘要，并模拟 OMP 18.18.6 的
初始 description preview；生成超过 200 字符的两组沿用原摘要。在仅让默认模型选择
组的模拟中，原摘要命中 5/12，新摘要命中 12/12；两者均正确排除 6/6 负例。这不是
真实 OMP 的端到端命中率，样本不足以保证泛化。

另用 `judge_batch` 对 12 个合成覆盖判断进行探针，实际后端报告为 `openai/gpt-6-luna`：
6 个不充分摘要中有 2 个获得至少 0.95 的“已覆盖”概率。该探针不证明原生 SystemOne
后端的表现；即使使用阈值，预过滤仍可能误跳过，`--force` 可用于强制复核。

一次真实宿主调用的合成样本中，`@smol` 生成耗时 3.68 秒、SDK 估算成本
$0.0000241；`openai-decisions` judge 耗时 0.72 秒、估算成本 $0.0000275，
覆盖概率为 0.19，因而需要继续生成。该样本的预过滤加生成合计约 4.40 秒、
$0.0000516；这是单次调用和 SDK 估算，不代表实际账单或长期平均。

OMP 18.18.6 的隔离真实宿主探针使用本地模拟模型服务：五个相同合成 Skill 的真实
provider 清单由平铺的 447 字节、89 个 o200k token 降为分组后的 103 字节、22 个
o200k token。五次真实 `read` 触发 native hidden capture 后，`learn` wrapper 委托
memory 落盘、创建三层组内 Skill，并生成祖先摘要；模型摘要请求未包含成员正文。
