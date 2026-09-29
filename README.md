# dsh-qq-bridge

把一个**固定的 DSH 会话**接到 QQ（OneBot / NapCat 个人号），**保留原上下文**。

设计见 [`DESIGN.md`](./DESIGN.md)。当前进度：**M1 已完成**（固定的会话注入 + 唤醒策略 + 出站采集 + 调试工具）。

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

## 设置项（settings 命名空间 `qq-bridge`）

| 键 | 默认 | 说明 |
|---|---|---|
| `targetSessionId` | — | 固定目标会话 id |
| `nicknames` | `['244','猫猫']` | 命中即唤醒 |
| `wakeProbability` | `0.05` | 非昵称消息唤醒概率 |
| `whitelist` / `groupWhitelist` | `[]` | 私聊 / 群白名单（**空 = 谁都不能唤醒**） |
| `attachRecentChat` / `recentChatLimit` | `true` / `20` | 未唤醒聊天是否附给下次唤醒、条数 |
| `replyMaxChars` | `1500` | 出站分段上限 |

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

## 调试工具（`debugTools: true` 时注册）

- `qq_bridge_status` — 设置、目标会话是否已加载、未唤醒缓冲条数、最近唤醒日志、待发文本。
- `qq_bridge_simulate` — 模拟一条 QQ 入站消息走完整策略；`dryRun: true` 只看决策不注入。

## 路线

- **M1** ✅ 固定会话注入 / 显式 resume / 唤醒策略 / 出站采集 / 调试工具
- **M2** ⏳ OneBot(NapCat) 传输：入站 WS/HTTP → `handleInbound()`；出站 → `sendToQQ()`
- **M3** ⏳ 设置界面（昵称 chips / 白名单 / 概率滑块 / 目标会话选择 / 唤醒日志）+ 审批桥接
