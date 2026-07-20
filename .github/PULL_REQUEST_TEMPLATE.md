## Summary

What this PR changes and why. Link any related issue (e.g. `Closes #123`).

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal change (no behaviour change)
- [ ] Docs only

## Checklist

- [ ] `pnpm run build` succeeds
- [ ] `pnpm test` passes
- [ ] `pnpm run typecheck` passes
- [ ] Ran `tripact check` — the tree is **level** (exit 0); no drift introduced in tripact's own spec
- [ ] Added or updated tests for behavioural changes; new/changed spec claims have a tagged test
- [ ] Added a `## [Unreleased]` entry to `CHANGELOG.md` for user-visible changes

## Public contract

- [ ] This change does **not** touch the public contract (`--json` schemas, exit codes, MCP tools)

If it does:

- [ ] Additive field: updated the surface's `fields` list in `src/contract.ts` (shape-pin test passes)
- [ ] Breaking change: bumped the relevant `*_SCHEMA_VERSION` in `src/contract.ts`
- [ ] Updated `docs/architecture/public-contract.md` to match

## Licensing

- [ ] I agree my contribution is licensed under the project's **Apache-2.0** license (inbound = outbound)

## Notes for reviewers

Anything that needs special attention, trade-offs made, or follow-ups deferred.
