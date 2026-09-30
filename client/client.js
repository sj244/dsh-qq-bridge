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
        kind: 'text',
        hint: '固定跟哪个会话说话（session-…）。留空 = 不驱动任何会话。',
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
        label: '出站闸门',
        kind: 'select',
        options: [
          ['marker', '只发标记块（推荐）'],
          ['always', '整轮回复都发'],
        ],
        hint: 'marker = 只把标记块里的内容发到 QQ，防止技术内容刷屏。',
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
      { key: 'selfId', label: '机器人 QQ', kind: 'text', hint: '留空 = 连上后自动获取。' },
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

      const current = react.useMemo(() => draftFrom(snap.value), [snap.value])
      const shown = draft ?? current
      const dirty = draft !== null && !same(draft, current)
      const user = snap.user && typeof snap.user === 'object' ? snap.user : {}

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
            f.kind !== 'boolean' && f.hint ? h('div', { style: S.hint }, f.hint) : null,
          ),
        )
      }

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.head },
          h('div', { style: S.title }, 'QQ 桥接'),
          h(
            'div',
            { style: S.sub },
            '把固定的 DSH 会话接到 QQ。改动即时生效（写进 settings.yaml 的用户层），不用重启。',
          ),
        ),
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
            () => h(Card, { scope }),
          ),
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    // 导出 name：Cordis 用它做插件标识，Slots inspect 里的 registrant 会显示成它
    // （不导的话那边显示的是产物里的 fallback 短名，排障时认不出是谁注册的卡片）。
    exports.name = 'dsh-qq-bridge'
    return module.exports
  },
})
