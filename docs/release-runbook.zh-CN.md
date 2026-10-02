# Floway macOS 发布运行手册

`.github/workflows/release.yaml` 支持手动发布和 `v*` 标签发布，构建 arm64 与 x64 两个安装包，并附带 updater 清单与摘要证据。手动运行默认只生成预览产物。

签名是一个**条件层**：仓库配置了 Apple 凭据时，安装包经 Developer ID 签名并公证；没有凭据时，同一条流水线发布未签名安装包，release notes 自带 Gatekeeper 安装指引。更新包的 minisign 签名与 Apple 无关，两种形态下都有效。之后开通 Apple Developer 账号、补齐 secrets，同一条流水线即升级为签名公证版，无需改代码。

## 一次性配置（仓库 Secrets）

最小可用（无 Apple 账号）：

| Secret | 内容 | 获取方式 |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | updater 签名私钥 | 由维护者用 `tauri signer generate` 生成；公钥已固定在 `apps/desktop/src-tauri/tauri.conf.json` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater 私钥密码 | 生成时若留空则不需要此 secret |

签名公证层（需要 Apple Developer Program 账号）：

| Secret | 内容 | 获取方式 |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | Developer ID Application 证书的 base64 编码 p12 | Keychain Access 导出证书+私钥为 p12，`base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | p12 导出密码 | 导出时设定 |
| `APPLE_SIGNING_IDENTITY` | 签名身份全名 | 形如 `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_ISSUER` | App Store Connect API Issuer UUID | App Store Connect → Users and Access → Integrations |
| `APPLE_API_KEY` | App Store Connect API Key ID | 同上 |
| `APPLE_API_KEY_CONTENT` | `.p8` 私钥内容 | 同上，下载后全文 |

标签与手动正式发布缺 `TAURI_SIGNING_PRIVATE_KEY` 都会在构建前明确失败；`sign=true` 缺完整 Apple 凭据也会失败并指出缺项。

## 发版步骤

1. 在 PR 中同步更新 `apps/desktop/package.json`、`apps/platform-node/package.json`、`apps/web/package.json`、`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/Cargo.toml` 的版本，并更新 Cargo.lock 中 `floway-desktop` 的版本。发布流程只接受一致的正式版本 `X.Y.Z`。为已安装的客户端推送更新时，新版本必须更高。
2. 审定 `docs/releases/X.Y.Z.md` 的版本正文并随版本改动合入 `main`。此文件与源提交、安装指引、摘要证据共同用于 GitHub Release 和应用内更新说明；缺失、空白或过长正文会阻止流水线。
3. 等待目标提交的 Verify 完整通过，记录它的完整 40 位 SHA。工作流会校验源提交属于 `main`、版本一致、目标提交的 Verify 成功、版本高于全部已发布 stable 版本，以及已有同名标签指向同一提交。
4. 在 GitHub Actions → Release → Run workflow 选择 `main`，填写 `version=X.Y.Z`、`commit=<完整 SHA>`，勾选 `publish`。只有要求 Developer ID 签名与公证时才勾选 `sign`；发布始终需要 updater 私钥。也可运行：

   ```sh
   gh workflow run release.yaml --ref main -f publish=true -f version=X.Y.Z -f commit=<完整SHA> -f sign=false
   ```

5. 两个架构分别构建、以 release 模式安装并启动真实应用、完成打包验收，再将 Tauri 的同名更新包原样复制为带版本和架构的文件。汇总产物含 DMG、`.app.tar.gz`、`.sig`、`floway-update.json`、`sha256sums.txt` 和共用正文。
6. 发布前再次校验源提交、Verify 和版本。全部成功后创建指向该 SHA 的 `vX.Y.Z` 标签及 GitHub Release，并标记为 Latest。stable 客户端通过 `releases/latest/download/floway-update.json` 获取更新。

已有标签入口继续可用：经维护者批准源提交后，推送 `git tag vX.Y.Z <完整SHA> && git push floway-one vX.Y.Z`；它执行相同的校验、构建、汇总与发布链路。已存在的 Release 会明确拒绝重复发布。

## 流水线预览

```sh
gh workflow run release.yaml --ref main -f publish=false -f sign=false
```

预览可选择工作分支；省略 `commit` 时使用该次 dispatch 的源提交。有 updater 私钥时，也生成双架构签名更新包、清单和共用说明，保存为 `floway-release` artifact；缺少私钥时只保存两个架构的 DMG。预览不会创建标签、GitHub Release 或修改 Latest。

Apple 凭据完整时，正式发布自动加入签名公证层；`sign=true` 要求全部 Apple 凭据。`publish=false, sign=false` 则保留未做 Developer ID 签名的预览构建。

## 排错

- 公证失败信息在 `Build the installer and updater artifacts` 步骤的日志里（notarytool 原文）。
- 打包验证失败保留错误链；x64 的失败在 `build-x64`（macos-15-intel runner），arm64 在 `build-aarch64`。
