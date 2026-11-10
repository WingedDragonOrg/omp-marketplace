# Managed Skill 分组与渐进加载设计

日期：2026-11-09

## 用户原始需求

1. “现在的 oh my pi auto learn 管理效率太低了，managed_skills 也太多了，而且还不支持分组，动态载入等等，有办法通过 extension 或者什么方式解决吗？”
2. “不应该是这个思路，是否应该是  @~/.omp/agent/managed-skills 中支持目录，目录作为分组，而目录本身实际上就是一个 skill, SKILL.md 固定为目录中每个 skill 的 skill_name + description，agent 通过渐进式加载来 展开 skill 相关内容，以此组织、减少上下文占用”
3. “现在的 @plugins/auto-learn-scope/ 不是就覆盖了内置 tool 吗？需要完成哪些改造来支持当前设计？”
4. “支持 group 参数，有则复用，没有则自动创建新组，组 SKILL.md 由工具每次使用到时自动生成，不依赖 agent 管理”
5. “ok”（确认 global Skill 操作显式指定 `group`，只有 memory 的 `learn` 不需要 `group`）。
6. “迁移不考虑， 这个我手动迁移(创建目录并把 skill 直接挪进去， 组SKILL.md 会在后续使用到时自动生成/维护)”
7. “ok”（确认会话加载或刷新时为缺少索引的组生成 `SKILL.md`，使用组和工具写入时维护索引；组 description 自动生成）。

## 目标和范围

扩展 `plugins/auto-learn-scope/`，使全局 managed Skill 以组 Skill → 子 Skill 目录 → 子 Skill 正文三级渐进读取。初始模型清单展示组的名称和简短 description，读取组才获得该组子 Skill 的名称、description 和读取路径，读取子 Skill 才获得正文。

组和子 Skill 存放在 OMP 原有 managed-skills 目录。用户负责移动已有 Skill；本设计不执行迁移、不改写旧引用、不自动整理或合并 Skill。现存平铺 Skill 继续按原有发现机制工作。原有 project scope 不改布局或调用语义。

## 当前事实与约束

- `auto-learn-scope` 已同名注册 `learn` 和 `manage_skill`。global 当前委托原生同名工具；project Skill 由插件写入，memory 委托 native `learn`。
- 当前 OMP 18.18.3 源码中的 managed provider 只扫描根目录下一层的 `SKILL.md`；`skill://<组>/<相对路径>` 可读取组内文件。两者是版本相关约束，不承诺其他版本相同。
- 隔离探针使用 OMP 18.18.3：extension factory 创建顶层组 `SKILL.md` 后，`session_start` 的 active skills 包含该组而不包含子 Skill；独立 `omp read` 成功读取 `skill://probe-group/probe-child/SKILL.md`。探针未验证所有插件并发、符号链接或现有交叉引用。
- 部分现有 managed Skill 是由外部工具管理的符号链接；目录扫描和读取不得修改链接目标或链接管理清单。旧 `skill://子名称` 在子 Skill 移入组后不保证可解析，用户手动迁移时负责相关引用。
- 本设计改变已有 auto-learn-scope 规格的 global Skill 写入契约：group 必填，插件写组内 Skill；原有 project scope 和 memory 委托契约不变。

## 布局和索引

```text
managed-skills/
  postgresql/
    SKILL.md
    postgresql-readonly-space-audit/
      SKILL.md
```

- 组目录的 `SKILL.md` 是生成产物，有标准 `name` 和 `description` frontmatter；正文按子 Skill 名称稳定排序，每项包含原始名称、description 和 `skill://<组>/<子目录>/SKILL.md` 路径。
- 子 Skill 的 frontmatter 是其名称和 description 的唯一来源；正文及其他文件保持不变。组 description 按确定性规则由组名和按名称排序的成员 description 拼接，截取至 200 个 Unicode 字符，不能将全部成员列表作为初始清单。该摘要不依赖 agent 手工管理或额外在线模型调用；它可能丢失靠后的触发词，必须用验收中的召回探针量化。组索引正文保留全部成员的完整 description。
- 按命名规范校验组名与子 Skill 名称、拒绝路径穿越；组目录名与组 Skill 名一致。每次操作按子 Skill frontmatter 建立名称到实际目录的映射，更新和删除使用映射而不是假定目录同名；创建时名称和目标目录均不能冲突。组内出现重复名称时停止并报告冲突，不修改成员；不同组可以使用相同子 Skill 名，引用以组和实际子目录限定。
- 不存在顶层 `SKILL.md` 且包含直接子目录 `SKILL.md` 的目录视为新组；生成的组索引含固定的工具标记，已有此标记的目录即使为空组仍识别为组。组内其他文件不进入索引。
- 顶层组目录或组索引文件是符号链接时，不创建或替换索引，明确报告冲突，不改链接目标。已存在但不带工具标记的顶层 `SKILL.md` 是用户数据，不能被覆盖或自动转换，即使它有子目录；目标组冲突时明确失败。组内目录如为符号链接，仅用于读取与索引，不通过自动写入覆盖链接目标；写入冲突明确报告。
- 索引重建只修改组 `SKILL.md`，不改变子 Skill 或其他文件。安全地原子替换索引；工具写入、启动扫描和读取前重建等所有组变更入口跨进程按组互斥，锁内重新扫描成员后更新索引。锁内失败必须可见并释放协调资源。手动或外部修改不受此锁约束；下一次读取或刷新重新扫描修复索引，不承诺并发手工修改在当前次索引中立即可见。

## 发现与刷新

- 扩展初始化阶段在 OMP 初次发现之前扫描 managed 根目录，为新识别的组创建索引，并刷新已有组索引，使会话启动时能发现手工创建的组。不得依赖 `session_start` 后的自动重新发现来实现首次发现。
- `read` 使用已发现组的 `skill://<组>` 读取索引前，重新生成对应组索引；当通过组内路径读取子 Skill 时，按同一规则先刷新所属组。不得重写普通 Skill。无法重建时应报告失败而不是返回误导性的旧索引。
- 会话运行中用户新建或移动的组，使用插件刷新命令或开启新会话后进入顶层清单；刷新必须先生成索引再让 OMP 重新发现。已有组索引的内容在下次读取时更新；顶层 description 在重新发现之后更新。
- 索引重建应比较生成内容，仅内容变化时写入，避免每次读取无意义改变文件时间。不能通过组内文件内容执行命令。

## `learn` 与 `manage_skill` 契约

- `learn.skill.group`、`manage_skill.group` 是 global Skill 操作必填的合法单段组名；省略或不合法时明确报错，不回退到平铺路径。仅 memory 的 `learn` 不要求 group。project scope 的旧参数和行为保持不变。
- 对 global `learn`，先用去掉 `skill`、`scope` 和插件专用字段的参数委托 native `learn` 保存 memory；memory 失败不写 Skill。memory 成功后创建或更新组内 Skill 并更新组索引。后续失败时报告 memory 已成功、Skill 与索引各自的结果和路径，不伪报整体成功。
- 对 global `manage_skill`，插件执行组内 create/update/delete 和索引更新，保留原有动作的存在性语义、启用条件、审批等级和清晰错误。组不存在则创建；同名非组 Skill 冲突时停止。删除最后一个成员后的组索引仍可存在，供后续复用。
- 不改变 native memory backend、auto-learn controller、触发阈值和 native hidden capture；更新工具 schema、描述及引导，使后台 capture 能提供 group。必须用真实 OMP 验证 hidden capture 实际调用该 wrapper，不能只以注册成功为证。
- 结果按提交点区分：确认未写入、已写入但索引待重建、以及无法确认是否已写入；不得把提交后的检查失败报告为肯定未写入。返回 memory、Skill 和索引各自状态及路径。索引失败或状态不明时，后续刷新或读取重新扫描并重建；不得静默回滚 memory。

## 验收标准

1. 手工建立一个没有组 `SKILL.md` 的组并放入两个子 Skill，启动隔离 OMP 会话后组自动出现；初始清单只包含组条目，不包含子 Skill 条目。读取组后能看到两者完整名称、description 和路径，再能读取对应正文。（需求 1、2、6、7）
2. 手动修改、新增、移走子 Skill 后，下一次读取组反映变化；运行中新增组在刷新后出现；已有平铺 Skill 的内容不变。（需求 2、6、7）
3. 两个工具按显式 group 在现有组内写入或创建新组，缺失 group 明确报错；纯 memory 与 project 路径保持原契约；创建、更新、删除和索引内容一致。（需求 3–5、7）
4. 使用真实 OMP hidden capture 验证 wrapper、group 参数和 memory 委托；模拟 memory、Skill 和索引失败，检查可见部分成功结果与后续重建。（需求 3–5）
5. 使用顶层链接、索引文件链接、符号链接成员和同名冲突检验不改变链接目标、不覆盖普通顶层 Skill；跨进程并发修改同组成员后索引包含全部已成功写入成员。测试名称与目录不一致及重复名称的处理，并在提交前后注入故障验证未写入、已写入和状态不明结果。（需求 4、6、7）
6. 比较迁移前后实际 provider 请求中的 managed Skill 清单大小，并用代表性任务检查组 description 能引导读取正确组；记录测量和未命中情况，不把目录数减少当作召回质量证明。（需求 1、2）

## 实施前提

上述启动与嵌套读取路径已有 18.18.3 隔离探针；运行时刷新、组路径读取前拦截、hidden capture 参数以及符号链接行为需在实现时进一步验证。若某一能力在目标版本不可实现，不得静默降低上述行为承诺，须先回到设计确认。
