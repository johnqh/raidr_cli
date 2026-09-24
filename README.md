# raidr_cli

Reconstruct a working web app from an **raidr** capture bundle — plus the agent
skill that drives the reconstruction.

```bash
bun add -g @sudobility/raidr_cli
```

Requires [Bun](https://bun.sh) ≥ 1.2. The CLI ships as TypeScript and runs
under Bun directly.

## Usage

```bash
raidr reconstruct <bundle.zip|dir> --out <dir> [--replay]
raidr install [--claude] [--codex] [--agents] [--all]
raidr uninstall [--claude] [--codex] [--agents]
```

`raidr install` symlinks the `reconstruct` skill into the personal skills
directory of a coding agent — `.claude/skills`, `.codex/skills`, or the shared
`.agents/skills` path. The skill itself is runtime-agnostic: it drives a shell
binary and reads JSON, so it works the same in Claude Code, Codex, Gemini CLI,
and Copilot CLI.

## The split: CLI does the deterministic work, the agent does the judgment

`raidr reconstruct` performs every stage that has a right answer — source-map
recovery, bundle unpacking, JSON Schema inference, API and route modelling,
project scaffold, and a [Hono](https://hono.dev) replay server that serves the
captured traffic back. Each stage writes a JSON artifact to disk.

The `reconstruct` skill reads those artifacts and does only the work that needs
judgment: implementing components, naming things, wiring routes. Its governing
rule is that **the bundle is evidence, not inspiration** — everything written
must trace to something captured, and where the bundle is silent it says so.

That boundary is what keeps the system testable. Everything the CLI does is
covered by `bun test`; only genuinely model-shaped work lives in prose.

## Why this is a separate repository

[`raidr_lib`](https://github.com/johnqh/raidr_lib) is imported by
[`raidr_extension`](https://github.com/johnqh/raidr_extension), which ships into
a Chrome MV3 bundle. Its defining constraint is that it performs no I/O — no
filesystem, no `DOM` in its tsconfig `lib` — which is what keeps it trivially
testable and safe to bundle for the browser.

A CLI is the opposite: it needs `fs`, `path`, `process`, and zip extraction.
Putting that in `raidr_lib` would place Node-only code in the dependency graph
of a browser artifact and would end the mechanical enforcement of that purity.

So the dependency shape is a diamond, not a chain:

```
raidr_lib              pure: bundle format, redaction, coverage, inference
   ├── raidr_extension   browser: CDP capture, offscreen buffer, side panel
   └── raidr_cli         node: unzip, filesystem, codegen + the reconstruct skill
```

The two consumers never see each other.

## Development

```bash
bun install
bun run typecheck
bun test
bun run fixtures:build      # build the sample apps
bun run fixtures:capture    # capture them into fixtures/bundles/
```

## The raidr project

| Repository | Role |
|---|---|
| [`raidr_lib`](https://github.com/johnqh/raidr_lib) | Bundle format and pure analysis |
| [`raidr_extension`](https://github.com/johnqh/raidr_extension) | Chrome MV3 extension that performs the capture |
| [`raidr_cli`](https://github.com/johnqh/raidr_cli) | Reconstruction CLI and the agent skill — this repo |
| [`raidr_web`](https://github.com/johnqh/raidr_web) | Landing site |

## License

BUSL-1.1 — see [LICENSE.md](LICENSE.md).
