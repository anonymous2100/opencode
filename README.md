<p align="center">   <a href="https://opencode.ai">     <picture>       <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">       <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">       <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">     </picture>   </a> </p> <p align="center">开源的 AI Coding Agent。</p> <p align="center">   <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>   <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>   <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a> </p>

<p align="center">

  <a href="README.md">简体中文</a> |

  <a href="README.en.md">English</a> |

  </p>

[!\[OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)\](https://opencode.ai)

---

### 本分支新增内容

> 以下为当前分支相对 `dev` 的改动，其余使用方式与上游 OpenCode 保持一致。

**默认使用旧布局，不再自动切换到新布局**

- 布局只由设置项 `general.newLayoutDesigns` 决定，默认 `false`（旧布局）。
- 移除了到点强制切换的退役时间限制与跨版本升级时的自动切换；首次启动会把既有的 `true` 重置一次。
- 设置中的 **New layout** 开关常驻可见，需要使用新布局时手动开启即可。

**自定义提供商可一键拉取模型列表**

- 在配置自定义（OpenAI 兼容）提供商时可点击「获取模型列表」直接拉取模型，不必再手填模型 ID。
- 服务端新增 `POST /provider/models`：请求 `{baseURL}/models`，当基础 URL 不含版本号时自动回退到 `/v1/models`，并兼容 `data`、`models` 与裸数组三种返回格式。
- API Key 支持 `{env:NAME}` 写法，由服务端读取环境变量后再发起请求；合并结果时以你已经修改过的模型行为准。

**会话提示词锚点**

- 会话右侧新增提示词锚点栏，点击任意锚点即可快速定位到对应的历史提示词。
- 定位复用已有的 hash 滚动逻辑，跳转后 URL 会同步为 `#message-<id>`，可以直接分享定位。
- 当前停留的提示词会高亮，悬停锚点可预览该条提示词内容。

**任务列表可隐藏**

- 输入框上方的任务列表新增隐藏按钮，隐藏后不再占用输入框上方的空间。
- 隐藏期间会出现一个带完成进度的恢复按钮；显示状态按会话分别记忆。

**其他调整**

- 桌面端禁用自动降级更新，避免更新后回退到更低版本。
- 修复 `custom-elements.d.ts` 的类型声明导入。
- 为「默认旧布局」补充 e2e 覆盖，并固定新布局相关的 e2e 用例。

### 安装

```bash
# 直接安装 (YOLO)
curl -fsSL https://opencode.ai/install | bash

# 软件包管理器
npm i -g opencode-ai@latest        # 也可使用 bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS 和 Linux（推荐，始终保持最新）
brew install opencode              # macOS 和 Linux（官方 brew formula，更新频率较低）
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # 任意系统
nix run nixpkgs#opencode           # 或用 github:anomalyco/opencode 获取最新 dev 分支
```

> \[!TIP\]
> 安装前请先移除 0.1.x 之前的旧版本。

### 桌面应用程序 (BETA)

OpenCode 也提供桌面版应用。可直接从 [发布页 (releases page)](https://github.com/anomalyco/opencode/releases) 或 [opencode.ai/download](https://opencode.ai/download) 下载。

| 平台 | 下载文件 |
| --- | --- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg` |
| macOS (Intel) | `opencode-desktop-mac-x64.dmg` |
| Windows | `opencode-desktop-windows-x64.exe` |
| Linux | `.deb`、`.rpm` 或 AppImage |

```bash
# macOS (Homebrew Cask)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### 安装目录

安装脚本按照以下优先级决定安装路径：

1. `$OPENCODE_INSTALL_DIR` - 自定义安装目录
2. `$XDG_BIN_DIR` - 符合 XDG 基础目录规范的路径
3. `$HOME/bin` - 如果存在或可创建的用户二进制目录
4. `$HOME/.opencode/bin` - 默认备用路径

```bash
# 示例
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode 内置两种 Agent，可用 `Tab` 键快速切换：

- **build** - 默认模式，具备完整权限，适合开发工作
- **plan** - 只读模式，适合代码分析与探索
  - 默认拒绝修改文件
  - 运行 bash 命令前会询问
  - 便于探索未知代码库或规划改动

另外还包含一个 **general** 子 Agent，用于复杂搜索和多步任务，内部使用，也可在消息中输入 `@general` 调用。

了解更多 [Agents](https://opencode.ai/docs/agents) 相关信息。

### 文档

更多配置说明请查看我们的 [**官方文档**](https://opencode.ai/docs)。

### 参与贡献

如有兴趣贡献代码，请在提交 PR 前阅读 [贡献指南 (Contributing Docs)](./CONTRIBUTING.md)。

### 基于 OpenCode 进行开发

如果你在项目名中使用了 “opencode”（如 “opencode-dashboard” 或 “opencode-mobile”），请在 README 里注明该项目不是 OpenCode 团队官方开发，且不存在隶属关系。

---

**加入我们的社区** [飞书](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=52ao9352-5623-4fa0-b7dd-3407c392c1af&qr_code=true) | [X.com](https://x.com/opencode)