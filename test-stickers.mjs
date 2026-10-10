// stickers.js 单测：哈希 / 登记表读写 / 查找 / 排序 / 原子写 / importSticker 复制文件。
// 纯离线，零依赖。运行：node test-stickers.mjs
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  findSticker,
  hashOfBuffer,
  importSticker,
  listStickers,
  loadStickers,
  saveStickers,
  shortHash,
  upsertSticker,
} from './stickers.js'

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-stickers-'))
const jsonPath = join(dir, 'qq-bridge-stickers.json')
const destDir = join(dir, 'qq-bridge-stickers')

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
const PNG2 = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000020806000000', 'hex')
const H1 = hashOfBuffer(PNG)
const H2 = hashOfBuffer(PNG2)

// 1) 哈希：稳定、16 位小写十六进制、与 sha256 前 16 位一致
{
  check('同内容 → 同哈希（稳定）', hashOfBuffer(PNG) === H1 && hashOfBuffer(Buffer.from(PNG)) === H1)
  check('不同内容 → 不同哈希', H1 !== H2, `${H1} / ${H2}`)
  check('hash 是 16 位小写十六进制', /^[0-9a-f]{16}$/.test(H1), H1)
  check(
    'hash = sha256 的前 16 位',
    H1 === createHash('sha256').update(PNG).digest('hex').slice(0, 16),
  )
  check('空 buffer 也能算（不抛）', /^[0-9a-f]{16}$/.test(hashOfBuffer(Buffer.alloc(0))))
  check('短哈希取前 6 位', shortHash(H1) === H1.slice(0, 6) && shortHash(H1).length === 6, shortHash(H1))
  check('短哈希：空值/undefined → 空串（调用方据此退回裸占位符）', shortHash('') === '' && shortHash(undefined) === '')
  check('短哈希：大写输入也归一成小写', shortHash(H1.toUpperCase()) === H1.slice(0, 6))
}

// 2) 登记与查找
{
  const store = loadStickers(jsonPath)
  check('空路径读不到 → 空表（不抛）', Object.keys(store.stickers).length === 0 && store.version === 1)
  const a = upsertSticker(store, { hash: H1, mood: '无语', description: '一只无语的猫', addedAt: 10, sentCount: 0, lastSentAt: null })
  const b = upsertSticker(store, { hash: H2, mood: '开心', description: '开心的图', addedAt: 20, sentCount: 0, lastSentAt: null })
  check('upsert 返回条目并入表', a?.hash === H1 && b?.hash === H2 && Object.keys(store.stickers).length === 2)
  check('upsert：hash 空 → 返回 null（不建脏条目）', upsertSticker(store, { mood: 'x' }) === null)
  check('find：全哈希命中', findSticker(store, { hash: H1 })?.mood === '无语')
  check('find：短哈希命中', findSticker(store, { hash: H1.slice(0, 6) })?.mood === '无语')
  check('find：只给 mood 命中该情绪里最近登记的一条', findSticker(store, { mood: '开心' })?.hash === H2)
  check('find：查不到 → null', findSticker(store, { hash: 'deadbeef' }) === null && findSticker(store, {}) === null)
  check(
    'upsert 合并：重存保留 addedAt / sentCount，只换 mood 与描述',
    (() => {
      upsertSticker(store, { hash: H1, sentCount: 3, lastSentAt: 99 })
      const again = upsertSticker(store, { hash: H1, mood: '震惊', description: '改了描述' })
      return again.mood === '震惊' && again.description === '改了描述' && again.addedAt === 10 && again.sentCount === 3 && again.lastSentAt === 99
    })(),
  )
  check('upsert：传进来的对象被就地改（宿主半持有同一份）', Object.keys(store.stickers).length === 2 && store.stickers[H1].mood === '震惊')
  saveStickers(jsonPath, store) // 下一节从盘上读，先把这两条落下来
}

// 3) 列表：mood 过滤 / 从新到旧 / limit
{
  const store = loadStickers(jsonPath)
  const all = listStickers(store)
  check('list：两条都在，且从新到旧', all.length === 2 && all[0].hash === H2 && all[1].hash === H1, all.map((e) => e.hash).join(','))
  check('list：按 mood 过滤', listStickers(store, { mood: '开心' }).length === 1 && listStickers(store, { mood: '开心' })[0].hash === H2)
  check('list：没有该情绪 → 空数组', listStickers(store, { mood: '愤怒' }).length === 0)
  check('list：limit 生效（0 也是合法值）', listStickers(store, { limit: 1 }).length === 1 && listStickers(store, { limit: 0 }).length === 0)
  check('list：不传 limit 返回全部', listStickers(store, {}).length === 2)
  saveStickers(jsonPath, store) // 后面几节都从盘上读，先落一次
}

// 4) 原子写 + 坏文件
{
  check('save 成功返回 true', saveStickers(jsonPath, loadStickers(jsonPath)) === true)
  check('落盘内容可读回（JSON 合法 + 值对）', JSON.parse(readFileSync(jsonPath, 'utf8')).stickers[H1].mood === '震惊')
  check('不留 .tmp 残留文件', !existsSync(`${jsonPath}.tmp`) && !readdirSync(dir).some((n) => n.endsWith('.tmp')))
  writeFileSync(jsonPath, '{ 这不是 JSON', 'utf8')
  check('坏文件 → 空表，不抛', Object.keys(loadStickers(jsonPath).stickers).length === 0)
  writeFileSync(jsonPath, JSON.stringify({ version: 1, stickers: '不是对象' }), 'utf8')
  check('结构不对（stickers 不是对象）→ 空表', Object.keys(loadStickers(jsonPath).stickers).length === 0)
  writeFileSync(jsonPath, JSON.stringify({ stickers: { [H1]: { hash: H1 } } }), 'utf8')
  check('结构对但缺字段 → 原样读回', loadStickers(jsonPath).stickers[H1].hash === H1)
  // 父路径是一个文件：mkdirSync 必失败 → 返回 false，不抛
  const bogus = join(jsonPath, 'nested', 'x.json')
  check('写不进去 → 返回 false，不抛', saveStickers(bogus, loadStickers(jsonPath)) === false)
}

// 5) importSticker：复制文件 + 登记
{
  const src1 = join(dir, 'from-group.png')
  writeFileSync(src1, PNG)
  const store = loadStickers(join(dir, 'fresh.json'))
  check('importSticker 用一张干净的登记表起步', Object.keys(store.stickers).length === 0)
  const entry = importSticker({ store, srcPath: src1, destDir, mood: '无语', description: '一只无语的猫', source: 'group:12345678' })
  check('importSticker：返回条目（hash / ext / file / source）', entry?.hash === H1 && entry.ext === 'png' && entry.mood === '无语' && entry.source === 'group:12345678', JSON.stringify(entry))
  check('importSticker：file 是相对路径 qq-bridge-stickers/<hash>.png', entry.file === `qq-bridge-stickers/${H1}.png`, String(entry.file))
  check('importSticker：图片本体已复制进 destDir', existsSync(join(destDir, `${H1}.png`)) && readFileSync(join(destDir, `${H1}.png`)).equals(PNG))
  check('importSticker：新条目带 addedAt / sentCount / lastSentAt', typeof entry.addedAt === 'number' && entry.addedAt > 0 && entry.sentCount === 0 && entry.lastSentAt === null)
  check('importSticker：登记进 store（就地）', findSticker(store, { hash: H1.slice(0, 6) })?.description === '一只无语的猫')
  check('importSticker：store 落盘后仍是同一条', (() => {
    saveStickers(jsonPath, store)
    return loadStickers(jsonPath).stickers[H1].mood === '无语'
  })())

  // 同一张图再存一次：只换 mood / 描述，累计次数与首次登记时间保留
  upsertSticker(store, { hash: H1, sentCount: 5, lastSentAt: 123 })
  const again = importSticker({ store, srcPath: src1, destDir, mood: '开心', description: '重存一次' })
  check(
    'importSticker：重存保留 sentCount / lastSentAt / addedAt，只换 mood 与描述',
    again.mood === '开心' && again.description === '重存一次' && again.sentCount === 5 && again.lastSentAt === 123 && again.addedAt === entry.addedAt,
    JSON.stringify(again),
  )
  check('importSticker：已存在的目标文件不重复复制（内容不变）', readFileSync(join(destDir, `${H1}.png`)).equals(PNG))
  check('importSticker：源文件不存在 → 抛错（由工具翻成提示）', (() => {
    try {
      importSticker({ store, srcPath: join(dir, '不存在.png'), destDir, mood: 'x', description: 'y' })
      return false
    } catch {
      return true
    }
  })())
  check('importSticker：无扩展名的源文件回落到 png', (() => {
    const src2 = join(dir, 'noext')
    writeFileSync(src2, PNG2)
    const e2 = importSticker({ store, srcPath: src2, destDir, mood: '开心', description: '无扩展名' })
    return e2.ext === 'png' && e2.file === `qq-bridge-stickers/${H2}.png`
  })())
}

rmSync(dir, { recursive: true, force: true })

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
