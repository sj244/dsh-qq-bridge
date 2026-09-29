# HANDOVER —— dsh-qq-bridge 交接说明

> 交接对象：接手本项目的专门 agent
> 交接人：DSH 工作区会话 `<HANDOVER_SESSION>` 的 agent
> 日期：2026-09-14
> **本文件自包含**：读完它 + 同目录 `DESIGN.md` / `README.md`，你应当能在不依赖原作者的情况下继续推进。
> **占位符**：`<REPO>` = 本仓库的绝对路径；`<TARGET_SESSION_ID>`（目标会话 id）、`<TARGET_WORKSPACE>`（目标会话的工作区）、`<GROUP_ID>`（QQ 群号）需在部署时自行填入。

---

## 0. 一句话目标

把 **一个已存在的、固定的 DSH 会话**接到 QQ（OneBot / NapCat 个人号），
**保留该会话原有上下文**（同一个 sessionId，不新建会话），并且用**省 token 的唤醒策略**决定哪些 QQ 消息真正唤起模型。

---

## 1. 背景与需求来源（为什么是这么设计的）

- 用户有一个长期存在的角色 agent（代号 **244**，跑在 `<TARGET_WORKSPACE>` 工作区）。
- 用户希望**从 QQ 直接跟"这个会话"对话**，而不是 QQ 侧另起一个新会话（现有 QQ 插件都是后者）。
- 用户明确提出的三条附加逻辑：
  1. **被叫到名字/昵称时必须唤醒**；
  2. **普通聊天只按概率唤醒（默认 5%）**，其余消息不唤醒（"太耗 token 了"）；
  3. **昵称与白名单需要一个界面来设定**。
- 传输方式由用户在 A/B 之间**选择了 B**：
  - ~~A. QQ 官方机器人（q.qq.com，AppID/Secret）~~
  - **B. OneBot 协议（NapCat / go-cqhttp 等，可用个人 QQ 号）** ← 采用

---

## 2. 当前状态总览

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M1** | 固定会话注入 + 显式 resume + 唤醒策略 + 出站采集 + 调试工具 | ✅ **已完成，且曾在真实 host 中实测通过** |
| **M2** | OneBot(NapCat) 传输层：入站 → `handleInbound()`，出站 → `sendToQQ()` | ✅ **已完成**（`onebot.js`，离线端到端实测通过；⚠️ **尚未对真实 NapCat 联调**） |
| **M3** | 设置界面（昵称 / 白名单 / 概率 / 目标会话 / 唤醒日志） | ⛔ **未开始** |
| **M5** | NapCat 自助托管：下载 / sha256 校验 / 解包 / 写 OneBot 配置 / 启停 | ✅ **已完成**（离线 + 真实包验证；⚠️ **未在真实 NapCat 上跑通全流程**） |
| — | 插件在 profile 中的安装 | ⚠️ **已被用户卸载**（源码保留在本目录，可随时重装） |
| — | 离线测试 | ✅ `node test-smoke.mjs`（策略/工具）+ `node test-onebot.mjs`（M2 端到端）+ `node test-napcat.mjs`（M5 解包/校验），全绿 |

> 卸载是用户的决定（当时 DSH 新版不稳定、不想叠加变量），**不是代码不可用**。M1 曾通过 `qq_bridge_status` / `qq_bridge_simulate` 两个工具在运行中的 host 内跑通三条分支。

---

## 3. 文件清单

| 文件 | 大小 | 作用 |
|---|---|---|
| `index.js` | ~30 KB | **host 半主体**：M1 全部逻辑 + M2 的接入（配置、入站映射、出站分段、调试工具） |
| `onebot.js` | ~12 KB | **M2 传输层**：内置 WebSocket 连接管理、退避重连、心跳看门狗、action/echo 收发 |
| `napcat.js` | ~14 KB | **M5 托管层**：GitHub 发行查询、sha256 校验下载、纯 Node ZIP 解包、OneBot 配置读写、QQ 检测 |
| `cordis.patch.yml` | ~3.5 KB | bundle 挂载声明 + 安装期默认配置（composition base，含 M2/M5 键） |
| `package.json` | ~0.9 KB | 包声明：`name=dsh-qq-bridge`、`type=module`、`dsh.bundle.patch` |
| `DESIGN.md` | ~12 KB | 设计草案：与现有 QQ 插件的区别、唤醒策略、接口表、设置项、里程碑、安全注意 |
| `README.md` | ~9 KB | 安装/使用说明，含 OneBot 接入、access_token 配置、NapCat 一键托管、依赖解析坑与解法 |
| `test-smoke.mjs` | ~5 KB | **离线冒烟测试**（假 ctx 直接调 `apply()`，覆盖策略分支与工具注册） |
| `test-onebot.mjs` | ~14 KB | **M2 端到端测试**：内置最小 OneBot WS 服务器（手写 RFC 6455，不依赖 `ws`） |
| `test-napcat.mjs` | ~9 KB | **M5 测试**：测试自己造 zip，覆盖解包 / CRC / zip-slip / 摘要校验 / 配置写入 |
| `LICENSE` | ~1 KB | MIT，Copyright (c) 2026 sj244 |
| `node_modules\@deepseek-ai` | junction | 本地安装时让 `import '@deepseek-ai/...'` 能解析（见 §7 坑 1）；**已 gitignore** |
| `HANDOVER.local.md` | — | **未脱敏**的原始交接文档（含真实会话 id / 本机路径 / 群号），**只在本机，已 gitignore** |

---

## 4. 运行时行为（M1 已实现，务必先读懂再改）

### 4.1 唤醒策略

```
收到 QQ 消息 msg
 ├─ 不在白名单                     → drop（fail-closed，记日志）
 ├─ msg.atSelf === true（被 @）     → wake
 ├─ 文本命中任一昵称               → wake
 ├─ Math.random() < wakeProbability → wake
 └─ 否则                           → record（只进缓冲，零模型调用）
```

- **昵称匹配**：先归一化（转小写、去空白、去中英文常见标点）再做子串包含判断（`normalize()` / `mentionsNickname()`）。
- **白名单语义**：有 `groupId` 时查 `groupWhitelist`，否则查 `whitelist`；**数组为空 = 谁都不能唤醒**（fail-closed，刻意的）。
- 决策被抽成纯函数 `decide(msg, settings, random = Math.random)`，便于测试（冒烟测试直接用它）。

### 4.2 唤醒 vs 只记录

- **wake**：
  ```js
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'qq-bridge' },
  }))
  ```
  `followup` 会**排入一轮普通对话并唤醒 driver**；agent 忙时自动排队，不会并发重叠。
- **record**：消息只进 `state.buffer`（上限 200 条）。
  **在下一次真正唤醒时**，把最近 `recentChatLimit`（默认 20）条拼成
  `[QQ 未唤醒期间聊天记录 · 最近 N 条] … [记录结束]` 作为前缀附在那条唤醒消息上，然后**清空缓冲**。
  → 这样既让 agent"接得上话"，又**不会**给每一条闲聊都写一次会话日志（省 token + 不污染上下文）。

> 若你想改成"每条都 inject 进上下文"，可用 `agent.inject(msg)`（只喂上下文、不唤醒 driver）——但注意它**每条都会往会话日志里写一条 user/message**，长聊会膨胀。

### 4.3 目标会话的加载（**本项目的核心差异点，别改坏**）

```js
async function ensureTargetAgent() {
  const live = ctx.agents.get(targetSessionId)
  if (live) return live                       // 已加载，直接用
  if (handles.has(id)) return handles.get(id).agent
  const handle = await ctx.agents.resume({    // 显式 resume
    resumeSessionId: id,
    ...(config.agentPreset ? { setup: mountPreset } : {}),
  })
  handles.set(id, handle)                     // 持有 handle
  return handle.agent
}
```

- **绝不回退到别的会话**。这是刻意修掉的一个真实缺陷：`dsh-cron` 的 `pickAgent()` 只在
  **当前已加载的 roots** 里找绑定会话，找不到就 `logger.warn` 后**回退到"最近活跃会话"**
  （不 resume、不报错）。结果就是"给 A 会话排的定时任务被投进了 B 会话"——本项目用户真实踩过。
- 持有 `AgentHandle`，并在 `ctx.effect(() => () => { handle.dispose() })` 里清理。

### 4.4 出站采集 → QQ（M2 已接好）

```js
ctx.on('session/event', (session, event) => {
  if (session?.id !== targetSessionId) return
  if (event.type === 'assistant/message') { 累积文本到 pendingReply }
  if (event.type === 'turn/end')           { 落 state.outbox → sendToQQ(text) }
})
```

- `sendToQQ(text, destination?)` **已经是真实发送**（不再是桩）：
  目的地默认取 `state.lastDestination`（入站时记住的**最后一次来源**，持久化），
  也可以用参数显式指定；私聊发 `send_private_msg`、群发 `send_group_msg`。
- 按 `replyMaxChars`（下限 100）分段；`replyWithQuote` 时**首段**带 reply 段引用触发消息。
- **连不上或还没有目的地时丢弃并记日志**（不静默排队堆积）。
- ⚠️ `assistant/message` 事件可能带**顶层** `surfaceOp`（`{op:'replace', startSeq, endSeq}`）；
  那时这条是「替换」而不是「追加」，继续累加会重复，所以直接重算为当前这条。
- ⚠️ 出站只带文本段。工具调用、思考过程不会发出去。

### 4.5 状态持久化

`statePath` 默认 `$DSH_HOME/qq-bridge-state.json`，结构：

```json
{ "buffer": [...], "log": [...], "outbox": [...] }
```

- `buffer` 上限 200 条（未唤醒聊天）；`log` 上限 200 条（唤醒/丢弃/记录决策的审计）；`outbox` 上限 50 条（出站文本）。
- 写入是 `tmp + rename` 原子替换。

### 4.6 设置与配置

**两层**：`cordis.patch.yml`（安装期 composition base）→ `settings` 命名空间 `qq-bridge`（用户层，界面/`settings.yaml` 可覆盖）。

| settings 键 | 默认 | 说明 |
|---|---|---|
| `targetSessionId` | — | 固定目标会话 id |
| `nicknames` | `['244','猫猫']` | 命中即唤醒 |
| `wakeProbability` | `0.05` | 非昵称消息唤醒概率 |
| `whitelist` / `groupWhitelist` | `[]` | 私聊 / 群白名单（**空 = 全拒**） |
| `attachRecentChat` / `recentChatLimit` | `true` / `20` | 未唤醒聊天是否附给下次唤醒、条数 |
| `replyMaxChars` | `1500` | 出站分段上限（下限 100） |
| `onebotUrl` | `''` | NapCat 正向 WS 地址；**空 = 不启用传输** |
| `accessTokenEnv` | `''` | access_token 的**凭据引用名**（`role('credential-ref')`），不放明文 |
| `selfId` | `''` | 自己的 QQ 号；空 = 连上后 `get_login_info` 自动取 |
| `replyWithQuote` | `false` | 首段带 `[CQ:reply]` 引用触发消息 |
| `atOnlyInGroup` | `false` | 群里只有被 @ 才处理（比概率唤醒更严的闸门） |
| `stripMarkdown` | `true` | 出站去掉 Markdown 标记（QQ 不渲染） |

Config（`cordis.patch.yml`）另有：`agentPreset`（resume 时挂载的 preset，留空则沿用会话 header）、
`statePath`、`debugTools`、`heartbeatTimeoutMs`（无 WS 流量多久判定断线，默认 90000）。

> ⚠️ **当前 patch 里的白名单是测试值 `test-user`**，正式使用必须换成真实 QQ openid。

### 4.7 调试工具（`debugTools: true` 时注册）

- `qq_bridge_status` —— 设置、目标会话是否已加载、**OneBot 连接状态**、目的地、缓冲条数、
  最近唤醒日志、待发文本、state 路径。
- `qq_bridge_send` —— **（M2 新增）** 立刻发一条消息，不经过目标会话；
  可指定 `userId` / `groupId`，都不给则用最后一次入站目的地。**验证出站最直接的手段。**
- `qq_bridge_transport` —— **（M2 新增）** 看连接状态（含 `accessTokenEnv` 是否解析到 token），
  或 `action: 'reconnect'` 强制重连。
- `qq_bridge_simulate` —— 模拟一条入站消息走完整策略；`dryRun: true` 只返回决策、不注入。

**M5 新增（不受 `debugTools` 开关限制，因为它是本插件的"一键"入口而不是调试工具）：**

- `qq_bridge_napcat` —— `status` / `download` / `configure` / `launch` / `stop`。
  典型顺序：`status` → `download` →（**用户手动**跑一次 `NapCatInstaller.exe`）→ `configure` → `launch`。
  `status` 会一并列出 NapCat 配置目录的候选位置（因为 `config/` 落在哪取决于安装方式）。

这些工具是排障主力，**保留**。

---

## 5. 已核实的关键 API（照着用，不要猜）

| 用途 | 接口 | 出处 |
|---|---|---|
| 构造用户消息 | `createUserMessage({ content, source })` | `@deepseek-ai/dsh-llm`（`lib/types/message.d.ts`） |
| 唤醒一轮 | `agent.followup(msg)` | `@deepseek-ai/dsh-agent`（`lib/types/runtime-types.d.ts` 约 192 行） |
| 只喂上下文不唤醒 | `agent.inject(msg)` | 同上（约 209 行）—— **当前未使用** |
| 发起者归属 | `ctx.agents.withInitiator(agent, op)`；另有 `currentInitiator()` / `requireInitiator()` | `agents` 服务（rc3 起） |
| 取/列会话 | `ctx.agents.get(id)`、`ctx.agents.roots()`、`ctx.agents.list()` | `agents` 服务 |
| 显式加载会话 | `await ctx.agents.resume({ resumeSessionId, agentOptions?, signal?, setup? })` → `AgentHandle{agent, dispose()}` | `agents` 服务 |
| 出站事件 | `ctx.on('session/event', (session, event) => …)`；事件信封 `{type, seq, time, data, surfaceOp?}` | `session/event`（emit 模式） |
| 出站事件类型 | `assistant/message`（`data.message`）、`turn/end`（`data.reason.kind`）、`user/message`、`tool/result` | 同上 |
| 设置 | `ctx.settings.register(ns, schema, { base, applies:'live' })`、`ctx.settings.get(ns)` | `settings` 服务 |
| 注册工具 | `ctx.tools.register(defineTool({ name, description, parameters, output:{schema,render}, execute }))` | `@deepseek-ai/dsh-tools` |
| **M2 · WS 客户端** | 全局 `WebSocket`（Node ≥ 22，WHATWG 接口：`onopen/onmessage/onclose/onerror`、`send`、`close`、`readyState`）。**构造函数只收 `(url, protocols)`，不能传请求头** → `access_token` 走查询串 | Node 内置，零依赖 |
| **M2 · 凭据** | `ctx.get('credentials').resolve(ref)` → `{value, source} \| undefined`；`ref` 是**环境变量名**（`CredentialRef`）。**每次操作重新解析，不得缓存** | `credentials` 服务 |
| **M2 · 出站 action** | `{action:'send_private_msg', params:{user_id, message}, echo}` / `send_group_msg` + `group_id`；回包按 `echo` 配对，`retcode===0` 为成功 | OneBot v11 |
| **M2 · 元数据 action** | `get_login_info`（拿 `self_id`）、`get_group_info`（拿群名） | OneBot v11 |
| 设置界面（M3） | client 半注册 Slot **`settings.section`**（list，注册项 `{id, order, label}`）；另有 `settings.plugin.item` / `settings.general.item` | 客户端 Slot 树 |

插件基本形态（与 `dsh-cron` 一致）：

```js
export const name = 'qq-bridge'
export const inject = ['agents', 'tools', 'settings']
export const Config = Schema.object({ /* … */ })
export function apply(ctx, config) { /* … */ }
```

> `ctx.tools.register` 要求 `inject` 里含 `'tools'`；缺了会静默不可用。

---

## 6. 实现计划与进度

### M2 —— OneBot（NapCat）传输层 ✅ **已实现**

> 代码：传输层在 **`onebot.js`**，接入（配置 / 入站映射 / 出站分段 / 工具）在 `index.js`。
> 下面的编号清单是**当初的计划**，已按此实现；与原计划只有两处差异：
> ① **token 走查询串** `?access_token=…` 而不是请求头——Node 内置的 WHATWG WebSocket
> **不支持自定义请求头**，Body/Bearer 那条路走不通；
> ② 只实现了 **WS 客户端**形态，HTTP + 反向回调没做（也不需要）。
> **剩余未做：对真实 NapCat 联调**（本机没装/没跑 NapCat，只有离线端到端测试）。

**推荐形态**：插件作为 **WebSocket 客户端**连到 NapCat 的 forward WS（如 `ws://127.0.0.1:3001`，带 `access_token`）。
（也可用 HTTP + 反向回调，但 WS 更省事、事件更及时。）

1. **配置新增**（Config + settings base）：`onebotUrl`、`accessToken`、`replyWithQuote`、`atOnlyInGroup` 等。
   ⚠️ **不要把 token 明文写进 `cordis.patch.yml`**；DSH 有凭据 seam（参考 `dsh-llm-pi-ai` 的 `apiKeyEnv: <credential-ref>` 与 `~/.dsh/.credentials.yaml` 的 `refs`）。用引用而非明文。
2. **连接管理**：`ctx.effect()` 里建连/销毁；实现 heartbeat、断线重连（指数退避）；忽略 `post_type:'message_sent'` 与 `user_id === self_id` 的自身消息（防回复死循环）。
3. **入站映射**（OneBot v11 事件 → 现有入口）：
   ```
   { post_type:'message', message_type:'private'|'group', user_id, group_id,
     raw_message, message, sender:{nickname}, self_id, message_id }
        ↓
   handleInbound({ text, userId, groupId, nickname, groupName, atSelf, messageId })
   ```
   - `text`：`message` 是 **array**（用户配置 `message_format: array`）时按段拼接 text 段；
   - `atSelf`：array 中存在 `{type:'at', data:{qq: self_id}}`；
   - `handleInbound()` **已存在且可直接调用**，无需改动 M1 逻辑。
4. **出站**：把 `sendToQQ(text)` 换成 WS action
   - 私聊：`{ action:'send_private_msg', params:{ user_id, message }, echo }`
   - 群聊：`{ action:'send_group_msg', params:{ group_id, message }, echo }`
   - 分段：按 `replyMaxChars`（默认 1500）切；必要时去 Markdown；
   - 需要记住"最近一次入站的目的地"，或把 `sendToQQ` 签名改成带 destination。
5. **并发**：一个会话同时只能跑一轮；QQ 消息在 agent 忙时由 `followup` 队列自然排队，
   `record` 分支只是缓冲，不会阻塞。

**用户环境相关线索**（来自其另一会话的笔记，供配置 NapCat 时参考，需现场核实）：
- NapCat 端口 **7998** 可能被旧 MaiBot 占用（需决定停用或换端口）；
- 群号 **<GROUP_ID>**；
- 消息格式为 **`array`**（不是 `string`）——解析时必须按数组处理；
- **`reportSelfMessage: false`**：自己的消息不回灌，**保持 false**（防回复死循环）。

### M3 —— 设置界面

- 首选：**自定义 client 半**，注册到 `settings.section`，包含
  昵称 chips 增删 / 私聊·群白名单两组列表 / 唤醒概率滑块（显示"约每 N 条醒一次"）/ 目标会话选择（列会话 id + 工作区 + 是否已加载）/ 最近唤醒日志预览。
- client 半需要**预构建的 `lib/client.js`**（`__ModuleLoader__` 格式）。可直接参考已装插件：
  - `~/.dsh/profiles/web/node_modules/dsh-cron/lib/client.js`
  - `~/.dsh/profiles/web/node_modules/dsh-whale-widget-bowl/lib/index.js`（同为 bundle 插件，含 client 资源）
- 与 host 通信：参考 `dsh-cron` 的 `ctx.inject(['webServer','webRuntime'], …)` + `/cron/api/*` 路由（host 侧自建 HTTP 端点，client 用 fetch）。
- **备选**：DSH 会把注册过的 settings 命名空间渲染进通用设置界面——**先去确认通用表单能不能编辑"字符串数组"**；能的话 M3 可以省掉整个 client 半。

---

## 7. 环境坑（血泪，务必先看）

1. **本地 `link:` 安装的模块解析坑（必踩）**
   `dsh plugin --profile web add <本地目录>` 装出来的是**符号链接**，Node 按**真实路径**解析依赖，
   而 DSH 的包在 `~/.dsh/profiles/node_modules/@deepseek-ai`，从工作区向上找不到 →
   插件 `import` 直接失败（报 `Cannot find package '@deepseek-ai/schemastery'`）。
   **解法**：在本项目目录建 junction
   ```powershell
   New-Item -ItemType Junction `
     -Path "<REPO>\node_modules\@deepseek-ai" `
     -Target "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"
   ```
   （本仓库已建好；重装/迁移到别处要重建。）

2. **每次 pnpm 安装/卸载都会冲掉 electron**
   web profile 的 `node_modules/electron/dist` 会被重新解包清空，导致 `dsh-builtin-browser`
   报 `no usable browser provider is registered`（该插件把"electron 可用性"**按进程生命周期缓存**，
   所以二进制补回来后**必须重启**才恢复）。
   **已做的加固**（保持它）：
   - 共享层留一份：`~/.dsh/profiles/node_modules/electron`（该插件的 resolver 会探测
     `$DSH_HOME/profiles/node_modules` 这个 anchor）；
   - web profile 的 `dist` 做成**指向共享层 dist 的 junction**。
   恢复命令：
   ```powershell
   $w="$env:USERPROFILE\.dsh\profiles\web\node_modules\electron"
   $s="$env:USERPROFILE\.dsh\profiles\node_modules\electron"
   if(Test-Path "$w\dist"){ Remove-Item "$w\dist" -Recurse -Force }
   New-Item -ItemType Junction -Path "$w\dist" -Target "$s\dist"
   Copy-Item "$s\path.txt" "$w\path.txt" -Force
   ```

3. **agent 侧 shell 连 github 是间歇性的**
   `dsh plugin add github:...` 常见报错：
   `ERR_PNPM_GIT_RESOLVE_FAILED` / `Failed to connect to github.com port 443` / schannel `SEC_E_NO_CREDENTIALS`。
   **多试几次**通常能过（`dsh-cron`、本挂件都是重试后成功的）。harness 自身的 `web_fetch` 是稳的，
   必要时可用它下载源码包再本地安装。

4. **DSH 版本会破坏性变更**
   现为 `0.1.5-rc.1`。该版本把 `dsh-persona` 的配置从 `text` 改成**必填 `prefix`**，
   直接导致用户的两个 preset（`catgirl` / `liangshen`）挂载失败、会话 `resume failed`。
   → **任何插件/preset 报 `invalid config … missing required value` 都优先怀疑这次格式变更。**
   排查手段：用 roster 服务 `standingKeyFor(id)` 做真实挂载校验（见 §8）。

5. **会话日志是"多帧 zstd"**
   `session.v3.jsonl.zstd` 是逐帧追加的；`zlib.zstdDecompressSync(buf)` **只解出第一帧（header）**。
   要读全量：按 magic **`28 B5 2F FD`** 切帧后逐帧解压（Node ≥ 22 自带 zstd）。

6. **加/卸 bundle 后必须重启 `dsh web`**；`patchReload: live` 只热更 `cordis.patch.yml` 的改动。

7. **用户经常分叉（fork）会话** —— 见 §9，`targetSessionId` 会被"冻结"在旧会话上，需要提醒用户更新。

8. **`dsh` 命令必须用 `dsh.cmd`（Windows）**
   PowerShell 执行策略会拦截 `dsh.ps1`，直接敲 `dsh` 报 `UnauthorizedAccess` / `PSSecurityException`。
   用 **`dsh.cmd`**，或直接 `node <npx缓存>\...\@deepseek-ai\dsh\lib\bin.js`。
   另外：`dsh --profile web --help` 给的是 **web app 自己的**帮助；launcher 级选项
   （`--version` / `--dump-config`）要看 `dsh --help`。`dsh plugin ...` 其实是 **pnpm 的包装**。

9. **agent 侧 `git push/pull` 在沙箱里走不通 HTTPS**
   报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` —— 连公开仓库的
   `git ls-remote` 都会失败（所以**不是**凭据问题，是 TLS 取不到加密句柄）；
   换 `-c http.sslBackend=openssl` 则撞上沙箱**禁止命名管道**（`sh.exe: couldn't create signal pipe,
   Win32 error 5`），凭据助手起不来，于是退回「terminal prompts disabled」失败。
   → 该命令需要更宽的执行权限。另外**推送不稳定是常态**（用户原话：「我推 GitHub 有时候也需要推好几次」），
   写成**循环重试**（8–10 次 + 几秒间隔）比单次调用有效。
   ⚠️ 推送失败时别只想网络：`error: failed to push some refs` 是**非快进拒绝**，
   说明远端被谁（比如用户在网页上）推进了 —— 先 `git fetch` 看分叉，再 `git rebase origin/main`。

10. **不要给插件引入 `ws` 依赖**
    插件目录只挂了 `@deepseek-ai` 一个 junction，`ws` 从这里解析不到（`ERR_MODULE_NOT_FOUND`）。
    用 Node ≥ 22 的内置全局 `WebSocket`（零依赖）。注意它是 WHATWG 接口、**不能传请求头**。

11. **NapCat 的现场事实（M5 调研结论，避免重复踩）**
    - 官方发行（`NapNeko/NapCatQQ`）四个包：`NapCat.Shell.Windows.OneKey.zip`（**1 MB，引导器**，
      内含 `NapCatInstaller.exe` + `bootmain/NapCatWinBootMain.exe` + `7z.exe`）、`NapCat.Shell.zip`（29.5 MB）、
      `NapCat.Shell.Windows.Node.zip`（116.7 MB）、`NapCat.Framework.zip`。
    - Release API 的每个 asset **自带 `digest: sha256:…`** → 用来校验下载。
    - **QQ NT 要求 ≥ 40768**；启动方式 `bootmain/NapCatWinBootMain.exe [QQ号]`。
    - **OneKey 的 ReadMe 原话：「编辑 quick 的脚本即可实现快速登录（需要登录过一次）」**
      —— 首次登录必须手动，无法自动化。
    - **`NapCatInstaller.exe` 是交互式的**，而 DSH 的 `SubprocessStdio.stdin` 只有
      `'ignore' | 'pipe' | {data}`、**没有 `inherit`** → 插件驱动不了它，这一步必须用户手动。
    - **配置落点**：NapCat ≥ v4.5.3 支持 `./config/onebot11.json` 作为默认配置（按账号则是
      `onebot11_<QQ号>.json`）。但 `./` 取决于安装方式（OneKey 根目录 / QQ 安装目录里的
      `resources/app/app_launcher/napcat/config`），所以 `status` 会列候选、`configure` 可显式指定。
    - WebUI 默认端口 **6099**、token 随机，启动日志会打 `WebUi User Panel Url: …?token=xxxxx`；
      端口被占会自动 +1。
    - ⚠️ **大文件经 7890 代理很慢**：29 MB 的 `NapCat.Shell.zip` 在 300 s 内只下了 13 MB 就超时；
      1 MB 的 OneKey 秒下。所以 M5 默认选 OneKey。
    - ⚠️ **NapCat 是第三方 QQ 客户端**，有账号风控风险——这一点必须让用户自己决定。

---

## 8. 验证手册（改完照这个顺序验）

```powershell
# 1) 语法
node --check index.js
node --check onebot.js

# 2) 离线测试（都要 ALL PASS）
node test-smoke.mjs            # 策略分支 + 工具注册；概率实测 ≈5%
node test-onebot.mjs           # M2 端到端：内置最小 OneBot WS 服务器，覆盖收发全链路
node test-napcat.mjs           # M5：自造 zip 验证解包/CRC/zip-slip/摘要校验/配置写入

# 3) 从 profile 里做加载检查
cd "$env:USERPROFILE\.dsh\profiles\web"
node -e "import('dsh-qq-bridge').then(m=>console.log(m.name, JSON.stringify(m.inject))).catch(e=>{console.error(e.message);process.exit(1)})"
# 期望：qq-bridge ["agents","tools","settings"]

# 4) 安装 + 组合检查
dsh plugin --profile web add "<REPO>"          # ⚠️ 用 dsh.cmd，别用 dsh（见 §7 坑 8）
dsh --profile web --dump-config | Select-String "qq-bridge"     # 应看到 # == dsh-qq-bridge
# 5) 重启 dsh web 后，在会话里调用调试工具：
#    qq_bridge_status                    → 设置 / 目标会话 / OneBot 连接状态
#    qq_bridge_transport                 → 连接状态 + token 是否解析到
#    qq_bridge_simulate {dryRun:true}    → 只看决策，不消耗 token
#    qq_bridge_send {text:'hi'}          → 直接测出站（需要 NapCat 已连上）
#    qq_bridge_simulate {userId:'<白名单内>', text:'…'}  → 真正唤醒一轮（会花 token）
```

**preset 挂载校验探针**（改 preset 时用）：临时定义一个动态 host 插件，注册一个调用
`ctx.agentPresets.standingKeyFor(id)` 的工具，成功返回 `mounted OK`，失败返回错误信息；
用完 `cordis_undefine` 清掉。

---

## 9. 需要留意/待决策的事项

- **目标会话 id 要现场确认**：参考值曾是 `<TARGET_SESSION_ID>`
  （244 的会话），但用户**经常分叉**，绑定会失效，需提醒用户改成当前会话。
- **分叉语义的坑（上游 bug）**：用户在"agent 正忙、有消息排队"时分叉，那条尚未成轮的消息会被
  **seed 进新分支**（表现为"我在这分支只发了一句，却看到上一句也在"）。
  报告在 `<WORKSPACE>\dsh-bugreport-fork-queue.md`（用户自行提交）。
  → 与固定会话绑定叠加时，容易出现"到底在跟哪个会话说话"的困惑，排障时先确认 sessionId。
- **安全边界**：QQ 那头能驱动目标会话的工具（文件、Shell）。白名单必须 fail-closed；
  建议再加上"只允许私聊/指定群"、"命令白名单"这类更细的闸门。
- **审批（approval）与提问**：目标会话里若发生需要审批的工具调用，在无人值守时会挂起。
  M2/M3 完成后建议把 `approval/request` 桥到 QQ 内联按钮（参考 `dsh-qqbot-community` 的做法），
  或对该会话选择更宽松的审批策略——**这一步目前完全没做**。

---

## 10. 交接清单（接手后逐项打勾）

- [ ] 读 `DESIGN.md` + 本文件；跑一遍 §8 的 1–3 步，确认现状可复现
- [ ] 确认当前目标会话 id，并更新 `cordis.patch.yml` / settings
- [ ] 把白名单里的 `test-user` 换成真实 QQ openid
- [ ] 确定 NapCat 的 WS 地址与 token（并决定 7998 端口冲突怎么处理）
- [ ] 实现 M2：入站 → `handleInbound()`；出站 `sendToQQ()` → `send_private_msg`/`send_group_msg`
- [ ] 实现 M3：设置界面（或验证通用设置表单已够用）
- [ ] 重装插件 → 重启 `dsh web` → 用 §8 第 5 步验证
- [ ] 视需要把审批/提问桥接到 QQ

---

## 11. 附：核心代码索引

### `index.js`

| 位置（函数） | 作用 |
|---|---|
| `apply(ctx, config)` | 入口：注册 settings、状态、传输、事件、工具 |
| `readSettings()` | 合并 settings 命名空间解析值与默认值 |
| `normalize()` / `mentionsNickname()` | 昵称匹配（归一化后包含判断） |
| `isAllowed()` | 白名单 fail-closed 判定 |
| `decide(msg, settings, random)` | **纯函数策略**（drop/wake/record），测试入口 |
| `ensureTargetAgent()` | `agents.get` → `agents.resume`，**绝不回退** |
| `handleInbound(msg)` | **入站总入口**（OneBot 传输与调试工具都调它） |
| `rememberDestination(msg)` | **M2**：记住最后一次来源，出站回复用它当目的地 |
| `renderInbound()` / `renderDigest()` | 唤醒消息渲染（含未唤醒聊天摘要） |
| `messageText()` | 从 assistant content blocks 抽文本 |
| `resolveAccessToken()` | **M2**：每次建连经 `ctx.credentials` 重新解析 token |
| `handleOneBotEvent(event)` | **M2**：OneBot 事件入口（过滤自身消息 / 元事件） |
| `mapOneBotMessage(event, selfId)` | **M2**：OneBot 事件 → `handleInbound` 的 msg（兼容 array/string） |
| `loadGroupName(groupId)` | **M2**：懒加载群名（失败不影响策略） |
| `stripMarkdown(text)` | **M2**：出站前去掉 Markdown 标记 |
| `chunkText(text, limit)` | **M2**：按码点分段，优先在换行处断 |
| `sendToQQ(text, destination?)` | **M2 已实现**：真实发到 OneBot（私聊/群），分段 + 可选引用 |
| `loadState()` / `saveState()` / `pushLog()` | 状态持久化（含 `lastDestination` / `lastMessageId`） |
| `qq_bridge_status` / `qq_bridge_send` / `qq_bridge_transport` / `qq_bridge_simulate` | 调试工具 |
| `napcatStatus()` / `napcatDownload()` / `napcatConfigure()` / `napcatLaunch()` / `napcatStop()` | **M5**：托管编排（`qq_bridge_napcat` 的五个 action） |
| `proxyFor(settings)` | **M5**：下载代理，设置 → 环境变量 → 直连 |

### `napcat.js`（M5 托管层）

| 位置（函数） | 作用 |
|---|---|
| `resolveRelease({version, fetcher})` | 查 GitHub Release（latest 或指定 tag），规范化 assets（含 `digest` → sha256） |
| `pickAsset(assets, pattern)` | 按资产名选包（精确 → 包含），找不到明确报错 |
| `createFetcher({subprocess, logger, proxy})` | 造取数器：优先 `curl.exe`（可带代理），退回内置 `fetch` |
| `downloadVerified({fetcher, asset, dest})` | 下载 + **sha256 校验**，不符则删文件并抛错 |
| `extractZip(zipPath, destDir)` | **纯 Node ZIP 解包**（store/deflate、CRC32 校验、拒绝 zip-slip） |
| `crc32(buf)` / `sha256Of` / `sha256File` | 摘要工具 |
| `oneBotConfig()` / `writeOneBotConfig()` / `readOneBotConfig()` | 生成与读写 NapCat 的 `config/onebot11.json` |
| `configDirCandidates({installDir, qqPath})` | 列出 NapCat 配置目录的候选位置（**不猜、不乱写**） |
| `detectQq()` | 只读地找 QQ 安装位置（不碰用户的 QQ） |
| `defaultInstallDir(home)` / `napcatPaths(dir)` / `isNapcatInstalled(dir)` | 路径与安装状态 |

### `onebot.js`（M2 传输层）

| 位置（函数） | 作用 |
|---|---|
| `createOneBotTransport(options)` | 建传输实例（唯一持有的对象，副作用全归 `dispose()`） |
| `connect()` | 解析 url/token → 拼 `?access_token=` → 建 WS → 挂事件 |
| `scheduleReconnect()` | 指数退避 + 抖动（1s→30s），带重连计数 |
| `armWatchdog()` / `clearWatchdog()` | 心跳看门狗：`heartbeatTimeoutMs` 无流量即强制重连 |
| `call(action, params)` | 发 action 并按 `echo` 等回包（带超时）；未连接直接 reject |
| `dispose()` | 清所有定时器、关闭连接、reject 待决调用（可重复调用） |
| `status()` | 连接状态快照（state/url/selfId/reconnects/收发计数） |
