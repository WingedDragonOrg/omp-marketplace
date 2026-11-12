# Octo 原生资源列表设计

日期：2026-11-12

## 用户原始需求

1. “为什么不支持直接 read 列表？这种应该是直接给列表才对”——截图中的路径为 `octo://docs/`。
2. “类似的几个资源都应该支持 list 需求”——补充到其他 Octo 资源。
3. 对覆盖范围选择“包括（推荐）：Docs 根目录列文档；Loop 根目录列工作区，并保留任务和评论列表；Drive 根目录列空间，空间及文件夹路径列内容”。
4. “read octo://loop/workspaces/也应该是list workspace, /drive/spaces 同理”——补充集合路径的列表行为。

## 设计与验收

- `read octo://docs/` 或 `octo://docs` 通过 `octo-cli docs list` 逐页返回当前身份可访问的文档，见 `2026-11-10-octo-native-tools-design.md`。列表不接受写入。
- `read octo://loop/` 或 `octo://loop` 等价于 `octo://loop/workspaces`，返回可访问工作区。`octo://loop/workspaces/`、`octo://loop/workspaces/<workspaceId>/tasks/` 和 `octo://loop/workspaces/<workspaceId>/tasks/<taskId>/comments/` 分别列出工作区、任务和评论，末尾斜杠可省略。沿用 `2026-11-11-octo-loop-comments-design.md` 的权限和完整分页约束。
- `read octo://drive/`、`octo://drive`、`octo://drive/spaces/` 或 `octo://drive/spaces` 使用 `octo-cli drive space list` 列出当前身份可访问的空间。`read octo://drive/spaces/<spaceId>` 使用 `octo-cli drive browse --space-id <spaceId> --parent-id 0` 列出空间根目录；`read octo://drive/spaces/<spaceId>/folders/<folderId>` 列出指定文件夹。路径段按 URI 规则编码；空间 ID 是不透明字符串，文件夹 ID 是十进制字符串，均不得转换为 JavaScript 数字。末尾斜杠可省略。返回 CLI 的 JSON 业务数据；Drive v1 的列表接口当前返回完整列表，页面对象不表示可翻页的数据切片。
- 以上列表均为只读，沿用 Octo 原有 profile、环境变量及 task mode 选择；CLI 身份和权限失败原样报告，不更换身份。目录项包含 CLI 返回的原始字段；Drive 文件正文、修改、分享和 `find` 搜索不在此列表改动范围内。
- 验收需使用真实 OMP 原生 `read` 与真实 `octo-cli`，验证 Docs 跨页、Loop 列表及 Drive 空间和文件夹路径，包括大于 JavaScript 安全整数的文件夹 ID、空列表和只读行为。对无权或不可用的 Drive 空间返回真实 CLI 错误。
