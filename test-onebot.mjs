// M2 端到端测试：起一个**最小的 OneBot WS 服务器**（手写 RFC 6455，不依赖 ws），
// 用假 ctx 把插件跑起来，验证真实的收发路径。
//
// 为什么不 import 'ws'：插件目录只挂了 @deepseek-ai 一个 junction，ws 解析不到；
// 而这个测试要能被任何 clone 下来的人直接 `node test-onebot.mjs` 跑通。
//
// 运行：node test-onebot.mjs
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from './index.js'

// ── 最小 WebSocket 服务器 ────────────────────────────────────────────────────

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 服务端 → 客户端：不带掩码的文本帧。 */
function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/** 尝试从缓冲区里取出一个完整帧；不完整返回 null。 */
function parseFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < offset + 2) return null
    len = buf.readUInt16BE(offset)
    offset += 2
  } else if (len === 127) {
    if (buf.length < offset + 8) return null
    len = Number(buf.readBigUInt64BE(offset))
    offset += 8
  }
  let mask = null
  if (masked) {
    if (buf.length < offset + 4) return null
    mask = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null
  const payload = Buffer.from(buf.subarray(offset, offset + len))
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  return { total: offset + len, opcode, payload }
}

/** 起一个假 OneBot：记录收到的 action，自动用 echo 回包。 */
function createMockOneBot() {
  const actions = []
  let client = null
  const server = createServer()

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(String(key) + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    client = socket
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const frame = parseFrame(buf)
        if (!frame) break
        buf = buf.subarray(frame.total)
        if (frame.opcode === 0x8) {
          socket.end()
          return
        }
        if (frame.opcode !== 0x1) continue
        let msg
        try {
          msg = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          continue
        }
        actions.push(msg)
        // 假 OneBot 的 action 回包：status/retcode/echo + data。
        const data =
          msg.action === 'get_login_info'
            ? { user_id: 10001, nickname: 'test-bot' }
            : msg.action === 'get_group_info'
              ? { group_id: msg.params?.group_id, group_name: '测试群' }
              : { message_id: 9001 }
        socket.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo })))
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (client === socket) client = null
    })
  })

  return {
    actions,
    get connected() {
      return client !== null
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
      })
    },
    /** 服务端主动推一条 OneBot 事件（模拟 QQ 来消息）。 */
    sendEvent(event) {
      if (!client) throw new Error('mock: no client connected')
      client.write(encodeFrame(JSON.stringify(event)))
    },
    close() {
      return new Promise((resolve) => {
        try {
          client?.destroy()
        } catch {
          /* 已经断了 */
        }
        server.close(() => resolve())
      })
    },
  }
}

// ── 测试脚手架 ───────────────────────────────────────────────────────────────

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let v = false
    try {
      v = await fn()
    } catch {
      v = false
    }
    if (v) return true
    if (Date.now() > deadline) return false
    await sleep(50)
  }
}

function createFakeCtx() {
  const state = { listeners: new Map(), disposers: [], registered: [], warnings: [], followups: [], resolvedSettings: {} }
  const targetAgent = {
    id: 'session-target',
    session: { id: 'session-target' },
    followup: (m) => state.followups.push(m),
    inject: () => {},
  }
  const handle = { agent: targetAgent, dispose: async () => {} }
  const ctx = {
    logger: { info() {}, warn: (m) => state.warnings.push(String(m)) },
    settings: {
      register: (_ns, _schema, opts) => {
        state.resolvedSettings = { ...(opts?.base ?? {}) }
        return {}
      },
      get: () => state.resolvedSettings,
    },
    agents: {
      get: () => undefined,
      roots: () => [],
      resume: async () => handle,
      withInitiator: (_agent, op) => op(),
    },
    tools: { register: (def) => state.registered.push(def) },
    on: (name, fn) => state.listeners.set(name, fn),
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') state.disposers.push(d)
    },
    get: (name) =>
      name === 'credentials'
        ? {
            resolve: async (ref) =>
              String(ref) === 'QQ_BRIDGE_TEST_TOKEN' ? { value: 'tok-123', source: 'test' } : undefined,
          }
        : undefined,
  }
  return { ctx, state, targetAgent }
}

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

// ── 跑 ───────────────────────────────────────────────────────────────────────

const mock = createMockOneBot()
const port = await mock.listen()

const { ctx, state } = createFakeCtx()
const statePath = join(tmpdir(), 'qq-bridge-m2-test.json')
if (existsSync(statePath)) rmSync(statePath)

apply(ctx, {
  targetSessionId: 'session-target',
  agentPreset: '',
  statePath,
  debugTools: true,
  onebotUrl: `ws://127.0.0.1:${port}`,
  accessTokenEnv: 'QQ_BRIDGE_TEST_TOKEN',
  selfId: '',
  replyWithQuote: false,
  atOnlyInGroup: false,
  stripMarkdown: true,
  heartbeatTimeoutMs: 60000,
  nicknames: ['244', '猫猫'],
  wakeProbability: 0, // 非昵称一律走 record，便于断言
  whitelist: ['1001'],
  groupWhitelist: ['2001'],
})

const tool = (n) => state.registered.find((t) => t.name === n)
const transportTool = tool('qq_bridge_transport')
const statusTool = tool('qq_bridge_status')

check('M2 工具已注册（send / transport）', !!tool('qq_bridge_send') && !!transportTool)

// 1) 建连：token 走查询串，建连后自动 get_login_info
const connected = await waitFor(async () => JSON.parse(await transportTool.execute({})).transport.state === 'open')
check('已连上假 OneBot', connected)
check(
  'access_token 通过查询串送出',
  await waitFor(async () => JSON.parse(await transportTool.execute({})).tokenResolved === true),
)
check('连接后调用 get_login_info', mock.actions.some((a) => a.action === 'get_login_info'))
const trInfo = JSON.parse(await transportTool.execute({}))
check('selfId 自动学到', String(trInfo.selfId) === '10001', `selfId=${trInfo.selfId}`)

// 2) 白名单内私聊命中昵称 → 唤醒目标会话
mock.sendEvent({
  post_type: 'message',
  message_type: 'private',
  user_id: 1001,
  self_id: 10001,
  message_id: 555,
  raw_message: '244 在吗',
  message: [{ type: 'text', data: { text: '244 在吗' } }],
  sender: { nickname: '小明' },
})
await waitFor(() => state.followups.length === 1)
check('私聊命中昵称 → 唤醒目标会话', state.followups.length === 1)
check('唤醒文本带 QQ 来源标注', textOf(state.followups[0]).includes('[QQ · 私聊]'), textOf(state.followups[0]).slice(0, 60))

// 3) 防回环：message_sent 与 user_id === self_id 都要忽略
mock.sendEvent({
  post_type: 'message_sent',
  message_type: 'private',
  user_id: 1001,
  self_id: 10001,
  raw_message: '我自己发的',
  message: [{ type: 'text', data: { text: '我自己发的' } }],
})
mock.sendEvent({
  post_type: 'message',
  message_type: 'private',
  user_id: 10001,
  self_id: 10001,
  raw_message: '244',
  message: [{ type: 'text', data: { text: '244' } }],
})
await sleep(250)
check('message_sent / self_id 消息被忽略（防回复死循环）', state.followups.length === 1)

// 4) 白名单外 → drop
mock.sendEvent({
  post_type: 'message',
  message_type: 'private',
  user_id: 9999,
  self_id: 10001,
  raw_message: '244 在吗',
  message: [{ type: 'text', data: { text: '244 在吗' } }],
  sender: { nickname: '路人' },
})
await sleep(250)
check('白名单外被丢弃', state.followups.length === 1)

// 5) 群消息：@ 判定来自 array 里的 at 段
mock.sendEvent({
  post_type: 'message',
  message_type: 'group',
  group_id: 2001,
  user_id: 1001,
  self_id: 10001,
  message_id: 556,
  raw_message: '[CQ:at,qq=10001] 244',
  message: [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 244' } },
  ],
  sender: { nickname: '小明', card: '群名片小明' },
})
await waitFor(() => state.followups.length === 2)
check('群内被 @ → 唤醒', state.followups.length === 2)
check('群渲染用了群名', textOf(state.followups[1]).includes('测试群'), textOf(state.followups[1]).slice(0, 60))

// 5.5) 表情包：只发一个 mface、不带文字 —— **不能整条被丢掉**
mock.sendEvent({
  post_type: 'message',
  message_type: 'private',
  user_id: 1001,
  self_id: 10001,
  raw_message: '[CQ:mface]',
  message: [{ type: 'mface', data: { summary: '[动画表情]' } }],
  sender: { nickname: '小明' },
})
await sleep(500)
{
  const st = JSON.parse(await statusTool.execute({}))
  const lastLog = st.recentLog[st.recentLog.length - 1]
  check('纯表情包消息没被丢掉', String(lastLog?.text ?? '').includes('表情'), JSON.stringify(lastLog))
}

// 5.6) 纯图片消息：即使拿不到 attachments 服务，也不能整条丢掉
mock.sendEvent({
  post_type: 'message',
  message_type: 'private',
  user_id: 1001,
  self_id: 10001,
  raw_message: '[CQ:image,file=x.png,url=https://example.invalid/x.png]',
  message: [{ type: 'image', data: { url: 'https://example.invalid/x.png', file: 'x.png' } }],
  sender: { nickname: '小明' },
})
await sleep(600)
{
  const st = JSON.parse(await statusTool.execute({}))
  const lastLog = st.recentLog[st.recentLog.length - 1]
  check('纯图片消息没被丢掉（占位符兜底）', String(lastLog?.text ?? '').includes('图片'), JSON.stringify(lastLog))
}

// 6) 概率 0 的非昵称 → 只记录
mock.sendEvent({
  post_type: 'message',
  message_type: 'private',
  user_id: 1001,
  self_id: 10001,
  raw_message: '今天天气不错',
  message: [{ type: 'text', data: { text: '今天天气不错' } }],
  sender: { nickname: '小明' },
})
const buffered = await waitFor(async () => JSON.parse(await statusTool.execute({})).bufferedUnwoken >= 1)
check('非昵称 → 只记录（进缓冲，零模型调用）', buffered)
check('记录不改动唤醒次数', state.followups.length === 2)

// 7) 出站：目标会话回复 → 发回最后一次入站目的地
const onSessionEvent = state.listeners.get('session/event')
check('session/event 监听已注册', typeof onSessionEvent === 'function')

// 出站闸门现在看**来源**：只有「QQ 唤醒的那一轮」才允许出站（index.js 的 turnFromQQ）。
// 真实链路里这个标记由 handleInbound 注入时置位；这里手工补一条我们自己的 user/message，
// 否则 fire 出来的 assistant/message 会被正确地判成"不是 QQ 轮"而不发。
const asQQTurn = () =>
  onSessionEvent(
    { id: 'session-target' },
    { type: 'user/message', seq: 0, time: Date.now(), data: { source: { kind: 'plugin', plugin: 'qq-bridge' } } },
  )

mock.actions.length = 0
// 7a) 没有 [QQ] 标记 → 一个字都不该发出去（这一轮确实是 QQ 唤醒的，所以测的是标记规则本身）
asQQTurn()
onSessionEvent(
  { id: 'session-target' },
  {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '这些技术说明不该进群' }] } },
  },
)
onSessionEvent(
  { id: 'session-target' },
  { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
)
await sleep(400)
check('无 [QQ] 标记 → 不发送', mock.actions.filter((a) => a.action === 'send_private_msg').length === 0)

// 7b) 有标记 → 只发块内内容，块外的文字不发
asQQTurn()
onSessionEvent(
  { id: 'session-target' },
  {
    type: 'assistant/message',
    seq: 3,
    time: Date.now(),
    data: {
      turn: 2,
      step: 1,
      message: { content: [{ type: 'text', text: '先说一堆给 DSH 看的技术细节。\n[QQ]**你好**，我是 244[/QQ]\n后面还有一堆废话。' }] },
    },
  },
)
onSessionEvent(
  { id: 'session-target' },
  { type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } },
)
const sentOk = await waitFor(() => mock.actions.some((a) => a.action === 'send_private_msg'))
check('出站发到私聊', sentOk)
const first = mock.actions.find((a) => a.action === 'send_private_msg')
check('目的地 = 最后一次入站发送者', String(first?.params?.user_id) === '1001', JSON.stringify(first?.params?.user_id))
const outText = (first?.params?.message ?? []).map((s) => s.data?.text ?? '').join('')
check('只发标记块内的内容', !outText.includes('技术细节') && !outText.includes('废话'), outText)
check('Markdown 标记已去除', !outText.includes('**') && outText.includes('你好'), outText)

// 8) 长回复按 replyMaxChars 分段
// 注意：插件对 replyMaxChars 有下限保护（readSettings 里 Math.max(100, …)），
// 所以这里取 100，而不是更小的值。
state.resolvedSettings.replyMaxChars = 100
mock.actions.length = 0
const longText = Array.from({ length: 20 }, (_, i) => `第${i + 1}行内容`).join('\n')
asQQTurn()
onSessionEvent(
  { id: 'session-target' },
  { type: 'assistant/message', seq: 5, time: Date.now(), data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: `[QQ]${longText}[/QQ]` }] } } },
)
onSessionEvent(
  { id: 'session-target' },
  { type: 'turn/end', seq: 6, time: Date.now(), data: { turn: 3, reason: { kind: 'completed' } } },
)
await waitFor(() => mock.actions.filter((a) => a.action === 'send_private_msg').length >= 2)
const chunks = mock.actions.filter((a) => a.action === 'send_private_msg')
check('长回复被分段', chunks.length >= 2, `段数=${chunks.length}`)
check(
  '每段不超过 replyMaxChars',
  chunks.every((c) => (c.params.message ?? []).reduce((n, s) => n + [...(s.data?.text ?? '')].length, 0) <= 100),
)

// 9) replyWithQuote：首段带 reply 段，引用触发那条消息（群消息 556 是最后一次带 id 的入站）
state.resolvedSettings.replyWithQuote = true
mock.actions.length = 0
asQQTurn()
onSessionEvent(
  { id: 'session-target' },
  { type: 'assistant/message', seq: 7, time: Date.now(), data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: '[QQ]好[/QQ]' }] } } },
)
onSessionEvent(
  { id: 'session-target' },
  { type: 'turn/end', seq: 8, time: Date.now(), data: { turn: 4, reason: { kind: 'completed' } } },
)
await waitFor(() => mock.actions.some((a) => a.action === 'send_private_msg'))
const quoted = mock.actions.find((a) => a.action === 'send_private_msg')
check(
  'replyWithQuote 首段为 reply 段',
  quoted?.params?.message?.[0]?.type === 'reply' && String(quoted.params.message[0].data.id) === '556',
  JSON.stringify(quoted?.params?.message?.[0] ?? null),
)

// 9.5) 摘要上限：灌一批长消息后唤醒，附上的摘要必须被限额、并注明省略了几条
{
  state.resolvedSettings.recentChatLimit = 20 // 故意要 20 条，看总额度管不管得住
  const filler = 'F'.repeat(400)
  for (let i = 0; i < 10; i++) {
    mock.sendEvent({
      post_type: 'message',
      message_type: 'private',
      user_id: 1001,
      self_id: 10001,
      raw_message: filler,
      message: [{ type: 'text', data: { text: filler } }],
      sender: { nickname: '灌水怪' },
    })
  }
  await sleep(800)
  const beforeN = state.followups.length
  mock.sendEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 1001,
    self_id: 10001,
    message_id: 777,
    raw_message: '244',
    message: [{ type: 'text', data: { text: '244' } }],
    sender: { nickname: '灌水怪' },
  })
  await waitFor(() => state.followups.length > beforeN)
  const wake = textOf(state.followups[state.followups.length - 1])
  const m = wake.match(/\[QQ 未唤醒期间聊天记录[^\n]*\n([\s\S]*?)\n\[记录结束\]/)
  check('摘要被附上', Boolean(m), wake.slice(0, 60))
  check('摘要注明省略了更早的消息', /已省略/.test(wake), (wake.match(/最近 \d+ 条[^\]]*\]/) || [''])[0])
  check('摘要正文不超过 1200 字', !m || m[1].length <= 1200, m ? `${m[1].length} 字` : 'n/a')
}

// 9.7) **只 @ 一下、不带文字**：必须唤醒，不能被"文本为空"静默丢弃（真机踩过）
{
  const beforeN = state.followups.length
  mock.sendEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 2001,
    user_id: 1001,
    self_id: 10001,
    message_id: 888,
    raw_message: '[CQ:at,qq=10001] ',
    message: [
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' ' } },
    ],
    sender: { nickname: '小明', card: '群名片小明' },
  })
  await waitFor(() => state.followups.length > beforeN)
  check('只 @ 一下（无文字）也会唤醒', state.followups.length > beforeN, `followups ${beforeN} -> ${state.followups.length}`)
}

// 10) 卸载：传输必须干净停掉
for (const d of state.disposers) await d()
check('dispose 后连接已关闭', await waitFor(() => mock.connected === false, 2000))
await mock.close()

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (state.warnings.length) console.log('warnings:', state.warnings.slice(0, 5))
process.exit(failed === 0 ? 0 : 1)
