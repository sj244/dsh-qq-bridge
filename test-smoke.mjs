// qq-bridge 冒烟测试：用一个假 ctx 直接调 apply()，验证
//  (1) apply 不抛错、注册了 2 个调试工具；
//  (2) 唤醒策略三条分支（白名单外丢弃 / 昵称必唤醒 / 其余按概率）；
// 运行：node test-smoke.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { apply, buildUsagePrompt, extractQQReply, hasLegacySettings, injectedMessageSource, inlineImageNotes, labelForSegment, mapOneBotNotice, normalizeDelivery, normalizeReplyMode, NS, truncateText } from './index.js'
import { hashOfBuffer, loadStickers, saveStickers, shortHash, upsertSticker } from './stickers.js'

// 状态文件必须每次从零开始：这个会话的 $env:TEMP 是固定的，
// 不删的话上一次运行留下的 buffer/log 会串进这一次（测出过"只灌 1 条却显示 9 条"）。
const statePath = process.env.TEMP + '/qq-bridge-smoke.json'
if (existsSync(statePath)) rmSync(statePath, { force: true })

// ── 表情包 / 描述缓存用的夹具（必须在 apply 之前写好）─────────────────────────
// 登记表的路径与宿主半一致：statePath 所在目录。
const stickersJson = join(dirname(statePath), 'qq-bridge-stickers.json')
// 一张真 PNG（只要前 4 个字节对，sniffImageMediaType 就认）。
const CACHED_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
const CACHED_HASH = hashOfBuffer(CACHED_PNG)
const cachedImagePath = join(tmpdir(), `qq-bridge-smoke-image-${CACHED_HASH}.png`)
writeFileSync(cachedImagePath, CACHED_PNG)
{
  const store = loadStickers(stickersJson)
  upsertSticker(store, {
    hash: CACHED_HASH,
    mood: '无语',
    description: '一只无语的猫',
    file: `qq-bridge-stickers/${CACHED_HASH}.png`,
    ext: 'png',
    source: 'group:770156738',
    addedAt: 1,
    sentCount: 0,
    lastSentAt: null,
  })
  saveStickers(stickersJson, store)
}
// 预热状态文件：缓冲里放一条带图的消息。唤醒时它走真实路径（digest.images → describeImage）。
writeFileSync(
  statePath,
  `${JSON.stringify({
    buffer: [
      {
        at: 1,
        userId: 'test-user',
        nickname: '群友',
        groupId: '770156738',
        groupName: null,
        text: '看这个 [图片]',
        images: [{ path: cachedImagePath, mediaType: 'image/png', bytes: CACHED_PNG.length, hash: CACHED_HASH }],
      },
    ],
  }, null, 2)}\n`,
  'utf8',
)

const registered = []
const warnings = []
// settings.get() 在真实运行时返回「composition base + 用户层」的合并值，
// 这里必须如实模拟，否则 config 里的白名单/昵称会被丢掉。
let resolvedSettings = {}
const registeredSettings = []
// 捕获 ctx.on 注册的处理器：出站闸门要看「这一轮是不是 QQ 唤醒的」，只有真的喂事件才测得到
const handlers = {}
// 默认没有 agent；「端到端时序」那条用例会临时塞一个假 agent 进来
let fakeAgent = null
// 恢复会话那条用例会塞这两个：假 sessionQuery + 捕获 resume 收到的参数
let fakeSessionQuery = null
let lastResumeOptions = null
// 「描述缓存命中」用例会塞这两个：假 attachments + 假 llm（统计多模态调用次数）
let fakeAttachments = null
let fakeLlm = null
let visionStreamCalls = 0
/** 宿主半挂出来的 HTTP 路由（webServer 假实现收集用）。 */
const capturedRoutes = []

const ctx = {
  logger: { info() {}, warn: (m) => warnings.push(String(m)) },
  settings: {
    register: (ns, schema, opts) => { registeredSettings.push({ ns, schema }); resolvedSettings = { ...(opts?.base ?? {}) }; return {} },
    get: () => resolvedSettings,
  },
  agents: {
    get: (id) => (fakeAgent && fakeAgent.id === id ? fakeAgent : undefined),
    roots: () => [],
    resume: async (opts) => {
      lastResumeOptions = opts
      throw new Error('smoke: no agent factory')
    },
  },
  tools: { register: (def) => registered.push(def) },
  on: (name, fn) => {
    handlers[name] = fn
    return () => {}
  },
  effect: () => {},
  get: (name) => {
    if (name === 'sessionQuery') return fakeSessionQuery
    if (name === 'attachments') return fakeAttachments
    if (name === 'llm') return fakeLlm
    return undefined
  },
}
// 真实 Cordis ctx 一定有 ctx.inject（可选注入用它）；假 ctx 也补上，
// 这样「设置接口」那条路能被离线测到。
ctx.inject = (_deps, cb) => cb(ctx)
ctx.webServer = {
  register: (route) => {
    capturedRoutes.push(route)
    return () => {}
  },
}

const config = {
  targetSessionId: 'session-smoke',
  agentPreset: '',
  statePath,
  debugTools: true,
  // ⚠️ 必须显式指向一个**不存在**的目录：否则测试结果会依赖本机
  // $DSH_HOME/napcat 的真实状态（那里装过 NapCat 的话，"未安装时 launch 报错"
  // 这条断言就会走到下一个分支而失败）。
  napcatInstallDir: process.env.TEMP + '/qq-bridge-smoke-napcat-absent',
  nicknames: ['244', '猫猫'],
  wakeProbability: 0.05,
  whitelist: ['test-user'],
  groupWhitelist: [],
}

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

apply(ctx, config)
// ⚠️ 后面若干 `{...ctx}` 派生的 ctx 会重新 `apply`，并且**共用同一个 `on`** ——
// 那会覆盖 `handlers['session/event']`。需要主 ctx 时序（主 ctx 的 state 与传输）的用例
// 必须用这里保存的引用，否则喂进去的事件跑在别的 ctx 上（那些 ctx 的 state 是空的）。
const mainSessionHandler = handlers['session/event']
// legacy（0.1.5 形态）宿主上**不该**挂设置接口：老模型读 settings 命名空间、不读设置文件，
// 挂上去只会是"改了不生效"的死接口。⚠️ 这条必须在**其它假 ctx 跑 apply 之前**断言 ——
// 后面那些 `{...ctx}` 会继承主 ctx 的 webServer，往同一个数组里塞路由（第一版就被污染了）。
check('legacy 宿主上不挂设置路由', !capturedRoutes.some((r) => r.path === '/api/qq-bridge/settings'))
// 三个操作按钮**不**受 legacy 门控：它们只管启动与打开，跟"设置值存在哪"无关，两代宿主都要挂。
check(
  'legacy 宿主上也挂 napcat 操作路由（打开 WebUI / 启动 / 打开文件夹）',
  ['/api/qq-bridge/napcat', '/api/qq-bridge/napcat/launch', '/api/qq-bridge/napcat/reveal'].every((p) =>
    capturedRoutes.some((r) => r.path === p && r.kind === 'exact' && typeof r.handler === 'function'),
  ),
  JSON.stringify(capturedRoutes.map((r) => r.path)),
)
console.log('registered tools:', registered.map((t) => t.name).join(', '))
check('apply 未抛错且注册了 7 个工具', registered.length === 7)

const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
const status = registered.find((t) => t.name === 'qq_bridge_status')
check('qq_bridge_simulate 存在', !!sim)
check('qq_bridge_status 存在', !!status)
check('qq_bridge_send 存在（M2）', !!registered.find((t) => t.name === 'qq_bridge_send'))
check('qq_bridge_transport 存在（M2）', !!registered.find((t) => t.name === 'qq_bridge_transport'))
check('qq_bridge_napcat 存在（M5）', !!registered.find((t) => t.name === 'qq_bridge_napcat'))
check('qq_bridge_sticker 存在（表情包）', !!registered.find((t) => t.name === 'qq_bridge_sticker'))

// ★ 描述缓存命中：登记过的图**不调用多模态**，登记里的 description 直接进正文。
//   （用户要求：缓存命中就不调多模态 —— 反复出现的图只描述一次。）
{
  check('stickers：登记表落在 statePath 同目录', existsSync(stickersJson), stickersJson)
  fakeAttachments = {
    imageLimits: { maxImagesPerMessage: 4 },
    saveImage: async ({ mediaType }) => ({ id: 'smoke-att', mediaType }),
  }
  fakeLlm = {
    listProviders: () => [{ id: 'smoke' }],
    listModels: async () => [{ id: 'smoke-vision', provider: 'smoke', inputModalities: ['image'] }],
    stream: () => {
      visionStreamCalls += 1
      throw new Error('llm 不该被调用：这张图已经登记过了')
    },
  }
  let injected = null
  fakeAgent = {
    id: 'session-smoke',
    ctx: { get: () => undefined, effect: () => () => {} },
    status: 'idle',
    followup: (m) => {
      injected = m
    },
  }
  const r = JSON.parse(await sim.execute({ text: '244 看这个图', userId: 'test-user', nickname: '群友' }))
  check('已登记的图：唤醒走通真实路径', r?.decision?.delivered === true, JSON.stringify(r?.decision ?? r))
  const text = String(injected?.content?.[0]?.text ?? '')
  check(
    '已登记的图：描述来自登记表（带短哈希）',
    text.includes(`[图片#${CACHED_HASH.slice(0, 6)}]：一只无语的猫`),
    text.slice(-90).replace(/\n/g, ' '),
  )
  check('已登记的图：一次多模态都没调', visionStreamCalls === 0, `llm.stream 被调 ${visionStreamCalls} 次`)
  fakeAgent = null
  fakeAttachments = null
  fakeLlm = null
  // 上面那次唤醒认领了"下一轮"，会把后面闸门用例的前提顶掉 —— 走一遍 turn/start+turn/end 还原。
  handlers['session/event']({ id: 'session-smoke' }, { type: 'turn/start', data: { turn: 1 } })
  handlers['session/event']({ id: 'session-smoke' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

// status 能跑通
if (status) {
  const s = await status.execute({})
  check('qq_bridge_status 可执行', typeof s === 'string' && s.includes('recentLog'), s.slice(0, 80).replace(/\s+/g, ' '))
}

// 策略分支（dryRun 只看决策，不触碰 agent）
if (sim) {
  const notAllowed = JSON.parse(await sim.execute({ text: '你好', userId: 'stranger', dryRun: true }))
  check('白名单外 → drop', notAllowed.preview.action === 'drop', JSON.stringify(notAllowed.preview))

  const nick = JSON.parse(await sim.execute({ text: '244 在吗', userId: 'test-user', dryRun: true }))
  check('命中昵称 → wake', nick.preview.action === 'wake' && nick.preview.reason === 'nickname', JSON.stringify(nick.preview))

  const at = JSON.parse(await sim.execute({ text: '在吗', userId: 'test-user', atSelf: true, dryRun: true }))
  check('@机器人 → wake', at.preview.action === 'wake' && at.preview.reason === 'at-mention', JSON.stringify(at.preview))

  // 概率：默认 5%，跑 4000 次看落点
  let woke = 0
  const N = 4000
  for (let i = 0; i < N; i++) {
    const r = JSON.parse(await sim.execute({ text: `随便说的第${i}句`, userId: 'test-user', dryRun: true }))
    if (r.preview.action === 'wake') woke++
  }
  const rate = woke / N
  check('非昵称唤醒率 ≈ 5%', rate > 0.03 && rate < 0.08, `实测 ${(rate * 100).toFixed(2)}%`)

  // M2：群里的额外闸门 —— atOnlyInGroup 打开后，群里没被 @ 就完全不处理
  resolvedSettings.atOnlyInGroup = true
  resolvedSettings.groupWhitelist = ['test-group']
  const g1 = JSON.parse(await sim.execute({ text: '244 在吗', groupId: 'test-group', userId: 'test-user', dryRun: true }))
  check('群内未 @ + atOnlyInGroup → drop', g1.preview.action === 'drop' && g1.preview.reason === 'group-not-at', JSON.stringify(g1.preview))
  const g2 = JSON.parse(await sim.execute({ text: '在吗', groupId: 'test-group', userId: 'test-user', atSelf: true, dryRun: true }))
  check('群内被 @ + atOnlyInGroup → wake', g2.preview.action === 'wake', JSON.stringify(g2.preview))
  resolvedSettings.atOnlyInGroup = false
}

// M5：NapCat 托管工具——status 必须能跑通（假 ctx 没有 subprocess，应优雅报告不可用）
{
  const nap = registered.find((t) => t.name === 'qq_bridge_napcat')
  const out = JSON.parse(await nap.execute({ action: 'status' }))
  check('qq_bridge_napcat status 可执行', typeof out.installDir === 'string' && 'installed' in out, JSON.stringify(out.installDir))
  check('无 subprocess 时如实报告', out.subprocessAvailable === false)
  const bad = JSON.parse(await nap.execute({ action: 'nonsense' }))
  check('未知 action 返回错误而非抛异常', typeof bad.error === 'string', bad.error)
  const cannotLaunch = JSON.parse(await nap.execute({ action: 'launch' }))
  check('未安装时 launch 明确报错', typeof cannotLaunch.error === 'string' && cannotLaunch.error.includes('download'), cannotLaunch.error)
}

// 出站闸门：默认只发 [QQ]…[/QQ] 里的内容（否则整轮技术说明都会倒进群里）
{
  check('无标记 → 一个字都不发', extractQQReply('这些技术说明不该进群') === '')
  check('单块 → 只取块内', extractQQReply('前言\n[QQ]在的 👻[/QQ]\n后记') === '在的 👻')
  check('多块 → 按顺序拼接', extractQQReply('[QQ]第一句[/QQ]\n中间\n[QQ]第二句[/QQ]') === '第一句\n\n第二句')
  check('空块 → 忽略', extractQQReply('[QQ]   [/QQ]') === '')
  check('大小写 / 跨行都认', extractQQReply('[qq]\n跨行内容\n[/QQ]') === '跨行内容')
  check('未闭合 → 不发', extractQQReply('[QQ]没有结尾') === '')
  check('空输入安全', extractQQReply(undefined) === '')
  // 关键回归：正文里"提到标记本身"不能把中间正文串进来（真机踩过，一大段正文被发进群）
  const prose = '要给 QQ 看的话放进 [QQ] 里。\n[QQ]你好[/QQ]\n后面是给自己看的技术细节'
  check('正文提及标记不会串味', extractQQReply(prose) === '你好', JSON.stringify(extractQQReply(prose)))
  const two = '技术说明一\n[QQ]第一句[/QQ]\n技术说明二\n[QQ]第二句[/QQ]\n尾注'
  check('两块各自独立抽取', extractQQReply(two) === '第一句\n\n第二句', JSON.stringify(extractQQReply(two)))
  const inline = '前置文字 [QQ]行内的块[/QQ] 后置文字'
  check('行内的块不再被当作块（宁可漏发也不串味）', extractQQReply(inline) === '', JSON.stringify(extractQQReply(inline)))
}

// 上下文上限：别让群里的长文把上下文撑爆
{
  check('短文本不动', truncateText('你好', 500) === '你好')
  check('恰好等于上限不动', truncateText('x'.repeat(500), 500).length === 500)
  const cut = truncateText('x'.repeat(3000), 500)
  check('超长被截断并留标记', cut.length === 500 + '…（已截断）'.length && cut.endsWith('…（已截断）'), `len=${cut.length}`)
  check('max<=0 返回空', truncateText('abc', 0) === '')
  check('非数字 max 返回空', truncateText('abc', undefined) === '')

  // 这一段要的是 record 分支：先把唤醒概率压成 0，
  // 否则 210 条里会有约 10 条抽中 5% 唤醒，而假 ctx 没有 agent 工厂会直接抛错。
  resolvedSettings.wakeProbability = 0

  // 走一遍真实入站：贴一篇长文，缓冲里存下的必须是**截断后**的
  const long = 'A'.repeat(3000)
  await sim.execute({ text: long, userId: 'test-user', nickname: '长文怪' })
  const st = JSON.parse(await status.execute({}))
  const last = st.recentBuffer[st.recentBuffer.length - 1]
  check('长文进缓冲时被截断（不是 3000）', last.len <= 500 + '…（已截断）'.length, `存下 ${last.len} 字符`)
  check('缓冲条数被记录', st.bufferedUnwoken >= 1, `${st.bufferedUnwoken} 条`)

  // 条数上限 200：灌 210 条
  for (let i = 0; i < 210; i++) await sim.execute({ text: `灌水第${i}条`, userId: 'test-user' })
  const st2 = JSON.parse(await status.execute({}))
  check('缓冲条数封顶 200', st2.bufferedUnwoken === 200, `实际 ${st2.bufferedUnwoken}`)
}

// 表情包 / 非文本段：**绝不能变成空字符串**，否则整条消息会被上层丢掉
{
  check('表情 → 有占位符', labelForSegment('face', { id: 4 }) === '[表情4]')
  check('表情包(mface) → 用 summary', labelForSegment('mface', { summary: '[动画表情]' }) === '[表情包:[动画表情]]')
  check('表情包无 summary → 兜底', labelForSegment('mface', {}) === '[表情包]')
  check('图片 → 占位符', labelForSegment('image', {}) === '[图片]')
  check('语音 → 占位符', labelForSegment('record', {}) === '[语音]')
  check('文件 → 带文件名', labelForSegment('file', { name: 'a.zip' }) === '[文件:a.zip]')
  check('合并转发 → 占位符', labelForSegment('forward', {}) === '[合并转发]')
  check('纯元数据段 reply → 跳过', labelForSegment('reply', {}) === '')
  check(
    '关键：每个已知非文本段都不是空串',
    ['face', 'mface', 'image', 'record', 'video', 'file', 'json', 'xml', 'forward', 'poke', 'location', 'music']
      .every((t) => labelForSegment(t, {}) !== ''),
  )
}

// 会话跟随（listening window）：一次性 @ 之后，线性聊天不再需要反复 @
{
  const listen = registered.find((t) => t.name === 'qq_bridge_listen')
  check('qq_bridge_listen 工具存在', !!listen)

  // 开窗前：普通消息走抽样（概率已被前面压成 0）→ record
  const before = JSON.parse(await sim.execute({ text: '没有昵称的一句', userId: 'test-user', dryRun: true }))
  check('开窗前普通消息不唤醒', before.preview.action === 'record', JSON.stringify(before.preview))

  // 开窗（目的地由前面的非 dryRun 调用记为 private:test-user）
  const opened = JSON.parse(await listen.execute({ minutes: 5 }))
  check('开窗成功且 key 正确', opened.key === 'private:test-user', JSON.stringify(opened))

  const during = JSON.parse(await sim.execute({ text: '继续聊，没有 @', userId: 'test-user', dryRun: true }))
  check('窗口内普通消息 → wake(listening)', during.preview.action === 'wake' && during.preview.reason === 'listening', JSON.stringify(during.preview))

  const other = JSON.parse(await sim.execute({ text: '别处来的', userId: 'stranger', dryRun: true }))
  check('窗口只对本目的地生效（别处仍被白名单挡）', other.preview.reason === 'not-allowlisted', JSON.stringify(other.preview))

  // 关窗
  await listen.execute({ off: true })
  const after = JSON.parse(await sim.execute({ text: '关窗之后', userId: 'test-user', dryRun: true }))
  check('关窗后恢复普通策略', after.preview.reason !== 'listening', JSON.stringify(after.preview))

  // 上限保护
  const capped = JSON.parse(await listen.execute({ minutes: 9999 }))
  check('时长被上限截住', capped.minutes === 60, JSON.stringify(capped.minutes))
  await listen.execute({ off: true })
  const st = JSON.parse(await status.execute({}))
  check('status 暴露 listening 字段', 'listening' in st)
}

// ── 主 ctx 的假 WebSocket（出站用例的前置条件）─────────────────────────────
// 主 ctx 的 ctx.effect 是空实现，所以 transport.start() 从来不执行。
// 改 recordOutbox() 之前，这些用例只查台账。台账当时无条件记录，
// 所以每条出站都被判成“发出去”。实际全是 reason='not-connected' 被丢弃，
// 一次真实出站都没发生过。这一段装假 WebSocket 补上真实链路。
//
// 假 WebSocket 之后**不还原**。文件后半段还有几段主 ctx 用例同样要真的发得出去。
// 末尾 registered2 那段自己会保存与还原 globalThis.WebSocket，与这一段不冲突。
const qqSockets = []
{
  // 假 WebSocket：构造后立刻算连上。send() 把帧收进 this.sent，再回一个成功 echo。
  // 写法与文件末尾 registered2 那段一致。
  globalThis.WebSocket = class {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      this.onopen = this.onmessage = this.onclose = this.onerror = null
      qqSockets.push(this)
      setTimeout(() => {
        this.readyState = 1
        this.onopen?.({})
      }, 0)
    }
    send(text) {
      const msg = JSON.parse(String(text))
      this.sent.push(msg)
      const data = msg.action === 'get_login_info' ? { user_id: 10001, nickname: 'fake-bot' } : { message_id: 7001 }
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }) })
      }, 0)
    }
    close() {
      this.readyState = 3
      this.onclose?.({ code: 1000 })
    }
  }
  // 主 config 没有给 onebotUrl。传输要真有地址才建连，所以这里补一个。
  resolvedSettings.onebotUrl = 'ws://127.0.0.1:3001/'
  // reconnectNow() 是主 ctx 里唯一能启动传输的口子（start() 挂在空 effect 上）。
  await registered.find((t) => t.name === 'qq_bridge_transport').execute({ action: 'reconnect' })
  // 等 onopen 与 get_login_info 走完。这之后 transport.isOpen() 才是 true。
  await new Promise((r) => setTimeout(r, 20))
  check('主 ctx：传输真的连上了（transport.state 为 open）', JSON.parse(await status.execute({})).transport.state === 'open')
}

/** 真实出站的文本帧：取 send_group_msg / send_private_msg 里的 text 段，按发送顺序拼好。 */
function sentTexts() {
  const out = []
  for (const s of qqSockets) {
    for (const frame of s.sent ?? []) {
      if (frame.action !== 'send_group_msg' && frame.action !== 'send_private_msg') continue
      const segs = Array.isArray(frame.params?.message) ? frame.params.message : []
      out.push(segs.filter((x) => x?.type === 'text').map((x) => String(x.data?.text ?? '')).join(''))
    }
  }
  return out
}
/** 最后一条真实出站文本。没有任何出站时返回空串。 */
function lastSentText() {
  const a = sentTexts()
  return a.length > 0 ? a[a.length - 1] : ''
}
/** 真实出站里有没有一条包含 s。 */
function sawSentText(s) {
  return sentTexts().some((t) => t.includes(s))
}

// 出站闸门必须看**来源**：只有「QQ 唤醒的那一轮」才允许出站。
// 用户 2026-09-30 报的：「agent 分不清是在 QQ 还是 DSH 里」—— 用法说明是常驻系统提示，
// DSH 界面里的那一轮模型同样看得到标记块规矩，所以闸门不能只看"有没有标记块"。
{
  const fire = (type, data, extra = {}) => handlers['session/event']({ id: 'session-smoke' }, { type, data, ...extra })
  const outbox = async () => JSON.parse(await status.execute({})).recentOutbox
  // ⚠️ status 只暴露 outbox 最后 3 条 —— 断言一律看**最新那条的内容**，不要比长度
  //（长度比到 3 就永远相等，那种断言是"碰巧通过"）。
  // outbox 现在只是**辅助口径**：主判据一律落在 sentTexts() 拿到的真实出站帧上。
  const sawText = (a, s) => a.some((o) => String(o.text ?? '').includes(s))
  const reply = (text) => fire('assistant/message', { message: { content: [{ type: 'text', text }] } })
  const end = () => fire('turn/end', { reason: { kind: 'completed' } })
  // 标记块的出站是异步的：sendToQQ() 要等 transport.call() 的 echo 回包。
  // turn/end 之后立刻查会看不到，所以断言前必须过一个宏任务。
  const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))
  const endA = async () => {
    end()
    await tick()
  }
  // ⚠️ 现在闸门是**按轮快照**的：currentTurnFromQQ 在 turn/start 时从 pendingFromQQ 取。
  // 所以每条场景都要先 fire turn/start（真实链路里 turn/start 一定在 assistant/message 之前）。
  const start = () => fire('turn/start', { turn: 1 })

  // A) 人在 DSH 界面里打字触发的那一轮：即使写了标记块也不出站
  fire('user/message', { source: { kind: 'user' } })
  start()
  reply('[QQ]DSH 里聊出来的标记块不该进群[/QQ]')
  await endA()
  check(
    'DSH 触发的轮次：标记块不出站',
    !sawSentText('DSH 里聊出来的标记块') && !sawText(await outbox(), 'DSH 里聊出来的标记块'),
  )

  // B) QQ 注入的那一轮：正常出站
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  start()
  reply('这段只给 DSH 看\n[QQ]群里看到这句[/QQ]')
  await endA()
  // 判据换成真实出站帧：这一条必须是 socket 上真发出去的 send_private_msg。
  check('QQ 触发的轮次：正常出站且只取块内', lastSentText() === '群里看到这句', JSON.stringify(sentTexts()))

  // C) 工具结果也是 user/message，不能把「这轮来自 QQ」冲掉
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  start()
  fire('user/message', { source: { kind: 'tool' } })
  reply('[QQ]工具跑完后的回复[/QQ]')
  await endA()
  check('工具结果不会冲掉「来自 QQ」的标记', lastSentText() === '工具跑完后的回复', JSON.stringify(sentTexts()))

  // D) 别的插件（cron / goal / 别人）注入的轮次同样不出站
  fire('user/message', { source: { kind: 'plugin', plugin: 'dsh-cron' } })
  start()
  reply('[QQ]cron 那一轮[/QQ]')
  await endA()
  check('别的插件触发的轮次也不出站', !sawSentText('cron 那一轮') && !sawText(await outbox(), 'cron 那一轮'))

  // E) 没有 user/message 直接 turn/end（冷启动等）→ fail-closed
  reply('[QQ]没有来源信息[/QQ]')
  await endA()
  check('没有来源信息时 fail-closed', !sawSentText('没有来源信息') && !sawText(await outbox(), '没有来源信息'))

  // G) **口子①回归**（复查时发现的）：QQ 那一轮还在跑，中途 DSH 里又来了一句
  //    → 那一轮仍然是 QQ 轮，工具/标记块该发就发（单一标时代这里会哑火）。
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  start()
  fire('user/message', { source: { kind: 'user' } }) // 中途插进来的 DSH 消息
  reply('[QQ]这一轮仍然是 QQ 轮，必须发出去[/QQ]')
  await endA()
  check('口子①：轮内插入 DSH 消息不导致哑火', lastSentText() === '这一轮仍然是 QQ 轮，必须发出去', JSON.stringify(sentTexts()))

  // H) **口子②回归**：DSH 那一轮还在跑，中途群里来了 QQ 消息
  //    → 这一轮不是 QQ 轮，一个字都不许发；但**下一条**消息起的那轮才是 QQ 轮。
  fire('user/message', { source: { kind: 'user' } })
  start()
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  reply('[QQ]DSH 那一轮不许发[/QQ]')
  await endA()
  check(
    '口子②：DSH 轮内来的 QQ 消息不会让它误发',
    !sawSentText('DSH 那一轮不许发') && !sawText(await outbox(), 'DSH 那一轮不许发'),
    JSON.stringify(sentTexts()),
  )
  start()
  reply('[QQ]下一条消息起的那轮才是 QQ 轮[/QQ]')
  await endA()
  check('口子②：QQ 消息确实认领了它的下一轮', lastSentText() === '下一条消息起的那轮才是 QQ 轮', JSON.stringify(sentTexts()))

  // I) 多轮延续（同一轮没有新的用户消息）：仍然是 QQ 轮 —— 别因为"turn/end 消费掉了"就哑火
  start()
  reply('[QQ]第二轮延续也发得出去[/QQ]')
  await endA()
  check('多轮延续保持 QQ 轮（turn/end 不吞掉归属）', lastSentText() === '第二轮延续也发得出去', JSON.stringify(sentTexts()))

  // J) **哑火第 3 次回归（真机实测抓到的那条）**：QQ 消息之后紧跟一条 harness 注入的上下文
  //    （`@deepseek-ai/dsh-system-prompt` 发的 "Current runtime context…"，它同样走
  //    user/message + plugin 来源）。它**不是一轮的触发器**，绝不能把 pending 打掉 ——
  //    真机上就是它让 turn/start 快照到 false，于是工具拒绝（用户当场看到"哑火"）。
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  fire('user/message', {
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    message: { id: 'ctx-1', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes…' }] },
  })
  start()
  reply('[QQ]harness 上下文不该抢走这一轮[/QQ]')
  await endA()
  check('哑火③回归：harness 注入的上下文不影响本轮归属', lastSentText() === 'harness 上下文不该抢走这一轮', JSON.stringify(sentTexts()))

  // 但 **harness 上下文不足以认领一轮**：先由真人消息把 pending 打成 false，
  // 再来一条 harness 上下文 —— 它既不能打掉真归属（上面 J），也不能把归属抬起来。
  fire('user/message', { source: { kind: 'user' } })
  fire('user/message', { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } })
  start()
  reply('[QQ]只有 harness 上下文的一轮不该出站[/QQ]')
  await endA()
  check(
    'harness 上下文不足以认领一轮',
    !sawSentText('只有 harness 上下文的一轮') && !sawText(await outbox(), '只有 harness 上下文的一轮'),
    JSON.stringify(sentTexts()),
  )

  // F) **真机哑火回归**：source 被上游重写成 'user'，但正文就是我们注入的 QQ 入站消息
  //    → 必须仍然按「QQ 唤醒的那一轮」算，否则就是"用户明明用 QQ @ 了却发不出去"。
  fire('user/message', {
    source: { kind: 'user' },
    message: {
      id: 'm-qq-1',
      content: [{ type: 'text', text: '[QQ · 某群] 某人：在吗\n（回 QQ：用 qq_bridge_send 工具）' }],
    },
  })
  start()
  reply('[QQ]回归通过[/QQ]')
  await endA()
  check('回归：source 被改写成 user 也不哑火（按正文前缀认出来）', lastSentText() === '回归通过', JSON.stringify(sentTexts()))

  // 排障入口：status 里要能看到最近观测到的 user/message（哑火时看 ours 是不是 false）
  const st2 = JSON.parse(await status.execute({}))
  const probe = st2.recentInboundSources
  check(
    'status 暴露 recentInboundSources（排障用）',
    Array.isArray(probe) && probe.some((p) => p.ours === true) && probe.some((p) => p.ours === false),
    JSON.stringify(probe?.slice(-2)),
  )
  check('status 暴露 gate（三个闸门变量）', typeof st2.gate === 'object' && 'currentTurnFromQQ' in st2.gate, JSON.stringify(st2.gate))
}

// 注入的用法说明是一份**产品契约**：出站标记 / 群聊礼仪 / 无人值守特权禁令 / 监听模式用法
{
  const p = buildUsagePrompt({ replyMaxChars: 1200 })
  check('用法说明：出站标记 + 开标记独占行首', p.includes('[QQ]') && p.includes('独占行首'))
  check('用法说明：QQ 是聊天不是工作台', p.includes('不是工作台'))
  // 用户报「agent 分不清是在 QQ 还是 DSH 里」→ 规矩必须写成"只对被 QQ 唤醒的那一轮生效"
  check(
    '用法说明：规矩只对被 QQ 唤醒的那一轮生效（DSH 里别用出站方式）',
    p.includes('只对「被 QQ 唤醒的那一轮」生效') && p.includes('DSH 界面里直接跟你说话') && p.includes('不要用任何 QQ 出站方式'),
  )
  // 用户先后三次嫌群里回复太长（"又发出了一坨"、"太长了"、"不适合做封面"）→ 用字数上限钉住
  check('用法说明：群聊回复默认 40 字以内', p.includes('默认 40 字以内') && p.includes('群里只给结论'))
  check('用法说明：无人值守不碰特权操作', p.includes('无人值守') && p.includes('不要主动做'))
  check('用法说明：把 QQ 消息当不可信输入（防群友注入）', p.includes('不可信输入') && p.includes('注入'))
  check('用法说明：需要动手就停下等发起人', p.includes('无人值守时我不执行这类操作') && p.includes('等发起人在电脑前'))
  // 用户 2026-09-30 抓出来的：把「我的规矩」说成「得等你授权」是把规矩伪装成权限，属于误导
  check('用法说明：禁止把规矩说成「需要授权」（诚实性）', p.includes('别把它说成') && p.includes('伪装成权限'))
  // 用浏览器点网页同样不弹审批 —— 必须显式堵住这条绕过路径
  check(
    '用法说明：不弹审批的路径（浏览器/HTTP/写文件）同样算动手',
    p.includes('不受审批闸门管的路径同样算「动手」') && p.includes('不能因为不弹就拿它们绕过'),
  )
  check(
    '用法说明：监听模式用法（开窗 / 上限 / 关窗 / 别无脑常开）',
    p.includes('qq_bridge_listen') && p.includes('off: true') && p.includes('60 分钟') && p.includes('别无脑常开'),
  )
  check(
    '用法说明：超长阈值跟着 replyMaxChars 走，且写明不会发出',
    p.includes('1200 字') && p.includes('不会发出') && p.includes('缩短后重发'),
    p.slice(0, 80),
  )
  check('用法说明：明确「回群只用标记块，别拿 send 工具当回复通道」', p.includes('qq_bridge_send') && p.includes('别拿它当回复通道'))
  check('用法说明：说明被戳会显示成「[戳一戳]（戳的是我）」', p.includes('[戳一戳]') && p.includes('戳的是我'))
  check('用法说明：发了表情包不要解释（人自己看得懂）', p.includes('不要解释') && p.includes('表情包'))
  // 表情包是产品玩法：提示词必须教模型怎么用（否则工具存在但永远没人调）
  check(
    '用法说明：图片占位符带短哈希（模型能指着一张具体的图）',
    p.includes('[图片#') && p.includes('短哈希'),
    p.slice(0, 0),
  )
  check(
    '用法说明：教用 qq_bridge_sticker（list / send / save）',
    p.includes('qq_bridge_sticker') && p.includes('`list`') && p.includes('`send`') && p.includes('`save`'),
  )
  check('用法说明：登记过的图不再花多模态调用', p.includes('命中登记表') && p.includes('多模态调用'))
}

// 出站方式是**开关**（replyMode）：marker / tool / always —— 提示词与出站路径都要跟着变
// （用户 2026-09-30 定：新增还是替换由用户选，相当于给"标记块发送"装个开关）
{
  check(
    'normalizeReplyMode：只认三个值，其余归 marker',
    normalizeReplyMode('tool') === 'tool' &&
      normalizeReplyMode('always') === 'always' &&
      normalizeReplyMode('marker') === 'marker' &&
      normalizeReplyMode('乱写') === 'marker' &&
      normalizeReplyMode(undefined) === 'marker',
  )

  const pm = buildUsagePrompt({ replyMaxChars: 1500, replyMode: 'marker' })
  const pt = buildUsagePrompt({ replyMaxChars: 1500, replyMode: 'tool' })
  const pa = buildUsagePrompt({ replyMaxChars: 1500, replyMode: 'always' })
  check('marker 提示词：教标记块 + 别拿工具当通道', pm.includes('[QQ]') && pm.includes('别拿它当回复通道'))
  check('tool 提示词：教调工具、并说明标记块不生效', pt.includes('tool 模式') && pt.includes('标记块在这个模式下不生效'))
  check('tool 提示词里不再教「只用标记块」', !pt.includes('回群**只用标记块**'))
  check('always 提示词：警告整轮都会进群', pa.includes('always 模式') && pa.includes('整轮回复都会原样发到群里'))

  const fire = (type, data) => handlers['session/event']({ id: 'session-smoke' }, { type, data })
  const outbox = async () => JSON.parse(await status.execute({})).recentOutbox
  const lastText = (a) => String(a[a.length - 1]?.text ?? '')
  const sawText = (a, s) => a.some((o) => String(o.text ?? '').includes(s))
  const start = () => fire('turn/start', { turn: 1 })
  const sendTool = registered.find((t) => t.name === 'qq_bridge_send')

  // 切到 tool 模式：标记块这条路被关掉
  resolvedSettings.replyMode = 'tool'
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  start()
  fire('assistant/message', { message: { content: [{ type: 'text', text: '[QQ]tool 模式下标记块应该无效[/QQ]' }] } })
  fire('turn/end', { reason: { kind: 'completed' } })
  check('tool 模式：标记块不出站（开关把它关了）', !sawSentText('tool 模式下标记块应该无效') && !sawText(await outbox(), 'tool 模式下标记块应该无效'))

  // 工具在 DSH 轮里走**两步确认**：第一次只回问、一个字都不发；同一轮里再调一次才真的发。
  // （2026-10-01 用户提议：硬拒绝太死，改成"确认后再发" —— 能力不丢，误发依然要跨一道有意识的动作。）
  fire('user/message', { source: { kind: 'user' } })
  start()
  const asked = JSON.parse(await sendTool.execute({ text: '第一次不该发出去' }))
  check(
    '工具：DSH 轮第一次调用只回确认、不发送',
    asked.needsConfirm === true && asked.sent === 0 && String(asked.reason).includes('DSH'),
    JSON.stringify(asked),
  )
  check('第一次调用不记 outbox', !sawSentText('第一次不该发出去') && !sawText(await outbox(), '第一次不该发出去'))
  const confirmed = JSON.parse(await sendTool.execute({ text: '确认之后发出去' }))
  check(
    '工具：DSH 轮第二次调用真的发送',
    confirmed.refused !== true && confirmed.sent === 1 && lastSentText() === '确认之后发出去' && lastText(await outbox()) === '确认之后发出去',
    JSON.stringify(confirmed),
  )
  const obNonQQ = await outbox()
  check(
    '非 QQ 轮的发送在 outbox 留痕（nonQQTurn）',
    sawSentText('确认之后发出去') && obNonQQ[obNonQQ.length - 1]?.nonQQTurn === true,
    JSON.stringify(obNonQQ[obNonQQ.length - 1]),
  )
  fire('turn/end', { reason: { kind: 'completed' } })

  // 确认状态**不能跨轮泄漏**：新一轮的第一次调用必须重新回问
  fire('user/message', { source: { kind: 'user' } })
  start()
  const again = JSON.parse(await sendTool.execute({ text: '新一轮第一次' }))
  check('确认状态不跨轮：新一轮第一次仍只回确认', again.needsConfirm === true, JSON.stringify(again))
  check('跨轮也不该发出去', !sawSentText('新一轮第一次') && !sawText(await outbox(), '新一轮第一次'))
  fire('turn/end', { reason: { kind: 'completed' } })

  // 工具在 QQ 轮里走通，并记 outbox（via: tool）
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  start()
  const sent = JSON.parse(await sendTool.execute({ text: '工具发出去的话' }))
  const ob = await outbox()
  check(
    '工具：QQ 轮里不再被拒（发送路径走通）',
    sent.refused !== true && sent.sent === 1 && lastSentText() === '工具发出去的话' && lastText(ob) === '工具发出去的话',
    JSON.stringify(sent),
  )
  check(
    '工具发送记进 outbox（via: tool）',
    sawSentText('工具发出去的话') && ob[ob.length - 1]?.via === 'tool',
    JSON.stringify(ob[ob.length - 1]),
  )

  // 复位，别影响后面的块
  resolvedSettings.replyMode = 'marker'
  fire('turn/end', { reason: { kind: 'completed' } })

  // 改 replyMode 会走 settings/updated → 重挂用法说明那条路。
  // 真挂载需要宿主有 systemPrompt 服务（这里没有），所以只验证这条处理器**不抛错** ——
  // 它顺带能挡住"usagePromptMounted 从 Set 改成 Map 却漏改某处"这类错。
  let settingsHandlerOk = true
  try {
    resolvedSettings.replyMode = 'tool'
    handlers['settings/updated']?.('qq-bridge')
    resolvedSettings.replyMode = 'marker'
    handlers['settings/updated']?.('qq-bridge')
  } catch (e) {
    settingsHandlerOk = false
    console.log('  settings/updated 抛错：', String(e?.message ?? e))
  }
  check('改 replyMode 时 settings/updated 处理器不抛错', settingsHandlerOk)
}

// ★ 端到端时序回归（哑火第 4 次的成因）：走**真实 handleInbound 路径**注入一条 QQ 消息，
//   并让假 agent 的 followup() **同步**发出 turn/start（真机就是这个时序）。
//   它专门盯"置位必须早于 send" —— 晚一拍，turn/start 就会快照到一个还没置位的 pending。
{
  const fire = (type, data) => handlers['session/event']({ id: 'session-smoke' }, { type, data })
  const outbox = async () => JSON.parse(await status.execute({})).recentOutbox
  const lastText = (a) => String(a[a.length - 1]?.text ?? '')
  const gate = async () => JSON.parse(await status.execute({})).gate
  const sendTool = registered.find((t) => t.name === 'qq_bridge_send')

  fire('turn/end', { reason: { kind: 'completed' } }) // 清掉前一块可能残留的轮
  resolvedSettings.replyMode = 'tool'
  // 上一块的 settings/updated 发现了新的 onebotUrl → 调了 transport.reconnectNow()。
  // 新 socket 的 onopen 走宏任务。这里不等它，工具就回到 reason='not-connected'。
  await new Promise((r) => setTimeout(r, 20))
  check('重连之后传输回到 open', JSON.parse(await status.execute({})).transport.state === 'open')

  let injected = null
  fakeAgent = {
    id: 'session-smoke',
    ctx: { get: () => undefined, effect: () => () => {} },
    // 真机顺序：注入的 user/message → turn/start（**同步**，就在 followup 里面）
    followup: (msg) => {
      injected = msg
      fire('user/message', msg)
      fire('turn/start', { turn: 1 })
    },
  }

  // 用"叫到昵称"来保证必然唤醒（概率分支会 sampled-out，那样根本走不到注入）
  const r = JSON.parse(await sim.execute({ text: '244 在吗', userId: 'test-user' }))
  check('模拟注入走通真实 handleInbound 路径', r?.decision?.delivered === true, JSON.stringify(r?.decision ?? r))
  const text = String(injected?.content?.[0]?.text ?? '')
  check('注入的消息带 QQ 前缀（isOurInbound 认得出）', text.startsWith('[QQ · ') || text.includes('[QQ 未唤醒期间聊天记录'), text.slice(0, 40))

  const g = await gate()
  check('同步 turn/start 的时序下归属正确（置位早于 send）', g.currentTurnFromQQ === true, JSON.stringify(g))

  const sent = JSON.parse(await sendTool.execute({ text: '端到端：这条应该发得出去' }))
  check(
    '端到端：注入之后工具可用',
    sent.refused !== true && sent.sent === 1 && lastSentText() === '端到端：这条应该发得出去' && lastText(await outbox()) === '端到端：这条应该发得出去',
    JSON.stringify(sent),
  )

  // ── 投递方式：目标正忙时该不该插话 ────────────────────────────────────────
  check(
    'normalizeDelivery：只认三个值，其余归 auto',
    normalizeDelivery('steer') === 'steer' &&
      normalizeDelivery('followup') === 'followup' &&
      normalizeDelivery('auto') === 'auto' &&
      normalizeDelivery('乱写') === 'auto' &&
      normalizeDelivery(undefined) === 'auto',
  )

  let steered = 0
  let followed = 0
  const makeAgent = (status) => ({
    id: 'session-smoke',
    status,
    ctx: { get: () => undefined, effect: () => () => {} },
    steer: (msg) => {
      steered++
      injected = msg
      fire('user/message', msg) // 插话：塞进**正在跑的那一轮**，不发 turn/start
    },
    followup: (msg) => {
      followed++
      injected = msg
      fire('user/message', msg)
      fire('turn/start', { turn: 1 })
    },
  })

  // 目标正忙 + delivery='auto' → 插话；并且归属要算成 QQ，否则插话反而哑火
  fire('turn/start', { turn: 1 }) // 已经有轮在跑
  steered = followed = 0
  fakeAgent = makeAgent('running')
  resolvedSettings.delivery = 'auto'
  await sim.execute({ text: '244 在忙吗', userId: 'test-user' })
  check('delivery=auto + 目标正忙 → 插话（steer）', steered === 1 && followed === 0, JSON.stringify({ steered, followed }))
  check('插话之后归属算 QQ（否则插话会变成哑火）', (await gate()).currentTurnFromQQ === true, JSON.stringify(await gate()))
  fire('turn/end', { reason: { kind: 'completed' } })

  // 目标空闲 + delivery='auto' → 照常排队（更稳），并且能正常起一轮
  steered = followed = 0
  fakeAgent = makeAgent('idle')
  await sim.execute({ text: '244 在吗', userId: 'test-user' })
  check('delivery=auto + 目标空闲 → 排队（followup）', followed === 1 && steered === 0, JSON.stringify({ steered, followed }))
  fire('turn/end', { reason: { kind: 'completed' } })

  // delivery='followup'：即使正忙也不插话
  steered = followed = 0
  fakeAgent = makeAgent('running')
  resolvedSettings.delivery = 'followup'
  fire('turn/start', { turn: 1 })
  await sim.execute({ text: '244 排队', userId: 'test-user' })
  check("delivery='followup'：正忙也排队", followed === 1 && steered === 0, JSON.stringify({ steered, followed }))

  fakeAgent = null
  resolvedSettings.replyMode = 'marker'
  delete resolvedSettings.delivery
  fire('turn/end', { reason: { kind: 'completed' } })
}

// ★ 唤醒失败必须能事后看出：台账改成 wake-failed，调用方拿到 wakeFailed，闸门标志回滚，缓冲不丢。
//   修之前投递失败后台账里仍写着 wake，`status.recentLog` 查不出问题。
{
  const originalTarget = resolvedSettings.targetSessionId
  const originalConfigTarget = config.targetSessionId
  const stateNow = async () => JSON.parse(await status.execute({}))
  const lastLog = async () => {
    const a = (await stateNow()).recentLog
    return a[a.length - 1]
  }
  const gateNow = async () => (await stateNow()).gate
  const bufferedNow = async () => (await stateNow()).bufferedUnwoken
  const fire = (type, data) => handlers['session/event']({ id: 'session-smoke' }, { type, data })
  const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))
  // 改 targetSessionId 是为了造失败；无论怎么退出都必须还原，否则后面所有用例连锁失败。
  try {
    // 闸门归零：前面几块可能留下正在跑的一轮，或一个 QQ 来源标记。
    fire('turn/end', { reason: { kind: 'completed' } })
    fire('user/message', { source: { kind: 'user' } })

    // ① 未配置目标会话。readSettings() 会回落到 config.targetSessionId，所以两处都要清空。
    resolvedSettings.targetSessionId = ''
    config.targetSessionId = ''
    let r1 = null
    let threw1 = false
    try {
      r1 = JSON.parse(await sim.execute({ text: '244 在吗', userId: 'test-user' }))
    } catch (error) {
      threw1 = true
      console.log('  未配置目标会话时抛了：', String(error?.message ?? error))
    }
    check('未配置目标会话：调用方不抛异常、仍返回可解析 JSON', threw1 === false && typeof r1?.decision === 'object', JSON.stringify(r1))
    check(
      '未配置目标会话：decision 标出 wakeFailed、未投递、action 仍是 wake',
      r1?.decision?.wakeFailed === true && r1?.decision?.delivered === false && r1?.decision?.action === 'wake',
      JSON.stringify(r1?.decision),
    )
    check('未配置目标会话：error 指出 targetSessionId', String(r1?.decision?.error ?? '').includes('targetSessionId'), String(r1?.decision?.error))
    const log1 = await lastLog()
    check('未配置目标会话：台账最后一条是 wake-failed（不再是 wake）', log1?.decision === 'wake-failed', JSON.stringify(log1))
    check('未配置目标会话：台账带上失败原因', String(log1?.error ?? '').includes('targetSessionId'), JSON.stringify(log1))
    const g1 = await gateNow()
    check('未配置目标会话：闸门标志没被置位', g1.pendingFromQQ === false && g1.currentTurnFromQQ === false, JSON.stringify(g1))

    // ② resume 失败：目标会话不在 live 里，假 ctx 的 ctx.agents.resume 故意抛错。
    resolvedSettings.targetSessionId = 'session-resume-fail'
    config.targetSessionId = 'session-resume-fail'
    fakeAgent = null
    let r2 = null
    let threw2 = false
    try {
      r2 = JSON.parse(await sim.execute({ text: '244 在吗', userId: 'test-user' }))
    } catch (error) {
      threw2 = true
      console.log('  resume 失败时抛了：', String(error?.message ?? error))
    }
    check('resume 失败：调用方不抛异常、仍返回可解析 JSON', threw2 === false && typeof r2?.decision === 'object', JSON.stringify(r2))
    check(
      'resume 失败：decision 标出 wakeFailed、未投递、error 非空',
      r2?.decision?.wakeFailed === true && r2?.decision?.delivered === false && String(r2?.decision?.error ?? '') !== '',
      JSON.stringify(r2?.decision),
    )
    const log2 = await lastLog()
    check('resume 失败：台账最后一条是 wake-failed', log2?.decision === 'wake-failed', JSON.stringify(log2))

    // ③ 投递失败（followup 抛错）。假 ctx 没有 withInitiator：它先抛错，catch 里那次 send() 再抛错。
    //    这条就是“二次抛出逃出函数”的分支。这里同时验证闸门回滚与缓冲不丢。
    resolvedSettings.targetSessionId = 'session-smoke'
    config.targetSessionId = 'session-smoke'
    // 先在缓冲里放一条：失败的唤醒**不能**把它清掉（下次唤醒还得带上）。
    const wakeProb = resolvedSettings.wakeProbability
    resolvedSettings.wakeProbability = 0
    await sim.execute({ text: '这条只记录', userId: 'test-user' })
    resolvedSettings.wakeProbability = wakeProb
    const bufferedBefore = await bufferedNow()
    check('投递失败之前：缓冲里已有一条待唤醒消息', bufferedBefore >= 1, `${bufferedBefore} 条`)

    fakeAgent = {
      id: 'session-smoke',
      status: 'idle',
      ctx: { get: () => undefined, effect: () => () => {} },
      followup: () => {
        throw new Error('smoke: followup 拒收')
      },
    }
    let r3 = null
    let threw3 = false
    try {
      r3 = JSON.parse(await sim.execute({ text: '244 在吗', userId: 'test-user' }))
    } catch (error) {
      threw3 = true
      console.log('  投递失败时抛了：', String(error?.message ?? error))
    }
    check(
      '投递失败：调用方不抛异常，且 error 是真实失败原因',
      threw3 === false && r3?.decision?.wakeFailed === true && r3?.decision?.error === 'smoke: followup 拒收',
      JSON.stringify(r3?.decision),
    )
    const log3 = await lastLog()
    check('投递失败：台账记成 wake-failed', log3?.decision === 'wake-failed', JSON.stringify(log3))
    check('投递失败：台账带失败原因', String(log3?.error ?? '').includes('followup 拒收'), JSON.stringify(log3))
    const g3 = await gateNow()
    check(
      '投递失败：闸门三标志回滚到置位前的值',
      g3.pendingFromQQ === false && g3.currentTurnFromQQ === false && g3.claimedFromQQ === false,
      JSON.stringify(g3),
    )
    check('投递失败：缓冲不丢（这条消息留在缓冲里等下次唤醒）', (await bufferedNow()) === bufferedBefore, `${bufferedBefore} → ${await bufferedNow()}`)
    fakeAgent = null

    // ④ 反证：失败留下的认领若没回滚，下面这一轮（没有 QQ 来源）会被误判成 QQ 轮而误发。
    fire('turn/start', { turn: 9 })
    fire('assistant/message', { message: { content: [{ type: 'text', text: '[QQ]不该发出去的残留归属[/QQ]' }] } })
    fire('turn/end', { reason: { kind: 'completed' } })
    await tick()
    check('投递失败：残留归属没让非 QQ 轮误发', !sawSentText('不该发出去的残留归属'), JSON.stringify(sentTexts()))

    // ⑤ 失败之后按正常时序走一轮 QQ 轮，必须真的发得出去。
    fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
    fire('turn/start', { turn: 1 })
    fire('assistant/message', { message: { content: [{ type: 'text', text: '[QQ]失败之后这一轮照发[/QQ]' }] } })
    fire('turn/end', { reason: { kind: 'completed' } })
    await tick()
    check('投递失败之后：下一轮 QQ 轮仍能真的发出去', lastSentText() === '失败之后这一轮照发', JSON.stringify(sentTexts()))
  } finally {
    resolvedSettings.targetSessionId = originalTarget
    config.targetSessionId = originalConfigTarget
    fakeAgent = null
    fire('turn/end', { reason: { kind: 'completed' } })
  }
  check(
    '唤醒失败用例结束后：targetSessionId 已还原',
    resolvedSettings.targetSessionId === 'session-smoke' && config.targetSessionId === 'session-smoke',
    `${resolvedSettings.targetSessionId} / ${config.targetSessionId}`,
  )
}

// M3：settings Schema 直接生成设置界面上的表单 —— 每个键都必须有说明，否则界面里只剩裸键名
{
  const reg = registeredSettings[0]
  check('注册了 settings 命名空间 qq-bridge', registeredSettings.length === 1 && reg?.ns === 'qq-bridge', String(reg?.ns))
  const dict = reg?.schema?.dict ?? {}
  const keys = Object.keys(dict)
  check('settings 键数量符合预期（23）', keys.length === 23, `实际 ${keys.length}`)
  const missing = keys.filter((k) => String(dict[k]?.meta?.description ?? '').trim() === '')
  check('每个 settings 键都有说明（设置界面里能看懂）', missing.length === 0, missing.join(', '))
  // readSettings() 会读到的键必须都在 Schema 里，否则用户在界面上改不到它
  const want = ['targetSessionId', 'nicknames', 'wakeProbability', 'whitelist', 'groupWhitelist', 'replyMode', 'visionModel']
  const absent = want.filter((k) => !keys.includes(k))
  check('关键键都在 Schema 里（界面上改得到）', absent.length === 0, absent.join(', '))
}

// ★ 恢复**没开着的**会话时必须带上模型 —— 否则 {{model}} 无值，整轮提示词组装会抛错。
//   （2026-09-30 真机：244 不在 GUI 里开着的时候，插件一唤醒它就 `prompt variable "{{model}}"
//    has no value for this assembly (section "deployment.persona-prefix")`。）
{
  let asked = 0
  fakeSessionQuery = {
    observeSession: async () => {
      asked++
      return {
        events: [{ type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } }],
        dispose() {},
      }
    },
  }
  lastResumeOptions = null
  fakeAgent = null
  // 这里注入会走到 resume，而假 ctx 的 resume 故意抛错（模拟"没有 agent 工厂"）——
  // 我们要的是**它拿到了什么参数**，所以把异常接住即可。
  try {
    await sim.execute({ text: '244 在吗', userId: 'test-user' })
  } catch {
    /* 预期：resume 抛 'smoke: no agent factory' */
  }
  check(
    '恢复会话前会去读该会话的模型',
    asked === 1 && lastResumeOptions?.resumeSessionId === 'session-smoke',
    JSON.stringify({ asked, resumeSessionId: lastResumeOptions?.resumeSessionId }),
  )
  check(
    '恢复会话时带上了模型（避免 {{model}} 无值炸掉）',
    lastResumeOptions?.agentOptions?.provider === 'deepseek-official' && lastResumeOptions?.agentOptions?.model === 'deepseek-v4-flash',
    JSON.stringify(lastResumeOptions?.agentOptions ?? null),
  )
  fakeSessionQuery = null
}

// M3：浏览器半 —— 设置页 → 插件 → 插件配置 里的那张卡片
{
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))
  check('package.json 声明了 dsh.client（platform: web）', pkg?.dsh?.client?.platform === 'web', JSON.stringify(pkg?.dsh?.client))
  check('声明了 ./client 导出', pkg?.exports?.['./client'] === './client/client.js', String(pkg?.exports?.['./client']))

  const clientPath = fileURLToPath(new URL('./client/client.js', import.meta.url))
  check('client/client.js 存在', existsSync(clientPath))
  const src = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : ''
  check('bundle 用 __ModuleLoader__.load 包装', src.includes('window.__ModuleLoader__.load'))
  check('模块 id 与包名一致（否则浏览器取不到这个 bundle）', src.includes(`id: '${pkg.name}'`))
  check('导出 name = 包名（inspect 里能认出是谁注册的卡片）', src.includes(`exports.name = '${pkg.name}'`))
  // 卡片按 settings 命名空间派发：key 与宿主注册的 NS 不一致 = 界面上静默什么都不出现
  check('卡片 key 与宿主 settings 命名空间一致', src.includes(`const NS = '${NS}'`) && src.includes('key: NS'))
  check('注册进 settings.plugin.item', src.includes("'settings.plugin.item'"))
  let parses = false
  try {
    new vm.Script(src)
    parses = true
  } catch (e) {
    parses = false
    console.log('  client 语法错误：', String(e.message))
  }
  check('client/client.js 语法可解析', parses)

  // 真把 bundle 跑一遍：假 window.__ModuleLoader__ + 假 react + 假 ctx。
  // 比字符串匹配强得多 —— key 写错在真机上是「不报错、界面静默空白」，
  // 那种失败只有把注册路径真跑一次才拦得住。
  {
    let def
    const sandbox = { window: { __ModuleLoader__: { load: (d) => { def = d } } }, console }
    vm.runInNewContext(src, sandbox)
    check('bundle 被 __ModuleLoader__ 装载', def?.id === pkg.name, String(def?.id))

    const fakeReact = {
      createElement: (...args) => ({ args }),
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useState: () => [null, () => {}],
      useEffect: () => {},
      useSyncExternalStore: () => undefined,
    }
    const mod = def.factory((name) => {
      if (name === 'react') return fakeReact
      throw new Error(`require 了非 baseline 模块：${name}`)
    })
    check(
      '浏览器半导出 apply / inject / name',
      typeof mod.apply === 'function' && Array.isArray(mod.inject) && mod.name === pkg.name,
    )

    const cards = []
    const slotInjects = []
    const fakeCtx = {
      get: () => undefined,
      inject: (_deps, cb) => cb(fakeCtx),
      settingsScope: { bind: () => ({}) },
      slots: {
        inject: (name, cb) => {
          slotInjects.push(name)
          return cb()
        },
        register: (options, cell) => {
          cards.push({ options, cell })
          return () => {}
        },
      },
    }
    mod.apply(fakeCtx)
    // ★ 两版 DSH 都要能显示：0.1.5-rc.3 的挂载点是 settings.plugin.item，
    //   0.2.0 改成了 settings.plugins.tab（插件自己是一个 tab）。
    //   真的 slots.inject 只在那个 slot 存在时才跑 factory，所以两个都注入是安全的。
    check(
      '同时向新旧两个 slot 注入（兼容 0.1.5-rc.3 与 0.2.0）',
      slotInjects.includes('settings.plugin.item') && slotInjects.includes('settings.plugins.tab'),
      JSON.stringify(slotInjects),
    )
    check('两个 slot 各自的卡片都注册了', cards.length === 2, String(cards.length))
    const oldCard = cards.find((c) => c.options.name === 'settings.plugin.item')
    const newCard = cards.find((c) => c.options.name === 'settings.plugins.tab')
    check(
      '0.1.5-rc.3 的卡片：key 必须等于宿主 settings 命名空间',
      oldCard?.options?.key === NS,
      JSON.stringify(oldCard?.options),
    )
    check(
      '0.2.0 的 tab：id / order / label 齐全',
      newCard?.options?.id === NS &&
        typeof newCard?.options?.order === 'number' &&
        typeof newCard?.options?.label === 'function' &&
        String(newCard.options.label()).length > 0,
      JSON.stringify(newCard?.options),
    )
    check('卡片渲染函数可调用', cards.every((c) => typeof c.cell === 'function' && Boolean(c.cell())))

    // ★ 第三个变化轴（2026-10-01 桌面端真机）：**可写设置域的 key 也换了**。
    //   0.1.5 用 settings 命名空间 `qq-bridge`；0.2.0 用 profile entry id `include:qq-bridge`
    //   （宿主 Config 投影出来的是后者）。只绑前者 → 0.2.0 上永远 unavailable，
    //   用户看到"这个部署没有为 qq-bridge 提供可写的设置服务"。
    {
      const bindSettings = mod.__test?.bindSettings
      check('bindSettings 已导出（便于测两代 key）', typeof bindSettings === 'function')
      if (typeof bindSettings === 'function') {
        const serviceReadyFor = (readyNs) => ({
          bind: ({ namespace }) => ({
            getSnapshot: () => ({
              status: namespace === readyNs ? 'ready' : 'unavailable',
              value: { nicknames: ['x'] },
            }),
            subscribe: () => () => {},
            set: async () => {},
          }),
        })
        const legacy = bindSettings(serviceReadyFor('qq-bridge'))
        check(
          '老宿主：绑 qq-bridge 拿到 ready',
          legacy.getSnapshot().status === 'ready',
          JSON.stringify(legacy.namespaces),
        )
        const modern = bindSettings(serviceReadyFor('include:qq-bridge'))
        check(
          '0.2.0：自动改用 include:qq-bridge（entry id）',
          modern.getSnapshot().status === 'ready',
          JSON.stringify(modern.namespaces),
        )
        const none = bindSettings({ bind: () => ({}) })
        check('两代都拿不到时不炸、如实报 unavailable', none.getSnapshot().status === 'unavailable')
        check(
          '诊断信息列出试过的 key 与各自状态（真机排障用）',
          typeof none.detail === 'function' && none.detail().includes('qq-bridge=unavailable'),
          typeof none.detail === 'function' ? none.detail() : 'no detail',
        )

        // ★ 0.2.0 的兜底：scope 全不可用 → 走宿主自己挂的本机接口（fetch 打桩验证）。
        {
          const calls = []
          sandbox.fetch = async (url, init) => {
            calls.push({ url: String(url), method: init?.method ?? 'GET' })
            const values = { nicknames: init?.method === 'POST' ? ['y'] : ['x'] }
            return { ok: true, status: 200, json: async () => ({ ok: true, values, overridden: ['nicknames'] }) }
          }
          const apiScope = bindSettings({
            bind: () => ({
              getSnapshot: () => ({ status: 'unavailable' }),
              subscribe: () => () => {},
              set: async () => {},
            }),
          })
          check('诊断里同时报 scope 与接口状态', String(apiScope.detail()).includes('本机接口='), apiScope.detail())
          check('scope 全不可用时先报 loading（并已在拉接口）', apiScope.getSnapshot().status === 'loading')
          await new Promise((resolve) => setTimeout(resolve, 0))
          const ready = apiScope.getSnapshot()
          check(
            '接口返回后 snapshot=ready，且带 value/user/writable（卡片不用改）',
            ready.status === 'ready' &&
              ready.writable === true &&
              ready.value?.nicknames?.[0] === 'x' &&
              ready.user?.nicknames === true,
            JSON.stringify(ready),
          )
          check('via() 报 api', apiScope.via() === 'api')
          await apiScope.set('nicknames', ['y'])
          check(
            'set 走 POST 到 /api/qq-bridge/settings',
            calls.some((c) => c.method === 'POST' && c.url.includes('/api/qq-bridge/settings')),
            JSON.stringify(calls),
          )
          check(
            '接口不可用（没有 fetch）时如实报 unavailable，不炸',
            (() => {
              const saved = sandbox.fetch
              delete sandbox.fetch
              const noFetch = bindSettings({ bind: () => ({ getSnapshot: () => ({ status: 'unavailable' }) }) })
              noFetch.getSnapshot()
              const snap = noFetch.getSnapshot()
              sandbox.fetch = saved
              return snap.status === 'unavailable' || snap.status === 'loading'
            })(),
          )
        }


        check('set 在没有可写源时明确抛错', (() => {
          try {
            none.set('nicknames', ['a'])
            return false
          } catch {
            return true
          }
        })())
      }
    }

    // ★ 第二个变化轴：**服务门也换了名字**。0.1.5-rc.3 是 settingsScope，0.2.0 是 webUiSettings。
    //   只 inject 旧的那个，0.2.0 上回调永远不跑（用户 2026-10-01 抓出来的）。
    {
      const cards2 = []
      const fakeCtx2 = {
        get: () => undefined,
        inject: (_deps, cb) => cb(fakeCtx2),
        // 只给新服务名，没有 settingsScope —— 模拟 0.2.0（web-all 0.4.x）
        webUiSettings: { bind: () => ({}) },
        slots: {
          inject: (_name, cb) => cb(),
          register: (options, cell) => {
            cards2.push({ options, cell })
            return () => {}
          },
        },
      }
      mod.apply(fakeCtx2)
      check('只有 webUiSettings 时也能注册（0.2.0 的服务名）', cards2.length === 2, String(cards2.length))
      check(
        '两个服务都在时只注册一次（不重复挂卡片）',
        cards.length === 2 && cards2.length === 2,
        `旧 ctx=${cards.length} 新 ctx=${cards2.length}`,
      )
    }

    // ★ 卡片必须覆盖**每一个** settings 键 —— 用户报的「设置里配不了 visionModel」就是这个：
    // 它在 Schema 里有、卡片 FIELDS 里却没做输入框 → 用户根本改不到。这条断言专防它。
    {
      const cardKeys = (mod.__test?.fields ?? []).map((x) => x.key)
      const schemaKeys = Object.keys(registeredSettings[0]?.schema?.dict ?? {})
      const notOnCard = schemaKeys.filter((k) => !cardKeys.includes(k))
      check('每个 settings 键在卡片上都有输入框', notOnCard.length === 0, `缺：${notOnCard.join(', ')}（卡片共 ${cardKeys.length} 项）`)
      check('卡片上的键都真实存在于 Schema（没写错名字）', cardKeys.every((k) => schemaKeys.includes(k)), cardKeys.filter((k) => !schemaKeys.includes(k)).join(', '))
    }

    // 会话下拉的筛选规则（用户报的 bug：归档会话也混在下拉里）
    const so = mod.__test?.sessionOptions
    check('导出 sessionOptions 供离线测试', typeof so === 'function')
    const list = {
      ids: ['s1', 's2', 's3'],
      byId: { s1: { displayTitle: '甲' }, s2: { displayTitle: '乙', running: true }, s3: { displayTitle: '丙' } },
    }
    const opts = so(list, 's1', ['s3'])
    check('第一项是「不驱动任何会话」', opts[0]?.value === '', JSON.stringify(opts[0]))
    check('归档的会话不出现在下拉里', !opts.some((o) => o.value === 's3'), JSON.stringify(opts.map((o) => o.value)))
    check('运行中的会话有标注', String(opts.find((o) => o.value === 's2')?.label ?? '').includes('运行中'))
    const keep = so(list, 's3', ['s3'])
    check(
      '当前选中的恰好是归档会话时仍保留（标「已归档」，否则一保存就清空配置）',
      keep.some((o) => o.value === 's3' && String(o.label).includes('已归档')),
      JSON.stringify(keep),
    )
    const missing = so(list, 'gone', [])
    check('不在列表里的当前值保留为兜底项', missing.some((o) => o.value === 'gone'), JSON.stringify(missing))
    check('没有归档集时不会误删（fail-open）', so(list, 's1', undefined).length === 4)
  }

  // status 要能回答「浏览器半到底装上没有」—— 界面里不显示时全靠这一条排障
  const st = JSON.parse(await status.execute({}))
  check('qq_bridge_status 报告浏览器半状态', st.clientHalf && typeof st.clientHalf === 'object', JSON.stringify(st.clientHalf))
}

// 商城详情页截图：仓库根目录的 screenshots.json（路径相对于它自己，1–8 张）
{
  const shotPath = fileURLToPath(new URL('./screenshots.json', import.meta.url))
  check('screenshots.json 存在', existsSync(shotPath))
  const raw = existsSync(shotPath) ? JSON.parse(readFileSync(shotPath, 'utf8')) : []
  const arr = Array.isArray(raw) ? raw : raw?.screenshots
  check('截图数量在 1–8 之间', Array.isArray(arr) && arr.length >= 1 && arr.length <= 8, String(arr?.length))
  check(
    '截图是相对路径、不跳出仓库目录',
    (arr || []).every((s) => typeof s === 'string' && !s.startsWith('/') && !s.includes('..')),
    JSON.stringify(arr),
  )
  // 官方规范点名过这个坑：路径写错只会在市场里静默 404，本地测不出来
  const gone = (arr || []).filter((s) => !existsSync(fileURLToPath(new URL(`./${s}`, import.meta.url))))
  check('每个截图文件都真实存在（改名/删除就 FAIL）', gone.length === 0, gone.join(', '))
}

// 图片描述必须**就地**填回 [图片] 占位符，并带上短哈希（2026-10-01 用户真机反馈：以前描述另起一段
// 附在末尾，模型会读成"这张图没解析出来、后面又来了一张"；短哈希让模型能指着一张具体的图存 / 发）
{
  const i1 = { url: 'a', hash: 'aaaaaa1111111111' }
  const i2 = { url: 'b', hash: 'bbbbbb2222222222' }
  const note = (text, hash) => ({ text, hash })
  const d = new Map([
    [i1, note('一只猫', 'aaaaaa1111111111')],
    [i2, note('一张卡牌：攻击力 3', 'bbbbbb2222222222')],
  ])
  check('描述就地替换占位符（带短哈希）', inlineImageNotes('看看 [图片] 这个', [i1], d) === '看看 [图片#aaaaaa]：一只猫 这个')
  check('多图按顺序对上各自的描述', inlineImageNotes('[图片] 和 [图片]', [i1, i2], d) === '[图片#aaaaaa]：一只猫 和 [图片#bbbbbb]：一张卡牌：攻击力 3')
  check('没拿到描述 → 标未描述', inlineImageNotes('[图片]', [i1], new Map()) === '[图片]（未描述）')
  check('纯图无文字', inlineImageNotes('[图片]', [i1], d) === '[图片#aaaaaa]：一只猫')
  check(
    '描述失败也带短哈希（模型仍能指这张图）',
    inlineImageNotes('[图片]', [i1], new Map([[i1, note('（描述失败：超时）', 'aaaaaa1111111111')]])) === '[图片#aaaaaa]：（描述失败：超时）',
  )
  check('图和 note 都没有 hash 时退回裸占位符（老缓存条目）', (() => {
    const i3 = { url: 'c' }
    return inlineImageNotes('[图片]', [i3], new Map([[i3, note('x')]])) === '[图片]：x'
  })())
  check(
    'note 里没带 hash 时用图片自己的 hash',
    inlineImageNotes('[图片]', [i1], new Map([[i1, note('一只猫')]])) === '[图片#aaaaaa]：一只猫',
  )
  check('多出来的占位符留原样（对不上就不编）', inlineImageNotes('[图片][图片]', [i1], d) === '[图片#aaaaaa]：一只猫[图片]')
  check('没有占位符就不动正文', inlineImageNotes('只有文字', [i1], d) === '只有文字')
  check('关键：不会再多出一段 [图片] 开头的描述行', !/\n\s*\[图片/.test(inlineImageNotes('[图片] 文字', [i1], d)))
  check('digest 与入站各自对齐（不会串号）', inlineImageNotes('缓冲 [图片]', [i1], d) + inlineImageNotes('本条 [图片]', [i2], d) === '缓冲 [图片#aaaaaa]：一只猫本条 [图片#bbbbbb]：一张卡牌：攻击力 3')
}

// 戳一戳：OneBot 里它是 notice 事件（不是消息段），以前会被静默丢掉（2026-10-01 用户要求适配）
{
  const me = '3082276036'
  const pokeMe = mapOneBotNotice(
    { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 3097206157, target_id: 3082276036, group_id: 770156738 },
    me,
  )
  check('戳我 → 合成入站、atSelf 且带 poke 标记', !!pokeMe && pokeMe.atSelf === true && pokeMe.poke === true, JSON.stringify(pokeMe))
  check('戳我 → 正文是 [戳一戳] 占位符', String(pokeMe && pokeMe.text).includes('[戳一戳]'))
  check('戳我 → 群号与操作者都留着', !!pokeMe && pokeMe.groupId === '770156738' && pokeMe.userId === '3097206157')
  const pokeOther = mapOneBotNotice(
    { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 3097206157, target_id: 111111, group_id: 770156738 },
    me,
  )
  check('戳别人 → 进策略但不当 atSelf（只记录）', !!pokeOther && pokeOther.atSelf !== true)
  check('自己戳自己 → 忽略（防回环）', mapOneBotNotice({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: me, target_id: me }, me) === null)
  check('别的 notice 不误判', mapOneBotNotice({ post_type: 'notice', notice_type: 'group_recall' }, me) === null)
  check('非 notice 一律不接', mapOneBotNotice({ post_type: 'message' }, me) === null)
  check('兼容 group_poke / friend_poke 写法', !!mapOneBotNotice({ post_type: 'notice', notice_type: 'group_poke', user_id: '1', target_id: me, group_id: 2 }, me))
}

// 回归（2026-10-01 桌面端真机）：DSH 0.2.0 的 settings 服务**没有 register/get**（#677），
// 老代码在里面无条件调 register → apply() 抛错 → **fiber failed**；客户端半却照样进 boot graph，
// 现象是"设置页有 tab、卡片说没有可写设置服务"。这几条断言专防它回来。
{
  check('hasLegacySettings：认得出老模型', hasLegacySettings({ register: () => {}, get: () => ({}) }) === true)
  check(
    'hasLegacySettings：0.2.0（只有 describe/update）判为新模型',
    hasLegacySettings({ describe: () => [], update: async () => {} }) === false,
  )
  check('hasLegacySettings：没有服务也判新模型（不炸）', hasLegacySettings(undefined) === false)
  check('0.1.5 注入 source 用老的 plugin 包装', injectedMessageSource(true).kind === 'plugin')
  check(
    '0.2.0 注入 source 用 producer-owned（plugin:包名）',
    injectedMessageSource(false).kind === 'plugin:dsh-qq-bridge',
    JSON.stringify(injectedMessageSource(false)),
  )
  check('0.2.0 的 source.kind 不是已废弃的 plugin', injectedMessageSource(false).kind !== 'plugin')

  const before = registeredSettings.length
  const newModelCtx = {
    ...ctx,
    settings: { describe: () => [], update: async () => {}, configure: () => () => {} },
  }
  let threw = null
  try {
    apply(newModelCtx, config)
  } catch (error) {
    threw = error
  }
  check('0.2.0 的 settings（无 register/get）上 apply 不抛错', threw === null, String(threw))
  check(
    '0.2.0 上不再调用 settings.register（这是 fiber failed 的直接原因）',
    registeredSettings.length === before,
    `多调了 ${registeredSettings.length - before} 次`,
  )
}

// 0.2.0 的设置接口：宿主 settings 桥拿不到可写域时的数据源
// （范本：@linxin666/dsh-client-ui-skin-center 的 /api/skin-center/...）。
// 只有**非 legacy**（0.2.0 形态）的宿主才走设置文件那条路，所以要单独 mount 一个假 ctx。
{
  const apiRoutes = []
  const apiCtx = {
    ...ctx,
    settings: { describe: () => [], update: async () => {}, configure: () => () => {} }, // 非 legacy
    webServer: { register: (route) => { apiRoutes.push(route); return () => {} } },
  }
  apiCtx.inject = (_deps, cb) => cb(apiCtx)
  apply(apiCtx, config)

  const route = apiRoutes.find((r) => r.path === '/api/qq-bridge/settings')
  check('非 legacy 宿主：挂上 /api/qq-bridge/settings（exact）', route?.kind === 'exact' && typeof route.handler === 'function')

  const makeRes = () => {
    const out = { status: 0, body: '' }
    return { out, writeHead: (status) => { out.status = status }, end: (body) => { out.body = String(body ?? '') } }
  }
  const req = (method, { addr = '127.0.0.1', body } = {}) => ({
    method,
    url: '/api/qq-bridge/settings',
    socket: { remoteAddress: addr },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  })

  if (route) {
    const res1 = makeRes()
    await route.handler(req('GET'), res1)
    const got = JSON.parse(res1.out.body)
    check(
      'GET 200：返回生效值（含 config 回落）',
      res1.out.status === 200 && got.ok === true && got.values?.targetSessionId === 'session-smoke',
      res1.out.body.slice(0, 120),
    )

    const res2 = makeRes()
    await route.handler(req('GET', { addr: '10.0.0.9' }), res2)
    check('非本机请求 403（接口能改设置，绝不能外露）', res2.out.status === 403, String(res2.out.status))

    const res3 = makeRes()
    await route.handler(req('POST', { body: { set: { nicknames: ['a', 'b'], wakeProbability: 0.5 } } }), res3)
    const wrote = JSON.parse(res3.out.body)
    check(
      'POST 写进设置文件并立即生效',
      res3.out.status === 200 &&
        wrote.ok === true &&
        wrote.values?.wakeProbability === 0.5 &&
        JSON.stringify(wrote.values?.nicknames) === '["a","b"]',
      res3.out.body.slice(0, 160),
    )
    check('overridden 列出被用户显式设过的键（卡片据此标「已覆盖」）', Array.isArray(wrote.overridden) && wrote.overridden.includes('nicknames'))

    const res4 = makeRes()
    await route.handler(req('POST', { body: { set: { notAKnownKey: 1 } } }), res4)
    const unknown = JSON.parse(res4.out.body)
    check('白名单外的键不会被写进去', unknown.overridden?.includes('notAKnownKey') !== true, JSON.stringify(unknown.overridden))

    const res5 = makeRes()
    await route.handler(req('POST', { body: { set: { wakeProbability: 'abc' } } }), res5)
    check('非法值被 schema 拦下（400）', res5.out.status === 400, `${res5.out.status} ${res5.out.body.slice(0, 80)}`)

    const res6 = makeRes()
    await route.handler(req('POST', { body: { unset: ['nicknames'] } }), res6)
    const cleared = JSON.parse(res6.out.body)
    check(
      'unset 能清掉覆盖（回落到 config）',
      res6.out.status === 200 && JSON.stringify(cleared.values?.nicknames) === JSON.stringify(config.nicknames),
      res6.out.body.slice(0, 160),
    )
    check('读到的 overridden 已不含被清掉的键', cleared.overridden?.includes('nicknames') !== true, JSON.stringify(cleared.overridden))
  }
}

// M6：卡片上的三个操作按钮 —— 宿主接口。造一份真的 webui.json，直接调路由处理函数。
{
  const installDir = mkdtempSync(join(tmpdir(), 'qq-bridge-webui-'))
  mkdirSync(join(installDir, 'config'), { recursive: true })
  writeFileSync(
    join(installDir, 'config', 'webui.json'),
    `${JSON.stringify({ host: '127.0.0.1', port: 6099, token: 'tok123' })}\n`,
    'utf8',
  )

  const routes = []
  // 非 legacy（0.2.0 形态）宿主：设置从自己的文件读，napcatInstallDir 从 config 回落。
  const napcatCtx = {
    ...ctx,
    settings: { describe: () => [], update: async () => {}, configure: () => () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }
  napcatCtx.inject = (_deps, cb) => cb(napcatCtx)
  // statePath 单独一个：设置文件也跟着落在另一个路径，napcatInstallDir 必定从 config 回落。
  apply(napcatCtx, {
    ...config,
    statePath: process.env.TEMP + '/qq-bridge-smoke-buttons.json',
    napcatInstallDir: installDir,
  })

  const handlerFor = (path) => routes.find((r) => r.path === path)?.handler
  const makeRes = () => {
    const out = { status: 0, body: '' }
    return { out, writeHead: (status) => { out.status = status }, end: (body) => { out.body = String(body ?? '') } }
  }
  const req = (method, { addr = '127.0.0.1', url = '' } = {}) => ({
    method,
    url,
    socket: { remoteAddress: addr },
    async *[Symbol.asyncIterator]() {},
  })

  const napcatGet = handlerFor('/api/qq-bridge/napcat')
  const res1 = makeRes()
  await napcatGet(req('GET', { url: '/api/qq-bridge/napcat' }), res1)
  const got = JSON.parse(res1.out.body)
  check(
    'GET /napcat：读到 webui.json，URL 带 token，端口与 hasToken 都对',
    res1.out.status === 200 &&
      got.ok === true &&
      got.configFound === true &&
      got.port === 6099 &&
      got.hasToken === true &&
      String(got.webuiUrl).includes('token=tok123'),
    res1.out.body.slice(0, 160),
  )
  check(
    'GET /napcat：installed 按同一个 installDir 判定（空目录 = false）',
    got.installed === false,
    String(got.installed),
  )
  check(
    'GET /napcat：running / startedByPlugin 都是布尔量',
    typeof got.running === 'boolean' && typeof got.startedByPlugin === 'boolean',
    JSON.stringify({ running: got.running, startedByPlugin: got.startedByPlugin }),
  )
  check(
    'GET /napcat：测试环境没连 OneBot WS、也没启动过 → running=false',
    got.running === false && got.startedByPlugin === false,
    JSON.stringify({ running: got.running, startedByPlugin: got.startedByPlugin }),
  )

  const res2 = makeRes()
  await napcatGet(req('GET', { addr: '10.0.0.9', url: '/api/qq-bridge/napcat' }), res2)
  check('GET /napcat：非本机请求 403', res2.out.status === 403, String(res2.out.status))

  const napcatLaunchRoute = handlerFor('/api/qq-bridge/napcat/launch')
  const res3 = makeRes()
  await napcatLaunchRoute(req('POST', { addr: '10.0.0.9', url: '/api/qq-bridge/napcat/launch' }), res3)
  check('POST /napcat/launch：非本机请求 403', res3.out.status === 403, String(res3.out.status))

  // launch / reveal 在测试机上必然失败（没有 NapCat，也不该真去开文件管理器），
  // 但必须**回 JSON 而不是抛** —— 抛出去会让宿主那条请求挂死。
  // 这里用 legacy 那份路由：它的 installDir 是不存在的目录，所以 reveal 不会真的启动进程。
  const legacyReveal = capturedRoutes.find((r) => r.path === '/api/qq-bridge/napcat/reveal')?.handler
  const legacyLaunch = capturedRoutes.find((r) => r.path === '/api/qq-bridge/napcat/launch')?.handler
  for (const [label, handler] of [['reveal', legacyReveal], ['launch', legacyLaunch]]) {
    const res = makeRes()
    await handler(req('POST', { url: `/api/qq-bridge/napcat/${label}` }), res)
    let body = null
    try {
      body = JSON.parse(res.out.body)
    } catch {
      body = null
    }
    check(
      `POST /napcat/${label}：返回 JSON 且有 ok 字段（测试环境允许 ok:false）`,
      typeof body?.ok === 'boolean',
      `${res.out.status} ${String(res.out.body).slice(0, 120)}`,
    )
  }

  rmSync(installDir, { recursive: true, force: true })
}

// ★ 表情包工具：登记（save）/ 列表（list）/ 发送（send，base64 出站）。
//   独立 ctx（自己的 handler map、自己的 statePath、假 WebSocket）—— 与前面的用例完全隔离，
//   也正因为隔离，这里可以真跑一遍"发送成功"的路径。
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-sticker-tool-'))
  const statePathS = join(dir, 'state.json')
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
  const hash = hashOfBuffer(png)
  const srcPath = join(dir, 'src.png')
  writeFileSync(srcPath, png)
  // 预热状态：缓冲里放一条群友发的图（record 分支的产物：本地路径 + hash）。
  writeFileSync(
    statePathS,
    `${JSON.stringify({
      buffer: [{
        at: 1,
        userId: 'test-user',
        nickname: '群友',
        groupId: '770156738',
        groupName: null,
        text: '看这个 [图片]',
        images: [{ path: srcPath, mediaType: 'image/png', bytes: png.length, hash }],
      }],
    })}\n`,
    'utf8',
  )

  const savedHome = process.env.DSH_HOME
  const savedWebSocket = globalThis.WebSocket
  const sockets = []
  // 假 WebSocket：装上就当连上；send() 立刻用 echo 回一个成功包。
  globalThis.WebSocket = class {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      this.onopen = this.onmessage = this.onclose = this.onerror = null
      sockets.push(this)
      setTimeout(() => {
        this.readyState = 1
        this.onopen?.({})
      }, 0)
    }
    send(text) {
      const msg = JSON.parse(String(text))
      this.sent.push(msg)
      const data = msg.action === 'get_login_info' ? { user_id: 10001, nickname: 'fake-bot' } : { message_id: 7001 }
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }) })
      }, 0)
    }
    close() {
      this.readyState = 3
      this.onclose?.({ code: 1000 })
    }
  }
  // 图片缓存目录也跟着落到临时目录：否则 listImageCache / findSourceByHash 会去扫用户真实的 qq-bridge-images。
  process.env.DSH_HOME = join(dir, 'home')

  const stickerHandlers = {}
  const registered2 = []
  const resolved2 = {}
  const disposers = []
  const ctxS = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)) },
    settings: {
      register: (_ns, _schema, opts) => {
        Object.assign(resolved2, opts?.base ?? {})
        return {}
      },
      get: () => resolved2,
    },
    agents: { get: () => undefined, roots: () => [], resume: async () => { throw new Error('no factory') } },
    tools: { register: (def) => registered2.push(def) },
    on: (name, fn) => {
      stickerHandlers[name] = fn
      return () => {}
    },
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    get: () => undefined,
  }
  apply(ctxS, {
    targetSessionId: 'session-sticker',
    statePath: statePathS,
    debugTools: true,
    onebotUrl: 'ws://127.0.0.1:9/', // 假 WebSocket 会立刻把它当连上
    wakeProbability: 0, // 只记录：save 要从缓冲里取图
    nicknames: ['244'],
    whitelist: ['test-user'],
    groupWhitelist: [],
    napcatInstallDir: join(dir, 'no-napcat'),
  })
  await new Promise((r) => setTimeout(r, 20))

  const stickerTool = registered2.find((t) => t.name === 'qq_bridge_sticker')
  const status2 = registered2.find((t) => t.name === 'qq_bridge_status')
  check('表情包工具在独立 ctx 里也注册', !!stickerTool && !!status2, registered2.map((t) => t.name).join(','))

  // 空表：list 给一句提示（不是空白，也不是报错）
  {
    const out = JSON.parse(await stickerTool.execute({ action: 'list' }))
    check('list：没有登记时给一句提示', out.count === 0 && String(out.note).includes('save'), JSON.stringify(out))
  }

  // 闸门：与 qq_bridge_send 同一道 —— 非 QQ 轮第一次调用只回确认
  {
    stickerHandlers['session/event']({ id: 'session-sticker' }, { type: 'user/message', data: { source: { kind: 'user' } } })
    stickerHandlers['session/event']({ id: 'session-sticker' }, { type: 'turn/start', data: { turn: 1 } })
    const asked = JSON.parse(await stickerTool.execute({ action: 'send', hash, userId: '1001' }))
    check('send：非 QQ 轮第一次调用只回确认（一个字都不发）', asked.needsConfirm === true && asked.sent === 0, JSON.stringify(asked))
    stickerHandlers['session/event']({ id: 'session-sticker' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }

  // save：从缓冲区最近一张图登记（顺带复制图片本体）
  {
    const out = JSON.parse(await stickerTool.execute({ action: 'save', fromLast: true, mood: '无语', description: '一只无语的猫' }))
    check('save：fromLast 登记成功', out.ok === true && out.hash === shortHash(hash), JSON.stringify(out))
    check('save：图片本体复制进 qq-bridge-stickers/', existsSync(join(dir, 'qq-bridge-stickers', `${hash}.png`)))
    check('save：file 是相对 statePath 的路径', out.file === `qq-bridge-stickers/${hash}.png`, String(out.file))
    const onDisk = loadStickers(join(dir, 'qq-bridge-stickers.json'))
    check(
      'save：登记表已落盘（source 记了群号）',
      onDisk.stickers[hash]?.source === 'group:770156738' && onDisk.stickers[hash]?.mood === '无语',
      JSON.stringify(onDisk.stickers[hash]),
    )
  }

  // save：缺参数 / 找不到源图 → 清晰错误
  {
    const noMood = JSON.parse(await stickerTool.execute({ action: 'save', description: 'x' }))
    check('save：缺 mood/description → 清晰错误', noMood.ok === false && String(noMood.error).includes('mood'), JSON.stringify(noMood))
    const noArgs = JSON.parse(await stickerTool.execute({ action: 'save', mood: '无语', description: 'x' }))
    check('save：既没 hash 也没 fromLast → 清晰错误', noArgs.ok === false && String(noArgs.error).includes('fromLast'), JSON.stringify(noArgs))
    const noSrc = JSON.parse(await stickerTool.execute({ action: 'save', hash: 'deadbeef', mood: '无语', description: 'x' }))
    check('save：找不到源图 → 提示先让群友发一张', noSrc.ok === false && String(noSrc.error).includes('让群友发一张图'), JSON.stringify(noSrc))
  }

  // list：紧凑列表（短哈希 / mood / 描述 / 大小）+ mood 过滤
  {
    const out = JSON.parse(await stickerTool.execute({ action: 'list' }))
    const first = out.stickers?.[0]
    check(
      'list：返回短哈希 / mood / 描述 / 大小',
      out.count === 1 && first?.hash === shortHash(hash) && first?.mood === '无语' && first?.bytes === png.length,
      JSON.stringify(out),
    )
    const filtered = JSON.parse(await stickerTool.execute({ action: 'list', mood: '开心' }))
    check('list：按 mood 过滤（没有该情绪时给提示）', filtered.count === 0 && String(filtered.note).includes('开心'), JSON.stringify(filtered))
  }

  // send：真发一张（base64 出站，不走本地路径）
  {
    stickerHandlers['session/event']({ id: 'session-sticker' }, { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'qq-bridge' } } })
    stickerHandlers['session/event']({ id: 'session-sticker' }, { type: 'turn/start', data: { turn: 1 } })

    const noDest = JSON.parse(await stickerTool.execute({ action: 'send', hash }))
    check('send：没有目的地 → 清晰错误', noDest.ok === false && String(noDest.error).includes('目的地'), JSON.stringify(noDest))

    const sent = JSON.parse(await stickerTool.execute({ action: 'send', hash, groupId: '770156738' }))
    check('send：按 hash 发送成功', sent.ok === true && sent.hash === shortHash(hash), JSON.stringify(sent))

    const socket = sockets.find((s) => s.readyState === 1)
    const call = socket?.sent.find((m) => m.action === 'send_group_msg')
    check('send：走 send_group_msg 且带上群号', !!call && String(call.params.group_id) === '770156738', JSON.stringify(call?.action))
    const file = String(call?.params?.message?.[0]?.data?.file ?? '')
    check('send：图片走 base64://（不用本地路径）', file.startsWith('base64://') && !file.includes(dir), file.slice(0, 24))
    check('send：base64 解出来就是原图', Buffer.from(file.slice('base64://'.length), 'base64').equals(png))

    const after = loadStickers(join(dir, 'qq-bridge-stickers.json'))
    check(
      'send：更新 sentCount / lastSentAt',
      after.stickers[hash]?.sentCount === 1 && typeof after.stickers[hash]?.lastSentAt === 'number',
      JSON.stringify(after.stickers[hash]),
    )
    const st = JSON.parse(await status2.execute({}))
    const ob = st.recentOutbox[st.recentOutbox.length - 1]
    check(
      'send：记 outbox（via tool / action sticker）',
      ob?.via === 'tool' && ob?.action === 'sticker' && String(ob?.text).includes(`[表情包#${shortHash(hash)}]`),
      JSON.stringify(ob),
    )

    const byMood = JSON.parse(await stickerTool.execute({ action: 'send', mood: '无语', userId: '1001' }))
    check('send：只给 mood 时随机挑一张（私聊）', byMood.ok === true && byMood.hash === shortHash(hash), JSON.stringify(byMood))
    const second = socket?.sent.filter((m) => m.action === 'send_private_msg').pop()
    check('send：私聊走 send_private_msg', String(second?.params?.user_id) === '1001', JSON.stringify(second?.action))

    const unknown = JSON.parse(await stickerTool.execute({ action: 'send', mood: '不存在' }))
    check('send：mood 没有匹配 → 指向 list', unknown.ok === false && String(unknown.error).includes('list'), JSON.stringify(unknown))
    const neither = JSON.parse(await stickerTool.execute({ action: 'send' }))
    check('send：hash 与 mood 都不给 → 清晰错误', neither.ok === false, JSON.stringify(neither))
    const bad = JSON.parse(await stickerTool.execute({ action: 'nonsense' }))
    check('未知 action → 错误而非抛异常', bad.ok === false && Array.isArray(bad.valid), JSON.stringify(bad))
  }

  // ★ 超长出站：一条都不发（不再分段），并且**不碰 transport**。
  //   QQ 不该发长消息 —— 超长直接拒绝，让模型缩短后重发。
  {
    const sendTool2 = registered2.find((t) => t.name === 'qq_bridge_send')
    const sim2 = registered2.find((t) => t.name === 'qq_bridge_simulate')
    // 先记一个目的地：这条消息走 record 分支（不进白名单外的群），不会注入会话。
    await sim2.execute({ text: '记一下目的地', userId: 'test-user' })
    stickerHandlers['session/event']({ id: 'session-sticker' }, { type: 'turn/start', data: { turn: 2 } })

    // ① 工具通道：返回 too-long，且 sockets 里没有多出任何出站动作。
    const longText = 'x'.repeat(2000)
    const before = sockets.reduce((n, s) => n + s.sent.length, 0)
    // 按**内容**判断，不按条数：recentOutbox 只留最后 3 条，条数会饱和。
    const sawOutbox = async (needle) =>
      JSON.parse(await status2.execute({})).recentOutbox.some((e) => String(e.text).includes(needle))
    const tooLong = JSON.parse(await sendTool2.execute({ text: longText, groupId: '770156738' }))
    const after = sockets.reduce((n, s) => n + s.sent.length, 0)
    check(
      '超长出站被拒：reason=too-long / sent=0 / 带 limit 与 length',
      tooLong.reason === 'too-long' &&
        tooLong.sent === 0 &&
        tooLong.dropped === true &&
        tooLong.limit > 0 &&
        tooLong.length === longText.length,
      JSON.stringify(tooLong),
    )
    check('超长出站不调用 transport（一条都不发）', after === before, `出站动作数 ${before} → ${after}`)
    // 台账只记真的发出去的：被拒绝的不落 outbox，否则事后对不上账。
    check('超长被拒不落 outbox（台账不记假账）', !(await sawOutbox('xxxx')), JSON.stringify(await status2.execute({})))

    // ② 标记块通道：拒绝结果要进日志（能看出是超长被拒）。
    const warned = warnings.length
    stickerHandlers['session/event'](
      { id: 'session-sticker' },
      { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: `[QQ]${'y'.repeat(2000)}[/QQ]` }] } } },
    )
    stickerHandlers['session/event'](
      { id: 'session-sticker' },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    )
    await new Promise((r) => setTimeout(r, 10))
    check(
      '标记块超长被拒时日志里有 too-long',
      warnings.slice(warned).some((w) => String(w).includes('too-long')),
      JSON.stringify(warnings.slice(warned)),
    )
    check('标记块超长被拒也不落 outbox', !(await sawOutbox('yyyy')))
  }

  // 不受 debugTools 限制：关掉调试工具，表情包工具仍在
  {
    const registered3 = []
    const ctx3 = {
      ...ctxS,
      tools: { register: (d) => registered3.push(d) },
      effect: () => {},
      settings: { register: () => ({}), get: () => ({}) },
    }
    apply(ctx3, { targetSessionId: 'session-x', statePath: join(dir, 'state-nodebug.json'), debugTools: false, onebotUrl: '' })
    check(
      'qq_bridge_sticker 不受 debugTools 限制',
      registered3.some((t) => t.name === 'qq_bridge_sticker') && !registered3.some((t) => t.name === 'qq_bridge_status'),
      registered3.map((t) => t.name).join(','),
    )
  }

  // 收尾：停掉传输、还原全局、删临时目录（不留给下一次运行）
  for (const d of disposers) {
    try {
      d()
    } catch {
      /* 已经停了 */
    }
  }
  globalThis.WebSocket = savedWebSocket
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(dir, { recursive: true, force: true })
}

// ★ 视觉模型解析结果按**设置签名**缓存（用户报的“卡片里填了 visionModel 不生效”）：
//   1. 解析结果与 `visionModel` 的值绑定，值一改就重新解析；
//   2. 解析失败的 `null` 也带签名，不会被永久记住；
//   3. 值没变就命中缓存，**不再枚举**模型列表（`listModels` 的调用次数就是观测点）。
//   独立 ctx + 独立 statePath：与前面的用例完全隔离，也不碰共享的 `resolvedSettings` / `config`。
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-vision-'))
  const statePathV = join(dir, 'state.json')
  // 一张**没有登记**过的图：describeImage 会真的走到多模态模型那条路。
  const pngV = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000020806000000', 'hex')
  const hashV = hashOfBuffer(pngV)
  const imagePathV = join(dir, `image-${hashV}.png`)
  writeFileSync(imagePathV, pngV)
  writeFileSync(
    statePathV,
    `${JSON.stringify({
      buffer: [{
        at: 1,
        userId: 'test-user',
        nickname: '群友',
        groupName: null,
        text: '看这个 [图片]',
        images: [{ path: imagePathV, mediaType: 'image/png', bytes: pngV.length, hash: hashV }],
      }],
    })}\n`,
    'utf8',
  )

  const routesV = []
  const toolsV = []
  const handlersV = {}
  // 观测点：模型列表被枚举几次、多模态调用收到哪个 provider/model。
  let listModelsCalls = 0
  let modelsV = []
  const streamedV = []
  const llmV = {
    listProviders: () => [{ id: 'prov-a' }],
    listModels: async () => {
      listModelsCalls += 1
      return modelsV
    },
    stream: async function* (opts) {
      streamedV.push(`${opts.provider}/${opts.model}`)
      yield { type: 'text-delta', text: '图里写着“测试”' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  let injectedV = null
  const agentV = {
    id: 'session-vision',
    ctx: { get: () => undefined, effect: () => () => {} },
    status: 'idle',
    session: { id: 'session-vision' },
    followup: (m) => { injectedV = m },
  }
  const ctxV = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)) },
    settings: { describe: () => [], update: async () => {}, configure: () => () => {} },
    agents: {
      get: (id) => (id === agentV.id ? agentV : undefined),
      roots: () => [],
      resume: async () => { throw new Error('vision: no agent factory') },
    },
    tools: { register: (def) => toolsV.push(def) },
    on: (name, fn) => { handlersV[name] = fn; return () => {} },
    effect: () => {},
    get: (name) => {
      if (name === 'llm') return llmV
      if (name === 'attachments') {
        return { imageLimits: { maxImagesPerMessage: 4 }, saveImage: async ({ mediaType }) => ({ id: 'vision-att', mediaType }) }
      }
      return undefined
    },
    webServer: { register: (route) => { routesV.push(route); return () => {} } },
  }
  ctxV.inject = (_deps, cb) => cb(ctxV)
  // 起始设置：显式写死 `provider/model` —— 这条路径解析时**不枚举**模型列表。
  writeFileSync(
    join(dir, 'qq-bridge-settings.json'),
    `${JSON.stringify({ version: 1, values: { visionModel: 'prov-a/explicit-a' } })}\n`,
    'utf8',
  )
  apply(ctxV, {
    targetSessionId: 'session-vision',
    statePath: statePathV,
    debugTools: true,
    onebotUrl: '',
    wakeProbability: 0,
    nicknames: ['244'],
    whitelist: ['test-user'],
    groupWhitelist: [],
    napcatInstallDir: join(dir, 'no-napcat'),
  })

  const statusV = toolsV.find((t) => t.name === 'qq_bridge_status')
  const simV = toolsV.find((t) => t.name === 'qq_bridge_simulate')
  const routeV = routesV.find((r) => r.path === '/api/qq-bridge/settings')
  check('视觉模型：独立 ctx 挂上了状态工具与设置路由', !!statusV && !!simV && !!routeV)

  // 用设置接口改值 —— 与真机上卡片的路径一致（写文件后调 applySettingChanges）。
  const setV = async (set) => {
    const out = { status: 0, body: '' }
    await routeV.handler(
      {
        method: 'POST',
        url: '/api/qq-bridge/settings',
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ set })) },
      },
      { writeHead: (s) => { out.status = s }, end: (b) => { out.body = String(b ?? '') } },
    )
    return out
  }
  const resolvedV = async () => JSON.parse(await statusV.execute({})).visionModel

  try {
    // ① 显式设置：直接命中，一次都不枚举；第二次仍然命中缓存。
    const first = await resolvedV()
    check(
      '视觉模型：显式 provider/model 直接命中（不枚举模型列表）',
      first?.provider === 'prov-a' && first?.model === 'explicit-a' && listModelsCalls === 0,
      JSON.stringify({ first, listModelsCalls }),
    )
    const second = await resolvedV()
    check(
      '视觉模型：设置没变 → 命中缓存，不再枚举',
      second?.model === 'explicit-a' && listModelsCalls === 0,
      JSON.stringify({ second, listModelsCalls }),
    )

    // ② 换成一个**不带 `/`** 的值：解析走自动查找这条路（只有这条路会枚举模型列表）。
    //    此刻模型列表为空。
    modelsV = []
    const set1 = await setV({ visionModel: 'no-slash-a' })
    check('视觉模型：设置接口写入成功（换值）', set1.status === 200, `${set1.status} ${set1.body.slice(0, 80)}`)
    const failed = await resolvedV()
    check(
      '视觉模型：解析失败 → 返回原来的“没找到”结果，且只枚举 1 次',
      failed === '(没找到支持图片输入的模型)' && listModelsCalls === 1,
      JSON.stringify({ failed, listModelsCalls }),
    )
    const failedAgain = await resolvedV()
    check(
      '视觉模型：失败的 null 也进缓存（连调 2 次仍只枚举 1 次）',
      failedAgain === '(没找到支持图片输入的模型)' && listModelsCalls === 1,
      JSON.stringify({ failedAgain, listModelsCalls }),
    )

    // ③ 值变了（仍然走自动查找）：必须重新枚举，并拿到新模型。
    modelsV = [{ id: 'smoke-vision-b', provider: 'prov-b', inputModalities: ['image'] }]
    await setV({ visionModel: 'no-slash-b' })
    const refreshed = await resolvedV()
    check(
      '视觉模型：改设置后重新枚举（listModels +1）并拿到新模型',
      refreshed?.provider === 'prov-b' && refreshed?.model === 'smoke-vision-b' && listModelsCalls === 2,
      JSON.stringify({ refreshed, listModelsCalls }),
    )
    const refreshedAgain = await resolvedV()
    check(
      '视觉模型：新结果同样进缓存（不再枚举）',
      refreshedAgain?.model === 'smoke-vision-b' && listModelsCalls === 2,
      JSON.stringify({ refreshedAgain, listModelsCalls }),
    )

    // ④ 只改**别的**设置项：视觉模型的缓存必须留着，不能白枚举一次。
    await setV({ nicknames: ['244'] })
    const untouched = await resolvedV()
    check(
      '视觉模型：只改别的设置项时不动视觉缓存',
      untouched?.model === 'smoke-vision-b' && listModelsCalls === 2,
      JSON.stringify({ untouched, listModelsCalls }),
    )

    // ⑤ 真的走一遍描述路径：缓存命中 → 用的是刚解析出来的新模型。
    const wokeV = JSON.parse(await simV.execute({ text: '244 看这个图', userId: 'test-user', nickname: '群友' }))
    check('视觉模型：独立 ctx 的唤醒走通', wokeV?.decision?.delivered === true, JSON.stringify(wokeV?.decision ?? wokeV))
    check(
      '视觉模型：描述路径用的是新模型（多模态调用的 provider/model 可观测）',
      streamedV[streamedV.length - 1] === 'prov-b/smoke-vision-b',
      JSON.stringify(streamedV),
    )
    const textV = String(injectedV?.content?.[0]?.text ?? '')
    check(
      '视觉模型：新模型写出的描述进了注入正文',
      textV.includes(`[图片#${hashV.slice(0, 6)}]：图里写着“测试”`),
      textV.slice(-90).replace(/\n/g, ' '),
    )

    // ⑥ 换成显式值：立刻生效，仍然不枚举。
    await setV({ visionModel: 'prov-c/explicit-c' })
    const explicitAgain = await resolvedV()
    check(
      '视觉模型：改成显式值时立刻生效（仍然不枚举）',
      explicitAgain?.provider === 'prov-c' && explicitAgain?.model === 'explicit-c' && listModelsCalls === 2,
      JSON.stringify({ explicitAgain, listModelsCalls }),
    )

    // ⑦ 解析失败的结果不留到下一次设置变更。
    //   之后补上视觉模型时，改任何设置都会重试一次，不必专门去动 visionModel 的值。
    await setV({ visionModel: 'no-slash-d' })
    modelsV = []
    const beforeFail = listModelsCalls
    const failD = await resolvedV()
    check(
      '视觉模型：解析失败仍然返回“没找到”',
      failD === '(没找到支持图片输入的模型)' && listModelsCalls === beforeFail + 1,
      JSON.stringify({ failD, listModelsCalls }),
    )
    // 模型此时已可用，但设置值没变 —— 单靠签名不会失效。
    modelsV = [{ id: 'smoke-vision-e', provider: 'prov-e', inputModalities: ['image'] }]
    await setV({ nicknames: ['244'] })
    const retried = await resolvedV()
    check(
      '视觉模型：失败结果不留 → 改别的设置项也会重试并拿到补上的模型',
      retried?.provider === 'prov-e' && retried?.model === 'smoke-vision-e' && listModelsCalls === beforeFail + 2,
      JSON.stringify({ retried, listModelsCalls }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ★ 摘要的省略条数必须是**真实丢失量**，并且大于 99 条时只写“大量消息”。
//   窗口外（比 recentChatLimit 更早）的条目同样随快照一起删掉，必须计入省略数；
//   字数预算装不下的窗口内条目同样计入。
//   独立 ctx + 独立 statePath：与前面的用例完全隔离，也不碰共享的 `resolvedSettings` / `config`。
{
  const dirA = mkdtempSync(join(tmpdir(), 'qq-bridge-digest-'))
  const statePathA = join(dirA, 'state.json')
  writeFileSync(statePathA, `${JSON.stringify({ buffer: [] })}\n`, 'utf8')

  const toolsA = []
  let injectedA = ''
  const agentA = {
    id: 'session-digest',
    ctx: { get: () => undefined, effect: () => () => {} },
    status: 'idle',
    session: { id: 'session-digest' },
    followup: (m) => { injectedA = String(m?.content?.[0]?.text ?? '') },
  }
  const ctxA = {
    logger: { info() {}, warn: (m) => warnings.push(String(m)) },
    settings: { describe: () => [], update: async () => {}, configure: () => () => {} },
    agents: {
      get: (id) => (id === agentA.id ? agentA : undefined),
      roots: () => [],
      resume: async () => { throw new Error('digest: no agent factory') },
    },
    tools: { register: (def) => toolsA.push(def) },
    on: () => () => {},
    effect: () => {},
    get: () => undefined,
    webServer: { register: () => () => {} },
  }
  ctxA.inject = (_deps, cb) => cb(ctxA)
  // `recentChatLimit` 与 `attachRecentChat` 走 `config`：readSettings() 每次都回落到它，
  // 所以 `attachRecentChat` 可以在用例中途改（不必重挂插件）。
  const configA = {
    targetSessionId: 'session-digest',
    statePath: statePathA,
    debugTools: true,
    onebotUrl: '',
    wakeProbability: 0,
    nicknames: ['244'],
    whitelist: ['test-user'],
    groupWhitelist: [],
    recentChatLimit: 8,
    napcatInstallDir: join(dirA, 'no-napcat'),
  }
  apply(ctxA, configA)
  const simA = toolsA.find((t) => t.name === 'qq_bridge_simulate')

  // 只记录：wakeProbability=0，正文里也没有昵称 → record（进缓冲）。
  const recordA = async () => { await simA.execute({ text: 'aaaa', userId: 'test-user', nickname: '甲' }) }
  // 唤醒：正文命中昵称“244” → 必唤醒，与概率无关。
  const wakeA = async () => {
    injectedA = ''
    await simA.execute({ text: '244', userId: 'test-user', nickname: '甲' })
    return injectedA.split('\n')[0]
  }

  try {
    // ① 缓冲为空 → 摘要为空（行为不变）。
    const head0 = await wakeA()
    check('摘要：缓冲为空时不拼摘要', !injectedA.includes('[QQ 未唤醒期间聊天记录'), head0)

    // ② 缓冲 20 条 + recentChatLimit 8 + 字数预算充足 → 窗口外的 12 条也计入省略数。
    for (let i = 0; i < 20; i++) await recordA()
    const head1 = await wakeA()
    check('摘要：20 条取最近 8 条', head1.includes('最近 8 条'), head1)
    check('摘要：窗口外的 12 条计入省略数', head1.includes('（更早的 12 条已省略）'), head1)

    // ③ 字数预算不足 → 窗口外的条目与窗口内没装下的条目一起计入。
    //    摘要行是 203 字符（昵称 1 + “: ” 2 + 正文 200），预算 1200 字符：
    //    装得下 5 条，第 6 条因只剩 180 字符被拒。省略数 = 20 - 5 = 15 = 窗口外 12 + 窗口内 3。
    for (let i = 0; i < 20; i++) await simA.execute({ text: 'x'.repeat(200), userId: 'test-user', nickname: '甲' })
    const head2 = await wakeA()
    check('摘要：预算不足时省略数含窗口外与窗口内两条来源', head2.includes('（更早的 15 条已省略）'), head2)

    // ④ 省略数恰好 99 → 写数字。
    for (let i = 0; i < 107; i++) await recordA()
    const head3 = await wakeA()
    check('摘要：省略数 99 写“更早的 99 条已省略”', head3.includes('（更早的 99 条已省略）'), head3)

    // ⑤ 省略数恰好 100 → 写“大量消息”，正文里不再出现 100 这个数字。
    for (let i = 0; i < 108; i++) await recordA()
    const head4 = await wakeA()
    check('摘要：省略数 100 写“更早的大量消息已省略”', head4.includes('（更早的大量消息已省略）'), head4)
    check('摘要：省略数 100 时正文里没有 100 这个数字', !injectedA.includes('100'), head4)

    // ⑥ 省略数 0 → 不加省略说明。
    for (let i = 0; i < 5; i++) await recordA()
    const head5 = await wakeA()
    check('摘要：省略数 0 时不加省略说明', !injectedA.includes('已省略'), head5)

    // ⑦ attachRecentChat=false → 摘要为空（行为不变）。
    configA.attachRecentChat = false
    for (let i = 0; i < 3; i++) await recordA()
    const head6 = await wakeA()
    check('摘要：attachRecentChat=false 时不拼摘要', !injectedA.includes('[QQ 未唤醒期间聊天记录'), head6)
  } finally {
    configA.attachRecentChat = true
    rmSync(dirA, { recursive: true, force: true })
  }
}

// ★ 投递返回的 rejected Promise 必须被接住：同一条台账条目改成 wake-failed，
//   并写上“投递后这一轮失败：<原因>”。既不产生 unhandled rejection，也不向调用方抛。
//   这一路**不回滚**闸门标志：投递已经真的把这一轮开起来了，标志已被正常消费。
{
  const originalTarget = resolvedSettings.targetSessionId
  const originalConfigTarget = config.targetSessionId
  const originalDelivery = resolvedSettings.delivery
  const stateNow = async () => JSON.parse(await status.execute({}))
  const lastLog = async () => {
    const a = (await stateNow()).recentLog
    return a[a.length - 1]
  }
  const fire = (type, data) => mainSessionHandler({ id: 'session-smoke' }, { type, data })
  const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))
  // unhandled rejection 的判定在微任务清空之后，所以监听必须在触发前挂上，断言前过一个宏任务。
  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    // 闸门归零：前面几块可能留下正在跑的一轮，或一个 QQ 来源标记。
    fire('turn/end', { reason: { kind: 'completed' } })
    fire('user/message', { source: { kind: 'user' } })

    // ① followup 返回 rejected Promise。
    resolvedSettings.targetSessionId = 'session-smoke'
    config.targetSessionId = 'session-smoke'
    fakeAgent = {
      id: 'session-smoke',
      status: 'idle',
      ctx: { get: () => undefined, effect: () => () => {} },
      followup: () => Promise.reject(new Error('这一轮炸了')),
    }
    let threw1 = false
    let r1 = null
    try {
      r1 = JSON.parse(await sim.execute({ text: '244 在吗', userId: 'test-user' }))
    } catch (error) {
      threw1 = true
      console.log('  异步失败时抛了：', String(error?.message ?? error))
    }
    check(
      '异步失败：调用方不抛异常、仍返回可解析 JSON',
      threw1 === false && typeof r1?.decision === 'object' && r1?.decision?.delivered === true,
      JSON.stringify(r1?.decision),
    )
    await tick()
    const log1 = await lastLog()
    check('异步失败：台账最后一条 decision 是 wake-failed', log1?.decision === 'wake-failed', JSON.stringify(log1))
    check('异步失败：error 含真实原因“这一轮炸了”', String(log1?.error ?? '').includes('这一轮炸了'), String(log1?.error))
    check('异步失败：error 写的是“投递后这一轮失败”', String(log1?.error ?? '').includes('投递后这一轮失败'), String(log1?.error))
    const g1 = await stateNow()
    check(
      '异步失败：闸门标志不回滚（这一轮已真的开起来）',
      g1.gate.pendingFromQQ === true && g1.gate.currentTurnFromQQ === true,
      JSON.stringify(g1.gate),
    )

    // ② steer 返回 rejected Promise：目标正忙 + delivery='auto' → 走 steer。
    fire('turn/end', { reason: { kind: 'completed' } })
    fire('user/message', { source: { kind: 'user' } })
    let steered = 0
    fakeAgent = {
      id: 'session-smoke',
      status: 'running',
      ctx: { get: () => undefined, effect: () => () => {} },
      steer: () => {
        steered += 1
        return Promise.reject(new Error('插话也炸了'))
      },
      followup: () => { throw new Error('这条用例不该走 followup') },
    }
    resolvedSettings.delivery = 'auto'
    await sim.execute({ text: '244 在忙吗', userId: 'test-user' })
    await tick()
    const log2 = await lastLog()
    check(
      '异步失败：steer 返回 rejected Promise 同样被接住',
      steered === 1 && log2?.decision === 'wake-failed',
      JSON.stringify({ steered, log: log2 }),
    )
    check('异步失败：steer 那次的 error 也含真实原因', String(log2?.error ?? '').includes('插话也炸了'), String(log2?.error))

    // ③ 异步失败之后，按正常时序走一轮 QQ 轮仍然能真的发出去。
    fakeAgent = null
    delete resolvedSettings.delivery
    fire('turn/end', { reason: { kind: 'completed' } })
    fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
    fire('turn/start', { turn: 12 })
    fire('assistant/message', { message: { content: [{ type: 'text', text: '[QQ]异步失败之后照发[/QQ]' }] } })
    fire('turn/end', { reason: { kind: 'completed' } })
    await tick()
    check('异步失败之后：下一轮 QQ 轮仍能真的发出去', lastSentText() === '异步失败之后照发', JSON.stringify(sentTexts()))

    // ④ 两条 rejected Promise 都不许变成 unhandled rejection。
    check('异步失败：不产生 unhandled rejection', rejections.length === 0, `收集到 ${rejections.length} 条`)
  } finally {
    process.removeListener('unhandledRejection', onRejection)
    resolvedSettings.targetSessionId = originalTarget
    config.targetSessionId = originalConfigTarget
    if (originalDelivery === undefined) delete resolvedSettings.delivery
    else resolvedSettings.delivery = originalDelivery
    fakeAgent = null
    fire('turn/end', { reason: { kind: 'completed' } })
  }
}

// 用例用过的临时图片：留着只会在 %TEMP% 里积垃圾
rmSync(cachedImagePath, { force: true })

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)


if (warnings.length) console.log('warnings:', warnings.slice(0, 5))
process.exit(failed === 0 ? 0 : 1)
