// qq-bridge 冒烟测试：用一个假 ctx 直接调 apply()，验证
//  (1) apply 不抛错、注册了 2 个调试工具；
//  (2) 唤醒策略三条分支（白名单外丢弃 / 昵称必唤醒 / 其余按概率）；
// 运行：node test-smoke.mjs
import { existsSync, rmSync } from 'node:fs'
import { apply, extractQQReply, labelForSegment, truncateText } from './index.js'

// 状态文件必须每次从零开始：这个会话的 $env:TEMP 是固定的，
// 不删的话上一次运行留下的 buffer/log 会串进这一次（测出过"只灌 1 条却显示 9 条"）。
const statePath = process.env.TEMP + '/qq-bridge-smoke.json'
if (existsSync(statePath)) rmSync(statePath, { force: true })

const registered = []
const warnings = []
// settings.get() 在真实运行时返回「composition base + 用户层」的合并值，
// 这里必须如实模拟，否则 config 里的白名单/昵称会被丢掉。
let resolvedSettings = {}
const ctx = {
  logger: { info() {}, warn: (m) => warnings.push(String(m)) },
  settings: {
    register: (_ns, _schema, opts) => { resolvedSettings = { ...(opts?.base ?? {}) }; return {} },
    get: () => resolvedSettings,
  },
  agents: { get: () => undefined, roots: () => [], resume: async () => { throw new Error('smoke: no agent factory') } },
  tools: { register: (def) => registered.push(def) },
  on: () => {},
  effect: () => {},
  get: () => undefined,
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
  check('多块 → 按顺序拼接', extractQQReply('[QQ]第一句[/QQ] 中间 [QQ]第二句[/QQ]') === '第一句\n\n第二句')
  check('空块 → 忽略', extractQQReply('[QQ]   [/QQ]') === '')
  check('大小写 / 跨行都认', extractQQReply('[qq]\n跨行内容\n[/QQ]') === '跨行内容')
  check('未闭合 → 不发', extractQQReply('[QQ]没有结尾') === '')
  check('空输入安全', extractQQReply(undefined) === '')
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

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (warnings.length) console.log('warnings:', warnings.slice(0, 5))
process.exit(failed === 0 ? 0 : 1)
