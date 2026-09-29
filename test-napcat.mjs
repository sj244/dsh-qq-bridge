// napcat.js 的离线测试：ZIP 解包 / 摘要校验 / 发行包选择 / 配置写入。
//
// 测试自己造 zip（node:zlib），所以不需要 7z、PowerShell 或任何外部工具，
// 任何 clone 下来的人 `node test-napcat.mjs` 都能跑。
//
// 运行：node test-napcat.mjs
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  crc32,
  defaultInstallDir,
  detectQq,
  downloadVerified,
  extractZip,
  isNapcatInstalled,
  napcatPaths,
  oneBotConfig,
  pickAsset,
  readOneBotConfig,
  resolveRelease,
  sha256Of,
  writeOneBotConfig,
} from './napcat.js'

let failed = 0
function check(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failed++
}

// ── 测试用的极小 ZIP 打包器 ──────────────────────────────────────────────────

function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.content ?? '', 'utf8')
    const method = entry.method ?? 0
    const data = method === 8 ? deflateRawSync(raw) : raw
    const crc = entry.crcOverride ?? crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    centrals.push(cen, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }

  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const work = mkdtempSync(join(tmpdir(), 'qq-bridge-napcat-'))
const writeZip = (name, entries) => {
  const p = join(work, name)
  writeFileSync(p, makeZip(entries))
  return p
}

// ── 1) crc32 已知值 ─────────────────────────────────────────────────────────

check('crc32("123456789") = 0xCBF43926', crc32(Buffer.from('123456789')) === 0xcbf43926)
check('crc32("") = 0', crc32(Buffer.alloc(0)) === 0)

// ── 2) ZIP 解包 ──────────────────────────────────────────────────────────────

// 2a) store 方式
{
  const zip = writeZip('store.zip', [{ name: 'bootmain/ReadMe.txt', content: 'hello store' }])
  const out = join(work, 'out-store')
  const r = extractZip(zip, out)
  check('解包 store 条目', readFileSync(join(out, 'bootmain', 'ReadMe.txt'), 'utf8') === 'hello store')
  check('返回文件清单', r.files.length === 1 && r.files[0] === join('bootmain', 'ReadMe.txt'), JSON.stringify(r.files))
}

// 2b) deflate 方式 + 中文内容 + 嵌套目录
{
  const zip = writeZip('deflate.zip', [
    { name: 'a/b/c.txt', content: '压缩条目内容 deflate ✅', method: 8 },
    { name: 'top.txt', content: 'top', method: 8 },
  ])
  const out = join(work, 'out-deflate')
  extractZip(zip, out)
  check('解包 deflate 条目（含中文）', readFileSync(join(out, 'a', 'b', 'c.txt'), 'utf8') === '压缩条目内容 deflate ✅')
  check('解包多个条目', readFileSync(join(out, 'top.txt'), 'utf8') === 'top')
}

// 2c) zip-slip 防护
{
  const zip = writeZip('slip.zip', [{ name: '../escaped.txt', content: 'evil' }])
  let threw = false
  try {
    extractZip(zip, join(work, 'out-slip'))
  } catch {
    threw = true
  }
  check('拒绝 zip-slip（../ 条目）', threw)
  check('未在目标目录外写出文件', !existsSync(join(work, 'escaped.txt')))
}

// 2d) 绝对路径条目
{
  const zip = writeZip('abs.zip', [{ name: 'C:/windows/evil.txt', content: 'evil' }])
  let threw = false
  try {
    extractZip(zip, join(work, 'out-abs'))
  } catch {
    threw = true
  }
  check('拒绝绝对路径条目', threw)
}

// 2e) CRC 不符要报错
{
  const zip = writeZip('badcrc.zip', [{ name: 'x.txt', content: 'payload', crcOverride: 12345 }])
  let msg = ''
  try {
    extractZip(zip, join(work, 'out-badcrc'))
  } catch (e) {
    msg = e.message
  }
  check('CRC 校验失败会报错', msg.includes('CRC'), msg)
}

// 2f) 损坏的 zip
{
  const p = join(work, 'notzip.zip')
  writeFileSync(p, Buffer.from('this is definitely not a zip file'))
  let threw = false
  try {
    extractZip(p, join(work, 'out-notzip'))
  } catch {
    threw = true
  }
  check('非 zip 文件报错', threw)
}

// ── 3) 发行包选择 ───────────────────────────────────────────────────────────

const assets = [
  { name: 'NapCat.Framework.zip', url: 'u1', size: 1, sha256: '' },
  { name: 'NapCat.Shell.zip', url: 'u2', size: 2, sha256: '' },
  { name: 'NapCat.Shell.Windows.OneKey.zip', url: 'u3', size: 3, sha256: '' },
]
check('精确匹配资产', pickAsset(assets, 'NapCat.Shell.Windows.OneKey.zip').url === 'u3')
check('包含匹配资产', pickAsset(assets, 'Framework').url === 'u1')
{
  let threw = false
  try {
    pickAsset(assets, 'NoSuchThing.zip')
  } catch {
    threw = true
  }
  check('找不到资产时明确报错', threw)
}

// ── 4) resolveRelease（注入假 fetcher）──────────────────────────────────────

{
  const seen = []
  const fetcher = {
    getJson: async (url) => {
      seen.push(url)
      return {
        tag_name: 'v4.18.28',
        name: 'NapCat v4.18.28',
        assets: [
          {
            name: 'NapCat.Shell.Windows.OneKey.zip',
            browser_download_url: 'https://example.invalid/onekey.zip',
            size: 1035630,
            digest: 'sha256:ABCDEF',
          },
        ],
      }
    },
  }
  const rel = await resolveRelease({ fetcher })
  check('resolveRelease 解析 tag', rel.tag === 'v4.18.28', rel.tag)
  check('默认查询 latest', seen[0].endsWith('/releases/latest'), seen[0])
  check('sha256 去掉前缀并小写', rel.assets[0].sha256 === 'abcdef', rel.assets[0].sha256)

  const rel2 = await resolveRelease({ fetcher, version: 'v4.0.0' })
  check('指定版本时查 tags 接口', seen[1].endsWith('/releases/tags/v4.0.0'), seen[1])
  check('版本查询也能返回', rel2.tag === 'v4.18.28')
}

// ── 5) 下载 + sha256 校验 ───────────────────────────────────────────────────

{
  const payload = Buffer.from('pretend this is a napcat zip')
  const good = sha256Of(payload)
  const makeFetcher = (bytes) => ({
    download: async (_url, dest) => {
      writeFileSync(dest, bytes)
      return { via: 'fake', bytes: bytes.length }
    },
  })

  const okPath = join(work, 'dl-ok.bin')
  const ok = await downloadVerified({
    fetcher: makeFetcher(payload),
    asset: { name: 'x.zip', url: 'u', size: payload.length, sha256: good },
    dest: okPath,
  })
  check('sha256 正确时下载通过', ok.verified === true && ok.sha256 === good)
  check('文件确实落盘', existsSync(okPath))

  const badPath = join(work, 'dl-bad.bin')
  let msg = ''
  try {
    await downloadVerified({
      fetcher: makeFetcher(payload),
      asset: { name: 'x.zip', url: 'u', size: payload.length, sha256: 'deadbeef' },
      dest: badPath,
    })
  } catch (e) {
    msg = e.message
  }
  check('sha256 不符时报错', msg.includes('sha256 校验失败'), msg)
  check('校验失败会删掉坏文件', !existsSync(badPath))

  const noDigestPath = join(work, 'dl-nodigest.bin')
  const r = await downloadVerified({
    fetcher: makeFetcher(payload),
    asset: { name: 'x.zip', url: 'u', size: payload.length, sha256: '' },
    dest: noDigestPath,
  })
  check('没有摘要时只报告实际值', r.verified === false && r.sha256 === good)
}

// ── 6) OneBot 配置 ──────────────────────────────────────────────────────────

{
  const cfg = oneBotConfig({ port: 3001, token: 'tok-123' })
  const ws = cfg.network.websocketServers[0]
  check('写入正向 WS 服务端', Array.isArray(cfg.network.websocketServers) && cfg.network.websocketServers.length === 1)
  check('端口来自参数', ws.port === 3001)
  check('token 来自参数', ws.token === 'tok-123')
  check('messagePostFormat = array', ws.messagePostFormat === 'array')
  check('reportSelfMessage = false（防回环）', ws.reportSelfMessage === false)
  check('enable = true', ws.enable === true)

  const cfgDir = join(work, 'config')
  const p = writeOneBotConfig({ configDir: cfgDir, port: 3002, token: 'abc' })
  check('配置写到 <configDir>/onebot11.json', p === join(cfgDir, 'onebot11.json') && existsSync(p))
  const back = readOneBotConfig(cfgDir)
  check('读回的配置端口正确', back?.network?.websocketServers?.[0]?.port === 3002)
  check('读回不存在的目录返回 undefined', readOneBotConfig(join(work, 'nope')) === undefined)
}

// ── 7) 路径与检测 ───────────────────────────────────────────────────────────

{
  const dir = defaultInstallDir('C:\\x\\.dsh')
  check('默认安装目录 = <home>/napcat', dir === join('C:\\x\\.dsh', 'napcat'), dir)

  const paths = napcatPaths(dir)
  check('bootMain 路径正确', paths.bootMain.endsWith(join('bootmain', 'NapCatWinBootMain.exe')), paths.bootMain)
  check('未安装时 isNapcatInstalled = false', isNapcatInstalled(dir) === false)

  // 造一个"已安装"的目录
  const fake = join(work, 'fake-install')
  writeOneBotConfig({ configDir: join(fake, 'config'), port: 1 })
  mkdirSync(join(fake, 'bootmain'), { recursive: true })
  writeFileSync(join(fake, 'bootmain', 'NapCatWinBootMain.exe'), 'stub')
  check('有 bootmain 时 isNapcatInstalled = true', isNapcatInstalled(fake) === true)

  const qq = detectQq({ env: {} })
  check('detectQq 返回结构正常', Array.isArray(qq.found) && 'primary' in qq)
}

// 收尾
rmSync(work, { recursive: true, force: true })

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
