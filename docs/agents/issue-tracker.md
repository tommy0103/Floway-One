# Issue tracker: GitHub

Issues and PRDs for this repository live in [tommy0103/Floway-One](https://github.com/tommy0103/Floway-One). Use the `gh` CLI for all tracker operations and always pass `--repo tommy0103/Floway-One`; the local clone also retains the original Floway repository as a separate remote.

## Conventions

- Create an issue with `gh issue create --repo tommy0103/Floway-One` and a prepared body file.
- Read an issue with `gh issue view <number> --repo tommy0103/Floway-One --comments`, including its labels and relationships when they affect the work.
- List issues with `gh issue list --repo tommy0103/Floway-One`, scoped by the required state and labels.
- Comment with `gh issue comment <number> --repo tommy0103/Floway-One`.
- Apply or remove labels with `gh issue edit <number> --repo tommy0103/Floway-One`.
- Close an issue with `gh issue close <number> --repo tommy0103/Floway-One` only when its completion condition is satisfied.
- Create implementation PRs against `tommy0103/Floway-One:main`.
- Write PR titles and bodies in English.
- Keep one implementation issue per PR unless the user explicitly authorizes a combined PR.
- End an implementation PR body with exactly one `Closes #<issue-number>` line.

GitHub shares one number space across issues and pull requests. Resolve an ambiguous `#N` with `gh pr view N --repo tommy0103/Floway-One` and fall back to `gh issue view N --repo tommy0103/Floway-One`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

External PRs do not enter the issue triage queue. Issue-driven implementation PRs are still reviewed and merged through the repository's normal PR workflow.

## Publishing and retrieval

- When a skill says to publish to the issue tracker, create a GitHub issue in `tommy0103/Floway-One`.
- When a skill says to fetch the relevant ticket, read the issue body, comments, labels, parent, children, dependencies, and linked PRs from `tommy0103/Floway-One`.

## Parent issues, sub-issues, and dependencies

- Use a parent issue for coordination only when several independently deliverable leaf issues share one outcome.
- Link leaf issues as native GitHub sub-issues where the repository supports them.
- Represent blocking order with native GitHub issue dependencies where available.
- If native relationships are unavailable, put `Part of #<parent>` and `Blocked by: #<issue>` lines in the leaf issue body.
- Parent issues do not receive implementation PRs; each leaf issue owns at most one closing PR.

## Session workflow

- Create one coder session for each ready, unblocked leaf issue.
- Create one reviewer session after the coder session opens its PR.
- Reuse the same coder and reviewer sessions for every feedback round on that PR.
- Reviewer findings return to the corresponding coder session; the updated PR returns to the same reviewer session until both review axes report no findings.
- Do not merge a PR without the human's explicit permission for that exact PR.
