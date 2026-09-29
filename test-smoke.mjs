// qq-bridge 冒烟测试：用一个假 ctx 直接调 apply()，验证
//  (1) apply 不抛错、注册了 2 个调试工具；
//  (2) 唤醒策略三条分支（白名单外丢弃 / 昵称必唤醒 / 其余按概率）；
// 运行：node test-smoke.mjs
import { apply, extractQQReply } from './index.js'

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
  statePath: process.env.TEMP + '/qq-bridge-smoke.json',
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
check('apply 未抛错且注册了 5 个工具', registered.length === 5)

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

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
if (warnings.length) console.log('warnings:', warnings.slice(0, 5))
process.exit(failed === 0 ? 0 : 1)
