---
name: floway
description: Configure and inspect a running local Floway personal gateway through the installed Floway helper. Use for Upstream connection, model discovery, and Copilot authorization; not for remote or team gateways.
---

<!-- Managed by Floway. -->

# Floway

Use the installed `scripts/floway` launcher beside this file (on Windows, `scripts/floway.ps1`). It reads local authorization and the current gateway port itself. Never read, print, paste, or send the contents of the private session file. If the launcher is missing or says authorization is unavailable, ask the owner to sign in to the local Dashboard and use **Install Floway Skill** on the Quick Start page.

## Workflow

1. Run `floway status` and `floway list` to see the current state. Avoid duplicate Upstreams.
2. For an OpenAI-compatible provider, have the owner put its API key in an owner-only local file, then run `floway create-custom NAME BASE_URL KEY_FILE`. Do not put the key in a command argument or conversation. For Ollama, run `floway create-ollama NAME BASE_URL`.
3. For GitHub Copilot, run `floway copilot-start NAME`. Show the returned verification URL and user code to the owner. After they authorize, run `floway copilot-finish HANDLE`; if authorization is pending, retry the same handle. Do not claim completion until it reports verified models.
4. Run `floway models UPSTREAM_ID` when checking an existing Upstream. Treat an empty model list or a model-fetch error as a configuration task still needing attention.
5. Report the Upstream name, kind, enabled state, verified models or concrete failure, and the local Dashboard Upstreams link. Never include provider keys or OAuth tokens in the report.

The helper supports the local personal runtime only. Its output is deliberately reduced to safe status and model fields; do not bypass it with raw authenticated `curl` requests. If a provider needs a flow the helper does not support, explain that limitation and direct the owner to the Dashboard.
