# Security Policy

## Supported versions

tripact is **pre-alpha (0.x)**. Only the **latest 0.x release** is supported with security fixes.
There are no long-term-support branches; please upgrade to the newest release before reporting.

| Version | Supported |
|---|---|
| Latest 0.x | Yes |
| Any older 0.x | No |

## Scope

tripact is a **local developer CLI and library**, not a network service. It reads a project's
files and git history, writes a `.tripact/` sidecar, and — via `mcp-serve` — exposes a
Model Context Protocol server for a local harness. It does not listen on a public network, hold
credentials, or process untrusted remote input by default.

The kinds of issues we consider security-relevant:

- Path traversal or writes outside the project / `.tripact/` directory.
- Command or code injection reachable from `tripact.yaml`, claim text, tags, or file contents.
- The `mcp-serve` server performing unintended actions, or exposing data beyond the configured
  layers, when driven by a local client.
- Denial of service (e.g. crafted input that hangs or exhausts memory) that a normal repository
  could trigger.

General bugs that are not a security risk should go to the normal
[issue tracker](https://github.com/Le0C/tripact/issues) instead.

## Reporting a vulnerability

Please report privately — **do not open a public issue** for a suspected vulnerability.

Two channels, either is fine:

- **GitHub private security advisory** — open a draft advisory at
  <https://github.com/Le0C/tripact/security/advisories/new>.
- **Email** — Leo Coleman <leoacoleman@proton.me>.

Please include: the version, your `tripact.yaml`, the command run, what happened versus what you
expected, and a minimal reproduction if you have one.

## What to expect

- **Acknowledgement** within about 5 business days.
- An initial assessment and a plan (or a reason it's out of scope) within about 14 days.
- Coordinated disclosure: we'll agree a timeline with you and credit you in the release notes
  unless you'd rather stay anonymous.

Because this is a 0.x project maintained by a small team, these are best-effort targets, not a
contractual SLA.
