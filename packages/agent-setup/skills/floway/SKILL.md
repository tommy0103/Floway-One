---
name: floway
description: Configure and test model services in a running local Floway personal gateway. Use for adding a provider (新增 provider), setting up a model service (模型服务), connecting one to Floway (接入 Floway), discovering models, testing Gateway formats, or authorizing Copilot; not for remote or team gateways.
---

<!-- Managed by Floway. -->

# Floway

Use the installed `scripts/floway` launcher beside this file (on Windows, `scripts/floway.ps1`). It reads local authorization and the current gateway port itself. Never read, print, paste, or send the contents of the private session file. If authorization is unavailable, open the Quick Start URL in the helper's error and ask the owner to sign in and use **Install Floway Skill**. If the launcher is missing, ask the owner to open Quick Start in Floway.app and reinstall the Skill.

## Workflow

1. Run `floway status` and `floway list` to see the current state and avoid duplicates. To the owner, call an Upstream a **model service** or use their word **provider**. Keep `Upstream`, `custom`, and IDs for helper arguments and troubleshooting. Ask only for information still missing.
2. For an OpenAI-compatible model service, obtain its name and API URL. If a key file does not already exist, create a new empty file with exclusive creation and owner-only mode `0600`; never overwrite an existing file. Immediately open it in the owner's editor through the host UI or system opener (`open -t` on macOS, Notepad on Windows, `xdg-open` on Linux). Wait for the owner to enter and save the key; check that the file is nonempty and owner-only, then run `floway create-custom NAME BASE_URL KEY_FILE`. Never put the key in a command argument, tool output, or conversation. For Ollama, run `floway create-ollama NAME BASE_URL`.
3. The custom helper removes a final full `/v1` or `/v1/` only when the new model service uses Floway's default paths, which append `/v1/models` and `/v1/chat/completions` to the base URL. For example, `/api/v1/` becomes `/api/`, while `/v1beta` stays unchanged. It rejects URL queries and fragments and reports the URL actually saved. If the model service needs custom endpoint paths, use the Dashboard instead of assuming this normalization applies.
4. For GitHub Copilot, run `floway copilot-start NAME`. Immediately open its returned verification URL in the owner's system browser through the host UI or system opener (`open`, `start`, or `xdg-open`), then show the user code. The owner completes authorization. Run `floway copilot-finish HANDLE`; if authorization is pending, retry the same handle.
5. `floway create-custom`, `floway create-ollama`, `floway copilot-finish`, and `floway models UPSTREAM_ID` list models; that alone does not prove inference works. After receiving models, choose a chat model (prefer one the user named) and run `floway test-model UPSTREAM_ID MODEL_ID`. This sends a short streaming request as an external client to the local Gateway's three Playground formats: OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages. If no Floway API key can reach the model service, open the returned API Keys page for the owner and retry after a key is available.
6. Report each format as available, failed, empty, or incomplete. `available` means the Gateway produced text and completed that request. If `possibleUpstreams` lists multiple model services, say the test could have routed through any of them. Report the model service name, enabled state, listed models, test model and results. For an issue requiring the owner, open the returned Dashboard page in the system browser and explain the next action. Never include provider keys, Gateway keys, or OAuth tokens.

The helper supports the local personal runtime only. It uses the local control API for configuration and an existing Floway API key in memory for Gateway tests; it does not print keys. Do not bypass it with raw authenticated `curl` requests. The helper provides Dashboard links but cannot focus or navigate inside Floway.app; open those links in the system browser. If a model service needs an unsupported flow, explain that limitation and open its Dashboard page.
