# 默认旧布局、取消自动切换新布局 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 opencode app 默认进入旧布局，并且除非用户在设置里主动开启，永不自动切换到新布局。

**Architecture:** 把 `general.newLayoutDesigns` 变为决定布局的唯一开关（默认 `false`）；删除 sunset 退役与升级迁移两条自动切换路径；用一次性持久化标记 `general.layoutDefaultReset` 清空既有 `true`；设置里的开关常驻可见。

**Tech Stack:** SolidJS（createStore/createMemo/createEffect）、bun test、Playwright。

## Global Constraints

- 布局唯一规则：`general.newLayoutDesigns === true` → 新布局；`undefined` / `false` → 旧布局。
- 不删除新布局（v2）代码；不修改 TUI（`packages/tui`）行为。
- 一次性迁移标记字段名固定为 `general.layoutDefaultReset`。
- 迁移只清空 `general.newLayoutDesigns`，不得改动其它设置项。
- 单元测试命令在 `packages/app` 目录下运行：`bun test --conditions=solid --preload ./happydom.ts <path>`。
- 类型检查：`bun run --cwd packages/app typecheck`。

---

### Task 1: 核心布局逻辑 + 设置开关常驻

一次性改完 `settings.tsx` 与其两个设置 UI 消费方，保证任一时刻都能编译通过。

**Files:**
- Modify: `packages/app/src/context/settings.tsx`
- Modify: `packages/app/src/components/settings-v2/general.tsx`
- Modify: `packages/app/src/components/settings-general.tsx`
- Test: `packages/app/src/context/settings.test.ts`

**Interfaces:**
- Produces（供 Task 2 与运行时代码使用）:
  - `export const newLayoutDesignsDefault = false`
  - `export function resolveLayoutDesigns(preference: boolean | undefined): boolean`
  - `export function shouldResetLayoutDefault(applied: boolean | undefined): boolean`
  - provider 暴露：`settings.general.newLayoutDesigns()`、`settings.general.setNewLayoutDesigns(value: boolean)`
- Removes: `oldInterfaceSunset`、`layoutTransitionState`、`maximumSunsetTimeout`、`nextSunsetCheckDelay`、`resolveNewLayoutDesigns`、`shouldEnableNewLayout`，以及 provider 的 `layoutTransitionAvailable` / `newInterfaceNoticeVisible` / `dismissNewInterfaceNotice` / `layoutTransitionClassified` / `setOldLayoutEligible`。

- [ ] **Step 1: 用新用例替换单元测试**

把 `packages/app/src/context/settings.test.ts` 整个文件替换为：

```ts
import { describe, expect, test } from "bun:test"
import {
  hasExistingWebState,
  initialAgentVisibility,
  isAppUpgrade,
  newLayoutDesignsDefault,
  resolveLayoutDesigns,
  shouldDisplayTabsToast,
  shouldResetLayoutDefault,
} from "./settings"

describe("agent visibility", () => {
  test("shows the picker for existing profiles and hides it for first-time installs", () => {
    expect(initialAgentVisibility(undefined, true)).toBe(true)
    expect(initialAgentVisibility(undefined, false)).toBe(false)
  })

  test("shows the picker when updating from a recent release", () => {
    expect(initialAgentVisibility(undefined, false, "1.18.8")).toBe(true)
  })

  test("preserves the preference after initialization", () => {
    expect(initialAgentVisibility(true, true, "1.18.8")).toBeUndefined()
    expect(initialAgentVisibility(true, false)).toBeUndefined()
  })
})

describe("layout defaults", () => {
  test("blank profiles default to the legacy layout", () => {
    expect(newLayoutDesignsDefault).toBe(false)
  })

  test("only an explicit true selects the new layout", () => {
    expect(resolveLayoutDesigns(undefined)).toBe(false)
    expect(resolveLayoutDesigns(false)).toBe(false)
    expect(resolveLayoutDesigns(true)).toBe(true)
  })

  test("resets an existing preference exactly once", () => {
    expect(shouldResetLayoutDefault(undefined)).toBe(true)
    expect(shouldResetLayoutDefault(false)).toBe(true)
    expect(shouldResetLayoutDefault(true)).toBe(false)
  })

  test("classifies web profiles from existing settings or a recorded version", () => {
    expect(hasExistingWebState("{}", undefined)).toBe(true)
    expect(hasExistingWebState(null, "1.17.19")).toBe(true)
    expect(hasExistingWebState(null, undefined)).toBe(false)
  })

  test("detects upgrades only when a previous version is older", () => {
    expect(isAppUpgrade("1.17.19", "1.17.20")).toBe(true)
    expect(isAppUpgrade(undefined, "1.17.20")).toBe(false)
    expect(isAppUpgrade("1.17.20", "1.17.20")).toBe(false)
    expect(isAppUpgrade("1.17.21", "1.17.20")).toBe(false)
  })

  test("shows the tabs toast for upgrades and existing installs without a recorded version", () => {
    expect(shouldDisplayTabsToast("1.17.19", "1.17.20", false)).toBe(true)
    expect(shouldDisplayTabsToast(undefined, "1.17.20", true)).toBe(true)
    expect(shouldDisplayTabsToast(undefined, "1.17.20", false)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/context/settings.test.ts`
Expected: FAIL —— `resolveLayoutDesigns` / `shouldResetLayoutDefault` 未从 `./settings` 导出。

- [ ] **Step 3: 改 `settings.tsx` 的常量（第 57-64 行）**

把：

```ts
export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"
const legacyNewLayoutDesignsDefault = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"
export const newLayoutDesignsDefault = true
// Existing users can switch layouts until local midnight on this date. Set new Date(YYYY, M-1, D) to show.
export const oldInterfaceSunset = new Date(2026, 8, 14)
const newLayoutDesignsUpgradeCutoff = "1.17.19"
```

替换为：

```ts
export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"
export const newLayoutDesignsDefault = false
```

- [ ] **Step 4: 改 `settings.tsx` 的纯函数区（原第 102-132 行）**

删除这三个函数：`shouldEnableNewLayout`、`layoutTransitionState`、`maximumSunsetTimeout`，以及 `nextSunsetCheckDelay`、`resolveNewLayoutDesigns`。

保留不动：`compareVersions`、`isAppUpgrade`、`shouldDisplayTabsToast`、`hasExistingWebState`、`initialAgentVisibility`。

在 `initialAgentVisibility` 之后新增：

```ts
export function resolveLayoutDesigns(preference: boolean | undefined): boolean {
  return preference ?? newLayoutDesignsDefault
}

export function shouldResetLayoutDefault(applied: boolean | undefined): boolean {
  return applied !== true
}
```

- [ ] **Step 5: 改 `Settings` 接口字段（第 37-41 行）**

把：

```ts
    newLayoutDesigns?: boolean
    layoutTransitionEligible?: boolean
    agentVisibilityInitialized?: boolean
    newInterfaceNoticeDismissed?: boolean
    shouldDisplayTabsToast?: boolean
```

替换为：

```ts
    newLayoutDesigns?: boolean
    layoutDefaultReset?: boolean
    agentVisibilityInitialized?: boolean
    shouldDisplayTabsToast?: boolean
```

- [ ] **Step 6: 改 `settings.tsx` 顶部 import（第 2 行）**

`createSignal` 与 `onCleanup` 在删除退役逻辑后不再使用，替换为：

```ts
import { batch, createEffect, createMemo } from "solid-js"
```

- [ ] **Step 7: 替换 init 内的布局信号（第 250-278 行）**

把从 `const sunset = oldInterfaceSunset` 到 `newLayoutDesigns` 的整个 memo 块（第 250-278 行）替换为：

```ts
    const newLayoutDesigns = createMemo(() => resolveLayoutDesigns(store.general?.newLayoutDesigns))
```

- [ ] **Step 8: 删除 sunset 超时 effect（原第 289-302 行）**

删除整个 `if (sunset && !oldInterfaceRetired()) { ... }` 块（含 `checkSunset` 函数与 `onCleanup`）。

- [ ] **Step 9: 删除升级迁移 effect（原第 321-327 行）与强制退役 effect（原第 340-344 行）**

删除这两段：

```ts
    createEffect(() => {
      if (!ready() || !launchState.classified || launchState.migrationApplied) return
      if (layoutUpgrade() && store.general?.newLayoutDesigns !== true) {
        setStore("general", "newLayoutDesigns", true)
      }
      setLaunchState("migrationApplied", true)
    })
```

```ts
    createEffect(() => {
      if (!ready() || !oldInterfaceRetired()) return
      if (store.general?.newLayoutDesigns === true) return
      setStore("general", "newLayoutDesigns", true)
    })
```

在同一位置新增一次性重置迁移 effect：

```ts
    createEffect(() => {
      if (!ready()) return
      if (!shouldResetLayoutDefault(store.general?.layoutDefaultReset)) return
      batch(() => {
        setStore("general", "newLayoutDesigns", undefined)
        setStore("general", "layoutDefaultReset", true)
      })
    })
```

- [ ] **Step 10: 改 web 分类 effect（原第 314-319 行）**

把：

```ts
    createEffect(() => {
      if (!ready() || !launchState.classified || platform.platform !== "web") return
      const existing = hasExistingWebState(settingsInit, launchState.previous)
      if (!layoutTransitionClassified()) setStore("general", "layoutTransitionEligible", existing)
      initializeAgentVisibility(existing)
    })
```

替换为：

```ts
    createEffect(() => {
      if (!ready() || !launchState.classified || platform.platform !== "web") return
      initializeAgentVisibility(hasExistingWebState(settingsInit, launchState.previous))
    })
```

- [ ] **Step 11: 改 tabs toast effect（原第 329-338 行）**

把：

```ts
    createEffect(() => {
      if (!ready() || !launchState.classified) return
      if (typeof store.general?.shouldDisplayTabsToast === "boolean") return
      if (!launchState.previous && !layoutTransitionClassified()) return
      setStore(
        "general",
        "shouldDisplayTabsToast",
        shouldDisplayTabsToast(launchState.previous, platform.version, layoutTransitionEligible()),
      )
    })
```

替换为：

```ts
    createEffect(() => {
      if (!ready() || !launchState.classified) return
      if (typeof store.general?.shouldDisplayTabsToast === "boolean") return
      setStore(
        "general",
        "shouldDisplayTabsToast",
        shouldDisplayTabsToast(
          launchState.previous,
          platform.version,
          hasExistingWebState(settingsInit, launchState.previous),
        ),
      )
    })
```

- [ ] **Step 12: 改 provider 返回对象（原第 431-449 行）**

把：

```ts
        newLayoutDesigns,
        setNewLayoutDesigns(value: boolean) {
          const next = oldInterfaceRetired() ? true : value
          if (newLayoutDesigns() === next) return
          setStore("general", "newLayoutDesigns", next)
          if (typeof window !== "undefined") setTimeout(() => window.location.reload())
        },
        layoutTransitionClassified,
        setOldLayoutEligible(eligible: boolean) {
          const current = store.general?.layoutTransitionEligible
          if (typeof current === "boolean") return
          setStore("general", "layoutTransitionEligible", eligible)
        },
        initializeAgentVisibility,
        layoutTransitionAvailable: createMemo(() => ready() && layoutTransition().available),
        newInterfaceNoticeVisible: createMemo(() => ready() && layoutTransition().notice),
        dismissNewInterfaceNotice() {
          setStore("general", "newInterfaceNoticeDismissed", true)
        },
```

替换为：

```ts
        newLayoutDesigns,
        setNewLayoutDesigns(value: boolean) {
          if (newLayoutDesigns() === value) return
          setStore("general", "newLayoutDesigns", value)
          if (typeof window !== "undefined") setTimeout(() => window.location.reload())
        },
        initializeAgentVisibility,
```

- [ ] **Step 13: 改 `settings-v2/general.tsx`**

1. 第 15 行 import 改为只引 `LayoutTransitionToggle`：
   ```ts
   import { LayoutTransitionToggle } from "./interface-transition"
   ```
2. 删除 `InterfaceNoticeSection` 定义（原第 318-325 行）。
3. 第 544-551 行的 tab body 开头，把两个 `<Show>` 换成直接渲染：
   ```tsx
         <div class="settings-v2-tab-body">
           <InterfaceSection />

           <GeneralSection />
   ```
   （即删除 `<Show when={settings.general.layoutTransitionAvailable()}>` 包裹，以及整个 `<Show when={settings.general.newInterfaceNoticeVisible()}>...</Show>` 块）

- [ ] **Step 14: 改 `settings-general.tsx`**

1. 删除 `InterfaceNoticeSection` 定义（原第 284-297 行）。
2. 第 750-757 行，把两个 `<Show>` 换成直接渲染：
   ```tsx
         <div class="flex flex-col gap-8 w-full">
           <InterfaceSection />

           <GeneralSection />
   ```
   （`Button` import 保留，第 695 行仍在用。）

- [ ] **Step 15: 运行单元测试，确认通过**

Run: `cd packages/app && bun test --conditions=solid --preload ./happydom.ts src/context/settings.test.ts`
Expected: PASS，全部用例通过。

- [ ] **Step 16: 类型检查**

Run: `bun run --cwd packages/app typecheck`
Expected: 通过，无 `Property 'layoutTransitionAvailable' does not exist` 之类的报错。

- [ ] **Step 17: 提交**

```bash
git add packages/app/src/context/settings.tsx packages/app/src/context/settings.test.ts packages/app/src/components/settings-v2/general.tsx packages/app/src/components/settings-general.tsx
git commit -m "feat(app): default to legacy layout and remove automatic layout switching"
```

---

### Task 2: e2e 用例适配

默认值从新布局改为旧布局后，此前依赖"默认即新布局"的用例需要显式声明 `newLayoutDesigns: true`；同时新增一个"默认即旧布局"的回归用例。

**Files:**
- Create: `packages/app/e2e/regression/default-legacy-layout.spec.ts`
- Modify: `packages/app/e2e/**/*.spec.ts`（按 Step 2 结果逐个补显式值）

**Interfaces:**
- Consumes: Task 1 的默认值行为（`settings.v3` 中不写 `newLayoutDesigns` 即为旧布局）。

- [ ] **Step 1: 找出所有设置 `settings.v3` 的 e2e 用例**

Run: `cd packages/app && grep -rl "settings\.v3" e2e`
记录所有匹配文件，逐个查看其 `page.addInitScript` / `localStorage.setItem("settings.v3", ...)`：若用例断言的是新布局 UI，则它需要在写入时包含 `newLayoutDesigns: true`。

- [ ] **Step 2: 运行 e2e，取得基线失败清单**

Run: `cd packages/app && bun run test:e2e`
Expected: 部分用例 FAIL（此前默认新布局，现在落到旧布局）。

- [ ] **Step 3: 为期望新布局的失败用例补显式开关**

对每个失败且本意是新布局的用例，把其 `settings.v3` 写入改为包含 `general.newLayoutDesigns: true`。已有 `general` 字段的形态：

```ts
localStorage.setItem("settings.v3", JSON.stringify({ general: { ...原字段, newLayoutDesigns: true } }))
```

没有 `settings.v3` 写入的用例，在 `page.addInitScript` 内新增：

```ts
localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
```

注意：本意就是旧布局的用例（例如 `packages/app/e2e/regression/legacy-new-session.spec.ts`）保持 `newLayoutDesigns: false` 不变。

- [ ] **Step 4: 新增默认旧布局回归用例**

创建 `packages/app/e2e/regression/default-legacy-layout.spec.ts`：

```ts
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const draftID = "draft_default_legacy_layout"
const directory = "C:/OpenCode/DefaultLegacyLayout"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

test("defaults to the legacy layout when no preference is stored", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_default_legacy_layout",
      worktree: directory,
      vcs: "git",
      name: "default-legacy-layout",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: {} }))
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )

  await page.goto(`/new-session?draftId=${draftID}`)

  await expect(page).toHaveURL(`/${base64Encode(directory)}/session`)
  await expect(page.locator("header[data-tauri-drag-region]")).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
})
```

- [ ] **Step 5: 重跑 e2e，确认全绿**

Run: `cd packages/app && bun run test:e2e`
Expected: PASS，包括新增的 `default-legacy-layout.spec.ts`。

- [ ] **Step 6: e2e 类型检查**

Run: `bun run --cwd packages/app typecheck:e2e`
Expected: 通过。

- [ ] **Step 7: 提交**

```bash
git add packages/app/e2e
git commit -m "test(app): pin new-layout e2e specs and cover default legacy layout"
```

---

## Self-Review

**Spec coverage:**
- 默认旧布局 → Task 1 Step 3-4、7（`newLayoutDesignsDefault=false`、`resolveLayoutDesigns`）
- 移除退役 → Task 1 Step 3、7、8、9（删除 `oldInterfaceSunset` 及两处 effect）
- 移除升级迁移 → Task 1 Step 4、9
- 去 clamp → Task 1 Step 12
- 一次性重置 → Task 1 Step 5、9（`layoutDefaultReset`）
- 开关常驻 → Task 1 Step 13-14
- 测试更新 → Task 1 Step 1、Task 2 全部
- i18n key 保留 → 计划未改动语言文件，符合设计

**Placeholder scan:** 无 TBD/TODO；Task 2 Step 3 依赖 Step 2 的实际失败清单，已给出确定的修补模式与示例代码。

**Type consistency:** `resolveLayoutDesigns`、`shouldResetLayoutDefault`、`layoutDefaultReset` 在测试、实现、迁移中命名一致；provider 暴露的 `newLayoutDesigns` / `setNewLayoutDesigns` 签名与 UI 消费方一致。
