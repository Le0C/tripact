# Releasing tripact

A maintainer runbook. Phase 0 happens while the repository is still private; everything from
Phase 3 is irreversible in practice, so the order matters.

Commands assume the repo root as the working directory. Steps marked **(browser)** have no CLI
equivalent unless you install the GitHub CLI (`brew install gh && gh auth login`).

---

## Phase 0 — while still private

The point of this phase is to reach the registry-install path without spending the `0.1.0` version
or making the repository public.

### 0.1 Test the artefact, not the working tree

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
node dist/cli.js check --strict          # must exit 0
```

Then the packed tarball, which is what users actually get:

```bash
npm pack --pack-destination /tmp/tripact-smoke
tar -xzf /tmp/tripact-smoke/tripact-0.1.0.tgz -C /tmp/tripact-smoke
ln -sfn "$PWD/node_modules" /tmp/tripact-smoke/package/node_modules   # stands in for `npm install`

mkdir -p /tmp/tripact-demo && cd /tmp/tripact-demo && git init -q .
printf '# Calculator\n\n## Addition\n\n- [ ] add(a, b) returns the sum of two integers\n' > SPEC.md
printf 'schemaVersion: 1\nlayers:\n  specs:\n    role: prescriptive\n    paths: [SPEC.md]\n  tests:\n    role: verificatory\n    paths: [test/**/*.test.ts]\nedges:\n  - [specs, tests]\n' > tripact.yaml
node /tmp/tripact-smoke/package/dist/cli.js check     # expect exit 1, one NEW-UNCOVERED claim
```

Walk the rest of the quickstart from `docs/overview.md` in that demo repo: tag the test, `check`
(PENDING), `accept --yes`, `check` (level). The output should match the documented transcript.

### 0.2 Publish a release candidate

A prerelease exercises the real registry, the real install path, and the npm README rendering,
without touching `latest` and without needing the repo to be public. Provenance is skipped — it
needs OIDC from a public-repo CI run — which is exactly why this is a candidate and not the release.

```bash
npm login                                 # laptop publish; expect an OTP prompt
```

Bump three places to `0.1.0-rc.1` — `package.json`, `src/version.ts`, and nothing else (a test pins
those two to each other):

```bash
pnpm test                                 # confirms the two versions agree
npm publish --tag next --access public    # --tag next keeps `latest` untouched
```

Verify from a clean directory:

```bash
cd $(mktemp -d) && npm init -y >/dev/null
npm install -D tripact@next
npx tripact --version                     # 0.1.0-rc.1
```

Then read <https://www.npmjs.com/package/tripact> and check the things only the registry can show
you: **does the logo render**, do the `./docs/overview.md` links resolve, does the README read well
at the top of the page. Fix anything wrong, publish `-rc.2`, repeat.

When you are done, set `package.json` and `src/version.ts` back to `0.1.0` and commit.

### 0.3 What else is worth testing here

- Run tripact against a handful of real repositories with different spec systems and confirm
  `detect` and `kind:` presets behave.
- `npx tripact mcp-serve` wired into a client, exercising `check` / `tasks` / `resolve`.
- A global install (`npm install -g tripact@next`) — a different bin resolution path from `npx`.
- Node 22 specifically, not just your local Node, since 22 is the declared floor.

---

## Phase 1 — npm account preparation

1. **(browser)** <https://www.npmjs.com/settings/~/tokens> → *Generate New Token* → **Granular
   Access Token**.
   - Packages and scopes: **Read and write**, restricted to the `tripact` package.
   - Set an expiry you will actually rotate; the UI requires one. Put the rotation date in your
     calendar now — an expired token fails the release workflow at the last step.
2. **(browser)** <https://www.npmjs.com/package/tripact/access> → Publishing access →
   **Require two-factor authentication or automation tokens**. The stricter "2FA required" setting
   rejects the token in CI, which is the single most common first-release failure.

---

## Phase 2 — GitHub preparation (still private)

1. **(browser)** Settings → Secrets and variables → Actions → *New repository secret*, named
   exactly `NPM_TOKEN`, holding the token from Phase 1. `release.yml` reads that name.
2. **(browser)** Settings → General: fill in the description and website, and add topics
   (`traceability`, `spec-driven-development`, `requirements`, `testing`, `agents`, `drift`).
   These drive GitHub search and the repo card.
3. Confirm Actions are enabled and CI is green on `main` with the new matrix. The Windows job is
   expected to be red or skipped — it is `continue-on-error`, so it must not block anything.

---

## Phase 3 — go public

**(browser)** Settings → General → Danger Zone → *Change repository visibility* → Public.

This is the irreversible step. Everything before it is reversible; after it, the commit history,
every issue, and the `.tripact/` ledger are public. Confirm first that no commit in history carries
a secret — the repository is small and was developed privately, so a quick skim of
`git log -p -- '*.yml' '*.json'` is proportionate.

Immediately after:

1. **(browser)** Settings → Code security → **Private vulnerability reporting** → Enable. This is
   public-repos-only, which is why it lands here and not in Phase 2. `SECURITY.md` already links to
   `/security/advisories/new`, and that URL 404s until this is on.
2. **(browser)** Settings → Rules → Rulesets → protect `main`: require a pull request, and require
   the status checks `test (ubuntu-latest, 22)`, `test (ubuntu-latest, 24)`,
   `test (macos-latest, 22)` and `integrity`. Pick them from the list after a run has reported, so
   the names match exactly. **Do not mark the windows job required.**
3. Check the README renders as intended on the public repo page, in both colour schemes.

---

## Phase 4 — final pre-tag checks

```bash
git switch main && git pull
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm test && pnpm run build
node dist/cli.js check --strict           # exit 0
node dist/cli.js generate && git diff --exit-code    # derived outputs current
node dist/cli.js skills --force && git diff --exit-code   # emitted skills current
npm pack --dry-run                        # inspect the file list one last time
node -p "require('./package.json').version"          # must read 0.1.0
```

Then, by hand:

- `CHANGELOG.md` — set `## [0.1.0] - <the actual release date>`. It currently reads `2026-07-20`.
- Confirm `src/version.ts` says `0.1.0` (the test enforces this, so a green suite is proof).
- Commit anything the above changed, including the `tripact-sync-id` trailer if you ran `accept`.

---

## Phase 5 — tag and publish

```bash
git tag -a v0.1.0 -m "tripact 0.1.0"
git push origin v0.1.0
```

That triggers `release.yml`, which re-runs typecheck, tests, build and `check --strict`, refuses if
the tag and `package.json` disagree, and publishes with provenance. Watch it in the Actions tab (or
`gh run watch`). Do not publish by hand in parallel.

If it fails, read the failing step:

| Symptom | Cause |
| --- | --- |
| `ENEEDAUTH` / 401 at publish | `NPM_TOKEN` missing, expired, or scoped to the wrong package |
| `EOTP` | package set to "2FA required" — change it to allow automation tokens (Phase 1.2) |
| provenance generation failed | repo not public, or `id-token: write` missing from the workflow |
| tag/version mismatch error | the tag does not match `package.json`; delete the tag, fix, re-tag |

To retag after a failure that published nothing: `git tag -d v0.1.0 && git push origin :v0.1.0`,
fix, then tag again. Once a version is published to npm it cannot be reused, even if unpublished.

---

## Phase 6 — after publishing

```bash
npm view tripact version                  # 0.1.0
npm view tripact dist-tags                # latest → 0.1.0
npm deprecate tripact@0.0.0 "placeholder — start at 0.1.0"

cd $(mktemp -d) && npm init -y >/dev/null && npm install -D tripact
npx tripact --version                     # the published artefact, from the registry
```

Then:

1. Read <https://www.npmjs.com/package/tripact>: the logo renders, the links work, and a
   **Provenance** section names the workflow and commit.
2. **(browser)** Releases → *Draft a new release* → choose tag `v0.1.0` → paste the `0.1.0` section
   of `CHANGELOG.md` as the body. This makes the `[0.1.0]: …/releases/tag/v0.1.0` link at the
   bottom of the CHANGELOG resolve.
3. Watch the issue tracker for the first day. The likely first questions are "does it check that
   the test really tests the claim?" (no — documented under *What tripact deliberately does not
   check*) and Windows support.

**If something is badly wrong**, prefer fixing forward with `0.1.1` over unpublishing. Unpublishing
is only possible within 72 hours and permanently burns the version number.

---

## Every subsequent release

1. Move `## [Unreleased]` in `CHANGELOG.md` to `## [x.y.z] - <date>` and add the link reference.
2. Bump `package.json` **and** `src/version.ts` together (the test suite fails if they diverge).
3. Commit, then Phase 4 → Phase 5. Phases 0–3 are one-time setup.
