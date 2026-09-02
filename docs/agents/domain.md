# Domain Docs

Floway One uses a single domain context across its monorepo.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant architecture decisions under `docs/adr/` when that directory exists.
- Proceed silently when either source is absent; domain documentation is created when terminology or architectural decisions need to be recorded.

## Layout

```text
/
├── CONTEXT.md
└── docs/
    └── adr/
        ├── 0001-example-decision.md
        └── 0002-another-decision.md
```

Do not create a `CONTEXT-MAP.md` or package-specific contexts unless the repository explicitly moves to a multi-context model.

## Vocabulary

- Use the terms defined by `CONTEXT.md` in issues, PRs, tests, documentation, and code comments.
- Do not replace defined terms with near-synonyms.
- Treat missing vocabulary as a prompt to verify the current code and product language before introducing a new term.

## Architecture decisions

- Surface any conflict with an existing ADR explicitly.
- Do not silently override or contradict a recorded decision.
- Record a superseding decision when an accepted change replaces an earlier ADR.
