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
| **M2** | OneBot(NapCat) 传输层：入站 → `handleInbound()`，出站 → `sendToQQ()` | ⛔ **未开始**（`sendToQQ()` 目前只打日志） |
| **M3** | 设置界面（昵称 / 白名单 / 概率 / 目标会话 / 唤醒日志） | ⛔ **未开始** |
| — | 插件在 profile 中的安装 | ⚠️ **已被用户卸载**（源码保留在本目录，可随时重装） |
| — | 离线冒烟测试 | ✅ `node test-smoke.mjs` 全绿（含 5.05% 概率实测） |

> 卸载是用户的决定（当时 DSH 新版不稳定、不想叠加变量），**不是代码不可用**。M1 曾通过 `qq_bridge_status` / `qq_bridge_simulate` 两个工具在运行中的 host 内跑通三条分支。

---

## 3. 文件清单

| 文件 | 大小 | 作用 |
|---|---|---|
| `index.js` | ~15.9 KB | **host 半主体**（全部 M1 逻辑） |
| `cordis.patch.yml` | ~1.3 KB | bundle 挂载声明 + 安装期默认配置（composition base） |
| `package.json` | ~0.5 KB | 包声明：`name=dsh-qq-bridge`、`type=module`、`dsh.bundle.patch` |
| `DESIGN.md` | ~5.5 KB | 设计草案：与现有 QQ 插件的区别、唤醒策略、接口表、设置项、里程碑、安全注意 |
| `README.md` | ~3.1 KB | 安装/使用说明，含本地 `link:` 安装的依赖解析坑与解法 |
| `test-smoke.mjs` | ~3.3 KB | **离线冒烟测试**（假 ctx 直接调 `apply()`） |
| `node_modules\@deepseek-ai` | junction | 本地安装时让 `import '@deepseek-ai/...'` 能解析（见 §7 坑 1） |

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

### 4.4 出站采集（M2 的接入点）

```js
ctx.on('session/event', (session, event) => {
  if (session?.id !== targetSessionId) return
  if (event.type === 'assistant/message') { 累积文本 }
  if (event.type === 'turn/end')           { 落 state.outbox → sendToQQ(text) }
})
```

- `sendToQQ(text)` 目前是**桩**：只 `logger.info`，不发送。
- ⚠️ **M2 必须扩展它**：现在只传 `text`，不传目标（私聊/群）。实现时要么改成
  `sendToQQ(destination, text)`，要么在 `state` 里记住"最后一次入站的会话目的地"。

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
| `replyMaxChars` | `1500` | 出站分段上限（M2 用） |

Config（`cordis.patch.yml`）另有：`agentPreset`（resume 时挂载的 preset，留空则沿用会话 header）、`statePath`、`debugTools`。

> ⚠️ **当前 patch 里的白名单是测试值 `test-user`**，正式使用必须换成真实 QQ openid。

### 4.7 调试工具（`debugTools: true` 时注册）

- `qq_bridge_status` —— 打印设置、目标会话是否已加载、缓冲条数、最近唤醒日志、待发文本。
- `qq_bridge_simulate` —— 模拟一条入站消息走完整策略；`dryRun: true` 只返回决策、不注入。

这两个工具是 M1 的验证手段，**保留**；M2 接好真实传输后可继续用于排障。

---

## 5. 已核实的关键 API（照着用，不要猜）

| 用途 | 接口 | 出处 |
|---|---|---|
| 构造用户消息 | `createUserMessage({ content, source })` | `@deepseek-ai/dsh-llm` |
| 唤醒一轮 | `agent.followup(msg)` | `@deepseek-ai/dsh-agent` types（`runtime-types.d.ts` 约 118 行）/ `dsh-agent-loop` |
| 只喂上下文不唤醒 | `agent.inject(msg)` | 同上（约 135 行） |
| 取/列会话 | `ctx.agents.get(id)`、`ctx.agents.roots()` | `agents` 服务 |
| 显式加载会话 | `await ctx.agents.resume({ resumeSessionId, agentOptions?, signal?, setup? })` → `AgentHandle{agent, dispose()}` | `agents` 服务 |
| 出站事件 | `ctx.on('session/event', (session, event) => …)`；事件信封 `{type, seq, time, data}` | `session/event`（emit 模式） |
| 出站事件类型 | `assistant/message`（`data.message`，content blocks）、`turn/end`（`data.reason.kind`）、`user/message`（`data.id`） | 同上 |
| 设置 | `ctx.settings.register(ns, schema, { base, applies:'live' })`、`ctx.settings.get(ns)` | `settings` 服务 |
| 注册工具 | `ctx.tools.register(defineTool({ name, description, parameters, output:{schema,render}, execute }))` | `@deepseek-ai/dsh-tools` |
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

## 6. 下一步实现计划

### M2 —— OneBot（NapCat）传输层【建议的接入点】

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

---

## 8. 验证手册（改完照这个顺序验）

```powershell
# 1) 语法
node --check index.js

# 2) 离线冒烟（策略分支 + 工具注册）
node test-smoke.mjs            # 期望 ALL PASS，概率实测 ≈5%

# 3) 从 profile 里做加载检查
cd "$env:USERPROFILE\.dsh\profiles\web"
node -e "import('dsh-qq-bridge').then(m=>console.log(m.name, JSON.stringify(m.inject))).catch(e=>{console.error(e.message);process.exit(1)})"
# 期望：qq-bridge ["agents","tools","settings"]

# 4) 安装 + 组合检查
dsh plugin --profile web add "<REPO>"
dsh --profile web --dump-config | Select-String "qq-bridge"     # 应看到 # == dsh-qq-bridge
# 5) 重启 dsh web 后，在会话里调用调试工具：
#    qq_bridge_status                → 看设置 / 目标会话是否加载
#    qq_bridge_simulate {dryRun:true} → 只看决策，不消耗 token
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

## 11. 附：核心代码索引（`index.js`）

| 位置（函数） | 作用 |
|---|---|
| `apply(ctx, config)` | 入口：注册 settings、状态、事件、工具 |
| `readSettings()` | 合并 settings 命名空间解析值与默认值 |
| `normalize()` / `mentionsNickname()` | 昵称匹配（归一化后包含判断） |
| `isAllowed()` | 白名单 fail-closed 判定 |
| `decide(msg, settings, random)` | **纯函数策略**（drop/wake/record），测试入口 |
| `ensureTargetAgent()` | `agents.get` → `agents.resume`，**绝不回退** |
| `handleInbound(msg)` | **入站总入口**（M2 直接调它） |
| `renderInbound()` / `renderDigest()` | 唤醒消息渲染（含未唤醒聊天摘要） |
| `messageText()` | 从 assistant content blocks 抽文本 |
| `sendToQQ(text)` | **M2 要替换的桩** |
| `loadState()` / `saveState()` / `pushLog()` | 状态持久化 |
| `qq_bridge_status` / `qq_bridge_simulate` | 调试工具 |
