/**
 * dsh-qq-bridge —— 浏览器半（client half）
 *
 * 作用：在 **设置 → 插件 → 插件配置** 里放一张名为「QQ 桥接」的卡片，
 * 用来改昵称、白名单、唤醒概率、目标会话这些设置 —— 也就是用户要的那个界面。
 *
 * 为什么这里的东西长得不像源码：
 *   DSH 的官方文档明确说，本仓库之外没有现成的 client 打包预设
 *   （`packages/client/tsdown.client.ts` 不发布），外部插件得自己复刻产物格式。
 *   好在格式很简单：`window.__ModuleLoader__.load({ id, factory })`，
 *   `factory(require)` 返回一个带 `apply` / `inject` 的 Cordis 插件。
 *   这里就是**手写**这个格式，不引入任何构建步骤。
 *   参考实现：第三方插件 `dshmarket` 的 `client/client.js`（同样是手写/预构建产物）。
 *
 * 与宿主半的约定：
 *   - `id` 必须等于包名 `dsh-qq-bridge`；
 *   - 卡片注册进 `settings.plugin.item`，**key 必须等于宿主注册的 settings 命名空间** `qq-bridge`，
 *     否则配置页那一栏里什么都不会出现（它按命名空间派发）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // react 是模块表里的 baseline 依赖，不用在 package.json 里声明 external。
    const react = require('react')
    const h = react.createElement

    /** settings 命名空间，必须与 index.js 里的 NS 一致。 */
    const NS = 'qq-bridge'

    // ── 表单描述 ──────────────────────────────────────────────────────────────
    // 加一个设置项 = 在这里加一行。kind: text | list | number | boolean | select
    const FIELDS = [
      {
        key: 'targetSessionId',
        label: '目标会话',
        kind: 'session',
        hint: '要接管哪个会话 —— 按名字选就行，不用记 id。',
      },
      {
        key: 'nicknames',
        label: '昵称',
        kind: 'list',
        hint: '被叫到这些名字必然唤醒；逗号分隔，例如：244, 猫猫。',
      },
      {
        key: 'wakeProbability',
        label: '唤醒概率',
        kind: 'number',
        step: '0.01',
        hint: '既没被 @ 也没叫名字时的唤醒概率（0–1）。默认 0.05 = 5%；嫌耗 token 就调小。',
      },
      {
        key: 'whitelist',
        label: '私聊白名单',
        kind: 'list',
        hint: '允许唤醒的私聊 QQ 号；**空 = 谁都不能唤醒**。',
      },
      {
        key: 'groupWhitelist',
        label: '群白名单',
        kind: 'list',
        hint: '允许唤醒的群号；**空 = 任何群都不唤醒**。',
      },
      {
        key: 'atOnlyInGroup',
        label: '群里只认 @',
        kind: 'boolean',
        hint: '开启后，群里没被 @ 就完全不处理（比概率唤醒更严）。',
      },
      {
        key: 'replyMode',
        label: '出站方式',
        kind: 'select',
        options: [
          ['marker', '标记块（默认）'],
          ['tool', '工具调用'],
          ['always', '整轮都发'],
        ],
        hint: '标记块 = 只发块里的内容；工具调用 = 关掉标记块、改用 qq_bridge_send 发送（每轮多一次模型调用，但发不出去时有明确反馈）；整轮都发 = 技术内容也会进群，慎用。',
      },
      {
        key: 'delivery',
        label: '投递方式',
        kind: 'select',
        options: [
          ['auto', '自动（忙时插话）'],
          ['followup', '排队'],
          ['steer', '总是插话'],
        ],
        hint: 'QQ 消息怎么进目标会话：自动 = 目标正忙就插话（在下一个 step 边界塞进去）、空闲时排队；排队 = 永远排成独立一轮（更稳）；总是插话 = 无论忙闲都插。',
      },
      { key: 'replyWithQuote', label: '引用原消息', kind: 'boolean', hint: '回复时引用触发的那条消息。' },
      { key: 'stripMarkdown', label: '去掉 Markdown', kind: 'boolean', hint: '出站前去掉 Markdown 标记（QQ 不渲染）。' },
      {
        key: 'replyMaxChars',
        label: '出站字数上限',
        kind: 'number',
        hint: '单条消息的字数上限，超长自动分段发送。',
      },
      {
        key: 'onebotUrl',
        label: 'OneBot 地址',
        kind: 'text',
        hint: 'NapCat 的正向 WS 地址，如 ws://127.0.0.1:3001；留空 = 完全不启用传输。',
      },
      {
        key: 'accessTokenEnv',
        label: 'OneBot Token 凭据名',
        kind: 'text',
        hint: '指 **NapCat / OneBot 的 access_token** 存在哪个环境变量里 —— 填「变量名」（如 NAPCAT_TOKEN），不是 token 本身；NapCat 没开 token 校验就留空。⚠️ 不是模型 API key（DeepSeek 等），两者无关，别填错。',
        check: (v) => {
          const s = String(v ?? '').trim()
          if (s === '') return null
          if (/^(sk-|Bearer\s)/i.test(s) || s.length > 64 || /[.\s]/.test(s)) {
            return '这看起来像一串 token —— 这一栏要填的是「存它的环境变量名」（如 NAPCAT_TOKEN），不是 token 本身。'
          }
          return null
        },
      },
      { key: 'selfId', label: '机器人 QQ', kind: 'text', hint: '留空 = 连上后自动获取。' },
      // ↓ 这些键以前只在 Schema 里、卡片上没做输入框，等于"设了也改不了"（用户报的正是这个）
      {
        key: 'visionModel',
        label: '识图模型',
        kind: 'text',
        hint: '给图片写描述的多模态模型，形如 provider/model（如 deepseek-official/deepseek-v4-flash-vision-exp）；留空 = 自动找（优先名字带 vision 的）。',
      },
      { key: 'attachRecentChat', label: '附带未唤醒记录', kind: 'boolean', hint: '唤醒时是否把"未唤醒期间"的聊天记录一并附上。' },
      { key: 'recentChatLimit', label: '附带条数', kind: 'number', hint: '上面那段摘要最多带最近几条（0–200）。' },
      { key: 'napcatInstallDir', label: 'NapCat 目录', kind: 'text', hint: 'NapCat 安装目录；留空 = $DSH_HOME/napcat。' },
      { key: 'napcatVersion', label: 'NapCat 版本', kind: 'text', hint: '要下载的版本 tag（如 v4.18.28）；留空 = 最新。' },
      { key: 'downloadProxy', label: '下载代理', kind: 'text', hint: '下载 NapCat 用的 HTTP 代理（如 http://127.0.0.1:7890）；留空 = 读环境变量。' },
      { key: 'onebotPort', label: 'OneBot 端口', kind: 'number', hint: '写进 NapCat 配置、并用来连的正向 WS 端口。' },
      { key: 'qqNumber', label: '快速登录 QQ', kind: 'text', hint: '快速登录用的 QQ 号（需先成功登录过一次）。' },
    ]

    function format(field, raw) {
      if (field.kind === 'list') return Array.isArray(raw) ? raw.join(', ') : raw == null ? '' : String(raw)
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') return raw == null || raw === '' ? '' : String(raw)
      return raw == null ? '' : String(raw)
    }

    /** 表单值 → 要写进设置的 JSON；数字不合法返回 undefined（拦住保存）。 */
    function parse(field, raw) {
      if (field.kind === 'list') {
        return String(raw == null ? '' : raw)
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter((s) => s !== '')
      }
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') {
        const n = Number(raw)
        return Number.isFinite(n) ? n : undefined
      }
      return String(raw == null ? '' : raw).trim()
    }

    function draftFrom(value) {
      const v = value && typeof value === 'object' ? value : {}
      const draft = {}
      for (const f of FIELDS) draft[f.key] = format(f, v[f.key])
      return draft
    }

    function same(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /**
     * 会话下拉的选项：真实的会话列表 + 「不驱动」+ 一个兜底项。
     *
     * **归档的会话不列出来**（用户报的 bug：下拉里混进了一堆早就归档的会话）——
     * 归档集在 workspace 域：`ctx.workspaces.list.getSnapshot().archivedSessionIds`。
     *
     * 两个兜底项都是必要的：
     * - 配置里那个 id 可能**不在**列表里（别的工作区、宿主还没加载完）；
     * - 也可能**正好是归档的**（用户刚把它归档了）。
     * 两种都必须保留成选项，否则用户一保存就把目标会话清空了。
     */
    function sessionOptions(state, current, archivedIds) {
      const archived = new Set((Array.isArray(archivedIds) ? archivedIds : []).map((id) => String(id)))
      const out = [{ value: '', label: '（不驱动任何会话）' }]
      const ids = Array.isArray(state?.ids) ? state.ids : []
      const byId = state && typeof state.byId === 'object' && state.byId ? state.byId : {}
      const cur = String(current ?? '')
      const seen = new Set([''])
      for (const id of ids) {
        const key = String(id)
        const isArchived = archived.has(key)
        // 归档的一律不显示 —— 除非它就是当前选中的那个（不显示的话就没法保留/换掉了）
        if (isArchived && key !== cur) continue
        seen.add(key)
        const row = byId[id] ?? {}
        const title = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : key
        out.push({
          value: key,
          label: `${title}${row.running ? '（运行中）' : ''}${isArchived ? '（已归档）' : ''}`,
        })
      }
      if (cur !== '' && !seen.has(cur)) {
        out.push({ value: cur, label: `${cur}（${archived.has(cur) ? '已归档' : '不在会话列表里'}）` })
      }
      return out
    }

    /** 没有 sessions / workspaces 服务（或它们还没就绪）时用的稳定空快照 —— 必须稳定，否则 useSyncExternalStore 会死循环。 */
    const EMPTY_SESSION_LIST = { ids: [], byId: {} }
    const EMPTY_WORKSPACES = { archivedSessionIds: [] }

    // ── 样式（内联，跟随主题文字色） ──────────────────────────────────────────
    const BORDER = '1px solid rgba(127,127,127,0.35)'
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px' },
      head: { display: 'flex', flexDirection: 'column', gap: '2px' },
      title: { fontSize: '14px', fontWeight: 600 },
      sub: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: '8px 12px', alignItems: 'start' },
      label: { fontSize: '13px', paddingTop: '5px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 8px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
      },
      hint: { fontSize: '11px', opacity: 0.55, marginTop: '3px', lineHeight: 1.5 },
      check: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', paddingTop: '4px' },
      foot: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      btn: {
        padding: '5px 14px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
      },
      primary: { background: 'rgba(127,127,127,0.18)', fontWeight: 600 },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '8px 10px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
      },
      chevron: { marginLeft: 'auto', opacity: 0.6 },
      note: { fontSize: '12px', opacity: 0.7 },
      err: { fontSize: '12px', color: '#e5534b' },
      overridden: { fontSize: '11px', opacity: 0.5, marginLeft: '4px' },
    }

    function disabled(btn, off) {
      return off ? { ...btn, opacity: 0.5, cursor: 'default' } : btn
    }

    // ── 卡片 ──────────────────────────────────────────────────────────────────

    function Card(props) {
      const scope = props.scope
      const subscribe = react.useCallback((cb) => scope.subscribe(cb), [scope])
      const getSnapshot = react.useCallback(() => scope.getSnapshot(), [scope])
      const snap = react.useSyncExternalStore(subscribe, getSnapshot)

      const [draft, setDraft] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [note, setNote] = react.useState('')
      // 折叠块：跟官方那几张卡片一致 —— 默认收起
      const [open, setOpen] = react.useState(false)

      const current = react.useMemo(() => draftFrom(snap.value), [snap.value])
      const shown = draft ?? current
      const dirty = draft !== null && !same(draft, current)
      const user = snap.user && typeof snap.user === 'object' ? snap.user : {}

      // ── 目标会话的下拉数据源 ──────────────────────────────────────────────
      // ctx.sessions.list 是客户端 SDK 暴露的会话列表快照（ObservableSnapshot）。
      // 取不到（这个部署没装 sessions 服务、或它还没就绪）就退回「只有兜底项」，
      // 卡片本身照常渲染 —— 宁可少一个下拉，也不要整张卡片消失。
      const sessions = props.sessionsOf ? props.sessionsOf() : undefined
      const listStore = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list : undefined
      const listSubscribe = react.useCallback((cb) => (listStore ? listStore.subscribe(cb) : () => {}), [listStore])
      const listGetSnapshot = react.useCallback(
        () => (listStore ? listStore.getSnapshot() : EMPTY_SESSION_LIST),
        [listStore],
      )
      const sessionList = react.useSyncExternalStore(listSubscribe, listGetSnapshot)
      react.useEffect(() => {
        // 进卡片时拉一次，免得显示的是很久以前的标题
        if (sessions && typeof sessions.refresh === 'function') Promise.resolve(sessions.refresh()).catch(() => {})
      }, [sessions])

      // 归档集在 workspace 域：ctx.workspaces.list 的快照里有 archivedSessionIds
      //（"Complete registry-global archive set"）。取不到就当作「没有归档的会话」——
      // 宁可多列几个，也别把用户能选的会话藏掉。
      const workspaces = props.workspacesOf ? props.workspacesOf() : undefined
      const wsStore =
        workspaces && workspaces.list && typeof workspaces.list.getSnapshot === 'function' ? workspaces.list : undefined
      const wsSubscribe = react.useCallback((cb) => (wsStore && typeof wsStore.subscribe === 'function' ? wsStore.subscribe(cb) : () => {}), [wsStore])
      const wsGetSnapshot = react.useCallback(() => {
        if (!wsStore) return EMPTY_WORKSPACES
        try {
          return wsStore.getSnapshot() ?? EMPTY_WORKSPACES
        } catch {
          return EMPTY_WORKSPACES
        }
      }, [wsStore])
      const workspaceSnapshot = react.useSyncExternalStore(wsSubscribe, wsGetSnapshot)

      function change(key) {
        return (event) => {
          const next = { ...shown }
          next[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
          setDraft(next)
          setNote('')
          setError('')
        }
      }

      async function save() {
        setBusy(true)
        setError('')
        setNote('')
        try {
          const writes = []
          for (const f of FIELDS) {
            if (same(current[f.key], shown[f.key])) continue
            const next = parse(f, shown[f.key])
            if (next === undefined) throw new Error(`「${f.label}」不是合法数字`)
            writes.push([f.key, next])
          }
          for (const [key, value] of writes) await scope.set(key, value)
          setDraft(null)
          setNote(writes.length === 0 ? '没有改动' : `已保存 ${writes.length} 项`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      if (snap.status === 'loading') {
        return h('div', { style: S.wrap }, h('div', { style: S.sub }, '载入设置中…'))
      }
      if (snap.status === 'unavailable') {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.title }, 'QQ 桥接'),
          h(
            'div',
            { style: S.sub },
            '这个部署没有为 qq-bridge 提供可写的设置服务（settings 提供者没挂载，或连接处于内存模式）。设置仍然可以用 cordis.patch.yml 改。',
          ),
        )
      }

      const rows = []
      for (const f of FIELDS) {
        const value = shown[f.key]
        const overridden = Object.prototype.hasOwnProperty.call(user, f.key)
        let control
        if (f.kind === 'boolean') {
          control = h(
            'label',
            { style: S.check },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              disabled: !snap.writable || busy,
              onChange: change(f.key),
            }),
            h('span', null, f.hint || ''),
          )
        } else if (f.kind === 'select') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            (f.options || []).map(([v, text]) => h('option', { key: v, value: v }, text)),
          )
        } else if (f.kind === 'session') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            sessionOptions(sessionList, value, workspaceSnapshot?.archivedSessionIds).map((o) =>
              h('option', { key: o.value || '(none)', value: o.value }, o.label),
            ),
          )
        } else {
          control = h('input', {
            type: f.kind === 'number' ? 'number' : 'text',
            ...(f.step ? { step: f.step } : {}),
            style: S.input,
            value: String(value),
            disabled: !snap.writable || busy,
            onChange: change(f.key),
            spellCheck: false,
          })
        }
        rows.push(h('div', { key: f.key, style: S.label }, f.label, overridden ? h('span', { style: S.overridden }, '·已覆盖') : null))
        rows.push(
          h(
            'div',
            { key: `${f.key}-ctl` },
            control,
            f.kind !== 'boolean' && f.hint
              ? h(
                  'div',
                  { style: S.hint },
                  // 会话下拉额外把真实 id 显示出来：看着名字选，但真要手抄/核对时 id 就在旁边
                  (f.kind === 'session' && String(value) !== '' ? `${f.hint}当前：${value}` : f.hint) +
                    (typeof f.check === 'function' && f.check(value) ? `\n⚠️ ${f.check(value)}` : ''),
                )
              : null,
          ),
        )
      }

      const header = h(
        'button',
        { type: 'button', onClick: () => setOpen(!open), 'aria-expanded': open, style: S.header },
        h('span', { style: S.title }, 'QQ 桥接'),
        h('span', { style: S.sub }, dirty ? '有未保存的改动' : '把固定的 DSH 会话接到 QQ'),
        h('span', { style: S.chevron }, open ? '▴' : '▾'),
      )
      // 默认收起：和官方那几张卡片一样，点标题才展开，免得一屏全是表单
      if (!open) return h('div', { style: S.wrap }, header)
      return h(
        'div',
        { style: S.wrap },
        header,
        h('div', { style: S.grid }, rows),
        h(
          'div',
          { style: S.foot },
          h(
            'button',
            {
              type: 'button',
              style: disabled({ ...S.btn, ...S.primary }, !dirty || busy || !snap.writable),
              disabled: !dirty || busy || !snap.writable,
              onClick: save,
            },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, !dirty || busy),
              disabled: !dirty || busy,
              onClick: () => {
                setDraft(null)
                setError('')
                setNote('')
              },
            },
            '放弃修改',
          ),
          !snap.writable ? h('span', { style: S.note }, '（只读：这个连接不改宿主文档）') : null,
          error ? h('span', { style: S.err }, error) : null,
          !error && note ? h('span', { style: S.note }, note) : null,
        ),
      )
    }

    // ── 插件 ──────────────────────────────────────────────────────────────────

    /** 需要的浏览器服务：slots（注册卡片）；settingsScope 在 apply 里等它出现。 */
    const inject = ['slots']

    function apply(ctx) {
      // 设置域不在时不要报错：等它出现再注册（Cordis 的 ctx.inject 是响应式的）。
      ctx.inject(['settingsScope'], (scoped) => {
        const scope = scoped.settingsScope.bind({ namespace: NS })
        scoped.slots.inject('settings.plugin.item', () =>
          scoped.slots.register(
            {
              name: 'settings.plugin.item',
              key: NS,
              // 卡片按 settings 命名空间派发：key 不对 = 界面上什么都不出现。
            },
            // sessionsOf 用「取的时候再解析」而不是现在取一次：
            // sessions 服务可能比本插件晚出现，也可能这个部署根本没装 —— 那时卡片照常渲染，
            // 只是目标会话那一栏只有一个兜底项，而不是整张卡片消失。
            () => h(Card, { scope, sessionsOf: () => ctx.get('sessions'), workspacesOf: () => ctx.get('workspaces') }),
          ),
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    // 导出 name：Cordis 用它做插件标识，Slots inspect 里的 registrant 会显示成它
    // （不导的话那边显示的是产物里的 fallback 短名，排障时认不出是谁注册的卡片）。
    exports.name = 'dsh-qq-bridge'
    // 纯函数给离线测试用（test-smoke.mjs 会在假 ctx 里真跑这个 bundle）。
    // Cordis 只认 apply / inject / name / Config，多余的导出它不管。
    exports.__test = { sessionOptions, draftFrom, parse, fields: FIELDS }
    return module.exports
  },
})
