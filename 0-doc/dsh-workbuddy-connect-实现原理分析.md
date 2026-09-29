# DSH WorkBuddy Connect — 实现原理分析

> 分析对象：`D:\5_PersonFiles\dsh-workbuddy-connect`（v0.5.4，MIT，作者 corrinehu）
> 分析时间：基于仓库当前 HEAD `edbc41c chore: release 0.5.4`
> 分析范围：全量阅读 25 个源文件（7,110 行）、28 个测试文件（6,828 行 / 341 个用例）、3 个验证脚本、2 个 README、`docs/`、全部构建与配置文件，并在 DSH 实际安装包中核对了它依赖的内核接口。

---

## 目录

1. [项目定位](#一项目定位)
2. [三位一体架构](#二三位一体架构)
3. [装载契约](#三装载契约)
4. [Variant 抽象：一个插件服务两个产品](#四variant-抽象一个插件服务两个产品)
5. [凭据层 `src/auth.ts`](#五凭据层-srcauths-485)
6. [上游协议层 `src/upstream.ts`](#六上游协议层-srcupstreams-1175最大模块)
7. [回环 shim `src/shim.ts`](#七回环-shim-srcshims-258)
8. [适配器层 `src/adapter.ts`](#八适配器层-srcadapters-346)
9. [目录层：三级降级 + 分代校验](#九目录层三级降级--分代校验)
10. [推理档位探测：一个严谨的实验设计](#十推理档位探测一个严谨的实验设计)
11. [Web 状态路由与浏览器半边](#十一web-状态路由与浏览器半边)
12. [CLI 与心跳](#十二cli-与心跳)
13. [贯穿全局的四条方法论](#十三贯穿全局的四条方法论)
14. [本次分析新发现的两个问题](#十四本次分析新发现的两个问题)
15. [完整数据流](#十五完整数据流)
16. [约束与风险](#十六约束与风险)
17. [小结](#小结)

---

## 一、项目定位

一句话：**把 WorkBuddy 桌面 App 的私有 HTTP 接口，伪装成 DSH 的一个标准 LLM Provider。**

它不是反向代理服务，是 **DSH/Cordis 插件**，在 DSH 进程内注册 provider。实际请求路径：

```
DSH 会话 → dsh-llm → pi-ai adapter → 127.0.0.1 随机端口 shim → 改写后的 OpenAI 请求 → WorkBuddy 云端
```

关键：**复用桌面 App 已登录的凭据**，不启动自己的 OAuth（`cordis.patch.yml` 注释明说）。

**规模**：124 commit，2026-08-17 → 2026-09-17 整一个月。commit 类型分布：

| 类型 | 数量 |
|---|---|
| `fix` | 36 |
| `docs` | 29 |
| `chore` | 23 |
| `feat` | 19 |
| `test` | 6 |
| `build` | 4 |

**修复数是特性数的近两倍**——这个比例很说明问题：大部分工作量花在把"能跑"变成了"跑对"。

---

## 二、三位一体架构

一次 npm 安装产出三种产物，跑在三个不同运行时里：

| 半边 | 入口 | 运行时 | 产物 | 职责 |
|---|---|---|---|---|
| **Host** | `src/index.ts` (948) | DSH 主进程 Node 22+ | `lib/index.js` ESM + `variants-*.js` chunk | 凭据、上游协议、shim、adapter、路由、心跳 |
| **Browser** | `src/client/index.tsx` (95) | DSH Web GUI | `lib/client.js` CJS，包进 `window.__ModuleLoader__` | 设置卡片、Composer 探测控件 |
| **CLI** | `src/bin.ts` (257) | 独立进程 | `lib/bin.js` | status / doctor / logout |

Host 与 Browser **不能互相 import**，只有两条通道：

1. **同源 HTTP 路由**——读/写状态
2. **DSH 的 LLM seam**——模型列表经 `ctx.llm.registerAdapter` 进内核，再流到浏览器

两者共享的**只有常量与类型**，放在刻意保持 Node-free 的 `src/status-paths.ts` (189)。路径用**字面量常量**而非拼接表达式，注释写的理由很具体：

> "浏览器 bundle 和 host bundle 是独立构建的，一个共享表达式距离构建配置漂移只差一步。"

### 源文件规模

| 行数 | 文件 |
|---:|---|
| 1175 | `src/upstream.ts` |
| 1017 | `src/client/WorkBuddyPluginCard.tsx` |
| 948 | `src/index.ts` |
| 485 | `src/auth.ts` |
| 448 | `src/client/WorkBuddyProbeControl.tsx` |
| 346 | `src/adapter.ts` |
| 312 | `src/probe-store.ts` |
| 268 | `src/client-identity.ts` |
| 258 | `src/shim.ts` |
| 257 | `src/bin.ts` |
| 214 | `src/web-status.ts` |
| 198 | `src/probe-route.ts` |
| 189 | `src/status-paths.ts` |
| 177 | `src/probe-service.ts` |
| 172 | `src/probe.ts` |
| 171 | `src/client/locales.ts` |
| 169 | `src/catalog-store.ts` |
| 166 | `src/host-heartbeat.ts` |
| 163 | `src/app-version.ts` |
| 150 | `src/catalog.ts` |
| 95 | `src/client/index.tsx` |
| 92 | `src/variants.ts` |
| 50 | `src/loopback.ts` |
| 23 | `src/client/status-document.ts` |
| 15 | `src/version.ts` |

---

## 三、装载契约

### 3.1 声明式挂载点

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": ["@deepseek-ai/dsh-api-remotes", "...-session-controller", "...-ui-renderer",
               "...-ui-settings-plugins", "...-ui-conversation", "...-ui-model-selection", "...-client-locale"],
    "platform": "web"
  }
}
```

`cordis.patch.yml` 仅 6 行，用 `insert` 而非替换——注释明说：**注册 provider 但不改变 profile 当前默认模型**。

```yaml
# Register the WorkBuddy provider without changing the profile's current
# default model. The plugin reuses the WorkBuddy desktop app's sign-in; no
# separate OAuth flow is started.
- insert:
    - id: llm-workbuddy
      name: dsh-workbuddy-connect
```

### 3.2 生命周期契约

```ts
export const name = 'llm-workbuddy'
export const inject = ['llm']              // 硬依赖
export function apply(ctx: Context, config: Config): void
```

- `ctx.inject(['webServer'], ...)` 和 `ctx.inject(['settings'], ...)` 是**可选依赖**——headless profile 照样供模型，只是没有卡片
- `ctx.effect(() => () => {...})` 注册清理，卸载时释放 shim、路由、定时器

### 3.3 浏览器半边的降级包裹

`apply()` 整体包在 try/catch 里，失败只 `console.error`。理由在注释里：DSH slot API 在 rc.6→rc.7 发生过 `id`→`key`、`order`→`priority` 破坏性改名；**跟着抛错会弹红色 "Failed to load plugins" 横幅，而模型通道其实是好的**。

```ts
} catch (error: unknown) {
  // Degrade silently on the page: the host provider still serves models.
  // Developers see the full cause in the browser console; users see no banner.
  console.error('[dsh-workbuddy-connect] client card failed to load (host provider unaffected):', error)
}
```

`tests/client-fallback.spec.ts` 里对这个 try/catch 有一句 **DRIFT WARNING**：该测试是手工镜像的 `apply()`，**不是产品代码**，改真实入口必须同步改测试，否则测试无法发现回归。

### 3.4 双产物构建

`tsdown.config.ts` 两个独立配置。Client 侧手工包装 DSH 模块协议：

```ts
banner: `window.__ModuleLoader__.load({ id: "dsh-workbuddy-connect", factory: (require) => {`,
footer: 'return module.exports; } });',
intro: 'var module = { exports: {}; var exports = module.exports;',
```

版本经 `define` 注入 `__DSH_WORKBUDDY_VERSION__`，**唯一真相源是 package.json**。

**已验证**：`lib/variants-XUStsapF.js` 内含 `const WORKBUDDY_CONNECT_VERSION = "0.5.4"`，与 `package.json` 的 `0.5.4` 一致。

---

## 四、Variant 抽象：一个插件服务两个产品

CN（WorkBuddy）与国际（WorkBuddy AI）被抽象成数据描述符（`src/variants.ts`, 92 行）：

```ts
{ id: 'workbuddy',    displayName: 'WorkBuddy',    region: 'cn',     env: 'WORKBUDDY_AUTH_FILE',
  desktopFilename: 'workbuddy-desktop.info',  ownFilename: '.workbuddy-auth.json',
  probeFilename: '.workbuddy-probe.json',     catalogFilename: '.workbuddy-catalog.json',
  statusPath: '/plugins/dsh-workbuddy-connect/status', probePath: '.../probe' }

{ id: 'workbuddy-ai', displayName: 'WorkBuddy AI', region: 'global', env: 'WORKBUDDY_AI_AUTH_FILE',
  desktopFilename: 'workbuddy-desktop-ai.info', ownFilename: '.workbuddy-ai-auth.json',
  probeFilename: '.workbuddy-ai-probe.json', catalogFilename: '.workbuddy-ai-catalog.json',
  statusPath: '.../ai/status', probePath: '.../ai/probe' }
```

设计意图：**"任何模块都不用再带自己的 `if (international)` 分支，加第三个 variant 是改数据而不是重构。"**

### 关键事实：两版共用同一个凭据目录

从 git 历史里挖出的调研文档揭示：**两个 App 共用同一个 `CodeBuddyExtension` 凭据目录，只靠文件名 basename 区分**。这直接决定了三件事：

1. **凭据区域校验**——CN 版本读到 global 域的凭据直接抛错，不照用
2. **状态文件全部分离**——两个端点对**同名模型 id**（`glm-5.3`/`hy3`/`kimi-k2.6` 等）报的倍率、窗口、档位都不同
3. **指纹不含 provider**——`fingerprintModel()` 只哈希 `id + reasoning + supportsImages`，所以共用文件会让两版结果互串；分文件是这个约束的补偿

`tests/variants.spec.ts` 里有一条测试直接钉住这点，逐字段断言两版不共享任何东西：

```ts
for (const field of ['desktopFilename','ownFilename','probeFilename','statusPath','probePath','env','id'] as const) {
  const values = WORKBUDDY_VARIANTS.map(variant => variant[field])
  expect(new Set(values).size, `${field} must differ between variants`).toBe(values.length)
}
```

另外两条值得注意的断言：

- `it('keeps the CN provider byte-identical to its historical identity')` —— 保证既有安装、settings 文件、路由不移动
- `it('reuses the platform probe order when swapping the basename')` —— 逐索引比对两版候选路径，只允许文件名不同

### 运行时装配

`index.ts` 的 `createVariantRuntime()` 为每个 variant 造一整套运行时：

```
store → client → catalog → catalogStore
                       → shim → adapter
                       → probeStore → probeService
```

**任一 variant 启动失败都被 catch 住，另一个照常注册**——`startVariant()` 返回 `false`，`Promise.all` 里的另一个不受影响。

---

## 五、凭据层 `src/auth.ts` (485)

### 5.1 双源读取 + 身份优先

两个来源：

1. 桌面 App 自己的文件（**只读，永不写入**）
2. 插件自留副本 `$DSH_HOME/.workbuddy-{ai-,}auth.json`（存 refresh 结果）

选择规则**不是简单取新**：

```ts
// 身份优先于过期时间
if (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId) return desktop
return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
```

注释的推理：

> "插件副本是自己的 refresh 写的，所以用户在 App 里切换账号后，副本还属于上一个账号——而且因为被插件续过期，它很可能过期更晚。按过期时间取就会用旧账号的 uid 发 `X-User-Id`，以错误的用户身份应答。"

`tests/variants.spec.ts` 有两条测试分别覆盖两个方向：同账号取过期更晚的副本、换账号后必须取桌面文件。

### 5.2 按需刷新 + 单飞

```ts
async resolve(): Promise<WorkBuddyCredential> {
  const credential = await this.current()
  if (credential === undefined) throw new Error('workbuddy: no signed-in ... account found; ...')
  if (!this.needsRefresh(credential)) return credential
  this.inflight ??= this.refreshNow(credential).finally(() => { this.inflight = undefined })
  return this.inflight
}
```

刷新失败策略克制：**token 未到期（>30s）就返回旧 token**——"一个不可达的 refresh 端点不该打掉一个还能用的会话"。

### 5.3 平台探测链

```
显式配置 authFile → 环境变量 → 平台默认（多候选依次探测）
```

- **macOS**：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/`
- **Windows**：**依次探测 Local 和 Roaming**——"新版本写 Local，旧版本写 Roaming"
- **WSL**：优先从 `/mnt/<drive>` 读挂载的 Windows 用户目录，且会把 `USERPROFILE`/`LOCALAPPDATA`/`APPDATA` 里的 Windows 路径（含 `D:\...` 形式）转成 WSL 形式，最后才落 Linux 原生路径

失败语义被明确区分：**只有 ENOENT 才落到下一个候选**。

> "一个存在但解析不了的文件对它那个槽位是权威的，所以一个陈旧的旧版本文件永远不会悄悄赢过一个损坏的新文件。"

`tests/auth.spec.ts` 用 `vi.mock('node:os')` + `Object.defineProperty(process, 'platform')` 伪造 win32 和 WSL 环境，覆盖 Local 优先、Roaming 回退、两者都在、两者都无、显式路径绕过探测五种情况。

### 5.4 原子写

```ts
await withFileLock(this.ownPath, async () => {
  await writeFileAtomic(this.ownPath, ..., { mode: 0o600, dirMode: 0o700 })
})
```

### 5.5 自留副本的格式陷阱

`parseOwnDocument` 不复用 `parseWorkBuddyAuth`，注释说明了原因：

> "自留副本存的是**规范化后的凭据本身**（camelCase `expiresAtMs`、身份字段在顶层），不是桌面文档形状。往返一次会读到 `expiresAt` 和 `account` 对象、两个都找不到、把过期时间清零、丢掉 uid/enterprise/nickname——**所以一个存活的副本会在每次请求时刷新，并丢失它的身份头部**。"

---

## 六、上游协议层 `src/upstream.ts` (1175，最大模块)

协议行为**移植自 `Sliverkiss/workbuddy2api`（MIT）的 Go 实现**。

### 6.1 端点矩阵

| 用途 | CN | 国际 |
|---|---|---|
| 模型目录 | `GET copilot.tencent.com/console/enterprises/personal/models` | `GET www.workbuddy.ai/v3/config`（**按 UA 分流**） |
| Chat | `POST /v2/chat/completions` | 同路径 |
| Token 刷新 | `POST /v2/plugin/auth/token/refresh` | 同路径 |
| 积分（个人） | `POST www.codebuddy.cn/v2/billing/meter/get-user-resource` | 同路径 |
| 积分（企业） | `POST /v2/billing/meter/get-enterprise-user-usage` | 未验证，仍走个人接口 |

### 6.2 三条 wire quirk（`prepareChatBody`）

1. **`stream: true` 强制**——上游拒绝非流式
2. **`developer` → `system`**——pi-ai 按 OpenAI 新约定发 `role: "developer"`，上游 HTTP 400 code 11128 拒绝。注释明确说这是 load-bearing
3. **`tool_choice` 扁平化**——对象形式返回 400：
   - `{type:'auto'}` / `{type:'required'}` → 字符串
   - `{type:'function',function:{name}}` → 函数名字符串
   - `{type:'none'}` → 删除 `tool_choice` **并连带删除 `tools`/`functions`**
   - 无法识别的对象 → 删除

国际版第四条（`prepareInternationalChatBody`）：**首条消息必须是 `system`**。这里有个坑，注释专门点了：

> **同一个 11128 在两区域语义不同**——CN 是"拒绝 developer 角色"，国际是"首条消息不是 system"。**永远不能只按 code 分支。**

实现细节：`unshift` 而非合并，已有消息保持顺序与措辞；非 JSON 原样返回。

`tests/variants.spec.ts` 里有一条回归测试，注释记录了一个真实崩溃：

> "Regression: this used to JSON.parse() prepareChatBody's output, which passes non-JSON straight through — **so any non-JSON body crashed the chat path with a SyntaxError** rather than reaching the upstream's own error."

### 6.3 错误分类

`classifyUpstreamError` → `hard_credit | soft_rate | session_dead | not_found | server | client`

`HARD_CREDIT_MARKERS` 同时匹配**英文小写和原始中文**（`积分不足`、`额度不足`、`余额不足`、`积分用完`、`额度用尽`、`没有积分`…），并补了复数 `credits exhausted`。后者是从真实事故学的：

> 国际版 0 积分账号返 HTTP 429 + `Credits exhausted`，原表只有单数 `credit exhausted`，导致**积分耗尽被误判成可重试限流**。

分类在 shim 里映射成有意义的状态码，让 DSH 的 retry 层能做正确判断：

```ts
{ hard_credit: 402, soft_rate: 429, session_dead: 401, not_found: 502, server: 502, client: 400 }
```

### 6.4 企业积分：拒绝"看起来合理的错数字"

```ts
if (limit === undefined) throw new Error(`... no recognised quota field (expected limitNum/limit_num + credit/used_num; received ${describeShape(...)})`)
if (used === undefined)  throw new Error(`... a quota limit but no recognised usage field ...`)
if (limit === -1) return { total: 0, unlimited: true, ... }   // 显式 flag，不是哨兵值
```

三条规则：

- **读不懂就报错，绝不返回 0**。原文：**"把 `0` 渲染成'我们没看懂这个回答'，正是 issue #31 一直隐身、而用户看到一个看起来合理的错数字的原因。"**
- **`-1` 是"无上限"标记**，用独立 `unlimited: true` 布尔承载——"渲染器必须首先测试这个 flag，不能回退到 total"，因为已有的负数钳位会把 `-1` 变成 `0`，而 `0` 对读者意味着"什么都不剩"，正好相反
- 诊断**只报字段名和 typeof，绝不带值**（`describeShape`）——这字符串经 status 路由进浏览器，而响应体描述账号用量

两条测试专门钉住"不泄漏值"：

```ts
expect(error?.message).toContain('secretQuota:number')
expect(error?.message).not.toContain('998877')
expect(error?.message).not.toContain('should-not-leak')
```

企业分支的**区域门是 load-bearing 的**：国际凭据即使带 `enterpriseId` 也必须留在已验证的个人路径上。有专测断言 URL 含 `get-user-resource` 且不含 `get-enterprise-user-usage`。

### 6.5 促销的时效性重算

**这是全项目最漂亮的设计。**

国际目录带 `modelPromotions`（`validFrom`/`validUntil`/`factor`/`displayMode`/`priority`），而目录在进程生命周期内缓存。若在解析时冻结，缓存里的 `Free now` 会在窗口过后继续声称打折。

`catalog.current()` **每次读取**都调 `modelWithCurrentPromotion()` 重新求值，所以**徽章自己消失、倍率自己还原，不需刷新**。

促销过期后的处理更精妙——上游把折后价直接写进 `credits` 字段（国际版免费模型就发 `"x0.00"`）：

```ts
// 原价无法从这一行还原，所以诚实的答案是不再断言任何价格
return { ...model, billing: { free: false, rateUnknown: true } }
```

**它宁可显示"价格未知"，也不显示已知过期的折扣价或"免费"。**

但有个例外被精确划出：`factor === 1` 的促销不改变任何东西，所以到期后仍照常报价。

`tests/variants.spec.ts` 的 `promotion lifetime` describe 有 8 个用例覆盖：生效中、已过期、未开始、从未有促销、中性因子、非零折扣缩放、无促销、基础倍率不可解析时跳过缩放。

还有一条解析规则体现了保守：

> "只实现实际观察并验证的形态（enabled + 时间盒 + `displayMode: 'replace'`）。**不匹配的条目被丢弃而不是猜测：渲染一个插件不理解的折扣可能低估用户实际支付的金额。**"

---

## 七、回环 shim `src/shim.ts` (258)

### 7.1 为什么需要

pi-ai 只发标准 OpenAI 请求，WorkBuddy 需要额外头部与 body 改写。与其 fork pi-ai，不如**在中间插一个本机 HTTP 服务器**。

```ts
server.listen(0, '127.0.0.1')
```

端口由操作系统随机分配，**只绑回环**。

路由：`GET /healthz`、`GET /v1/models`、`POST /v1/chat/completions`。请求体上限 64MB。

### 7.2 四层入站加固

模块注释开门见山：

> "只绑回环本身不是信任边界——任何本机进程或 DNS-rebinding 页面都能到达 127.0.0.1。"

| # | 检查 | 挡住 |
|---|---|---|
| 1 | `hostIsLoopback(Host)` | **DNS rebinding**——攻击者域名重解析到 127.0.0.1，但 Host 带的是攻击者域名 |
| 2 | `originIsLoopback(Origin)` | 浏览器跨站请求（非浏览器客户端不发 Origin，放行） |
| 3 | `Content-Type: application/json` | **simple-request CSRF**——`<form>` 发不出 JSON |
| 4 | `Authorization: Bearer <32字节随机密钥>` | **本机其他进程**——密钥只在内存，`timingSafeEqual` 常量时间比较 |

密钥**从不转发给上游**——真实凭据由 shim 自己 `store.resolve()`。所以 adapter 层完全不接触真实 token。

`src/loopback.ts` (50) 是共享的门，被 shim 和 web-status 共用。`hostnameOfHost` 处理了 IPv6 括号和"多点冒号不是端口"的边界：

```ts
// Only `name:port` with a single colon is a port; anything with more colons
// is an (unbracketed) IPv6 literal and must not be truncated.
```

### 7.3 流式转发细节

```ts
body.on('data', chunk => { if (chunk.includes('[DONE]')) sawDone = true })
body.on('error', error => {
  logger?.warn('dsh-workbuddy-connect: upstream stream failed mid-flight', error)
  if (!sawDone && res.writable) res.end('data: [DONE]\n\n')   // 补一个正常结束
})
```

上游流中途断开时**主动补 `[DONE]`**，让下游 SSE 解析器正常收尾而不挂住。

`req.on('close', () => controller.abort())` 向上游传播取消，不让请求空烧积分。

响应头带 `X-Accel-Buffering: no`，防止中间代理缓冲流。

### 7.4 可执行的安全验证

`scripts/verify-shim-hardening.mjs` 是可执行验证：对真实 shim 发 6 个原始 HTTP 请求，逐一断言：

| # | 请求 | 期望 |
|---|---|---|
| 1 | 敌意 Host（DNS rebinding 形态） | 403 |
| 2 | 敌意浏览器 Origin | 403 |
| 3 | 非 JSON Content-Type | 415 |
| 4 | 合法回环 + 正确密钥 | 200 |
| 5 | 合法回环但无密钥 | 401 |
| 6 | 合法回环但密钥错误 | 401 |

**安全属性可执行**是好做法。

---

## 八、适配器层 `src/adapter.ts` (346)

### 8.1 活读目录

```ts
const provider: Provider = { ...base, getModels: () => buildModels() }
```

stream 分发走构造好的 provider，但目录答案跟随上游刷新。

`baseUrl = ${shim.baseUrl()}/v1`——OpenAI SDK 会拼 `/chat/completions`，路径正好对上。

### 8.2 惰性 auth 平面

```ts
const INERT_AUTH = {
  credentials: { async read() { return undefined }, async list() { return [] },
                 async modify() { throw new Error('...no pi-ai credential lifecycle') }, async delete() {} },
  authContext: { async env() { return undefined }, async fileExists() { return false } },
}
```

确保 pi-ai **永远不会自己造出一个凭据来用**。注释说明 `auth` 自 0.1.1-rc.2 起是必填。

### 8.3 共享密钥当 apiKey

```ts
resolveApiKey: async () => shim.token()
```

pi-ai 把它发成 `Authorization: Bearer <shared-secret>`，正好满足 shim 第 4 道门。**接口错位利用**——adapter 由此从不接触真实 token。

### 8.4 `maxTokensField` 显式声明

```ts
compat: { maxTokensField: 'max_tokens' },
```

注释：

> "pi-ai 无法从 shim 的随机回环 URL 推断出 WorkBuddy 的字段拼写"

正常情况它会按 baseURL 猜 `max_tokens` 还是 `max_completion_tokens`，但 URL 是 `127.0.0.1:<随机端口>`，猜不出来。

git 历史有 `fix: send WorkBuddy output caps as max_tokens`，说明踩过坑。`tests/adapter.spec.ts` 用一条测试钉住它。

### 8.5 推理档位三源优先级

`reasoningFields()` 实现严格优先级：

1. **上游声明的 `supportedEfforts`**——永远赢，观测既不能拓宽也不能收窄
2. **本地探测观测**——只对未声明的行生效，且**只接受 `validating` 的观测**
3. **都没有**——不给任何思考控制，wire 上也不发 `reasoning_effort`

两条政策性硬规则：

- **`non-validating` 观测刻意不产生任何控制**——上游接受了不可能存在的值（`glm-5.2` 实测），它产出的每个"逐档接受"都是假阳性
- **`off` 只由 `canDisableThinking: true` 授予，永不探测**——关闭思考是另一种能力，无法从行的形状推断

`minimal` 永远为 `null`：它不在上游的 effort 词汇表里，任何声明集合和探测候选都不可能含它。

以及措辞上的自觉：

> "内部描述为 'verified accepted'，从不是 'verified effective'"——接受只证明上游没拒绝这个拼写，不证明它改变了模型行为。

### 8.6 显示后缀注入 `name` 而非 `description`

```ts
class WorkBuddyPiAiAdapter extends PiAiAdapter {
  override async listModels(...)   { ...name: withCatalogDisplay(model.name, info) }
  override async resolveModel(...) { ...name: withCatalogDisplay(resolved.name, info) }
}
```

为什么？注释解释：

> **DSH 0.1.2 起 Composer 的模型席位只渲染 `model.name`，完全不读 `description`**（0.1.1 时代才读，这就是以前徽章在席位可见的原因）。

放 `description` 里会"要么重复（倍率），要么消失（徽章）"。

安全性论证写全了：**纯显示，不影响路由**——wire 请求从 `model.id` 构造，选择器提交 `{provider, model: id, reasoningEffort}`，`dsh-llm` 只校验 `name` 非空，**host 里没有任何地方按 name 解析模型**。

`tests/settings-integration.spec.ts` 里直接断言：

```ts
expect(byId.get('glm-5.2')?.name).toBe('GLM-5.2 · x0.79 · 夜间折扣')
expect(byId.get('glm-5.1')?.name).toBe('GLM-5.1 · x0.79')
expect(byId.get('auto')?.name).toBe('Auto')
expect(byId.get('glm-5.2')?.description).toBeUndefined()
```

**分隔符选 `·` 而非 `-`**：

> "模型名本身含连字符（`GLM-5.3-Flash`），用连字符会让名字在哪结束、倍率从哪开始变得有歧义。"

### 8.7 图像模态

```ts
input: info.supportsImages === true ? ['text', 'image'] : ['text'],
```

上游 `supportsImages === true && disabledMultimodal !== true` 才为真。缺省即纯文本——**"过度声明会放行一张 provider 随后拒绝的图片，而那时消息已经落库了"**。

`docs/image-modality-gap.md` 有一份很完整的缺陷分析：把"图片被拒绝"定位到 **100% 是本地行为，图片消息根本没发出网络请求**，用真实数据证明 15/16 的模型上游标了 `supportsImages: true`，而插件把每一个硬编码成了纯文本。

并论证了为什么不能无条件放行：

> "`glm-5.1` 会变成'消息已落库后 provider 中途拒绝，会话反复重试一个不可能成功的请求'，**这比拒绝更糟**。"

该文档还明确要求"新增单元测试防止日后有人把 `input` 再写死回去"——`tests/settings-integration.spec.ts` 里有对应的端到端模态断言。

---

## 九、目录层：三级降级 + 分代校验

### 9.1 降级顺序

```
live（本次成功拉取） → saved（该账号上次成功拉取，持久化） → fallback（编译进插件的静态名册）
```

`saved` 的存在理由：

> "没有它，一次重启就会永远把用户掉到内置名册上，即使几分钟前刚成功拉取过。内置名册是一次性快照；拉取的目录才是上游真正服务这个账号的内容。"

且刻意**不是带新鲜度策略的缓存**——"它从不阻止一次拉取，只在拉取失败时回答"。

`catalog-store.ts` 的模块注释还用否定式列清了它**不是**什么：不跨账号、不跨 variant、不放秘密（账号键已经是 status 文档里可见的 `uid:enterpriseId`）。

写入用 `写临时文件 + rename`，失败静默——"丢失对它们的*记忆*不值得上报"。

### 9.2 隐藏分组 = 空目录

```ts
current(): readonly WorkBuddyModelInfo[] {
  if (!this.visible) return []
  ...
}
```

**在 DSH 安装包中核实了这条链路**：

```js
// dsh-api-session-controller/lib/index.js
groups: catalog.flatMap(item => item.kind === "group" ? [item.group] : [])
              .filter(group => group.models.length > 0)
```

空组被自动丢弃——所以选择器里"不注册"和"注册了但目录为空"**等效**。

这让插件用最少机制解决三个问题（论证来自从 git 历史挖出的调研文档）：

1. **可见性对称**——只装国际版就只有「WorkBuddy AI」组
2. **启动后登录不用重启**——provider 无条件注册，凭据出现只需翻 `visible` + invalidate
3. **兜底名册语义变纯**——以前无凭据也顶出 15 个模型，用户选了必然报错（`store.resolve()` 抛异常）

`tests/settings-integration.spec.ts` 有一条测试直接叫 **"hides a variant with no usable credential while still registering it"**，并断言目录仍在：

> "The provider directory entry survives: the group is hidden by having no models, not by unregistering, so a later sign-in needs no restart."

调研文档里有一段很清晰的形态对比（三选一的决策记录），最终选②而非①或③：

| 形态 | 做法 | 优点 | 代价 |
|---|---|---|---|
| ① 按凭据存在性注册 | `stat` 判凭据，不存在则跳过注册 | 没装的人最干净 | 注册是开机一次性的，**启动后才登录需重启** |
| ② 始终注册、目录为空 | 无凭据时 `current()` 返回空 | **登录后第一次刷新即出现** | 改变了国内 provider 现状 |
| ③ 动态重注册 | 凭据变化时重新注册 | 语义最精确 | 需新拆凭据变化探测，成本最高 |

### 9.3 `catalogGeneration`：迟到响应不许写回

```ts
catalogGeneration: number
...
if (stopped || runtime.catalogGeneration !== generation) return
```

注释解释为什么**只检查身份不够**：

> "同一账号的两次刷新仍然可以乱序完成，而更旧的那次会赢。"

`adoptIdentity` 是**四种转移的唯一入口**，注释说明了为什么：

> "四种转移（轮询登录、轮询登出、手动刷新、手动刷新登出）共用一个 helper，因为**它们以前各做各的部分版本，而手动路径漏掉了轮询做的部分**。"

### 9.4 双重身份复核

`fetchCatalog` 对"App 在请求飞行期间切换账号"做两次复核：

```ts
const credential = await runtime.store.resolve()        // 读文件
if (resolvedIdentity !== identity) { adoptIdentity(...); await fetchCatalog(...); return }
models = await runtime.client.fetchModels(...)
const latest = await runtime.store.current()            // 发完再读一次
if (latestIdentity !== identity) { ... }                // 发布前再校验
```

注释：

> "`current()` 确立了拥有这次 fetch 的身份，但 `resolve()` 会重新读桌面文件。App 可以在这两次读之间切换账号；**绝不把 B 的目录当作 A 的发送或持久化**。"

`tests/catalog-lifecycle.spec.ts` 有一条测试用 `vi.spyOn` 在 `resolve()` 调用中途改写凭据文件，然后断言 `.workbuddy-catalog.json` 里**只有 B 的条目，没有 A 的**。

### 9.5 单飞 fetch

```ts
const inflight = runtime.inflightFetch
if (inflight !== undefined && inflight.identity === identity && inflight.generation === generation) {
  return inflight.promise          // 合流，不重复请求
}
inflight?.controller.abort()       // 不同作用域 → 取消旧的
```

**作用域含身份和代次**——"调用方只能加入同一作用域"。

### 9.6 凭据轮询

`CREDENTIAL_POLL_MS = 30_000`，可被 `DSH_WORKBUDDY_POLL_MS` 覆盖（钳位 100ms–24h）。性质被明确限定：

> "只做最多几个本地文件的存在性/解析读取：**它从不联网、从不运行推理探测**。"

四种转移各有不同动作：

| 转移 | 动作 |
|---|---|
| 无 → 有（首次） | 显示分组 + 拉目录 |
| 无 → 有（身份变了） | 额外丢弃前账号观测 |
| 有 → 无 | 隐藏 + 停服模型 + **删除该账号的 saved catalog** |
| 同身份 | **什么都不做**——store 按需刷 token，每次轮换都重拉目录只白打端点 |

登出时删除 saved catalog 的理由：

> "它是那个账号的数据，且按身份分键所以别的什么也服务不了它，但保留它只在**同一个**账号回来时才有用，而这个文件不是累积已离开账号目录的地方。"

失败重试退避 `CATALOG_RETRY_SWEEPS = 10`：

> "没有重试的话，启动时一次瞬时网络抖动会让分组一直停在兜底名册上，直到用户注意到并手动按刷新。"

用"轮询周期倍数"而非固定时长，是为了在 `DSH_WORKBUDDY_POLL_MS` 覆盖下保持比例。

`tests/catalog-lifecycle.spec.ts` 里有一条测试的注释很能说明这套机制的用心程度：

> "The reviewer's second finding: after switching to account B, a MANUAL refresh that fails left account A's catalog serving — **under a 'live' label, too**, since a failed fetch never marks the source fallback, so even the sweep's retry would not have recovered it."

该测试端到端驱动真实路由，验证 A 的 roster 与 A 的探测观测在切换后都不再被服务，且检查 `catalog.source` 诚实地变成 `'fallback'` 并带错误。

---

## 十、推理档位探测：一个严谨的实验设计

四模块职责切得很干净：

| 模块 | 职责 |
|---|---|
| `probe.ts` (172) | 纯函数，只依赖"一个模型的响应序列" |
| `probe-store.ts` (312) | 持久化、有效期、指纹、账号分键 |
| `probe-service.ts` (177) | 串行队列、同意门、观测→能力的桥 |
| `probe-route.ts` (198) | HTTP 入口、鉴权 |

### 10.1 三段式协议

```ts
// 1. baseline（不带 reasoning_effort）——证明模型、凭据、请求形状本身是好的
if (!isAcceptance(baseline)) return { validation: 'unknown', reason: unknownReason('baseline', baseline) }

// 2. sentinel（新鲜随机、不可能碰撞）——回答逐档扫描回答不了的那个问题
if (isAcceptance(sentinelAttempt)) return { validation: 'non-validating', efforts: [], requests }

// 3. levels —— 只有在 sentinel 被拒之后才有意义
```

注释解释每步的不可替代性：

> **"baseline 之后，一个 sentinel 上的 400 才可能被归因。"**
> **"一个接受 sentinel 的模型对一切都答 200，所以它的逐档结果会均匀地是假阳性。"**

判据严格收窄：

```ts
function isEffortRejection(attempt) {
  return attempt.status === 400 && attempt.errorCode === 'invalid_reasoning_effort'
}
function isAcceptance(attempt) {
  return attempt.status === 200 && attempt.streamed
}
```

- **200 但没流不算接受**（"空的 200 不是档位被接受的证据"）
- **bare 400 不算拒绝**（"同样的状态码，没有可归因的 code：计划要求降级为 unknown 而不是猜测是档位引起的"）

中途非决定性回答时，**整轮报 `unknown` 而非给部分列表**：

> "部分列表不是发现，报 unknown 好过对一个模型低估。"

`tests/probe.spec.ts` 有 10 个用例逐一钉住这些分支。

### 10.2 观测不是断言：指纹 + TTL + 账号

```ts
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000

function fingerprintModel(info) {
  const basis = JSON.stringify({
    id: info.id,
    reasoning: info.reasoning ?? null,
    supportsImages: info.supportsImages ?? null,
  })
  return createHash('sha256').update(basis).digest('hex').slice(0, 16)
}
```

指纹**刻意排除**显示性字段（改个名不该丢观测）、**刻意包含**整个 `reasoning` 对象（形状任何变化都重新探测）。

存储是 v2 的两级嵌套：

```ts
records: Record<account, Record<modelId, WorkBuddyProbeRecord>>   // account = `${uid}:${enterpriseId}`
```

理由：

> "一个档位集合既是对模型的描述，也是对账号权益的描述——同一个模型 id 在不同订阅下可以接受不同档位。"

三层保护：

1. **两级分键**隔离账号
2. **记录自带 `account` 字段**——"纵深防御：两级分键已经隔离了账号，但记录自己的身份字段对'它为谁作答'有最终发言权"
3. **写回时重校验账号**

v1（扁平）**刻意不迁移**：

> "它们读作空，受影响的模型按需重新探测，这让读取器不必带半懂的兼容路径。"

一条防御规则：**`unknown` 不覆盖已有的决定性记录**——"一次瞬时 unknown 不该擦掉用户已经付过费的知识。"

写入用临时文件 + rename，理由：

> "崩溃在写入中途不会留下一个半解析、读作'无记录'并静默丢弃每个观测的文档。"

### 10.3 串行队列与同意门

两条被注释称为**结构性而非建议性**的规则：

1. **一次只探测一个**——"用户的真实聊天不能和一次扫描争抢"
2. **没有明确同意什么都不做**

```ts
this.queue = run.catch(() => undefined)   // 一次失败不毒化后续所有探测
```

队列内部**重新读取目录和同意状态**：

> "在队列内重新读取：更早的一次扫描可能已经改过目录，或者已经回答过这个模型了。"

去重键是 `JSON.stringify([account, modelId])`——**含账号**。

手工探测的语义与自动探测刻意不同：

- 手工（`manualConsent = true`）：**绕过历史结果**，每次都真发请求；"手工同意永不改变自动探测的配置"
- 自动：命中有效缓存则 `requests: 0` 返回

`tests/probe-service.spec.ts` 有 6 个用例覆盖这组差别。

### 10.4 在途账号切换的竞态

```ts
const activeAccount = this.options.account()
if (activeAccount !== account) return { state: 'unavailable', reason: 'account changed before detection' }
...
const outcome = await probeModel({ ... })     // 可能耗时数十秒
if (this.options.account() !== account) {     // 完成后再校验
  return { state: 'unavailable', reason: 'account changed during detection' }
}
```

注释：

> "store 的按账号分键本身抓不住这个，因为**一次在途探测是在切换已经发生之后才完成的**。"

`tests/probe-service.spec.ts` 有一条测试专门制造这个时序：A 的探测挂起 → 切到 B → B 开始自己的探测（必须**不**加入 A 的 pending）→ 释放 A → A 报 `account changed during detection`，B 成功。

### 10.5 HTTP 路由的两道门

`probe-route.ts` 模块注释：

> "1. 回环 Host + Origin——挡 DNS rebinding 页面。2. **进程内随机密钥**——**回环本身不是认证**，任何本机进程都能写 `Host: 127.0.0.1`，所以一条要花用户积分的路由必须证明调用方被告知过密钥。"

密钥 `randomBytes(24).toString('hex')` 每进程生成，随 status 文档下发，**从不持久化、每进程轮转**。

输入面刻意收窄：

> "永不接受来自浏览器的 prompt、目录外的 model id，或 sentinel：探测请求完全在 host 侧组装。"

且 `refresh` 不带参数——"variant 已经由请求到达的路由确定，所以浏览器没法让这条路由去刷新另一个 provider"。

四种 action（`probe`/`clear`/`refresh`/`set-maximum-context-window`）共享这条路由，"因为四个都是写操作"。请求体上限 4096 字节。

`tests/dual-routes.spec.ts` 有一条测试专门验证 **CN 卡片的密钥不能授权 AI 路由**。

### 10.6 唯一判据共享

`probeSection()` 读 `runtime.probeService.recordFor(info.id)`——**与 adapter 同一个判断**。注释解释为什么卡片不直接读 store：

> "一条原始记录可能以 adapter 已经折算掉的方式过期——它的目录行变了、它过了 TTL、或者上游已经声明了 effort 集合（后者永远赢）——显示它会让卡片承诺模型选择器并不提供的档位。"

`tests/probe-store.spec.ts` 里有一个 describe 直接叫 **"recordFor: the single judgement the card and adapter share"**，注释点明这修的是"卡片显示档位而 picker 已不再提供"的历史缺陷。

`tests/reasoning-merge.spec.ts` 用真实的 LLM seam 端到端验证合并规则（不测内部 helper），有一条测试的注释解释了为什么要对着"实际生效的声明"断言而非硬编码：

> "对着实际生效的声明断言，而不是硬编码列表：实时上游刷新会替换兜底目录，而它对这一模型声明的集合**已经与兜底的不同了**（上游现在说 low/high/max，兜底说 low/high/xhigh）。被测的不变量是观测永不增加或替换声明集合——**而不是上游这周声明了什么**。"

---

## 十一、Web 状态路由与浏览器半边

### 11.1 status 路由的取舍

三态判别联合：

```ts
| { status: 'signed-out'; reason?: string }
| { status: 'signed-in'; nickname?; domain?; source?; expiresAt?; credits?; creditsError?;
    models?; catalog?; probe?; useMaximumContextWindow?; probeKey? }
| { status: 'error'; message: string }
```

几个刻意设计：

- **积分失败降级为 `creditsError`**，不让整个文档失败——"登录状态是只读的；积分是一个活的计费回答"
- **可诊断的登出保留 `reason`**——因为**"当真正的修法是改正一个路径时，告诉用户去登录是错的建议"**
- **卡片收到每一个模型，不只是打折的**——"在 200k 模型和 1M 兄弟并列时，上下文容量恰恰是用户选模型前最想知道的事实，而这些模型正是没有促销附身的那些"
- **目录来源即使模型列表为空也要下发**——"'没有模型'恰恰是需要解释的那种情况，也是区分'分组被隐藏'和'拉取失败'的唯一方法"

Token 脱敏 `safeMessage()`：

```ts
.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')  // JWT
.replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
.slice(0, 500)
```

`bin.ts` 里有同样一份（CLI 输出也脱敏）。

### 11.2 浏览器侧的健壮性原则

`WorkBuddyPluginCard.tsx` (1017) 的核心工程决策：

**① "未读取" 独立于 "未登录"**

```ts
const [status, setStatus] = useState<WorkBuddyWebStatus>()   // undefined = 还没读
```

注释：

> "用一份已登出的文档来初始化，会让一个已经登录的用户在整个首次往返期间被告知未登录（**如果读取从未落定，就是永远**）。"

状态点颜色还专门区分 `'loading'` 的灰 vs 登出的灰——"否则会读成'没什么问题，只是没人登录'，而真相是'还没读'"。

**② 失败的读绝不丢弃已在屏幕上的文档**

```ts
setStatus(previous => previous === undefined ? { status: 'error', message } : previous)
```

**③ 轮询开关由"上次成功读取"决定，而非当前渲染的文档**

```ts
if (!open || signedIn === false) return
```

注释：

> "一次失败的读不能解除这个 effect，否则一次瞬时错误会让卡片一直空着直到用户点刷新。"

而真正的登出答案仍然停掉轮询——"用户的 Refresh 按钮是唯一能改变它的东西"。

**④ 读序号防迟到覆盖**

```ts
const seq = ++readSeq.current
const current = (): boolean => mounted.current && signal?.aborted !== true && seq === readSeq.current
```

**"请求启动最晚的那个响应赢"**——"否则一个在手动操作之前开始的慢轮询，可能在操作的刷新之后落定，把更旧的文档恢复回去"。

**⑤ 写操作失败与读失败同策**

`refreshModels` 和 `control` 都遵守同一条：**理由附在文档旁边，绝不取代它**——"一次被拒绝的'刷新模型列表'不该因为一个失败的动作就把账号和积分拿掉"。

**⑥ 确认框的演进**

`window.confirm` → 内联确认框（"一行决策加两个按钮，为它弹模态太重了"）→ **从列表底部移进所属行内**（"问题'要往这个模型发请求吗？'和提问的按钮隔了一屏"）。

**⑦ 探测按钮的 running 标签**

`busy` 是卡片级的，任何请求在飞都为 true，**无法决定哪个按钮该显示 running**。用独立 `runningModel` + 一个 `runningArmed` ref 解决：

> "只按 `busy` 判断会立即触发：启动检测的那次点击在同一批里设置了 `runningModel` 和 `busy`，而只检查 `!busy` 的 effect 仍可能观察到更新前的值。所以标签在上升途中被 armed，只在运行真的被看到在飞之后才释放。"

`tests/plugin-card.spec.ts` 的头两句注释就是这条缺陷的记录：

> "The plugin card had none, **which is how a shared `busy` flag ended up driving a per-model button label: pressing one candidate made every button claim it was running.**"

**⑧ 可访问性**

- `role="progressbar"` 在 size 未知时**省略 range 属性**（"省略 range 属性，让辅助技术报告一个不确定的进度条，而不是把那个假的 100% 再大声重复一遍"）
- `aria-busy` 区分"值待定"与"值缺失"
- 未限额时**不画填充**（"'无限额'不是'剩余 100%'，断言语义比例就是上游从未做出的声明"）
- 结果 note 用 `role="status" aria-live="polite"`

### 11.3 双卡片的 slot 机制

`index.ts` 里有一段很长的注释解释为什么必须是**两个 settings namespace**。**在 DSH 安装包里核实了它**：

```js
// dsh-client-ui-settings-plugins/lib/client.js — ConfigurablePluginsTabController.publish()
const served = new Set(mirrored.view?.namespaces.map((view) => view.ns) ?? [])
const namespaces = this.entries().flatMap((entry) =>
  entry.options.key !== void 0 && served.has(entry.options.key) ? [entry.options.key] : [])
```

```js
// and the renderer:
children: namespaces.map((ns) => jsx(Fragment, { children: renderSlot("settings.plugin.item", {}, { entryKey: ns }) }, ns))
```

**卡片由"已服务的 namespace"驱动，不是由 slot 注册驱动。** 一个 key 不指向任何已服务 namespace 的条目会注册成功但永不渲染——这正是注释描述的那个 bug。

`tests/settings-integration.spec.ts` 把它称为 **"THE DISPATCH CONTRACT"** 并逐 variant 断言：

```ts
const served = new Set(ctx.settings.describe().map(entry => entry.ns))
for (const variant of WorkBuddy.WORKBUDDY_VARIANTS) {
  expect(served, `card key "${variant.id}" must be a served settings namespace`).toContain(variant.id)
}
```

同时验证**两个 section 的字段互相隔离**：

```ts
expect(fieldsOf('workbuddy')).toContain('authFile')
expect(fieldsOf('workbuddy')).not.toContain('authFileAI')
expect(fieldsOf('workbuddy-ai')).toEqual(['authFileAI', 'useMaximumContextWindow'])
```

并用一个巧妙的可观测点验证**写入路由正确**：

> "刻意选的可观测点：把 `authFileAI` 指向一个持有 CN 域凭据的文件。如果写入真的到达了 AI store，那个 store 会拒绝跨产品凭据而 AI 分组清空；CN 分组必须不受影响。**一个被错误路由的写入反而会清空 CN 分组**——所以这个断言区分了'到达了 AI store'和'到达了某个 store'。"

### 11.4 slot 注册的真实性验证

`tests/slot-registration.spec.ts` 直接驱动**真实的 `SlotCore`**，而不是信任注册形状。注释说明这是计划里的 §7 门槛：

> "同一 client bundle 注册两个 settings.plugin.item key…实施前以最小运行验证两个条目都可见；若插槽不支持，再定位限制，不直接复制整个插件。"

我核对了 `SlotCore` 的实际抛错文案，与测试断言的完全一致：

```js
if (options.key === void 0) throw new Error(`keyed slot "${options.name}" requires options.key`)
if (occupant) throw new Error(`keyed slot "${options.name}" already has an entry for key "${options.key}"`)
if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
```

6 个用例分别验证：两个不同 key 可共存、投影出两个 cell、**同 key 同优先级被拒**（这才是"优先级必须错开"的真实原因）、**不同 key 同优先级允许**（"如果这会抛错，两张卡片就依赖人为的优先级差异才能共存——值得明确知道"）、key 必填、未声明的 slot 被拒。

### 11.5 Composer 探测控件

明确对齐 `dsh-codex-connect` 的 Fast Mode 控件（"这是这里 composer chrome 的既定形状"）：

- **标签是静态的，永不携带状态**——"已验证的档位已经出现在模型下拉里，在这里重复只会复制真实答案，并让标签宽度随结果跳动"
- 状态和点击意图放 hover/focus tooltip，**不用原生 `title`**（有测试断言 `title` 是 `undefined` 且 `aria-describedby` 存在）
- 确认是小气泡锚定控件，不是 `window.confirm`（有测试断言 `confirm` 从未被调用）
- 结果 note 比确认气泡更小——"它承载的是一个*结果*而不是一个*决定*"

tooltip 优先级被规范为四段（`busy` → `result` → `failed` → idle），`tests/client-defects.spec.ts` 的 `#7.1` 有 3 个用例逐一验证。其中一条测试的注释说明了为什么这需要分支顺序而非副作用：

> "可达的状态：一个结果**已经**在屏幕上，而对同一模型的新检测失败了。没有读取介入，所以 `result` 从不改变 identity，清除 effect 从不运行，`failed && result !== undefined` 成立——**除了分支顺序，没有别的东西能让档位留在屏幕上**。"

另一个精妙细节：探测响应**自己**打开 note，不去等 `/status`：

```ts
// 这个响应属于那次明确的点击，即使 host 复用了更旧的缓存结果。
// 不要等 /status（它会拉积分），也不要从墙上时钟时间戳和后台轮询推断完成。
```

`cardVariantFor(provider)` 对任何非 WorkBuddy provider 返回 `undefined`——"这就是图标不出现在每一个非 WorkBuddy 模型上的原因"。

`WorkBuddyProbeControl` 的 `key` 是 `${card.id}:${selection.model}`——"一个迟到的响应不能瞄准新的模型"。

### 11.6 status 文档的形状校验

`src/client/status-document.ts` (23) 被卡片和 Composer 控件共用。注释说明为什么需要它：

> "一个 200 不是对 body 的承诺：它可能是空的、字面的 `null`、来自代理的非 JSON 页面，或者一个数组。两端读同一条路由，所以两端必须对什么有效达成一致——**存储一个不可读的值会把某个东西放进 state，而下一次渲染会解引用它**。"

校验**刻意只覆盖判别式**（加 `error` 的 `message`）："在这里校验可选字段会拒绝 host 合法省略字段的文档。"

`tests/client-defects.spec.ts` 的 `#1`/`#2` 用 `body: null` 和 `invalidJson: true` 精确构造这两个崩溃场景。

### 11.7 国际化

`locales.ts` (171)：`en` 是类型源（`WorkBuddySettingsKey = keyof typeof en`），`zh` 是 `Record<WorkBuddySettingsKey, string>`——**中文缺一个 key 就编译失败**。

一个精确的"哪一半能做本地化"的区分：

- **卡片里的徽章做了本地化**（`modelBadgeLabel` 映射 `限时免费`/`夜间折扣`/`Free now`），因为卡片在浏览器里有 locale 服务
- **adapter 注入到模型 `name` 的后缀没做**——"host seam 没有 locale 服务，所以非中文 UI 会原样看到它们——在 picker 长出本地化徽章槽位之前，这个是被接受的"

`tests/client-variants.spec.ts` 有一条测试验证两种语言的标题**实际不同**，而不只是 key 不同：

```ts
expect(zh[card.titleKey]).toContain(card.id === 'workbuddy-ai' ? 'AI' : 'WorkBuddy')
expect(zh.titleAI).not.toBe(zh.title)
expect(en.titleAI).not.toBe(en.title)
```

---

## 十二、CLI 与心跳

### 12.1 心跳文件

Host 在至少一个 variant 注册成功后写 `$DSH_HOME/.workbuddy-host-heartbeat.json`：

```ts
{ version, package: 'dsh-workbuddy-connect', pluginVersion, registeredAt, pid }
```

为什么需要？注释：

> "浏览器 bundle 不能写文件；它的健康只通过 `console.error` 报告。**这个不对称是有意的：host 是承重的那一半，缺少心跳无歧义地意味着 host 从未启动。**"

### 12.2 PID 复用防护

```ts
process.kill(heartbeat.pid, 0)                     // 1. PID 存在
const startAtMs = processStartTimeMs(heartbeat.pid)
if (startAtMs === undefined) return true           // 平台读不到 → 退化为 PID 存活
return startAtMs <= heartbeat.registeredAt         // 2. 启动时刻早于注册时刻
```

注释：

> "崩溃后操作系统可能把同一个 PID 交给无关进程，未清理的陈旧心跳就会产生假的 'Host running'。注册心跳的 host 必须先于写它而启动，所以 `start <= registeredAt`；被回收的 PID 属于 host 死后才启动的无关进程，所以 `start > registeredAt` 正确地读作已死。"

跨平台：macOS/Linux 用 `ps -o lstart=`（带 `LC_ALL=C`），Windows 用 `wmic process ... get CreationDate`（UTC，用 `Date.UTC` 解析）。

`tests/host-heartbeat.spec.ts` 有一条测试用**当前进程自己**构造回收 PID 场景（`registeredAt = 本进程启动时间 - 60s`，`pid = 本进程 pid`），断言报死——这个构造很干净。

### 12.3 CLI

```
dsh-workbuddy-connect <doctor|status|logout> [--provider <id>] [--json]
```

- `doctor` —— 无秘密诊断：凭据路径与存在性、UA 版本来源、心跳状态、**按条件生成的 hints**；退出码反映"已登录且桌面文件存在"
- `status` —— 登录态 + 剩余积分 + host bundle 健康；未限额时打印 `unlimited` 而非占位的 `0`（"显示占位 0 会读成'已耗尽'"）
- `logout` —— **只删该 variant 的插件自留副本**，连 `.lock` 一起删；"不动桌面 App 自己的登录，也不承诺一定让模型分组消失"

默认 CN（`CN_VARIANT`），"所以每一次已存在的调用都保持它的行为"。支持 `--provider <id>` 和 `--provider=<id>` 两种写法。

`safeMessage()` 对 CLI 输出同样脱敏。

---

## 十三、贯穿全局的四条方法论

### 13.1 "读不懂就报错，绝不猜一个看起来合理的值"

出现在：企业积分字段缺失、`unlimited` 用独立 flag 而非 `-1` 哨兵、促销过期标 `rateUnknown`、未声明且未观测的模型不给思考控制、包大小未知时不画 100%、`describeShape` 只报字段名。

最直白的表述在 `upstream.ts`：

> "渲染 `0` 表示'我们没看懂这个回答'，正是 issue #31 一直隐身、而用户看到一个看起来合理的错数字的原因。"

以及卡片里的对应表述：

> "一个上游从未报告过额度的套餐没有百分比可陈述。它**绝不能回退到 100%**：那会是插件在声称一个它一无所知的满额，与它下面打印的诚实的'剩余 N'正好相反。"

### 13.2 每个降级都要能追溯到"为什么"

| 维度 | 降级链 |
|---|---|
| 凭据 | 显式路径 → env → 平台默认链 |
| App 版本 | 已安装 → 已保存 → 编译内置 |
| Chat 身份 | 已安装 → 区域保存值 → 编译内置（**永不回退到 legacy CLI UA**） |
| 目录 | live → saved → fallback |
| 探测记录 | 指纹匹配 → 未过期 → 归属当前账号 |

**每一级在卡片上都有对应可见文案**（`catalogLive`/`catalogSaved`/`catalogFallback`），因为：

> "'陈旧'和'离线但有保存的列表'对用户是不同的处境。"

Chat 身份的降级设计尤其讲究——所有失败路径**收敛到同一个形状**：

> "这是每一个失败路径都收敛到的、唯一的降级形状——一个抛出异常的读取器、一个不可读的 bundle，或者一个缺失的缓存，都呈现这个，**永不呈现 legacy CLI UA**。"

并且有一条测试专门钉住"抛异常的 resolver 降级到桌面 fallback 形态"。

### 13.3 版本兼容的显式记账

代码里到处是对 DSH 版本演进的注释，且写清了为什么改：

| 变更 | 应对 |
|---|---|
| `settingsNamespace()` 品牌函数在 0.1.2 被删 | 改成普通字符串 + 一次类型断言 |
| `installSettingsSection` 移到 `settings.installSection` | `ctx.inject(['settings'], ...)` 等待服务 |
| `@deepseek-ai/dsh-client-runtime` 在 0.1.2 被移除 | slot 从 `-ui-renderer` 来，locale 从 `-client-locale` 来 |
| `PiAiAdapterOptions.auth` 在 0.1.1-rc.2 变必填 | `INERT_AUTH` |
| `ResolvedPiAiProviderProfile.modelErrors` 在 0.1.5-alpha.2 变必填 | 显式加 `new Map()` |
| client slot 的 `id`→`key` / `order`→`priority` 改名 | try/catch 降级 |
| 请求图片预算字段在 0.1.1-rc.2 变必填 | `REQUEST_IMAGE_BUDGETS` |

我核对了 `dsh-llm-pi-ai` 的实际代码，`modelErrors` 确实是该模块自己构造的字段，注释所述属实。

还有一句关于为什么手工装配 profile：

> "那个 helper 不在包的公开导出面上（root 入口、`lib/` 深导入被 exports map 挡住、`src/` 不发布），所以手工装配是唯一受支持的路径，**每一个新增的必填字段都必须在这里显式采纳**。"

README 里有明确的版本对应表并警告"不可混用——不匹配的组合会导致 DSH 启动失败"。

### 13.4 测试的真实性

341 个用例，**集成优先**。几个代表性做法：

**① 驱动真实的 `apply()`**

`tests/catalog-lifecycle.spec.ts` 用真实的 `Context` + `LlmRuntime` + 假 `webServer`，注释解释为什么必须这样：

> "The reviewer's finding lives inside `apply()`'s route closures, so exercising it needs the actual handlers `apply()` registers — **which means the `webServer` inject has to fire**."

**② 回归钉子**

`tests/chat-identity-wire.spec.ts` 有一个 describe 直接叫 **"unchanged paths (regression pin)"**：

- refresh 保持 CLI UA + `X-Auth-Refresh-Source`
- CN 目录保持 CLI UA
- 国际目录保持无空格的 `WorkBuddyAI/<v>`
- billing 完全不受身份改动影响

**③ 防退化测试**

`docs/image-modality-gap.md` 明确要求"新增单元测试防止日后有人把 `input` 再写死回去"；`tests/adapter.spec.ts` 有一条专测钉住 `maxTokensField`。

**④ 缺陷文档驱动**

`tests/client-defects.spec.ts` 的每个 describe 带 `#N` 标号，对应缺陷文档的章节号，且头注说明：

> "每个测试都写成**在其修复前失败、修复后通过**：它命名的缺陷必须能按缺陷文档描述的方式驱动组件而触达，而不是断言一个实现细节。"

**⑤ 版本单一真相源**

`tests/version.spec.ts` 第三个用例防止 issue #1 复发（v0.2.2 产物报 0.2.1）：扫描**所有** `lib/*.js` 而非猜一个文件名——"断言是'发布的产物带有这个版本'，不是'bundle 是这样排布的'。"

---

## 十四、本次分析新发现的两个问题

这两个是**只有读测试内部断言才会浮出来的**——只看源码或只看 README 都发现不了。

### 发现 1：`tests/probe-composer.spec.ts` 的持久化用例已失去意义

测试 337 行 `it('persists the dismissal so it survives a remount')` 的注释与 fixture 都建立在 localStorage 之上：

```ts
/** Backing map for the stubbed localStorage. */
let seenStore = new Map<string, string>()
// Minimal in-memory localStorage: the "already read" marks are persisted
// there precisely so a reload cannot replay an old detection as news.
localStorage: { getItem: ..., setItem: ..., removeItem: ... },
```

但源码里**没有任何 localStorage 引用**（`src/` 与 `lib/` 全文搜索均为 0 命中）。

git 历史显示这是一次真实的机制替换：

- **`a92963d`** 引入 `SEEN_STORAGE_KEY = 'dsh-workbuddy-probe-seen'` + `SEEN_LIMIT = 200` + `readSeen`/`writeSeen`
- **`1d40f74`** 全部删除，换成源码现在的注释：**"no persisted 'seen' marks are needed"**

**测试用例和 localStorage stub 被留下了。**

该用例现在实际验证的是"同一次挂载内不重播"——一个仍然真实、但比它自称的弱得多的属性。`statusBody` 在两个 `mount()` 之间是共享模块状态，所以它碰巧通过，而不是因为持久化生效。

**影响评估**：不是产品缺陷，是**测试断言与实现脱节**。按这个项目自己的标准——`client-fallback.spec.ts` 里那段 DRIFT WARNING 就是为同类问题写的——这里缺一句同等的警告。

### 发现 2：`docs/` 里 4 份被源码引用的设计文档从未进过仓库

13 处源码注释引用了设计文档，其中 4 份在 git 全历史中**从未被追踪**：

| 文档 | 引用处 |
|---|---|
| `reasoning-effort-probe-plan.md` | `probe.ts`、`probe-store.ts`、`probe-service.ts`、`probe-route.ts`、`adapter.ts` + 3 个测试文件（共 9 处） |
| `client-defect-confirmation.md` | `tests/client-defects.spec.ts`（§1–§8 的出处） |
| `upstream-identity-alignment-plan.md` | `client-identity.ts` |
| `client-identity-live-verification-2026-09-14.md` | `scripts/client-identity-live-matrix.mjs` |

前两份尤其重要——**`client-defects.spec.ts` 的每个 describe 标号（`#1`–`#11`）都指向 `client-defect-confirmation.md` 的章节**，而那份文档不存在。

`c871c03 chore: untrack the international-version working docs` 只解释了国际版那两份（`workbuddy-ai-implementation-plan.md` 与 `workbuddy-ai-international-research-2026-09-11.md`，这两份可以从 git 历史取回），这 4 份是另一回事。

**影响评估**：新维护者无法追溯"为什么是这 5 个档位候选值""`#7.1` 的规范顺序从哪来""`§5` 的优先级规则原文是什么"。不影响代码正确性（注释本身信息量很大），但削弱了这个项目最引以为傲的那条链——**每个决定都能追溯到依据**。

### 建议

两条都很小，也都可修：

1. 给 `probe-composer.spec.ts` 那条用例补一句 DRIFT 说明，或直接改写它去验证当前真实机制（"同一次挂载内不重播"）
2. 把 4 份文档补进 `docs/`（国际版那两份可从 git 历史取回作参考格式），或把引用改成自包含的说明

---

## 十五、完整数据流

```
┌─ 浏览器 (DSH Web GUI) ─────────────────────────────────────────┐
│  settings.plugin.item[workbuddy]     → WorkBuddyPluginCard     │
│  settings.plugin.item[workbuddy-ai]  → WorkBuddyPluginCard     │
│  conversation.input.right            → WorkBuddyProbeControl   │
│    │ GET  /plugins/.../status            (只读)                │
│    │ POST /plugins/.../probe + X-WorkBuddy-Probe-Key (写)      │
│    │   body: {action: probe|clear|refresh|set-maximum-...}     │
└────┼───────────────────────────────────────────────────────────┘
     │ 同源 fetch / JSON（credentials: same-origin）
┌────▼─ DSH Host 进程 (Node) ────────────────────────────────────┐
│  web-status.ts / probe-route.ts                                │
│    守卫: hostIsLoopback + originIsLoopback + timingSafeEqual   │
│                                                                │
│  index.ts apply()                                              │
│   ├─ syncAll() 每 30s → store.current() → adoptIdentity()      │
│   │                        │                  │                │
│   │                        │          catalogGeneration++     │
│   │                        │          abort in-flight         │
│   │                        ▼                  ▼                │
│   │                  fetchCatalog() ──→ catalog.set()          │
│   │                     │ generation 校验写回                  │
│   │                     │ 成功 → savedCatalogs.set(account)    │
│   │                     ▼                                      │
│   │            WorkBuddyUpstreamClient.fetchModels()           │
│   │                                                            │
│   ├─ WorkBuddyCatalog (visible / models / useMaximumContext…)  │
│   ├─ WorkBuddyProbeStore + ProbeService (串行队列 + 同意门)     │
│   ├─ writeHostHeartbeat()  (pid + registeredAt)                │
│   └─ ctx.llm.registerAdapter([variant.id], adapter)            │
│                                                                │
│  adapter.ts (extends PiAiAdapter)                              │
│    getModels() → catalog.current() → toPiModel()               │
│      input: supportsImages ? ['text','image'] : ['text']       │
│      thinkingLevelMap ← reasoningFields(info, observe(id))     │
│      compat: { maxTokensField: 'max_tokens' }                  │
│    resolveApiKey() → shim.token()   ← 进程内随机密钥            │
│         │                                                      │
│  shim.ts  http://127.0.0.1:<随机端口>                           │
│    4 道门: Host回环 / Origin回环 / JSON Content-Type / Bearer   │
│    POST /v1/chat/completions                                   │
│      ├─ store.resolve()  ← 真实凭据（按需刷新、单飞、身份优先）  │
│      ├─ prepareChatBody / prepareInternationalChatBody         │
│      │    stream=true, developer→system, tool_choice 扁平化    │
│      └─ client.chatStream() → 补 [DONE] / abort 传播           │
└─────────────────┬──────────────────────────────────────────────┘
                  │ HTTPS  Bearer <accessToken>
                  │ UA: WorkBuddy/<v> <product>/<v> CLI/<cli>
                  ▼
     copilot.tencent.com (CN)  /  www.workbuddy.ai (国际)
       /v2/chat/completions
       /console/enterprises/personal/models    /v3/config
       /v2/plugin/auth/token/refresh
       /v2/billing/meter/get-user-resource   (+ enterprise 变体)

$DSH_HOME 下的状态文件
  .workbuddy-auth.json         / .workbuddy-ai-auth.json          凭据自留副本
  .workbuddy-probe.json        / .workbuddy-ai-probe.json         探测记录（v2，按账号嵌套）
  .workbuddy-catalog.json      / .workbuddy-ai-catalog.json       上次成功目录（按账号）
  .workbuddy-ai-version.json                                      国际版 App 版本缓存
  .workbuddy-app-version.json                                     国内版 App 版本缓存
  .workbuddy-host-heartbeat.json                                  host 心跳（pid + registeredAt）
```

---

## 十六、约束与风险

### 项目自述

1. **插件版本与 DSH 核心一一对应，不可混用**——不匹配会导致 DSH 启动失败（README 有对照表）
2. **国际版目录来自 App 界面接口**，服务端按 UA 分流，属私有实现；上游改动可能使其失效，届时降级为"本账号上次成功目录 → 内置目录"并标明来源与失败原因，**但不保证长期兼容**
3. **Windows/WSL/Linux 下国际版 App 版本无可靠来源**——`installedAppVersion()` 里 `if (process.platform !== 'darwin') return undefined`，会退回最近保存值或内置值
4. **国际版企业计费接口未验证**；CN 企业分支本机无法自测（开发机是个人账号），依据官方 App 接口契约实现
5. **无凭据时的行为变化**——某版 App 从未登录且没留下插件副本时，该版模型分组不再显示（此前国内版会显示一份内置兜底列表，但那些模型选了必然报错）
6. **依赖客户端私有接口**（非官方开放 API）
7. macOS 是唯一验证过的平台；TUI 需 `dsh-tui` `0.10.0-beta.5`+（更早版本装了会报 `events is not iterable`）
8. `dsh-tui` profile 需用 pnpm 11 安装（否则 `ERR_PNPM_UNEXPECTED_STORE`）

### 代码层面的补充观察

- `variants.ts` 声称"第三个 variant 是改数据而非重构"，但 `index.ts` 仍有若干 `variant.id === CN_VARIANT.id` 分支（`configuredAuthFile`、`settingsNamespaceFor`、`fallbackFor`、`useMaximumContextWindow` 挂载点）。这些源于**配置不对称**（CN 有 `probeConsent`，AI 有 `useMaximumContextWindow`），不是纯数据项，所以第三个 variant 仍需少量判断逻辑
- 双 variant 意味着两套 shim、两套路由、两套定时器、两套状态文件；`apply()` 的复杂度随 variant 数线性增长
- 三类状态文件的**清理策略不一致**：saved catalog 登出即删，probe 记录跨账号保留（按账号分键），App 版本缓存永久保留。各自有理由，但磁盘占用会缓慢增长
- **第十四节的两个发现**

---

## 小结

这个项目的本质是**一个协议适配器 + 一个状态机**，质量体现在三层：

1. **协议层**——把 WorkBuddy 私有接口的 quirk（强制流式、developer 角色、tool_choice 形状、11128 的双区域歧义、max_tokens 下限、UA 分流、`modelPromotions` 时效）逐条实测并显式记录
2. **状态层**——凭据双源、三级降级、分代校验、账号维度观测隔离、四态转移，把"App 是活的、会变"这个现实建模进了并发控制
3. **诚实层**——读不懂就报错、促销过期就撤回、`non-validating` 就不给控制、`unknown` 不覆盖已知答案

第三条最难得，也是最一致的：

> **在每一个不确定的地方，作者都选择"把不确定性暴露给用户"，而不是"填一个默认值让界面看起来完整"。**

这在"必须和快速演进的宿主 + 私有上游同时对账"的场景里，是唯一能长期维护下去的姿态。

而本次分析发现的两个问题，恰好都落在这个项目最引以为傲的那条链上——**可追溯性**：一个测试失去了它声称验证的机制，四份被反复引用的设计文档不在仓库里。都不影响功能，但都是"依据链"上的缺口。
