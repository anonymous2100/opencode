# 将 dsh-workbuddy-connect 的功能移植到 opencode — 可行性分析

> 前置文档：`0-doc/dsh-workbuddy-connect-实现原理分析.md`（下称"原理分析"）
> 分析对象：本仓库（opencode monorepo，dev 分支）× `dsh-workbuddy-connect` v0.5.4
> 分析方法：阅读 opencode 的 provider 装配全链路（`packages/opencode/src/provider/provider.ts` 2072 行）、插件系统（V1 Hooks + 加载器）、凭据存储（`packages/opencode/src/auth`）、请求准备（`packages/opencode/src/session/llm/request.ts`）、模型目录（models.dev 集成），以及三个现成的插件样板（`azure.ts`、`github-copilot.ts`、`codex.ts`）。

---

## 结论先行

**可行，且 opencode 的插件缝隙比 DSH 的更干净。** dsh-workbuddy-connect 的每一个核心职责在 opencode 里都有对应（且多数是现成的）挂载点；DSH 版本里最复杂的两个子系统（回环 shim、凭据双源）在 opencode 里分别有**直接替代**（`options.fetch` 自定义 fetch）和**可复用的先例**（`auth.loader`）。

推荐路径是 **方案 B：V1 插件 + `options.fetch` 进程内改写**（一个纯 npm 包，无需任何 opencode 内核改动），详见第六节的三案对比。

| 移植项 | 难度 | 说明 |
|---|---|---|
| 模型目录（动态 + 兜底 + 三级降级） | 低 | `auth.loader` + `provider.models` + config providers 直接覆盖 |
| 凭据读取（桌面 App auth 文件） | 低 | 复用原实现 `auth.ts`，原样可用 |
| Token 刷新（单飞 + 副本写回） | 低 | 原样可用 |
| 请求改写（stream/developer→system/tool_choice） | 低 | `options.fetch` 内做，或 `chat.params` |
| 回环 shim | **可整体省略** | opencode 有 `options.fetch`，无需起本地 HTTP 服务 |
| 推理档位（声明集 + variants） | 中 | `model.variants` 直接支持，但探测服务无现成入口 |
| 积分/促销展示 | 中 | opencode 无设置卡片机制，只能 CLI 化或读 env |
| 多账号可见性（空目录=隐藏分组） | 中 | 靠 `provider.models` 返回空表实现，但模型列表是静态解析的 |
| 图片输入 | 低 | `capabilities.attachment/image` 布尔位 |

---

## 一、先明确"移植什么"

原理分析里总结过，dsh-workbuddy-connect 的本质是**一个协议适配器 + 一个状态机**，由七个可分离的职责组成：

1. **凭据解析**：读桌面 App 的 `workbuddy-desktop.info`（只读），与插件自留副本按"身份优先于过期时间"合并，按需刷新（单飞），区域校验
2. **模型目录**：从上游拉 `cli` agent 名单 + 元数据，三级降级（live → saved → fallback），凭据变化驱动的生命周期
3. **协议适配**：强制流式、`developer`→`system`、`tool_choice` 扁平化、国际版强制首条 system、错误分类
4. **回环 shim**：四层入站加固 + 凭据注入 + SSE 转发
5. **推理档位**：声明集优先、观测补充、三段式探测协议
6. **计费/促销元数据**：积分余额、倍率、限时促销的时效性重算
7. **UI 面**：设置卡片、Composer 探测入口、CLI 诊断

逐项对照 opencode 的能力边界，是本文的主体。

---

## 二、opencode 的 provider 装配全链路（移植的落点）

移植方案的可行性完全取决于这条链路（`packages/opencode/src/provider/provider.ts`，`state` 构造闭包）：

```
models.dev 目录                ← provider 目录的静态底座（database）
    ↓ toPublicInfo()
provider.models hook           ← 插件按 providerID 覆盖模型表（要求 database 已有该 provider）
config.providers 扩展          ← opencode.json 里用户定义的 provider/model（可新建 provider）
env 匹配 (provider.env)        ← 环境变量里的 API key
auth.json (api 类型)           ← `opencode auth login` 存的 key
plugin auth.loader             ← 插件按 providerID 注入 options（要求 auth.json 里已有该 provider 的记录）
内置 custom() loaders          ← anthropic/azure/bedrock/copilot 等特殊逻辑
config.providers 重放          ← 用户配置最终覆盖
allowlist/denylist 过滤        ← enabled_providers / disabled_providers
```

四个对移植起决定作用的事实（均有代码行号佐证）：

### 事实 1：`auth.loader` 是凭据注入的官方缝隙，但有一个门控

`provider.ts:1609-1627`：

```ts
// plugin auth loader - database now has entries for config providers
for (const plugin of plugins) {
  if (!plugin.auth) continue
  const providerID = ProviderV2.ID.make(plugin.auth.provider)
  if (disabled.has(providerID)) continue

  const stored = yield* auth.get(providerID).pipe(Effect.orDie)
  if (!stored) continue          // ← 门控：auth.json 里必须已有该 provider 的记录
  if (!plugin.auth.loader) continue

  const options = yield* Effect.promise(() =>
    plugin.auth!.loader!(
      () => bridge.promise(auth.get(providerID).pipe(Effect.orDie)) as any,
      toPublicInfo(database[plugin.auth!.provider]),
    ),
  )
  const opts = options ?? {}
  const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
  mergeProvider(providerID, patch)
}
```

**`loader` 返回的整个对象会被当作 provider 的 `options`**，一路流进 `resolveSDK` 的工厂调用（`provider.ts:1834` `factory({ name, ...options })`）。这意味着插件可以让 `apiKey`、`baseURL`、`headers`、甚至**自定义 `fetch` 函数**全部来自任意外部来源。

**门控的含义**：`if (!stored) continue` —— loader 只在 `auth.json` 已存在该 provider 记录时触发。这不是缺陷而是安全设计（loader 需要一个"已授权"的信号），移植时用 **`opencode auth login` 的伪 OAuth 方法**（一次性的 `authorize()` 直接成功）来种下这条记录——Azure 插件（`packages/opencode/src/plugin/azure.ts:80-100`）就是这么做的。

### 事实 2：`options.fetch` 是回环 shim 的直接替代

`provider.ts:1798-1829`：opencode 把每个 SDK 的 `fetch` 都包了一层（超时 + SSE 块超时），而**用户的自定义 `fetch` 会先于这个包装被调用**（`const fetchFn = customFetch ?? fetch`）。也就是说插件在 `loader` 里返回的 `fetch` 拿到的是**SDK 已经序列化好的最终请求**（URL、headers、body 全部就绪），返回前可以任意改写。

Azure 插件就是这么用的（`azure.ts:62-70`）：

```ts
async fetch(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  headers.delete("api-key")
  headers.set("authorization", `Bearer ${await token(scopeForRequest(input))}`)
  return request(input, { ...init, headers })
}
```

这正是 dsh-workbuddy-connect 里 shim 的全部实质工作：**在请求离开进程前改写 headers/body，在响应进入 SDK 前改写错误分类**。区别只在于 shim 是网络层代理（需要端口、需要四层加固），而 `fetch` 是进程内函数拦截（无端口、无加固面）。

### 事实 3：`model.variants` 原生支持推理档位

`session/llm/request.ts:80-91`：用户选择的 variant 的 body/headers 会在请求准备时合并进 options；`packages/opencode/src/provider/transform.ts` 的 `variants()` 已经为 GLM-5.2 生成过 `{ high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } }` 这样的映射（针对 `@ai-sdk/openai-compatible`）。

也就是说 **"模型 + 档位"在 opencode 里是一等公民**（`Model.Ref` 带 `variant` 字段，TUI/ACU 都有档位选择 UI），DSH 里用 `thinkingLevelMap` 做的事情，opencode 用 `variants` 做，而且对 `openai-compatible` 路径的 `reasoningEffort` 拼写是现成的。

### 事实 4：`provider.models` hook 有一个目录来源前提

`provider.ts:1454-1479`：

```ts
for (const hook of plugins) {
  const p = hook.provider
  const models = p?.models
  if (!p || !models) continue
  const providerID = ProviderV2.ID.make(p.id)
  ...
  const provider = database[providerID]
  if (!provider) continue        // ← 前提：models.dev 目录里必须已有这个 provider
  ...
  provider.models = await models(toPublicInfo(provider), { auth: pluginAuth })
}
```

`database` 只来自 models.dev（`provider.ts:1404-1406`）。**插件不能凭空造出一个 models.dev 里不存在的 provider**——除非用户先在 `opencode.json` 里声明了它（config 扩展在 hook 之后才跑，所以 hook 看不到 config 定义的 provider；见"限制 2"）。

---

## 三、逐模块映射

### 3.1 凭据解析（原 `src/auth.ts`，485 行）→ **原样移植，零改动**

| 原职责 | opencode 对应 |
|---|---|
| 读桌面 App auth 文件（平台探测链） | 插件内部代码，无需任何宿主支持 |
| 身份优先合并、单飞刷新、区域校验 | 同上 |
| 副本写回 `$DSH_HOME/.workbuddy-auth.json` | 改写到 opencode 数据目录下即可 |

`WorkBuddyCredentialStore` 是纯 TypeScript 类，只依赖 `node:fs`、`node:os`、`node:path` 和原项目的 `withFileLock`/`writeFileAtomic`（后者可换成 opencode 的 `FSUtil.Service` 或简单的写临时文件+rename）。**这是移植成本最低、风险最小的一块。**

集成点：插件的 `auth.loader` 在被调用时读这个 store，把解析出的 `accessToken` 变成返回 options 的一部分。

### 3.2 模型目录（原 `catalog.ts` + `catalog-store.ts`）→ **`provider.models` hook + config 声明**

两条可用路径：

**路径 A（推荐）：config 声明静态兜底 + loader 内动态刷新**

在 `opencode.json` 里声明一个 WorkBuddy provider（models.dev 里没有它，所以必须声明）：

```jsonc
// opencode.json
{
  "provider": {
    "workbuddy": {
      "name": "WorkBuddy",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://copilot.tencent.com/v1" },
      "models": {
        "glm-5.3": { "name": "GLM-5.3" },
        "deepseek-v4-pro": { "name": "Deepseek-V4-Pro" }
      }
    }
  }
}
```

插件的 `auth.loader` 被调用时**重新拉取上游目录**，通过某种机制让模型表生效。这里遇到一个 opencode 侧的缺口，见第五节"限制 1"。

**路径 B：`provider.models` hook**

`ProviderHook.models` 签名（`packages/plugin/src/index.ts:214-217`）：

```ts
export type ProviderHook = {
  id: string
  models?: (provider: ProviderV2, ctx: ProviderHookContext) => Promise<Record<string, ModelV2>>
}
```

它**整体替换**该 provider 的模型表，且带 `ctx.auth`（当前凭据）。前提是该 providerID 在 models.dev 里存在——**`workbuddy` 不在**。

变通：hook 一个**存在的 providerID**（如 `openai-compatible`）并在内部按 providerID 分流——可行但丑陋，且会和真正的 `openai-compatible` 用户互相干扰。

**结论**：目录的动态部分走 `auth.loader`（它每 provider 装配时都会跑，天然是刷新点），静态兜底走 `opencode.json`。三级降级里的 "saved"（上次成功目录）由插件自管一个 JSON 文件，逻辑原样照搬。

### 3.3 协议适配（原 `prepareChatBody`）→ **`options.fetch` 内改写**

四个改写点在 `fetch` 拦截里全部可实现，且比 shim 里更简单（拿到的是已序列化的 body 字符串）：

| 改写 | 实现 |
|---|---|
| `stream: true` 强制 | `JSON.parse(body)` → 设值 → 重新序列化。AI SDK 走 `streamText` 本来就是流式，此项大概率天然满足 |
| `developer` → `system` | AI SDK 的 `@ai-sdk/openai-compatible` **不发** `developer` 角色（它把 system 发成 `system`），此项可能天然不需要——需实测确认 |
| `tool_choice` 扁平化 | AI SDK 的 openai-compatible 发的是字符串 `tool_choice`（"auto"/"required"/具体函数名），此项也大概率天然满足 |
| 国际版首条 system | body 解析后 `unshift`，原逻辑照搬 |

**这是 shim 的最大简化点**：原实现需要维护一个 HTTP 服务器 + 四层加固 + SSE 管道转发，opencode 里变成一个纯函数 `(input, init) => Promise<Response>`，且错误分类（`hard_credit`→402 等）可以在响应返回前把上游状态码/错误体规范化成 AI SDK 期待的开头。

### 3.4 回环 shim（原 `src/shim.ts`，258 行）→ **整体省略**

原理分析里 shim 的四层加固（loopback Host、loopback Origin、JSON Content-Type、per-process Bearer）防的是"本机其他进程/恶意网页打到这个端口"。`options.fetch` 是**进程内函数调用**，没有监听端口，攻击面不存在，四层加固随之消失。

连带省掉的还有：
- 端口分配与 `shim.ready` 生命周期
- `resolveApiKey: () => shim.token()` 的接口错位利用
- `Connection: keep-alive` / `X-Accel-Buffering` 响应头
- `verify-shim-hardening.mjs` 验证脚本

**这是移植相对原项目最大的架构简化。**

### 3.5 推理档位（原 probe 四模块）→ **声明集走 variants，探测服务降级为 CLI**

**声明集**：上游目录里 `reasoning.supportedEfforts` 非空的模型（GLM-5.3 的 low/high/max 等），在 `provider.models` 返回的 `ModelV2.variants` 里直接生成：

```ts
variants: {
  high: { reasoningEffort: "high" },
  max: { reasoningEffort: "max" },
  // low 同理
}
```

opencode 的 TUI/ACU 会自动把 variants 渲染成档位选择。`canDisableThinking` 对应一个 `off: { reasoningEffort: undefined }` 之类的 variant（具体拼写需实测上游行为）。

**探测服务**（三段式 baseline→sentinel→levels）：opencode 没有 DSH 那种"宿主内 HTTP 路由 + 设置卡片"的挂载点，无法在对话 UI 里放一个"检测"按钮。可行形态：

1. 插件包里带一个 CLI 子命令（`package.json` 的 `bin`），用户手动跑 `opencode-workbuddy probe glm-5.2`
2. 探测结果写进插件自管的状态文件（原 `probe-store.ts` 原样可用，含指纹/TTL/账号分键）
3. `auth.loader` 读这份文件，把探测出的档位**合并进返回的模型表**（若走的是可变路径）

**观测优先级规则**（声明集永远赢、non-validating 不给档位、off 永不探测）原样保留——这些是纯函数逻辑，与宿主无关。

### 3.6 计费/促销/积分 → **降级为只读 CLI 或放弃**

- **积分余额**：原 `fetchCredits` 纯函数可用，但没有设置卡片可展示。形态：CLI 子命令（`opencode-workbuddy status`）或干脆砍掉
- **倍率/促销徽章**：DSH 版把它拼进模型 `name`（`GLM-5.2 · x0.79`），opencode 的模型列表同样渲染 `name`，**此法原样可用**（同样需要遵守"纯显示不影响路由"的约束，opencode 按 `model.id` 路由，成立）。促销的时效性重算（`modelWithCurrentPromotion`）是纯函数，原样移植
- **企业积分**：原样移植到 CLI

### 3.7 UI 面 → **opencode 无对应物，砍掉或换形态**

| DSH 里的 | opencode 里的对应 | 结论 |
|---|---|---|
| 设置卡片（三标签页） | 无宿主 UI 插槽 | 砍掉，CLI 替代 |
| Composer 探测按钮 | 无宿主 UI 插槽 | 砍掉，CLI 替代 |
| `/model` 弹窗的档位显示 | TUI/ACU 原生 variants 选择 | 免费获得，更好 |
| CLI `status`/`doctor`/`logout` | 插件包自带 bin | 保留 |

### 3.8 多账号可见性 → **重新设计**

DSH 版用"空目录=隐藏分组"实现"没登录的版本不出现在选择器"。opencode 的模型列表是**静态解析**的（config 声明了哪些模型就有哪些），没有"运行时把 provider 从列表里摘掉"的官方缝隙——`enabled_providers`/`disabled_providers` 是静态配置。

变通：`auth.loader` 返回 `{}`（无凭据时），该 provider 的请求会在 `resolveSDK` 因缺 `apiKey` 而失败——但**模型仍会出现在选择器里**（选了会报错）。这与 DSH 版"必然报错的模型不如不显示"的设计哲学冲突。

**务实的取舍**：接受"未登录时模型可见但请求报错"，在错误信息里引导（`auth.loader` 抛出的错误信息可以带"在 WorkBuddy App 里登录一次"的指引）；或者接受"需要用户在 config 里手动注释掉 provider"。

---

## 四、推荐的插件骨架

```ts
// opencode-workbuddy-connect/index.ts
import type { Plugin } from "@opencode-ai/plugin"

const WorkBuddyPlugin: Plugin = async (input) => ({
  auth: {
    provider: "workbuddy",
    // 种子记录：一次性伪 OAuth（抄 Azure 插件的做法）
    methods: [{
      type: "oauth",
      label: "Use WorkBuddy desktop app sign-in",
      async authorize() {
        // 触发一次凭据读取，失败则报错（引导用户去 App 登录）
        const credential = await store.resolve()
        return {
          url: "",
          instructions: "Reads the sign-in from the WorkBuddy desktop app.",
          method: "auto",
          callback: async () => ({ type: "success", access: DUMMY, refresh: DUMMY, expires: far }),
        }
      },
    }],
    // 每次装配时：读凭据 → 刷新目录 → 返回带自定义 fetch 的 options
    async loader(getAuth) {
      const credential = await store.resolve()          // 原 auth.ts 逻辑
      const models = await fetchCatalog(credential)     // 原 upstream.ts 逻辑
      rememberCatalog(models)                           // saved 层
      return {
        apiKey: credential.accessToken,
        headers: buildHeaders(credential),              // X-User-Id 等
        async fetch(input, init) {
          // prepareChatBody 改写 + 国际版 system 注入
          // 响应侧错误分类规范化
        },
      }
    },
  },
  // provider.models 需要目录存在的前提，见"限制 2"，故这里不用它
})
export default WorkBuddyPlugin
```

用户侧配置：

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["opencode-workbuddy-connect"],
  "provider": {
    "workbuddy": {                        // models.dev 没有，必须声明
      "name": "WorkBuddy",
      "npm": "@ai-sdk/openai-compatible",
      "models": { "glm-5.3": {}, "deepseek-v4-pro": {}, "..." : {} }
    }
  }
}
```

关键分工：**config 声明模型清单（静态），插件负责凭据 + 协议改写 + 目录刷新（动态）**。

### 双 provider 的实现要点（实施层面已验证）

`Hooks.auth.provider` 是单数（一个插件一个 auth provider），且 config 的 `plugin` 数组按包名去重（`config/plugin.ts:64-77` `deduplicatePluginOrigins`），同一包不能声明两次。服务 workbuddy + workbuddy-ai 两个 provider 的正确做法是 **`getLegacyPlugins` 多函数导出路径**（`plugin/index.ts:99-112`）：

- **不提供** default export 的 `{id, server}` 对象（detect 逻辑 `shared.ts:278-283`：default export 不是含 `id`/`server`/`tui` 键的对象时返回 undefined，落回 legacy 路径）
- **导出多个普通函数**，每个函数导出都会被 `getLegacyPlugins` 收集为独立插件实例，各声明自己的 `auth.provider`
- 两个函数共享同一套凭据 store / 上游 client / 目录逻辑，仅以 `CN_VARIANT` / `AI_VARIANT` 参数区分

```ts
// 不能 default export 对象；导出多个函数，各管一个 provider
export const WorkBuddyPlugin = async (input) => makeHooks(CN_VARIANT, input)
export const WorkBuddyAIPlugin = async (input) => makeHooks(AI_VARIANT, input)
```

---

## 五、opencode 侧的限制与需要的权衡

### 限制 1：`auth.loader` 的产出没有官方的"模型表更新"通道

`loader` 返回的 options 里放模型清单是**无效的**——模型表在 `resolveSDK` 之前已经定型。目录动态刷新只能：
- 靠用户重启 opencode（每次装配重新跑 loader → 目录是最新的）
- 或靠 `provider.models` hook（受限制 2 约束）

DSH 版的"启动后登录不用重启"体验在 opencode 里**打折扣**（登录后需要重启或重开 session 才见新目录）。

### 限制 2：`provider.models` hook 要求 provider 在 models.dev 里存在

`workbuddy`/`workbuddy-ai` 不在 models.dev。三个出路：

1. **给 models.dev 提 PR** 添加这两个 provider（上游是公开的 [models.dev](https://models.dev) 数据仓库），插件 hook 就能正常工作——这是最正的路，但把"私有 App 接口"写进了公开数据集，**不合适**（倍率/促销/凭据路径都是私有实现）
2. hook 一个存在的 providerID 内部分流——脏，会互相干扰
3. **不用 hook**，接受限制 1 的"重启刷新"语义——推荐

### 限制 3：无 UI 插槽

opencode 的插件没有设置卡片/对话侧边按钮这类 UI 注入点（V2 的 `ctx.catalog`/`ctx.integration` 是数据面不是 UI 面）。所有"给用户看的信息"（积分、目录来源、探测结果）只能走 CLI。

### 限制 4：`chat.headers` 与 `options.headers` 的分工

`chat.headers` hook（`request.ts:134-146`）是**每请求**触发的，比 `loader` 里的静态 headers 更适合放"每次都可能变的"头（比如轮换后的 token）。它是插件自己的 hook 函数，**天然能访问插件闭包状态**（store、缓存等），所以 token 既可从 `auth.json`（`getAuth()`）读，也可直接从插件自管的 store 读。两者结合：`loader` 放静态结构，`chat.headers` 放动态 token。

补充说明：`chat.headers` 的返回值在当前代码路径里**仅对 openai OAuth 路径被消费**（`session/llm/request.ts` 的 `Prepared.headers` 主要服务于 codex OAuth 的 `instructions` 流程），自定义 provider 走 `@ai-sdk/openai-compatible` 时动态 token 应优先放进 `loader` 返回的自定义 `fetch` 里（Azure 插件的做法），`chat.headers` 作为补充。

### 限制 5：错误分类的规范化边界

AI SDK 对上游错误有自己的解析（`APICallError` 等）。原 shim 把上游错误映射成 402/429/401/502 是给 DSH 的 retry 层看的；opencode 的重试语义由 AI SDK 内部决定，`fetch` 拦截里改状态码**可能**被 AI SDK 的错误解析二次加工。`provider-error.ts`（`packages/llm/src/provider-error.ts`）是 native 路径的分类器，AI SDK 路径的行为需实测后决定拦截里改什么。

---

## 六、三案对比

| | 方案 A：纯 config，无插件 | 方案 B：V1 插件 + `options.fetch` | 方案 C：改 opencode 内核（内置 provider） |
|---|---|---|---|
| 需要改 opencode | 否 | 否 | 是（新 provider 插件进 `ProviderPlugins` 或 models.dev 条目） |
| 能复用原项目代码量 | ~0%（凭据/协议逻辑没地方放） | **~70%**（auth/upstream/catalog/probe 纯逻辑全保留，shim 省略，UI 砍掉） | ~85%（额外获得 models hook 的动态目录） |
| 动态目录刷新 | 无 | 重启生效 | 实时（catalog.transform） |
| 未登录时隐藏模型组 | 否（可见但报错） | 否（同左） | **可以**（学习 DSH 的空目录语义） |
| 探测 UI | 无 | CLI | 可挂 command hook（`ctx.command.transform` 加一个 `/workbuddy-probe` 命令） |
| 维护成本 | 最低 | 低 | 最高（跟内核演进） |
| 发布形态 | 一份 opencode.json + 文档 | npm 包 `opencode-workbuddy-connect` | opencode 仓库 PR |

**推荐方案 B**，理由：

1. opencode 的 V1 插件 API 是稳定公开面（`@opencode-ai/plugin`），Azure/Copilot/Codex 等内置 auth 插件全部走这条路，**样例充足且不会因内核重构而破**
2. 原项目最有价值的资产——凭据状态机、上游协议细节（quirk 清单）、错误分类、促销时效逻辑——全部是宿主无关的纯逻辑，B 能保留
3. DSH 版最重的两个包袱（shim 的安全面、四层加固）在 B 里自然消失
4. 方案 C 的额外收益（实时目录、隐藏分组、探测命令）都值得要，但代价是进内核 + 跟随 Effect V2 架构演进；可以作为 B 验证可行后的**二期**

### 方案 B 的两期划分

**一期（能跑）**：
- npm 包：`auth.ts` + `upstream.ts`（裁剪）+ `catalog.ts`（兜底表）+ 插件入口（伪 OAuth 种子 + loader）
- config 模板：`opencode.json` 声明 workbuddy / workbuddy-ai 两个 provider + 模型清单
- 验证：流式对话、工具调用、图片输入、GLM-5.3 档位（variants 静态写死在 config 的 `variants` 字段里，一期不做动态）

**二期（对齐 DSH 版体验）**：
- 动态目录：loader 内刷新 + saved 降级（需要接受"重启生效"）
- 推理探测：CLI 子命令 + probe-store 原样移植 + loader 读探测结果
- 积分/倍率：CLI `status`；倍率拼进模型 name
- 国际版：`prepareInternationalChatBody` + 首条 system + `WorkBuddyAI/<v>` UA

---

## 七、风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| `@ai-sdk/openai-compatible` 对 WorkBuddy 上游的兼容性未知（SSE 形状、`object: "response"` 包装、工具调用续轮） | **高**——这是 DSH 版当年必须写 shim 的原因 | 一期先做连通性验证：单模型单轮 → 工具调用 → 图片 → 档位；不兼容处全部塞进 `fetch` 拦截改写 |
| `chat.headers` 触发频率与 token 轮换时机的错配 | 中 | token 刷新在 `loader` 内闭包持有 store；headers hook 每次从 store 现读 |
| 上游私有接口变更（原项目已有此风险） | 中 | 与 DSH 版同源，跟随上游更新即可 |
| opencode V1 插件 API 未来演进 | 低-中 | V2 API 已存在但 `auth.loader` 语义在两代里等价，迁移路径清晰 |
| 模型可见性与"必然报错"问题（限制 1/2 的副作用） | 低 | 错误信息引导 + README 说明 |
| 原项目的两个已知问题随代码带过来（probe-composer 失效测试、4 份缺失设计文档） | 低 | 移植时顺手修：不搬 localStorage 残留；把 quirk 清单直接写成代码注释 |

---

## 八、与 DSH 版的能力对照（最终形态）

| 能力 | DSH 版 | opencode 移植版（方案 B 二期） |
|---|---|---|
| 模型接入 | ✅ 零配置 | ✅ 一次 config 声明 |
| 凭据复用 App 登录 | ✅ | ✅ 同源逻辑 |
| 账号切换跟随 | ✅ 轮询 30s | ⚠️ 重启/重开 session 生效 |
| 未登录隐藏分组 | ✅ | ❌（可见但报错，错误信息引导） |
| 流式 / 工具调用 / 图片 | ✅ | ✅（依赖 AI SDK 兼容性验证） |
| 推理档位（声明集） | ✅ thinkingLevelMap | ✅ variants（TUI 原生选择 UI） |
| 推理档位（探测） | ✅ 卡片内一键 | ⚠️ CLI 子命令 |
| 积分/倍率/促销显示 | ✅ 卡片 + 模型名后缀 | ⚠️ CLI + 模型名后缀 |
| 促销时效重算 | ✅ | ✅ 纯函数原样移植 |
| 企业积分 | ✅ | ⚠️ CLI |
| 安全加固 | shim 四层门 | 不需要（进程内拦截无攻击面） |
| 诊断 CLI | ✅ | ✅ 同源逻辑 |

---

## 九、结语

移植的可行性判断可以压缩成三句话：

1. **opencode 的插件缝隙（`auth.loader` + `options.fetch` + variants）覆盖了 dsh-workbuddy-connect 的全部核心职责**，而且 `options.fetch` 让原项目里最重的组件（回环 shim 及其安全面）整体消失——这是架构上的净简化。
2. **原项目约七成代码是宿主无关的纯逻辑**（凭据状态机、上游协议、目录降级、探测协议、促销时效），可以近乎原样搬运；真正要重写的只有插件入口（~100 行）和 UI 面（放弃或 CLI 化）。
3. **两个体验降级是 opencode 架构的固有代价**（目录刷新需重启、未登录时模型可见但报错），不是移植缺陷；如果二期决定进内核（方案 C），两者都能消除，但要付出跟随 Effect V2 演进的维护成本。

先做方案 B 一期的连通性验证（半天工作量：包骨架 + config 模板 + 单模型对话），它的结果决定 `@ai-sdk/openai-compatible` 对 WorkBuddy 上游的兼容性——这是整个移植唯一真正的不确定项。
