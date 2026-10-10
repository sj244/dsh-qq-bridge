// stickers.js — 表情包登记表：纯函数 + 文件读写，导出以便测试。
//
// 登记表把“群里出现过的一张图”变成可复用的资产：
//   * 图片本体复制到 `qq-bridge-stickers/<hash>.<ext>`；
//   * 元数据（mood / description / 来源 / 发送次数）写在 `qq-bridge-stickers.json`。
//
// hash 取图片字节 sha256 的**前 16 位十六进制**（小写）—— 与 `qq-bridge-images/` 的文件名同构，
// 因此登记的图能直接命中宿主的图片描述缓存（省一次多模态调用）。
//
// 本文件不依赖 index.js，也不碰任何宿主服务：读不到、坏了都返回空表，绝不抛。

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

/** 登记表的文件名（放在 statePath 同一个目录）。 */
export const STICKERS_FILE = 'qq-bridge-stickers.json'
/** 图片本体目录名（同样放在 statePath 同一个目录）。 */
export const STICKERS_DIR = 'qq-bridge-stickers'
/** hash 位数（sha256 十六进制的前 16 位）。 */
export const HASH_LEN = 16
/** 短哈希位数（正文占位符与工具里显示的是它）。 */
export const SHORT_HASH_LEN = 6

/** 图片字节 → 16 位小写十六进制 hash。 */
export function hashOfBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, HASH_LEN)
}

/** 长哈希 → 短哈希。传进来空值时返回空串（调用方据此退回不带 hash 的占位符）。 */
export function shortHash(hash) {
  return String(hash ?? '')
    .trim()
    .toLowerCase()
    .slice(0, SHORT_HASH_LEN)
}

/** 空登记表。 */
export function emptyStore() {
  return { version: 1, stickers: {} }
}

/** 把任意输入收敛成 `{ version: 1, stickers }`，坏结构当空表。 */
function normalizeStore(data) {
  if (!data || typeof data !== 'object') return emptyStore()
  const stickers =
    data.stickers && typeof data.stickers === 'object' && !Array.isArray(data.stickers) ? data.stickers : {}
  return { version: 1, stickers }
}

/** 读登记表。文件不存在、不是 JSON、结构不对 → 返回空表，绝不抛。 */
export function loadStickers(path) {
  try {
    return normalizeStore(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return emptyStore()
  }
}

/** 原子写：先写 `*.tmp` 再 rename。失败返回 false，绝不抛。 */
export function saveStickers(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(normalizeStore(data), null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * 登记或更新一条（按 hash 合并）。
 *
 * 没有显式给值时保留旧的 `addedAt` / `sentCount` / `lastSentAt`：
 * 重存同一张图只该换 mood 与描述，不该把累计发送次数清零。
 */
export function upsertSticker(store, entry) {
  // 就地改传进来的那个对象：调用方（宿主半）把它当“内存里的登记表”持有，
  // 拿一份新对象回写会让它悄悄丢失这次登记。
  const s = store && typeof store === 'object' ? store : emptyStore()
  if (!s.stickers || typeof s.stickers !== 'object' || Array.isArray(s.stickers)) s.stickers = {}
  s.version = 1
  const hash = String(entry?.hash ?? '')
    .trim()
    .toLowerCase()
  if (hash === '') return null
  const prev = s.stickers[hash] && typeof s.stickers[hash] === 'object' ? s.stickers[hash] : {}
  const next = { ...prev, ...entry, hash }
  if (entry?.addedAt === undefined && prev.addedAt !== undefined) next.addedAt = prev.addedAt
  if (entry?.sentCount === undefined && prev.sentCount !== undefined) next.sentCount = prev.sentCount
  if (entry?.lastSentAt === undefined && prev.lastSentAt !== undefined) next.lastSentAt = prev.lastSentAt
  s.stickers[hash] = next
  return next
}

/** 列出登记项（可只列某个 mood）。按登记时间**从新到旧**排序，`limit` 为 0 时返回空数组。 */
export function listStickers(store, { mood, limit } = {}) {
  const s = normalizeStore(store)
  const m = String(mood ?? '').trim()
  let items = Object.values(s.stickers).filter((e) => e && typeof e === 'object')
  if (m !== '') items = items.filter((e) => String(e.mood ?? '') === m)
  items.sort((a, b) => Number(b.addedAt ?? 0) - Number(a.addedAt ?? 0))
  const n = Number(limit)
  return Number.isFinite(n) && n >= 0 ? items.slice(0, n) : items
}

/**
 * 查一条。`hash` 可以是短哈希或全哈希（按前缀匹配）；只给 `mood` 时返回该情绪里最近登记的一条。
 * 查不到返回 null。
 */
export function findSticker(store, { hash, mood } = {}) {
  const s = normalizeStore(store)
  const want = String(hash ?? '')
    .trim()
    .toLowerCase()
  if (want !== '') {
    if (s.stickers[want]) return s.stickers[want]
    for (const [h, e] of Object.entries(s.stickers)) {
      if (h.toLowerCase().startsWith(want)) return e
    }
    return null
  }
  const m = String(mood ?? '').trim()
  if (m === '') return null
  return listStickers(s, { mood: m, limit: 1 })[0] ?? null
}

/**
 * 把一张本地图片收进登记表：算 hash → 按需复制进 destDir → 登记并返回条目。
 *
 * 源文件读不到时**抛错**（由调用方翻成一句给模型看的提示）。落盘由调用方负责
 * （宿主半统一 `saveStickers`），这样本函数保持“输入进、条目出”的纯形状。
 */
export function importSticker({ store, srcPath, destDir, mood, description, source }) {
  const data = readFileSync(srcPath)
  const hash = hashOfBuffer(data)
  const rawExt = extname(String(srcPath ?? ''))
    .replace(/^\./, '')
    .toLowerCase()
  const ext = rawExt === '' ? 'png' : rawExt
  const name = `${hash}.${ext}`
  const destPath = join(destDir, name)
  mkdirSync(destDir, { recursive: true })
  if (!existsSync(destPath)) copyFileSync(srcPath, destPath)

  const prev = findSticker(store, { hash })
  const entry = {
    hash,
    mood: String(mood ?? '').trim(),
    description: String(description ?? '').trim(),
    // file 相对 statePath 所在目录 —— 宿主的出站按它读回图片本体。
    file: `${basename(destDir)}/${name}`,
    ext,
    source: String(source ?? '').trim(),
    // 新条目给全字段；已登记的图只换 mood / 描述，保留累计次数与首次登记时间。
    ...(prev ? {} : { addedAt: Date.now(), sentCount: 0, lastSentAt: null }),
  }
  return upsertSticker(store, entry)
}
