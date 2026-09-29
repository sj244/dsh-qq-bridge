# dsh-qq-bridge 设计草案

> 目标：把 **一个指定的、已存在的 DSH 会话**（当前目标：
> `<TARGET_SESSION_ID>`，<TARGET_WORKSPACE> 工作区）
> 接到 QQ，**保留原有上下文**（同一个 sessionId，不新建会话）。

## 1. 与现有 QQ 插件的根本区别

| | 现有 QQ 插件（官方 / community / qqchat） | dsh-qq-bridge |
|---|---|---|
| 会话模型 | 每个 QQ 私聊/群 → **新建**一个独立会话 | **固定指向一个已存在的 sessionId** |
| 上下文 | 从零开始 | **原样继承**（会话日志即上下文） |
| 唤醒 | 每条消息都跑模型 | **昵称必醒 + 5% 概率醒 + 其余只记录** |

## 2. 唤醒策略（核心逻辑）

```
收到 QQ 消息
  ├─ 不在白名单？           → 丢弃 + 记日志（fail-closed）
  ├─ 群里且 atOnlyInGroup 且没被 @？ → 丢弃 + 记日志
  ├─ 文本命中昵称 / 被 @ ？ → 唤醒（followup）
  └─ 否则 → random() < p ? 唤醒 : 只记录
       （p 默认 0.05，可在设置界面调）
```

- **昵称匹配**：归一化后子串匹配（小写、去空格与常见标点），另支持 QQ @机器人
  （array 形态看 `{type:'at'}` 段，string 形态看 `[CQ:at,qq=…]` CQ 码）。
- **只记录**：消息只进 `state.buffer`（上限 200 条），**期间零模型调用**。
  在下一次真正唤醒时，把最近 `recentChatLimit`（默认 20）条拼成
  `[QQ 未唤醒期间聊天记录 · 最近 N 条] … [记录结束]` 作为前缀附在那条唤醒消息上，然后清空缓冲。
  → 既不丢上下文，也**不会**给每条闲聊都写一次会话日志（省 token + 不污染上下文）。
  > ⚠️ 早期草案这里写的是 `agent.inject()`（每条都进模型上下文，但**也每条都写会话日志**）；
  > 实现改成了「缓冲 + 摘要前缀」，长聊时不会膨胀。**以代码为准。**
- **唤醒（followup）**：`agent.followup(msg)` —— 排队一轮普通对话（agent 忙时自动排队，不并发重叠）。
  调用时包一层 `ctx.agents.withInitiator(agent, …)`：OneBot 的 WS 回调本身**没有发起者**，
  而某些插件会调 `agents.requireInitiator()` 并在无发起者时抛错。

## 3. 固定会话的加载（不重蹈 dsh-cron 的覆辙）

dsh-cron 的已知缺陷：`ctx.agents.roots()` 只查**当前已加载**的会话，绑定的会话没开着就
**回退到活动会话**（这就是 244 巡逻任务投到别人会话的根因）。

本插件的做法：
```
ensureTargetAgent():
  a = ctx.agents.get(targetSessionId)
  if a exists            → return a
  else                   → agentLoop.resume(...)/agents.resume(...) 显式加载该会话
  if 仍未成功            → 报错 + 记日志，并【绝不】回退到别的会话
```

## 4. 关键接口（已核实）

| 用途 | 接口 |
|---|---|
| 构造消息 | `createUserMessage({ content:[{type:'text',text}], source:{kind:'plugin',plugin:'qq-bridge'} })`（`@deepseek-ai/dsh-llm`） |
| 唤醒一轮 | `agent.followup(message)`，包在 `ctx.agents.withInitiator(agent, …)` 里 |
| 只喂上下文不唤醒 | `agent.inject(message)`（**当前未使用**，见 §2 的说明） |
| 出站回收 | `ctx.on('session/event', (session, event) => …)`；`event.type ∈ {user/message, assistant/message, turn/end}` |
| 找/加载会话 | `ctx.agents.get(id)` / `ctx.agents.roots()` / `agents.resume({resumeSessionId, setup?})` → `AgentHandle{agent, dispose()}` |
| 设置持久化 | `settings.register('qq-bridge', Schema, {base, applies:'live'})`；`get/describe/update/mutate` |
| 设置界面 | client 半注册 `settings.section`（list，`{id, order, label}`） |
| **M2 传输** | 内置全局 `WebSocket`（Node ≥ 22，零依赖）：连 NapCat 正向 WS；`access_token` 走**查询串**（WHATWG WebSocket 不支持自定义请求头） |
| **M2 凭据** | `ctx.get('credentials').resolve(ref)`，`ref` 是环境变量名；每次建连**重新解析**（不得缓存） |
| **M2 出站** | `{action:'send_private_msg', params:{user_id, message:[{type:'text',data:{text}}]}}`（群则 `send_group_msg` + `group_id`）；`echo` 配对回包 |

## 5. 设置项（settings 命名空间 `qq-bridge`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `targetSessionId` | string | — | 固定目标会话（<TARGET_WORKSPACE> 那个） |
| `nicknames` | string[] | `['244']` | 命中即唤醒的昵称/别名 |
| `wakeProbability` | number | `0.05` | 非昵称消息的唤醒概率 |
| `whitelist` | string[] | `[]` | 私聊 openid 白名单（空=全拒，fail-closed） |
| `groupWhitelist` | string[] | `[]` | 群 openid 白名单 |
| `attachRecentChat` / `recentChatLimit` | boolean / number | `true` / `20` | 未唤醒聊天是否作为摘要附给下次唤醒、条数 |
| `replyMaxChars` | number | `1500` | 出站分段上限（下限 100） |
| `onebotUrl` | string | `''` | NapCat 正向 WS 地址；**空 = 不启用传输** |
| `accessTokenEnv` | string（`role('credential-ref')`） | `''` | access_token 的凭据引用名，**不放明文** |
| `selfId` | string | `''` | 自己的 QQ 号；空 = 连上后 `get_login_info` 自动取 |
| `replyWithQuote` | boolean | `false` | 首段带 `[CQ:reply]` 引用触发消息 |
| `atOnlyInGroup` | boolean | `false` | 群里只有被 @ 才处理 |
| `stripMarkdown` | boolean | `true` | 出站去掉 Markdown 标记 |

Config（`cordis.patch.yml`）另有：`agentPreset`、`statePath`、`debugTools`、`heartbeatTimeoutMs`。

## 6. 设置界面（client 半）

一页 `settings.section`「QQ 桥接」：
- **昵称**：标签式增删（chips）
- **白名单**：私聊/群两组列表增删（可一键填入当前会话/最近发送者 openid）
- **唤醒概率**：0–100% 滑块（默认 5%），旁边显示"约每 N 条醒一次"
- **目标会话**：从会话列表选一个（显示工作区与标题），并展示"已加载/需 resume"
- **连接状态**：QQ 网关在线/断线、最近 20 条唤醒日志（醒 / 只记录 / 丢弃原因）

## 7. QQ 接入方式：**B —— OneBot（NapCat，个人 QQ 号）· M2 已实现**

- ✅ **采用 B. OneBot 协议**（NapCat / go-cqhttp 等）：**可用个人 QQ 号**，私聊/群都能收。
- ~~A. QQ 官方机器人（q.qq.com）~~：**已否决**（只能用官方 Bot 身份，不能当个人号）。
- **实现形态**：插件是 **WS 客户端**，主动连 NapCat 的「正向 WebSocket」。
  - 用 Node 内置全局 `WebSocket`（Node ≥ 22），**不依赖 `ws`**——插件目录只挂了
    `@deepseek-ai` 一个 junction，`ws` 从该目录解析不到（`ERR_MODULE_NOT_FOUND`）。
  - 内置 WebSocket 是 WHATWG 接口、**不支持自定义请求头**，所以 `access_token` 走
    **查询串** `?access_token=…`（OneBot 服务端支持这种写法）。
  - 连接管理：指数退避重连（1s→30s，带抖动）+ 心跳看门狗（`heartbeatTimeoutMs` 无流量即重连）。
  - 防回环：忽略 `post_type:'message_sent'` 与 `user_id === self_id`。
  - 入站映射**同时兼容** `message` 为 **array** 与 **string** 两种形态
    （array 看 `{type:'at'}` 段判 @；string 则解析 `[CQ:at,qq=…]`）。
- 现场线索（需现场核实）：NapCat 端口 **7998** 可能被旧 MaiBot 占用；群号 **<GROUP_ID>**；
  消息格式为 **`array`**（非 `string`）；**`reportSelfMessage: false` 保持 false**（防回复死循环）。
- 出站：`send_private_msg` / `send_group_msg`，按 `replyMaxChars` 分段，
  目的地 = **最后一次入站消息的来源**（持久化在 `state.lastDestination`）。

### 7.1 NapCat 自助托管（M5，"一键包"体验但不真打包）

思路：**不把 NapCat 打进仓库**，而是在需要时由插件从官方 Releases 现取并托管。

```
qq_bridge_napcat
  status     → QQ 是否装了 / NapCat 在不在 / 代理配没配 / 端口对不对
  download   → 取发行包 → sha256 校验 → 解包到 $DSH_HOME/napcat
  configure  → 写 config/onebot11.json（正向 WS 端口 + token），免点 WebUI
  launch     → ctx.subprocess 拉起 NapCatWinBootMain.exe
  stop       → 结束该进程
```

- **安全模型**：所有动作都由**显式工具调用**触发；插件加载时绝不下崽、绝不执行任何东西。
- **下载实现**：优先 `ctx.subprocess` + 系统自带 `curl.exe`（能带 `-x` 代理；本机直连 GitHub 不通），
  无 subprocess 时退回内置 `fetch`。
- **校验**：按 GitHub Release 的 `asset.digest` 做 sha256，不符即删文件报错。
- **解包**：纯 Node（`node:zlib` 的 `inflateRawSync`），不依赖 7z / Expand-Archive；
  校验 CRC32，并拒绝 `..` / 绝对路径（zip-slip）。
- **配置落点不确定**：NapCat 的 `config/` 取决于安装方式，所以 `status` 会列出候选目录
  （OneKey 根目录下的 `config/`、QQ 安装目录里的 NapCat 数据目录），`configure` 也可显式指定。
- **做不到的（已在文档与工具输出里明确写出）**：
  1. `NapCatInstaller.exe` 是交互式的，而 `SubprocessStdio.stdin` 没有 `inherit` → 必须用户手动跑；
  2. QQ 首次登录必须扫码/密码 → 无法自动化；
  3. 启动的进程由 DSH subprocess 服务托管，插件卸载 / DSH 退出时一并结束。

## 8. 里程碑（含当前状态）

- **M1** ✅ **已完成并实测**：host 半 —— 固定会话 `ensureTargetAgent`（显式 resume）+
  `followup` + 唤醒策略引擎 + 出站采集 + 调试工具；曾在运行中的 host 内验证三条策略分支。
- **M2** ✅ **已完成并离线端到端实测**：OneBot/NapCat 传输层（`onebot.js`）——
  WS 连接管理、入站事件映射、出站 `sendToQQ()` 分段发送、token 走凭据引用。
  由 `test-onebot.mjs`（内置最小 OneBot WS 服务器）覆盖全链路。
  ⚠️ **尚未对真实 NapCat 联调**（本机没装/没跑 NapCat）。
- **M3** ⛔ **未开始**：设置界面（昵称/白名单/概率/目标会话/日志）。
- **M4** ✅ **已完成**：打成 DSH bundle，`dsh plugin --profile web add <path>` 安装、重启、实测通过。
  （当前插件已被用户从 profile 卸载，源码与文档保留在本目录，可随时重装。）
- **M5** ✅ **已完成（离线验证）**：NapCat 自助托管 —— 下载 / sha256 校验 / 纯 Node 解包 /
  写 OneBot 配置 / 启停，见 §7.1。
  ✅ 真实数据验证过：下载 OneKey 包，sha256 与 Release digest 一致，纯 Node 解包出全部 9 个文件。
  ⚠️ **未在真实 NapCat 上跑通全流程**（安装器与 QQ 登录是交互式的，需要人在场）。
- **待办** ⛔ **未开始**：`approval/request` / `user-questions/request` 桥接到 QQ。

## 9. 安全与注意

- 白名单 **fail-closed**：默认谁都不能唤醒（QQ 那头能驱动 <TARGET_WORKSPACE> 工作区的工具）。
- **`accessTokenEnv` 只存引用名**：token 走 `ctx.credentials`，不落进 `cordis.patch.yml`、
  不进日志（日志里的地址会脱敏 `access_token=***`）、不进状态文件。
- **`onebotUrl` 默认为空 = 传输完全不启用**，不会在没配置时就去连。
- 目标会话同时在 Web 与 QQ 被驱动时**共享同一上下文**、且一次只能跑一轮（消息排队）。
- 工具审批：无人值守时必须把 `approval/request` 桥到 QQ 按钮，或为该会话设审批策略，
  否则会挂起。
- 形态：**host 平面 profile bundle**（像 dsh-cron 一样 `dsh plugin add` 安装），不是 agent preset。
