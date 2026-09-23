# Floway app companion: concepts and controls

Use this for every GUI task, then read only the reference for the relevant section. These directions describe the local personal app; visible labels may be English or Chinese. Find the current control by role and accessible name, using the owner's language and the live view. Do not assume a page, dialog, index, or coordinate remains stable between app versions.

## Map the owner's words

| Owner's words | Floway concept | Where to look |
| --- | --- | --- |
| provider, model service, upstream | Upstream: a connection to an external model service or account | Upstreams |
| model | A model ID listed by one or more enabled Upstreams | Upstreams > Models; Playground |
| model nickname, route, fallback | Model Alias: a virtual ID with target models and selection rules | Model Aliases |
| provider key | Credential Floway uses to call the external service | The selected Upstream's connection settings |
| Floway key, gateway key, client key | API key a client uses to call Floway | API Keys |
| connect my agent | Agent Setup or agent configuration using a Floway API key | API Keys > Set Up Your Agents |
| request log, tracing | Captured Requests, if capture is enabled on the key | Requests; API Keys |
| usage, cost, latency | Aggregated Usage or Performance telemetry | Usage; Performance |
| export, restore | Backup / Restore | Backup / Restore |
| local status, logs, password | Settings | Account footer > Settings |

An enabled Upstream may list models without proving an inference request succeeds. An alias may hide from model discovery but remain callable by ID. API key scope limits which Upstreams a client may reach; it does not change a provider credential. Request dump retention and stateful OpenAI Responses retention are different settings.

## Operate and verify

1. Focus the running Floway.app. Inspect the live accessibility tree or equivalent semantic UI state. Find the navigation item or heading by name; confirm the destination heading after activating it. If a section is absent, check sign-in, role, and runtime state before assuming a product change.
2. Identify the exact target row by its visible name and surrounding details. Open the row's named action, then inspect the dialog or editor and its current values. For duplicate names, pause until the target is unambiguous.
3. Enter only the requested change. For secrets, let the owner type into the masked field; do not inspect or reveal the field. Before saving, state the target, effect, and any destructive or access change. If the owner already authorized that exact change, continue.
4. Activate the labeled Save/Confirm action. Wait for completion, inspect any error or success notice, reopen or refresh the record when practical, and compare the persisted state to the intended state. A click, toast alone, or model-list result is not proof of the downstream behavior.
5. If computer use is unavailable, give the owner one action and an expected visible result, then wait for their observation. Avoid a long checklist that presumes the preceding action worked.

Never open the Dashboard in a browser, construct a localhost Dashboard link, or expose its page address to the owner. Use Floway.app; external provider authorization may open the provider's own page. For a model request test, use the Playground UI when the owner chose GUI, or `test-model` in the direct workflow when they chose the helper.
