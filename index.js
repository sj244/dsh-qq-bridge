// dsh-qq-bridge — 把一个「固定的」DSH 会话接到 QQ（OneBot / NapCat）。
//
// 设计见同目录 DESIGN.md。核心两点：
//   1) 唤醒策略：白名单(fail-closed) → 命中昵称/@ 必唤醒 → 否则按概率(默认 5%)唤醒
//      → 其余只进「最近聊天缓冲」，在下一次唤醒时作为上下文附上（期间零模型调用）。
//   2) 目标会话显式加载：agents.get(id) 拿不到就 agents.resume(resumeSessionId) 拉起来，
//      并且【绝不】回退到别的会话（dsh-cron 的已知坑：roots() 找不到就投给活动会话）。
//
// M1 范围：以上全部 + 出站文本采集 + 调试工具。QQ 传输（OneBot）在 M2 接入，
// 届时只需调用本文件的 handleInbound()，并把出站文本交给 sendToQQ()。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'qq-bridge'

export const inject = ['agents', 'tools', 'settings']

const NS = 'qq-bridge'
const PLUGIN_TAG = 'qq-bridge'
const MAX_BUFFER = 200
const MAX_LOG = 200
const MAX_OUTBOX = 50

export const Config = Schema.object({
  targetSessionId: Schema.string().default('').description('固定目标会话 id；留空则用 settings 里的值。'),
  agentPreset: Schema.string().default('').description('resume 目标会话时挂载的 preset；留空沿用 header 记录。'),
  statePath: Schema.string().default('').description('状态文件路径；留空 = $DSH_HOME/qq-bridge-state.json'),
  debugTools: Schema.boolean().default(true).description('注册 qq_bridge_status / qq_bridge_simulate 调试工具。'),
  // 以下是 settings 命名空间的 composition base（装好的默认值）：
  // 设置界面里的用户层会覆盖它们。
  nicknames: Schema.array(Schema.string()).default(['244']),
  wakeProbability: Schema.number().default(0.05),
  whitelist: Schema.array(Schema.string()).default([]),
  groupWhitelist: Schema.array(Schema.string()).default([]),
})

// 用户可编辑设置：注册成 settings 命名空间后，会持久化到 settings.yaml，
// 并出现在 Settings 界面里（昵称 / 白名单 / 概率 / 目标会话都在这）。
const BridgeSettings = Schema.object({
  targetSessionId: Schema.string().default(''),
  nicknames: Schema.array(Schema.string()).default(['244']),
  wakeProbability: Schema.number().default(0.05),
  whitelist: Schema.array(Schema.string()).default([]),
  groupWhitelist: Schema.array(Schema.string()).default([]),
  attachRecentChat: Schema.boolean().default(true),
  recentChatLimit: Schema.number().default(20),
  replyMaxChars: Schema.number().default(1500),
})

// ─────────────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const logger = {
    info: (m) => ctx.logger?.info?.(`qq-bridge: ${m}`),
    warn: (m) => ctx.logger?.warn?.(`qq-bridge: ${m}`),
  }

  /** 任何回调入口都包一层：插件 bug 绝不能冒泡成宿主崩溃。 */
  function guarded(label, fn) {
    return (...args) => {
      try {
        const out = fn(...args)
        if (out && typeof out.then === 'function') {
          out.catch((e) => logger.warn(`${label} failed: ${e?.message ?? e}`))
        }
        return out
      } catch (error) {
        logger.warn(`${label} failed: ${error?.message ?? error}`)
        return undefined
      }
    }
  }

  // ── settings ───────────────────────────────────────────────────────────────

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  ctx.settings.register(NS, BridgeSettings, {
    base: {
      targetSessionId: config.targetSessionId || '',
      nicknames: config.nicknames ?? ['244'],
      wakeProbability: config.wakeProbability ?? 0.05,
      whitelist: config.whitelist ?? [],
      groupWhitelist: config.groupWhitelist ?? [],
    },
    applies: 'live',
  })

  function readSettings() {
    let stored
    try {
      stored = ctx.settings.get(NS)
    } catch {
      stored = undefined
    }
    const s = { ...(stored ?? {}) }
    return {
      targetSessionId: String(s.targetSessionId || config.targetSessionId || '').trim(),
      nicknames: (s.nicknames ?? ['244']).map((n) => String(n)).filter((n) => n !== ''),
      wakeProbability: clamp01(Number(s.wakeProbability ?? 0.05)),
      whitelist: (s.whitelist ?? []).map(String),
      groupWhitelist: (s.groupWhitelist ?? []).map(String),
      attachRecentChat: s.attachRecentChat !== false,
      recentChatLimit: Math.max(0, Math.min(200, Number(s.recentChatLimit ?? 20))),
      replyMaxChars: Math.max(100, Number(s.replyMaxChars ?? 1500)),
    }
  }

  // ── state (最近聊天缓冲 / 唤醒日志 / 出站采集) ───────────────────────────────

  const statePath = config.statePath || join(home, 'qq-bridge-state.json')
  const state = { buffer: [], log: [], outbox: [] }
  loadState()

  function loadState() {
    try {
      if (!existsSync(statePath)) return
      const raw = JSON.parse(readFileSync(statePath, 'utf8'))
      if (Array.isArray(raw?.buffer)) state.buffer = raw.buffer.slice(-MAX_BUFFER)
      if (Array.isArray(raw?.log)) state.log = raw.log.slice(-MAX_LOG)
      if (Array.isArray(raw?.outbox)) state.outbox = raw.outbox.slice(-MAX_OUTBOX)
    } catch (error) {
      logger.warn(`state load failed: ${error?.message ?? error}`)
    }
  }

  function saveState() {
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      const tmp = `${statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, statePath)
    } catch (error) {
      logger.warn(`state save failed: ${error?.message ?? error}`)
    }
  }

  function pushLog(entry) {
    state.log.push({ at: Date.now(), ...entry })
    if (state.log.length > MAX_LOG) state.log = state.log.slice(-MAX_LOG)
    saveState()
  }

  // ── 唤醒策略 ───────────────────────────────────────────────────────────────

  function normalize(text) {
    return String(text ?? '')
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[，。！？、,.!?~～:：;；"'“”‘’()（）\[\]【】<>《》]/g, '')
  }

  function mentionsNickname(text, nicknames) {
    const n = normalize(text)
    if (n === '') return false
    return nicknames.some((nick) => {
      const k = normalize(nick)
      return k !== '' && n.includes(k)
    })
  }

  function isAllowed(msg, s) {
    if (msg.groupId) {
      return s.groupWhitelist.length === 0 ? false : s.groupWhitelist.includes(String(msg.groupId))
    }
    return s.whitelist.length === 0 ? false : s.whitelist.includes(String(msg.userId))
  }

  /**
   * 纯函数式决策，便于测试：返回 {action:'drop'|'wake'|'record', reason}
   * random 注入以便复现。
   */
  function decide(msg, s, random = Math.random) {
    if (!isAllowed(msg, s)) return { action: 'drop', reason: 'not-allowlisted' }
    if (msg.atSelf === true) return { action: 'wake', reason: 'at-mention' }
    if (mentionsNickname(msg.text, s.nicknames)) return { action: 'wake', reason: 'nickname' }
    if (random() < s.wakeProbability) return { action: 'wake', reason: 'probability' }
    return { action: 'record', reason: 'sampled-out' }
  }

  // ── 目标会话（显式加载，绝不回退） ──────────────────────────────────────────

  const handles = new Map() // sessionId -> AgentHandle

  async function ensureTargetAgent() {
    const s = readSettings()
    const id = s.targetSessionId
    if (!id) throw new Error('未配置 targetSessionId')

    const live = ctx.agents.get(id)
    if (live) return live

    const held = handles.get(id)
    if (held) return held.agent

    // 显式 resume：这是与 dsh-cron 的关键差异 —— 目标会话没开着也能被唤醒。
    const handle = await ctx.agents.resume({
      resumeSessionId: id,
      ...(config.agentPreset ? { setup: mountPreset } : {}),
    })
    handles.set(id, handle)
    logger.info(`resumed target session ${id}`)
    return handle.agent
  }

  /** resume 时把 preset 挂到该 agent 的 setup 上（可选）。 */
  async function mountPreset(agentCtx) {
    const presets = ctx.get('agentPresets')
    if (!presets || !config.agentPreset) return
    await presets.mount(agentCtx, config.agentPreset)
  }

  ctx.effect(() => () => {
    for (const handle of handles.values()) {
      Promise.resolve(handle.dispose()).catch(() => {})
    }
    handles.clear()
  })

  // ── 入站：QQ 消息 → 策略 → 注入 ────────────────────────────────────────────

  function renderInbound(msg) {
    const who = msg.nickname || msg.userName || msg.userId || '未知'
    const where = msg.groupName ? `${msg.groupName}` : '私聊'
    return `[QQ · ${where}] ${who}：${String(msg.text ?? '')}`
  }

  function renderDigest(s) {
    if (!s.attachRecentChat || state.buffer.length === 0) return ''
    const items = state.buffer.slice(-s.recentChatLimit)
    if (items.length === 0) return ''
    const lines = items.map((m) => `${m.nickname || m.userId || '未知'}${m.groupName ? `@${m.groupName}` : ''}: ${m.text}`)
    return `[QQ 未唤醒期间聊天记录 · 最近 ${items.length} 条]\n${lines.join('\n')}\n[记录结束]\n\n`
  }

  function makeMessage(text) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: PLUGIN_TAG },
    })
  }

  /**
   * 入站总入口（M2 的 OneBot 传输也会调它）。
   * msg: { text, userId, nickname?, userName?, groupId?, groupName?, atSelf?, messageId? }
   */
  async function handleInbound(msg) {
    const s = readSettings()
    const d = decide(msg, s)
    pushLog({ kind: 'inbound', decision: d.action, reason: d.reason, who: msg.userId, group: msg.groupId ?? null, text: String(msg.text ?? '').slice(0, 200) })

    if (d.action === 'drop') return { ...d, delivered: false }

    if (d.action === 'record') {
      state.buffer.push({
        at: Date.now(),
        userId: msg.userId ?? null,
        nickname: msg.nickname ?? null,
        groupId: msg.groupId ?? null,
        groupName: msg.groupName ?? null,
        text: String(msg.text ?? ''),
      })
      if (state.buffer.length > MAX_BUFFER) state.buffer = state.buffer.slice(-MAX_BUFFER)
      saveState()
      return { ...d, delivered: false }
    }

    const agent = await ensureTargetAgent()
    const text = `${renderDigest(s)}${renderInbound(msg)}`
    agent.followup(makeMessage(text))
    state.buffer = [] // 已作为本轮上下文附上，清空避免重复
    saveState()
    logger.info(`woke target session (${d.reason})`)
    return { ...d, delivered: true, sessionId: agent.session?.id ?? null }
  }

  // ── 出站：目标会话的回复 → QQ（M2 接传输，此处先采集） ────────────────────────

  let pendingReply = null

  ctx.on('session/event', guarded('session/event', (session, event) => {
    const targetId = readSettings().targetSessionId
    if (!targetId || session?.id !== targetId) return
    const data = event?.data ?? {}

    if (event.type === 'assistant/message') {
      const text = messageText(data.message)
      if (!text) return
      pendingReply = pendingReply ? `${pendingReply}\n${text}` : text
      return
    }

    if (event.type === 'turn/end') {
      const kind = typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown'
      const text = pendingReply
      pendingReply = null
      if (!text) return
      state.outbox.push({ at: Date.now(), sessionId: session.id, endReason: kind, text: text.slice(0, 4000) })
      if (state.outbox.length > MAX_OUTBOX) state.outbox = state.outbox.slice(-MAX_OUTBOX)
      saveState()
      sendToQQ(text).catch((e) => logger.warn(`sendToQQ failed: ${e?.message ?? e}`))
    }
  }))

  function messageText(message) {
    const blocks = Array.isArray(message?.content) ? message.content : []
    return blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }

  /**
   * M2 的传输出口。M1 只打日志（并把文本留在 outbox 里供 status 查看）。
   * 接 OneBot 时把这里换成 WS action: send_private_msg / send_group_msg。
   */
  async function sendToQQ(text) {
    logger.info(`outbound (transport not wired yet): ${text.slice(0, 120)}`)
  }

  // ── 调试工具（M1 验证用；config.debugTools 可关） ───────────────────────────

  if (config.debugTools) {
    ctx.tools.register(defineTool({
      name: 'qq_bridge_status',
      description: '查看 qq-bridge 状态：当前设置、目标会话是否已加载、最近唤醒日志与待发文本。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        const s = readSettings()
        const live = s.targetSessionId ? ctx.agents.get(s.targetSessionId) : undefined
        return JSON.stringify({
          settings: s,
          targetLoaded: Boolean(live),
          resumedHandles: [...handles.keys()],
          bufferedUnwoken: state.buffer.length,
          recentLog: state.log.slice(-15),
          recentOutbox: state.outbox.slice(-3),
          statePath,
        }, null, 2)
      },
    }))

    ctx.tools.register(defineTool({
      name: 'qq_bridge_simulate',
      description: '模拟一条 QQ 入站消息，走完整唤醒策略（不改白名单的话默认会被丢弃）。用于验证昵称唤醒 / 概率唤醒 / 只记录三条分支。',
      parameters: {
        text: { type: 'string', required: true, description: 'QQ 消息文本。' },
        userId: { type: 'string', description: '私聊发送者 id（需在白名单内）。' },
        groupId: { type: 'string', description: '群 id（需在群白名单内）。' },
        nickname: { type: 'string', description: '发送者昵称（仅用于渲染与记录）。' },
        atSelf: { type: 'boolean', description: '是否 @ 了机器人。' },
        dryRun: { type: 'boolean', description: 'true 时只返回决策、不注入。' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const s = readSettings()
        const msg = {
          text: args.text,
          userId: args.userId ?? null,
          groupId: args.groupId ?? null,
          nickname: args.nickname ?? null,
          atSelf: args.atSelf === true,
        }
        const preview = decide(msg, s)
        if (args.dryRun) return JSON.stringify({ preview, allowed: isAllowed(msg, s) }, null, 2)
        const result = await handleInbound(msg)
        return JSON.stringify({ decision: result, preview }, null, 2)
      },
    }))
  }

  logger.info(`ready (target=${readSettings().targetSessionId || '未设置'}, state=${statePath})`)
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.05
  return Math.max(0, Math.min(1, n))
}
