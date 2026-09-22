# Kimi Computer Use 接入 Pi 可行性调研

> 调研日期：2026-09-22。结论先行：**可以接入**，且不需要 Kimi Code 订阅或任何 Kimi API key。

## 1. Kimi Computer Use 是什么

Kimi Computer Use 是月之暗面随 **Kimi Code CLI** 分发的一个本地桌面操控能力：AI agent 在 macOS 上读取任意 app 的界面（无障碍 AX 树 + 截图），并在后台完成点击、输入、滚动、拖拽，全程不移动用户真实鼠标、不把目标 app 切到前台。

- 官方插件文档（kimi-code 仓库，`docs/en/customization/plugins.md`，"Kimi Computer Use <Badge text=v0.5.4>" 一节）：<https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/plugins.md>
- 能力安装/探测实现（`packages/agent-core-v2/src/app/capability/entries/kimiCu.ts`）：<https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/src/app/capability/entries/kimiCu.ts>
- macOS 官方一键安装：`curl -fsSL https://cdn.kimi.com/kimi-computer-use/latest/setup_macos.sh | bash`

架构（macOS 侧）：

| 组件 | 说明 |
|---|---|
| `kimi-cu` 插件 | Kimi Code 的 capability 层，从 CDN 拉取 `kimi-computer-use/latest/kimi-cu-plugin.zip`（当前 v0.5.11） |
| `KimiCU.app` | 安装到 `/Applications` 的 helper app（bundle id `ai.kimi.cu`，`LSMinimumSystemVersion` 14.0），二进制 `Contents/MacOS/kimi-cu` |
| launchd 服务 | 标签 `ai.kimi.cu.service`，由 `kimi-cu install` 注册；**辅助功能 / 屏幕录制权限由该后台服务持有**，agent 进程本身不需要权限 |
| MCP 服务器 | 内嵌在 app 二进制中：`kimi-cu mcp`（user scope 为 `kimi-cu mcp -s user`），stdio 传输 |

Windows 有对应版本（`kimi-cu-win` 插件 + `setup_windows.ps1`），区别是 Windows 版无法可靠后台注入，可能短暂接管真实键鼠并激活目标窗口。

## 2. 它不是云端 API（关键结论）

- Kimi 开放平台文档（platform.kimi.ai，域名已由 platform.moonshot.ai 301 迁移）的 API reference 中没有任何 computer-use 模型或端点；模型清单只有 kimi-k2.6 / kimi-k3 / kimi-k2.7-code-highspeed / kimi-vision-model 等。
- 对 `KimiCU.app/Contents/MacOS/kimi-cu`（v0.5.11, arm64 Mach-O）做字符串检查：**没有任何 Moonshot API key、登录、账号、订阅相关字符串**；外联地址只有 `cdn.kimi.com`（版本检查）、`gator.volces.com`（埋点）和 `127.0.0.1`（本地 XPC）。
- 即：界面感知（AX 树 + 截图）由 helper 返回给调用方 agent，**推理完全由 agent 侧的模型完成**，Kimi 侧不消耗任何云端 token。

（推断，未实测：MCP 服务器运行时无需账号。依据为上述二进制字符串与官方插件 README / SKILL.md 均未提及登录。）

## 3. 接入面：标准 MCP（stdio）

官方插件 `kimi.plugin.json` 声明的 MCP server 与工具集：

```json
{
  "mcpServers": {
    "mac": {
      "command": "sh",
      "args": ["./bin/kimi-cu-mcp"],
      "enabledTools": ["list_apps","get_app_state","click","type_text","press_key","scroll","set_value","perform_secondary_action","select_text","drag"]
    }
  }
}
```

插件包里的 `bin/kimi-cu-mcp` 只是一个 wrapper：`exec /Applications/KimiCU.app/Contents/MacOS/kimi-cu mcp`。二进制内同样确认了这 10 个工具名。

工作流（官方 SKILL.md）：`list_apps` 定位 → `get_app_state` 取 AX 树 + 截图（树节点 index 供 `click`/`set_value` 等引用；截图像素坐标供 `click`/`scroll`/`drag`）→ 执行 → 重要操作后重新 `get_app_state` 验证。

值得注意：app 会**自动**把自身注册到 hermes（Kimi Code）、gemini、codex、claude 的 user-scope MCP 配置（二进制内可见 `claude mcp add kimi-cu -s user -- ...` 等命令模板），但不会注册 pi，需手动。

## 4. Pi 侧的接入方式

Pi **不内置 MCP**（官方 usage.md："It intentionally does not include built-in MCP, sub-agents..."），通过扩展接入：

- **现成方案（推荐）**：npm 包 `@specode/pi-kimi-cu`（v1.0.0，2026-09-04 发布，"Lightweight Kimi Computer Use installer and MCP setup for Pi"，不依赖 Kimi Code）。一条命令完成 KimiCU.app 安全安装、launchd 服务注册、`pi-mcp-adapter` 安装、MCP 配置与 skill 装配，并提供 `/kimi-cu`（status / setup / mcp）入口。
  ```bash
  pi install npm:@specode/pi-kimi-cu
  ```
  来源：<https://www.npmjs.com/package/@specode/pi-kimi-cu>、<https://github.com/specode/pi-kimi-cu>
- **手动方案**：
  1. `curl -fsSL https://cdn.kimi.com/kimi-computer-use/latest/setup_macos.sh | bash`
  2. 在系统设置 → 隐私与安全性中给 KimiCU 开启「辅助功能」「屏幕录制」（必须用户手动点）
  3. `pi install npm:pi-mcp-adapter`（MCP 适配扩展，读取标准 MCP 配置文件；v2.36.0）
  4. 注册 server，写入 `~/.config/mcp/mcp.json`：
     ```json
     { "mcpServers": { "kimi-cu": { "command": "/Applications/KimiCU.app/Contents/MacOS/kimi-cu", "args": ["mcp", "-s", "user"] } } }
     ```
  5. 重启 Pi。

## 5. 使用前提与注意事项

1. **模型必须支持图像输入**：`get_app_state` 返回截图，驱动 agent 需要 vision 能力。Pi 会对工具返回的图片按模型的 resize 策略编码（见 pi docs/models.md 的 `inputLimits.images.resize`）。可走 Floway 网关选 kimi-k3 / step-1o-turbo-vision 等已接入模型。
2. **权限在服务侧**：排障用 `/Applications/KimiCU.app/Contents/MacOS/kimi-cu service-status` 与 `xpc-ping`（`permissionStatus: accessibility=true screenRecording=true` 为正常）；不要用 `kimi-cu doctor` 在 agent 进程里判断权限，必然显示未授权。
3. **安全守则**（官方 skill）：删除、发送、提交、付款等不可逆操作前必须向用户复述并获确认；不得用 AppleScript/cliclick 等绕过"不抢鼠标、不切前台"的设计约束。
4. **token 成本**：`pi-mcp-adapter` 以单一代理工具 + 按需发现的方式暴露 MCP 工具，server 仅在真正使用时启动，避免工具定义常驻上下文。
5. **系统要求**：macOS 14+（Apple Silicon/Intel 均可，官方插件只声明 platforms: macos）；Windows 版另有单独安装方式。
6. **版本**：截至调研日，插件与 app 均为 v0.5.11；更新在 KimiCU 内执行 `kimi-cu upgrade`。

## 6. 未验证项

- `pi-mcp-adapter` 与 kimi-cu MCP server 的实际连通性（含 `get_app_state` 截图在 Pi 中的落库与视觉模型读取）需实测；上述判断基于官方插件清单、app 二进制、pi 文档与 npm 包元数据，未在真机运行过 MCP 会话。
- 权限申请交互需真机点击系统设置，无法在此环境中完成。

## 参考来源

- kimi-code 仓库（官方）：plugins 文档、kimiCu capability 源码、`kimi-cu-plugin.zip`（kimi.plugin.json / README / SKILL.md / bin/kimi-cu-mcp）、`KimiCU.app.zip` 二进制字符串与 Info.plist
- CDN：`https://cdn.kimi.com/kimi-computer-use/latest/`（setup_macos.sh、kimi-cu-plugin.zip、KimiCU.app.zip、version.json）
- Kimi 平台文档：<https://platform.kimi.ai/docs>（确认无 computer-use 云端 API）
- Pi 文档：docs/usage.md（无内置 MCP）、docs/packages.md（pi install）、docs/models.md（工具返回图片的 resize）
- npm：`pi-mcp-adapter` v2.36.0、`@specode/pi-kimi-cu` v1.0.0
