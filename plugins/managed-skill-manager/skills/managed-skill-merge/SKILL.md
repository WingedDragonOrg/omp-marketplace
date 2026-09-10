---
name: managed-skill-merge
description: 审计并合并膨胀的 managed skill 库（~/.omp/agent/managed-skills 或项目级 managed 目录）。当用户说 skill 太多了、有没有重复、合并/整理一下技能库、consolidate my skills、问某几个 skill 是不是同一件事，或 auto-learn 把同一次调查写成了好几份时，使用本 skill：按判据聚类、用并行 subagent 做无损合并、再用结构校验与真实加载探针验收。不要用于新建单个 skill、调单个 skill 的触发率，也不要用它改写用户手写或插件自带的只读 skill。
---

# 合并 managed skill 库

auto-learn 每次会话都可能新铸一个 skill，于是同一次调查被写成 2-4 份：中文一份英文一份、泛化一份产品具体一份、诊断一份修复一份。成员真的是同一套流程时合并是净收益；只是恰好共用产品名的不同判据，合并会毁掉两者。

## 0. 可写边界

只有 managed skills 可以改写和删除（`~/.omp/agent/managed-skills`，或项目内的 managed 目录）。`~/.agents/skills`、`~/.omp/agent/skills` 与插件 cache 下的 skill 属于用户和插件，**只报告候选，不编辑不删除**。

删除是合并的一部分，不是收尾工作：同名两份会按 provider 优先级互相遮蔽，留着就等于制造分叉。

## 1. 先出清单和重叠排名，不要凭记忆

```bash
python3 scripts/skill_audit.py inventory <skills-dir>
python3 scripts/skill_audit.py overlap   <skills-dir> --top 25
```

`inventory` 给出每个 skill 的 description 长度、字节数、字符数与多余文件；`overlap` 用正文与 description 的 token Jaccard 排出最可疑的成对候选，能捞到名字看不出来的重叠（例如两个不同产品前缀、其实是同一套三层计时定位）。

排名只是线索。**候选成员的正文必须读过**再定案。名字相似而判据不同的不该合（见 §2）。

## 2. 聚类判据：同一问题 + 同一证据源 + 同一组修法

该合的典型形态：

- 同一次运行的中文版与英文版；
- 泛化蒸馏版 + 它的产品具体来源（若泛化版确实可移植，就按**层**拆分，而不是按产品）；
- 一个循环里的诊断 / 取证 / 修复切换三段。

该分开的：判据不同，即使技术栈与关键词重叠。例如「客户端实际发出了什么」与「谁回答了这次请求」都是网关探针；「写一个扩展」与「严格 typecheck 一个孤立 .ts」都是扩展工程。这类写进汇报让用户决定，不要自行合掉。

簇也可以是**重新分配**：4 个成员变成 2 个存活（一个产品无关的失败类、一个产品专属流程）比硬压成 1 个更有用。簇边界跟着失败类走，不跟着文件走。

派工前，每个文件必须只属于一个簇 —— 文件不相交是并行安全的前提。

派工前再全库 grep 一次 `skill://[a-z0-9-]+`：把已经指向不存在 skill 的死链告诉负责它的 worker，否则合并后它仍然在。

## 3. 一簇一个 subagent，一批发出去

一次 `task` 批次发全部簇，上限 16 并发。共享 `context` 里写死这些约束，逐簇 task 里只写目标与验收：

- frontmatter 恰好两个键：`name`（等于目录名）与 `description`；目录内只有 `SKILL.md`；
- 合并后的 `description` 是各成员触发条件的**并集**：成员语言不同就写双语，保留精确错误串与产品名。否则内容留下了、触发丢了；
- **合并 = 取并集，不是摘要**：命令、路径、`file:line`、spec 文件名、commit hash、阈值、实测数字、陷阱、修法优先级逐项保留；只去掉完全相同的表述；同一规则出现两种粒度时保留具体版，把泛化说法并进去；
- 产物必须读起来像新写的：不出现「合并自」「原先两个」「已整合」「替代 X」之类元叙述（no-negative-echo）；
- 成员之间的 `skill://` 链接若指向本簇要删的 skill，把内容内联进来，不要留链接；
- 用 `rm -rf` 删除被取代的目录；存活名沿用某个成员时就地覆盖它的 `SKILL.md`；
- 不跑 formatter、lint 或全量测试；只碰本簇目录；
- 汇报里明确说出「刻意丢掉了哪些具体内容」。

每个 task 额外**逐项点名必须落地的标识符**（那几条命令、那个 kubeconfig、那个 commit、那个数字）。这是防止 subagent 压缩最有效的一招；只写「保留细节」它会摘要。

跨簇内容（某文件的一节属于别的簇）在两边都写明归属：一边只读引用、另一边负责收纳。

## 4. 自己验收，不信汇报

```bash
python3 scripts/skill_audit.py validate <skills-dir> --extra-roots ~/.agents/skills
stat -f '%Sm %N' -t '%m-%d %H:%M' <skills-dir>/*/SKILL.md | sort
```

1. **结构与链接**：`validate` 检查 frontmatter 只有两个键、`name` == 目录名、无多余文件、代码围栏配对、库内 `skill://` 可解析（`--extra-roots` 让指向用户 skill 的链接也算有效）。脚本自带最小 frontmatter 解析，因为 omp 环境常常没有 PyYAML。
2. **影响面**：只有存活文件可以带今天的 mtime。**不要用文件大小判断**：`wc -c` 数字节、Python `len(text)` 数字符，中文文件相差约 3 倍，会伪造出「文件被改小了」的假象。
3. **残留**：grep 合并措辞，以及每个被删的 skill 名字（能同时捞出别处的过期交叉引用）。
4. **内容抽查**：给每个存活 skill 列一批必须出现的 token（命令、ID、数字）并 grep 确认；再亲自读最大的一两份。subagent 会截断标识符（实测把 7 位 commit hash 写成 6 位）、也会产出混单位表述。
5. **真实加载探针**（唯一能证明 omp 还能用的证据）：

   ```bash
   omp -p --no-session "Count the skills available to you and reply with exactly two lines: line 1 = the total count; line 2 = comma-separated names matching <pattern>. No tool calls."
   ```

   新名字在、旧名字不在、总数与目录数一致（用户 skill 会计入总数，先算好基数）。

## 5. 汇报

一张表：存活 ← 吸收了谁 ← 依据（同判据、同证据源那一句）；总数变化；验收清单；顺路修掉的既有缺陷；以及**刻意没合的边界簇**及原因，让用户决定要不要继续压。
