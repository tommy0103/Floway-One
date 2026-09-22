---
name: floway
description: Configure and test providers (Upstreams) in a running local Floway personal gateway. Use when the user asks to add a provider, connect an API, discover models, test Gateway formats, or authorize Copilot; not for remote or team gateways.
---

<!-- Managed by Floway. -->

# Floway

Use the installed `scripts/floway` launcher beside this file (on Windows, `scripts/floway.ps1`). It reads local authorization and the current gateway port itself. Never read, print, paste, or send the contents of the private session file. If the launcher is missing or says authorization is unavailable, ask the owner to sign in to the local Dashboard and use **Install Floway Skill** on the Quick Start page.

## Workflow

1. Run `floway status` and `floway list` to see the current state. The user may call an Upstream a **provider**; use their term and avoid duplicates. Ask only for information still missing.
2. For an OpenAI-compatible provider, obtain its name and API URL. The helper accepts a URL ending in `/v1` or `/v1/` and removes that suffix before storing it, because Floway adds `/v1` to its standard custom-provider routes. Have the owner put the provider key in an owner-only local file, then run `floway create-custom NAME BASE_URL KEY_FILE`. If they need a place to enter it, create a new empty file with mode `0600` and open that file in their editor when the host supports it. Ask them to fill and save it before running the helper. Never put the key in a command argument, tool output, or conversation. For Ollama, run `floway create-ollama NAME BASE_URL`.
3. For GitHub Copilot, run `floway copilot-start NAME`. Open the returned verification URL in the owner's browser when the host supports it, and show the user code. After they authorize, run `floway copilot-finish HANDLE`; if authorization is pending, retry the same handle.
4. `floway create-custom`, `floway create-ollama`, `floway copilot-finish`, and `floway models UPSTREAM_ID` list models; that alone does not prove inference works. After receiving models, choose a chat model (prefer one the user named) and run `floway test-model UPSTREAM_ID MODEL_ID`. This sends a short streaming request as an external client to the local Gateway's three Playground formats: OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages. If no Floway API key can reach the provider, open the returned API Keys page for the owner and retry after a key is available.
5. Report each format as available, failed, empty, or incomplete. `available` means the Gateway produced text and completed that request. If `possibleUpstreams` lists multiple providers, state that the test could have routed through any of them; do not attribute the result to one provider. Report the provider name, enabled state, listed models, test model and results, and Dashboard link. Never include provider keys, Gateway keys, or OAuth tokens.

The helper supports the local personal runtime only. It uses the local control API for configuration and an existing Floway API key in memory for Gateway tests; it does not print keys. Do not bypass it with raw authenticated `curl` requests. If a provider needs a flow the helper does not support, explain that limitation and direct the owner to the Dashboard.
