# Floway macOS 发布运行手册

`.github/workflows/release.yaml` 在推送 `v*` 标签时构建、签名、公证并发布 arm64 与 x64 两个安装包。本文件列出发布前必须配置的一次性凭据和发版步骤。

## 一次性配置（仓库 Secrets）

| Secret | 内容 | 获取方式 |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书的 base64 编码 p12 | Keychain Access 导出证书+私钥为 p12，`base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | p12 导出密码 | 导出时设定 |
| `APPLE_SIGNING_IDENTITY` | 签名身份全名 | 形如 `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_ISSUER` | App Store Connect API Issuer UUID | App Store Connect → Users and Access → Integrations |
| `APPLE_API_KEY` | App Store Connect API Key ID | 同上 |
| `APPLE_API_KEY_CONTENT` | `.p8` 私钥内容 | 同上，下载后全文 |
| `TAURI_SIGNING_PRIVATE_KEY` | updater 签名私钥 | 由维护者用 `tauri signer generate` 生成；公钥已固定在 `apps/desktop/src-tauri/tauri.conf.json` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater 私钥密码 | 生成时若留空则不需要此 secret |

缺少任一签名 secret 时，tag 触发的发布会明确失败并指出缺哪一项，不会降级产出未签名的"正式"安装包。

## 发版步骤

1. 确认 `main` 上 verify 全绿。
2. 推送标签：`git tag vX.Y.Z <commit> && git push floway-one vX.Y.Z`。
3. release workflow 对每个架构：构建 → 签名公证 → 以 release 模式跑打包验证（安装、启动、bootstrap、provider 连接、建 key、streaming、WebSocket、重启、更新、卸载）→ 架构失败会阻塞整个发布。
4. 汇总 job 生成 `floway-update.json`（双平台 updater 清单）和 `sha256sums.txt`（摘要证据），创建含源 commit 的 GitHub Release。
5. stable 通道的客户端通过 `releases/latest/download/floway-update.json` 自动获得更新。

## 流水线自测

不带 Apple 凭据验证流水线本身：`gh workflow run release.yaml -f sign=false`。未签名产物只作为 workflow artifacts 保留，不会发布。

## 排错

- 公证失败信息在 `Build, sign, and notarize the installer` 步骤的日志里（notarytool 原文）。
- 打包验证失败保留错误链；x64 的失败在 `build-x64`（macos-15-intel runner），arm64 在 `build-aarch64`。
