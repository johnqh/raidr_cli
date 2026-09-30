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
end users (`bun add -g`) and coding agents via the skill.

## Commands

Observed on this checkout (Bun 1.4.2):

| Command | What it does | Result |
|---|---|---|
| `bun install --frozen-lockfile` | Install deps | pass, no changes |
| `bun run typecheck` | `tsc --noEmit` over src, tests, scripts, fixtures/api | pass |
| `bun run test:unit` | `bun test` on the listed dirs (excludes `tests/capture`) | pass — 61 tests, 9 files, ~9 s |
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
  cli.ts                  bin entry; dispatches reconstruct | install | uninstall (lazy imports)
  commands/reconstruct.ts the pipeline: stages 01–07, mode choice, project + replay/proxy server codegen, report.md
  commands/install.ts     symlinks skills/reconstruct into ~/.claude|.codex|.agents/skills/raidr-reconstruct
  bundle/load.ts          zip-or-dir → LoadedBundle; validateManifest; content map keyed by hash
  stages/unpack.ts        stage 3: prettier-beautify JS chunks, split webpack modules without an AST
  stages/mirror.ts        stage 5b: write served bytes to public/, snapshot fallback for client routes
  emit.ts                 write files, prettier-format when possible (never fails on format errors)
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
| 2 | `02-sources/` | original sources from source maps (`recoverSources`) |
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
first → bump `@sudobility/raidr_processor` here → read it in
`src/bundle/load.ts` (`LoadedBundle` + loader) → consume in
`src/commands/reconstruct.ts` → if the capture harness should emit it,
`src/capture/harness.ts` → regenerate bundles only if needed.

**Change redaction**: not here. Edit raidr_processor `src/redaction/`, publish,
bump the dependency.

**Add a reconstruct stage/artifact**: `src/stages/<name>.ts` → call it from
`reconstruct()` and `writeJson('NN-name.json')` → add to `report.md` lines if
useful → add the artifact to SKILL.md Quick Reference and to the artifact list
in `tests/skills/skillFormat.test.ts` → test in `tests/stages/`.

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
- `capture/harness.ts` imports Playwright (a devDependency) but ships in `src/`;
  the CLI never imports it, so installs without devDeps still work.
- The comment block above `mode` in `reconstruct.ts` contains two overlapping
  paragraphs from different revisions; the second is the current rule.
