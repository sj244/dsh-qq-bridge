// dsh-qq-bridge — 把一个「固定的」DSH 会话接到 QQ（OneBot / NapCat）。
//
// 设计见同目录 DESIGN.md。核心两点：
//   1) 唤醒策略：白名单(fail-closed) → 命中昵称/@ 必唤醒 → 否则按概率(默认 5%)唤醒
//      → 其余只进「最近聊天缓冲」，在下一次唤醒时作为上下文附上（期间零模型调用）。
//   2) 目标会话显式加载：agents.get(id) 拿不到就 agents.resume(resumeSessionId) 拉起来，
//      并且【绝不】回退到别的会话（dsh-cron 的已知坑：roots() 找不到就投给活动会话）。
//
// M1：以上全部 + 出站文本采集 + 调试工具。
// M2：OneBot 传输层（见 onebot.js）——WS 入站映射到 handleInbound()，
//     出站文本按 replyMaxChars 分段发给「最后一次入站的目的地」。
//     传输细节（内置 WebSocket、token 走查询串、退避重连）全部封装在 onebot.js。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createOneBotTransport } from './onebot.js'

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
  debugTools: Schema.boolean().default(true).description('注册 qq_bridge_* 调试工具。'),
  // ── M2：OneBot 传输 ────────────────────────────────────────────────────────
  onebotUrl: Schema.string().default('').description('NapCat 的正向 WS 地址，如 ws://127.0.0.1:3001；留空 = 不启用传输。'),
  accessTokenEnv: Schema.string().default('').role('credential-ref').description('存放 access_token 的凭据引用名（环境变量名），经 ctx.credentials 解析；不要明文写 token。'),
  selfId: Schema.string().default('').description('机器人自己的 QQ 号；留空则连上后调 get_login_info 自动获取。'),
  replyWithQuote: Schema.boolean().default(false).description('回复时引用触发那条消息（[CQ:reply]）。'),
  atOnlyInGroup: Schema.boolean().default(false).description('群里只有被 @ 才处理（比概率唤醒更严的闸门）。'),
  stripMarkdown: Schema.boolean().default(true).description('出站前去掉 Markdown 标记（QQ 不渲染）。'),
  heartbeatTimeoutMs: Schema.number().default(90000).description('多久没有任何 WS 流量就判定连接已死并重连。'),
  // 以下是 settings 命名空间的 composition base（装好的默认值）：
  // 设置界面里的用户层会覆盖它们。
  nicknames: Schema.array(Schema.string()).default(['244']),
  wakeProbability: Schema.number().default(0.05),
  whitelist: Schema.array(Schema.string()).default([]),
  groupWhitelist: Schema.array(Schema.string()).default([]),
})

// 用户可编辑设置：注册成 settings 命名空间后，会持久化到 settings.yaml，
// 并出现在 Settings 界面里（昵称 / 白名单 / 概率 / 目标会话 / 传输都在这）。
const BridgeSettings = Schema.object({
  targetSessionId: Schema.string().default(''),
  nicknames: Schema.array(Schema.string()).default(['244']),
  wakeProbability: Schema.number().default(0.05),
  whitelist: Schema.array(Schema.string()).default([]),
  groupWhitelist: Schema.array(Schema.string()).default([]),
  attachRecentChat: Schema.boolean().default(true),
  recentChatLimit: Schema.number().default(20),
  replyMaxChars: Schema.number().default(1500),
  // M2
  onebotUrl: Schema.string().default(''),
  accessTokenEnv: Schema.string().default('').role('credential-ref'),
  selfId: Schema.string().default(''),
  replyWithQuote: Schema.boolean().default(false),
  atOnlyInGroup: Schema.boolean().default(false),
  stripMarkdown: Schema.boolean().default(true),
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
      onebotUrl: config.onebotUrl ?? '',
      accessTokenEnv: config.accessTokenEnv ?? '',
      selfId: config.selfId ?? '',
      replyWithQuote: config.replyWithQuote === true,
      atOnlyInGroup: config.atOnlyInGroup === true,
      stripMarkdown: config.stripMarkdown !== false,
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
      onebotUrl: String(s.onebotUrl ?? config.onebotUrl ?? '').trim(),
      accessTokenEnv: String(s.accessTokenEnv ?? config.accessTokenEnv ?? '').trim(),
      selfId: String(s.selfId ?? config.selfId ?? '').trim(),
      replyWithQuote: s.replyWithQuote === true,
      atOnlyInGroup: s.atOnlyInGroup === true,
      stripMarkdown: s.stripMarkdown !== false,
      heartbeatTimeoutMs: Math.max(10000, Number(config.heartbeatTimeoutMs ?? 90000)),
    }
  }

  // ── state (最近聊天缓冲 / 唤醒日志 / 出站采集 / 出站目的地) ──────────────────

  const statePath = config.statePath || join(home, 'qq-bridge-state.json')
  const state = { buffer: [], log: [], outbox: [], lastDestination: null, lastMessageId: null }
  loadState()

  function loadState() {
    try {
      if (!existsSync(statePath)) return
      const raw = JSON.parse(readFileSync(statePath, 'utf8'))
      if (Array.isArray(raw?.buffer)) state.buffer = raw.buffer.slice(-MAX_BUFFER)
      if (Array.isArray(raw?.log)) state.log = raw.log.slice(-MAX_LOG)
      if (Array.isArray(raw?.outbox)) state.outbox = raw.outbox.slice(-MAX_OUTBOX)
      if (raw?.lastDestination && typeof raw.lastDestination === 'object') state.lastDestination = raw.lastDestination
      if (raw?.lastMessageId !== undefined) state.lastMessageId = raw.lastMessageId
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
    // M2：群里的额外闸门 —— 没被 @ 就完全不处理（比概率唤醒更严）。
    if (msg.groupId && s.atOnlyInGroup && msg.atSelf !== true) return { action: 'drop', reason: 'group-not-at' }
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

  /** 记住「这条消息是谁从哪儿发的」，出站回复用它当目的地。 */
  function rememberDestination(msg) {
    if (msg.groupId) state.lastDestination = { kind: 'group', groupId: String(msg.groupId) }
    else if (msg.userId) state.lastDestination = { kind: 'private', userId: String(msg.userId) }
    if (msg.messageId !== undefined && msg.messageId !== null && String(msg.messageId) !== '') {
      state.lastMessageId = String(msg.messageId)
    }
    saveState()
  }

  /**
   * 入站总入口（OneBot 传输与调试工具都调它）。
   * msg: { text, userId, nickname?, userName?, groupId?, groupName?, atSelf?, messageId? }
   */
  async function handleInbound(msg) {
    const s = readSettings()
    const d = decide(msg, s)
    pushLog({ kind: 'inbound', decision: d.action, reason: d.reason, who: msg.userId, group: msg.groupId ?? null, text: String(msg.text ?? '').slice(0, 200) })

    // 目的地无论是否唤醒都要记：这样「只记录」期间的闲聊之后也能被回复到。
    if (d.action !== 'drop') rememberDestination(msg)

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
    // 包一层 initiator：WS 回调本身没有发起者，而某些插件会调
    // agents.requireInitiator() 并在无发起者时抛错。
    const send = () => agent.followup(makeMessage(text))
    try {
      ctx.agents.withInitiator(agent, send)
    } catch {
      send()
    }
    state.buffer = [] // 已作为本轮上下文附上，清空避免重复
    saveState()
    logger.info(`woke target session (${d.reason})`)
    return { ...d, delivered: true, sessionId: agent.session?.id ?? null }
  }

  // ── M2 传输层：连接管理 / 入站映射 / 出站发送 ────────────────────────────────

  /**
   * 解析 access_token。
   * 凭据契约要求「每次操作重新解析、不得缓存」，所以这里每次建连都重取，
   * 于是轮换 token 不需要重启进程。
   */
  async function resolveAccessToken() {
    const ref = readSettings().accessTokenEnv
    if (ref === '') return ''
    const credentials = ctx.get('credentials')
    if (credentials) {
      try {
        const hit = await credentials.resolve(ref)
        if (hit?.value) return String(hit.value)
      } catch (error) {
        logger.warn(`credentials.resolve(${ref}) failed: ${error?.message ?? error}`)
      }
    }
    // 凭据服务缺席时退回到进程环境（与 dsh-llm-pi-ai 的处理一致）。
    return String(process.env[ref] ?? '')
  }

  const groupNames = new Map() // groupId -> 群名（懒加载缓存）

  const transport = createOneBotTransport({
    getUrl: () => readSettings().onebotUrl,
    getToken: () => resolveAccessToken(),
    heartbeatTimeoutMs: readSettings().heartbeatTimeoutMs,
    logger,
    onStateChange: (st) => {
      if (st.state === 'open') logger.info(`transport open (self_id=${st.selfId ?? 'unknown'})`)
    },
    onEvent: guarded('onebot/event', (event) => handleOneBotEvent(event)),
  })

  /** OneBot v11 事件 → 现有入站入口。 */
  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return

    // 元事件只用来观察连接健康（心跳），不进策略。
    if (event.post_type === 'meta_event') return

    // 自身消息防回环：message_sent 是我们自己发的；user_id === self_id 同理。
    if (event.post_type === 'message_sent') return
    if (event.post_type !== 'message') return

    const selfId = readSettings().selfId || transport.status().selfId || ''
    const userId = event.user_id === undefined ? null : String(event.user_id)
    if (selfId !== '' && userId === selfId) return

    const inbound = mapOneBotMessage(event, selfId)
    if (!inbound || inbound.text.trim() === '') return

    if (inbound.groupId) {
      // 群名只用于渲染：优先用缓存，拿不到就留空（fail-open，不影响策略）。
      inbound.groupName = groupNames.has(inbound.groupId)
        ? groupNames.get(inbound.groupId)
        : await loadGroupName(inbound.groupId)
    }

    await handleInbound(inbound)
  }

  /**
   * OneBot 消息事件 → handleInbound 的 msg。
   * 兼容 message 为 **array**（用户当前配置）与 string 两种形态。
   */
  function mapOneBotMessage(event, selfId) {
    const message = event.message
    const isGroup = event.message_type === 'group'
    const userId = event.user_id === undefined || event.user_id === null ? null : String(event.user_id)
    let text = ''
    let atSelf = false

    if (Array.isArray(message)) {
      const parts = []
      for (const seg of message) {
        const type = seg?.type
        const data = seg?.data ?? {}
        if (type === 'text') parts.push(String(data.text ?? ''))
        else if (type === 'at') {
          if (selfId !== '' && String(data.qq) === selfId) atSelf = true
        } else if (type === 'face') parts.push(`[表情${data.id ?? ''}]`)
        else if (type === 'image') parts.push('[图片]')
      }
      text = parts.join('')
    } else {
      const raw = String(event.raw_message ?? message ?? '')
      // string 形态下 @ 是 CQ 码；顺便把常见 CQ 码换成可读占位符。
      if (selfId !== '' && new RegExp(`\\[CQ:at,qq=${selfId}(?:,[^\\]]*)?\\]`).test(raw)) atSelf = true
      text = raw
        .replace(/\[CQ:at,qq=([^,\]]+)(?:,[^\]]*)?\]/g, (_m, qq) => (selfId !== '' && String(qq) === selfId ? '' : `@${qq} `))
        .replace(/\[CQ:face,[^\]]*\]/g, '[表情]')
        .replace(/\[CQ:image,[^\]]*\]/g, '[图片]')
        .replace(/\[CQ:[^\]]*\]/g, '')
    }

    return {
      text: text.trim(),
      userId,
      nickname: event.sender?.card || event.sender?.nickname || null,
      groupId: isGroup && event.group_id !== undefined ? String(event.group_id) : null,
      groupName: null,
      atSelf,
      messageId: event.message_id === undefined ? null : String(event.message_id),
    }
  }

  /** 懒加载群名（拿不到就返回 null，不影响策略）。 */
  async function loadGroupName(groupId) {
    if (!transport.isOpen()) return null
    try {
      const info = await transport.call('get_group_info', { group_id: groupId, no_cache: false })
      const name = info?.group_name
      if (name) groupNames.set(String(groupId), String(name))
      return name ?? null
    } catch (error) {
      logger.warn(`get_group_info(${groupId}) failed: ${error?.message ?? error}`)
      return null
    }
  }

  /** 出站前把 Markdown 标记抹掉（QQ 不渲染，留着只是噪音）。 */
  function stripMarkdown(text) {
    return String(text)
      .replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body) => String(body).trim())
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
      .trim()
  }

  /** 按码点切分（不会切坏 emoji 代理对），优先在换行处断，每段不超过 limit。 */
  function chunkText(text, limit) {
    const body = String(text)
    if (body === '') return []
    const chunks = []
    let current = []
    let currentLen = 0
    const flush = () => {
      if (current.length > 0) {
        chunks.push(current.join('\n'))
        current = []
        currentLen = 0
      }
    }

    for (const line of body.split('\n')) {
      const chars = [...line]
      if (chars.length > limit) {
        // 单行超长：先落掉已攒的，再硬切。
        flush()
        let rest = chars
        while (rest.length > limit) {
          chunks.push(rest.slice(0, limit).join(''))
          rest = rest.slice(limit)
        }
        current = [rest.join('')]
        currentLen = rest.length
        continue
      }
      if (current.length > 0 && currentLen + 1 + chars.length > limit) flush()
      current.push(line)
      currentLen = current.length === 1 ? chars.length : currentLen + 1 + chars.length
    }
    flush()
    return chunks
  }

  /**
   * 出站：把目标会话的回复发给「最后一次入站的目的地」。
   * M2 之前这里只是打日志的桩。
   */
  async function sendToQQ(text, destination) {
    const s = readSettings()
    const dest = destination ?? state.lastDestination
    if (!dest?.kind) {
      logger.warn('outbound dropped: no destination yet (还没有任何非丢弃的入站消息)')
      return { sent: 0, dropped: true, reason: 'no-destination' }
    }
    if (!transport.isOpen()) {
      logger.warn('outbound dropped: OneBot transport is not connected')
      return { sent: 0, dropped: true, reason: 'not-connected' }
    }

    const body = s.stripMarkdown ? stripMarkdown(text) : String(text)
    if (body === '') return { sent: 0, dropped: true, reason: 'empty' }

    const chunks = chunkText(body, s.replyMaxChars)
    let sent = 0
    for (const [index, chunk] of chunks.entries()) {
      const segments = []
      // 引用只在第一段带上，避免每段都引用同一条。
      if (s.replyWithQuote && index === 0 && state.lastMessageId) {
        segments.push({ type: 'reply', data: { id: String(state.lastMessageId) } })
      }
      segments.push({ type: 'text', data: { text: chunk } })

      if (dest.kind === 'group') {
        await transport.call('send_group_msg', { group_id: dest.groupId, message: segments })
      } else {
        await transport.call('send_private_msg', { user_id: dest.userId, message: segments })
      }
      sent += 1
    }
    logger.info(`sent ${sent} message(s) to ${dest.kind}:${dest.groupId ?? dest.userId}`)
    return { sent, dropped: false, destination: dest }
  }

  // 传输生命周期：建连、随插件卸载回收；settings 改了地址/token 就重连。
  ctx.effect(() => {
    transport.start()
    return () => transport.dispose()
  })

  // 只有「地址 / token 引用」变了才重连；改昵称、唤醒概率之类不该把连接掐了。
  let lastTransportKey = `${readSettings().onebotUrl}\u0000${readSettings().accessTokenEnv}`
  ctx.on('settings/updated', guarded('settings/updated', (ns) => {
    if (String(ns) !== NS) return
    const s = readSettings()
    const key = `${s.onebotUrl}\u0000${s.accessTokenEnv}`
    if (key === lastTransportKey) return
    lastTransportKey = key
    logger.info('onebot 配置变了，重连')
    transport.reconnectNow()
  }))

  // ── 出站：目标会话的回复 → QQ ────────────────────────────────────────────────

  let pendingReply = null

  ctx.on('session/event', guarded('session/event', (session, event) => {
    const targetId = readSettings().targetSessionId
    if (!targetId || session?.id !== targetId) return
    const data = event?.data ?? {}

    if (event.type === 'assistant/message') {
      // ⚠️ surfaceOp 是事件对象的**顶层**字段（与 type/seq/time/data 同级），不在 data 里。
      // 它是 {op:'replace', startSeq, endSeq} 时表示这条是「替换」而非「追加」，
      // 继续累加会重复，所以直接重算为当前这条。
      const text = messageText(data.message)
      if (!text) return
      pendingReply = event.surfaceOp && event.surfaceOp !== 'append' ? text : pendingReply ? `${pendingReply}\n${text}` : text
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

  // ── 调试工具（config.debugTools 可关） ──────────────────────────────────────

  if (config.debugTools) {
    ctx.tools.register(defineTool({
      name: 'qq_bridge_status',
      description: '查看 qq-bridge 状态：设置、目标会话是否已加载、OneBot 连接状态、最近唤醒日志与待发文本。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        const s = readSettings()
        const live = s.targetSessionId ? ctx.agents.get(s.targetSessionId) : undefined
        return JSON.stringify({
          settings: s,
          targetLoaded: Boolean(live),
          resumedHandles: [...handles.keys()],
          transport: transport.status(),
          lastDestination: state.lastDestination,
          bufferedUnwoken: state.buffer.length,
          recentLog: state.log.slice(-15),
          recentOutbox: state.outbox.slice(-3),
          statePath,
        }, null, 2)
      },
    }))

    ctx.tools.register(defineTool({
      name: 'qq_bridge_send',
      description: '立刻通过 OneBot 发一条消息（调试用，不经过目标会话）。默认发给最后一次入站的目的地。',
      parameters: {
        text: { type: 'string', required: true, description: '要发送的文本。' },
        userId: { type: 'string', description: '私聊目标 QQ 号；与 groupId 二选一，都不给则用最后一次入站目的地。' },
        groupId: { type: 'string', description: '群号；与 userId 二选一。' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const dest = args.groupId
          ? { kind: 'group', groupId: String(args.groupId) }
          : args.userId
            ? { kind: 'private', userId: String(args.userId) }
            : undefined
        try {
          const result = await sendToQQ(args.text, dest)
          return JSON.stringify(result, null, 2)
        } catch (error) {
          return JSON.stringify({ error: error?.message ?? String(error) }, null, 2)
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'qq_bridge_transport',
      description: '查看或操作 OneBot 连接：action=status 看状态，reconnect 强制重连。',
      parameters: {
        action: { type: 'string', description: 'status（默认）或 reconnect。' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        if (args.action === 'reconnect') {
          transport.reconnectNow()
          return JSON.stringify({ ok: true, transport: transport.status() }, null, 2)
        }
        const s = readSettings()
        return JSON.stringify({
          transport: transport.status(),
          onebotUrl: s.onebotUrl,
          accessTokenEnv: s.accessTokenEnv,
          tokenResolved: (await resolveAccessToken()) !== '',
          selfId: s.selfId || transport.status().selfId,
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

  logger.info(`ready (target=${readSettings().targetSessionId || '未设置'}, onebot=${readSettings().onebotUrl || '未配置'}, state=${statePath})`)
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.05
  return Math.max(0, Math.min(1, n))
}
