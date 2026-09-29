// onebot.js — OneBot v11（NapCat / go-cqhttp）传输层。
//
// 设计要点（都是被环境逼出来的，改之前先读）：
//
//   1) **用 Node 内置的全局 WebSocket，不引 `ws` 依赖。**
//      插件目录里只挂了一个 `@deepseek-ai` junction（见 README 的 link 安装坑），
//      `ws` 从这个目录解析不到（ERR_MODULE_NOT_FOUND）。Node >= 22 自带
//      WHATWG WebSocket 客户端，零依赖。
//
//   2) **access_token 只能走查询串。**
//      内置 WebSocket 是 WHATWG 接口，构造函数只收 (url, protocols)，
//      **不支持自定义请求头**，所以没法像别的客户端那样发 `Authorization: Bearer`。
//      OneBot 的 WS 服务端（NapCat / go-cqhttp）都支持 `?access_token=…`，走它。
//
//   3) **getUrl / getToken 传「函数」而不是值。**
//      DSH 的凭据契约要求「每次操作重新解析、不得跨操作缓存」，这样轮换 token
//      不用重启进程。所以每次建连环都重新取一次。
//
//   4) **所有定时器都归 dispose() 管。**
//      插件被 stop / update / undefine 时必须能干净地停掉，不留悬挂连接和定时器。

/** WebSocket.OPEN（不依赖全局常量，避免运行时差异）。 */
const WS_OPEN = 1

/**
 * 建一个 OneBot 传输实例。返回的对象是插件生命周期内唯一持有的东西，
 * 所有副作用（连接、定时器、待决调用）都由 dispose() 回收。
 *
 * @param {object} options
 * @param {() => string} options.getUrl          每次建连时取 WS 地址；返回空串 = 不连。
 * @param {() => (string | Promise<string>)} options.getToken 每次建连时取 token（可为异步）。
 * @param {(event: object) => void} options.onEvent        OneBot 事件（非 echo 回包）。
 * @param {(status: object) => void} [options.onStateChange] 连接状态变化通知。
 * @param {{info: Function, warn: Function}} options.logger
 * @param {number} [options.reconnectMinMs]
 * @param {number} [options.reconnectMaxMs]
 * @param {number} [options.heartbeatTimeoutMs] 多久没有任何流量就判定连接已死。
 * @param {number} [options.echoTimeoutMs]     action 调用等待 echo 回包的超时。
 */
export function createOneBotTransport(options) {
  const {
    getUrl,
    getToken,
    onEvent,
    onStateChange,
    logger,
    reconnectMinMs = 1000,
    reconnectMaxMs = 30000,
    heartbeatTimeoutMs = 90000,
    echoTimeoutMs = 20000,
  } = options

  let socket = null
  let stopped = true
  let reconnectDelay = reconnectMinMs
  let reconnectTimer = null
  let watchdogTimer = null
  let lastTrafficAt = 0
  let echoSeq = 0
  const pending = new Map()

  const status = {
    state: 'idle', // idle | connecting | open | closed | reconnecting | disabled
    url: '',
    selfId: null,
    connectedAt: null,
    lastError: null,
    reconnects: 0,
    received: 0,
    sent: 0,
  }

  function snapshot() {
    return {
      ...status,
      pendingCalls: pending.size,
      lastTrafficAt: lastTrafficAt || null,
      reconnectDelayMs: reconnectDelay,
    }
  }

  function notify() {
    try {
      onStateChange?.(snapshot())
    } catch (error) {
      logger.warn(`onStateChange failed: ${error?.message ?? error}`)
    }
  }

  function setState(next, patch = {}) {
    status.state = next
    Object.assign(status, patch)
    notify()
  }

  // ── 定时器 ────────────────────────────────────────────────────────────────

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function armWatchdog() {
    if (watchdogTimer !== null) return
    // 用一个较长周期的 interval 检查「最近有没有流量」；OneBot 的 heartbeat
    // 元事件默认 5s 一条，所以正常情况永远不会触发。
    const tick = Math.max(5000, Math.floor(heartbeatTimeoutMs / 3))
    watchdogTimer = setInterval(() => {
      if (stopped || !socket || socket.readyState !== WS_OPEN) return
      if (Date.now() - lastTrafficAt <= heartbeatTimeoutMs) return
      logger.warn(`no traffic for ${heartbeatTimeoutMs}ms, forcing reconnect`)
      status.lastError = `heartbeat timeout (${heartbeatTimeoutMs}ms)`
      teardownSocket()
      scheduleReconnect()
    }, tick)
  }

  function clearWatchdog() {
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
  }

  function scheduleReconnect() {
    if (stopped) return
    clearReconnectTimer()
    setState('reconnecting', { reconnects: status.reconnects + 1 })
    // 指数退避 + 抖动，避免断网恢复时所有实例同时重连。
    const jitter = Math.floor(Math.random() * 250)
    const delay = reconnectDelay + jitter
    logger.info(`reconnecting in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxMs)
  }

  // ── 连接 ──────────────────────────────────────────────────────────────────

  function teardownSocket() {
    const ws = socket
    socket = null
    if (!ws) return
    try {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      if (ws.readyState === WS_OPEN || ws.readyState === 0) ws.close()
    } catch {
      /* 关闭失败无所谓，连接已经不可用 */
    }
  }

  function rejectPending(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
  }

  async function connect() {
    if (stopped) return

    let url
    try {
      url = String(getUrl?.() ?? '').trim()
    } catch (error) {
      logger.warn(`getUrl failed: ${error?.message ?? error}`)
      url = ''
    }
    if (url === '') {
      setState('disabled', { url: '' })
      return
    }

    let token = ''
    try {
      token = String((await getToken?.()) ?? '').trim()
    } catch (error) {
      logger.warn(`resolve access token failed: ${error?.message ?? error}`)
    }

    // 内置 WebSocket 无法自定义请求头 → token 走查询串（OneBot 服务端支持）。
    let target
    try {
      const parsed = new URL(url)
      if (token !== '') parsed.searchParams.set('access_token', token)
      target = parsed.toString()
    } catch (error) {
      status.lastError = `invalid onebotUrl: ${error?.message ?? error}`
      setState('closed', { lastError: status.lastError })
      scheduleReconnect()
      return
    }

    // 日志里只打脱敏后的地址，绝不把 token 写进日志或状态文件。
    const safeUrl = url.replace(/access_token=[^&]*/i, 'access_token=***')
    setState('connecting', { url: safeUrl })

    let ws
    try {
      ws = new WebSocket(target)
    } catch (error) {
      status.lastError = `WebSocket ctor failed: ${error?.message ?? error}`
      setState('closed', { lastError: status.lastError })
      scheduleReconnect()
      return
    }
    socket = ws

    ws.onopen = () => {
      if (socket !== ws) return
      reconnectDelay = reconnectMinMs // 成功一次就把退避清零
      lastTrafficAt = Date.now()
      setState('open', { connectedAt: Date.now(), lastError: null })
      logger.info(`connected to ${safeUrl}`)
      armWatchdog()
      // 主动问一次登录信息：selfId 是过滤自身消息的依据（防回复死循环）。
      call('get_login_info', {}).then(
        (data) => {
          const id = data?.user_id ?? data?.data?.user_id
          if (id !== undefined && id !== null && String(id) !== '') {
            status.selfId = String(id)
            notify()
            logger.info(`self_id = ${status.selfId}`)
          }
        },
        () => {
          /* 拿不到就算了：配置里的 selfId 仍可兜底 */
        },
      )
    }

    ws.onmessage = (ev) => {
      if (socket !== ws) return
      lastTrafficAt = Date.now()
      status.received += 1
      let payload
      try {
        payload = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch (error) {
        logger.warn(`non-JSON frame ignored: ${error?.message ?? error}`)
        return
      }
      if (!payload || typeof payload !== 'object') return

      if (payload.echo !== undefined && pending.has(String(payload.echo))) {
        const entry = pending.get(String(payload.echo))
        pending.delete(String(payload.echo))
        clearTimeout(entry.timer)
        if (payload.status === 'failed' || payload.retcode !== 0) {
          entry.reject(new Error(`OneBot action failed: retcode=${payload.retcode} ${payload.message ?? ''}`.trim()))
        } else {
          entry.resolve(payload.data ?? payload)
        }
        return
      }

      try {
        onEvent?.(payload)
      } catch (error) {
        logger.warn(`onEvent failed: ${error?.message ?? error}`)
      }
    }

    ws.onclose = (ev) => {
      if (socket !== ws) return
      socket = null
      clearWatchdog()
      rejectPending('transport closed')
      const reason = `closed (code=${ev?.code ?? '?'}${ev?.reason ? `, ${ev.reason}` : ''})`
      setState('closed', { connectedAt: null, lastError: status.lastError ?? reason })
      logger.warn(`disconnected: ${reason}`)
      scheduleReconnect()
    }

    ws.onerror = () => {
      // WHATWG 的 error 事件不带细节；真正的诊断信息在随后的 close 事件里。
      // 这里只记录「发生过错误」，绝不冒泡（插件 bug 不能弄崩宿主）。
      if (socket !== ws) return
      status.lastError = status.lastError ?? 'websocket error'
    }
  }

  // ── 对外 API ──────────────────────────────────────────────────────────────

  /** 启动（幂等）。地址为空时不连，状态停在 disabled。 */
  function start() {
    if (!stopped) return
    stopped = false
    reconnectDelay = reconnectMinMs
    connect()
  }

  /** 立刻重连一次（调试用）。 */
  function reconnectNow() {
    if (stopped) {
      start()
      return
    }
    clearReconnectTimer()
    teardownSocket()
    rejectPending('manual reconnect')
    reconnectDelay = reconnectMinMs
    connect()
  }

  /** 是否已连上。 */
  function isOpen() {
    return socket !== null && socket.readyState === WS_OPEN
  }

  /**
   * 发一个 OneBot action 并等待 echo 回包。
   * 未连接时抛错——上层据此决定「出站丢弃」还是「排队」。
   */
  function call(action, params = {}) {
    if (!isOpen()) return Promise.reject(new Error('OneBot transport is not connected'))
    echoSeq += 1
    const echo = `qq-bridge-${echoSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(echo)
        reject(new Error(`OneBot action "${action}" timed out after ${echoTimeoutMs}ms`))
      }, echoTimeoutMs)
      pending.set(echo, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ action, params, echo }))
        status.sent += 1
      } catch (error) {
        clearTimeout(timer)
        pending.delete(echo)
        reject(error)
      }
    })
  }

  /** 停止并回收一切副作用。可以重复调用。 */
  function dispose() {
    stopped = true
    clearReconnectTimer()
    clearWatchdog()
    teardownSocket()
    rejectPending('transport disposed')
    status.state = 'idle'
    status.connectedAt = null
  }

  return { start, dispose, reconnectNow, isOpen, call, status: snapshot }
}
