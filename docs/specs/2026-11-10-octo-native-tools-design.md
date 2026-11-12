# Octo 文档原生工具插件设计

日期：2026-11-10

## 用户原始需求

1. “能否扩展 oh my pi 的 read/write/edit 原生支持 https://im.deepminer.com.cn/d/d_4705256f55c5950a481b9c4c 这种链接？比如: read octo://d_4705256f55c5950a481b9c4c, 底层依赖 octo-cli 即可”
2. “marketplace 插件，edit 理论上我们可以不是有 hashline 吗？或者只管调用，我们插件内部逻辑处理”
3. 对“普通文档和 HTML 文档：分别呈现 Markdown 与 HTML，使用各自的版本检查；表格、白板等先返回明确的不支持。普通文档的增量映射若无法无损表达某次修改，就拒绝该次编辑，而不是静默整体替换”的设计回复“ok”。
4. “实现 docs/specs/2026-11-10-octo-native-tools-design.md 并验收通过, @./plugins/octo 在这里实现，对于多 profile，是否有办法在 oh my pi 的 setting 界面选择？现在的 extension 支持添加自定义项吗？如果不支持则不显示选择，就只管调用octo-cli，其它的由用户自己保证使用正确的 profile”
5. “没有办法绕开吗？或者extension 其它 api？或者 通过 patch 影响 omp 发行包源码？”
6. “应该默认使用 default profile, 如果有 OCTO_BOT_ID/OCTO_TOKEN/OCTO_BOT_TOKEN 则优先配置。”
7. “能否这样，现在是 octo://<docId> 能否改成, octo://docs/<docId>, 接下来还要做 octo://drive/xxxx   octo://loop/tasks/<xxxxxx> 具体路径定义你可以调研下给我设计参考。”本条将第 1 条中的 Octo 文档路径替换为带 `docs` 命名空间的路径。
8. “还要支持 octo loop task的 comment 读取、编辑、写入、回复、附件等。”
9. 对包含 workspace 的 Loop 路径、Docs 路径直接切换并保留 HTTPS、Loop 评论能力和 Drive 路径后续设计的整体方案选择“确认，修订规格”。Loop 评论的具体设计见 `2026-11-11-octo-loop-comments-design.md`。

## 目标与范围

提供可安装的 OMP marketplace 插件，让 `read`、`write` 和 `edit` 使用 `octo://docs/<docId>` 或 `https://im.deepminer.com.cn/d/<docId>` 操作已有 Octo 普通文档和 HTML 文档，远端访问通过 `octo-cli` 完成。普通文档以 Markdown 呈现，HTML 文档以 HTML 源码呈现。表格、白板及其他类型返回明确的不支持错误。

不创建或删除文档，不改变共享或权限。默认使用 CLI 的 `default` profile；设置 `OCTO_BOT_ID`、`OCTO_TOKEN` 或 `OCTO_BOT_TOKEN` 时，沿用 CLI 的身份优先级和网关配置。CLI task 模式保持其原有身份限制；身份不可用、权限不足或 CLI 失败时向调用方暴露错误。

OMP 18.18.6 的插件设置 enum 仅支持 manifest 中的静态选项，无法在设置界面动态列出 `octo-cli` profiles；插件不添加 profile 选择。

## 工具集成

插件在 OMP 18.18.6 内复用原生工具的协议路由与工具实现，不重新注册同名工具，以保留 builtin 身份、动态工具格式及 `xd://` 能力。进程内接入 OMP 内部 API 与原型时必须保持会话隔离，不修改已安装的 OMP 发行文件。只接管上述 Octo 路径；其他路径及工具参数交由同名原生工具执行，保留原有行为和权限机制。工具结果和说明使用原始 Octo 路径；原生 hashline 编辑语法与读取后的快照约束保持一致。工具集成不得绕过 OMP 的权限审批或将远端内容当作指令。

同一文档的 HTTPS 路径与 `octo://docs/<docId>` 路径解析为同一身份；旧 `octo://<docId>` 路径不再支持，历史链接和补丁需改用新路径。命名空间 `docs`、`drive`、`loop` 分别用于对应资源，不把其他命名空间当作文档 ID。文档类型由 Octo 元数据确定，不由 ID 推断。`read` 支持原生行范围和 hashline 工作流；`write` 对已有正文执行整体替换；`edit` 依据最近读取的快照应用用户指定的补丁，不接受过期或未见的锚点。混合本地与 Octo 的多文件补丁必须保留原生编辑的可观察行为，并明确处理远端提交失败，不能声称所有目标已成功修改。

## 远端写入与并发

- HTML：读取 `html source` 的源码和版本，基于该版本发布下一版本。版本冲突不得以旧内容直接覆盖新版本。
- 普通文档：读取富文本正文及 `baseVersion`，将 Markdown 变更映射为可表达且无损的增量块操作，并以该版本提交。无法证明映射保留未修改内容和结构时，拒绝编辑并说明原因，不退化为 Markdown 整体导入。
- `write` 的整体替换是显式请求；仍须使用对应后端的版本检查，不能以不带并发前置条件的导入冒充受保护写入。若 CLI 或后端无法实现受保护的整体替换，则返回明确错误。
- hashline 快照校验与服务端版本校验分别保护读取到编辑和编辑到提交两个时间窗口；任何冲突均不得静默覆盖他人修改。

## 验收标准

1. 对同一普通文档或 HTML 文档，新 `octo://docs/<docId>` 路径和 HTTPS 路径均可读取预期内容，行范围及 hashline 编辑可用；旧 `octo://<docId>` 不再作为文档路径。
2. 对受支持的修改，`edit` 只应用目标变更并保留其他内容；过期快照、远端并发修改及无法无损映射的普通文档修改不会覆盖远端内容。
3. `write` 整体替换可由远端实际读取验证，并受到版本保护；不具备该保护时明确失败。
4. 其他文档类型、无访问权限、身份不明确及 CLI 错误均返回可诊断的错误，不伪装为成功。
5. 本地路径和其他 URI 的三个原生工具行为不受影响；混合目标补丁的结果准确反映已完成和失败的操作。
6. marketplace 元数据及两份目录镜像遵循仓库惯例；通过针对性自动化测试，并使用真实 OMP 和 `octo-cli` 验证可用路径及 CLI 契约。远端写入验证只针对明确获准的测试文档，不创建或删除测试文档。
