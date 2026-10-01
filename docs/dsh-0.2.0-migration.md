# DSH 0.2.0 迁移笔记（2026-10-01 真机诊断）

> 场景：桌面端 APP（`E:\DSH`，Electron 44.0.0 + `resources\app.asar`）+ profile `~/.dsh/profiles/desktop`，
> 客户端 UI 由第三方包 **`@linxin666/dsh-web-all@0.4.4`** 提供（这就是"web-all 0.4.x"）。

## 现象

设置页里「QQ 桥接」这个 tab **出现了**，但卡片正文是我们自己的兜底文案：

> 这个部署没有为 qq-bridge 提供可写的设置服务（settings 提供者没挂载，或连接处于内存模式）。

## 根因：宿主半 `fiberPhase: "failed"`

插件名单（`plugin_manager list_plugins`）里：

```json
{"entryId":"include:qq-bridge","moduleName":"dsh-qq-bridge","enabled":true,"fiberPhase":"failed","patchId":"qq-bridge"}
```

同批 `dsh-at-file` 也是 `failed`。客户端半照常加载（boot graph 只看包里的 `dsh.client` 声明），
于是"tab 在、设置源不在"。

**为什么 failed**：0.2.0 把宿主 `settings` 服务换掉了（用 Inspect 直接问活主机得到）：

| | 0.1.5-rc.3 | 0.2.0-rc.2 |
|---|---|---|
| 注册命名空间 | `ctx.settings.register(ns, Schema, opts)` | **没有这个方法** |
| 读值 | `ctx.settings.get(ns)` | **没有这个方法**；表单按 **profile entry id** 投影，`schema/value` 来自插件自己的 **Config** |
| 变更通知 | 事件 `settings/updated` | **该事件不存在** |
| 写 | （设置界面内部走 settings 文件） | `update(ns, patch, rev)` / `replace(ns, section, rev)` / `mutate(ns, ops, rev)` |
| 读 | — | `describe(options?): SettingsDescriptor[]`（`{ns, autoGenerate, schema, value, revision, base, user, applies:'live', secrets}`） |
| 页面策略 | — | `configure({ auto?: boolean }, owner?)` |

我们 `index.js:250` 调 `ctx.settings.register(NS, BridgeSettings, {...})` → 0.2.0 上 `TypeError` → `apply` 抛错。

## 客户端侧的两个变化轴（已适配，可保留）

1. **服务名**：`settingsScope`（0.1.5 / web-all 0.3.x）→ **`webUiSettings`**（0.2.0 / web-all 0.4.x）。
   已经两扇门各 `ctx.inject` 一次 + `registered` 闸门 + 门内 `ctx.get` 互兜（commit `0e64f1b` / `e5aafb0`）。
2. **挂载 slot**：`settings.plugin.item`（按 settings 命名空间派发）→ **`settings.plugins.tab`**（插件自己是一个 tab）。
   已经两个都注册（commit `8add0fb`）。

`webUiSettings` 的 `bind({ namespace })` 与旧的一致，返回兼容 scope，有 `getSnapshot/set/subscribe`
（`createCompatScope` → `BridgeScopeController`：桥走 `api.settings.describe/mutate`）。

**`unavailable` 的三种来源**（`dsh-web-all/lib/client.js` 的 `read()`）：
① 桥调用抛错；② 返回 `!result.ok`；③ **`describe()` 返回的 namespaces 里没有这个 ns**。
我们命中的是 ③ —— 宿主半 failed → entry 没有 Config 投影。

## 迁移方案（待做）

宿主半按能力探测分成两条路：

```js
const svc = ctx.get('settings')
const legacy = typeof svc?.register === 'function' && typeof svc?.get === 'function'
if (legacy) {
  // 0.1.5-rc.3：维持现状 —— register 命名空间 + settings.get 读值 + 监听 'settings/updated'
} else {
  // 0.2.0：**不再注册命名空间**，值从 apply(config) 的入参读；
  // 用 Config（export const Config 已是完整 schema + description）当表单源；
  // svc.configure?.({ auto: true }) 让这个 entry 自动生成设置页。
}
```

要点：

- `readSettings()` 在 0.2.0 分支要读 **apply 收到的 config**（用户改配置后由 loader 重新下发）。
- 客户端那张自定义卡片在 0.2.0 上大概率**不需要**了：自动生成的表单会接管（入口就是「内置插件」页）。
  保留卡片时应避免出现"unavailable 兜底文案"这种观感（可只在 legacy 分支注册卡片，
  但客户端拿不到宿主模式 —— 需要一个宿主→客户端的标志）。
- 迁移后必须真机验证：桌面端点开插件页，确认表单字段可读可写、改完即时生效。

## 环境问题（本次会话）

这个会话里 `pwsh` 直接失败：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(F:\游戏视频回放\DSH工作区)`。
即桌面端宿主的沙箱无法给该工作区授写权限 → **跑不了测试、提交不了**。
文件读写工具（read/grep/write）正常。做迁移请回到能跑命令的会话，或先解决这个 ACL 问题。

## 已修（2026-10-01）

- `hasLegacySettings(service)`（导出以便测试）按**方法探测**分流：
  老宿主维持 settings 命名空间；新宿主**不注册**、直接读 entry 配置，
  并 `settings.configure({ auto: true })` 让插件页自动生成表单。
- `readSettings()` 全部字段改为回落到 `config`：新模型下用户的值就在 config 里，
  原先只回落硬编码默认值会**悄悄丢掉用户配置**（昵称、群白名单等）。
- `settings/updated` 监听加 `legacySettings` 守卫（0.2.0 没有这个事件；那边配置变更由 loader 重新下发）。
- 回归断言 4 条进 `test-smoke.mjs`：0.2.0 形状的 settings 服务上 `apply()` **不抛错**、且**不再调 register**。
- 真机验收标准：重启桌面端后 `plugin_manager list_plugins` 里 `include:qq-bridge` 的 `fiberPhase`
  必须是 **`active`**（修前是 `failed`）；插件页应出现自动生成的设置表单。

**旁证补充**：同批 `failed` 的 `dsh-at-file` 也调了同一个被删的 API
（`dsh-at-file/lib/index.js:15892  ctx.settings.register(AT_FILE_NAMESPACE, …)`）——
两个失败的插件用同一个"0.2.0 已删除"的方法，这比单看我们的栈更硬。

## TODO（0.2.0 相关，按优先级）

- [ ] **等平台把第三方插件的设置桥接上**（首选，无需我们改代码）。
      0.2.0 + web-all 0.4.4 上**所有**第三方插件的设置表单都失效：
      `dsh-pet` 的卡片显示"当前 DSH 版本未向设置页暴露本插件的配置命名空间"，
      和我们 `bindSettings.detail()` 报的 `unavailable` 是同一根因。
      平台修好后我们的卡片会**自动恢复**（`bindSettings` 已经会挑 ready 的那个 key）。
      **恢复判据**：卡片诊断行出现 `<某个 key>=ready`。
- [ ] **（可选）自建 client↔host 设置通道**：宿主注册一个只读写本插件 config 的 API
      （typert lookup 或 API controller），客户端卡片读写走它。
      能立刻让 GUI 可用，但属于**重复实现平台能力**，平台修好后应删除。先评估成本再决定。
- [ ] **精简诊断**：`client/client.js` 的 `bindSettings.detail()` 与卡片上那行「诊断：…」是排障用的；
      平台恢复后可去掉卡片上的那行（`namespaces` / `detail()` 建议保留，排障很有用）。
- [ ] **README 补一句**：README「设置界面与全部设置项」一节在 0.2.0 上目前**不适用**
      （表单不可用，只能改 profile 的 `cordis.patch.yml`）；等平台修好再恢复原有描述。
- [ ] **出站 poke 合流**：完整实现留在本地分支 `poke-tool-wip`（未推送）。
      触发条件：NapCat 的 PacketBackend 支持当前 QQ（9.9.36-53644），或换到受支持的 QQ（官方推荐 40768–44343）。
- [ ] **桌面端沙箱 ACL**：本机桌面端在这个工作区上跑命令会失败
      （`SetNamedSecurityInfoW failed (Win32 5): grantWrite(F:\游戏视频回放\DSH工作区)`），
      切成 `danger-full-access` 才正常。已写进给 DSH 的反馈，等官方确认是否已知问题。


