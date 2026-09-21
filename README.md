# Floway One

All models, one local entry.

Floway One is a personal, local-first LLM gateway for people who use multiple
AI coding tools. It puts subscription-backed and token-backed model providers
behind one stable loopback address, then routes each model through the API
shape the client already speaks — like Clash, but for AI model traffic.

Floway One is a personal-product fork of [Floway](https://github.com/Menci/Floway).
It keeps the full gateway, protocol translation, provider integrations, and
Dashboard, and packages them as an installable desktop application that runs
entirely on your machine. No Docker, Node.js, or database to install; no
account or cloud control plane to trust. The product and technical
specification lives in [docs/floway-one-spec.zh-CN.md](./docs/floway-one-spec.zh-CN.md).

## Highlights

- One stable address: every client always talks to `http://127.0.0.1:8788`.
  Configure Codex, Claude Code, and other tools once; switch providers, models,
  and routing afterwards without touching client configuration.
- Use GitHub Copilot, ChatGPT subscriptions, Claude.ai subscriptions, Azure AI,
  configurable multi-protocol HTTP providers, and Ollama from one app.
- Serve OpenAI, Anthropic, Gemini-compatible, audio transcription, and rerank
  APIs with cross-protocol translation where needed.
- One owner, many API keys: give each tool, project, or use case its own
  revocable key with per-key upstream scope, usage statistics, and request
  history.
- Local-first: configuration, credentials (encrypted at rest), usage, and
  request records stay in the operating system's per-user application-data
  directory.
- Desktop shell with tray lifecycle: closing the window keeps the gateway
  running; only an explicit quit stops it.
- Encrypted full backups and credential-free safe exports.
- Generate one-command Claude Code and Codex configurations from an API key.

## Quick Start

Signed desktop installers are on the roadmap; today Floway One runs from
source. Requires Node.js 24 and pnpm 10:

```bash
git clone https://github.com/tommy0103/Floway-One.git
cd Floway-One
pnpm install
ADMIN_KEY='replace-with-a-secret' pnpm run dev:one
```

Open <http://127.0.0.1:8788> and sign in with your `ADMIN_KEY`. Then:

1. Add at least one provider under **Providers → Upstreams**.
2. Create a key under **Services → API Keys**.
3. Give that key to a client as a bearer token or `x-api-key`, or use **Agent
   Setup** to configure Claude Code or Codex.

The personal profile binds only to `http://127.0.0.1:8788` and stores its
database, files, logs directory, and `runtime.json` below the operating
system's per-user application-data directory. Set `PORT` when deliberately
moving the personal endpoint; the selected port is persisted in `runtime.json`,
and startup warns that configured AI clients must be updated. A port conflict
or inaccessible application-data directory stops startup rather than selecting
a fallback. Personal stdout and stderr are retained in size-bounded rotating
files under the application-data logs directory.

The desktop executable accepts `--data-dir <absolute-path>` when an operator
needs its shell logs and support diagnostics beneath a different application
data root. This changes only Floway-owned desktop data; it does not replace the
user home directory or operating-system credential store.

## Architecture

Floway One follows the Clash split between a long-lived core and a management
shell:

```text
Floway.app
├── Tauri 2 desktop shell (window, tray, single instance)
├── Node.js sidecar (gateway + control plane)
└── Dashboard (served same-origin, opened in the shell's WebView)
```

The desktop shell starts the local gateway process and loads the Dashboard
from the same loopback origin, so the existing SPA, SSE, WebSocket, OAuth, and
Agent Setup flows keep working unchanged. The window is only a control
surface: the gateway keeps running after the window closes, and can also run
headless without the desktop shell.

The desktop app bundles its own Node.js runtime, compiled gateway, database
migrations, and Dashboard assets per platform and architecture. On macOS it is
built as separate arm64 and x64 applications, each verified on its native
architecture by the desktop test gate; public signed installers are on the
roadmap, and Windows and Linux shells are planned.

## Compatibility

### Client APIs

| API | Routes |
| --- | --- |
| OpenAI Completions | `POST /v1/completions` |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses`, `POST /v1/responses/compact`, WebSocket `GET /v1/responses` |
| OpenAI Embeddings | `POST /v1/embeddings` |
| OpenAI Images | `POST /v1/images/generations`, `POST /v1/images/edits` |
| OpenAI Audio Transcriptions | `POST /v1/audio/transcriptions` |
| OpenAI Models | `GET /v1/models`, `GET /models` |
| Anthropic Messages | `POST /v1/messages`, `POST /v1/messages/count_tokens` |
| Google Gemini | `GET /v1beta/models`, `GET /v1beta/models/{model}`, `POST /v1beta/models/{model}:generateContent`, `POST /v1beta/models/{model}:streamGenerateContent`, `POST /v1beta/models/{model}:countTokens` |
| Cohere Rerank v1 | `POST /v1/rerank` |
| Cohere Rerank v2 | `POST /v2/rerank` |
| Jina Rerank | `POST /jina/v1/rerank` |
| Voyage Rerank | `POST /voyage/v1/rerank` |

`/v1/models` and `/models` return Floway One's public model superset to
ordinary callers and select the Codex or Claude Code discovery shape for those
clients' User-Agent.

Rerank models are manual Custom models. Each model selects its outbound Cohere,
Jina, Voyage, DashScope-compatible, or DashScope-native protocol and may
override that protocol's canonical path; there is no upstream-wide rerank path.

Audio transcription is a buffered multipart passthrough for Custom, Azure, and
Ollama-compatible upstreams. JSON, text, subtitle, and transcription SSE
responses retain their upstream wire shape.

### Upstreams

| Provider | Connection | Model catalog |
| --- | --- | --- |
| GitHub Copilot | GitHub device OAuth on `github.com` or a `*.ghe.com` tenant | Fetched live from Copilot |
| Codex | ChatGPT subscription through the Codex CLI OAuth client | Live inference catalog plus the account's built-in GPT Image capability |
| Claude Code | Claude.ai Pro, Max, Team, or Enterprise subscription through the Claude Code CLI OAuth client | Fetched live from Anthropic |
| Custom | Configurable multi-protocol HTTP endpoint, credential, and per-header ingress passthrough/overwrite rules | Live `/models` (OpenAI, Anthropic, or superset shapes), manual models, or both |
| Azure | Azure AI resource or Foundry project endpoint and API key | Configured models |
| Ollama | ollama.com or a self-hosted Ollama-compatible server | Fetched live from Ollama, with optional manual overrides |

## Relationship to Floway

Floway One tracks the upstream [Floway](https://github.com/Menci/Floway)
codebase and keeps it syncable. The multi-user server, Docker Compose, and
Cloudflare Workers targets remain in the tree (see `docker/` and
`wrangler.example.jsonc`) but are outside Floway One's product scope: the
product is the personal, loopback-only desktop gateway with a single owner.

## Development

```bash
pnpm install
pnpm run dev
pnpm run verify
```

`verify` chains every root verification script named by
`.github/workflows/verify.yaml`, reproducing that script set on the current
host. Pull requests additionally run the packaged Node verifier against Linux
Secret Service, Windows Credential Manager, and macOS Keychain to exercise
platform-specific credential storage, assembly, and startup paths. Each link is
also a script of its own, in the order the chain runs them: `typegen`, `lint`,
`typecheck`, `test`,
`test:desktop`, `test:installers`, `check:agents-md`, `check:generated-assets`,
`check:verify-parity`, `build:web`, and `test:packaged-node`. The build carries
the assertions about the emitted bundle. `test:desktop` uses the exact packaged
Node and pnpm versions to build separate arm64 and x64 macOS applications with
Tauri's production features, installs each executable artifact that the host can
run into an isolated application-like path, starts its packaged personal runtime,
checks migrations, loopback health and Dashboard assets, and fault-tests resources,
the actually loaded native Keyring binding, architecture, and live-child cleanup.
The final check assembles an isolated production
Node runtime and executes its image command. `typegen` comes first because the
generated route types are not checked in and the lint configuration is
type-aware, so a fresh clone has to produce them before anything else can read
the dashboard's sources. Desktop release authorities are the versioned
[Node.js distribution](https://nodejs.org/dist/v24.19.0/),
[Tauri 2.11.5](https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.11.5),
and [Tauri Shell 2.3.6](https://github.com/tauri-apps/plugins-workspace/releases/tag/shell-v2.3.6).

[AGENTS.md](./AGENTS.md) defines the repository-wide agent requirements and
indexes its CI workflows, skills, workspace packages, and their responsibilities.

## License

MIT
