# Floway product context

## Register

Product: a desktop application and operator dashboard. Design serves the user's local gateway workflow.

## Users and purpose

Floway serves individual developers using multiple AI coding tools and subscriptions. It provides one stable local LLM gateway address, with authentication, model discovery, routing, fallback, usage and diagnostics. The desktop application owns its background runtime, including when the window is closed to the tray. See [the product specification](docs/floway-one-spec.zh-CN.md).

## Interface personality and references

Use the existing Fluent UI React components through the WinUI appearance boundary. Present tasks, status and recovery precisely, using the same controls as the rest of the dashboard. Support the existing light and dark themes rather than choosing a new visual identity. Metrics and intentional departures must come from the sources required by [the Web agent guide](apps/web/AGENTS.md).

## Anti-references

Do not introduce independent decorative controls, guessed WinUI values, or an alternative desktop-only dashboard. Do not show successful completion before the owning runtime has verified it. Preserve error evidence and a discoverable recovery action. These boundaries follow the repository and Web agent guides.

## Accessibility and language

Preserve Fluent keyboard navigation, focus handling, accessible labels, reduced-motion behavior and forced-color support. User-visible strings go through typed English and Simplified Chinese resources. Reuse existing primitives and their state styles.

## Current update brief

The approved [desktop update research](docs/desktop-update-research.zh-CN.md), sections 7–9, defines this feature: native state as truth, a settings action area, a ready MessageBar in main content, user-opened release notes, version-specific Later, and explicit update/restart through the existing recovery-aware installer. Browser/server dashboards do not offer local installation.
