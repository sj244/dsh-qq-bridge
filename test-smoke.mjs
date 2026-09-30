// qq-bridge 冒烟测试：用一个假 ctx 直接调 apply()，验证
//  (1) apply 不抛错、注册了 2 个调试工具；
//  (2) 唤醒策略三条分支（白名单外丢弃 / 昵称必唤醒 / 其余按概率）；
// 运行：node test-smoke.mjs
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { apply, buildUsagePrompt, extractQQReply, labelForSegment, normalizeDelivery, normalizeReplyMode, NS, truncateText } from './index.js'

// 状态文件必须每次从零开始：这个会话的 $env:TEMP 是固定的，
// 不删的话上一次运行留下的 buffer/log 会串进这一次（测出过"只灌 1 条却显示 9 条"）。
const statePath = process.env.TEMP + '/qq-bridge-smoke.json'
if (existsSync(statePath)) rmSync(statePath, { force: true })

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
  get: (name) => (name === 'sessionQuery' ? fakeSessionQuery : undefined),
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
console.log('registered tools:', registered.map((t) => t.name).join(', '))
check('apply 未抛错且注册了 6 个工具', registered.length === 6)

const sim = registered.find((t) => t.name === 'qq_bridge_simulate')
const status = registered.find((t) => t.name === 'qq_bridge_status')
check('qq_bridge_simulate 存在', !!sim)
check('qq_bridge_status 存在', !!status)
check('qq_bridge_send 存在（M2）', !!registered.find((t) => t.name === 'qq_bridge_send'))
check('qq_bridge_transport 存在（M2）', !!registered.find((t) => t.name === 'qq_bridge_transport'))
check('qq_bridge_napcat 存在（M5）', !!registered.find((t) => t.name === 'qq_bridge_napcat'))

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

// 出站闸门必须看**来源**：只有「QQ 唤醒的那一轮」才允许出站。
// 用户 2026-09-30 报的：「agent 分不清是在 QQ 还是 DSH 里」—— 用法说明是常驻系统提示，
// DSH 界面里的那一轮模型同样看得到标记块规矩，所以闸门不能只看"有没有标记块"。
{
  const fire = (type, data, extra = {}) => handlers['session/event']({ id: 'session-smoke' }, { type, data, ...extra })
  const outbox = async () => JSON.parse(await status.execute({})).recentOutbox
  // ⚠️ status 只暴露 outbox 最后 3 条 —— 断言一律看**最新那条的内容**，不要比长度
  //（长度比到 3 就永远相等，那种断言是"碰巧通过"）。
  const lastText = (a) => String(a[a.length - 1]?.text ?? '')
  const sawText = (a, s) => a.some((o) => String(o.text ?? '').includes(s))
  const reply = (text) => fire('assistant/message', { message: { content: [{ type: 'text', text }] } })
  const end = () => fire('turn/end', { reason: { kind: 'completed' } })
  // ⚠️ 现在闸门是**按轮快照**的：currentTurnFromQQ 在 turn/start 时从 pendingFromQQ 取。
  // 所以每条场景都要先 fire turn/start（真实链路里 turn/start 一定在 assistant/message 之前）。
  const start = () => fire('turn/start', { turn: 1 })

  // A) 人在 DSH 界面里打字触发的那一轮：即使写了标记块也不出站
  fire('user/message', { source: { kind: 'user' } })
  start()
  reply('[QQ]DSH 里聊出来的标记块不该进群[/QQ]')
  end()
  check('DSH 触发的轮次：标记块不出站', !sawText(await outbox(), 'DSH 里聊出来的标记块'))

  // B) QQ 注入的那一轮：正常出站
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  start()
  reply('这段只给 DSH 看\n[QQ]群里看到这句[/QQ]')
  end()
  check('QQ 触发的轮次：正常出站且只取块内', lastText(await outbox()) === '群里看到这句', lastText(await outbox()))

  // C) 工具结果也是 user/message，不能把「这轮来自 QQ」冲掉
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  start()
  fire('user/message', { source: { kind: 'tool' } })
  reply('[QQ]工具跑完后的回复[/QQ]')
  end()
  check('工具结果不会冲掉「来自 QQ」的标记', lastText(await outbox()) === '工具跑完后的回复', lastText(await outbox()))

  // D) 别的插件（cron / goal / 别人）注入的轮次同样不出站
  fire('user/message', { source: { kind: 'plugin', plugin: 'dsh-cron' } })
  start()
  reply('[QQ]cron 那一轮[/QQ]')
  end()
  check('别的插件触发的轮次也不出站', !sawText(await outbox(), 'cron 那一轮'))

  // E) 没有 user/message 直接 turn/end（冷启动等）→ fail-closed
  reply('[QQ]没有来源信息[/QQ]')
  end()
  check('没有来源信息时 fail-closed', !sawText(await outbox(), '没有来源信息'))

  // G) **口子①回归**（复查时发现的）：QQ 那一轮还在跑，中途 DSH 里又来了一句
  //    → 那一轮仍然是 QQ 轮，工具/标记块该发就发（单一标时代这里会哑火）。
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  start()
  fire('user/message', { source: { kind: 'user' } }) // 中途插进来的 DSH 消息
  reply('[QQ]这一轮仍然是 QQ 轮，必须发出去[/QQ]')
  end()
  check('口子①：轮内插入 DSH 消息不导致哑火', lastText(await outbox()) === '这一轮仍然是 QQ 轮，必须发出去', lastText(await outbox()))

  // H) **口子②回归**：DSH 那一轮还在跑，中途群里来了 QQ 消息
  //    → 这一轮不是 QQ 轮，一个字都不许发；但**下一条**消息起的那轮才是 QQ 轮。
  fire('user/message', { source: { kind: 'user' } })
  start()
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  reply('[QQ]DSH 那一轮不许发[/QQ]')
  end()
  check('口子②：DSH 轮内来的 QQ 消息不会让它误发', !sawText(await outbox(), 'DSH 那一轮不许发'), lastText(await outbox()))
  start()
  reply('[QQ]下一条消息起的那轮才是 QQ 轮[/QQ]')
  end()
  check('口子②：QQ 消息确实认领了它的下一轮', lastText(await outbox()) === '下一条消息起的那轮才是 QQ 轮', lastText(await outbox()))

  // I) 多轮延续（同一轮没有新的用户消息）：仍然是 QQ 轮 —— 别因为"turn/end 消费掉了"就哑火
  start()
  reply('[QQ]第二轮延续也发得出去[/QQ]')
  end()
  check('多轮延续保持 QQ 轮（turn/end 不吞掉归属）', lastText(await outbox()) === '第二轮延续也发得出去', lastText(await outbox()))

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
  end()
  check('哑火③回归：harness 注入的上下文不影响本轮归属', lastText(await outbox()) === 'harness 上下文不该抢走这一轮', lastText(await outbox()))

  // 但 **harness 上下文不足以认领一轮**：先由真人消息把 pending 打成 false，
  // 再来一条 harness 上下文 —— 它既不能打掉真归属（上面 J），也不能把归属抬起来。
  fire('user/message', { source: { kind: 'user' } })
  fire('user/message', { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } })
  start()
  reply('[QQ]只有 harness 上下文的一轮不该出站[/QQ]')
  end()
  check('harness 上下文不足以认领一轮', !sawText(await outbox(), '只有 harness 上下文的一轮'), lastText(await outbox()))

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
  end()
  check('回归：source 被改写成 user 也不哑火（按正文前缀认出来）', lastText(await outbox()) === '回归通过', lastText(await outbox()))

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
  check('用法说明：截断阈值跟着 replyMaxChars 走', p.includes('1200 字'), p.slice(0, 80))
  check('用法说明：明确「回群只用标记块，别拿 send 工具当回复通道」', p.includes('qq_bridge_send') && p.includes('别拿它当回复通道'))
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
  check('tool 模式：标记块不出站（开关把它关了）', !sawText(await outbox(), 'tool 模式下标记块应该无效'))

  // 工具在 DSH 轮里被拒绝，并且**明确把原因回给模型**（这就是工具方案要的那个反馈回路）
  fire('user/message', { source: { kind: 'user' } })
  start()
  const refused = JSON.parse(await sendTool.execute({ text: '不该发出去' }))
  check(
    '工具：DSH 轮里被拒绝且说明原因',
    refused.refused === true && refused.sent === 0 && String(refused.reason).includes('DSH'),
    JSON.stringify(refused),
  )
  check('被拒绝的调用不记 outbox', !sawText(await outbox(), '不该发出去'))
  fire('turn/end', { reason: { kind: 'completed' } })

  // 工具在 QQ 轮里走通，并记 outbox（via: tool）
  fire('user/message', { source: { kind: 'plugin', plugin: 'qq-bridge' } })
  start()
  const sent = JSON.parse(await sendTool.execute({ text: '工具发出去的话' }))
  const ob = await outbox()
  check('工具：QQ 轮里不再被拒（发送路径走通）', sent.refused !== true && lastText(ob) === '工具发出去的话', JSON.stringify(sent))
  check('工具发送记进 outbox（via: tool）', ob[ob.length - 1]?.via === 'tool', JSON.stringify(ob[ob.length - 1]))

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
  check('端到端：注入之后工具可用', sent.refused !== true && lastText(await outbox()) === '端到端：这条应该发得出去', JSON.stringify(sent))

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
    const fakeCtx = {
      get: () => undefined,
      inject: (_deps, cb) => cb(fakeCtx),
      settingsScope: { bind: () => ({}) },
      slots: {
        inject: (_name, cb) => cb(),
        register: (options, cell) => {
          cards.push({ options, cell })
          return () => {}
        },
      },
    }
    mod.apply(fakeCtx)
    check('apply 注册了一张卡片', cards.length === 1, String(cards.length))
    check(
      '卡片 name / key 正确（key 必须等于宿主 settings 命名空间）',
      cards[0]?.options?.name === 'settings.plugin.item' && cards[0]?.options?.key === NS,
      JSON.stringify(cards[0]?.options),
    )
    check('卡片渲染函数可调用', typeof cards[0]?.cell === 'function' && Boolean(cards[0].cell()))

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

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (warnings.length) console.log('warnings:', warnings.slice(0, 5))
process.exit(failed === 0 ? 0 : 1)
