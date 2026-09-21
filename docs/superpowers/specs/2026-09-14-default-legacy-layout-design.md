# 默认旧布局、取消自动切换新布局 — 设计文档

日期：2026-09-14
范围：`packages/app`（opencode 桌面/Web 应用）

## 背景

opencode app 存在新旧两套界面布局，由设置项 `general.newLayoutDesigns` 控制：

- `newLayoutDesigns === true` → 新布局（v2）
- 否则 → 旧布局（legacy）

原实现会在以下情况自动把用户切到新布局，与"用户不开启就永远是旧布局"的目标冲突：

1. **退役时间限制**：`oldInterfaceSunset = new Date(2026, 8, 14)`（即 2026-09-14）。到点后 `oldInterfaceRetired()` 为 true，强制新布局，并把存储里的 `newLayoutDesigns` 写成 `true`，设置开关也随之隐藏。
2. **升级迁移**：`shouldEnableNewLayout`（版本跨过 `1.17.19`）自动开启新布局。
3. **fallback 默认值**：`legacyNewLayoutDesignsDefault` 在非 prod 渠道为 `true`，老用户 fallback 仍偏新布局。

本设计的目标行为：**所有用户默认旧布局；除非用户在设置里主动开启新布局，否则永不自动切换到新布局。**

## 目标

- 布局唯一由 `store.general.newLayoutDesigns` 决定，默认 `false`（旧布局）。
- 删除退役时间限制与升级自动切换。
- 设置里的 "New interface" 开关常驻可见，用户可随时手动开启新布局。
- 存储中既有的 `newLayoutDesigns: true`（含被退役逻辑强制写入的）做一次性重置，回到默认旧布局。

## 非目标

- 不删除新布局（v2）代码；它保留为可选项。
- 不调整 TUI（终端界面）的任何行为。
- 不改动与布局无关的设置项（`shouldDisplayTabsToast` 的 toast 语义保持）。

## 设计

### 1. 布局的唯一真相

`general.newLayoutDesigns` 是唯一开关：显式 `true` → 新布局；其余（`undefined` / `false`）→ 旧布局。

- `newLayoutDesignsDefault` 由 `true` 改为 `false`。
- 删除 `legacyNewLayoutDesignsDefault`。
- `newLayoutDesigns` memo 简化为 `store.general?.newLayoutDesigns ?? false`，去掉 `layoutUpgrade` / 分支式 `resolveNewLayoutDesigns` 逻辑。

### 2. 移除所有自动切换来源

- **退役机制**：删除 `oldInterfaceSunset`、`oldInterfaceRetired`、sunset timeout effect、强制写 `true` 的 effect。
- **升级迁移**：删除 `shouldEnableNewLayout`、`layoutUpgrade` 及其 effect；保留同一 effect 中的 agent visibility 初始化。
- **clamp**：`setNewLayoutDesigns` 去掉 `oldInterfaceRetired() ? true : value`，直接写入用户选择。
- **仅服务于退役/迁移的死代码**：删除 `layoutTransitionState`、`nextSunsetCheckDelay`、`maximumSunsetTimeout`、`newLayoutDesignsUpgradeCutoff`。
  `isAppUpgrade`、`compareVersions`、`shouldDisplayTabsToast` 保留（仍用于升级后的 tabs toast）。

### 3. 一次性重置迁移

- 新增持久化字段 `general.layoutDefaultReset?: boolean`。
- 在 settings provider 初始化、store ready 之后执行一次：若 `layoutDefaultReset !== true`，则：
  1. `setStore("general", "newLayoutDesigns", undefined)`
  2. `setStore("general", "layoutDefaultReset", true)`
- 效果：清空所有既有 `true`（被退役逻辑强制写入的、或历史遗留的），使所有用户回到默认旧布局；迁移完成后用户手动开启的 `true` 不再被清除。
- 同时删除不再使用的字段 `layoutTransitionEligible`、`newInterfaceNoticeDismissed`。

### 4. 设置开关常驻可见

- `settings-v2/general.tsx` 与 `settings-general.tsx`：去掉 `Show when={layoutTransitionAvailable()}`，直接渲染 `InterfaceSection`。
- 删除退役提示 `InterfaceNoticeSection`（及其在某处的 `Show`）。
- provider 返回对象删除：`layoutTransitionAvailable`、`newInterfaceNoticeVisible`、`dismissNewInterfaceNotice`、`layoutTransitionClassified`、`setOldLayoutEligible`。
- `shouldDisplayTabsToast` 的第三个参数原用 `layoutTransitionEligible()`，改用 `hasExistingWebState(settingsInit, launchState.previous)` 判断（语义等价：是否为已存在的安装）。
- i18n 的 `newInterfaceNotice.*` key 保留在语言文件中（未使用无害，避免牵动大量语言文件）。

### 5. 数据流

```
用户点击 "New interface" 开关
  → setNewLayoutDesigns(value)          # 无 clamp
  → setStore("general","newLayoutDesigns", value)
  → location.reload()

应用启动
  → persisted("settings.v3") 加载 store
  → ready 后跑一次性迁移：若 layoutDefaultReset !== true，清空 newLayoutDesigns
  → newLayoutDesigns() = store.general?.newLayoutDesigns ?? false
  → app.tsx 路由按 newLayoutDesigns() 分流 legacy / v2
```

## 错误处理

- 一次性迁移使用 `createEffect` + `ready()` 守卫，与既有 settings 迁移 effect 模式一致；store 未就绪时不动数据。
- `setNewLayoutDesigns` 在写入后 `window.location.reload()`，沿用现有行为（布局切换需要整页重载）。

## 测试

- **单元** `packages/app/src/context/settings.test.ts`：
  - 删除 `layoutTransitionState` / `shouldEnableNewLayout` / `nextSunsetCheckDelay` 相关用例。
  - `newLayoutDesignsDefault` 期望值改为 `false`。
  - 新增"一次性迁移清空既有 `true`"用例。
- **e2e** `packages/app/e2e`：
  - 排查所有依赖"默认即新布局"的用例，在 setup 中显式写入 `general.newLayoutDesigns: true`。
  - 新增/确认一个"默认进入旧布局"的用例（现有 `legacy-new-session.spec.ts` 可作参考）。

## 风险与取舍

- e2e 波及面较广（大量用例此前默认新布局），需要逐一排查补显式值，这是本次最大工作量。
- 用户已有的显式 `newLayoutDesigns: true` 会被一次性重置，需用户重新手动开启。已与需求方确认接受。
