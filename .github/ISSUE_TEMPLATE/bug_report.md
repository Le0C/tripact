---
name: Bug report
about: Something in tripact behaves incorrectly or crashes
title: ""
labels: bug
assignees: ""
---

## What happened

A clear description of the incorrect behaviour.

## What you expected

What you expected `tripact` to do instead.

## The failing command and its output

The exact command you ran, plus its **`--json`** output where possible (it's the machine-readable
contract and pins down exactly what the engine reported):

```console
$ tripact <command> --json
<paste output here>
```

**Exit code:** <!-- 0 = level, 1 = drift, 2 = usage/environment error -->

## Your `tripact.yaml`

```yaml
<paste your config here>
```

## Minimal reproduction

The smallest set of spec/docs/test files (or a repo link) that reproduces the problem. tripact
requires a git repository, so include the relevant git state if it matters (e.g. what the last sync
point was, what changed since).

## Environment

- tripact version: <!-- output of the installed version -->
- Node.js version: <!-- node -v ; must be >= 22 -->
- OS:
- Package manager used to install (pnpm / npm):

## Anything else

Contents of `.tripact/` (e.g. `escalations.json`), logs, or other context.
