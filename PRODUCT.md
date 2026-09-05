# Product

## Register

product

## Users

Floway serves individual developers who use multiple AI coding tools and model providers. They need one stable local endpoint, one control surface, independently revocable API keys, and local custody of credentials, usage, and request records without requiring Node.js, pnpm, Docker, or database administration.

## Product Purpose

Floway is a local-first LLM gateway and control plane. It combines subscription-backed and token-backed providers behind the API shapes clients already use, while the desktop shell keeps the local runtime observable and the shared Dashboard manages providers, models, routing, keys, usage, and diagnostics. Success means the gateway is dependable in the background, the current state is explicit, and recovery never requires guessing whether the shell, runtime, storage, or Dashboard failed.

## Brand Personality

Dependable, precise, and calm. Floway should communicate expert confidence through direct status, preserved diagnostic detail, and familiar operating-system and Dashboard affordances.

## Anti-references

Floway must not resemble a remote multi-tenant SaaS control plane, a decorative monitoring dashboard, or a second desktop-only implementation of gateway behavior. It must not hide failures behind blank windows, indefinite loading, silent fallback, generic error copy, or automatic changes to stable local configuration.

## Design Principles

- Keep the local gateway primary and make its state legible from every owning surface.
- Reuse the shared Dashboard and runtime contracts instead of duplicating business behavior in the desktop shell.
- Prefer explicit, bounded transitions with actionable recovery over optimistic or silent fallback.
- Preserve local-first security, stable endpoints, and original diagnostic chains.
- Use familiar Fluent and platform conventions so the interface disappears into the operator's task.

## Accessibility & Inclusion

Preserve Fluent keyboard, focus, and semantic behavior; communicate state with text and structure rather than color alone; respect reduced-motion preferences; keep English and Simplified Chinese resources structurally equivalent; and ensure startup or runtime failures always resolve to a readable, actionable surface.
