---
name: floway
description: Help the owner configure, navigate, and troubleshoot the running local Floway personal app. Use for 新增 provider, 配置模型服务, 接入 Floway, models and routing, API keys and Agent Setup, monitoring, backups, or local settings. Supports direct helper setup, app GUI operation, and guided owner actions; not for remote or team gateways.
---

<!-- Managed by Floway. -->

# Floway

This Skill is for the running local Floway personal app. The installed files in this directory belong to the same Floway build. Read `references/concepts.md` before a GUI task, then only the reference for the requested area. Read `references/direct-setup.md` before using the helper to create a model service, test a model, or connect an agent. If a reference is missing, ask the owner to reinstall the Skill from **Quick Start** in Floway.app rather than guessing from stale instructions.

## Choose the interaction

- Honor the owner's stated surface. For direct configuration, use the installed `scripts/floway` launcher (Windows: `scripts/floway.ps1`) and the direct setup reference. Do not silently switch a GUI request to helper mutations.
- For an app task, use available computer-use tools to inspect and operate **Floway.app**. Focus the running app, inspect its current accessibility tree or semantic controls, and locate sections by their visible names. Use role, label, and current state instead of coordinates or remembered element indices. After each navigation or mutation, inspect the resulting view, notification, or persisted state before claiming success. If the app or a control is unavailable, report what was observed and ask for the specific missing step.
- If the owner requested app operation but computer use is unavailable, explain that limitation and offer step-by-step app guidance or the supported direct helper path; let the owner choose. When guiding, give one action at a time: name the section, control, and expected visible result, then wait for the owner's observation before the next action. A requested explanation can be answered without taking control.
- If no surface was specified, use the direct helper for supported model-service setup and testing; use the app for browsing or editing areas the helper does not cover. State which surface you are using when it matters.

## Boundaries

Treat **model service** and the owner's word **provider** as the same task concept; Floway labels the page **Upstreams**. A provider credential authorizes Floway to contact an external service. A Floway **API key** authorizes a client to call the local Gateway. A **model alias** is a virtual model ID with routing targets. Keep these distinct when changing access or routing.

Never read, print, paste, or send the private Skill session token. Keep provider credentials and Floway API keys out of chat, screenshots, and tool output; let the owner enter secrets into masked app fields, or use the private-file flow in `references/direct-setup.md`. Do not bypass the helper with raw authenticated control-API requests. Never construct, display, or open a Floway internal URL as a page; direct the owner to Floway.app. An external provider authorization page, such as GitHub device verification, is separate.

Before a consequential GUI edit, identify the target record and current value, explain the change and likely effects, and verify the saved state. For deletion, key rotation, route changes, backup restore, or agent config replacement, show the concrete target and consequences before proceeding. Do not infer success from a click or an API model list alone.

## Read the relevant guide

- `references/concepts.md`: terminology, navigation, semantic-control and verification rules for every GUI task.
- `references/model-services.md`: **Upstreams** creation, credentials, endpoint formats, model discovery, and compatibility options.
- `references/models-routing.md`: model list, **Model Aliases**, routing and ambiguous IDs.
- `references/keys-agent-setup.md`: **API Keys**, request capture, key scope and agent configuration.
- `references/monitoring.md`: **Requests**, **Usage**, **Performance**, and Playground checks.
- `references/backup-settings.md`: **Backup / Restore** and **Settings**.
- `references/direct-setup.md`: installed helper workflow and safe agent configuration.
