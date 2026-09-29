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
  ├─ 文本命中昵称/被 @ ？   → 唤醒（followup）
  └─ 否则 → random() < p ? 唤醒 : 只记录（inject，不花 token）
       （p 默认 0.05，可在设置界面调）
```

- **昵称匹配**：归一化后子串匹配（小写、去空格与常见标点），另支持 QQ @机器人。
- **只记录（inject）**：`agent.inject(createUserMessage({...}))` —— 进模型上下文但不触发 driver，
  所以 244 下次被唤醒时**能看到这段聊天**，但不产生任何模型调用。
- **唤醒（followup）**：`agent.followup(msg)` —— 排队一轮普通对话（agent 忙时自动排队，不并发重叠）。

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
| 唤醒一轮 | `agent.followup(message)` |
| 只记录不唤醒 | `agent.inject(message)` |
| 出站回收 | `ctx.on('session/event', (session, event) => …)`；`event.type ∈ {user/message, assistant/message, turn/end}` |
| 找/加载会话 | `ctx.agents.get(id)` / `ctx.agents.roots()` / `agents.resume` / `agentLoop.resume` |
| 设置持久化 | `settings.register('qq-bridge', Schema, {applies:'live'})`；`describe/update/mutate` |
| 设置界面 | client 半注册 `settings.section`（list，`{id, order, label}`） |

## 5. 设置项（settings 命名空间 `qq-bridge`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `targetSessionId` | string | — | 固定目标会话（<TARGET_WORKSPACE> 那个） |
| `nicknames` | string[] | `['244']` | 命中即唤醒的昵称/别名 |
| `wakeProbability` | number | `0.05` | 非昵称消息的唤醒概率 |
| `whitelist` | string[] | `[]` | 私聊 openid 白名单（空=全拒，fail-closed） |
| `groupWhitelist` | string[] | `[]` | 群 openid 白名单 |
| `recordUnwoken` | boolean | `true` | 未唤醒消息是否 inject 进上下文 |
| `replyMaxChars` | number | `1500` | 出站分段上限 |
| `transport` | … | — | QQ 接入方式（见 §7 待定） |

## 6. 设置界面（client 半）

一页 `settings.section`「QQ 桥接」：
- **昵称**：标签式增删（chips）
- **白名单**：私聊/群两组列表增删（可一键填入当前会话/最近发送者 openid）
- **唤醒概率**：0–100% 滑块（默认 5%），旁边显示"约每 N 条醒一次"
- **目标会话**：从会话列表选一个（显示工作区与标题），并展示"已加载/需 resume"
- **连接状态**：QQ 网关在线/断线、最近 20 条唤醒日志（醒 / 只记录 / 丢弃原因）

## 7. QQ 接入方式：**已定 B —— OneBot（NapCat，个人 QQ 号）**

- ✅ **采用 B. OneBot 协议**（NapCat / go-cqhttp 等）：**可用个人 QQ 号**，私聊/群都能收；
  需另装 NapCat 并开 WS/HTTP；可参考 `kun2-5code/dsh-plugin-onebot`。
- ~~A. QQ 官方机器人（q.qq.com）~~：**已否决**（只能用官方 Bot 身份，不能当个人号）。
- 现场线索（需核实）：NapCat 端口 **7998** 可能被旧 MaiBot 占用；群号 **<GROUP_ID>**；
  消息格式为 **`array`**（非 `string`）；**`reportSelfMessage: false` 保持 false**（防回复死循环）。
- 入站/出站映射、配置项与实现步骤 → 见 **`HANDOVER.md` §6（M2）**。

## 8. 里程碑（含当前状态）

- **M1** ✅ **已完成并实测**：host 半 —— 固定会话 `ensureTargetAgent`（显式 resume）+
  `followup/inject` + 唤醒策略引擎 + 出站采集 + 两个调试工具；曾在运行中的 host 内验证三条策略分支。
- **M2** ⛔ **未开始**：QQ transport 接入（**已定 B：OneBot/NapCat**）+ 出站 `session/event` → QQ。
  接入点、事件映射与配置项见 `HANDOVER.md` §6。
- **M3** ⛔ **未开始**：设置界面（昵称/白名单/概率/目标会话/日志）+ 审批与提问桥接到 QQ。
- **M4** ✅ **已完成**：打成 DSH bundle，`dsh plugin --profile web add <path>` 安装、重启、实测通过。
  （当前插件已被用户从 profile 卸载，源码与文档保留在本目录，可随时重装。）

## 9. 安全与注意

- 白名单 **fail-closed**：默认谁都不能唤醒（QQ 那头能驱动 <TARGET_WORKSPACE> 工作区的工具）。
- 目标会话同时在 Web 与 QQ 被驱动时**共享同一上下文**、且一次只能跑一轮（消息排队）。
- 工具审批：无人值守时必须把 `approval/request` 桥到 QQ 按钮，或为该会话设审批策略，
  否则会挂起。
- 形态：**host 平面 profile bundle**（像 dsh-cron 一样 `dsh plugin add` 安装），不是 agent preset。
