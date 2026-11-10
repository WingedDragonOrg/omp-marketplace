# octo

使用 Oh My Pi 的 `read`、`write` 和 `edit` 操作 Octo 文档。安装后启动新会话：

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install octo@winged-dragon-org
```

需要在运行 OMP 的环境中安装并配置 `octo-cli`。插件使用 CLI 的现有身份与网关配置；存在多个 profile 时，请在启动 OMP 前通过 `OCTO_BOT_ID` 或 CLI 支持的环境凭据选择正确身份。CLI 身份、权限和服务端错误会传给调用方。

路径使用 `octo://<docId>` 或 `https://im.deepminer.com.cn/d/<docId>`。普通文档以 Markdown 呈现，HTML 文档以 HTML 源码呈现；表格、白板及其他类型不支持。`read` 提供用于 `edit` 的快照；修改使用服务端版本检查。普通文档的修改仅在可以保留未修改的富文本结构时提交，否则返回错误。`write` 表示整体替换。

普通文件和其他 URI 仍交由 OMP 原生工具处理。
