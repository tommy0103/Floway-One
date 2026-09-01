# Floway One 产品与技术规格

| 项目 | 内容 |
| --- | --- |
| 状态 | Draft 0.1 |
| 日期 | 2026-09-02 |
| 产品 | Floway One |
| 基础项目 | Floway |
| 首发形态 | 本机桌面应用 |

## 1. 摘要

Floway One 是面向个人开发者的本地 LLM 网关。它将多个订阅账户和 API Provider 汇聚到一个稳定的本机地址，由一个后台进程统一完成鉴权、模型发现、协议转换、模型路由、故障回退、用量统计和请求诊断。

Floway One 的产品形态参考 Clash：后台核心持续提供本地代理能力，桌面应用负责启动、状态展示和配置管理，Web Dashboard 是核心的控制面。用户关闭桌面窗口后，网关可以继续在后台运行；只有明确退出 Floway One 时才停止网关。

Floway One 基于 Floway 二次开发，复用现有 Gateway、Provider、协议转换、SQLite 存储和 Dashboard，不维护第二套网关实现或第二套前端。

## 2. 产品定位

### 2.1 一句话定义

> 所有模型，一个本地入口。

Floway One 为 Codex、Claude Code 等 AI 编程工具提供一个稳定的本地接口。用户只配置一次客户端，之后通过 Floway One 管理 Provider、订阅账户、模型和路由。

### 2.2 目标用户

- 同时使用多个 AI 编程工具的个人开发者。
- 同时拥有 Copilot、ChatGPT、Claude.ai 或其他模型服务的用户。
- 需要在不同 Provider、账户或模型之间切换，但不希望反复修改客户端配置的用户。
- 希望凭据和请求记录留在本机，不依赖第三方托管控制面的用户。

### 2.3 核心价值

- 一个稳定地址：客户端始终连接同一个本机 endpoint。
- 一个控制面：Provider、模型、路由、Key 和诊断统一管理。
- 多个隔离 Key：不同工具、项目和用途使用不同 Key，可独立撤销和统计。
- 本地优先：配置、凭据、用量和请求记录默认只保存在本机。
- 无 Docker：安装桌面应用后即可使用，不要求用户安装 Node.js、pnpm、Docker 或数据库。

## 3. 产品边界

### 3.1 MVP 目标

- 提供可安装的 Floway One 桌面应用。
- 在一个后台进程中运行 Floway Gateway、SQLite 和 Dashboard 静态资源。
- 默认仅监听 `127.0.0.1`。
- 使用稳定且可配置的本机端口，默认端口为 `8788`。
- 固定一个 owner，允许 owner 创建和管理多个 API Key。
- 复用现有 Provider、模型、路由、Playground、监控、备份和 Agent Setup 能力。
- 关闭窗口后继续运行，支持从托盘重新打开和完全退出。
- 支持安全的首次启动和后续自动登录。
- 支持数据备份、恢复和数据库自动迁移。

### 3.2 非目标

- 不支持多租户或团队成员管理。
- 不默认支持局域网、互联网或手机访问。
- 不提供云同步、远程控制或跨设备配置同步。
- 不替代 Floway 的 Cloudflare 和服务器部署形态。
- 不为桌面版重新实现 Gateway、Provider 或协议转换。
- MVP 不追求单文件可执行程序。
- MVP 不承诺移动端应用。

## 4. 产品原则

### 4.1 本机默认安全

网关必须默认绑定 `127.0.0.1`，不得默认监听 `0.0.0.0`。开放局域网不属于 MVP，不能通过隐藏开关或未记录环境变量意外启用。

### 4.2 窗口不是核心

桌面窗口是控制面，后台网关是持续工作的核心。关闭窗口不应导致已配置的 Codex、Claude Code 或其他客户端断开。

### 4.3 一个实现，多种外壳

桌面应用、系统浏览器和未来的 headless 命令行应使用同一个本地运行时。桌面应用不得拥有独立的业务实现。

### 4.4 单租户是后端不变量

隐藏用户管理页面不足以构成单租户。Floway One 必须在服务端拒绝创建、删除或修改额外用户，并保证所有 API Key 都属于唯一 owner。

### 4.5 保持上游可同步

个人版能力应尽量集中在桌面壳和本地运行时中。通用 Gateway 改进优先保持可回馈 Floway 上游，避免在共享模块中散布 Floway One 专用条件。

## 5. 术语

| 术语 | 定义 |
| --- | --- |
| Core | Floway Gateway 的数据面和控制面实现。 |
| Local Runtime | 在本机组合 Core、SQLite、文件存储和 Dashboard 的 Node.js 运行时。 |
| Desktop Shell | 基于 Tauri 2 的窗口、托盘、进程和系统集成层。 |
| Dashboard | 现有 `apps/web` 构建出的静态 React 应用。 |
| Owner | Floway One 中唯一的人类管理者，对应现有 seed admin 用户。 |
| API Key | 提供给 AI 工具或项目的数据面凭据。 |
| Upstream | Copilot、Codex、Claude Code、Custom、Azure 或 Ollama 等上游连接。 |
| Personal Profile | 开启单 owner、本机访问和精简 UI 的显式运行模式。 |

## 6. 总体架构

```text
┌──────────────────────────────────────────────┐
│               Floway One.app                 │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Tauri 2 Desktop Shell                  │  │
│  │ 窗口 / 托盘 / 单实例 / 启停 / 自动升级 │  │
│  └──────────────────┬─────────────────────┘  │
│                     │ 启动并监控               │
│  ┌──────────────────▼─────────────────────┐  │
│  │ Node.js Local Runtime                  │  │
│  │ http://127.0.0.1:8788                  │  │
│  │                                        │  │
│  │ Gateway routes + Dashboard assets      │  │
│  └───────────────┬───────────────┬────────┘  │
│                  │               │           │
│          ┌───────▼──────┐ ┌──────▼────────┐  │
│          │ SQLite       │ │ Local files   │  │
│          │ 配置与状态   │ │ 请求体与缓存 │  │
│          └──────────────┘ └───────────────┘  │
└──────────────────────────────────────────────┘
```

### 6.1 技术选型

| 层 | 选择 | 责任 |
| --- | --- | --- |
| 桌面壳 | Tauri 2 | 窗口、托盘、单实例、开机启动、升级和进程生命周期。 |
| 后台运行时 | Node.js sidecar | 运行现有 Floway Node 平台实现。 |
| HTTP | Hono + `@hono/node-server` | 同端口提供控制面、数据面和 Dashboard。 |
| UI | 现有 React Dashboard | 保持浏览器和桌面应用使用同一构建产物。 |
| 数据库 | `node:sqlite` | 保存配置、账户状态、Key、用量和性能数据。 |
| 文件存储 | 本机应用数据目录 | 保存请求体、缓存和其他大对象。 |

### 6.2 为什么使用 localhost

Dashboard 必须由 Local Runtime 通过 HTTP 提供，Desktop Shell 的 WebView 加载 `http://127.0.0.1:8788`。不得使用 `file://` 或 Tauri 自定义资源协议直接加载 Dashboard。

采用 localhost 可以保留现有 UI 的以下假设：

- `fetch` 和 Hono RPC 使用相对地址。
- Dashboard 与控制面同源。
- `window.location.origin` 是可供客户端使用的 Gateway 地址。
- SSE 和 WebSocket 直接连接当前 origin。
- OAuth、Agent Setup 和 API 文档无需增加桌面专用 URL 转换。

## 7. Local Runtime

### 7.1 组合接口

本地运行时应提供一个小型组合接口，其内部隐藏静态资源、路由分流、数据库迁移和进程初始化细节：

```ts
interface LocalAppOptions {
  gatewayFetch: typeof app.fetch;
  assetsDir: string;
  profile: 'personal';
}

createLocalApp(options: LocalAppOptions): {
  fetch: typeof app.fetch;
}
```

具体命名可在实现时调整，但调用者不应负责逐条注册静态文件或 Gateway 路径。

### 7.2 HTTP 路由

Local Runtime 在同一端口处理两类请求：

| 请求 | 处理方式 |
| --- | --- |
| `/api/*`、`/auth/*` | 交给 Floway 控制面。 |
| `/v1/*`、`/v2/*`、`/v1beta/*` 等数据面路径 | 交给 Floway 数据面。 |
| `/assets/*` | 返回 Dashboard 构建资源。 |
| `/dashboard`、`/dashboard/*` | 返回 Dashboard 的 `index.html`。 |
| `/` | 返回 Dashboard 的 `index.html`。 |
| 未知静态资源 | 返回真实 404，不得错误返回 `index.html`。 |

Gateway 路径的判定必须有一个权威来源。新增 Local Runtime 后，不应再增加一份无法验证的手写路径列表；现有 Cloudflare、Vite 和 nginx 的路径一致性检查应扩展到本地运行时。

### 7.3 静态资源策略

- 带内容哈希的 `/assets/*` 使用长期 immutable 缓存。
- `index.html` 不使用长期缓存。
- 正确设置 JavaScript、CSS、字体、SVG、JSON 和 sourcemap 的 MIME 类型。
- SPA fallback 仅服务已知的 Dashboard 导航路径。
- Dashboard 构建产物作为发行资源打包，不在用户机器上执行前端构建。

### 7.4 端口策略

- 默认端口为 `8788`。
- endpoint 必须稳定，因为 AI 客户端会持久化该地址。
- 端口被占用时必须启动失败并显示明确诊断，不得静默选择随机端口。
- 用户可在设置中修改端口；修改前应警告现有客户端配置需要更新。
- 修改端口后由 Desktop Shell 重启 Local Runtime。

### 7.5 数据目录

数据不得写入应用安装目录或当前工作目录。应使用操作系统标准应用数据目录：

| 平台 | 预期位置 |
| --- | --- |
| macOS | `~/Library/Application Support/Floway One/` |
| Windows | `%APPDATA%\Floway One\` |
| Linux | `$XDG_DATA_HOME/floway-one/`，未设置时使用 `~/.local/share/floway-one/`。 |

目录中至少包括：

```text
Floway One/
├── floway.db
├── files/
├── logs/
└── runtime.json
```

## 8. Desktop Shell

### 8.1 责任范围

Desktop Shell 只负责操作系统集成：

- 保证应用单实例运行。
- 启动、监控和停止 Node.js sidecar。
- 等待 `/api/health` 就绪后再显示 Dashboard。
- 创建和恢复窗口。
- 提供托盘菜单。
- 管理开机启动。
- 显示启动失败、端口冲突和迁移失败。
- 管理应用更新。
- 将外部链接交给系统浏览器。

Desktop Shell 不实现 Provider、路由、Key、用量或配置业务。

### 8.2 窗口与托盘行为

- 启动应用时显示主窗口。
- 关闭主窗口时隐藏窗口，Gateway 继续运行。
- 点击托盘图标或“打开 Floway One”恢复窗口。
- 点击“退出 Floway One”时优雅停止 sidecar，再退出桌面进程。
- sidecar 异常退出时，托盘显示错误状态并提供查看日志和重启操作。
- 操作系统关机或用户注销时尽力优雅停止，不阻塞系统退出。

正常关闭窗口只隐藏窗口，Desktop Shell 和 sidecar 都继续运行。Desktop Shell 正常退出或异常崩溃时，sidecar 必须随 owner 进程一起终止；MVP 不接管上一次壳进程遗留的 sidecar。各平台应使用可强制验证的 owner-lifetime 机制，例如 Windows Job Object、Linux parent-death signal，以及 macOS 的父进程监测或生命周期管道，而不是假设子进程会自动退出。

### 8.3 托盘菜单

MVP 托盘菜单包含：

- 打开 Floway One
- Gateway 状态与地址
- 复制 Gateway 地址
- 重启 Gateway
- 开机启动
- 打开日志目录
- 退出 Floway One

### 8.4 Sidecar 发行

发行包包含与目标平台和架构匹配的 Node.js runtime、编译后的 Gateway、生产依赖、数据库 migrations 和 Dashboard 静态资源。

MVP 不要求把所有资源压缩成一个二进制文件。`sharp` 等原生依赖必须随目标平台单独构建和验证，不能依赖用户机器现场编译。

首个公开 macOS 版本同时发布 arm64 和 x64 两个独立安装包，不制作 universal binary。两个架构使用相同版本号和功能集合，并在各自的原生 runner 上完成 sidecar、`sharp`、签名和安装验证。

## 9. 单租户多 Key 模型

### 9.1 数据模型

Floway One 保留 Floway 现有 `users`、`sessions` 和 `api_keys.user_id` 结构，以降低与上游同步的冲突。

Personal Profile 下应用以下不变量：

- 唯一 owner 的 ID 固定为 seed admin 用户 ID `1`。
- 不允许创建第二个用户。
- 不允许删除或降级 owner。
- 所有 API Key 的 `user_id` 必须为 `1`。
- owner 的 upstream 范围为全部 Upstream。
- 每个 API Key 可以继承全部 Upstream，或保存独立的 Upstream 白名单和优先级。

### 9.2 多 Key 使用场景

- 为 Codex 和 Claude Code 分别创建 Key。
- 为不同项目创建 Key，以便独立统计和撤销。
- 为测试环境创建短期 Key。
- 为某个客户端限制可访问的 Upstream。
- 在不影响其他客户端的情况下轮换单个 Key。

### 9.3 Key 能力

现有能力应全部保留：

- 创建、编辑、删除和轮换。
- 自动生成或使用自定义 Key。
- 设置 Upstream 白名单及顺序。
- 设置请求记录保留期。
- 设置 Stateful OpenAI Responses 保留期。
- 查看最后使用时间。
- 查看按 Key 聚合的请求、用量和性能。
- 生成 Codex 和 Claude Code 的 Agent Setup。

### 9.4 用户相关接口

Personal Profile 下，用户管理接口必须在服务端拒绝以下操作：

- 创建用户。
- 删除用户。
- 修改 owner 的管理员状态。
- 为 owner 配置用户级 Upstream 限制。

对不适用于 Personal Profile 的接口，应返回稳定、可测试的错误，而不是执行后再由 UI 隐藏结果。

## 10. Runtime Profile

### 10.1 显式 Profile

Node 运行时不等同于个人版。服务器也可能运行 Node，因此不得通过 `runtime.kind === 'node'` 推断产品模式。

运行时应显式初始化并向控制面暴露 Profile：

```ts
interface RuntimeProfile {
  mode: 'personal' | 'server';
  capabilities: {
    userManagement: boolean;
    remoteAccess: boolean;
    desktopIntegration: boolean;
  };
}
```

具体字段可随实现调整，但 UI 必须读取后端声明的 capability，不得根据 hostname、端口或 Node 类型猜测。

### 10.2 后端优先

Capability 同时用于：

- 后端执行产品不变量。
- Dashboard 决定显示哪些导航和筛选项。
- 备份导入验证目标运行模式。
- 诊断页面展示当前运行方式。

UI 隐藏是体验优化，后端拒绝才是安全和数据一致性保证。

## 11. Dashboard 复用

### 11.1 直接复用

以下现有页面和交互应直接复用：

| 功能 | 处理方式 |
| --- | --- |
| Playground | 原样复用。 |
| Upstream 管理 | 原样复用。 |
| Web Search | 原样复用。 |
| Proxy | 原样复用。 |
| Model Alias | 原样复用。 |
| API Keys | 原样复用多 Key 能力。 |
| Agent Setup | 原样复用。 |
| API 文档 | 原样复用，并显示当前本机 origin。 |
| 请求记录 | 原样复用。 |
| 用量与性能 | 复用主体，仅隐藏用户维度。 |
| 备份与恢复 | 复用界面，增加 Personal Profile 校验。 |
| 外观和语言设置 | 原样复用。 |

### 11.2 Personal Profile 调整

- 隐藏 Users 导航和页面。
- 隐藏监控中的“按用户”分组和用户筛选。
- 账户区域显示“本机 Owner”，不强调多人账户概念。
- 首页增加本机运行概览，而不是默认把 Playground 当作状态页。
- 首次启动进入引导流程。
- 设置页增加端口、开机启动、数据目录、版本和日志入口。
- Dashboard 展示 sidecar 断开、迁移失败或版本不匹配等桌面运行时错误。

### 11.3 首次启动引导

首次启动按以下顺序完成激活：

1. 确认本机 Gateway 已启动。
2. 选择并连接第一个 Upstream。
3. 获取并确认可用模型。
4. 创建第一个 API Key。
5. 选择 Codex 或 Claude Code，生成 Agent Setup。
6. 发起一次测试请求。
7. 成功后进入运行概览。

用户可以跳过具体 Provider，但未配置 Upstream 时，界面必须明确显示下一步，而不是展示空白监控图表。

### 11.4 运行概览

概览页至少显示：

- Gateway 运行状态。
- 本机 endpoint 和复制操作。
- 当前版本。
- Upstream 总数和异常数量。
- API Key 总数及最近使用状态。
- 最近请求成功或失败状态。
- 打开日志和诊断入口。

概览页不替代现有详细监控页面。

## 12. 身份验证与安全

### 12.1 网络范围

- 默认仅监听 IPv4 loopback `127.0.0.1`。
- MVP 不提供 `0.0.0.0`、局域网或公网监听配置。
- 健康检查、Dashboard、控制面和数据面均走同一 loopback origin。
- 不得因为端口冲突回退到外部网卡。

### 12.2 Dashboard 登录

不得在 Personal Profile 中复用“无 `ADMIN_KEY` 即免密登录”的开发模式。该模式与宽松 CORS 组合时不能作为桌面产品的安全模型。

推荐流程：

1. Desktop Shell 启动时生成一次性 bootstrap token。
2. Token 通过 URL fragment 或受保护的本机进程通信交给 Dashboard，不进入 HTTP access log。
3. Dashboard 使用 token 换取普通 Floway session。
4. 服务端立即销毁 bootstrap token。
5. Dashboard 清除 URL fragment。
6. 后续控制面请求继续使用现有 session header。

控制面 CORS 应限制为当前本机 Dashboard origin。数据面是否允许浏览器跨源调用应与控制面策略分离。

### 12.3 API Key

- API Key 只用于数据面，不得作为 Dashboard 管理凭据。
- Desktop Shell 不读取或缓存用户创建的 API Key。
- Key 删除和轮换应立即影响新请求及现有长连接的后续逻辑请求。

### 12.4 本地凭据

Floway One 会保存订阅 OAuth token 和 Provider API Key。凭据静态存储采用字段级加密与系统凭据存储结合的方案：

- 数据目录和敏感文件使用仅当前用户可读写的权限。
- 每台设备生成独立的 256-bit 主密钥。
- 主密钥保存到 macOS Keychain、Windows Credential Manager 或 Linux Secret Service，不与 SQLite 放在同一目录。
- SQLite 中的 Provider OAuth token、Provider API Key 和其他可恢复明文凭据使用主密钥执行带认证的字段级加密。
- 加密记录携带格式版本、随机 nonce 和认证信息，以支持后续密钥轮换与算法迁移。
- 系统凭据存储不可用时默认启动失败并给出明确错误；是否为无 Secret Service 的 Linux 环境提供受限 key-file fallback，留到 Linux 发行阶段决定。
- 日志、崩溃报告和导出文件不得意外包含明文凭据。
- 不得把主密钥直接写入普通备份。

Clash Verge Rev 已使用 AES-256-GCM 加密部分配置，但其加密 key 与应用配置位于同一目录。Floway One 保存的是可长期使用的订阅凭据，因此只借鉴字段加密方式，不沿用同目录 key-file 作为桌面正式版的正常路径。

### 12.5 WebView

- WebView 只允许导航到 Floway One 的 loopback origin。
- OAuth 和文档等外部链接使用系统浏览器打开。
- 禁止任意远程页面获得 Tauri IPC 权限。
- Tauri command 使用最小 allowlist，不向 Dashboard 暴露通用 shell 执行能力。

## 13. 进程与故障行为

### 13.1 启动顺序

1. Desktop Shell 获取单实例锁。
2. 解析并创建应用数据目录。
3. 检查默认端口是否可用。
4. 启动 Node.js sidecar。
5. Local Runtime 打开 SQLite 并执行 migrations。
6. Local Runtime 启动 HTTP listener。
7. Desktop Shell 轮询 `/api/health`。
8. 健康检查成功后加载主窗口。

### 13.2 启动失败

以下失败必须显示原始错误或错误链，并提供恢复建议：

- 数据目录不可写。
- SQLite 无法打开。
- migration 失败。
- 端口被占用。
- Dashboard 资源缺失。
- sidecar 架构或原生依赖不匹配。
- Gateway 未在规定时间内健康。

应用不得用空白窗口、无限 loading 或自动更换数据目录掩盖错误。

### 13.3 日志

- sidecar 的 stdout 和 stderr 写入轮转日志。
- Desktop Shell 保留自身生命周期日志。
- 日志默认存放在应用数据目录。
- 设置和托盘菜单提供“打开日志目录”。
- 日志保留策略应有上限，避免长期运行无限增长。
- 日志输出沿用 Floway 的错误链和 stack trace，不得只显示通用错误文案。

## 14. 数据迁移、备份与升级

### 14.1 数据库迁移

- Local Runtime 每次启动自动应用待执行 migration。
- migration 失败时停止启动，不得继续运行部分升级后的数据库。
- 应保留现有逐 migration 事务语义。
- 正式自动升级前应创建可恢复的数据库备份。

### 14.2 备份与恢复

- 复用现有 Floway 数据导出和导入格式。
- Personal Profile 导出保留 owner、Key、Upstream、路由和统计数据。
- 导入包含多个用户的数据时必须明确拒绝，或提供经用户确认的单 owner 归一化流程；MVP 选择明确拒绝。
- 导入不得静默丢弃其他用户或重写 Key 所有权。
- 恢复完成后应验证单 owner 不变量。

Floway One 提供两种明确区分的导出：

| 导出类型 | 默认 | 内容 | 保护方式 |
| --- | --- | --- | --- |
| 完整备份 | 是 | 包含恢复现有客户端所需的 Provider 凭据、API Key、配置和状态。 | 用户提供备份密码，使用内存困难 KDF 派生独立备份密钥，再对完整归档执行带认证加密。 |
| 安全导出 | 否 | 保留非敏感配置结构，移除 Provider 凭据、API Key 明文、session 和服务器私密材料。 | 可输出明文，适合诊断、分享和 Issue 附件。 |

完整备份不得默认产生明文文件，备份密码不得保存到数据库或系统凭据存储。自动升级前创建的同机恢复点可以使用设备主密钥保护，因为它不承担跨设备迁移职责。

### 14.3 应用升级

- Desktop Shell、Node sidecar、Gateway、migrations 和 Dashboard 必须作为一个版本整体发布。
- 不允许桌面壳与 sidecar 独立升级到不兼容版本。
- 默认使用 GitHub Releases 的 stable channel，预发布版本通过用户显式选择的 preview channel 提供。
- 使用 Tauri updater 生成并校验签名更新清单和安装包；Tauri updater 签名与操作系统代码签名分别管理。
- macOS 安装包使用 Developer ID 签名并完成 notarization。
- 应用在后台检查和下载完整更新，下一次启动前提示用户安装，不在运行中的 LLM 请求期间替换文件。
- 安装更新前创建受设备主密钥保护的数据库恢复点。
- MVP 不承诺应用二进制自动回滚；更新后健康检查失败时进入恢复界面，保留数据库恢复点、完整错误和上一版本下载入口。
- 数据库 migration 失败时不得标记新版本健康，也不得覆盖升级前恢复点。

## 15. 发行策略

### 15.1 阶段一：本地运行时验证

- Node 单进程提供 Gateway 和 Dashboard。
- 使用标准应用数据目录。
- 固定 loopback 地址和稳定端口。
- 提供开发用启动命令并完成真实 Provider 请求验证。

### 15.2 阶段二：macOS 桌面 MVP

- Tauri 2 桌面壳。
- macOS arm64 和 x64 同时发布独立安装包。
- 托盘、单实例、关闭隐藏和完全退出。
- sidecar 打包、签名和基础更新机制。
- Personal Profile 和单 owner 强制。
- 首次启动引导。

### 15.3 阶段三：跨平台

- Windows x64。
- macOS x64 完整支持。
- Linux 主流 x64 发行包。
- 开机启动和系统凭据存储的跨平台适配。

### 15.4 阶段四：体验完善

- 自动诊断和修复建议。
- 更完整的升级回滚。
- headless daemon 和命令行控制。
- 经明确产品决策后评估局域网模式；该能力不默认开启。

## 16. MVP 功能需求

| ID | 需求 |
| --- | --- |
| FO-RUN-001 | 应用必须在不依赖用户安装 Docker、Node.js 或 pnpm 的情况下启动。 |
| FO-RUN-002 | Gateway 必须只监听 `127.0.0.1`。 |
| FO-RUN-003 | 默认 endpoint 必须为 `http://127.0.0.1:8788`。 |
| FO-RUN-004 | 端口冲突必须阻止启动并显示占用诊断。 |
| FO-RUN-005 | 应用必须使用操作系统标准应用数据目录。 |
| FO-RUN-006 | Dashboard 和 Gateway 必须由同一个 origin 提供。 |
| FO-RUN-007 | 应用启动时必须自动执行数据库 migration。 |
| FO-DESK-001 | Desktop Shell 必须保证单实例。 |
| FO-DESK-002 | 关闭窗口后 Gateway 必须继续运行。 |
| FO-DESK-003 | 用户必须能从托盘重新打开窗口。 |
| FO-DESK-004 | 完全退出必须优雅停止 sidecar。 |
| FO-DESK-005 | sidecar 异常退出必须在桌面壳中可见。 |
| FO-DESK-006 | Desktop Shell 正常退出或异常崩溃后不得遗留无人管理的 sidecar。 |
| FO-TENANT-001 | Personal Profile 必须只允许 seed owner 存在。 |
| FO-TENANT-002 | 服务端必须拒绝创建、删除或降级 owner。 |
| FO-TENANT-003 | 所有新 API Key 必须归属于 owner。 |
| FO-KEY-001 | owner 必须能创建多个 API Key。 |
| FO-KEY-002 | 每个 Key 必须能够独立轮换和撤销。 |
| FO-KEY-003 | 每个 Key 必须能够独立限制 Upstream。 |
| FO-KEY-004 | 请求、用量和性能必须能够按 Key 查看。 |
| FO-UI-001 | 现有 Dashboard 必须作为唯一 UI 实现复用。 |
| FO-UI-002 | Personal Profile 必须隐藏 Users 页面和用户分析维度。 |
| FO-UI-003 | 首次启动必须引导用户完成 Upstream、Key 和 Agent Setup。 |
| FO-UI-004 | UI 必须显示 Gateway 状态、地址、版本和错误。 |
| FO-SEC-001 | Personal Profile 不得允许开发模式免密登录。 |
| FO-SEC-002 | Dashboard 自动登录必须使用短期、单次凭据。 |
| FO-SEC-003 | 控制面 CORS 必须限制为本机 Dashboard origin。 |
| FO-SEC-004 | WebView 不得向远程页面暴露 Tauri IPC。 |
| FO-DATA-001 | 重启应用后 Upstream、Key 和设置必须完整保留。 |
| FO-DATA-002 | Personal Profile 必须拒绝不符合单 owner 不变量的备份导入。 |
| FO-DATA-003 | migration 或存储失败必须阻止服务进入伪健康状态。 |
| FO-BACKUP-001 | 默认完整备份必须包含恢复所需凭据并使用独立备份密码加密。 |
| FO-BACKUP-002 | 安全导出必须移除所有可直接使用的凭据和 session。 |
| FO-UPDATE-001 | stable 更新必须通过 Tauri updater 签名及目标平台代码签名验证。 |
| FO-UPDATE-002 | 更新前必须创建受保护的数据库恢复点。 |

## 17. 非功能需求

### 17.1 可靠性

- Dashboard 窗口重载不得影响 Gateway 中正在执行的数据面请求。
- Desktop Shell 崩溃不应损坏 SQLite；sidecar 生命周期策略需在实现前明确。
- 删除或轮换 Key 后，新的逻辑请求必须立即使用最新状态。
- 所有内部失败保留原始错误或错误链。

### 17.2 性能

- Dashboard 静态资源必须使用生产构建。
- Gateway 不经过 WebView 或 Tauri IPC 转发数据面请求。
- 桌面壳不得代理 LLM streaming body。
- SSE 和 WebSocket 由客户端直接连接 Local Runtime。
- 应在首个发行候选版本上测量启动耗时、空闲内存和安装体积，再确定公开性能目标。

### 17.3 可维护性

- Personal Profile 条件集中在运行时 capability 和对应的服务端策略中。
- UI 不根据平台、hostname 或构建目标散布个人版判断。
- Dashboard 静态路由与 Gateway 路径必须由测试防止漂移。
- 新增桌面 workspace 后同步更新 `AGENTS.md` 的完整 Index。
- 新增验证器时通过根脚本接入 `verify`，并保持 CI parity。

## 18. 验收标准

MVP 只有同时满足以下条件才可称为可用：

1. 一台没有 Docker、Node.js 和 pnpm 的受支持机器能够安装并启动 Floway One。
2. 首次启动自动创建数据目录、数据库和唯一 owner，不需要执行终端命令。
3. Dashboard 在应用窗口中正常加载，并与 Gateway 使用同一 origin。
4. 用户能够连接至少一个现有 Floway Upstream，并成功获取模型。
5. 用户能够创建两个以上 API Key，并分别用于两个客户端。
6. 单个 Key 的轮换或删除不会影响其他 Key。
7. 用户能够为不同 Key 设置不同 Upstream 范围，并观察到路由限制生效。
8. 关闭桌面窗口后，已配置客户端仍能继续请求 Gateway。
9. 从托盘退出后，Gateway 停止接受新请求。
10. 重启应用后，配置、Key 和 Upstream 状态保持不变。
11. 端口被占用、migration 失败和 sidecar 崩溃均产生明确可操作的错误。
12. Users 管理接口和页面在 Personal Profile 下不可用。
13. 外部网页无法通过免密登录获得本机控制面 session。
14. 备份恢复后仍满足唯一 owner 和 Key 所有权不变量。
15. 生产发行包在目标系统上通过真实安装、启动、Provider 登录、streaming 请求、WebSocket 和卸载验证。
16. macOS arm64 和 x64 安装包均通过相同的端到端验收。
17. 强制终止 Desktop Shell 后，owner-lifetime 机制能够终止 sidecar；重新启动不会遇到自身遗留的端口占用。
18. 完整备份不能在没有密码的情况下读取，安全导出中不存在可直接使用的 Provider、API Key 或 session 凭据。
19. 更新包签名错误、更新后健康检查失败和 migration 失败均不会删除升级前恢复点。

## 19. 测试策略

### 19.1 Local Runtime

- Gateway 路径与静态路径分流测试。
- SPA fallback 和未知资源 404 测试。
- 静态资源 MIME 和缓存策略测试。
- loopback 绑定测试。
- 端口冲突失败测试。
- 数据目录和 migration 集成测试。

### 19.2 Personal Profile

- 唯一 owner 不变量测试。
- 用户管理拒绝测试。
- 多 Key 创建、轮换、删除和隔离测试。
- Key Upstream 范围测试。
- 多用户备份导入拒绝测试。
- Runtime Profile capability 序列化测试。
- 敏感字段落盘密文与主密钥缺失失败测试。
- 完整备份密码验证、篡改拒绝和安全导出脱敏测试。

### 19.3 Dashboard

- Personal Profile 导航测试。
- 用户维度隐藏测试。
- 首次启动引导测试。
- Gateway 状态和错误状态测试。
- 同一 Dashboard 构建在系统浏览器与 Tauri WebView 中的行为测试。

### 19.4 Desktop Shell

- 单实例测试。
- sidecar 启停和异常退出测试。
- Desktop Shell 被强制终止后的 sidecar 清理测试。
- 关闭窗口继续运行测试。
- 托盘恢复与完全退出测试。
- 外部链接隔离测试。
- 安装包 smoke test。

### 19.5 发行验证

- 每个平台在干净环境安装。
- macOS arm64 与 x64 分别在原生架构完成安装和端到端请求验证。
- 验证不依赖系统 Node.js 或编译工具链。
- 验证原生依赖与 CPU 架构匹配。
- 验证应用签名和升级包校验。
- 验证错误签名、损坏更新包和更新后健康检查失败路径。
- 验证升级前备份和失败回滚。

## 20. 上游同步策略

Floway One 应保持以下代码组织原则：

- 通用协议、Provider 和 Gateway 修复尽量保持与 Floway 上游一致。
- 桌面能力集中在新的 Desktop Shell 和 Local Runtime 组合层。
- Personal Profile 通过显式接口进入 Gateway，不在业务调用点散布环境变量判断。
- 定期将 Floway 上游 `main` 合并到 Floway One 工作分支，再通过正常验证进入 Floway One `main`。
- 能独立成立的通用修复优先向 Floway 上游贡献，减少永久差异。
- Floway One 的品牌、安装器、桌面生命周期和单租户体验保留在二开仓库。

## 21. 风险

| 风险 | 影响 | 缓解方向 |
| --- | --- | --- |
| 上游 OAuth 或协议变化 | Provider 登录或请求突然失效。 | 保持自动升级、兼容性测试和快速发行能力。 |
| 订阅服务使用条款变化 | 某些订阅连接方式不可持续。 | 清晰定位为本地控制面，持续审查 Provider 接入方式。 |
| Node sidecar 和原生依赖打包 | 不同系统或架构启动失败。 | 按平台构建发行物，在干净系统执行安装测试。 |
| 本地凭据明文落盘 | 订阅 token 或 API Key 泄露。 | 引入系统凭据存储或静态加密，限制文件权限。 |
| 端口被其他应用占用 | 客户端持久化 endpoint 失效。 | 明确失败、提供诊断和显式迁移流程。 |
| 个人版条件散布 | 上游同步困难、行为逐渐分叉。 | 使用 Runtime Profile 和集中策略模块。 |
| Tauri 壳与 sidecar 版本错配 | UI、数据库和 Gateway 不兼容。 | 作为单一版本整体发布和回滚。 |

## 22. Clash 对标决策

本节以 Clash Verge Rev 的桌面壳与 Mihomo core 组合为参照。Floway One 借鉴其“桌面壳管理独立 core”的产品结构，但根据 LLM 客户端持久化 endpoint、Provider token 价值更高、请求正文更敏感等差异调整实现。

| 议题 | Clash Verge Rev 观察 | Floway One 决策 |
| --- | --- | --- |
| macOS 架构 | 官方发布分别构建 Apple Silicon 和 Intel 安装包。 | 首个公开版本同时发布 arm64 与 x64 独立安装包。 |
| 凭据存储 | 对 WebDAV 字段使用 AES-256-GCM，但加密 key 保存在应用目录。 | 使用字段级带认证加密，主密钥由系统凭据存储保护，不在普通配置目录放置主密钥。 |
| 窗口关闭 | CloseRequested 被拦截并隐藏窗口，core 和壳继续运行。 | 相同行为；窗口关闭不停止 Gateway。 |
| 壳进程退出 | 正常退出执行 core cleanup；另有系统 service 模式。 | MVP 不安装系统 service；壳正常退出或崩溃时由 owner-lifetime 机制清理 sidecar。 |
| 自动升级 | GitHub Releases、Tauri updater 签名、平台代码签名，后台下载并延后安装。 | 采用相同主干方案，增加升级前数据库恢复点；MVP 健康失败进入恢复界面，不承诺自动二进制回滚。 |
| Headless CLI | Mihomo core 作为独立 externalBin 随桌面应用发行，桌面产品仍以 GUI 管理为主。 | 内部 sidecar 保持可独立启动，但 headless CLI 不属于 MVP；桌面稳定后再定义受支持的 `serve/status/open` 接口。 |
| 端口 | 代理端口可配置，冲突时可以为当前会话选择临时端口。 | 默认 `8788`，允许在高级设置中显式修改；冲突时失败并诊断，绝不自动漂移。 |
| 请求记录 | 连接和日志主要服务实时诊断，用户配置备份独立处理。 | 聚合用量和性能默认开启，请求正文记录默认关闭，由每个 API Key 显式开启并选择保留期。 |
| 备份 | 备份移除 WebDAV 凭据，但配置和 profiles 仍可能包含连接凭据。 | 默认提供密码加密的完整备份，同时提供不含任何可用凭据的安全导出。 |

### 22.1 已确定的产品默认值

- macOS 首发同时支持 arm64 与 x64。
- 凭据采用字段级加密与系统凭据存储结合。
- sidecar 不在 Desktop Shell 崩溃后继续成为孤儿进程。
- stable channel 使用 GitHub Releases 与 Tauri updater 签名更新。
- headless CLI 不属于 MVP。
- 端口默认 `8788`，可以显式修改，不自动 fallback。
- 聚合统计默认开启，请求正文记录默认关闭。
- 完整备份默认加密，安全导出默认脱敏。

### 22.2 参考实现

以下事实核对自 Clash Verge Rev 官方仓库固定提交 `f5cc24ec9fc7c6f025ecbd5b1952c27b3facc17a`：

- [Tauri 配置、externalBin 与 updater 签名](https://github.com/clash-verge-rev/clash-verge-rev/blob/f5cc24ec9fc7c6f025ecbd5b1952c27b3facc17a/src-tauri/tauri.conf.json)
- [macOS arm64/x64 构建、Apple 签名与 updater 产物](https://github.com/clash-verge-rev/clash-verge-rev/blob/f5cc24ec9fc7c6f025ecbd5b1952c27b3facc17a/.github/workflows/release.yml)
- [窗口关闭隐藏与应用退出清理](https://github.com/clash-verge-rev/clash-verge-rev/blob/f5cc24ec9fc7c6f025ecbd5b1952c27b3facc17a/src-tauri/src/lib.rs)
- [core 生命周期管理](https://github.com/clash-verge-rev/clash-verge-rev/blob/f5cc24ec9fc7c6f025ecbd5b1952c27b3facc17a/src-tauri/src/core/manager/lifecycle.rs)
- [端口冲突的会话级 fallback](https://github.com/clash-verge-rev/clash-verge-rev/blob/f5cc24ec9fc7c6f025ecbd5b1952c27b3facc17a/src-tauri/src/config/port.rs)
- [AES-256-GCM 字段加密](https://github.com/clash-verge-rev/clash-verge-rev/blob/f5cc24ec9fc7c6f025ecbd5b1952c27b3facc17a/src-tauri/src/config/encrypt.rs)
- [同目录加密 key 的生成与读取](https://github.com/clash-verge-rev/clash-verge-rev/blob/f5cc24ec9fc7c6f025ecbd5b1952c27b3facc17a/src-tauri/src/utils/dirs.rs)
- [备份内容与 WebDAV 凭据移除](https://github.com/clash-verge-rev/clash-verge-rev/blob/f5cc24ec9fc7c6f025ecbd5b1952c27b3facc17a/src-tauri/src/core/backup.rs)
- [后台下载与下次启动安装更新](https://github.com/clash-verge-rev/clash-verge-rev/blob/f5cc24ec9fc7c6f025ecbd5b1952c27b3facc17a/src-tauri/src/core/updater.rs)

## 23. 成功判断

Floway One 的核心成功指标不是安装量，而是用户是否停止反复修改各个 AI 工具的 Provider、模型和 endpoint 配置。

首轮验证应重点观察：

- 从安装到第一次成功请求是否顺畅。
- 用户是否愿意让 Gateway 持续在后台运行。
- 用户是否实际创建多个 Key，并按工具或项目使用。
- 用户是否在多个 Upstream 之间切换而无需修改客户端。
- 上游变化发生后，自动升级能否在用户介入前恢复兼容性。
- 用户是否信任 Floway One 保存本地订阅凭据。
