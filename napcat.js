// napcat.js — NapCat（OneBot 实现）的自助下载 / 校验 / 解包 / 配置 / 启停。
//
// 目标是"一键包的体验，但不真打包"：用户在会话里说一声，插件替他把 NapCat 弄好。
//
// 设计约束（改之前先读）：
//
//   1) **所有动作都由显式调用触发**。插件加载时绝不自作主张下载或执行任何东西——
//      下载并运行第三方二进制是重决定，必须由人按下那个按钮。
//
//   2) **下载优先走 ctx.subprocess + curl.exe**。原因：本机直连 GitHub 不通（实测超时），
//      必须能带上代理；而 Node 的 fetch 不读 http_proxy 环境变量，也没法传代理。
//      curl.exe 是 Windows 10+ 自带的，且天然支持 `-x`。没有 subprocess 时退回内置 fetch。
//
//   3) **ZIP 解包用纯 Node 实现**（node:zlib 的 inflateRawSync），不依赖 7z / Expand-Archive。
//      这样任何 clone 下来的人都能用，也便于离线测试（测试自己造 zip）。
//
//   4) **每次下载都按 Release API 自带的 sha256 校验**（GitHub 的 asset.digest 字段）。
//
//   5) **路径穿越防护**：zip 条目名里出现 `..` 或绝对路径一律拒绝。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const NAPCAT_REPO = 'NapNeko/NapCatQQ'
export const GITHUB_API = 'https://api.github.com'
/** OneKey 包：引导器 + 注入 hook，1 MB 左右，最省流量的入口。 */
export const DEFAULT_ASSET = 'NapCat.Shell.Windows.OneKey.zip'
/** NapCat 要求的最低 QQ NT 版本（来自 release 说明）。 */
export const MIN_QQ_BUILD = 40768

// ── 摘要与校验 ───────────────────────────────────────────────────────────────

export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sha256File(path) {
  return sha256Of(readFileSync(path))
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export function crc32(buffer) {
  let c = 0 ^ -1
  for (let i = 0; i < buffer.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff]
  return (c ^ -1) >>> 0
}

// ── ZIP 解包（纯 Node）───────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557) // EOCD + 最大注释长度
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/** 拒绝 `..` / 绝对路径 / 盘符，防止 zip 写出目录外（zip-slip）。 */
function safeEntryPath(name) {
  const cleaned = String(name).replace(/\\/g, '/')
  if (cleaned === '' || isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return null
  const parts = cleaned.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) return null
  if (parts.some((p) => p === '..')) return null
  return parts.join(sep)
}

/**
 * 解包一个 zip 到 destDir。支持 store(0) 与 deflate(8)，校验 CRC32。
 * @returns {{files: string[], bytes: number}}
 */
export function extractZip(zipPath, destDir) {
  const buf = readFileSync(zipPath)
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到 EOCD 记录')

  const count = buf.readUInt16LE(eocd + 10)
  const cenSize = buf.readUInt32LE(eocd + 12)
  const cenOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 归档')
  }

  const files = []
  let total = 0
  let off = cenOffset

  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) {
      throw new Error(`ZIP 中央目录损坏（第 ${i + 1} 项）`)
    }
    const method = buf.readUInt16LE(off + 10)
    const crc = buf.readUInt32LE(off + 16)
    const compSize = buf.readUInt32LE(off + 20)
    const rawSize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    off += 46 + nameLen + extraLen + commentLen

    if (compSize === 0xffffffff || rawSize === 0xffffffff || localOff === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 条目')
    }
    if (name.endsWith('/')) continue // 目录条目：由文件路径按需创建

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOC_SIG) {
      throw new Error(`ZIP 本地头损坏：${name}`)
    }
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const data = buf.subarray(dataStart, dataStart + compSize)

    let content
    if (method === 0) content = Buffer.from(data)
    else if (method === 8) content = inflateRawSync(data)
    else throw new Error(`ZIP 条目 "${name}" 使用了不支持的压缩方式 ${method}`)

    if (content.length !== rawSize) throw new Error(`ZIP 条目 "${name}" 解压后大小不符`)
    if (crc32(content) !== crc) throw new Error(`ZIP 条目 "${name}" CRC 校验失败`)

    const rel = safeEntryPath(name)
    if (rel === null) throw new Error(`ZIP 条目名不安全，已拒绝：${name}`)
    const target = resolve(destDir, rel)
    const root = resolve(destDir)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`ZIP 条目试图写出目标目录：${name}`)
    }

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    files.push(rel)
    total += content.length
  }

  return { files, bytes: total }
}

// ── GitHub 发行查询 ──────────────────────────────────────────────────────────

/**
 * 读一个 release（默认 latest），把 assets 规范化。
 * fetcher 可注入，便于离线测试。
 */
export async function resolveRelease({
  version = '',
  fetcher,
  apiBase = GITHUB_API,
  timeoutMs = 30000,
} = {}) {
  const url = version
    ? `${apiBase}/repos/${NAPCAT_REPO}/releases/tags/${version}`
    : `${apiBase}/repos/${NAPCAT_REPO}/releases/latest`
  const json = await fetcher.getJson(url, { timeoutMs })
  const assets = (Array.isArray(json?.assets) ? json.assets : []).map((a) => ({
    name: String(a.name ?? ''),
    url: String(a.browser_download_url ?? ''),
    size: Number(a.size ?? 0),
    // GitHub 会给 "sha256:xxxx"；老数据可能没有。
    sha256: String(a.digest ?? '').replace(/^sha256:/i, '').toLowerCase(),
  }))
  return { tag: String(json?.tag_name ?? ''), name: String(json?.name ?? ''), assets }
}

/** 按资产名选包：先精确匹配，再退化为包含匹配。 */
export function pickAsset(assets, pattern = DEFAULT_ASSET) {
  const want = String(pattern).toLowerCase()
  const exact = assets.find((a) => a.name.toLowerCase() === want)
  if (exact) return exact
  const partial = assets.find((a) => a.name.toLowerCase().includes(want))
  if (partial) return partial
  throw new Error(
    `发行包里找不到资产 "${pattern}"；可选：${assets.map((a) => a.name).join(' / ') || '（无）'}`,
  )
}

// ── 下载（curl 优先，可带代理）───────────────────────────────────────────────

/**
 * 造一个"取 JSON / 下文件"的小执行器。
 * - 有 subprocess 时用 curl.exe（可带代理；Windows 10+ 自带）
 * - 否则退回内置 fetch（不读代理环境变量）
 */
export function createFetcher({ subprocess, logger, proxy = '' }) {
  const hasCurl = Boolean(subprocess)

  async function curlPath() {
    if (!hasCurl) return ''
    try {
      return await subprocess.resolveExecutable('curl.exe')
    } catch (error) {
      logger?.warn?.(`找不到 curl.exe（${error?.message ?? error}），退回内置 fetch`)
      return ''
    }
  }

  async function runCurl(argv, cwd, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const handle = subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 8 * 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 5000,
        signal: controller.signal,
      })
      const outcome = await handle.done
      const stdout = handle.collected?.stdout ? handle.collected.stdout.readFrom(0).text : ''
      const stderr = handle.collected?.stderr ? handle.collected.stderr.readFrom(0).text : ''
      return { ...outcome, stdout, stderr }
    } finally {
      clearTimeout(timer)
    }
  }

  function curlProxyArgs() {
    return proxy ? ['-x', proxy] : []
  }

  async function getJson(url, { timeoutMs = 30000 } = {}) {
    const curl = await curlPath()
    if (curl) {
      const res = await runCurl(
        [curl, ...curlProxyArgs(), '-sSL', '--fail', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-H', 'accept: application/vnd.github+json', url],
        process.cwd(),
        timeoutMs + 10000,
      )
      if (res.exitCode !== 0) {
        throw new Error(`curl 取 ${url} 失败（exit=${res.exitCode}）：${res.stderr.trim().slice(0, 300)}`)
      }
      return JSON.parse(res.stdout)
    }
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-qq-bridge' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}`)
    return response.json()
  }

  /** 下载到 dest（不校验，校验交给调用方）。 */
  async function download(url, dest, { timeoutMs = 900000 } = {}) {
    const curl = await curlPath()
    if (curl) {
      const res = await runCurl(
        [curl, ...curlProxyArgs(), '-L', '--fail', '--silent', '--show-error', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-o', dest, url],
        dirname(dest),
        timeoutMs + 15000,
      )
      if (res.exitCode !== 0) {
        throw new Error(`下载失败（exit=${res.exitCode}）：${res.stderr.trim().slice(0, 300)}`)
      }
      return { via: 'curl', bytes: statSync(dest).size }
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, buffer)
    return { via: 'fetch', bytes: buffer.length }
  }

  return { getJson, download, usingCurl: hasCurl }
}

/**
 * 下载并**按预期 sha256 校验**。
 * 没有预期摘要时（老 release 没给 digest）只报告实际摘要，由调用方决定是否接受。
 */
export async function downloadVerified({
  fetcher,
  asset,
  dest,
  logger,
  timeoutMs = 900000,
}) {
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(dest)) rmSync(dest, { force: true })

  logger?.info?.(`下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）`)
  const result = await fetcher.download(asset.url, dest, { timeoutMs })

  const actual = sha256File(dest)
  if (asset.sha256) {
    if (actual !== asset.sha256) {
      rmSync(dest, { force: true })
      throw new Error(`sha256 校验失败：期望 ${asset.sha256}，实际 ${actual}（已删除下载文件）`)
    }
    logger?.info?.('sha256 校验通过')
  } else {
    logger?.warn?.(`该发行包未提供 sha256，实际摘要 ${actual}`)
  }
  return { ...result, sha256: actual, verified: Boolean(asset.sha256) }
}

// ── OneBot 配置 ──────────────────────────────────────────────────────────────

/**
 * 生成 NapCat 的 onebot11 默认配置（v4.5.3+ 支持 ./config/onebot11.json 作为默认配置）。
 * 插件用它在**用户点 WebUI 之前**就把正向 WS 服务端配好——这是"一键"的关键。
 */
export function oneBotConfig({ port = 3001, token = '', host = '127.0.0.1', name = 'dsh-qq-bridge' } = {}) {
  return {
    network: {
      httpServers: [],
      httpClients: [],
      websocketServers: [
        {
          name,
          enable: true,
          host,
          port: Number(port),
          messagePostFormat: 'array',
          reportSelfMessage: false, // 防回复死循环，保持 false
          token: token ?? '',
          enableForcePushEvent: true,
          debug: false,
          heartInterval: 30000,
        },
      ],
      websocketClients: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
  }
}

/** 把配置写到 <configDir>/onebot11.json。 */
export function writeOneBotConfig({ configDir, ...options }) {
  mkdirSync(configDir, { recursive: true })
  const path = join(configDir, 'onebot11.json')
  writeFileSync(path, `${JSON.stringify(oneBotConfig(options), null, 2)}\n`, 'utf8')
  return path
}

/** 读回 <configDir>/onebot11.json（不存在返回 undefined）。 */
export function readOneBotConfig(configDir) {
  const path = join(configDir, 'onebot11.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

// ── QQ 检测（只读，不碰用户的 QQ 安装）───────────────────────────────────────

const QQ_CANDIDATES = [
  'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
  'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
  'C:\\Program Files\\Tencent\\QQ\\QQ.exe',
]

/** 尽力找 QQ：只看常见安装位置 + PATH。找不到就返回空，不影响主流程。 */
export function detectQq({ env = process.env } = {}) {
  const found = []
  for (const p of QQ_CANDIDATES) {
    if (existsSync(p)) found.push(p)
  }
  const localAppData = env.LOCALAPPDATA ?? ''
  if (localAppData) {
    const p = join(localAppData, 'Programs', 'Tencent', 'QQNT', 'QQ.exe')
    if (existsSync(p)) found.push(p)
  }
  return { found, primary: found[0] ?? null }
}

// ── 安装目录 ─────────────────────────────────────────────────────────────────

/** NapCat 的默认安装目录：$DSH_HOME/napcat（跟随 DSH，不污染项目）。 */
export function defaultInstallDir(home) {
  return join(home, 'napcat')
}

/** 安装目录里的固定相对位置。 */
export function napcatPaths(installDir) {
  return {
    installDir,
    bootMain: join(installDir, 'bootmain', 'NapCatWinBootMain.exe'),
    bootDir: join(installDir, 'bootmain'),
    installer: join(installDir, 'NapCatInstaller.exe'),
    zipPath: join(installDir, 'napcat-onekey.zip'),
    configDir: join(installDir, 'config'),
  }
}

/** 目录里看起来已经装好 OneKey 了吗。 */
export function isNapcatInstalled(installDir) {
  const p = napcatPaths(installDir)
  return existsSync(p.bootMain)
}

export { join as joinPath }
