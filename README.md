# dsh-qq-bridge

把一个**固定的 DSH 会话**接到 QQ（OneBot / NapCat 个人号），**保留原上下文**。

设计见 [`DESIGN.md`](./DESIGN.md)。当前进度：**M1 + M2 已完成**（固定会话注入 + 唤醒策略 + OneBot 收发 + 调试工具）。

这是一个vibecoding项目，几乎完全由dsh创建

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

## 设置项（settings 命名空间 `qq-bridge`）

| 键 | 默认 | 说明 |
|---|---|---|
| `targetSessionId` | — | 固定目标会话 id |
| `nicknames` | `['244','猫猫']` | 命中即唤醒 |
| `wakeProbability` | `0.05` | 非昵称消息唤醒概率 |
| `whitelist` / `groupWhitelist` | `[]` | 私聊 / 群白名单（**空 = 谁都不能唤醒**） |
| `attachRecentChat` / `recentChatLimit` | `true` / `20` | 未唤醒聊天是否附给下次唤醒、条数 |
| `replyMaxChars` | `1500` | 出站分段上限（下限 100） |
| `onebotUrl` | `''` | NapCat 正向 WS 地址；空 = 不启用传输 |
| `accessTokenEnv` | `''` | access_token 的凭据引用名 |
| `selfId` | `''` | 自己的 QQ 号；空 = 连上后自动获取 |
| `replyWithQuote` | `false` | 回复时引用触发消息 |
| `atOnlyInGroup` | `false` | 群里只有被 @ 才处理 |
| `stripMarkdown` | `true` | 出站去掉 Markdown 标记 |

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
```

两个测试都零依赖。`test-onebot.mjs` 需要 **Node >= 22**（用到内置的全局 `WebSocket`）。

## 调试工具（`debugTools: true` 时注册）

- `qq_bridge_status` — 设置、目标会话是否已加载、OneBot 连接状态、目的地、缓冲条数、最近日志。
- `qq_bridge_send` — 立刻发一条消息（不经过目标会话），可指定 `userId` / `groupId`。
- `qq_bridge_transport` — 看连接状态（含 token 是否解析到），或 `action: 'reconnect'` 强制重连。
- `qq_bridge_simulate` — 模拟一条入站消息走完整策略；`dryRun: true` 只看决策不注入。

## 路线

- **M1** ✅ 固定会话注入 / 显式 resume / 唤醒策略 / 出站采集 / 调试工具
- **M2** ✅ OneBot(NapCat) 传输：WS 入站 → `handleInbound()`；出站 `sendToQQ()` → `send_private_msg` / `send_group_msg`
- **M3** ⏳ 设置界面（昵称 chips / 白名单 / 概率滑块 / 目标会话选择 / 唤醒日志）
- **M4** ✅ 打成 DSH bundle，`dsh plugin add` 安装、重启、实测通过
- **待办** ⏳ 把 `approval/request` 桥到 QQ（无人值守时工具审批会挂起，目前没做）
