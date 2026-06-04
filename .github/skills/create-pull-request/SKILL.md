---
name: create-pull-request
description: >-
  Create a pull request for mcp-oauth2-proxy the way this repo expects: a
  Conventional-Commits title (release-please depends on it), a green
  build + test gate, a proper feature branch, and the standard Copilot
  co-author trailer. Use whenever the user asks to "open a PR", "create a
  pull request", "raise a PR", or push current changes for review.
---

# Create a pull request for mcp-oauth2-proxy

This repository releases with **release-please**, which parses **Conventional
Commit** messages from PR titles/commits to compute the next version and the
changelog. Getting the title prefix right is therefore not cosmetic — it drives
versioning. Follow these steps.

## 1. Understand the current state

```sh
git status
git --no-pager branch --show-current
git --no-pager diff --stat            # what changed
git --no-pager log --oneline -10      # recent history / style
```

- Default branch (PR base) is **`main`**. `dev` is an integration branch — ask
  the user whether the PR should target `main` or `dev` if it's ambiguous; when
  unsure, base on `main`.
- If the work is currently on `dev`, `main`, or another shared branch, create a
  dedicated topic branch first (see step 3). Never open a PR straight from a
  long-lived branch unless the user explicitly asks.

## 2. Validate before proposing a PR

These are the project's real gates (see `.github/copilot-instructions.md`):

```sh
npm run build     # tsc; must succeed
npm test          # vitest run; must pass
```

Do **not** run `npm run lint` as a gate — it is currently broken (ESLint 9 vs
`.eslintrc.cjs`). If either build or tests fail, stop and fix or report before
creating the PR.

## 3. Branch naming

Match the prefixes already used in this repo's history:

- `fix/<short-desc>` — bug fixes
- `chore/<short-desc>` — tooling, deps, release plumbing
- `ci/<short-desc>` — CI/workflow changes
- `docs/<short-desc>` — docs-only changes
- `feat/<short-desc>` — new functionality

```sh
git switch -c fix/short-description       # branch off the intended base
git add -A
git commit -m "fix(bridge): correct upstream timeout handling"
```

## 4. Commit & PR title format (Conventional Commits — required)

`type(scope): summary`

- **type**: `feat`, `fix`, `chore`, `docs`, `ci`, `refactor`, `test`, `perf`.
- **scope** (optional but encouraged): a code area such as `bridge`, `config`,
  `oauth2`, `discovery`, `security`, `ci`, `release`.
- Imperative, lower-case summary, no trailing period.
- Breaking changes: add `!` after the scope (`feat(config)!: ...`) and a
  `BREAKING CHANGE:` footer.

Examples drawn from this repo:
`fix(bridge): hard wall-clock deadline for upstream requests`,
`fix(config): validate numeric env vars with clear errors`.

Always append this trailer to commit messages (unless the user opts out):

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## 5. Push and open the PR

Prefer the GitHub CLI when available:

```sh
git push -u origin <branch>
gh pr create --base main --head <branch> \
  --title "fix(bridge): correct upstream timeout handling" \
  --body-file <path-or-heredoc>
```

If `gh` is not installed, push the branch and provide the user the compare URL:
`https://github.com/ChengleiYuan/mcp-oauth2-proxy/compare/main...<branch>?expand=1`

### PR body template

```markdown
## Summary
<1–3 sentences: what changed and why>

## Changes
- <bullet per meaningful change>

## Testing
- `npm run build` ✅
- `npm test` ✅

## Notes
<migration notes, follow-ups, or "none">
```

## 6. After creating

- Report the PR URL/number back to the user.
- Mention that the PR **title** is what release-please consumes — if it's wrong,
  edit the title rather than relying on commit bodies.

## Guardrails

- Do not commit secrets, tokens, or a real `config.json` (only
  `config.example.json` is tracked).
- Do not commit the nested `mcp-oauth2-proxy.wiki/` directory — it is
  git-ignored and has its own remote.
- Do not force-push or rewrite shared-branch history unless explicitly asked.
- Keep the PR scoped to one logical change; leave unrelated edits out.
