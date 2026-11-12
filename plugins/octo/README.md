# octo

使用 Oh My Pi 的 `read`、`write` 和 `edit` 操作 Octo 文档及 Loop 评论。安装后启动新会话：

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install octo@winged-dragon-org
```

需要在运行 OMP 的环境中安装并配置 `octo-cli`。默认使用 CLI 的 `default` profile；设置 `OCTO_BOT_ID`、`OCTO_TOKEN` 或 `OCTO_BOT_TOKEN` 时，沿用 CLI 的环境凭据优先级。CLI 身份、权限和服务端错误会传给调用方。

插件针对 OMP 18.18.7 的内部协议和原生工具接口实现；升级 OMP 后应先验证兼容性。Octo 文档的 `edit` 使用 OMP 的 hashline 模式，包含按行范围读取和快照校验。某些模型会将 hashline 自动切换为其他编辑模式；如需固定 hashline，可将 `edit.mode` 设为 `hashline` 并在启动 OMP 前设置 `PI_STRICT_EDIT_MODE=1`。

在 `/settings` → **Tools** → **Available Tools** 中使用 **Octo** 开关启用或关闭 Octo 支持，默认开启。关闭后，Octo 操作不可用，普通本地文件和其他 URI 不受影响。

原生 `read` 可浏览以下只读列表：

| 路径 | 列表 |
| --- | --- |
| `octo://docs/` | 当前身份可访问的文档 |
| `octo://loop/` 或 `octo://loop/workspaces/` | 可访问的 Loop 工作区 |
| `octo://loop/workspaces/<workspaceId>/tasks/` | 工作区任务 |
| `octo://loop/workspaces/<workspaceId>/tasks/<taskId>/comments/` | 任务评论及附件信息 |
| `octo://drive/` 或 `octo://drive/spaces/` | 可访问的 Drive 空间 |
| `octo://drive/spaces/<spaceId>/` | Drive 空间根目录 |
| `octo://drive/spaces/<spaceId>/folders/<folderId>/` | Drive 文件夹内容 |

列表路径末尾的 `/` 可省略。`spaceId` 中的特殊字符应按 URI 路径段编码，例如 `shared:abc` 写成 `shared%3Aabc`；Drive 文件夹 ID 按原始十进制字符串传入。

路径使用 `octo://docs/<docId>` 或 `https://im.deepminer.com.cn/d/<docId>`。普通文档以 Markdown 呈现，HTML 文档以 HTML 源码呈现；表格、白板及其他类型不支持。文档中不能直接表示的富文本节点以标记显示；无法证明无损的修改会被拒绝。`write` 表示整体替换，写入和编辑都使用服务端版本检查。

Loop 使用 `octo://loop/workspaces/<workspaceId>/tasks/<taskId>`；其下的 `/comments` 可读取评论及附件信息，`/comments/<commentId>` 可读取和修改评论正文，`/comments/new` 用于发表新评论，`/comments/<commentId>/replies/new` 用于回复。新评论和回复的 `write` 内容是 JSON，例如 `{"content":"回复内容","attachment_ids":[],"suppress_expert_ids":[]}`。评论写入会预览触发对象并要求逐次审批；已有评论须先读取，提交前会重读比较，但检查与提交之间仍可能发生并发覆盖。

二进制附件通过 `octo-cli loop attachment upload --workspace-id <workspaceId> --task-id <taskId> --file <本地文件>` 上传；通过 `octo-cli loop attachment download <attachmentId> --workspace-id <workspaceId> --output <本地文件>` 下载。上传结果的 `attachment_id` 可用于评论的 `attachment_ids`。

普通文件和其他 URI 仍交由 OMP 原生工具处理。
