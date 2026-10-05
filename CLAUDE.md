# CLAUDE.md

> **Git policy — never auto-commit or auto-push.** Leave your work in the working tree.
> Run `git commit`, `git push`, `gh pr create`, or `push_all.sh` **only when the user
> explicitly asks in that turn**. Approval for an earlier change does not carry forward, and
> finishing a task is not permission to commit it.

## What this is

`@sudobility/raidr_cli` (public npm, BUSL-1.1) — the `raidr` binary that turns an
raidr capture bundle into a runnable project, plus the `raidr-reconstruct` agent
skill (`skills/reconstruct/`) that drives it. The CLI does every deterministic
stage; the skill does only judgment work (components, naming, wiring).

Ships as TypeScript: `bin.raidr` is `./src/cli.ts`, `files` is `src` + `skills`.
There is no build step and no `dist/`; users need Bun ≥ 1.2 (`engines.bun`).

### Place in the raidr family

| Repo | Role |
|---|---|
| raidr_processor | Pure bundle format / redaction / analysis / codegen. **This repo's core dependency.** |
| raidr_extension | Chrome MV3 capture (produces the bundles this CLI reads) |
| **raidr_cli** | Reconstruction CLI + `raidr-reconstruct` skill (this repo) |
| raidr_crawler | Headless crawl + `raidr-publish` skill |
| raidr_types → raidr_client → raidr_lib → raidr_app | Catalog types, client, logic, UI |
| raidr_api | Catalog + hosted MCP |
| raidr_web | Landing page |

Release order lives in `raidr_app/scripts/push_all.sh` (raidr_cli publishes after
raidr_processor). Nothing in the family depends on raidr_cli; its consumers are
end users (`bun add -g`), coding agents via the skill, and the MCP skills
raidr_crawler generates, which run `raidr token` through `bunx`.

## Commands

Observed on this checkout (Bun 1.4.2):

| Command | What it does | Result |
|---|---|---|
| `bun install --frozen-lockfile` | Install deps | pass, no changes |
| `bun run typecheck` | `tsc --noEmit` over src, tests, scripts, fixtures/api | pass |
| `bun run test:unit` | `bun test` on the listed dirs (excludes `tests/capture`) | pass — 69 tests, 11 files, ~8 s (2026-10-04) |
| `bun src/cli.ts` | Prints usage, exits 1 | as expected |
| `bun test tests/capture` | Real-browser capture harness | **fails here**: Playwright Chromium not installed; also needs `fixtures:build` first |
| `bun run fixtures:build` | `bun install && bun run build` in each `fixtures/apps/*` | not run (network; writes fixture `node_modules`/`dist`) |
| `bun run fixtures:capture` | Regenerates `fixtures/bundles/*.zip` via Playwright | not run (overwrites tracked fixtures; needs browser) |

There is **no `lint` and no `build` script**. Plain `bun test` (as the README
says) also picks up `tests/capture` and fails without a browser — use
`bun run test:unit`.

## Architecture

```
src/
  cli.ts                  bin entry; dispatches reconstruct | token | install | uninstall (lazy imports)
  commands/token.ts       `raidr token <apiHost>`: sign in in a headed browser, save the site token
  token/watcher.ts        CredentialWatcher: when a request's token counts as signed in
  commands/reconstruct.ts the pipeline: stages 01–07, mode choice, project + replay/proxy server codegen, report.md
  commands/install.ts     symlinks skills/reconstruct into ~/.claude|.codex|.agents/skills/raidr-reconstruct
  bundle/load.ts          zip-or-dir file I/O → raidr_processor's readBundle/unzipBundle (LoadedBundle)
  stages/unpack.ts        stage 3: prettier-beautify JS chunks, split webpack modules without an AST
  stages/mirror.ts        stage 5b: write served bytes to public/, snapshot fallback for client routes
  emit.ts                 write files, prettier-format when possible (never fails on format errors)
  paths.ts                safeRelativePath: shortens path segments over 200 bytes (URL-derived names hit ENAMETOOLONG)
  introspect/probes.ts    page-evaluated probes (framework, routes, chunks, links, DOM) — SHARED FILE, see below
  capture/harness.ts      test/fixture-only Playwright capture → bundle zip (not used by the CLI)
skills/reconstruct/       SKILL.md (the agent procedure) + INSTALL.md
fixtures/apps/            react-sample, vue-sample (vite apps; dist/ and node_modules/ gitignored)
fixtures/api/server.ts    Hono fixture API on :8123 the sample apps call
fixtures/bundles/*.zip    committed capture bundles — the input for most tests
scripts/                  fixtures:build and fixtures:capture
```

### `raidr reconstruct <bundle> --out <dir> [--replay]` data flow

All analysis/codegen functions come from `@sudobility/raidr_processor`; this repo
sequences them and does the I/O. Artifacts go to `<dir>/.raidr/`:

| Stage | Writes | Notes |
|---|---|---|
| 1 | `01-bundle.json` | manifest, gaps, redaction table — gaps first |
| 2 | `02-sources/` | original sources from source maps (raidr_processor's `recoverBundleSources`) |
| 3 | `03-chunks/` | only when recovery ratio < 80 (`unpackChunks`) |
| 4 | `04-api-model.json`, `recordings.json` | XHR/Fetch only, OPTIONS excluded; recordings keyed by `endpointKey` |
| 5 | `05-route-model.json` | runtime router table, or derived from Document requests (`source` field says which) |
| 5b | `06-mirror.json` + `<dir>/public/` | always written |
| 5c | `07-link-audit.json` | links from mirrored pages that resolve to nothing |
| — | `02-recovery.json` | written **after** 07, because `mode` depends on the mirror |
| 6–7 | project files in `<dir>` | `generateProject` or `mirrorProject`; `src/api/{types,client}.ts`, `server/replay.ts`, `server/recordings.json` |
| — | `report.md` | human summary; the skill starts here |

Mode: `recovery` if ratio ≥ 80 (`RECOVERY_THRESHOLD`), else `mirror` if any page
was mirrored, else `inference`. In mirror mode `server/replay.ts` is a live
**proxy** to the real origin by default; `--replay` switches to serving
`recordings.json`. The JSON report is printed to stdout.

### `raidr token <apiHost> [--print]`

Gets a site's auth token without the user copying it from DevTools.
Generated MCP skills (raidr_crawler `src/pipeline/skill.ts`) tell the agent
to run `bunx --package @sudobility/raidr_cli raidr token <apiHost> --print`;
it lives here rather than in raidr_crawler so that skills never name the
crawler.

1. **Target.** By default it fetches `GET /api/v1/apis/<apiHost>` from
   raidr_api (`--api-url`, then `RAIDR_API_URL`, then `apiUrl` in
   `~/.raidr/config.json`, then `https://api.raidr.app`) with the `apiKey` in
   that file; exits 1 if there is none. `targetFromDoc` takes `auth.user`
   (style, header/cookie name, `tokenPrefix`), `loginUrl` (else the first site
   origin, else `baseUrl`) and every `auth: 'user'` endpoint path as
   `userPaths`. With `--login <url> --style bearer|header|cookie` it skips the
   doc; `--header-name`, `--cookie-name` and repeatable `--user-path` fill the
   rest. A host whose style is `none` prints that and exits 0.
2. **Browser.** Playwright `launchPersistentContext`, headed, on the profile
   `~/.raidr/browser` (`RAIDR_BROWSER_PROFILE` overrides), so later runs reuse
   the session. Tries installed Chrome, then Edge, then Playwright Chromium;
   `--channel` pins one and does not fall back.
3. **Verification** (`CredentialWatcher`, the same rule as raidr_extension's
   `TokenCapture`): requests to `apiHost` are read with raidr_types
   `extractCredential`; a token is accepted once a request carrying it to a
   `userPaths` path (`matchesPathTemplate`) answers 2xx, or any 2xx when
   `userPaths` is empty. Then the browser closes.
4. **Window closed first** (or `--timeout-ms`, default 600000, runs out):
   null, unless `userPaths` is empty, in which case the last token seen comes
   back unverified. Null exits **2**.
5. **Save.** `saveSiteToken` writes `siteTokens[apiHost] = { token, savedAt }`
   into `~/.raidr/config.json`, keeping every other field, mode 0600 (dir
   0700). `--print` also writes the token alone to stdout; every message goes
   to stderr.

## Invariants (easy to break)

- **`src/introspect/probes.ts` must stay byte-identical** to
  `raidr_extension/src/introspect/probes.ts` (and raidr_crawler's copy).
  Enforced by `tests/introspect/probesParity.test.ts` (compares against the
  extension), which is *skipped* when the sibling checkout is absent — i.e. in
  CI. Do not add comments or reformat it here alone; change all three copies
  together. It cannot move into raidr_processor because it touches DOM globals.
- **Probe functions are serialized with `.toString()`** and evaluated in the page
  (`PROBE_SOURCES`). They must not reference anything outside their own body.
- **raidr_processor must stay I/O-free**; anything needing `fs`/`path`/zip goes
  here, not there (README "Why this is a separate repository").
- **`mirrorReplayServer` patches `generateReplayServer` output with exact-string
  `.replace()`** (`const app = new Hono();\n`, `serveStatic({ root: './dist' })`,
  `app.get('*', serveStatic({ path: './dist/index.html' }));`, the
  `recorded[0]!` pick). If raidr_processor's `src/codegen/replay.ts` template
  text changes, these silently no-op. Only `--replay` mirror mode is affected,
  and no unit test covers it (the round-trip tests use a recovery-mode bundle).
- **Never invent data.** Unrecorded endpoints return 501 `RAIDR-GAP`
  (asserted in `tests/roundTrip.test.ts`); gaps become `RAIDR-GAPS.md`.
- **Mirror safety**: paths containing `..` are dropped; served bytes always win
  over DOM snapshots (`seen` set in `stages/mirror.ts`).
- **`install()` takes `home` as a parameter** — `os.homedir()` ignores runtime
  `HOME` changes, so tests would otherwise write into the real home dir. It
  refuses to delete a non-symlink at the target.
- **Skill text is tested.** `tests/skills/skillFormat.test.ts` asserts the
  frontmatter (`name` letters/digits/hyphens, `description` starts with "Use
  when", no " then/first/step/stage ", < 1024 chars), that every `.raidr/`
  artifact name appears, the four completion-report headings, no `jq`
  invocation, and the install commands/paths in INSTALL.md.
- **`raidr token` must not accept a guest token.** Keep the verification rule
  identical to raidr_extension's `src/background/tokenCapture.ts`; both use
  raidr_types `extractCredential` and `matchesPathTemplate`.
- **`raidr token --print` keeps stdout to the token alone.** Skills capture it
  with `$(…)`; anything else goes to stderr.
- Redaction happens at capture time in raidr_processor (e.g. it deliberately
  leaves `x-api-key` alone); this repo never re-redacts.

## Testing

- `tests/` mirrors `src/`; `tests/roundTrip.test.ts` reconstructs
  `fixtures/bundles/{react,vue}-sample.zip` into `.tmp/`, runs `bun install`,
  typecheck, build, and boots the replay server on ports 8899/8900. It needs
  network for `bun install` and takes most of the run time.
- Tests write to `.tmp/` (gitignored). Leave it alone; tests recreate it.
- `tests/bundle/fixtures/badversion/` is a manifest the loader must reject.
- CI (`.github/workflows/ci-cd.yml` → `johnqh/workflows` unified workflow, npm
  access public) runs typecheck, lint if present (none), `test:unit`, build if
  present (none). CI **cannot** run the probes parity check (no sibling repo) or
  `tests/capture` (excluded from `test:unit`; needs Chromium + built fixtures).

## Common changes

**Use a new bundle field** (added in raidr_processor): publish raidr_processor
first (read it in raidr_processor's `src/bundle/read.ts`, `LoadedBundle` +
`readBundle`) → bump `@sudobility/raidr_processor` here → consume in
`src/commands/reconstruct.ts` → if the capture harness should emit it,
`src/capture/harness.ts` → regenerate bundles only if needed.

**Change redaction**: not here. Edit raidr_processor `src/redaction/`, publish,
bump the dependency.

**Add a reconstruct stage/artifact**: `src/stages/<name>.ts` → call it from
`reconstruct()` and `writeJson('NN-name.json')` → add to `report.md` lines if
useful → add the artifact to SKILL.md Quick Reference and to the artifact list
in `tests/skills/skillFormat.test.ts` → test in `tests/stages/`.

**Change what counts as a site token**: `extractCredential` lives in
raidr_types and is shared with raidr_extension; change it there. The
signed-in rule is `src/token/watcher.ts` here and `tokenCapture.ts` in the
extension; change both. Tests: `tests/token/`.

**Add a CLI command**: `src/commands/<name>.ts` exporting `run<Name>(argv)` →
a `case` in `src/cli.ts` plus the usage string → `tests/commands/` → README
Usage section.

**Change the skill**: edit `skills/reconstruct/SKILL.md` / `INSTALL.md` → run
`bun run test:unit` (skillFormat tests) → keep the frontmatter description a
trigger condition, not a procedure.

## Versioning and publishing

CI publishes to npm when `package.json` `version` is new on push to `main`.
Never `npm publish`/`bun publish` by hand, and do not bump versions unless the
user asks. Releases go through `raidr_app/scripts/push_all.sh` after
raidr_processor.

## Gotchas

- `src/cli.ts`'s top-level usage omits `--replay`; the subcommand usage in
  `runReconstruct` has it.
- `reconstruct()` does not clear `--out`; stale files from a previous run survive.
- `emitFiles` swallows prettier errors on purpose; unformatted output is not a bug.
- `recoveryRatio` is an integer percent (0–100), not a fraction.
- `playwright` is a runtime dependency because `raidr token` launches a
  browser. `capture/harness.ts` also imports it but the CLI never does.
- `raidr token` does not download a browser: with no Chrome or Edge installed
  it needs Playwright Chromium (`bunx playwright install chromium`).
- With `--login/--style` instead of the API doc, pass `--token-prefix` when a
  `header`-style site puts text before the token; without it `header` strips
  nothing and `bearer` strips `Bearer `.
- The comment block above `mode` in `reconstruct.ts` contains two overlapping
  paragraphs from different revisions; the second is the current rule.
