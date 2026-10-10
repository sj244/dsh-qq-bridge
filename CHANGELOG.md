# 更新日志 / Changelog

## 未发布

- **未唤醒摘要的省略条数改为真实丢失量，超过 99 条写“大量消息”**：`renderDigest()` 的省略数
  原来是 `picked.length - lines.length`，只数窗口内没装下的条目。窗口外（比 `recentChatLimit`
  更早）的条目同样随快照一起删除，却没有计入，所以对模型报的丢失量偏小。
  现在省略数取 `list.length - lines.length`：`list` 是传入的缓冲快照，`lines` 是真正写进摘要的行数。
  `lines.length` 含被截断后仍然保留的那一条，这一点未变。
  省略数大于 99 时只写“更早的大量消息已省略”，不写数字，避免巨大的数字进入上下文。
  省略数为 0 时不加省略说明。`handleInbound()` 里按快照删除缓冲的行为未变。
  README 的缓冲说明与上下文上限表同步。测试新增 9 条断言。测试总数 399 → 408。
- **接住投递 Promise 的异步失败**：`handleInbound()` 的 `deliver()` 丢弃了
  `agent.followup()` / `agent.steer()` 的返回值。该返回值是 rejected Promise 时，
  既没有人接住它，也没有把台账改成 `wake-failed`，进程还会报 unhandled rejection。
  现在 `deliver()` 把返回值传出来：`withInitiator` 的返回值是 thenable 时用它的返回值；
  `withInitiator` 抛错后改调 `send()`，那一次的返回值同样传出来。
  返回值是 thenable 时挂 `.catch()`：把同一条台账条目的 `decision` 改成 `wake-failed`，
  `error` 写成“投递后这一轮失败：<原因>”，并调用 `saveState()` 与 `logger.warn`。
  这一路不回滚 `pendingFromQQ` / `currentTurnFromQQ` / `claimedFromQQ`：投递已经真的把这一轮
  开起来，三面标志已被这一轮正常消费，事后回滚会破坏下一轮的归属。
  同步失败路径保持原样，两者都不向调用方抛。测试新增 9 条断言。测试总数 408 → 417。
- **唤醒失败不再记账为成功**（严重）：`handleInbound()` 先前在 `d.action === 'wake'` 时就写了
  `decision: 'wake'` 的台账，之后 `ensureTargetAgent()` 抛错（未配置 `targetSessionId`、resume 失败）
  或投递抛错（`followup` / `steer` 抛错，含 `withInitiator` 失败后那次 `send()` 再抛）都会异常退出，
  台账里留下的仍是 `wake` —— 事后查 `status.recentLog` 看不出失败。
  现在 `pushLog()` 返回推入的条目对象，唤醒路径保留引用：投递失败时把 `decision` 就地改成
  `wake-failed` 并加上 `error`；`handleInbound()` 返回
  `{ ...d, delivered: false, wakeFailed: true, error }`，不向上抛，`action` 仍为 `wake`。
  失败时同时回滚 `pendingFromQQ` / `currentTurnFromQQ` / `claimedFromQQ` 到置位前的值
  （失败的唤醒不再污染下一轮的归属判定）。投递失败时不进入清缓冲那一步，
  失败的消息留在缓冲里，下次唤醒还能带上。
  测试新增 18 条断言覆盖这 3 个失败点、回滚与缓冲。测试总数 366 → 384。
- **视觉模型的解析结果改为按设置签名缓存**（严重）：`visionModelCache` 原来只存一个值，
  一个进程内只解析一次。用户在设置卡片里填 `visionModel` 不生效；部署当时没有可用视觉模型时，
  之后补上模型仍然返回“没找到支持图片输入的模型”。现在缓存是 `{ signature, model }`，
  签名取 `visionModel` 的值。签名不同就重新解析，解析失败的 `null` 也带签名。
  `applySettingChanges()` 丢掉「解析失败」的缓存，所以之后补上视觉模型时，
  改任何设置都会重试一次；成功的解析照旧按签名缓存。
  测试新增 15 条断言覆盖缓存命中、`null` 缓存、改值后重新枚举、失败结果的重试与描述路径用到新模型。
  测试总数 384 → 399。
- **未唤醒摘要的清缓冲说明改为与真实行为一致**：只改注释与文档，行为未变。
  投递成功后按快照删除缓冲里的**全部**条目，没进摘要的旧条目也一起删掉，不会留到下一次唤醒。
  `index.js` 的注释、README 与 CHANGELOG 里的描述同步修正。
- **默认值修正**：`cordis.patch.yml` 里的 `targetSessionId` 与 `whitelist` 不再带占位值
  （原来的 `'<TARGET_SESSION_ID>'` 与 `['test-user']`），两项都改为空。
  空 `targetSessionId` = 不驱动任何会话；空 `whitelist` = fail-closed，任何来源都不能唤醒会话。
  README 的设置项表同步了这一默认值。
- **超长出站改为拒绝发送**：出站文本超过 `replyMaxChars` 时**一条都不发**，不再分段。
  `sendToQQ()` 返回 `{ sent: 0, dropped: true, reason: 'too-long', limit, length }`。
  删除了分段函数 `chunkText()` 与分段发送路径。拒绝原因会经 `qq_bridge_send` 的返回、
  标记块模式的日志、用法说明与设置项说明传到模型侧，文案统一为“超过上限的回复不会发出，请缩短后重发”。
- **表情包措辞更新**：用法说明里加一条：发了表情包不要解释它是什么意思（除非有人问）。
  人自己看得懂表情包，解释反而奇怪。
- **出站台账只记真话**：`outbox` 只记录真正发出去的消息。
  被拒绝的发送（超长、未连接、无目的地）不再落台账，只写 warn 日志。
  原来的写法会让台账里出现 QQ 里根本没有的消息，事后对不上账。
- **测试修复：出站用例改为看真实发送帧**（严重）：主 ctx 从未连上传输，
  12 条出站用例靠假台账被误判为通过，实际每条都是 `reason: 'not-connected'`。
  现在为主 ctx 装上能连上的假 WebSocket，判据改为 `send_group_msg` /
  `send_private_msg` 帧里的文本。负面用例同时检查真实帧与台账 2 个口径。
  新增 2 条断言钉住传输处于 `open`。测试总数 361 → 366。

## v0.1.2 — 2026-10-10

- **设置卡片的“启动 NapCat”按钮反映运行状态**：NapCat 运行中时，按钮显示“已在运行”并禁用，
  不再重复启动。宿主半新增 `napcatRunning()`，判据有 2 条：本插件启动的进程还没结束，
  或 OneBot WS 已连接（`transport.isOpen()`）。第 2 条用于识别外部启动的 NapCat，例如手动跑过 bat。
  `GET /api/qq-bridge/napcat` 的返回值新增 `running` 与 `startedByPlugin` 两个布尔字段。
  `POST /api/qq-bridge/napcat/launch` 在 NapCat 已运行时不再启动，
  返回 `{ ok: false, error: 'NapCat 已在运行，未重复启动' }`。
  卡片展开期间每 5 秒轮询一次该接口，用于发现外部启动。
  卡片收起或组件卸载时清掉定时器。
  启动请求结束后，按钮重拉一次状态，成功与失败都重拉。
- **NapCat 启动改为按布局探测，并优先调用官方 launcher**（真机修复）：以前把路径写死成
  `<安装目录>/bootmain/NapCatWinBootMain.exe`。用户把 `napcatInstallDir` 设成 `NapCat.Shell` 子目录时，
  这条路径必然不存在，点“启动 NapCat”只会报“找不到 …，先跑 action:download”。
  现在 `napcatPaths()` 按候选顺序探测，**OneKey 根与 `NapCat.Shell` 子目录两种布局都能解析**：
  `shellDir` 取存在的 `<安装目录>/NapCat.Shell`，不存在时取 `<安装目录>`；
  `bootMain` 依次取 `<shellDir>/bootmain/…`、`<安装目录>/bootmain/…`、`<shellDir>/NapCatWinBootMain.exe`；
  新增 `shellDir`、`hookDll`、`launcherBat` 三个字段。
  启动时优先执行官方 `launcher-win10.bat`（工作目录设为 `shellDir`）：该脚本自己读注册表找 QQ 路径，
  非管理员时用 UAC 自我提权，所以**可能弹出 UAC 窗口**。
  没有 launcher 脚本时才直接调用引导器，参数改为官方顺序
  `<bootMain> <QQ.exe 路径> <hook.dll> [-q <QQ号>]`；以前只传了 `<bootMain> <QQ号>`，
  并且工作目录是 `bootmain`，路径即使对也起不来。
  错误信息现在写明**期望路径**与**下一步动作**，且不含 token 值。
- **设置卡片新增 3 个操作按钮**：展开卡片后可以**打开 WebUI**、**启动 NapCat**、**打开文件夹**。
  打开 WebUI 的地址由 `<安装目录>/config/webui.json` 里的 host / port / token 拼成（没读到就禁用并写明原因）；
  启动复用 `qq_bridge_napcat` 的 launch；打开文件夹按系统调用 `explorer.exe` / `open` / `xdg-open`。
  宿主半新挂 `GET /api/qq-bridge/napcat` 与 `POST /api/qq-bridge/napcat/launch|reveal` 三条
  **不受 legacy 门控**的路由（两代宿主都有），只服务本机：非 loopback 一律 403。
  token 只拼进 URL，不写日志。
- **出站更新（二次确认）**：工具模式下不是 QQ 唤醒的那一轮不再"硬拒绝"：第一次调用只回一句确认、
  **不会发出去**，同一轮里**再调一次**才真的发（确认状态按轮清零，不会跨轮泄漏；非 QQ 轮的发送在
  outbox 里标 `nonQQTurn: true`）。
- **图片描述改为就地标注**：以前描述另起一段附在消息末尾，模型会读成"这张图没解析出来、后面又来了一张"；
  现在直接把描述填回图片原来的位置，形如 `[图片]：<描述>`（2026-10-02 起改成 `[图片#<短哈希>]：<描述>`，见本节末条）。
- **戳一戳更新**：戳一戳走的是 **notice 事件**（不是消息段），以前会被静默丢掉；现在"戳我"和 @ 我同级
  **必唤醒**，戳别人只记录不唤醒，其它 notice 会留一条日志方便后续适配。
- **兼容 DSH 0.2.0 的设置页**：0.2.0 换了**两处**名字 —— 客户端设置服务从 `settingsScope` 变成
  `webUiSettings`，插件配置页的挂载点从 `settings.plugin.item` 变成 `settings.plugins.tab`（插件自己是一个 tab）。
  插件现在**两个服务门、两个 slot 各注册一次**，哪个存在哪个生效，0.1.5-rc.3 与 0.2.0 都能显示设置卡片。
- **兼容 DSH 0.2.0 的宿主设置模型**（真机修复）：0.2.0 删掉了 `settings.register/get`（DSH #677），
  设置表单改为从插件自己的 `Config` 派生。老代码在 `apply()` 里无条件 `register` 会抛 TypeError →
  **整条 fiber failed**（客户端半照样显示 tab，看起来就像"设置项全没了"）。现在按方法探测走两条路：
  老宿主维持命名空间，新宿主直接读 entry 配置并 `configure({ auto: true })` 生成页面。
  顺带修掉 `readSettings()` 里若干字段没回落 `config` 的隐患（新模型下会悄悄丢用户配置）。
  客户端卡片也**两个可写设置 key 都绑**（0.1.5 的 `qq-bridge` vs 0.2.0 的 `include:qq-bridge`），谁 ready 用谁。
- **兼容 DSH 0.2.0 的消息格式 v4**：v4 废弃了 `source.kind === 'plugin'`（`assertV4MessageSources` 直接抛
  "requires a producer-owned source kind"），导致 QQ 唤醒的轮次整个失败。注入消息的 source 改为按宿主分叉：
  0.1.5 用老包装、0.2.0 用 producer-owned 的 `{ kind: 'plugin:dsh-qq-bridge' }`（`injectedMessageSource()`，导出可测）。
- **0.2.0 上设置卡片可用了（自建设置通道）**：0.2.0 的宿主设置桥对第三方插件不给可写域（#677 迁移未完成），
  于是照抄生态里真正能用的做法（皮肤中心）：宿主半**可选**注入 `webServer`，挂一条**只服务本机**的
  `GET/POST /api/qq-bridge/settings`；值存 `$DSH_HOME/qq-bridge-settings.json`
  （优先级：设置文件 > composition config）；浏览器半在拿不到可写域时自动改走这个接口。
  非 loopback 请求一律 403，只写 schema 白名单里的键。0.1.5 与 0.2.0 上都能改设置了。
- **表情包（新功能）**：群友发的图可以登记成表情包，之后按情绪或哈希再发出去。新模块 `stickers.js`
  （纯函数 + 文件读写，导出以便测试）：`hashOfBuffer()` 取图片字节 sha256 的前 16 位十六进制，
  `loadStickers()` / `saveStickers()`（原子写，读不到或坏了返回空表）、`upsertSticker()` /
  `findSticker()` / `listStickers()`、`importSticker()`（算 hash、按需复制图片本体、登记）。
  登记表存 `<statePath 目录>/qq-bridge-stickers.json`，图片本体存同目录的 `qq-bridge-stickers/<hash>.<ext>`。
  新工具 `qq_bridge_sticker`（**不受 `debugTools` 限制**）有 3 个 action：`list` 列已登记的
  （短哈希 / mood / 截断描述 / 大小）、`save` 登记一张图（给 `hash`，或 `fromLast: true` 取缓冲区里最近一张；
  `mood` 与 `description` 必填）、`send` 发一张（给 `hash` 精确发，或只给 `mood` 在该情绪里随机挑一张）。
  发送与 `qq_bridge_send` 共用同一道来源闸门（抽出为 `outboundGate()`）；图片本体用 `base64://` 发送，
  不用本地路径（NapCat 的 `enableLocalFile2Url` 是 false）；成功记 outbox（`via: 'tool'`、`action: 'sticker'`）
  并更新该条的 `sentCount` / `lastSentAt`。
- **图片占位符带短哈希 + 描述缓存命中**：入站占位符从 `[图片]：<描述>` 改成 `[图片#<短哈希>]：<描述>`
  （描述失败写成 `[图片#<短哈希>]：（描述失败：原因）`），模型据此能指着一张具体的图交给 `qq_bridge_sticker`；
  注入的系统提示同步改了格式说明。图片缓存的文件名改成内容哈希（`<hash>.<ext>`）：同一张图不重复落盘，
  命中已有文件时也拿得到哈希。`describeImage()` 先查登记表，命中且有 `description` 时**直接返回登记的描述、
  不调用多模态模型**（反复出现的图只描述一次），日志只记短哈希。新增测试套件 `test-stickers.mjs`（40 条）；
  `test-smoke.mjs` 增加描述缓存命中、入站短哈希渲染与表情包工具的断言。





## v0.1.1 — 2026-10-01

生活更新（补丁版，无破坏性改动）。

- 识图：改成让模型**逐字抄下图中所有可见文字**再说明画面，token 上限 300 → 600。
  （之前偶尔"图里的字被压成大意"，是我在提示词里要求它"一到两句"，不是代码截断描述。）
- 设置卡片：改成折叠块，点标题展开；界面里可以改的设置项补齐（含 visionModel、agentPreset）。
- OneBot 地址/token 栏加形状校验，避免把整段配置粘进单栏。
- 目标会话下拉不再列出已归档的会话（当前值仍保留，不会把你的选择吞掉）。

本项目遵循语义化版本。**v0.1.0 是第一次公开发布。**

## [0.1.0] — 2026-09-30

把**一个已存在的、固定的 DSH 会话**接到 QQ（OneBot / NapCat），**保留原上下文**，
并用一套省 token 的唤醒策略决定哪些 QQ 消息真正唤起模型。

**和同类 QQ 插件的区别**：接的是**同一个老会话**（不新建、不重置人设），并且**唤醒要花钱、所以要挑**。
多数同类方案是「每个群 / 每个私聊用户各自开一个新会话」。

### 能力

- **固定会话注入**：`agents.get(id)` 拿不到就 `agents.resume({resumeSessionId})` 显式拉起；**绝不回退**到别的会话。
- **唤醒策略（省 token）**：白名单 fail-closed → 被 @ / 命中昵称必唤醒 → 否则按概率（默认 5%）→
  其余**只记录不唤醒**（零模型调用），下次唤醒时取最近 `recentChatLimit` 条（默认 8）作为上下文附上；
  没进摘要的旧条目随这次清缓冲一起删掉，不会留到下一次唤醒。
- **会话跟随** `qq_bridge_listen`：一段线性对话开个短窗，期间普通消息也唤醒，不必每句都 @。
- **OneBot v11 传输**：内置 WebSocket（**零第三方运行时依赖**），指数退避重连、心跳看门狗、action/echo 配对。
- **出站方式开关** `replyMode`：
  `marker`（只发 `[QQ]…[/QQ]` 块）｜`tool`（关掉标记块，改用 `qq_bridge_send` 工具，**发不出去时有明确反馈**）｜`always`。
- **投递方式** `delivery`：`auto`（目标正忙时**插话**）、`followup`（排队）、`steer`（总是插话）。
- **设置界面**：`设置 → 插件 → 插件配置` 里的「QQ 桥接」卡片（目标会话下拉、昵称、白名单、概率、出站/投递方式……），
  **保存即生效**，改出站方式会立刻重挂注入给会话的用法说明。
- **图片**：收到即落盘缓存 → 唤醒时用多模态模型转成文字描述（目标模型看不见图时的唯一出路）。
- **NapCat 自助托管**：查 Release、sha256 校验下载、纯 Node 解包 ZIP、写 OneBot 配置、启停。
- **无人值守安全边界**：注入的系统提示明确禁止无人值守时做特权操作、把 QQ 消息当不可信输入；
  **明确不做审批桥接**（把审批搬到 QQ = 把"谁能发消息"变成"谁能替你授权"）。

### 修复（都是真机联调暴露的）

- 出站闸门**按来源生效**：只有被 QQ 唤醒的那一轮才出站，DSH 界面里的标记块一个字都不发。
- 出站归属**按轮快照**：轮内插入别的消息不会把归属打掉（哑火）或抬高（误发）。
- **四次哑火、四个不同成因**：`source` 字段被上游重写／单一标记被同轮消息打掉／
  harness 注入的上下文被当成"一轮的触发器"／`followup()` **同步**起轮导致置位晚一拍。
- 提示词**按出站方式分叉**，并在方式变化时**重挂**（提示词正文是挂载时的快照）。
- 设置卡片的 key 必须**逐字等于** settings 命名空间，否则界面静默空白（有测试盯住）。
- 图片：唤醒结束时的清缓冲会吞掉期间新到的消息（"发三张图只处理一张"的元凶）。
- 非文本消息段（表情包 / 语音 / 文件 / 合并转发……）都有占位符，**绝不让整条消息凭空消失**。
- **恢复没开着的会话时必须带上模型**：否则部署提示词里的 `{{model}}` 无值，
  每一轮都在组装提示词时失败（`prompt variable "{{model}}" has no value …`）。
  现在按官方 GUI 的优先级取值：会话的模型选择投影 → 日志里最后一次 `request/header` → 部署默认模型。
  （目标会话在 GUI 里开着时走的是"活的 agent"路径，所以这个坑只在**冷恢复**时出现 —— 真机验证过。）

### 已知限制

- **NapCat 自助托管未在真机跑通全流程**：安装器与 QQ 登录是交互式的，需要人在场（工具本身已离线验证）。
- 目标会话的模型如果不支持图片输入，必须配一个多模态模型（`visionModel`）；否则只看到「图片省略」。
- 白名单为空 = **谁都不能唤醒**（fail-closed），第一次用必须先把群号 / QQ 号填进去。
- 回复方式选 `tool` 时，每轮多一次模型调用（工具结果回来还要再出一轮）。