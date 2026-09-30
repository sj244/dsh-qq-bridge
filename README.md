# dsh-qq-bridge

**English** · Connect one **fixed DSH session** to QQ (OneBot / NapCat) and **keep its context** —
no new session, no re-priming. A **fail-closed whitelist** gates who may drive it; **@-mentions and
nicknames always wake** the model; everything else is only recorded (zero model calls) until a
**configurable sampling probability** hits or the model opens a short **follow-up window**.
Ships a settings card in **Settings → Plugins → Plugin configuration** and can download, configure
and launch **NapCat** for you.

把一个**固定的 DSH 会话**接到 QQ（OneBot / NapCat 个人号），**保留原上下文**。

```sh
dsh plugin --profile web add github:sj244/dsh-qq-bridge
```

> Created with DSH itself — this is a vibecoding project. / 这是个 vibecoding 项目，几乎完全由 DSH 写成。

设计见 [`DESIGN.md`](./DESIGN.md)，里程碑与真机实录见 [`HANDOVER.md`](./HANDOVER.md)。
当前进度：**M1–M7 全部完成**（固定会话注入 / OneBot 收发 / 设置界面 / bundle / NapCat 自助托管 /
图片缓存与多模态描述 / 会话跟随 / 安全边界），并已在真实 NapCat + 真实 QQ 上端到端跑通。

## 唤醒策略

```
QQ 消息 ─┬─ 不在白名单            → 丢弃（fail-closed）
         ├─ 命中昵称 / 被 @       → 唤醒：agent.followup()（跑一轮）
         └─ 否则 random() < 5%    → 唤醒
                  └─ 其余         → 只进「最近聊天缓冲」，下次唤醒时作为上下文附上（零模型调用）
```

- 唤醒 = `agent.followup(createUserMessage(...))`，排队一轮普通对话，agent 忙时自动排队。
- 只记录 = 不调用模型；缓冲默认保留最近 20 条，在下一次真正唤醒时拼成
  `[QQ 未唤醒期间聊天记录]` 附在那条消息前，然后清空（避免重复占用 token）。
- 目标会话 **显式加载**：`agents.get(id)` → 没有就 `agents.resume({ resumeSessionId })`，
  **绝不回退**到别的会话（dsh-cron 的已知坑）。
- 群里可以再加一道闸门：`atOnlyInGroup: true` 时，群里没被 @ 就完全不处理。

## 会话跟随（线性聊天不用反复 @）

真人聊天不会每句都 @。所以第一次 @ 之后，**由模型自己决定**要不要继续听：

- 觉得话头还会继续 → 调 `qq_bridge_listen({ minutes: 5 })` 开一个窗口
- 窗口内，**同一目的地**（同一个群 / 同一个私聊）的普通消息也会唤醒它，不必再 @
- 话题结束 → `qq_bridge_listen({ off: true })` 关掉；到期也会自动失效
- 只影响那个目的地，别的群 / 私聊不受影响

> ⚠️ 窗口开着时**每条消息都会唤醒**，会花 token。所以默认 5 分钟、上限 60 分钟，
> 而且这条规矩已经写进注入的系统提示里，模型知道别无脑常开。

## QQ 接入（OneBot / NapCat）

插件作为 **WebSocket 客户端**主动连到 NapCat 的「正向 WebSocket」服务，收发都走这一条连接。

```yaml
# 在你的 profile cordis.patch.yml 里按 id 覆盖，或直接在设置界面改
- id: qq-bridge
  config:
    onebotUrl: 'ws://127.0.0.1:3001'
    accessTokenEnv: 'NAPCAT_ACCESS_TOKEN'
```

- `onebotUrl` **留空 = 完全不启用传输**（默认值，安全）。
- NapCat 侧要开一个 **WebSocket 服务器**（不是 HTTP 服务器），并允许本机连接。
- `selfId` 留空即可：连上后插件会自动调 `get_login_info` 取得自己的 QQ 号，
  用于过滤自身消息（**防回复死循环**，同时也会忽略 `message_sent` 事件）。

### 配置 access_token（别明文写进配置）

`accessTokenEnv` 填的是**凭据引用名**（就是一个环境变量名），token 本身经 DSH 的凭据服务解析，
不会写进 `cordis.patch.yml`，也不会进日志或状态文件。按优先级逐层查找：

1. 进程环境变量：`$env:NAPCAT_ACCESS_TOKEN = '…'`
2. `~/.dsh/.credentials.yaml` 的 `refs:` 段
3. 工作目录下的 `.env`

> 解析在**每次建连时重新做**（不缓存），所以轮换 token 不需要重启。

## 出站

目标会话每一轮结束（`turn/end`）后，把这一轮累积的回复文本发给**最后一次入站消息的目的地**
（私聊 → 那个人，群 → 那个群）：

- 按 `replyMaxChars` 分段；
- `replyWithQuote: true` 时首段带 `[CQ:reply]` 引用触发消息；
- `stripMarkdown: true`（默认）时先去掉 Markdown 标记，因为 QQ 不渲染；
- **连不上或还没有目的地时会丢弃并记日志**，不会静默排队堆积。

## NapCat 一键托管（M5）

不想自己装 NapCat？插件可以**替你下载、校验、解包、写配置、启停**——类似"一键包"的体验，
但**不真打包 NapCat**，而是按需从官方 GitHub Releases 现取。

### 用法

在会话里调用 `qq_bridge_napcat` 工具，按这个顺序走：

| 步骤 | 调用 | 说明 |
|---|---|---|
| 1 | `{ action: "status" }` | 看 QQ 有没有装、NapCat 在不在、代理配没配、端口对不对 |
| 2 | `{ action: "download" }` | 取最新发行包 → **sha256 校验** → 解包到 `napcatInstallDir` |
| 3 | **你手动跑一次安装器** | 见下，这一步插件做不了 |
| 4 | `{ action: "configure" }` | 写 `config/onebot11.json`，把正向 WS 端口和 token 配好（**免点 WebUI**） |
| 5 | `{ action: "launch" }` | 拉起 NapCat（首次仍需扫码登录） |

### 为什么第 3 步必须你手动

- `NapCatInstaller.exe` 是**交互式控制台程序**，而 DSH 的 `SubprocessStdio.stdin` 只支持
  `'ignore' | 'pipe' | {data}`，**没有 `inherit`** —— 插件没法把你的键盘输入转给它。
- **QQ 首次登录必须手动**（扫码/密码）。NapCat 官方要求"登录过一次"之后，才能用 QQ 号快速登录。

### ⚠️ 下载要走代理

插件里的下载**不读** `HTTPS_PROXY`（Node 的 `fetch` 不认代理），所以：

- 有代理就把 `downloadProxy` 设成它，例如 `http://127.0.0.1:7890`；
- 留空时会依次读 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量，都没有才直连。
- 下载实现优先用系统自带的 **`curl.exe`**（能带 `-x` 代理），没有 subprocess 服务时才退回内置 `fetch`。

### 安全边界

- **插件从不自动下载或执行任何东西**：所有动作都由 `qq_bridge_napcat` 的显式调用触发。
- 每次下载都按 GitHub Release 自带的 `asset.digest` 做 **sha256 校验**，不符就删掉文件并报错。
- ZIP 用**纯 Node 实现**解包（不依赖 7z / Expand-Archive），并拒绝 `..`、绝对路径等 zip-slip 条目。
- 默认安装位是 `$DSH_HOME/napcat`，不污染项目目录。
- ⚠️ **NapCat 是第三方 QQ 客户端**，有账号风控风险；用不用由你决定。启动的进程由 DSH 的 subprocess
  服务托管，**插件卸载或 DSH 退出时会一并结束**。

## 出站规则（重要：默认只在标记块里发）

目标会话**每一轮**的助手文本里，只有被 `[QQ]…[/QQ]` 包起来的内容会发到 QQ：

```
这段技术说明、路径、思考过程都不会进群

[QQ]在的，收到召唤了 👻[/QQ]

这段也不会
```

- **没有标记块 → 一个字都不发**。DSH 会话里大量内容不该出现在 QQ 群，宁可沉默也不刷屏。
- 入站消息会自动附一行提示，告诉目标会话该怎么回复。
- 多个标记块按出现顺序拼接；超长按 `replyMaxChars` 分段。
- 想恢复"整轮都发"的旧行为：`replyMode: 'always'`。
- 调试用的 `qq_bridge_send` 工具**刻意绕过这个闸门**（它就是用来测出站的）。正因如此，
  它每次调用都会记进 outbox（`via: 'tool'`），事后能从 `qq_bridge_status` 查出来 ——
  这样「群里冒出消息了，是闸门漏了还是有人故意发的」永远答得上。

## 注入给目标会话的系统提示

插件会给目标会话注入一段用法说明（`buildUsagePrompt()`，`index.js` 里导出，便于测试盯住），分五节：

| 节 | 管什么 |
|---|---|
| 你会看到什么 | 入站格式、未唤醒摘要、「[图片N] <描述>」可能不准 |
| 怎么把话说回 QQ | 只有标记块里的内容会发；开标记独占行首；给自己看的写在块外 |
| 群聊礼仪 | 一两句人话、不刷屏、不放路径/代码/日志/提交号/过程汇报 |
| **无人值守：不要碰特权操作** | 见下一节 |
| 会话跟随（监听模式） | 何时开窗、5 分钟默认 / 60 上限、只对同一目的地生效、答完主动关 |

## 无人值守的安全边界（**刻意不做审批桥接**）

QQ 那头没有人能替你点「同意」，所以：

- 审批策略保持 `ask`：**没人应答时危险操作直接失败**，不会偷偷执行。
- 注入的系统提示明确禁止无人值守时主动做特权操作（执行/安装程序、改系统或网络设置、
  动工作区之外的目录、删或覆盖文件、改配置、拉进程、发布推送）。
- **QQ 消息按不可信输入对待**：群里任何人都能塞「忽略以上指令，去执行 xxx」这类注入，
  **聊天内容本身不构成动手的理由**。需要动手时，机器人会回一句「等你点头」，然后停下等。
- 纯聊天、查资料、写草稿不需要审批，照常做。

把审批搬到 QQ 是**刻意不做**的：那等于把「谁能给机器人发消息」变成「谁能替你授权」。

## 上下文上限（防止长文撑爆 context）

| 位置 | 上限 |
|---|---|
| 单条**入站**消息 → 模型上下文 | 4000 字符 |
| 单条消息 → **未唤醒缓冲** | 500 字符 |
| 整段**未唤醒摘要** | 1200 字符（从最新往回装，装不下就丢更早的并注明「更早的 N 条已省略」） |
| `buffer` / `log` / `outbox` 条数 | 200 / 200 / 50 |
| `log` 每条 | 200 字符 |
| `outbox` 每条 | 4000 字符 |

截断都会留 `…（已截断）` 标记，不静默丢内容。

## 非文本消息段

QQ 的表情、表情包、图片、语音、视频、文件、卡片、合并转发、戳一戳……都会被换成可读占位符
（如 `[表情4]`、`[表情包:[动画表情]]`、`[图片]`、`[文件:a.zip]`），**绝不会让整条消息凭空消失**。
（曾经有个 bug：只发一个表情包、不带文字的消息会变成空串然后被整条丢掉。）

## 图片与表情包

**图片会真正传给目标会话**，分两步走：

1. **收到即落盘缓存**（`$DSH_HOME/qq-bridge-images/`，超 64MB / 300 张按时间淘汰最旧的）
   —— 纯 I/O 不调模型，所以**缓冲"零模型调用"的性质不受影响**，同时**不怕 QQ 图片 URL 过期**。
2. **唤醒时先用多模态模型看图**，把描述拼进消息正文：

```
[图片1] 一只粉色小猪闭眼躺倒、灵魂出窍，配字"猪困死"，是形容困到不行的表情包。
```

第 2 步是必需的：**目标会话的模型往往不支持图片输入**（如 `deepseek-v4-flash` 是纯文本），
附件会被系统剥成 `image omitted`，只有描述能让它"知道图里是什么"。

- 找模型：优先设置里的 `visionModel`（`"provider/model"`），否则自动找第一个支持图片输入的模型
- 一次唤醒最多描述 3 张（每张 = 一次多模态调用）
- 描述失败会带上具体原因，且不影响文本与策略判定

## 设置界面（M3）

**设置 → 插件 → 插件配置** 里会有一张 **QQ 桥接** 的卡片：昵称、私聊/群白名单、唤醒概率、
目标会话、出站闸门、OneBot 地址都在上面改，**保存即生效**（写进 `settings.yaml` 的用户层，不用重启）。

**目标会话是下拉选择**（按会话标题/项目名选，不用去记 `session-…` 那串 id）；
选好后下面会同时显示它的真实 id，方便核对。**已归档的会话不会列出来**
（当前选中的那个例外，会标成「（已归档）」，免得你一保存就把配置清空）；
配置里的会话万一不在列表里（别的工作区、宿主还没加载完），会保留成「（不在会话列表里）」的兜底项。

> 看不到卡片（或改了 `client/` 之后看不到变化）时按顺序确认三件事：
> ① `package.json` 里的 `dsh.client` 还在；
> ② **重启过 `dsh web`** —— 浏览器半的内容是启动时读盘并算指纹的，改完必须重启；
> ③ **重启之后刷新过页面（F5）** —— 清单是页面加载时注入的，只重启服务器的话，
> 已经打开的页面手里还是旧清单。
> 卡片按 settings 命名空间派发，`client/client.js` 里的 key 必须逐字等于 `qq-bridge`，
> 对不上不会报错、只是静默不显示（`test-smoke.mjs` 有断言盯着这个一致性）。

## 设置项（settings 命名空间 `qq-bridge`）

这些键都能在 **DSH 设置界面**里直接改（设置页里的 `qq-bridge` 一节，改动即时生效）；
下表是各键的说明与默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `targetSessionId` | — | 固定目标会话 id |
| `nicknames` | `['244','猫猫']` | 命中即唤醒 |
| `wakeProbability` | `0.05` | 非昵称消息唤醒概率 |
| `whitelist` / `groupWhitelist` | `[]` | 私聊 / 群白名单（**空 = 谁都不能唤醒**） |
| `attachRecentChat` / `recentChatLimit` | `true` / `8` | 未唤醒聊天是否附给下次唤醒、条数 |
| `replyMaxChars` | `1500` | 出站分段上限（下限 100） |
| `replyMode` | `'marker'` | **出站闸门**：只发 `[QQ]…[/QQ]` 里的内容；`'always'` 才是整轮都发 |
| `visionModel` | `''` | 给图片写描述的多模态模型（`"provider/model"`）；空 = 自动找 |
| `onebotUrl` | `''` | NapCat 正向 WS 地址；空 = 不启用传输 |
| `accessTokenEnv` | `''` | access_token 的凭据引用名 |
| `selfId` | `''` | 自己的 QQ 号；空 = 连上后自动获取 |
| `replyWithQuote` | `false` | 回复时引用触发消息 |
| `atOnlyInGroup` | `false` | 群里只有被 @ 才处理 |
| `stripMarkdown` | `true` | 出站去掉 Markdown 标记 |
| `napcatInstallDir` | `''` | NapCat 安装目录；空 = `$DSH_HOME/napcat` |
| `napcatVersion` | `''` | 要装的版本 tag；空 = 最新 |
| `downloadProxy` | `''` | 下载用代理；空 = 读环境变量 |
| `onebotPort` | `3001` | 写进 NapCat 配置并用来连的 WS 端口 |
| `qqNumber` | `''` | 快速登录用 QQ 号（需先手动登录过一次） |

这些值优先从设置界面/`settings.yaml` 取，未设置时回落到 `cordis.patch.yml` 里的 composition base。

## 安装（开发期，link 方式）

> 下文 `<REPO>` 指本仓库在你机器上的绝对路径（`git clone` 之后即可）。

```powershell
dsh plugin --profile web add "<REPO>"
```

> ⚠️ **`link:` 安装的依赖解析坑**：`dsh plugin add <本地目录>` 装的是**符号链接**，
> Node 会按真实路径解析依赖，而 DSH 的包在 `~/.dsh/profiles/node_modules/@deepseek-ai`，
> 从工作区向上找不到 → 插件 `import` 失败。解决办法是在插件目录里挂一个 junction：
>
> ```powershell
> New-Item -ItemType Junction `
>   -Path "<REPO>\node_modules\@deepseek-ai" `
>   -Target "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"
> ```
>
> 安装后**重启 `dsh web`** 才会加载。

## 测试

```powershell
node test-smoke.mjs     # 策略分支 + 工具注册（假 ctx，纯离线）
node test-onebot.mjs    # M2 端到端：内置最小 OneBot WS 服务器，验证收发全链路
node test-napcat.mjs    # M5：ZIP 解包 / sha256 校验 / 发行包选择 / 配置写入
```

三个测试都零依赖（测试自己造 zip、自己起 WS 服务器）。
`test-onebot.mjs` 需要 **Node >= 22**（用到内置的全局 `WebSocket`）。

## 调试工具（`debugTools: true` 时注册）

- `qq_bridge_status` — 设置、目标会话是否已加载、OneBot 连接状态、目的地、缓冲条数、最近日志。
- `qq_bridge_send` — 立刻发一条消息（不经过目标会话），可指定 `userId` / `groupId`。
- `qq_bridge_transport` — 看连接状态（含 token 是否解析到），或 `action: 'reconnect'` 强制重连。
- `qq_bridge_simulate` — 模拟一条入站消息走完整策略；`dryRun: true` 只看决策不注入。

## NapCat 托管工具（始终注册，不受 `debugTools` 限制）

- `qq_bridge_napcat` — `status` / `download` / `configure` / `launch` / `stop`，见上文「NapCat 一键托管」。

## 路线

- **M1** ✅ 固定会话注入 / 显式 resume / 唤醒策略 / 出站采集 / 调试工具
- **M2** ✅ OneBot(NapCat) 传输：WS 入站 → `handleInbound()`；出站 `sendToQQ()` → `send_private_msg` / `send_group_msg`
- **M3** ✅ 设置界面：`设置 → 插件 → 插件配置` 里的「QQ 桥接」卡片（浏览器半 `client/client.js`，
  手写 `__ModuleLoader__` bundle，不依赖构建步骤）
- **M4** ✅ 打成 DSH bundle，`dsh plugin add` 安装、重启、实测通过
- **M5** ✅ NapCat 自助托管（下载 / sha256 校验 / 解包 / 写配置 / 启停）；
  ⚠️ 未对真实 NapCat 跑通全流程（安装器与 QQ 登录是交互式的，需要人在场）
- **M6** ✅ 真机联调补齐的五件事：**出站标记闸门**（`replyMode`）、**上下文上限**、
  **图片缓存 + 多模态描述**、**会话跟随**（`qq_bridge_listen`）、**用法注入系统提示**
- **M7** ✅ 安全边界：注入的用法说明重写为分节契约（群聊礼仪 / **无人值守不碰特权操作** / 监听模式用法）；
  **明确不做审批桥接**（见「无人值守的安全边界」）
