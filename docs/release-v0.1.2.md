# v0.1.2 — 兼容性更新

本次更新以 DSH 0.2.0 兼容为主，另有表情包功能。无破坏性改动。

### 更新内容

**DSH 0.2.0 设置页更新**：0.2.0 把插件配置页的挂载点从 `settings.plugin.item` 改为 `settings.plugins.tab`，
客户端设置服务从 `settingsScope` 改为 `webUiSettings`。
插件对两个服务、两个 slot 各注册一次，哪个存在哪个生效，DSH 0.1.5-rc.3 与 0.2.0 都能显示设置卡片。

**宿主设置模型更新**：0.2.0 删掉了 `settings.register/get`，设置表单改为从插件自己的 `Config` 派生。
插件按方法探测走两条路：老宿主维持命名空间，新宿主直接读 entry 配置并生成页面。

**消息格式 v4 更新**：v4 废弃了 `source.kind === 'plugin'`，QQ 唤醒的轮次会整个失败。
注入消息的 source 改为按宿主分叉，0.2.0 使用 producer-owned 的 `{ kind: 'plugin:dsh-qq-bridge' }`。

**设置通道更新**：0.2.0 的宿主设置桥对第三方插件不给可写域。
宿主半可选注入 `webServer`，挂一条只服务本机的 `GET/POST /api/qq-bridge/settings`，
值存 `$DSH_HOME/qq-bridge-settings.json`；浏览器半在拿不到可写域时自动改走该接口。
非 loopback 请求一律 403。

**NapCat 操作按钮更新**：设置卡片展开后可以打开 WebUI、启动 NapCat、打开文件夹。
打开 WebUI 的地址由 `<安装目录>/config/webui.json` 里的 host、port、token 拼成，没读到就禁用并写明原因。

**NapCat 启动路径更新**：`napcatPaths()` 改为按候选顺序探测，OneKey 根与 `NapCat.Shell` 子目录两种布局都能解析。
启动时优先执行官方 `launcher-win10.bat`，没有该脚本时才直接调用引导器，引导器参数改为官方顺序。

**启动按钮运行状态更新**：NapCat 运行中时，按钮显示“已在运行”并禁用，不再重复启动。
判据有 2 条：本插件启动的进程还没结束，或 OneBot WebSocket 已连接。
卡片展开期间每 5 秒轮询一次，用于发现外部启动的 NapCat。

**表情包更新**：群友发的图可以登记成表情包，之后按情绪或哈希再发出去。
新工具 `qq_bridge_sticker` 有 3 个 action：`list`、`save`、`send`，图片本体用 `base64://` 发送。

**图片占位符更新**：入站占位符从 `[图片]：<描述>` 改为 `[图片#<短哈希>]：<描述>`，
模型可以指着一张具体的图交给 `qq_bridge_sticker`。
图片缓存的文件名改成内容哈希，同一张图不重复落盘。

**图片描述缓存更新**：`describeImage()` 先查表情包登记表，命中且有描述时直接返回登记的描述，不调用多模态模型。
反复出现的图只描述一次。

安装与使用说明见 README，逐条变更见 CHANGELOG。
