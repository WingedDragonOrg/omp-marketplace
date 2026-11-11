# octo

使用 Oh My Pi 的 `read`、`write` 和 `edit` 操作 Octo 文档。安装后启动新会话：

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install octo@winged-dragon-org
```

需要在运行 OMP 的环境中安装并配置 `octo-cli`。插件直接使用 CLI 的身份与网关配置；存在多个 profile 时，请在启动 OMP 前通过 `OCTO_BOT_ID` 或 CLI 支持的环境凭据选择正确身份。CLI 身份、权限和服务端错误会传给调用方。

插件针对 OMP 18.18.7 的内部协议和原生工具接口实现；升级 OMP 后应先验证兼容性。Octo 文档的 `edit` 使用 OMP 的 hashline 模式，包含按行范围读取和快照校验。某些模型会将 hashline 自动切换为其他编辑模式；如需固定 hashline，可将 `edit.mode` 设为 `hashline` 并在启动 OMP 前设置 `PI_STRICT_EDIT_MODE=1`。

在 `/settings` → **Tools** → **Available Tools** 中使用 **Octo** 开关启用或关闭文档支持，默认开启。关闭后，Octo 文档操作不可用，普通本地文件和其他 URI 不受影响。

路径使用 `octo://<docId>` 或 `https://im.deepminer.com.cn/d/<docId>`。普通文档以 Markdown 呈现，HTML 文档以 HTML 源码呈现；表格、白板及其他类型不支持。文档中不能直接表示的富文本节点以标记显示；无法证明无损的修改会被拒绝。`write` 表示整体替换，写入和编辑都使用服务端版本检查。

普通文件和其他 URI 仍交由 OMP 原生工具处理。
